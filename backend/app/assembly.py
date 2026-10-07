"""Assembly instructions: ordered steps the designer writes for the shop floor.

A step says which components go on (part occurrences of the STEP assembly), how they are joined (screw, bolt,
rivet, weld, press fit …), with which fasteners into which holes, the torque / thread locker / tools, and free
notes. Nothing is inferred: fasteners, torques and methods are the designer's input. Forge animates the steps in
the viewer and prints a work instruction (one page per step, rendered pictures of the build state).
"""
from __future__ import annotations

import hashlib
import io
import json
import math
from pathlib import Path

import numpy as np
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from . import db, storage
from .security import revision_access

router = APIRouter()

METHODS = {'place': 'Place / locate', 'screw': 'Screw', 'bolt': 'Bolt & nut', 'rivet': 'Rivet', 'weld': 'Weld',
           'press_fit': 'Press fit', 'adhesive': 'Adhesive / bond', 'clip': 'Clip / snap fit', 'insert': 'Press-in hardware',
           'cable': 'Route & tie cable', 'other': 'Other'}
FASTENERS = {
    'screw': [('ISO 4762', 'Socket head cap screw'), ('ISO 7380-1', 'Button head screw'), ('ISO 10642', 'Countersunk socket screw'),
              ('ISO 7045', 'Pan head screw, cross recess'), ('ISO 14583', 'Pan head screw, hexalobular'), ('ISO 7046', 'Countersunk screw, cross recess'),
              ('ISO 7049', 'Self-tapping pan head screw'), ('ISO 4026', 'Set screw, flat point'), ('ISO 4029', 'Set screw, cup point')],
    'bolt': [('ISO 4017', 'Hex head screw, full thread'), ('ISO 4014', 'Hex head bolt, partial thread'), ('ISO 8676', 'Hex head screw, fine thread'),
             ('DIN 603', 'Carriage bolt')],
    'nut': [('ISO 4032', 'Hex nut'), ('ISO 10511', 'Prevailing torque nut (nyloc)'), ('DIN 6923', 'Hex flange nut'), ('ISO 4035', 'Thin hex nut'),
            ('DIN 1587', 'Domed cap nut')],
    'washer': [('ISO 7089', 'Plain washer'), ('ISO 7090', 'Plain washer, chamfered'), ('ISO 7093', 'Large washer'), ('DIN 127 B', 'Spring washer'),
               ('DIN 6798 A', 'Serrated lock washer'), ('DIN 25201', 'Wedge lock washer pair')],
    'rivet': [('ISO 15983', 'Blind rivet, aluminium'), ('ISO 15977', 'Blind rivet, steel / aluminium'), ('ISO 16582', 'Blind rivet, steel')],
    'pin': [('ISO 8734', 'Dowel pin'), ('ISO 8752', 'Spring pin, heavy'), ('ISO 2341', 'Clevis pin')],
    'insert': [('hardware', 'Catalogue hardware (nut, stud, standoff, rivnut)')],
    'custom': [('custom', 'Custom / supplier part')],
}
THREADLOCK = ('', 'Loctite 222 (low)', 'Loctite 243 (medium)', 'Loctite 270 (high)', 'Loctite 290 (wicking)', 'Pre-applied patch', 'Anti-seize')
APPROACH = ('auto', '+x', '-x', '+y', '-y', '+z', '-z')


def load(v, default):
    try:
        return json.loads(v) if isinstance(v, str) else (v if v is not None else default)
    except ValueError:
        return default


class StepIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    title: str = Field(default='', max_length=160)
    parts: list[dict] = Field(default_factory=list, max_length=400)
    method: str = 'place'
    fasteners: list[dict] = Field(default_factory=list, max_length=40)
    welds: list[str] = Field(default_factory=list, max_length=200)
    notes: str = Field(default='', max_length=4000)
    tools: str = Field(default='', max_length=300)
    check: str = Field(default='', max_length=600)
    approach: str = 'auto'
    subs: list[str] = Field(default_factory=list, max_length=50)   # sub-assemblies fitted as one unit in this step
    group: str = ''                                                # sub-assembly the step belongs to ('' = main); set on create


def instances_of(rid):
    f = db.revdir(rid) / 'instances.json'
    if not f.exists():
        try:
            storage.restore(rid, 'instances.json', f)
        except Exception:
            pass
    return load(f.read_text(), {}) if f.exists() else {}


def fastener_designation(f):
    k = f['kind']
    if k == 'insert':
        from .hardware import BY_ID, designation
        it = BY_ID.get(f.get('item') or '')
        return designation(it) if it else (f.get('name') or 'Hardware')
    if k == 'custom':
        return ' '.join(x for x in (f.get('name', ''), f.get('pn', '')) if x)
    name = dict(FASTENERS[k]).get(f['standard'], '')
    size = f.get('size', '')
    if f.get('length') and k in ('screw', 'bolt', 'rivet', 'pin'):
        size = f'{size}×{f["length"]:g}'
    return f"{f['standard']} {size} {name}".strip()


def clean_step(rid, a: StepIn, group='', sid=None):
    if a.method not in METHODS:
        raise HTTPException(422, 'Unknown joining method')
    if a.approach not in APPROACH:
        raise HTTPException(422, 'Unknown approach direction')
    rows = {p['id']: p for p in db.rows('SELECT id,name,quantity,geometry FROM parts WHERE revision_id=?', (rid,))}
    inst = instances_of(rid)
    parts, seen = [], set()
    for e in a.parts:
        pid = str(e.get('part', ''))
        if pid not in rows:
            raise HTTPException(422, 'Part outside revision')
        n = max(len(inst.get(pid) or []), int(rows[pid]['quantity'] or 1), 1)
        occ = sorted({int(o) for o in (e.get('occurrences') or [0])})
        if not occ or occ[0] < 0 or occ[-1] >= n:
            raise HTTPException(422, f"Occurrence outside 1..{n} for {rows[pid]['name']}")
        if pid in seen:
            raise HTTPException(422, 'A part is listed twice in one step')
        seen.add(pid)
        parts.append({'part': pid, 'occurrences': occ})
    holes_of = {}
    fasteners = []
    for f in a.fasteners:
        if not isinstance(f, dict):
            raise HTTPException(422, 'Invalid fastener')
        k = f.get('kind')
        if k not in FASTENERS:
            raise HTTPException(422, 'Unknown fastener kind')
        out = {'kind': k, 'qty': int(f.get('qty') or 0)}
        if not 1 <= out['qty'] <= 999:
            raise HTTPException(422, 'Fastener quantity must be 1–999')
        if k == 'insert':
            from .hardware import BY_ID
            if f.get('item') not in BY_ID:
                raise HTTPException(422, 'Unknown catalogue hardware')
            out['item'] = f['item']
        elif k == 'custom':
            out['name'] = str(f.get('name', '')).strip()[:120]
            out['pn'] = str(f.get('pn', '')).strip()[:80]
            if not out['name']:
                raise HTTPException(422, 'Name the custom fastener')
        else:
            if f.get('standard') not in dict(FASTENERS[k]):
                raise HTTPException(422, f'Unknown {k} standard')
            out['standard'] = f['standard']
            size = str(f.get('size', '')).strip()
            if not size or len(size) > 16:
                raise HTTPException(422, 'Fastener size is required (e.g. M5)')
            out['size'] = size
            if k in ('screw', 'bolt', 'rivet', 'pin'):
                L = float(f.get('length') or 0)
                if not .5 <= L <= 1000:
                    raise HTTPException(422, 'Fastener length is required (mm)')
                out['length'] = round(L, 2)
        for key, lim in (('torque', 40), ('note', 200)):
            out[key] = str(f.get(key, '') or '').strip()[:lim]
        tl = str(f.get('threadlock', '') or '')
        if tl not in THREADLOCK:
            raise HTTPException(422, 'Unknown thread locker')
        out['threadlock'] = tl
        holes = []
        for h in f.get('holes') or []:
            pid, hid = str(h.get('part', '')), str(h.get('hole', ''))
            if pid not in rows:
                raise HTTPException(422, 'Hole on a part outside the revision')
            if pid not in holes_of:
                holes_of[pid] = {x['id'] for x in load(rows[pid]['geometry'], {}).get('holes', [])}
            if hid not in holes_of[pid]:
                raise HTTPException(422, 'Unknown hole ' + hid)
            holes.append({'part': pid, 'occurrence': int(h.get('occurrence') or 0), 'hole': hid})
        if len(holes) > 400:
            raise HTTPException(422, 'Too many holes')
        out['holes'] = holes
        out['designation'] = fastener_designation(out)
        fasteners.append(out)
    welds = []
    if a.welds:
        ok = {j['id'] for j in db.rows("SELECT id FROM joints WHERE revision_id=? AND kind='weld'", (rid,))}
        welds = [w for w in dict.fromkeys(a.welds) if w in ok]
    subs = []
    if a.subs:
        groups = {g['id'] for g in db.rows('SELECT id FROM assembly_groups WHERE revision_id=?', (rid,))}
        used = {x: r['id'] for r in db.rows('SELECT id,data FROM assembly_steps WHERE revision_id=?', (rid,)) for x in load(r['data'], {}).get('subs', [])}
        for g in dict.fromkeys(a.subs):
            if g not in groups:
                raise HTTPException(422, 'Unknown sub-assembly')
            if g == group or group in sub_closure(rid, g):
                raise HTTPException(422, 'A sub-assembly cannot be fitted into itself')
            if used.get(g) and used[g] != sid:
                raise HTTPException(422, 'That sub-assembly is already fitted in another step')
            subs.append(g)
    return {'title': a.title.strip(), 'parts': parts, 'method': a.method, 'fasteners': fasteners, 'welds': welds,
            'notes': a.notes.strip(), 'tools': a.tools.strip(), 'check': a.check.strip(), 'approach': a.approach, 'subs': subs}


def sub_closure(rid, g, seen=None):
    """Sub-assemblies (transitively) fitted inside sub-assembly g."""
    seen = seen if seen is not None else set()
    for r in db.rows('SELECT data FROM assembly_steps WHERE revision_id=? AND grp=?', (rid, g)):
        for x in load(r['data'], {}).get('subs', []):
            if x not in seen:
                seen.add(x)
                sub_closure(rid, x, seen)
    return seen


def groups_of(rid):
    return db.rows('SELECT id,name,seq,notes FROM assembly_groups WHERE revision_id=? ORDER BY seq,created', (rid,))


def steps_of(rid):
    """Build order: every sub-assembly's steps (in sub-assembly order), then the main assembly."""
    rank = {g['id']: i for i, g in enumerate(groups_of(rid))}
    rows = db.rows('SELECT * FROM assembly_steps WHERE revision_id=? ORDER BY seq,created', (rid,))
    rows.sort(key=lambda r: (rank.get(r['grp'] or '', len(rank)), r['seq']))
    return [{'id': r['id'], 'seq': r['seq'], 'group': r['grp'] or '', 'subs': [], **load(r['data'], {}), 'updated': r['updated'], 'author': r['author']}
            for r in rows]


def touch(rid):
    (db.revdir(rid) / 'assembly-instructions.pdf').unlink(missing_ok=True)


@router.get('/api/assembly-config')
def assembly_config():
    from .hardware import CATALOG
    return {'methods': METHODS, 'fasteners': {k: [{'standard': s, 'name': n} for s, n in v] for k, v in FASTENERS.items()},
            'threadlock': THREADLOCK, 'approach': APPROACH,
            'hardware': [{'id': i['id'], 'name': i['name'], 'type': i['type'], 'pn': i['pn']} for i in CATALOG if i['type'] in ('nut', 'flush_nut', 'stud', 'standoff', 'rivnut', 'weld_nut')]}


@router.get('/api/revisions/{rid}/assembly-steps')
def list_steps(rid: str, request: Request):
    revision_access(request, rid)
    return steps_of(rid)


def writable(request, rid):
    u = revision_access(request, rid, True, 'part.edit')
    r = db.row('SELECT state,status FROM revisions WHERE id=?', (rid,))
    if not r or r['state'] != 'active' or r['status'] != 'ready':
        raise HTTPException(409, 'Only an active, ready revision can be edited')
    return u


@router.post('/api/revisions/{rid}/assembly-steps')
def create_step(rid: str, a: StepIn, request: Request, at: int | None = None):
    u = writable(request, rid)
    grp = a.group or ''
    if grp and not db.row('SELECT id FROM assembly_groups WHERE id=? AND revision_id=?', (grp, rid)):
        raise HTTPException(422, 'Unknown sub-assembly')
    data = clean_step(rid, a, grp)
    with db.connect() as c:
        c.execute('BEGIN IMMEDIATE')
        if c.execute('SELECT COUNT(*) FROM assembly_steps WHERE revision_id=?', (rid,)).fetchone()[0] >= 500:
            raise HTTPException(422, 'At most 500 steps')
        n = c.execute('SELECT COUNT(*) FROM assembly_steps WHERE revision_id=? AND grp=?', (rid, grp)).fetchone()[0]
        seq = n if at is None else max(0, min(n, at))
        c.execute('UPDATE assembly_steps SET seq=seq+1 WHERE revision_id=? AND grp=? AND seq>=?', (rid, grp, seq))
        sid = db.uid()
        c.execute('INSERT INTO assembly_steps(id,revision_id,seq,data,created,author,updated,grp) VALUES(?,?,?,?,?,?,?,?)', (sid, rid, seq, json.dumps(data), db.now(), u['name'], db.now(), grp))
        db.audit(c, u['name'], 'assembly.step.created', {'id': sid, 'seq': seq + 1, 'title': data['title'], 'group': grp}, rid)
    touch(rid)
    return {'id': sid, 'seq': seq, 'group': grp, **data}


@router.put('/api/assembly-steps/{sid}')
def update_step(sid: str, a: StepIn, request: Request):
    s = db.row('SELECT * FROM assembly_steps WHERE id=?', (sid,))
    if not s:
        raise HTTPException(404, 'Step not found')
    u = writable(request, s['revision_id'])
    data = clean_step(s['revision_id'], a, s['grp'] or '', sid)
    with db.connect() as c:
        c.execute('UPDATE assembly_steps SET data=?,updated=?,author=? WHERE id=?', (json.dumps(data), db.now(), u['name'], sid))
        db.audit(c, u['name'], 'assembly.step.updated', {'id': sid, 'title': data['title']}, s['revision_id'])
    touch(s['revision_id'])
    return {'id': sid, 'seq': s['seq'], 'group': s['grp'] or '', **data}


@router.delete('/api/assembly-steps/{sid}')
def delete_step(sid: str, request: Request):
    s = db.row('SELECT * FROM assembly_steps WHERE id=?', (sid,))
    if not s:
        raise HTTPException(404, 'Step not found')
    u = writable(request, s['revision_id'])
    with db.connect() as c:
        c.execute('DELETE FROM assembly_steps WHERE id=?', (sid,))
        c.execute('UPDATE assembly_steps SET seq=seq-1 WHERE revision_id=? AND grp=? AND seq>?', (s['revision_id'], s['grp'] or '', s['seq']))
        db.audit(c, u['name'], 'assembly.step.deleted', {'id': sid, **load(s['data'], {})}, s['revision_id'])
    touch(s['revision_id'])
    return {'ok': True}


class Order(BaseModel):
    model_config = ConfigDict(extra='forbid')
    ids: list[str] = Field(max_length=500)
    group: str = ''


@router.post('/api/revisions/{rid}/assembly-steps/order')
def reorder(rid: str, a: Order, request: Request):
    u = writable(request, rid)
    have = [r['id'] for r in db.rows('SELECT id FROM assembly_steps WHERE revision_id=? AND grp=? ORDER BY seq', (rid, a.group or ''))]
    if sorted(have) != sorted(a.ids):
        raise HTTPException(422, 'The order must list every step of the (sub-)assembly once')
    with db.connect() as c:
        for i, sid in enumerate(a.ids):
            c.execute('UPDATE assembly_steps SET seq=? WHERE id=?', (i, sid))
        db.audit(c, u['name'], 'assembly.steps.reordered', {'count': len(a.ids)}, rid)
    touch(rid)
    return {'ok': True}


class GroupIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=120)
    notes: str = Field(default='', max_length=1000)


@router.get('/api/revisions/{rid}/assembly-groups')
def list_groups(rid: str, request: Request):
    revision_access(request, rid)
    return groups_of(rid)


@router.post('/api/revisions/{rid}/assembly-groups')
def create_group(rid: str, a: GroupIn, request: Request):
    u = writable(request, rid)
    gid = db.uid()
    with db.connect() as c:
        n = c.execute('SELECT COUNT(*) FROM assembly_groups WHERE revision_id=?', (rid,)).fetchone()[0]
        if n >= 100:
            raise HTTPException(422, 'At most 100 sub-assemblies')
        c.execute('INSERT INTO assembly_groups(id,revision_id,seq,name,notes,created,author) VALUES(?,?,?,?,?,?,?)', (gid, rid, n, a.name.strip(), a.notes.strip(), db.now(), u['name']))
        db.audit(c, u['name'], 'assembly.group.created', {'id': gid, 'name': a.name}, rid)
    touch(rid)
    return {'id': gid, 'name': a.name.strip(), 'seq': n, 'notes': a.notes.strip()}


@router.put('/api/assembly-groups/{gid}')
def rename_group(gid: str, a: GroupIn, request: Request):
    g = db.row('SELECT * FROM assembly_groups WHERE id=?', (gid,))
    if not g:
        raise HTTPException(404, 'Sub-assembly not found')
    u = writable(request, g['revision_id'])
    with db.connect() as c:
        c.execute('UPDATE assembly_groups SET name=?,notes=? WHERE id=?', (a.name.strip(), a.notes.strip(), gid))
        db.audit(c, u['name'], 'assembly.group.updated', {'id': gid, 'name': a.name}, g['revision_id'])
    touch(g['revision_id'])
    return {'ok': True}


@router.delete('/api/assembly-groups/{gid}')
def delete_group(gid: str, request: Request):
    """Deletes the sub-assembly with its steps; steps that fitted it no longer do."""
    g = db.row('SELECT * FROM assembly_groups WHERE id=?', (gid,))
    if not g:
        raise HTTPException(404, 'Sub-assembly not found')
    rid = g['revision_id']
    u = writable(request, rid)
    with db.connect() as c:
        c.execute('DELETE FROM assembly_steps WHERE revision_id=? AND grp=?', (rid, gid))
        for r in c.execute('SELECT id,data FROM assembly_steps WHERE revision_id=?', (rid,)).fetchall():
            d = load(r['data'], {})
            if gid in d.get('subs', []):
                d['subs'] = [x for x in d['subs'] if x != gid]
                c.execute('UPDATE assembly_steps SET data=? WHERE id=?', (json.dumps(d), r['id']))
        c.execute('DELETE FROM assembly_groups WHERE id=?', (gid,))
        c.execute('UPDATE assembly_groups SET seq=seq-1 WHERE revision_id=? AND seq>?', (rid, g['seq']))
        db.audit(c, u['name'], 'assembly.group.deleted', {'id': gid, 'name': g['name']}, rid)
    touch(rid)
    return {'ok': True}


def build_states(steps):
    """For every step of the build order: the occurrences visible ((part, occ) -> 'done' | 'new'). A sub-assembly
    step shows only that sub-assembly; fitting a sub-assembly brings all of its parts in as one unit."""
    own = {}
    for s in steps:
        own.setdefault(s.get('group', ''), []).append(s)

    def all_of(g, seen=()):
        out = []
        for s in own.get(g, []):
            out += [(e['part'], o) for e in s.get('parts', []) for o in e.get('occurrences', [0])]
            for x in s.get('subs', []):
                if x not in seen:
                    out += all_of(x, seen + (g,))
        return out

    states = []
    for s in steps:
        g = s.get('group', '')
        st = {}
        for p in own.get(g, []):
            new = p is s
            items = [(e['part'], o) for e in p.get('parts', []) for o in e.get('occurrences', [0])] + [x for sub in p.get('subs', []) for x in all_of(sub, (g,))]
            for k in items:
                if new or k not in st:
                    st[k] = 'new' if new else 'done'
            if new:
                break
        states.append(st)
    return states


# ============================================================================ work instruction PDF
_MESH = {}


def part_mesh(rid, pid):
    key = (rid, pid)
    if key in _MESH:
        return _MESH[key]
    from .cad import read_brep
    from .render import mesh_data
    folder = db.revdir(rid) / 'parts' / pid
    brep = folder / 'shape.brep'
    if not brep.exists():
        storage.restore(rid, f'parts/{pid}/shape.brep', brep)
    md = mesh_data(read_brep(str(brep))) if brep.exists() else None
    if len(_MESH) > 600:
        _MESH.clear()
    _MESH[key] = md
    return md


def placed(md, M, color):
    R, t = M[:3, :3], M[:3, 3]
    n = md['n'] @ R.T
    return {'v': md['v'] @ R.T + t, 'n': n, 'f': md['f'], 'c': np.tile(np.asarray(color, float), (len(md['v']), 1))}


def merge(mds):
    off, V, N, F, C = 0, [], [], [], []
    for m in mds:
        V.append(m['v']); N.append(m['n']); C.append(m['c']); F.append(m['f'] + off); off += len(m['v'])
    return {'v': np.vstack(V), 'n': np.vstack(N), 'f': np.vstack(F), 'c': np.vstack(C)}


DONE = (0.80, 0.82, 0.85)
NEW = (0.33, 0.58, 0.96)
VIEW_N = np.array([1.0, -1.25, 0.9]) / np.linalg.norm([1.0, -1.25, 0.9])


def instructions_pdf(rid, progress=None):
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.units import mm
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas
    from .render import view_image, best_view, frame
    steps = steps_of(rid)
    rev = db.row('SELECT r.*, p.name AS project_name, p.code AS project_code FROM revisions r JOIN projects p ON p.id=r.project_id WHERE r.id=?', (rid,))
    parts = {p['id']: p for p in db.rows('SELECT id,name,category,geometry FROM parts WHERE revision_id=?', (rid,))}
    inst = instances_of(rid)
    out = db.revdir(rid) / 'assembly-instructions.pdf'
    W, H = landscape(A4)
    c = canvas.Canvas(str(out), pagesize=(W, H))
    c.setTitle(f"Assembly instructions — {rev['project_name']} rev {rev['number']}")
    right = np.cross([0, 0, 1.0], VIEW_N)
    right /= np.linalg.norm(right)
    up = np.cross(VIEW_N, right)

    def matrix(pid, occ):
        lst = inst.get(pid) or []
        if occ < len(lst):
            return np.array(lst[occ]['matrix'], float)
        return np.eye(4)

    def header(title):
        c.setFillColorRGB(.06, .09, .16)
        c.setFont('Helvetica-Bold', 9)
        c.drawString(12 * mm, H - 10 * mm, 'ASSEMBLY INSTRUCTIONS')
        c.setFont('Helvetica', 9)
        c.drawString(56 * mm, H - 10 * mm, f"{rev['project_code'] or ''} {rev['project_name']} · rev {rev['number']}")
        c.drawRightString(W - 12 * mm, H - 10 * mm, title)
        c.setStrokeColorRGB(.8, .83, .87)
        c.line(12 * mm, H - 12.5 * mm, W - 12 * mm, H - 12.5 * mm)

    def wrap(text, width, font='Helvetica', size=9):
        from reportlab.pdfbase.pdfmetrics import stringWidth
        lines = []
        for para in (text or '').splitlines() or ['']:
            cur = ''
            for word in para.split(' '):
                nxt = (cur + ' ' + word).strip()
                if stringWidth(nxt, font, size) > width and cur:
                    lines.append(cur)
                    cur = word
                else:
                    cur = nxt
            lines.append(cur)
        return lines

    if not steps:
        header('No steps')
        c.setFont('Helvetica', 12)
        c.drawString(20 * mm, H / 2, 'No assembly steps have been written for this revision yet.')
        c.save()
        return out
    states = build_states(steps)
    gname = {g['id']: g['name'] for g in groups_of(rid)}
    for k, s in enumerate(steps):
        if progress:
            progress(k + 1, len(steps))
        header(f"{('Sub-assembly ' + gname.get(s.get('group'), '') + ' · ') if s.get('group') else 'Main assembly · '}Step {k + 1} of {len(steps)}")
        meshes = []
        flags = []
        for (pid, o), state in states[k].items():
            md = part_mesh(rid, pid)
            if md is None:
                continue
            meshes.append(placed(md, matrix(pid, o), NEW if state == 'new' else DONE))
            flags.append(state == 'new')
        box = (12 * mm, 16 * mm, 182 * mm, H - 34 * mm)
        markers = []
        if meshes:
            md = merge(meshes)
            # camera per step: the side from which the parts fitted in this step are best seen
            new_tri = np.concatenate([np.full(len(m['f']), fl) for m, fl in zip(meshes, flags)])
            view_n = best_view(md, focus=new_tri) if new_tri is not None and new_tri.any() and not new_tri.all() else VIEW_N
            right, up = frame(view_n)
            P2 = np.c_[md['v'] @ right, md['v'] @ up]
            lo, hi = P2.min(0), P2.max(0)
            pad = (hi - lo) * .04 + 1
            lo, hi = lo - pad, hi + pad
            img = view_image(md, view_n, right, lo, hi, px_per_mm=1600 / max(hi - lo), max_px=1600)
            bw, bh = box[2] - box[0], box[3] - box[1]
            sc = min(bw / (hi - lo)[0], bh / (hi - lo)[1])
            iw, ih = (hi - lo)[0] * sc, (hi - lo)[1] * sc
            ix, iy = box[0] + (bw - iw) / 2, box[1] + (bh - ih) / 2
            c.drawImage(ImageReader(io.BytesIO(img)), ix, iy, iw, ih)
            to_paper = lambda p: (ix + (p @ right - lo[0]) * sc, iy + (p @ up - lo[1]) * sc)  # noqa: E731
            # fastener holes: letter per fastener line at the hole end facing the reader
            for fi, f in enumerate(s.get('fasteners', [])):
                for h in f.get('holes', []):
                    g = load(parts.get(h['part'], {}).get('geometry'), {})
                    hole = next((x for x in g.get('holes', []) if x['id'] == h['hole']), None)
                    if not hole:
                        continue
                    M = matrix(h['part'], h.get('occurrence', 0))
                    ax = np.asarray(hole['axis'], float)
                    ends = [np.asarray(hole['origin'], float) + ax * hole.get(e, 0) for e in ('start', 'end')]
                    ends = [M[:3, :3] @ e + M[:3, 3] for e in ends]
                    e = max(ends, key=lambda q: q @ view_n)
                    markers.append((fi, to_paper(e)))
        c.setStrokeColorRGB(.85, .2, .1)
        c.setFillColorRGB(.85, .2, .1)
        for fi, (x, y) in markers:
            c.setLineWidth(1)
            c.circle(x, y, 2.2 * mm, stroke=1, fill=0)
            c.setFont('Helvetica-Bold', 7)
            c.drawString(x + 2.6 * mm, y + 1.6 * mm, chr(65 + fi % 26))
        # right column
        x0, y = 192 * mm, H - 24 * mm
        colw = W - x0 - 12 * mm
        c.setFillColorRGB(.06, .09, .16)
        c.setFont('Helvetica-Bold', 15)
        for line in wrap(f"{k + 1}. {s.get('title') or METHODS.get(s.get('method'), 'Step')}", colw, 'Helvetica-Bold', 15)[:3]:
            c.drawString(x0, y, line)
            y -= 6.5 * mm
        c.setFont('Helvetica', 9.5)
        c.setFillColorRGB(.2, .35, .75)
        c.drawString(x0, y, METHODS.get(s.get('method'), ''))
        y -= 8 * mm

        def section(title):
            nonlocal y
            c.setFillColorRGB(.4, .45, .52)
            c.setFont('Helvetica-Bold', 7.5)
            c.drawString(x0, y, title.upper())
            y -= 4.8 * mm
            c.setFillColorRGB(.06, .09, .16)

        section('Components')
        c.setFont('Helvetica', 9)
        for e in s.get('parts', [])[:14]:
            nm = parts.get(e['part'], {}).get('name', e['part'])
            c.setFillColorRGB(*NEW)
            c.rect(x0, y - .4 * mm, 2.6 * mm, 2.6 * mm, stroke=0, fill=1)
            c.setFillColorRGB(.06, .09, .16)
            c.drawString(x0 + 4.5 * mm, y, (nm[:52] + '…' if len(nm) > 53 else nm) + f"  ×{len(e.get('occurrences', [0]))}")
            y -= 5 * mm
        for x in s.get('subs', []):
            c.setFillColorRGB(*NEW)
            c.rect(x0, y - .4 * mm, 2.6 * mm, 2.6 * mm, stroke=0, fill=1)
            c.setFillColorRGB(.06, .09, .16)
            c.drawString(x0 + 4.5 * mm, y, f"Sub-assembly: {gname.get(x, '?')}")
            y -= 5 * mm
        if s.get('fasteners'):
            y -= 2 * mm
            section('Fasteners')
            for fi, f in enumerate(s['fasteners']):
                c.setFillColorRGB(.85, .2, .1)
                c.setFont('Helvetica-Bold', 9)
                c.drawString(x0, y, chr(65 + fi % 26))
                c.setFillColorRGB(.06, .09, .16)
                for i, line in enumerate(wrap(f"{f['qty']} × {f['designation']}", colw - 6 * mm, 'Helvetica-Bold', 9)[:2]):
                    c.drawString(x0 + 5 * mm, y, line)
                    y -= 4.4 * mm
                extra = ' · '.join(x for x in (f.get('torque') and f"Torque {f['torque']}", f.get('threadlock'), f.get('note')) if x)
                if extra:
                    c.setFont('Helvetica', 8.5)
                    for line in wrap(extra, colw - 6 * mm, 'Helvetica', 8.5)[:2]:
                        c.drawString(x0 + 5 * mm, y, line)
                        y -= 4.2 * mm
                y -= 1.5 * mm
        for title, key in (('Tools', 'tools'), ('Instructions', 'notes'), ('Check', 'check')):
            if s.get(key) and y > 24 * mm:
                y -= 2 * mm
                section(title)
                c.setFont('Helvetica', 9)
                for line in wrap(s[key], colw):
                    if y < 18 * mm:
                        c.drawString(x0, y, '…')
                        break
                    c.drawString(x0, y, line)
                    y -= 4.4 * mm
        c.setFont('Helvetica', 7)
        c.setFillColorRGB(.45, .5, .56)
        c.drawString(12 * mm, 8 * mm, 'Blue: fitted in this step · grey: already assembled · red letters: fastener positions')
        c.drawRightString(W - 12 * mm, 8 * mm, f'Page {k + 1}/{len(steps)}')
        c.showPage()
    c.save()
    return out


def instructions_job(rid):
    return db.row("SELECT * FROM jobs WHERE revision_id=? AND kind='instructions' ORDER BY created DESC LIMIT 1", (rid,))


@router.get('/api/revisions/{rid}/assembly-instructions')
def instructions_status(rid: str, request: Request):
    """Work-instruction PDF state: ready (current with the steps), generating (with progress), failed or missing."""
    revision_access(request, rid)
    out = db.revdir(rid) / 'assembly-instructions.pdf'
    if not out.exists():
        try:
            storage.restore(rid, 'assembly-instructions.pdf', out)
        except Exception:
            pass
    j = instructions_job(rid)
    if j and j['status'] in ('queued', 'running', 'cancelling'):
        r = db.row('SELECT progress,message FROM revisions WHERE id=?', (rid,))
        return {'state': 'generating', 'progress': r['progress'] if j['status'] == 'running' else 0, 'message': r['message'] if j['status'] == 'running' else 'Waiting for the worker'}
    if out.exists():
        return {'state': 'ready', 'size': out.stat().st_size}
    if j and j['status'] == 'failed':
        return {'state': 'failed', 'error': j['error']}
    return {'state': 'missing'}


@router.post('/api/revisions/{rid}/assembly-instructions')
def generate_instructions(rid: str, request: Request):
    """Queue the work-instruction PDF (rendering every step can take a while on large assemblies)."""
    u = revision_access(request, rid)
    if u.get('role') == 'vendor':
        raise HTTPException(403, 'Vendor links are read-only')
    if not db.row('SELECT id FROM assembly_steps WHERE revision_id=? LIMIT 1', (rid,)):
        raise HTTPException(422, 'Write the assembly steps first')
    j = instructions_job(rid)
    if j and j['status'] in ('queued', 'running', 'cancelling'):
        return {'job': j['id'], 'state': 'generating'}
    (db.revdir(rid) / 'assembly-instructions.pdf').unlink(missing_ok=True)
    jid = db.uid()
    with db.connect() as c:
        c.execute('INSERT INTO jobs(id,revision_id,kind,status,created,error,payload) VALUES(?,?,?,?,?,?,?)', (jid, rid, 'instructions', 'queued', db.now(), '', '{}'))
        db.audit(c, u['name'], 'assembly.instructions.requested', {}, rid)
    return {'job': jid, 'state': 'generating'}


@router.get('/api/revisions/{rid}/assembly-instructions.pdf')
def instructions(rid: str, request: Request):
    revision_access(request, rid)
    out = db.revdir(rid) / 'assembly-instructions.pdf'
    if not out.exists():
        try:
            storage.restore(rid, 'assembly-instructions.pdf', out)
        except Exception:
            pass
    if not out.exists():
        j = instructions_job(rid)
        if j and j['status'] in ('queued', 'running', 'cancelling'):
            raise HTTPException(409, 'The work instructions are being generated')
        raise HTTPException(404, 'Generate the work instructions first')
    return FileResponse(out, media_type='application/pdf', filename='assembly-instructions.pdf')
