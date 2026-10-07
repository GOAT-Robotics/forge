"""Inspection planning and recording: ballooned drawings, critical characteristics, measurements per serial,
first-article / inspection reports and nonconformance disposition."""
import csv, io, json, math, re
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field, ConfigDict
from reportlab.lib.units import mm
from . import db, storage, inspection
from .security import revision_access
from .access import can, require, project_of_revision

router = APIRouter()


def _part(pid):
    p = db.row('SELECT * FROM parts WHERE id=?', (pid,))
    if not p:
        raise HTTPException(404, 'Part not found')
    p['geometry'] = json.loads(p['geometry'])
    p['spec'] = json.loads(p['spec'])
    return p


def _rev(rid):
    r = db.row('SELECT * FROM revisions WHERE id=?', (rid,))
    if not r:
        raise HTTPException(404, 'Revision not found')
    return r


def overrides(pid):
    return {r['key']: json.loads(r['data']) for r in db.rows('SELECT key,data FROM char_overrides WHERE part_id=?', (pid,))}


def load_chars(p, required=True):
    """Generated characteristics merged with the engineer's overrides; [] when the drawing has none yet."""
    folder = db.revdir(p['revision_id']) / 'parts' / p['id']
    path = folder / 'characteristics.json'
    if not path.exists():
        try:
            storage.restore(p['revision_id'], f"parts/{p['id']}/characteristics.json", path)
        except Exception:
            pass
    if not path.exists() or (folder / '.drawing-invalid').exists():
        if required:
            raise HTTPException(409, 'Generate documents to create the drawing and its inspection characteristics')
        return []
    data = json.loads(path.read_text())
    return inspection.merged(data.get('chars', []), overrides(p['id']))


def _summary(p, chars, records):
    flat = inspection.flat_list(chars)
    keys = {q['key'] for q in flat}
    crit = {q['key'] for q in flat if q.get('critical')}
    serials = {}
    for m in records:
        s = serials.setdefault(m['serial'], {'serial': m['serial'], 'measured': set(), 'fail': 0, 'fa': False, 'open_ncr': 0, 'last': ''})
        if m['char_key'] in keys:
            s['measured'].add(m['char_key'])
        s['fail'] += m['result'] != 'PASS'
        s['open_ncr'] += m['result'] != 'PASS' and not m['disposition']
        s['fa'] |= bool(m['first_article'])
        s['last'] = max(s['last'], m['created'])
    out = []
    for s in serials.values():
        need = keys if s['fa'] else crit
        missing = len(need - s['measured'])
        status = 'nonconforming' if s['fail'] else ('complete' if not missing else 'incomplete')
        out.append({'serial': s['serial'], 'first_article': s['fa'], 'measured': len(s['measured']), 'required': len(need), 'missing': missing,
                    'failures': s['fail'], 'open_ncr': s['open_ncr'], 'status': status, 'last': s['last']})
    out.sort(key=lambda s: s['last'])
    fa = next((s for s in out if s['first_article']), None)
    return {'part_id': p['id'], 'name': p['name'], 'category': p['category'], 'quantity': p['quantity'], 'characteristics': len(flat),
            'critical': len(crit), 'balloons': sum(1 for c in chars if c.get('selected')), 'candidates': len(inspection.flat_list(chars, True)), 'serials': out,
            'fai': 'not started' if not fa else ('passed' if fa['status'] == 'complete' else fa['status']),
            'open_ncr': sum(s['open_ncr'] for s in out)}


# ------------------------------------------------------------------------------------------- characteristics
@router.get('/api/parts/{pid}/characteristics')
def characteristics(pid: str, request: Request):
    p = _part(pid)
    access = revision_access(request, p['revision_id'])
    chars = load_chars(p)
    pr = project_of_revision(p['revision_id'])
    return {'chars': chars, 'editable': access['role'] != 'vendor' and can(access, 'qc.plan', pr),
            'can_record': access['role'] != 'vendor' and can(access, 'qc.record', pr)}


class CharEdit(BaseModel):
    model_config = ConfigDict(extra='forbid')
    inspect: bool | None = None
    critical: bool | None = None
    lower: float | None = None
    upper: float | None = None
    reset_limits: bool = False
    method: str | None = Field(default=None, max_length=80)
    note: str | None = Field(default=None, max_length=300)


@router.put('/api/parts/{pid}/characteristics/{key}')
def edit_characteristic(pid: str, key: str, a: CharEdit, request: Request):
    p = _part(pid)
    u = revision_access(request, p['revision_id'], True, 'qc.plan')
    q = next((q for q in inspection.flat_list(load_chars(p), True) if q['key'] == key), None)
    if q is None:
        raise HTTPException(404, 'Characteristic not found on the current drawing')
    o = overrides(pid).get(key, {})
    if a.inspect is not None:
        o['inspect'] = a.inspect
        if not a.inspect:
            o['critical'] = False  # a critical characteristic is always inspected
    if a.critical is not None:
        o['critical'] = a.critical
        if a.critical:
            o['inspect'] = True
    if a.method is not None:
        o['method'] = a.method.strip()
    if a.note is not None:
        o['note'] = a.note.strip()
    if a.reset_limits:
        o.pop('lower', None)
        o.pop('upper', None)
    elif a.lower is not None or a.upper is not None:
        if q['nominal'] is None:
            raise HTTPException(422, 'Attribute checks (threads, THRU) have no numeric limits')
        lo = a.lower if a.lower is not None else q['lower']
        hi = a.upper if a.upper is not None else q['upper']
        if lo is None or hi is None or not (math.isfinite(lo) and math.isfinite(hi)) or lo > hi:
            raise HTTPException(422, 'Limits must be finite numbers with lower <= upper')
        if not (lo - 1e-9 <= q['nominal'] <= hi + 1e-9):
            raise HTTPException(422, f"The nominal {q['nominal']:g} must lie within the limits")
        o['lower'], o['upper'] = float(lo), float(hi)
    _store(pid, key, o, u, p, {'characteristic': q['no'], 'label': q['label'], **a.model_dump(exclude_none=True)})
    return {'ok': True}


class BulkSelect(BaseModel):
    model_config = ConfigDict(extra='forbid')
    keys: list[str] = Field(max_length=2000)
    inspect: bool


@router.put('/api/parts/{pid}/characteristics')
def select_characteristics(pid: str, a: BulkSelect, request: Request):
    """Choose which dimensions / notes are inspected (ballooned) in one go."""
    p = _part(pid)
    u = revision_access(request, p['revision_id'], True, 'qc.plan')
    known = {q['key'] for q in inspection.flat_list(load_chars(p), True)}
    if set(a.keys) - known:
        raise HTTPException(404, 'Characteristic not found on the current drawing')
    old = overrides(pid)
    with db.connect() as c:
        for key in a.keys:
            o = dict(old.get(key) or {})
            o['inspect'] = a.inspect
            if not a.inspect:
                o['critical'] = False
            c.execute('INSERT INTO char_overrides(part_id,key,data,actor,updated) VALUES(?,?,?,?,?) ON CONFLICT(part_id,key) DO UPDATE SET data=excluded.data,actor=excluded.actor,updated=excluded.updated',
                      (pid, key, json.dumps(o), u['name'], db.now()))
        db.audit(c, u['name'], 'inspection.plan.updated', {'part': p['name'], 'inspect': a.inspect, 'count': len(a.keys)}, p['revision_id'])
    return {'ok': True}


class BalloonEdit(BaseModel):
    model_config = ConfigDict(extra='forbid')
    dx: float = Field(default=0, ge=-1200, le=1200)
    dy: float = Field(default=0, ge=-1200, le=1200)


@router.put('/api/parts/{pid}/balloons/{line}')
def edit_balloon(pid: str, line: str, a: BalloonEdit, request: Request):
    p = _part(pid)
    u = revision_access(request, p['revision_id'], True, 'qc.plan')
    if not any(c.get('id') == line for c in load_chars(p)):
        raise HTTPException(404, 'Balloon not found')
    _store(pid, f'balloon:{line}', a.model_dump(), u, p, None)
    return {'ok': True}


def _store(pid, key, data, u, p, audit):
    with db.connect() as c:
        c.execute('INSERT INTO char_overrides(part_id,key,data,actor,updated) VALUES(?,?,?,?,?) ON CONFLICT(part_id,key) DO UPDATE SET data=excluded.data,actor=excluded.actor,updated=excluded.updated',
                  (pid, key, json.dumps(data), u['name'], db.now()))
        if audit:
            db.audit(c, u['name'], 'inspection.plan.updated', {'part': p['name'], **audit}, p['revision_id'])


# ------------------------------------------------------------------------------------------- documents
def _drawing(p):
    from .main import drawing_state
    from .drawings import attach_view_lines
    folder, scene, edits, _ = drawing_state(p)
    return folder, scene, attach_view_lines(p, folder, scene, edits)


def inspection_pdf(p, rev, settings, target):
    """The vendor drawing with numbered balloons (hexagons for critical characteristics) followed by the
    characteristic list."""
    from .drawing_scene import render_scene
    from reportlab.pdfgen import canvas
    folder, scene, edits = _drawing(p)
    chars = load_chars(p)
    c = canvas.Canvas(target, pagesize=(scene['pages'][0]['width'], scene['pages'][0]['height']))
    c.setTitle(p['name'] + ' - inspection drawing')
    render_scene(scene, edits, c=c, balloons=chars)
    inspection.characteristic_sheets(c, p, rev, chars, settings, (420 * mm, 297 * mm))
    c.save()


@router.get('/api/parts/{pid}/inspection.pdf')
def inspection_drawing(pid: str, request: Request):
    p = _part(pid)
    revision_access(request, p['revision_id'])
    rev = _rev(p['revision_id'])
    buf = io.BytesIO()
    inspection_pdf(p, rev, db.project_settings(rev['project_id']), buf)
    name = re.sub(r'[^\w.-]+', '_', p['name'])[:60]
    return Response(buf.getvalue(), media_type='application/pdf', headers={'Content-Disposition': f'inline; filename="{name}_inspection.pdf"'})


def _safe(v):
    return "'" + v if isinstance(v, str) and v.startswith(('=', '+', '-', '@', '\t', '\r')) else v


def characteristics_csv_text(p):
    """The inspection plan of one part as CSV text ('' when the drawing has no characteristics yet)."""
    chars = load_chars(p, required=False)
    if not chars:
        return ''
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(['no', 'zone', 'sheet', 'characteristic', 'drawing text', 'nominal', 'lower', 'upper', 'unit', 'quantity', 'critical', 'tolerance basis', 'method', 'note'])
    for q in inspection.flat_list(chars):
        w.writerow([_safe(x) for x in [q['no'], q['zone'], q['page'] + 1, q['label'], q['text'], q['nominal'], q['lower'], q['upper'], q['unit'], q.get('qty', 1),
                                       'KC' if q.get('critical') else '', q.get('basis', ''), q.get('method', ''), q.get('note', '')]])
    return out.getvalue()


@router.get('/api/parts/{pid}/characteristics.csv')
def characteristics_csv(pid: str, request: Request):
    p = _part(pid)
    revision_access(request, p['revision_id'])
    return Response(characteristics_csv_text(p), media_type='text/csv', headers={'Content-Disposition': f'attachment; filename="characteristics-{pid}.csv"'})


# ------------------------------------------------------------------------------------------- recording
class Entry(BaseModel):
    model_config = ConfigDict(extra='forbid')
    key: str = Field(min_length=1, max_length=40)
    value: float | None = None
    attr: str | None = Field(default=None, max_length=10)
    instrument: str = Field(default='', max_length=80)
    note: str = Field(default='', max_length=300)


class Record(BaseModel):
    model_config = ConfigDict(extra='forbid')
    part_id: str
    serial: str = Field(min_length=1, max_length=60)
    first_article: bool = False
    instrument: str = Field(default='', max_length=80)
    entries: list[Entry] = Field(min_length=1, max_length=500)


@router.post('/api/revisions/{rid}/measurements')
def record(rid: str, a: Record, request: Request):
    u = revision_access(request, rid, True, 'qc.record')
    r = _rev(rid)
    if r['status'] not in ('ready', 'released'):
        raise HTTPException(409, 'Inspection opens once the revision has finished processing')
    p = _part(a.part_id)
    if p['revision_id'] != rid:
        raise HTTPException(422, 'Part outside revision')
    if p.get('excluded'):
        raise HTTPException(409, 'Part is marked not for production')
    serial = a.serial.strip()
    flat = {q['key']: q for q in inspection.flat_list(load_chars(p))}
    out = []
    with db.connect() as c:
        fa = a.first_article or bool(c.execute('SELECT 1 FROM measurements WHERE part_id=? AND serial=? AND first_article=1', (p['id'], serial)).fetchone())
        for e in a.entries:
            q = flat.get(e.key)
            if q is None:
                raise HTTPException(422, 'That dimension is not selected for inspection; reload the inspection plan')
            if q['nominal'] is None:
                if (e.attr or '').upper() not in ('PASS', 'FAIL'):
                    raise HTTPException(422, f"Characteristic {q['no']}: record PASS or FAIL")
                value, attr = None, e.attr.upper()
            else:
                if e.value is None or not math.isfinite(e.value):
                    raise HTTPException(422, f"Characteristic {q['no']}: enter the measured value")
                value, attr = float(e.value), ''
            result = inspection.evaluate(q, value, attr)
            mid = db.uid()
            c.execute('INSERT INTO measurements(id,revision_id,part_id,serial,char_key,char_no,label,nominal,lower_limit,upper_limit,unit,critical,value,attr,result,instrument,note,actor,created,first_article) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                      (mid, rid, p['id'], serial, q['key'], q['no'], q['label'], q['nominal'], q['lower'], q['upper'], q['unit'], int(bool(q.get('critical'))),
                       value, attr, result, e.instrument or a.instrument, e.note, u['name'], db.now(), int(fa)))
            out.append({'id': mid, 'no': q['no'], 'result': result})
        db.audit(c, u['name'], 'inspection.recorded', {'part': p['name'], 'serial': serial, 'first_article': fa, 'count': len(out),
                                                       'nonconforming': sum(o['result'] != 'PASS' for o in out)}, rid)
    return {'results': out, 'nonconforming': sum(o['result'] != 'PASS' for o in out)}


def _records(pid, serial=None):
    """Latest measurement per (serial, characteristic): a re-measurement replaces the reading in reports,
    the earlier one stays in the history."""
    rows = db.rows('SELECT * FROM measurements WHERE part_id=?' + (' AND serial=?' if serial else '') + ' ORDER BY created',
                   (pid, serial) if serial else (pid,))
    latest = {}
    for m in rows:
        latest[(m['serial'], m['char_key'])] = m
    return list(latest.values()), rows


@router.get('/api/parts/{pid}/measurements')
def part_measurements(pid: str, request: Request):
    p = _part(pid)
    revision_access(request, p['revision_id'])
    latest, history = _records(pid)
    chars = load_chars(p, required=False)
    return {'summary': _summary(p, chars, latest), 'latest': latest, 'history': history[-500:]}


@router.get('/api/revisions/{rid}/inspection')
def revision_inspection(rid: str, request: Request):
    """Per-part inspection status for the Quality page."""
    revision_access(request, rid)
    _rev(rid)
    out = []
    for p in db.rows("SELECT * FROM parts WHERE revision_id=? AND category!='purchased' AND COALESCE(excluded,0)=0 ORDER BY name", (rid,)):
        p['geometry'] = json.loads(p['geometry'])
        p['spec'] = json.loads(p['spec'])
        latest, _ = _records(p['id'])
        out.append(_summary(p, load_chars(p, required=False), latest))
    return out


class Disposition(BaseModel):
    model_config = ConfigDict(extra='forbid')
    disposition: str = Field(pattern='^(use as is|rework|repair|scrap|return to vendor)$')
    note: str = Field(min_length=5, max_length=500)


@router.post('/api/measurements/{mid}/disposition')
def disposition(mid: str, a: Disposition, request: Request):
    m = db.row('SELECT * FROM measurements WHERE id=?', (mid,))
    if not m:
        raise HTTPException(404, 'Measurement not found')
    u = revision_access(request, m['revision_id'], True, 'qc.plan')
    if m['result'] == 'PASS':
        raise HTTPException(409, 'Only nonconforming results need a disposition')
    with db.connect() as c:
        c.execute('UPDATE measurements SET disposition=?,disposition_note=?,disposition_by=?,disposition_at=? WHERE id=?', (a.disposition, a.note.strip(), u['name'], db.now(), mid))
        db.audit(c, u['name'], 'inspection.disposition', {'serial': m['serial'], 'characteristic': m['char_no'], 'disposition': a.disposition, 'note': a.note}, m['revision_id'])
    return {'ok': True}


@router.get('/api/parts/{pid}/report.pdf')
def report(pid: str, serial: str, request: Request):
    p = _part(pid)
    revision_access(request, p['revision_id'])
    rev = _rev(p['revision_id'])
    latest, _ = _records(pid, serial)
    if not latest:
        raise HTTPException(404, 'No measurements for this serial')
    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(420 * mm, 297 * mm))
    fa = any(m['first_article'] for m in latest)
    c.setTitle(f"{p['name']} - {'first article' if fa else 'inspection'} report {serial}")
    inspection.fai_report(c, p, rev, load_chars(p), latest, serial, (420 * mm, 297 * mm), first_article=fa)
    c.save()
    name = re.sub(r'[^\w.-]+', '_', f"{p['name']}_{serial}")[:80]
    return Response(buf.getvalue(), media_type='application/pdf', headers={'Content-Disposition': f'inline; filename="{name}_report.pdf"'})


@router.get('/api/revisions/{rid}/measurements.csv')
def measurements_csv(rid: str, request: Request):
    revision_access(request, rid)
    rows = db.rows('SELECT m.*,p.name AS part_name FROM measurements m JOIN parts p ON p.id=m.part_id WHERE m.revision_id=? ORDER BY m.created', (rid,))
    out = io.StringIO()
    cols = ['part_name', 'serial', 'first_article', 'char_no', 'label', 'nominal', 'lower_limit', 'upper_limit', 'unit', 'critical', 'value', 'attr', 'result',
            'instrument', 'actor', 'created', 'note', 'disposition', 'disposition_note', 'disposition_by']
    w = csv.DictWriter(out, fieldnames=cols, extrasaction='ignore')
    w.writeheader()
    for r in rows:
        w.writerow({k: _safe(v) for k, v in r.items()})
    return Response(out.getvalue(), media_type='text/csv', headers={'Content-Disposition': f'attachment; filename="inspection-{rid}.csv"'})
