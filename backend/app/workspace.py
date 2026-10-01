"""Workspace platform API: users & roles, project settings and members, process / drawing templates,
per-part drawing review, joints (mating & welding), secure 3D model streaming, job orders and the dashboard."""
import os, re, json, math, base64, hashlib, hmac, secrets, datetime
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field, ConfigDict
from . import db, storage
from .security import user, editor, revision_access, password_hash, sign, verify, secret
from .access import require, can, perms_for, roles_payload, project_of_revision, ROLES, PROJECT_ROLES, role_of
from . import entra

router = APIRouter()
CATEGORIES = ('machining', 'sheet_metal', 'purchased', 'other')


def load(v, default):
    try:
        return json.loads(v) if isinstance(v, str) and v else (v if v is not None else default)
    except ValueError:
        return default


def get_project(pid):
    p = db.row('SELECT * FROM projects WHERE id=?', (pid,))
    if not p:
        raise HTTPException(404, 'Project not found')
    return p


def get_rev(rid):
    r = db.row('SELECT * FROM revisions WHERE id=?', (rid,))
    if not r:
        raise HTTPException(404, 'Revision not found')
    return r


def get_part(pid):
    p = db.row('SELECT * FROM parts WHERE id=?', (pid,))
    if not p:
        raise HTTPException(404, 'Part not found')
    p['geometry'] = json.loads(p['geometry'])
    p['spec'] = json.loads(p['spec'])
    return p


def editable_revision(rid):
    r = get_rev(rid)
    if r['state'] != 'active' or r['status'] != 'ready':
        raise HTTPException(409, 'Only an active, ready revision can be edited. Upload a new revision for released designs.')
    if db.row('SELECT id FROM jobs WHERE revision_id=? AND status IN ("queued","running")', (rid,)):
        raise HTTPException(409, 'A CAD job is active; wait for completion')
    return r


# ============================================================================ validation helpers
def clean_prefixes(values):
    out = [str(x).strip() for x in (values or []) if str(x).strip()][:50]
    if any(len(x) > 40 for x in out):
        raise HTTPException(422, 'Prefixes must be at most 40 characters')
    return out


def clean_project_settings(s):
    if not isinstance(s, dict):
        raise HTTPException(422, 'Settings must be an object')
    out = {}
    seen = set()
    for key in ('sheet_prefixes', 'machining_prefixes', 'purchased_prefixes'):
        if key in s:
            out[key] = clean_prefixes(s[key])
            for x in out[key]:
                if x.lower() in seen:
                    raise HTTPException(422, f'Prefix "{x}" is listed in more than one category')
                seen.add(x.lower())
    for key in ('prefix_strict', 'hide_purchased_by_default', 'carry_over_specs', 'assembly_show_purchased'):
        if key in s:
            out[key] = bool(s[key])
    if 'drawing' in s:
        out['drawing'] = {k: str(v).strip()[:80] for k, v in (s['drawing'] or {}).items() if k in db.DEFAULT_DRAWING}
    if 'conventions' in s:
        c = s['conventions'] or {}
        allowed = {'standard': ('ISO', 'ASME'), 'projection': ('first', 'third'), 'units': ('mm',), 'sheet_size': ('auto', 'A4', 'A3', 'A2'),
                   'hole_table': ('auto', 'always', 'never'), 'dimension_style': ('ordinate',), 'thread_callouts': ('explicit',)}
        conv = {}
        for k, v in c.items():
            if k == 'general_tolerance':
                conv[k] = str(v).strip()[:60]
            elif k in allowed:
                if v not in allowed[k]:
                    raise HTTPException(422, f'Unsupported drawing convention {k}={v}')
                conv[k] = v
        out['conventions'] = conv
    for key, kind in (('process_templates', 'process'), ('drawing_templates', 'drawing')):
        if key in s:
            m = {}
            for cat, tid in (s[key] or {}).items():
                if cat not in CATEGORIES:
                    raise HTTPException(422, 'Unknown category ' + str(cat))
                if not tid:
                    continue
                if not db.row('SELECT id FROM templates WHERE id=? AND kind=? AND archived=0', (tid, kind)):
                    raise HTTPException(422, f'Unknown {kind} template')
                m[cat] = tid
            out[key] = m
    return out


def clean_rules(body):
    if not isinstance(body, dict) or set(body) != set(db.DEFAULT_RULES) or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v <= 0 for v in body.values()) or not 0 < body['k_factor'] < 1:
        raise HTTPException(422, 'Provide all positive numeric rule values, with K between 0 and 1')
    return {k: float(v) for k, v in body.items()}


def clean_members(members):
    out = []
    for m in members or []:
        if not isinstance(m, dict) or m.get('role') not in PROJECT_ROLES or not db.row('SELECT id FROM users WHERE id=?', (m.get('user_id'),)):
            raise HTTPException(422, 'Each member needs a known user and a project role')
        out.append({'user_id': m['user_id'], 'role': m['role']})
    return out


# ============================================================================ users & roles
@router.get('/api/roles')
def roles(request: Request):
    user(request)
    return roles_payload()


@router.get('/api/users')
def users(request: Request):
    u = user(request)
    # everyone may pick team members (assignments, project members); only admins see e-mail + status controls
    rows = db.rows('SELECT id,email,name,role,created,provider,active,last_login FROM users ORDER BY name')
    if not can(u, 'users.manage'):
        return [{'id': r['id'], 'name': r['name'], 'role': role_of(r)} for r in rows if r['active']]
    for r in rows:
        r['role'] = role_of(r)
    return rows


class NewUser(BaseModel):
    model_config = ConfigDict(extra='forbid')
    email: str = Field(max_length=200)
    name: str = Field(min_length=1, max_length=120)
    role: str = 'viewer'
    password: str = ''


@router.post('/api/users')
def create_user(a: NewUser, request: Request):
    """Pre-register a colleague (they sign in with Microsoft; a password only when local sign-in is enabled)."""
    u = editor(request, 'users.manage')
    email = a.email.strip().lower()
    if a.role not in ROLES or '@' not in email:
        raise HTTPException(422, 'Invalid role or e-mail')
    if not entra.domain_ok(email):
        raise HTTPException(422, 'Only ' + ', '.join(entra.allowed_domains()) + ' accounts can be added')
    if a.password and (len(a.password) < 12 or not entra.local_login_allowed()):
        raise HTTPException(422, 'Passwords need 12+ characters and local sign-in enabled')
    if db.row('SELECT id FROM users WHERE email=?', (email,)):
        raise HTTPException(409, 'User already exists')
    with db.connect() as c:
        c.execute('INSERT INTO users(id,email,name,password,role,created,provider,active) VALUES(?,?,?,?,?,?,?,1)',
                  (db.uid(), email, a.name.strip(), password_hash(a.password) if a.password else '', a.role, db.now(), 'local' if a.password else 'entra'))
        db.audit(c, u['name'], 'user.created', {'email': email, 'role': a.role})
    return {'ok': True}


class UserEdit(BaseModel):
    model_config = ConfigDict(extra='forbid')
    role: str | None = None
    active: bool | None = None
    name: str | None = Field(default=None, max_length=120)


@router.patch('/api/users/{uid}')
def edit_user(uid: str, a: UserEdit, request: Request):
    u = editor(request, 'users.manage')
    t = db.row('SELECT * FROM users WHERE id=?', (uid,))
    if not t:
        raise HTTPException(404, 'User not found')
    sets = {}
    if a.role is not None:
        if a.role not in ROLES:
            raise HTTPException(422, 'Unknown role')
        sets['role'] = a.role
    if a.active is not None:
        sets['active'] = int(a.active)
    if a.name:
        sets['name'] = a.name.strip()
    if not sets:
        raise HTTPException(422, 'Nothing to change')
    admins = [r['id'] for r in db.rows("SELECT id FROM users WHERE role IN ('admin','owner') AND active=1")]
    if uid in admins and len(admins) == 1 and (sets.get('role', 'admin') != 'admin' or sets.get('active', 1) == 0):
        raise HTTPException(409, 'Keep at least one active administrator')
    with db.connect() as c:
        c.execute('UPDATE users SET ' + ','.join(k + '=?' for k in sets) + ' WHERE id=?', (*sets.values(), uid))
        if sets.get('active') == 0:
            c.execute('DELETE FROM sessions WHERE user_id=?', (uid,))
        db.audit(c, u['name'], 'user.updated', {'user': t['email'], **sets})
    return {'ok': True}


# ============================================================================ project settings & members
class ProjectEdit(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    code: str | None = Field(default=None, max_length=24)
    archived: bool | None = None
    settings: dict | None = None
    rules: dict | None = None


@router.patch('/api/projects/{pid}')
def edit_project(pid: str, a: ProjectEdit, request: Request):
    u = editor(request, 'project.settings', pid)
    p = get_project(pid)
    sets = {}
    if a.name is not None:
        sets['name'] = a.name.strip()
    if a.description is not None:
        sets['description'] = a.description
    if a.code is not None:
        sets['code'] = a.code.strip().upper()
    if a.archived is not None:
        sets['archived'] = int(a.archived)
    if a.settings is not None:
        merged = {**load(p['settings'], {}), **clean_project_settings(a.settings)}
        sets['settings'] = json.dumps(merged)
    if a.rules is not None:
        sets['rules'] = json.dumps(clean_rules(a.rules))
    if not sets:
        raise HTTPException(422, 'Nothing to change')
    with db.connect() as c:
        c.execute('UPDATE projects SET ' + ','.join(k + '=?' for k in sets) + ' WHERE id=?', (*sets.values(), pid))
        db.audit(c, u['name'], 'project.updated', {'project': pid, **{k: load(v, v) for k, v in sets.items()}})
    return {'ok': True, 'settings': db.project_settings(pid), 'message': 'Settings apply to the next upload and document generation'}


@router.get('/api/projects/{pid}/members')
def members(pid: str, request: Request):
    user(request)
    get_project(pid)
    return db.rows('SELECT m.user_id,m.role,m.added,u.name,u.email FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=? ORDER BY u.name', (pid,))


class Members(BaseModel):
    members: list[dict] = Field(max_length=500)


@router.put('/api/projects/{pid}/members')
def set_members(pid: str, a: Members, request: Request):
    u = editor(request, 'project.settings', pid)
    get_project(pid)
    ms = clean_members(a.members)
    with db.connect() as c:
        c.execute('DELETE FROM project_members WHERE project_id=?', (pid,))
        for m in ms:
            c.execute('INSERT OR REPLACE INTO project_members VALUES(?,?,?,?)', (pid, m['user_id'], m['role'], db.now()))
        db.audit(c, u['name'], 'project.members.updated', {'project': pid, 'members': ms})
    return {'ok': True}


# ============================================================================ templates
TEMPLATE_KINDS = ('process', 'drawing')
STEP_KINDS = ('process', 'inspection', 'assembly', 'outsourced')


def clean_template(kind, data):
    if not isinstance(data, dict):
        raise HTTPException(422, 'Template data must be an object')
    if kind == 'process':
        steps = []
        for s in data.get('steps') or []:
            if isinstance(s, str):
                s = {'name': s}
            if not isinstance(s, dict) or not str(s.get('name', '')).strip():
                raise HTTPException(422, 'Every process step needs a name')
            if s.get('kind', 'process') not in STEP_KINDS:
                raise HTTPException(422, 'Unknown step kind')
            steps.append({'name': str(s['name']).strip()[:120], 'kind': s.get('kind', 'process'), 'detail': str(s.get('detail', ''))[:400],
                          'station': str(s.get('station', ''))[:80], 'minutes': max(0, min(10000, float(s.get('minutes') or 0)))})
        if not steps:
            raise HTTPException(422, 'Add at least one process step')
        if len(steps) > 40:
            raise HTTPException(422, 'At most 40 steps')
        return {'steps': steps, 'categories': [c for c in data.get('categories', []) if c in CATEGORIES]}
    out = {'size': data.get('size', 'auto'), 'hole_table': data.get('hole_table', 'auto'), 'categories': [c for c in data.get('categories', []) if c in CATEGORIES]}
    if out['size'] not in ('auto', 'A4', 'A3', 'A2') or out['hole_table'] not in ('auto', 'always', 'never'):
        raise HTTPException(422, 'Sheet size must be auto, A4, A3 or A2; hole table auto, always or never')
    return out


@router.get('/api/templates')
def templates(request: Request, kind: str = '', project_id: str = ''):
    user(request)
    q = 'SELECT * FROM templates WHERE archived=0'
    args = []
    if kind:
        q += ' AND kind=?'
        args.append(kind)
    if project_id:
        q += ' AND (project_id IS NULL OR project_id=?)'
        args.append(project_id)
    rows = db.rows(q + ' ORDER BY kind,name', tuple(args))
    for r in rows:
        r['data'] = json.loads(r['data'])
        r['usage'] = db.row('SELECT COUNT(*) AS n FROM parts WHERE process_template_id=?', (r['id'],))['n'] if r['kind'] == 'process' else \
            db.row("SELECT COUNT(*) AS n FROM parts WHERE drawing_options LIKE ?", ('%' + r['id'] + '%',))['n']
    return rows


class TemplateIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    kind: str
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default='', max_length=1000)
    data: dict
    project_id: str | None = None


@router.post('/api/templates')
def create_template(a: TemplateIn, request: Request):
    u = editor(request, 'templates.manage', a.project_id)
    if a.kind not in TEMPLATE_KINDS:
        raise HTTPException(422, 'Template kind must be process or drawing')
    if a.project_id:
        get_project(a.project_id)
    data = clean_template(a.kind, a.data)
    id = db.uid()
    with db.connect() as c:
        c.execute('INSERT INTO templates(id,kind,name,description,data,project_id,created,updated,author) VALUES(?,?,?,?,?,?,?,?,?)',
                  (id, a.kind, a.name.strip(), a.description, json.dumps(data), a.project_id, db.now(), db.now(), u['name']))
        db.audit(c, u['name'], 'template.created', {'id': id, 'kind': a.kind, 'name': a.name})
    return {'id': id}


@router.put('/api/templates/{tid}')
def update_template(tid: str, a: TemplateIn, request: Request):
    t = db.row('SELECT * FROM templates WHERE id=?', (tid,))
    if not t:
        raise HTTPException(404, 'Template not found')
    u = editor(request, 'templates.manage', t['project_id'])
    if a.kind != t['kind']:
        raise HTTPException(422, 'Template kind cannot change')
    data = clean_template(t['kind'], a.data)
    with db.connect() as c:
        c.execute('UPDATE templates SET name=?,description=?,data=?,updated=? WHERE id=?', (a.name.strip(), a.description, json.dumps(data), db.now(), tid))
        db.audit(c, u['name'], 'template.updated', {'id': tid, 'name': a.name})
    # Parts keep the routing snapshot they were given; re-apply the template to update them.
    return {'ok': True}


@router.delete('/api/templates/{tid}')
def archive_template(tid: str, request: Request):
    t = db.row('SELECT * FROM templates WHERE id=?', (tid,))
    if not t:
        raise HTTPException(404, 'Template not found')
    u = editor(request, 'templates.manage', t['project_id'])
    with db.connect() as c:
        c.execute('UPDATE templates SET archived=1 WHERE id=?', (tid,))
        db.audit(c, u['name'], 'template.archived', {'id': tid})
    return {'ok': True}


class ApplyProcess(BaseModel):
    model_config = ConfigDict(extra='forbid')
    ids: list[str] = Field(min_length=1, max_length=2000)
    template_id: str = ''


@router.post('/api/revisions/{rid}/parts/process-template')
def apply_process_template(rid: str, a: ApplyProcess, request: Request):
    """A part follows exactly one process template: its steps become the part's routing (snapshot)."""
    u = revision_access(request, rid, True, 'part.edit')
    editable_revision(rid)
    steps = []
    if a.template_id:
        t = db.row("SELECT * FROM templates WHERE id=? AND kind='process' AND archived=0", (a.template_id,))
        if not t:
            raise HTTPException(422, 'Unknown process template')
        steps = json.loads(t['data'])['steps']
    n = 0
    with db.connect() as c:
        for pid in dict.fromkeys(a.ids):
            row = c.execute('SELECT spec FROM parts WHERE id=? AND revision_id=?', (pid, rid)).fetchone()
            if not row:
                raise HTTPException(422, 'Part outside revision: ' + pid)
            spec = json.loads(row['spec'])
            spec['operations'] = [{'name': s['name'], 'detail': s.get('detail', ''), 'kind': s.get('kind', 'process')} for s in steps]
            c.execute('UPDATE parts SET spec=?,process_template_id=? WHERE id=?', (json.dumps(spec), a.template_id, pid))
            n += 1
        db.audit(c, u['name'], 'parts.process.template', {'count': n, 'template': a.template_id}, rid)
    return {'ok': True, 'updated': n}


class DrawingOptions(BaseModel):
    model_config = ConfigDict(extra='forbid')
    ids: list[str] = Field(min_length=1, max_length=2000)
    template_id: str = ''
    size: str = ''
    hole_table: str = ''
    regenerate: bool = True


class AssemblyShow(BaseModel):
    model_config = ConfigDict(extra='forbid')
    ids: list[str] = Field(min_length=1, max_length=2000)
    show: bool


@router.post('/api/revisions/{rid}/parts/assembly-drawing')
def set_assembly_show(rid: str, a: AssemblyShow, request: Request):
    """Override: show (or stop showing) purchased parts on the assembly drawing; regenerates the assembly PDF."""
    u = revision_access(request, rid, True, 'drawing.edit')
    editable_revision(rid)
    ids = list(dict.fromkeys(a.ids))
    with db.connect() as c:
        for pid in ids:
            row = c.execute('SELECT drawing_options FROM parts WHERE id=? AND revision_id=?', (pid, rid)).fetchone()
            if not row:
                raise HTTPException(422, 'Part outside revision: ' + pid)
            opts = load(row['drawing_options'], {})
            if a.show:
                opts['assembly_show'] = True
            else:
                opts.pop('assembly_show', None)
            c.execute('UPDATE parts SET drawing_options=? WHERE id=?', (json.dumps(opts), pid))
        db.audit(c, u['name'], 'parts.assembly_drawing', {'count': len(ids), 'show': a.show}, rid)
        job = db.uid()
        c.execute('INSERT INTO jobs(id,revision_id,kind,status,created,error,payload) VALUES(?,?,?,?,?,?,?)', (job, rid, 'documents', 'queued', db.now(), '', json.dumps({'assembly_only': True})))
    return {'ok': True, 'job': job}


@router.post('/api/revisions/{rid}/parts/drawing-options')
def set_drawing_options(rid: str, a: DrawingOptions, request: Request):
    """Per-part sheet template (A2 / A3 / A4 / automatic, hole table mode); regenerates the affected drawings."""
    u = revision_access(request, rid, True, 'drawing.edit')
    editable_revision(rid)
    if a.size not in ('', 'auto', 'A4', 'A3', 'A2') or a.hole_table not in ('', 'auto', 'always', 'never'):
        raise HTTPException(422, 'Invalid sheet size or hole table mode')
    if a.template_id and not db.row("SELECT id FROM templates WHERE id=? AND kind='drawing' AND archived=0", (a.template_id,)):
        raise HTTPException(422, 'Unknown drawing template')
    opts = {k: v for k, v in {'template_id': a.template_id, 'size': a.size, 'hole_table': a.hole_table}.items() if v}
    ids = list(dict.fromkeys(a.ids))
    with db.connect() as c:
        for pid in ids:
            if not c.execute('SELECT id FROM parts WHERE id=? AND revision_id=?', (pid, rid)).fetchone():
                raise HTTPException(422, 'Part outside revision: ' + pid)
            c.execute("UPDATE parts SET drawing_options=?,doc_reviewed=0,doc_reviewed_by='',doc_reviewed_at='' WHERE id=?", (json.dumps(opts), pid))
        db.audit(c, u['name'], 'parts.drawing.options', {'count': len(ids), **opts}, rid)
        job = None
        if a.regenerate:
            payload = {'part_id': ids[0]} if len(ids) == 1 else {}
            job = db.uid()
            c.execute('INSERT INTO jobs(id,revision_id,kind,status,created,error,payload) VALUES(?,?,?,?,?,?,?)', (job, rid, 'documents', 'queued', db.now(), '', json.dumps(payload)))
    return {'ok': True, 'job_id': job}


class DocReview(BaseModel):
    model_config = ConfigDict(extra='forbid')
    reviewed: bool
    note: str = Field(default='', max_length=1000)


@router.post('/api/parts/{pid}/doc-review')
def doc_review(pid: str, a: DocReview, request: Request):
    """The engineer has looked at (and arranged) this part's generated sheets."""
    p = get_part(pid)
    u = revision_access(request, p['revision_id'], True, 'drawing.review')
    editable_revision(p['revision_id'])
    folder = db.revdir(p['revision_id']) / 'parts' / pid
    if a.reviewed and ((folder / '.drawing-invalid').exists() or not (folder / 'drawing-scene.json').exists()):
        raise HTTPException(409, 'Generate the drawing before reviewing it')
    with db.connect() as c:
        c.execute('UPDATE parts SET doc_reviewed=?,doc_reviewed_by=?,doc_reviewed_at=? WHERE id=?', (int(a.reviewed), u['name'] if a.reviewed else '', db.now() if a.reviewed else '', pid))
        db.audit(c, u['name'], 'drawing.reviewed' if a.reviewed else 'drawing.review.reopened', {'part': pid, 'note': a.note}, p['revision_id'])
    return {'ok': True}


# ============================================================================ faces & joints
class FaceAt(BaseModel):
    point: list[float] = Field(min_length=3, max_length=3)


@router.post('/api/parts/{pid}/face-at')
def face_at(pid: str, a: FaceAt, request: Request):
    """Exact B-rep face under a picked point (part coordinates): type, normal, centre, area, radius."""
    p = get_part(pid)
    revision_access(request, p['revision_id'])
    if not all(math.isfinite(x) for x in a.point):
        raise HTTPException(422, 'Invalid point')
    shape_file = db.revdir(p['revision_id']) / 'parts' / pid / 'shape.brep'
    if not shape_file.exists():
        storage.restore(p['revision_id'], f'parts/{pid}/shape.brep', shape_file)
    if not shape_file.exists():
        raise HTTPException(409, 'Part geometry unavailable')
    from .cad import read_brep, explore, TopAbs_FACE, TopAbs_EDGE, xyz, sample_edge
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    from OCP.gp import gp_Pnt
    from OCP.TopoDS import TopoDS
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Plane, GeomAbs_Cylinder, GeomAbs_Cone
    from OCP.GProp import GProp_GProps
    from OCP.BRepGProp import BRepGProp
    from OCP.BRepLProp import BRepLProp_SLProps
    shape = read_brep(shape_file)
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    BRepMesh_IncrementalMesh(shape, 0.5, False, 0.45, True).Perform()
    v = BRepBuilderAPI_MakeVertex(gp_Pnt(*a.point)).Vertex()
    best = None
    for i, f in enumerate(explore(shape, TopAbs_FACE)):
        d = BRepExtrema_DistShapeShape(v, f)
        if d.IsDone() and (best is None or d.Value() < best[0]):
            best = (d.Value(), i, TopoDS.Face(f), d.PointOnShape2(1))
    if not best or best[0] > 2.0:
        raise HTTPException(422, 'No face at that point')
    dist, idx, face, onp = best
    ad = BRepAdaptor_Surface(face, True)
    t = ad.GetType()
    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(face, props)
    kind = {GeomAbs_Plane: 'plane', GeomAbs_Cylinder: 'cylinder', GeomAbs_Cone: 'cone'}.get(t, 'surface')
    out = {'index': idx, 'type': kind, 'area': round(props.Mass(), 3), 'center': [round(x, 4) for x in xyz(props.CentreOfMass())], 'point': [round(x, 4) for x in xyz(onp)]}
    if kind == 'plane':
        n = xyz(ad.Plane().Axis().Direction())
        if face.Orientation() == 1:
            n = -n
        out['normal'] = [round(x, 5) for x in n]
    if kind == 'cylinder':
        c = ad.Cylinder()
        out['radius'] = round(c.Radius(), 4)
        out['axis'] = [round(x, 5) for x in xyz(c.Axis().Direction())]
        out['internal'] = face.Orientation() == 1
    # Selected-face preview data. Boundaries drive the common-seam preview and the
    # triangulation gives patch welds the same face-fill feedback as the CAD viewer.
    boundaries = []
    for edge in explore(face, TopAbs_EDGE):
        points = sample_edge(edge, .15)
        if len(points) > 160:
            step = max(1, len(points) // 160)
            points = points[::step]
        boundaries.append([[round(float(v), 4) for v in point] for point in points])
    out['boundaries'] = boundaries
    from OCP.BRep import BRep_Tool
    from OCP.TopLoc import TopLoc_Location
    location = TopLoc_Location()
    triangulation = BRep_Tool.Triangulation_s(face, location)
    if triangulation is not None and triangulation.NbTriangles() <= 3000:
        transform = location.Transformation()
        vertices = [[round(float(v), 4) for v in xyz(triangulation.Node(i).Transformed(transform))] for i in range(1, triangulation.NbNodes() + 1)]
        triangles = [[int(v) - 1 for v in triangulation.Triangle(i).Get()] for i in range(1, triangulation.NbTriangles() + 1)]
        out['preview_mesh'] = {'vertices': vertices, 'triangles': triangles}
    return out


@router.post('/api/parts/{pid}/edge-at')
def edge_at(pid: str, a: FaceAt, request: Request):
    """Exact B-rep edge nearest a picked mesh point, for weld-seam selection and preview."""
    p = get_part(pid)
    revision_access(request, p['revision_id'])
    if not all(math.isfinite(x) for x in a.point):
        raise HTTPException(422, 'Invalid point')
    shape_file = db.revdir(p['revision_id']) / 'parts' / pid / 'shape.brep'
    if not shape_file.exists():
        storage.restore(p['revision_id'], f'parts/{pid}/shape.brep', shape_file)
    if not shape_file.exists():
        raise HTTPException(409, 'Part geometry unavailable')
    from .cad import read_brep, explore, TopAbs_EDGE, xyz, sample_edge
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.GCPnts import GCPnts_AbscissaPoint
    from OCP.GeomAbs import GeomAbs_Line, GeomAbs_Circle
    from OCP.gp import gp_Pnt
    from OCP.TopoDS import TopoDS
    shape = read_brep(shape_file)
    vertex = BRepBuilderAPI_MakeVertex(gp_Pnt(*a.point)).Vertex()
    best = None
    for i, edge in enumerate(explore(shape, TopAbs_EDGE)):
        distance = BRepExtrema_DistShapeShape(vertex, edge)
        if distance.IsDone() and (best is None or distance.Value() < best[0]):
            best = (distance.Value(), i, TopoDS.Edge(edge), distance.PointOnShape2(1))
    if not best or best[0] > 3.0:
        raise HTTPException(422, 'No edge at that point')
    distance, index, edge, nearest = best
    curve = BRepAdaptor_Curve(edge)
    first, last = curve.FirstParameter(), curve.LastParameter()
    start, end = curve.Value(first), curve.Value(last)
    kind = {GeomAbs_Line: 'line', GeomAbs_Circle: 'circle'}.get(curve.GetType(), 'curve')
    try:
        length = GCPnts_AbscissaPoint.Length_s(curve, first, last)
    except Exception:
        length = start.Distance(end)
    out = {'index': index, 'type': kind, 'point': [round(x, 4) for x in xyz(nearest)],
           'start': [round(x, 4) for x in xyz(start)], 'end': [round(x, 4) for x in xyz(end)],
           'length': round(float(length), 3)}
    sampled = sample_edge(edge, .12)
    if len(sampled) > 240:
        sampled = sampled[::max(1, len(sampled) // 240)]
    out['boundaries'] = [[[round(float(v), 4) for v in point] for point in sampled]]
    if kind == 'circle':
        circle = curve.Circle()
        out.update({'center': [round(x, 4) for x in xyz(circle.Location())],
                    'axis': [round(x, 5) for x in xyz(circle.Axis().Direction())],
                    'radius': round(circle.Radius(), 4)})
    return out


class SeamQuery(BaseModel):
    model_config = ConfigDict(extra='forbid')
    parts: list[str] = Field(min_length=1, max_length=12)
    # optional: restrict a part to one occurrence (the one the engineer picked in 3D)
    occurrences: dict[str, int] = Field(default_factory=dict)
    # optional: two picked faces [{part, occurrence, index}] that should be joined even though they do not touch
    faces: list[dict] = Field(default_factory=list, max_length=2)


@router.post('/api/revisions/{rid}/weld-seams')
def weld_seams(rid: str, a: SeamQuery, request: Request):
    """Candidate weld seams where the selected bodies touch in the assembly: edges of one body lying on
    another, classified as fillet (inside corner), corner (outside corner) or butt (flush) with a suggested
    throat size. Returned in each owning part's coordinates, ready to save as weld edge selections."""
    revision_access(request, rid)
    from .seams import load_bodies, find_seams, face_pair_seams
    folder = db.revdir(rid)
    ids = list(dict.fromkeys(a.parts + [str(f.get('part')) for f in a.faces if f.get('part')]))
    parts = []
    for pid in ids:
        row = db.row('SELECT id,name,category,geometry FROM parts WHERE id=? AND revision_id=?', (pid, rid))
        if not row:
            raise HTTPException(422, 'Part outside revision')
        row['geometry'] = json.loads(row['geometry'])
        parts.append(row)
        f = folder / 'parts' / pid / 'shape.brep'
        if not f.exists():
            storage.restore(rid, f'parts/{pid}/shape.brep', f)
    inst_file = folder / 'instances.json'
    if not inst_file.exists():
        storage.restore(rid, 'instances.json', inst_file)
    instances = json.loads(inst_file.read_text()) if inst_file.exists() else {}
    names = {p['id']: p['name'] for p in parts}
    if a.faces:
        if len(a.faces) != 2 or any(not isinstance(f.get('index'), int) for f in a.faces):
            raise HTTPException(422, 'Pick exactly two faces')
        keys = [(str(f['part']), int(f.get('occurrence') or 0)) for f in a.faces]
        bodies = {(b.pid, b.occurrence): b for b in load_bodies(folder, parts, instances, list(dict.fromkeys(keys)), keep_all=True)}
        if any(k not in bodies for k in keys):
            raise HTTPException(409, 'Part geometry unavailable')
        fa, fb = bodies[keys[0]], bodies[keys[1]]
        if any(not (0 <= f['index'] < len(body.faces)) for f, body in ((a.faces[0], fa), (a.faces[1], fb))):
            raise HTTPException(422, 'Unknown face')
        seams, distance = face_pair_seams((fa, a.faces[0]['index']), (fb, a.faces[1]['index']))
        for s in seams:
            s['part_name'], s['other_name'] = names.get(s['part'], ''), names.get(s['other_part'], '')
        message = '' if seams else (f'The faces are {distance:.1f} mm apart — too far to bridge with a weld (25 mm max).' if distance > 25 else
                                    'These faces meet only at a point or along no usable length. Pick the faces that form the joint.')
        return {'seams': seams, 'bodies': len(bodies), 'distance': round(distance, 3), 'message': message}
    wanted = [(pid, a.occurrences.get(pid)) for pid in ids]
    bodies = load_bodies(folder, parts, instances, wanted)
    if len(bodies) < 2 and not (len(ids) == 1 and len(bodies) >= 2):
        # A single selected part can still be checked against its own other occurrences.
        if len(ids) == 1 and len(instances.get(ids[0], [])) > 1:
            bodies = load_bodies(folder, parts, instances, [(ids[0], None)])
    single = len(ids) == 1
    if single and not bodies:
        bodies = load_bodies(folder, parts, instances, [(ids[0], a.occurrences.get(ids[0], 0))], keep_all=True)
    # one component: also the gaps it closes on itself (corners of a bent box)
    seams = find_seams(bodies, self_mode=single) if bodies else []
    partial = bool(bodies) and not getattr(find_seams, 'complete', True)
    for s in seams:
        s['part_name'], s['other_name'] = names.get(s['part'], ''), names.get(s['other_part'], '')
    if partial:
        return {'seams': seams, 'bodies': len(bodies), 'partial': True,
                'message': f'Stopped after 25 s with {len(seams)} seam(s) found — select fewer components (or pick the faces) for a complete search.'}
    return {'seams': seams, 'bodies': len(bodies),
            'message': '' if seams else ('No open seams on this component. Add the component(s) it is welded to, or pick the two faces to join.' if single else 'These components do not touch in the CAD assembly and no gap small enough to weld (≤ 1.5 × plate thickness) was found. Pick the two faces to join to bridge a larger gap.')}


WELD_PROCESSES = ('MIG/MAG (135)', 'Laser (52)', 'TIG (141)', 'MMA (111)', 'Spot (21)', 'Flux-cored (136)', 'Brazing')
WELD_TYPES = ('linear', 'stitch', 'patch', 'tack', 'fillet', 'butt', 'plug', 'spot', 'seam', 'edge', 'flare')
JOINT_KINDS = ('weld', 'bolted', 'press_fit', 'adhesive', 'rivet', 'pem', 'mate')


class JointIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    kind: str
    parts: list[str] = Field(min_length=1, max_length=60)
    # one weld on a tab-and-slot or stitched assembly easily has 100+ seam edges
    faces: list[dict] = Field(default_factory=list, max_length=1500)
    weld: dict = Field(default_factory=dict)
    fasteners: str = Field(default='', max_length=300)
    torque: str = Field(default='', max_length=80)
    sequence: int = Field(default=0, ge=0, le=1000)
    notes: str = Field(default='', max_length=2000)
    name: str = Field(default='', max_length=120)


def clean_joint(rid, a: JointIn):
    if a.kind not in JOINT_KINDS:
        raise HTTPException(422, 'Unknown joint type')
    ids = list(dict.fromkeys(a.parts))
    if len(ids) < (1 if a.kind == 'weld' else 2):
        raise HTTPException(422, 'Select at least one part for a weld' if a.kind == 'weld' else 'Select two or more parts')
    for pid in ids:
        if not db.row('SELECT id FROM parts WHERE id=? AND revision_id=?', (pid, rid)):
            raise HTTPException(422, 'Part outside revision')
    faces = []
    for f in a.faces:
        if f.get('part') not in ids or not isinstance(f.get('index'), int):
            raise HTTPException(422, 'Faces must belong to the joined parts')
        if not isinstance(f.get('occurrence', 0), int) or f.get('occurrence', 0) < 0:
            raise HTTPException(422, 'Invalid component occurrence')
        clean = {k: f[k] for k in ('part', 'occurrence', 'selection', 'index', 'type', 'point', 'normal', 'area', 'radius', 'start', 'end', 'center', 'axis', 'length') if k in f}
        # detected seams carry their joint classification and fillet legs for the 3D bead
        if f.get('joint') in ('fillet', 'corner', 'butt'):
            clean['joint'] = f['joint']
        if isinstance(f.get('legs'), list) and len(f['legs']) == 2 and all(isinstance(v, list) and len(v) == 3 for v in f['legs']):
            clean['legs'] = [[float(x) for x in v] for v in f['legs']]
        if f.get('side') in ('inside', 'outside'):
            clean['side'] = f['side']
        if isinstance(f.get('key'), str) and len(f['key']) <= 60:
            clean['key'] = f['key']
        if f.get('other_part') in ids:
            clean['other_part'] = f['other_part']
            clean['other_occurrence'] = int(f.get('other_occurrence') or 0)
        boundaries = f.get('boundaries')
        if isinstance(boundaries, list):
            paths = [path for path in boundaries[:64] if isinstance(path, list) and path]
            if f.get('type') == 'line':
                paths = [[path[0], path[-1]] for path in paths]
            clean['boundaries'] = [path if len(path) <= 200 else path[::-(-len(path) // 200)] + [path[-1]] for path in paths]
        preview = f.get('preview_mesh')
        if isinstance(preview, dict) and isinstance(preview.get('vertices'), list) and isinstance(preview.get('triangles'), list):
            clean['preview_mesh'] = {'vertices': preview['vertices'][:10000], 'triangles': preview['triangles'][:3000]}
        faces.append(clean)
    weld = {}
    if a.kind == 'weld':
        w = a.weld or {}
        if w.get('process') not in WELD_PROCESSES or w.get('type') not in WELD_TYPES:
            raise HTTPException(422, 'Choose a welding process and weld type')
        face_selections = [f for f in faces if f.get('selection') != 'edge']
        edge_selections = [f for f in faces if f.get('selection') == 'edge']
        if w['type'] in ('linear', 'stitch') and not (edge_selections or len(face_selections) == 2):
            raise HTTPException(422, 'Select one or more seam edges, or exactly two mating faces')
        if w['type'] == 'tack' and len(face_selections) != 2:
            raise HTTPException(422, 'Select exactly two mating faces for a tack weld')
        if w['type'] == 'patch' and not face_selections:
            raise HTTPException(422, 'Select one or more faces for a patch weld')
        placement = w.get('placement')
        if w['type'] == 'tack' and (not isinstance(placement, dict) or placement.get('part') not in ids or not isinstance(placement.get('point'), list) or len(placement['point']) != 3):
            raise HTTPException(422, 'Place the tack on one of the selected bodies')
        weld = {'process': w['process'], 'type': w['type'], 'size': str(w.get('size', ''))[:20], 'thickness': str(w.get('thickness', w.get('size', '')))[:20], 'length': str(w.get('length', ''))[:20],
                'pitch': str(w.get('pitch', ''))[:20], 'sides': w.get('sides', 'one') if w.get('sides') in ('one', 'both', 'all_around') else 'one',
                'finish': str(w.get('finish', ''))[:60], 'filler': str(w.get('filler', ''))[:60], 'quality': str(w.get('quality', ''))[:40],
                'field': bool(w.get('field')), 'subtype': w.get('subtype', 'centered') if w.get('subtype') in ('centered', 'free') else 'centered',
                'width': str(w.get('width', ''))[:20], 'placement': placement if isinstance(placement, dict) else None}
    return {'name': a.name.strip(), 'parts': ids, 'faces': faces, 'weld': weld, 'fasteners': a.fasteners, 'torque': a.torque, 'sequence': a.sequence, 'notes': a.notes}


@router.get('/api/revisions/{rid}/joints')
def joints(rid: str, request: Request):
    revision_access(request, rid)
    return [{**j, 'data': json.loads(j['data'])} for j in db.rows('SELECT * FROM joints WHERE revision_id=? ORDER BY created', (rid,))]


@router.get('/api/joint-options')
def joint_options(request: Request):
    user(request)
    return {'kinds': JOINT_KINDS, 'weld_processes': WELD_PROCESSES, 'weld_types': WELD_TYPES}


@router.post('/api/revisions/{rid}/joints')
def add_joint(rid: str, a: JointIn, request: Request):
    u = revision_access(request, rid, True, 'part.edit')
    editable_revision(rid)
    data = clean_joint(rid, a)
    id = db.uid()
    with db.connect() as c:
        c.execute('INSERT INTO joints VALUES(?,?,?,?,?,?,?)', (id, rid, a.kind, json.dumps(data), db.now(), u['name'], db.now()))
        db.audit(c, u['name'], 'joint.created', {'id': id, 'kind': a.kind, **data}, rid)
    return {'id': id}


@router.put('/api/joints/{jid}')
def edit_joint(jid: str, a: JointIn, request: Request):
    j = db.row('SELECT * FROM joints WHERE id=?', (jid,))
    if not j:
        raise HTTPException(404, 'Joint not found')
    u = revision_access(request, j['revision_id'], True, 'part.edit')
    editable_revision(j['revision_id'])
    data = clean_joint(j['revision_id'], a)
    with db.connect() as c:
        c.execute('UPDATE joints SET kind=?,data=?,updated=? WHERE id=?', (a.kind, json.dumps(data), db.now(), jid))
        db.audit(c, u['name'], 'joint.updated', {'id': jid, 'before': json.loads(j['data']), 'after': data}, j['revision_id'])
    return {'ok': True}


@router.delete('/api/joints/{jid}')
def delete_joint(jid: str, request: Request):
    j = db.row('SELECT * FROM joints WHERE id=?', (jid,))
    if not j:
        raise HTTPException(404, 'Joint not found')
    u = revision_access(request, j['revision_id'], True, 'part.edit')
    editable_revision(j['revision_id'])
    with db.connect() as c:
        c.execute('DELETE FROM joints WHERE id=?', (jid,))
        db.audit(c, u['name'], 'joint.deleted', {'id': jid, **json.loads(j['data'])}, j['revision_id'])
    return {'ok': True}


# ============================================================================ secure 3D model streaming
# Meshes never have a download URL. The viewer asks for a ticket (session / vendor link required), gets a
# signed URL valid for two minutes and bound to that principal, plus a one-off AES-GCM key; the stream is
# encrypted and marked no-store. (A viewer that can display a model can in principle capture it; this stops
# direct links, sharing of URLs, caching and casual "save as".)
MODEL_FILES = {'assembly.glb', 'flat.glb', 'model.glb'}


def principal(access):
    return ('share:' if access['role'] == 'vendor' else 'user:') + access['id']


def model_key(mac):
    return hmac.new(secret(), b'model-key|' + mac.encode(), hashlib.sha256).digest()


@router.get('/api/model-ticket')
def model_ticket(request: Request, revision: str, file: str, part: str = ''):
    if file not in MODEL_FILES or (file != 'assembly.glb' and not part):
        raise HTTPException(422, 'Unknown model')
    if part:
        p = get_part(part)
        if p['revision_id'] != revision:
            raise HTTPException(422, 'Part outside revision')
    access = revision_access(request, revision)
    payload = f'{revision}|{part}|{file}|{principal(access)}'
    exp, mac = sign('model:' + payload, ttl=120)
    token = base64.urlsafe_b64encode(payload.encode()).decode().rstrip('=') + '.' + str(exp) + '.' + mac
    return {'url': '/api/models/' + token, 'key': base64.b64encode(model_key(mac)).decode(), 'expires': exp}


@router.get('/api/models/{token}')
def model_stream(token: str, request: Request):
    try:
        b64, exp, mac = token.rsplit('.', 2)
        payload = base64.urlsafe_b64decode(b64 + '=' * (-len(b64) % 4)).decode()
        rid, part, file, who = payload.split('|')
        ok = verify('model:' + payload, int(exp), mac)
    except Exception:
        ok = False
    if not ok:
        raise HTTPException(403, 'Model link expired')
    access = revision_access(request, rid)
    if principal(access) != who:
        raise HTTPException(403, 'Model link belongs to another session')
    path = db.revdir(rid) / file if not part else db.revdir(rid) / 'parts' / part / file
    rel = file if not part else f'parts/{part}/{file}'
    if not path.exists():
        storage.restore(rid, rel, path)
    if not path.exists():
        raise HTTPException(404, '3D mesh is not available yet')
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    iv = secrets.token_bytes(12)
    body = iv + AESGCM(model_key(mac)).encrypt(iv, path.read_bytes(), payload.encode())
    return Response(body, media_type='application/octet-stream', headers={'Cache-Control': 'no-store, private', 'X-Forge-Aad': base64.b64encode(payload.encode()).decode(), 'Content-Disposition': 'inline'})


# ============================================================================ job orders
PRIORITIES = ('low', 'normal', 'high', 'urgent')
JO_STATUSES = ('open', 'in_progress', 'on_hold', 'completed', 'cancelled')


class JobOrderIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision_id: str = ''
    title: str = Field(min_length=1, max_length=160)
    requirement: str = Field(default='', max_length=4000)
    quantity: int = Field(default=1, ge=1, le=100000)
    due: str = Field(default='', max_length=40)
    priority: str = 'normal'
    customer: str = Field(default='', max_length=160)
    parts: list[dict] | None = Field(default=None, max_length=5000)
    include_purchased: bool = True


def default_steps(p):
    ops = [o for o in (p['spec'].get('operations') or []) if str(o.get('name', '')).strip()]
    if ops:
        return [(o['name'], o.get('kind') or ('inspection' if re.search(r'inspect|qc|check', o['name'], re.I) else 'process')) for o in ops]
    if p['category'] == 'sheet_metal':
        steps = [('Laser cut', 'process'), ('Deburr', 'process')]
        if p['geometry'].get('bends'):
            steps.append(('CNC bend', 'process'))
    else:
        steps = [('Machining', 'process')]
    if p['spec'].get('finish') and 'not applicable' not in p['spec']['finish'].lower():
        steps.append((p['spec']['finish'], 'outsourced'))
    steps.append(('Inspect', 'inspection'))
    return steps


def job_order_items(jo_id, rid, quantity, selection, include_purchased):
    """Process checklist per make part (routing steps × required count), procurement lines for bought-in
    parts and assembly lines for every weld / joint."""
    parts = {p['id']: p for p in db.rows('SELECT * FROM parts WHERE revision_id=? AND excluded=0', (rid,))}
    for p in parts.values():
        p['geometry'] = json.loads(p['geometry'])
        p['spec'] = json.loads(p['spec'])
    wanted = {s['part_id']: int(s.get('quantity') or 0) for s in selection} if selection is not None else None
    items = []
    for p in sorted(parts.values(), key=lambda x: x['name']):
        if wanted is not None and p['id'] not in wanted:
            continue
        req = wanted[p['id']] if wanted and wanted.get(p['id']) else p['quantity'] * quantity
        if p['category'] == 'purchased':
            if include_purchased:
                items.append((p, 0, 'Procure', 'procurement', req))
            continue
        for i, (step, kind) in enumerate(default_steps(p)):
            items.append((p, i, step, kind, req))
    rows = [(db.uid(), jo_id, p['id'], p['name'], p['category'], seq, step, kind, req) for p, seq, step, kind, req in items]
    for j in db.rows('SELECT * FROM joints WHERE revision_id=? ORDER BY created', (rid,)):
        d = json.loads(j['data'])
        names = [parts[x]['name'] for x in d['parts'] if x in parts]
        single_part_weld = j['kind'] == 'weld' and len(d['parts']) == 1
        if len(names) < (1 if single_part_weld else 2):
            continue
        if single_part_weld and wanted is not None and d['parts'][0] not in wanted:
            continue
        what = ('Weld ' + d['weld'].get('process', '') + ' ' + d['weld'].get('type', '') + (' a' + d['weld']['size'] if d['weld'].get('size') else '')) if j['kind'] == 'weld' else j['kind'].replace('_', ' ').title()
        required = (wanted[d['parts'][0]] if wanted is not None else parts[d['parts'][0]]['quantity'] * quantity) if single_part_weld else quantity
        rows.append((db.uid(), jo_id, 'joint:' + j['id'], ' + '.join(names)[:300], 'assembly', 1000 + d.get('sequence', 0), what.strip(), 'assembly', required))
    return rows


def jo_payload(jo, full=False):
    items = db.rows('SELECT * FROM jo_items WHERE job_order_id=? ORDER BY part_name,seq', (jo['id'],))
    total = sum(i['required'] for i in items) or 1
    done = sum(min(i['done'], i['required']) for i in items)
    jo = dict(jo)
    jo['progress'] = round(100 * done / total, 1)
    jo['items_total'] = len(items)
    jo['items_done'] = sum(1 for i in items if i['status'] == 'done')
    jo['rejected'] = sum(i['rejected'] for i in items)
    # finished parts = parts whose last routing step reached the required count
    byp = {}
    for i in items:
        if i['kind'] not in ('procurement', 'assembly'):
            byp.setdefault(i['part_id'], []).append(i)
    jo['parts_total'] = len(byp)
    jo['parts_done'] = sum(1 for v in byp.values() if all(x['done'] >= x['required'] for x in v))
    try:
        jo['overdue'] = bool(jo['due']) and jo['status'] not in ('completed', 'cancelled') and datetime.date.fromisoformat(jo['due'][:10]) < datetime.date.today()
    except ValueError:
        jo['overdue'] = False
    if full:
        jo['items'] = items
        jo['events'] = db.rows('SELECT * FROM jo_events WHERE job_order_id=? ORDER BY created DESC LIMIT 300', (jo['id'],))
        stations = {}
        for i in items:
            s = stations.setdefault(i['step'], {'step': i['step'], 'kind': i['kind'], 'required': 0, 'done': 0})
            s['required'] += i['required']
            s['done'] += min(i['done'], i['required'])
        jo['stations'] = sorted(stations.values(), key=lambda s: -(s['required'] - s['done']))
    return jo


@router.get('/api/projects/{pid}/job-orders')
def job_orders(pid: str, request: Request):
    user(request)
    get_project(pid)
    return [jo_payload(j) for j in db.rows('SELECT * FROM job_orders WHERE project_id=? ORDER BY number DESC', (pid,))]


@router.get('/api/job-orders')
def all_job_orders(request: Request, status: str = ''):
    user(request)
    q = 'SELECT j.*,p.name AS project_name,p.code AS project_code,r.number AS revision_number FROM job_orders j JOIN projects p ON p.id=j.project_id JOIN revisions r ON r.id=j.revision_id'
    rows = db.rows(q + (' WHERE j.status=?' if status else '') + ' ORDER BY j.created DESC', (status,) if status else ())
    return [jo_payload(j) for j in rows]


@router.post('/api/projects/{pid}/job-orders')
def create_job_order(pid: str, a: JobOrderIn, request: Request):
    u = editor(request, 'joborder.create', pid)
    get_project(pid)
    rid = a.revision_id or (db.row("SELECT id FROM revisions WHERE project_id=? AND status='released' ORDER BY number DESC LIMIT 1", (pid,)) or {}).get('id')
    if not rid:
        raise HTTPException(409, 'Job orders need a production-ready (released) revision: complete design checks and drawing reviews, then release')
    r = get_rev(rid)
    if r['project_id'] != pid:
        raise HTTPException(422, 'Revision belongs to another project')
    if r['status'] != 'released':
        raise HTTPException(409, 'This revision is not production ready yet')
    if a.priority not in PRIORITIES:
        raise HTTPException(422, 'Unknown priority')
    if a.due:
        try:
            datetime.date.fromisoformat(a.due[:10])
        except ValueError:
            raise HTTPException(422, 'Due date must be YYYY-MM-DD')
    if a.parts is not None:
        for s in a.parts:
            if not isinstance(s, dict) or not db.row('SELECT id FROM parts WHERE id=? AND revision_id=?', (s.get('part_id'), rid)) or int(s.get('quantity') or 0) < 0:
                raise HTTPException(422, 'Job order parts must belong to the revision with non-negative quantities')
    id = db.uid()
    with db.connect() as c:
        c.execute('BEGIN IMMEDIATE')
        n = c.execute('SELECT COALESCE(MAX(number),0)+1 FROM job_orders WHERE project_id=?', (pid,)).fetchone()[0]
        c.execute('INSERT INTO job_orders(id,project_id,revision_id,number,title,requirement,quantity,due,priority,customer,status,created,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                  (id, pid, rid, n, a.title.strip(), a.requirement, a.quantity, a.due[:10], a.priority, a.customer, 'open', db.now(), u['name']))
        rows = job_order_items(id, rid, a.quantity, a.parts, a.include_purchased)
        if not rows:
            raise HTTPException(422, 'Nothing to produce in this job order')
        c.executemany('INSERT INTO jo_items(id,job_order_id,part_id,part_name,category,seq,step,kind,required) VALUES(?,?,?,?,?,?,?,?,?)', rows)
        c.execute('INSERT INTO jo_events VALUES(?,?,?,?,?,?,?,?)', (db.uid(), id, None, u['name'], 'created', a.quantity, a.requirement[:1000], db.now()))
        db.audit(c, u['name'], 'joborder.created', {'id': id, 'number': n, 'title': a.title, 'quantity': a.quantity, 'items': len(rows)}, rid)
    return jo_payload(db.row('SELECT * FROM job_orders WHERE id=?', (id,)), True)


def get_jo(jid):
    j = db.row('SELECT j.*,p.name AS project_name,p.code AS project_code,r.number AS revision_number FROM job_orders j JOIN projects p ON p.id=j.project_id JOIN revisions r ON r.id=j.revision_id WHERE j.id=?', (jid,))
    if not j:
        raise HTTPException(404, 'Job order not found')
    return j


@router.get('/api/job-orders/{jid}')
def job_order(jid: str, request: Request):
    u = user(request)
    j = jo_payload(get_jo(jid), True)
    j['permissions'] = sorted(perms_for(u, j['project_id']))
    return j


class JobOrderEdit(BaseModel):
    model_config = ConfigDict(extra='forbid')
    status: str | None = None
    title: str | None = Field(default=None, max_length=160)
    requirement: str | None = Field(default=None, max_length=4000)
    due: str | None = Field(default=None, max_length=40)
    priority: str | None = None
    note: str = Field(default='', max_length=1000)


@router.patch('/api/job-orders/{jid}')
def edit_job_order(jid: str, a: JobOrderEdit, request: Request):
    j = get_jo(jid)
    u = editor(request, 'joborder.create', j['project_id'])
    sets = {k: v for k, v in a.model_dump().items() if v is not None and k != 'note'}
    if 'status' in sets and sets['status'] not in JO_STATUSES:
        raise HTTPException(422, 'Unknown status')
    if 'priority' in sets and sets['priority'] not in PRIORITIES:
        raise HTTPException(422, 'Unknown priority')
    if sets.get('due'):
        try:
            sets['due'] = datetime.date.fromisoformat(sets['due'][:10]).isoformat()
        except ValueError:
            raise HTTPException(422, 'Due date must be a date (YYYY-MM-DD)')
    if not sets:
        raise HTTPException(422, 'Nothing to change')
    if sets.get('status') in ('completed', 'cancelled'):
        sets['closed'] = db.now()
    with db.connect() as c:
        c.execute('UPDATE job_orders SET ' + ','.join(k + '=?' for k in sets) + ' WHERE id=?', (*sets.values(), jid))
        c.execute('INSERT INTO jo_events VALUES(?,?,?,?,?,?,?,?)', (db.uid(), jid, None, u['name'], 'status:' + sets['status'] if 'status' in sets else 'edited', 0, a.note, db.now()))
        db.audit(c, u['name'], 'joborder.updated', {'id': jid, **sets}, j['revision_id'])
    return {'ok': True}


class Progress(BaseModel):
    model_config = ConfigDict(extra='forbid')
    done: int | None = Field(default=None, ge=0, le=10000000)   # absolute count completed at this step
    add: int | None = Field(default=None, ge=-100000, le=100000)  # or an increment
    rejected: int = Field(default=0, ge=0, le=100000)
    status: str | None = None
    note: str = Field(default='', max_length=1000)
    at: str = Field(default='', max_length=40)  # when it happened (defaults to now)


@router.post('/api/job-orders/{jid}/items/{iid}')
def record_progress(jid: str, iid: str, a: Progress, request: Request):
    """Shop-floor record against one checklist line: count completed / rejected, with date & time."""
    j = get_jo(jid)
    u = editor(request, 'joborder.update', j['project_id'])
    it = db.row('SELECT * FROM jo_items WHERE id=? AND job_order_id=?', (iid, jid))
    if not it:
        raise HTTPException(404, 'Checklist item not found')
    done = it['done'] if a.done is None else a.done
    if a.add:
        done += a.add
    if done < 0 or done > it['required']:
        raise HTTPException(422, f"Count must be between 0 and {it['required']}")
    correction = done < it['done']
    # a closed job order only takes corrections (a count recorded by mistake); that reopens it
    if j['status'] in ('cancelled', 'on_hold') or (j['status'] == 'completed' and not correction):
        raise HTTPException(409, f"Job order is {j['status'].replace('_', ' ')}")
    if correction and it['kind'] not in ('procurement', 'assembly'):
        nxt = db.row("SELECT * FROM jo_items WHERE job_order_id=? AND part_id=? AND seq>? AND kind NOT IN ('procurement','assembly') ORDER BY seq LIMIT 1", (jid, it['part_id'], it['seq']))
        if nxt and done < nxt['done']:
            raise HTTPException(409, f"{nxt['done']} already passed the next step '{nxt['step']}' — correct that step first")
    # a part cannot pass a step more often than it passed the step before it
    if it['kind'] not in ('procurement', 'assembly') and done > it['done']:
        prev = db.row("SELECT * FROM jo_items WHERE job_order_id=? AND part_id=? AND seq<? AND kind NOT IN ('procurement','assembly') ORDER BY seq DESC LIMIT 1", (jid, it['part_id'], it['seq']))
        if prev and done > prev['done']:
            raise HTTPException(409, f"Only {prev['done']} passed '{prev['step']}' so far")
    status = a.status or ('done' if done >= it['required'] else 'in_progress' if done > 0 else 'blocked' if it['status'] == 'blocked' else 'pending')
    if status not in ('pending', 'in_progress', 'blocked', 'done'):
        raise HTTPException(422, 'Unknown status')
    when = db.now()
    if a.at:
        try:
            t = datetime.datetime.fromisoformat(a.at.replace('Z', '+00:00'))
            if t.tzinfo is None:
                t = t.replace(tzinfo=datetime.timezone.utc)
            if t > datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=5):
                raise ValueError()
            when = t.astimezone(datetime.timezone.utc).isoformat()
        except ValueError:
            raise HTTPException(422, 'Time must be an ISO date-time, not in the future')
    with db.connect() as c:
        c.execute("UPDATE jo_items SET done=?,rejected=rejected+?,status=?,started=CASE WHEN started='' THEN ? ELSE started END,finished=?,updated=?,updated_by=? WHERE id=?",
                  (done, a.rejected, status, when, when if status == 'done' else '', when, u['name'], iid))
        c.execute('INSERT INTO jo_events VALUES(?,?,?,?,?,?,?,?)', (db.uid(), jid, iid, u['name'], status, done - it['done'], (f'rejected {a.rejected}. ' if a.rejected else '') + a.note, when))
        if j['status'] == 'open' or (j['status'] == 'completed' and correction):
            c.execute("UPDATE job_orders SET status='in_progress',closed='' WHERE id=?", (jid,))
            if j['status'] == 'completed':
                c.execute('INSERT INTO jo_events VALUES(?,?,?,?,?,?,?,?)', (db.uid(), jid, None, u['name'], 'status:in_progress', 0, 'Reopened by a count correction', when))
        left = c.execute("SELECT COUNT(*) FROM jo_items WHERE job_order_id=? AND done<required", (jid,)).fetchone()[0]
        if left == 0:
            c.execute("UPDATE job_orders SET status='completed',closed=? WHERE id=?", (when, jid))
            c.execute('INSERT INTO jo_events VALUES(?,?,?,?,?,?,?,?)', (db.uid(), jid, None, 'Forge', 'status:completed', 0, 'All checklist items complete', when))
    return {'ok': True, 'done': done, 'status': status}


class Issue(BaseModel):
    model_config = ConfigDict(extra='forbid')
    body: str = Field(min_length=3, max_length=3000)


@router.post('/api/job-orders/{jid}/items/{iid}/issue')
def raise_issue(jid: str, iid: str, a: Issue, request: Request):
    """Production → design: an issue on a checklist line becomes a review comment on the part's revision."""
    j = get_jo(jid)
    u = editor(request, 'joborder.update', j['project_id'])
    it = db.row('SELECT * FROM jo_items WHERE id=? AND job_order_id=?', (iid, jid))
    if not it:
        raise HTTPException(404, 'Checklist item not found')
    part = it['part_id'] if not it['part_id'].startswith('joint:') else None
    body = f"[JO-{j['number']:03d} · {it['step']}] {a.body}"
    with db.connect() as c:
        c.execute('INSERT INTO comments VALUES(?,?,?,?,?,?,?,0)', (db.uid(), j['revision_id'], part, 'production', u['name'], body, db.now()))
        c.execute("UPDATE jo_items SET status='blocked',updated=?,updated_by=? WHERE id=?", (db.now(), u['name'], iid))
        c.execute('INSERT INTO jo_events VALUES(?,?,?,?,?,?,?,?)', (db.uid(), jid, iid, u['name'], 'issue', 0, a.body, db.now()))
        db.audit(c, u['name'], 'production.issue', {'job_order': jid, 'item': iid, 'body': a.body}, j['revision_id'])
    return {'ok': True}


# ============================================================================ dashboard
@router.get('/api/dashboard')
def dashboard(request: Request):
    u = user(request)
    jos = [jo_payload(j) for j in db.rows("SELECT j.*,p.name AS project_name,p.code AS project_code,r.number AS revision_number FROM job_orders j JOIN projects p ON p.id=j.project_id JOIN revisions r ON r.id=j.revision_id ORDER BY CASE j.status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 WHEN 'on_hold' THEN 2 ELSE 3 END, j.due, j.created DESC LIMIT 200")]
    active = [j for j in jos if j['status'] in ('open', 'in_progress', 'on_hold')]
    design = []
    for p in db.rows("SELECT p.id,p.name,p.code,r.id AS revision_id,r.number,r.status FROM projects p JOIN revisions r ON r.project_id=p.id AND r.state='active' WHERE p.archived=0"):
        s = db.row("SELECT COUNT(*) AS parts, SUM(reviewed) AS reviewed, SUM(doc_reviewed) AS docs FROM parts WHERE revision_id=? AND category!='purchased' AND excluded=0", (p['revision_id'],))
        open_c = db.row('SELECT COUNT(*) AS n FROM comments WHERE revision_id=? AND resolved=0', (p['revision_id'],))['n']
        design.append({**p, 'parts': s['parts'] or 0, 'reviewed': s['reviewed'] or 0, 'docs_reviewed': s['docs'] or 0, 'open_comments': open_c})
    events = db.rows('SELECT e.*,j.number,j.title,j.project_id FROM jo_events e JOIN job_orders j ON j.id=e.job_order_id ORDER BY e.created DESC LIMIT 40')
    issues = db.rows("SELECT c.*,r.project_id,pa.name AS part_name FROM comments c JOIN revisions r ON r.id=c.revision_id LEFT JOIN parts pa ON pa.id=c.part_id WHERE c.feature='production' AND c.resolved=0 ORDER BY c.created DESC LIMIT 30")
    today = datetime.date.today().isoformat()
    done_today = db.row('SELECT COALESCE(SUM(quantity),0) AS n FROM jo_events WHERE created>=? AND quantity>0', (today,))['n']
    return {'job_orders': jos, 'summary': {'active': len(active), 'overdue': sum(1 for j in active if j['overdue']), 'on_hold': sum(1 for j in active if j['status'] == 'on_hold'),
            'completed_30d': sum(1 for j in jos if j['status'] == 'completed' and (j.get('closed') or '') >= (datetime.date.today() - datetime.timedelta(days=30)).isoformat()),
            'done_today': done_today, 'open_issues': len(issues)},
            'design': design, 'events': events, 'issues': issues, 'user': {'name': u['name'], 'permissions': sorted(perms_for(u))}}
