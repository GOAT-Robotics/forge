"""Forge package (.forge) import — docs/FORGE_PACKAGE.md.

A package is a ZIP of ``model.step`` plus JSON written by a CAD-side exporter: tapped holes and cosmetic threads,
sheet-metal parameters, material and properties, the assembly tree with fasteners and press-in inserts. The STEP
goes through the normal import (sanitizing, analysis); this module then links the JSON to the geometry Forge found
and applies it — marked ``source: cad`` so the engineer can see where a specification came from and change it.

Nothing here infers anything from geometry: a tap is applied only because the designer's CAD feature says so, and
only to the bore whose axis, diameter and position the feature describes. Data that cannot be linked is listed in
the import summary, never guessed.
"""
from __future__ import annotations

import json
import math
import re
import shutil
import zipfile
from pathlib import Path

import numpy as np

from .hardware import BY_ID, CATALOG, TYPES as HW_TYPES, designation
from .scrub import clean_name

SCHEMA = 'forge-package/1'
EXT = '.forge'
MAX_JSON = 20 * 1024 * 1024
MAX_PARTS = 20000
MAX_HOLES = 5000
MAX_PREVIEW = 512 * 1024
MAX_LIST = 100000
ID_RE = re.compile(r'^[a-z0-9][a-z0-9._-]{0,79}$')
PART_MEMBER = re.compile(r'^parts/([a-z0-9][a-z0-9._-]{0,79})\.json$')
PREVIEW_MEMBER = re.compile(r'^previews/([a-z0-9][a-z0-9._-]{0,79})\.png$')
HOLE_KINDS = ('tap', 'clearance', 'counterbore', 'countersink', 'dowel', 'simple', 'cosmetic_thread', 'thread')
THREADED = ('tap', 'cosmetic_thread', 'thread')
INSERT_TYPES = ('nut', 'flush_nut', 'stud', 'standoff', 'rivnut', 'weld_nut')
FASTENER_KINDS = ('screw', 'bolt', 'nut', 'washer', 'rivet', 'pin', 'other')
COARSE = {2: .4, 2.5: .45, 3: .5, 3.5: .6, 4: .7, 5: .8, 6: 1, 7: 1, 8: 1.25, 10: 1.5, 12: 1.75, 14: 2, 16: 2, 18: 2.5, 20: 2.5, 24: 3}
FINISH_KEYS = ('finish', 'surface finish', 'surface_finish', 'coating', 'paint')


class PackageError(ValueError):
    """The archive is not a usable Forge package (the message is shown to the uploader)."""


# ------------------------------------------------------------------------------------------------ validation
def _fail(msg):
    raise PackageError(msg)


def _num(v, what, lo=None, hi=None, none=False):
    if v is None:
        if none:
            return None
        _fail(f'{what} is required')
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        _fail(f'{what} must be a finite number')
    if lo is not None and v < lo or hi is not None and v > hi:
        _fail(f'{what} must be between {lo} and {hi}')
    return float(v)


def _str(v, what, limit=200, none=False):
    if v is None or v == '':
        if none:
            return ''
        _fail(f'{what} is required')
    if not isinstance(v, str):
        _fail(f'{what} must be text')
    return v.strip()[:limit]


def _vec3(v, what, unit=False):
    if not isinstance(v, (list, tuple)) or len(v) != 3:
        _fail(f'{what} must be [x, y, z]')
    out = np.array([_num(x, what) for x in v], float)
    if unit:
        n = np.linalg.norm(out)
        if n < 1e-9:
            _fail(f'{what} must be a non-zero direction')
        out = out / n
    return out.tolist()


def _transform(v, what):
    if not isinstance(v, (list, tuple)) or len(v) != 16:
        _fail(f'{what} must be a 4x4 row-major matrix (16 numbers)')
    m = np.array([_num(x, what) for x in v], float).reshape(4, 4)
    if not np.allclose(m[3], [0, 0, 0, 1], atol=1e-6):
        _fail(f'{what} last row must be 0 0 0 1')
    return m.tolist()


def normalize_thread(t):
    """'M5x0.8' / 'M5 X 0.8' / 'M5' (coarse) -> ('M5×0.8', 5.0, 0.8); '#10-32' / '1/4-20' -> ('#10-32', None, None)."""
    s = re.sub(r'\s+', '', str(t or '')).replace('×', 'x').replace('X', 'x')
    m = re.match(r'^M(\d+(?:\.\d+)?)(?:x(\d+(?:\.\d+)?))?(?:-\w+)?$', s, re.I)
    if m:
        d = float(m.group(1))
        p = float(m.group(2)) if m.group(2) else COARSE.get(d)
        if not p:
            return f'M{d:g}', d, None
        return f'M{d:g}×{p:g}', d, p
    m = re.match(r'^(#\d+|\d+/\d+|\d+(?:\.\d+)?)-(\d+)(?:(?:UN[CF]|UN)?(?:-\w+)?)?$', s, re.I)
    if m:
        return f'{m.group(1)}-{m.group(2)}', None, None
    return (s[:30], None, None) if s else (None, None, None)


def validate_hole(h, i):
    if not isinstance(h, dict):
        _fail(f'holes[{i}] must be an object')
    kind = h.get('kind')
    if kind not in HOLE_KINDS:
        _fail(f'holes[{i}].kind must be one of {", ".join(HOLE_KINDS)}')
    out = {'id': _str(h.get('id') or f'h{i + 1}', f'holes[{i}].id', 80), 'feature': _str(h.get('feature'), f'holes[{i}].feature', 200, none=True), 'kind': kind,
           'standard': _str(h.get('standard'), f'holes[{i}].standard', 40, none=True), 'fastener': _str(h.get('fastener'), f'holes[{i}].fastener', 40, none=True),
           'thread_class': _str(h.get('thread_class'), f'holes[{i}].thread_class', 10, none=True),
           'thread_depth': _num(h.get('thread_depth'), f'holes[{i}].thread_depth', 0, 10000, none=True), 'thread_through': bool(h.get('thread_through', False)),
           'diameter': _num(h.get('diameter'), f'holes[{i}].diameter', 1e-3, 5000), 'depth': _num(h.get('depth'), f'holes[{i}].depth', 0, 100000, none=True),
           'through': bool(h.get('through', False)), 'point': _vec3(h.get('point'), f'holes[{i}].point'), 'direction': _vec3(h.get('direction'), f'holes[{i}].direction', unit=True),
           'face': _str(h.get('face'), f'holes[{i}].face', 80, none=True), 'counterbore': None, 'countersink': None}
    th, _, _ = normalize_thread(h.get('thread'))
    out['thread'] = th or ''
    if kind in THREADED and not out['thread']:
        _fail(f'holes[{i}] ({out["feature"] or out["id"]}): a threaded hole needs its thread designation')
    cb = h.get('counterbore')
    if cb:
        out['counterbore'] = {'diameter': _num(cb.get('diameter'), f'holes[{i}].counterbore.diameter', 1e-3, 5000), 'depth': _num(cb.get('depth'), f'holes[{i}].counterbore.depth', 0, 10000)}
    cs = h.get('countersink')
    if cs:
        out['countersink'] = {'diameter': _num(cs.get('diameter'), f'holes[{i}].countersink.diameter', 1e-3, 5000), 'angle': _num(cs.get('angle'), f'holes[{i}].countersink.angle', 1, 179)}
    return out


def validate_sheet(s):
    if s is None:
        return None
    if not isinstance(s, dict):
        _fail('sheet_metal must be an object')
    out = {'thickness': _num(s.get('thickness'), 'sheet_metal.thickness', 1e-3, 500, none=True), 'bend_radius': _num(s.get('bend_radius'), 'sheet_metal.bend_radius', 0, 5000, none=True),
           'k_factor': _num(s.get('k_factor'), 'sheet_metal.k_factor', 0, 1, none=True), 'bend_allowance': _num(s.get('bend_allowance'), 'sheet_metal.bend_allowance', none=True),
           'bend_deduction': _num(s.get('bend_deduction'), 'sheet_metal.bend_deduction', none=True), 'flat_pattern': bool(s.get('flat_pattern', True)), 'flat_size': None, 'bends': []}
    fs = s.get('flat_size')
    if fs:
        if not isinstance(fs, (list, tuple)) or len(fs) != 2:
            _fail('sheet_metal.flat_size must be [width, height]')
        out['flat_size'] = [_num(x, 'sheet_metal.flat_size', 0, 100000) for x in fs]
    for i, b in enumerate(s.get('bends') or []):
        if i >= 2000:
            break
        if not isinstance(b, dict):
            _fail(f'sheet_metal.bends[{i}] must be an object')
        out['bends'].append({'feature': _str(b.get('feature'), 'bend feature', 120, none=True), 'angle': _num(b.get('angle'), 'bend angle', -360, 360, none=True),
                             'radius': _num(b.get('radius'), 'bend radius', 0, 5000, none=True), 'direction': b.get('direction') if b.get('direction') in ('up', 'down') else None,
                             'k_factor': _num(b.get('k_factor'), 'bend k_factor', 0, 1, none=True)})
    return out


def validate_part(d, member=''):
    if not isinstance(d, dict):
        _fail(f'{member}: part must be a JSON object')
    pid = _str(d.get('id'), f'{member}: id', 80)
    if not ID_RE.match(pid):
        _fail(f'{member}: id "{pid}" must match [a-z0-9][a-z0-9._-]*')
    out = {'id': pid, 'name': _str(d.get('name'), f'{member}: name', 200), 'file': Path(_str(d.get('file'), 'file', 255, none=True)).name,
           'configuration': _str(d.get('configuration'), 'configuration', 120, none=True), 'part_number': _str(d.get('part_number'), 'part_number', 80, none=True),
           'description': _str(d.get('description'), 'description', 400, none=True), 'revision': _str(d.get('revision'), 'revision', 40, none=True),
           'material': _str(d.get('material'), 'material', 120, none=True), 'density': _num(d.get('density'), 'density', 0, 30, none=True),
           'mass_kg': _num(d.get('mass_kg'), 'mass_kg', 0, 1e6, none=True), 'volume_mm3': _num(d.get('volume_mm3'), 'volume_mm3', 0, 1e12, none=True),
           'bodies': int(_num(d.get('bodies'), 'bodies', 0, 10000, none=True) or 0), 'step_names': [], 'properties': {}, 'bbox': None, 'sheet_metal': None, 'holes': [], 'welds': [],
           'color': d['color'].upper() if isinstance(d.get('color'), str) and re.fullmatch(r'#[0-9a-fA-F]{6}', d['color']) else ''}
    for n in (d.get('step_names') or [])[:8]:
        if isinstance(n, str) and n.strip():
            out['step_names'].append(n.strip()[:255])
    props = d.get('properties') or {}
    if not isinstance(props, dict):
        _fail(f'{member}: properties must be an object')
    for k, v in list(props.items())[:60]:
        if isinstance(k, str) and k.strip() and (v is None or isinstance(v, (str, int, float, bool))):
            out['properties'][k.strip()[:60]] = ('' if v is None else str(v))[:200]
    if d.get('bbox') is not None:
        out['bbox'] = [abs(x) for x in _vec3(d['bbox'], 'bbox')]
    out['sheet_metal'] = validate_sheet(d.get('sheet_metal'))
    holes = d.get('holes') or []
    if not isinstance(holes, list) or len(holes) > MAX_HOLES:
        _fail(f'{member}: holes must be a list of at most {MAX_HOLES}')
    seen = set()
    for i, h in enumerate(holes):
        vh = validate_hole(h, i)
        if vh['id'] in seen:
            _fail(f'{member}: duplicate hole id {vh["id"]}')
        seen.add(vh['id'])
        out['holes'].append(vh)
    for w in (d.get('welds') or [])[:2000]:
        if isinstance(w, dict):
            out['welds'].append({'feature': _str(w.get('feature'), 'weld feature', 120, none=True), 'type': _str(w.get('type'), 'weld type', 40, none=True),
                                 'size': _num(w.get('size'), 'weld size', 0, 1000, none=True), 'length': _num(w.get('length'), 'weld length', 0, 1e6, none=True)})
    # threads whose face the writer could not trace (cosmetic threads on mirrored / derived bodies): size, depth
    # and count are the designer's; the import places them on the bores of the tap-drill size when unambiguous
    out['unplaced_threads'] = []
    for i, t in enumerate((d.get('unplaced_threads') or [])[:MAX_HOLES]):
        if not isinstance(t, dict):
            _fail(f'{member}: unplaced_threads[{i}] must be an object')
        th, _, _ = normalize_thread(t.get('thread'))
        if not th:
            _fail(f'{member}: unplaced_threads[{i}] needs its thread designation')
        out['unplaced_threads'].append({'feature': _str(t.get('feature'), f'unplaced_threads[{i}].feature', 200, none=True), 'thread': th,
                                        'diameter': _num(t.get('diameter'), f'unplaced_threads[{i}].diameter', 1e-3, 5000, none=True),
                                        'thread_depth': _num(t.get('thread_depth'), f'unplaced_threads[{i}].thread_depth', 0, 10000, none=True), 'thread_through': bool(t.get('thread_through', False))})
    return out


def validate_manifest(d):
    if not isinstance(d, dict):
        _fail('manifest.json must be a JSON object')
    if d.get('schema') != SCHEMA:
        _fail(f'Unsupported package schema {d.get("schema")!r}; this Forge reads {SCHEMA}')
    model = d.get('model') or {}
    if not isinstance(model, dict) or model.get('path') not in ('model.step', 'model.stp', 'model.brep'):
        _fail('manifest.model.path must be model.step')
    gen = d.get('generator') or {}
    src = d.get('source') or {}
    out = {'schema': SCHEMA, 'generator': {'name': _str(gen.get('name'), 'generator', 80, none=True) if isinstance(gen, dict) else '', 'version': _str(gen.get('version'), 'generator version', 40, none=True) if isinstance(gen, dict) else ''},
           'source': {'cad': _str(src.get('cad'), 'source.cad', 80, none=True), 'version': _str(src.get('version'), 'source.version', 80, none=True),
                      'file': Path(_str(src.get('file'), 'source.file', 255, none=True)).name, 'kind': src.get('kind') if src.get('kind') in ('part', 'assembly') else ''} if isinstance(src, dict) else {},
           'created': _str(d.get('created'), 'created', 40, none=True), 'units': 'mm',
           'model': {'path': model['path'], 'format': _str(model.get('format'), 'model.format', 40, none=True), 'sha256': _str(model.get('sha256'), 'model.sha256', 64, none=True).lower()},
           'root': _str(d.get('root'), 'root', 200, none=True)}
    if d.get('units') not in (None, 'mm'):
        _fail('Package units must be mm')
    if out['model']['sha256'] and not re.fullmatch(r'[0-9a-f]{64}', out['model']['sha256']):
        _fail('manifest.model.sha256 must be a hex SHA-256')
    return out


def validate_assembly(d):
    if d is None:
        return None
    if not isinstance(d, dict):
        _fail('assembly.json must be a JSON object')
    out = {'name': _str(d.get('name'), 'assembly name', 200, none=True), 'configuration': _str(d.get('configuration'), 'configuration', 120, none=True), 'components': [], 'fasteners': [], 'inserts': []}
    comps = d.get('components') or []
    if not isinstance(comps, list) or len(comps) > MAX_LIST:
        _fail('assembly.components must be a list')
    for i, c in enumerate(comps):
        if not isinstance(c, dict):
            _fail(f'components[{i}] must be an object')
        part = _str(c.get('part'), f'components[{i}].part', 80)
        if not ID_RE.match(part):
            _fail(f'components[{i}].part "{part}" is not a part id')
        out['components'].append({'id': _str(c.get('id') or f'c{i + 1}', 'component id', 80), 'part': part, 'name': _str(c.get('name'), 'component name', 200, none=True),
                                  'instance': _str(c.get('instance'), 'instance', 200, none=True), 'path': _str(c.get('path'), 'path', 2000, none=True),
                                  'configuration': _str(c.get('configuration'), 'configuration', 120, none=True), 'transform': _transform(c.get('transform'), f'components[{i}].transform'),
                                  'suppressed': bool(c.get('suppressed', False)), 'exclude_from_bom': bool(c.get('exclude_from_bom', False)), 'virtual': bool(c.get('virtual', False)),
                                  'fixed': bool(c.get('fixed', False)), 'mirrored': bool(c.get('mirrored', False))})
    fast = d.get('fasteners') or []
    if not isinstance(fast, list) or len(fast) > MAX_LIST:
        _fail('assembly.fasteners must be a list')
    for i, f in enumerate(fast):
        if not isinstance(f, dict):
            _fail(f'fasteners[{i}] must be an object')
        kind = f.get('kind') if f.get('kind') in FASTENER_KINDS else 'other'
        out['fasteners'].append({'id': _str(f.get('id') or f'f{i + 1}', 'fastener id', 80), 'kind': kind, 'standard': _str(f.get('standard'), 'standard', 60, none=True),
                                 'size': _str(f.get('size'), 'size', 40, none=True), 'length': _num(f.get('length'), 'fastener length', 0, 10000, none=True),
                                 'name': _str(f.get('name'), f'fasteners[{i}].name', 200), 'path': _str(f.get('path'), 'path', 2000, none=True),
                                 'transform': _transform(f['transform'], f'fasteners[{i}].transform') if f.get('transform') is not None else None})
    ins = d.get('inserts') or []
    if not isinstance(ins, list) or len(ins) > MAX_LIST:
        _fail('assembly.inserts must be a list')
    for i, s in enumerate(ins):
        if not isinstance(s, dict):
            _fail(f'inserts[{i}] must be an object')
        if s.get('type') not in INSERT_TYPES:
            _fail(f'inserts[{i}].type must be one of {", ".join(INSERT_TYPES)}')
        th, _, _ = normalize_thread(s.get('thread'))
        out['inserts'].append({'id': _str(s.get('id') or f'i{i + 1}', 'insert id', 80), 'type': s['type'], 'thread': th or '', 'pn': _str(s.get('pn'), 'pn', 60, none=True),
                               'name': _str(s.get('name'), 'insert name', 200, none=True), 'host': _str(s.get('host'), 'host', 80, none=True),
                               'path': _str(s.get('path'), 'path', 2000, none=True), 'transform': _transform(s.get('transform'), f'inserts[{i}].transform'),
                               'axis': _vec3(s['axis'], f'inserts[{i}].axis', unit=True) if s.get('axis') is not None else None})
    return out


# ------------------------------------------------------------------------------------------------ container
def _json_member(z, info):
    if info.file_size > MAX_JSON:
        _fail(f'{info.filename} is larger than {MAX_JSON // 1048576} MB')
    try:
        return json.loads(z.read(info).decode('utf-8'))
    except (UnicodeDecodeError, ValueError) as e:
        _fail(f'{info.filename} is not valid JSON ({str(e)[:80]})')


def unpack(archive, folder, limit):
    """Extract ``model.step`` to ``folder/source.step`` and the validated JSON to ``folder/package/``.
    Returns the package dict (manifest, parts by id, assembly, warnings)."""
    archive, folder = Path(archive), Path(folder)
    if not zipfile.is_zipfile(archive):
        _fail('Not a Forge package: the file is not a ZIP archive')
    pkg = {'manifest': None, 'parts': {}, 'assembly': None, 'warnings': [], 'previews': 0}
    out = folder / 'package'
    if out.exists():
        shutil.rmtree(out)
    (out / 'parts').mkdir(parents=True)
    with zipfile.ZipFile(archive) as z:
        infos = {}
        for info in z.infolist():
            n = info.filename
            if n.endswith('/') or n.startswith('/') or '..' in Path(n).parts or '\\' in n:
                continue
            infos[n] = info
        if 'manifest.json' not in infos:
            _fail('Not a Forge package: manifest.json is missing')
        man = validate_manifest(_json_member(z, infos['manifest.json']))
        model = infos.get(man['model']['path'])
        if model is None:
            _fail(f'Package has no {man["model"]["path"]}')
        if model.file_size > limit:
            _fail(f'model.step exceeds the configured upload limit ({limit // 1048576} MB)')
        if model.file_size < 30:
            _fail('model.step is empty')
        import hashlib
        h = hashlib.sha256()
        dest = folder / ('source.brep' if man['model']['path'].endswith('.brep') else 'source.step')
        pkg['source'] = str(dest)
        with z.open(model) as src, dest.open('wb') as dst:
            while chunk := src.read(1 << 20):
                h.update(chunk)
                dst.write(chunk)
        if man['model']['sha256'] and man['model']['sha256'] != h.hexdigest():
            pkg['warnings'].append('model.step does not match the checksum in manifest.json; the geometry was still imported')
        man['model']['sha256'] = h.hexdigest()
        pkg['manifest'] = man
        names = {}
        for n, info in infos.items():
            m = PART_MEMBER.match(n)
            if not m:
                continue
            if len(pkg['parts']) >= MAX_PARTS:
                _fail(f'Package has more than {MAX_PARTS} parts')
            part = validate_part(_json_member(z, info), n)
            if part['id'] != m.group(1):
                _fail(f'{n}: id "{part["id"]}" does not match the file name')
            if part['id'] in pkg['parts']:
                _fail(f'{n}: duplicate part id')
            pkg['parts'][part['id']] = part
            names[part['id']] = part['name']
        if 'assembly.json' in infos:
            pkg['assembly'] = validate_assembly(_json_member(z, infos['assembly.json']))
            for c in pkg['assembly']['components']:
                if c['part'] not in pkg['parts']:
                    pkg['warnings'].append(f'assembly.json: component {c["instance"] or c["id"]} refers to unknown part {c["part"]}')
        count = 0
        for n, info in infos.items():
            m = PREVIEW_MEMBER.match(n)
            if not m or m.group(1) not in pkg['parts'] or info.file_size > MAX_PREVIEW or count >= MAX_PARTS:
                continue
            (out / 'previews').mkdir(exist_ok=True)
            data = z.read(info)
            if data[:8] != b'\x89PNG\r\n\x1a\n':
                continue
            (out / 'previews' / f'{m.group(1)}.png').write_bytes(data)
            count += 1
        pkg['previews'] = count
    write_folder(folder, pkg)
    return pkg


def write_folder(folder, pkg):
    """Persist a validated package (manifest, parts, assembly) under folder/package/ for later loads and repacks."""
    out = Path(folder) / 'package'
    (out / 'parts').mkdir(parents=True, exist_ok=True)
    (out / 'manifest.json').write_text(json.dumps(pkg['manifest'], indent=1))
    for f in (out / 'parts').glob('*.json'):
        f.unlink()
    for pid, part in pkg['parts'].items():
        (out / 'parts' / f'{pid}.json').write_text(json.dumps(part))
    if pkg.get('assembly') is not None:
        (out / 'assembly.json').write_text(json.dumps(pkg['assembly']))
    pkg['warnings'] = list(pkg.get('warnings') or [])[:50]


def repack(folder, dest=None):
    """Rewrite the stored package from the sanitized STEP and the validated JSON, so the uploaded archive (with the
    authoring system's own STEP header and names) is replaced by a clean one. Returns the archive path."""
    folder = Path(folder)
    out = folder / 'package'
    dest = Path(dest) if dest else folder / 'source.forge'
    tmp = dest.with_name(dest.name + '.tmp')
    man = json.loads((out / 'manifest.json').read_text())
    geometry = folder / ('source.brep' if str(man.get('model', {}).get('path', '')).endswith('.brep') and (folder / 'source.brep').exists() else 'source.step')
    import hashlib
    h = hashlib.sha256()
    with geometry.open('rb') as fh:
        while chunk := fh.read(1 << 20):
            h.update(chunk)
    man['model'] = {'path': 'model' + geometry.suffix, 'format': man.get('model', {}).get('format') or geometry.suffix[1:], 'sha256': h.hexdigest()}
    man['sanitized'] = True
    (out / 'manifest.json').write_text(json.dumps(man, indent=1))
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as z:
        z.write(out / 'manifest.json', 'manifest.json')
        z.write(geometry, 'model' + geometry.suffix)
        if (out / 'assembly.json').exists():
            z.write(out / 'assembly.json', 'assembly.json')
        for f in sorted((out / 'parts').glob('*.json')):
            z.write(f, f'parts/{f.name}')
        if (out / 'previews').exists():
            for f in sorted((out / 'previews').glob('*.png')):
                z.write(f, f'previews/{f.name}')
    tmp.replace(dest)
    return dest


def load(folder):
    """The package stored with a revision (None when the revision was a plain CAD upload)."""
    out = Path(folder) / 'package'
    if not (out / 'manifest.json').exists():
        return None
    pkg = {'manifest': json.loads((out / 'manifest.json').read_text()), 'parts': {}, 'assembly': None, 'warnings': [], 'previews': 0}
    for f in sorted((out / 'parts').glob('*.json')):
        d = json.loads(f.read_text())
        pkg['parts'][d['id']] = d
    if (out / 'assembly.json').exists():
        pkg['assembly'] = json.loads((out / 'assembly.json').read_text())
    pkg['previews'] = len(list((out / 'previews').glob('*.png'))) if (out / 'previews').exists() else 0
    return pkg


# ------------------------------------------------------------------------------------------------ matching
def _norm(s):
    return re.sub(r'[\s_]+', ' ', clean_name(str(s or '')).strip().lower())


def _base_name(name):
    """Forge part name without the multi-body suffix."""
    return re.sub(r'\s*/\s*Body \d+$', '', name or '')


def match_parts(pkg, parts):
    """Forge part id -> package part. Name (cleaned, STEP product names, file stem) first, then bounding box
    + volume, then hole signature; the fallbacks only count when they are unique."""
    index = {}
    for pid, pp in pkg['parts'].items():
        for cand in [pp['name'], pp['id'], Path(pp['file']).stem if pp['file'] else '', *pp['step_names']]:
            n = _norm(cand)
            if n:
                index.setdefault(n, []).append(pid)
    out, used = {}, set()
    if len(pkg['parts']) == 1 and len({p['geometry'].get('source_component') for p in parts}) == 1:
        # one part document, one STEP component: every body belongs to it whatever the writer named the product
        pid = next(iter(pkg['parts']))
        return {p['id']: pkg['parts'][pid] for p in parts}
    for p in parts:
        n = _norm(_base_name(p['name']))
        ids = index.get(n) or []
        if len(ids) == 1:
            out[p['id']] = pkg['parts'][ids[0]]
            used.add(ids[0])
    rest = [pp for pid, pp in pkg['parts'].items() if pid not in used]
    for p in parts:
        if p['id'] in out or ' / Body ' in p['name']:
            continue
        g = p['geometry']
        dims = sorted(float(x) for x in g.get('dimensions', [0, 0, 0]))
        vol = float(g.get('volume') or 0)
        cands = []
        for pp in rest:
            if pp['bbox'] and pp['volume_mm3'] and len(pp['bbox']) == 3:
                bb = sorted(pp['bbox'])
                if all(abs(a - b) <= .005 * max(a, b) + .05 for a, b in zip(dims, bb)) and abs(vol - pp['volume_mm3']) <= .01 * max(vol, pp['volume_mm3'], 1e-9):
                    cands.append(pp)
        if len(cands) != 1:
            sig = tuple(sorted(round(h['diameter'], 2) for h in g.get('holes', [])))
            cands = [pp for pp in rest if sig and tuple(sorted(round(h['diameter'], 2) for h in pp['holes'])) == sig]
        if len(cands) == 1:
            out[p['id']] = cands[0]
            rest.remove(cands[0])
    return out


def _as_mat(t):
    return np.array(t, float).reshape(4, 4)


def _find_hole(holes, point, direction, diameter, tol_axis=.1, margin=1.0):
    """The geometric bore a package hole describes: same diameter, parallel axis, point on the axis line and
    within the bore's axial span. Returns the hole dict or None."""
    best, best_d = None, None
    p = np.asarray(point, float)
    d = np.asarray(direction, float)
    for h in holes:
        if abs(h['diameter'] - diameter) > max(.03, .005 * diameter):
            continue
        a = np.asarray(h['axis'], float)
        if abs(float(np.dot(a, d))) < .9995:
            continue
        o = np.asarray(h['origin'], float)
        v = p - o
        t = float(np.dot(v, a))
        off = float(np.linalg.norm(v - t * a))
        if off > tol_axis or t < h['start'] - margin or t > h['end'] + margin:
            continue
        if best is None or off < best_d:
            best, best_d = h, off
    return best


def _frames(fpart_instances, pkg_components):
    """Candidate package->Forge-local transforms: identity (parts in their own frames, the normal STEP export),
    then inverse(Forge placement) x package placement for writers that flatten the assembly."""
    yield np.eye(4)
    pairs = 0
    for inst in fpart_instances or []:
        try:
            inv = np.linalg.inv(np.array(inst['matrix'], float))
        except np.linalg.LinAlgError:
            continue
        for c in pkg_components:
            yield inv @ _as_mat(c['transform'])
            pairs += 1
            if pairs >= 64:
                return


def tap_item(hole):
    """Catalogue tap for the hole's thread, else a custom tap at the modelled (tap-drill) diameter."""
    thread, d, pitch = normalize_thread(hole['thread'])
    if d and pitch:
        item = BY_ID.get(f'tap-M{d:g}x{pitch:g}')
        if item:
            return dict(item)
    if thread and not d:
        item = BY_ID.get(f'tap-{thread}')
        if item:
            return dict(item)
    return {'id': 'custom', 'type': 'tap', 'units': 'metric' if d else 'imperial', 'thread': thread or 'thread', 'name': f'{thread} Tap', 'pn': '',
            'hole': round(float(hole['diameter']), 3), 'custom': True}


def insert_item(ins):
    """Catalogue hardware for a press-in insert by supplier part number, then by type + thread; else custom."""
    pn = (ins.get('pn') or '').strip().lower()
    if pn:
        for it in CATALOG:
            if it['type'] == ins['type'] and it.get('pn', '').lower() == pn:
                return dict(it)
    th = ins.get('thread') or ''
    cands = [it for it in CATALOG if it['type'] == ins['type'] and it.get('thread', '').lower() == th.lower()]
    if ins['type'] in ('stud', 'standoff'):
        cands = [c for c in cands if not c.get('length')] or cands[:1]
    if len(cands) == 1:
        return dict(cands[0])
    return {'id': 'custom', 'type': ins['type'], 'units': 'custom', 'thread': th[:30], 'name': (ins.get('name') or ins.get('pn') or f'{th} {HW_TYPES[ins["type"]]}')[:80],
            'pn': (ins.get('pn') or '')[:60], 'hole': None, 'custom': True}


def _place_threads(pp, fparts, taken):
    """Bores for the package part's unplaced threads. The designer's count per thread must equal the number of
    free bores of that thread's tap-drill size (then of its nominal size, for holes modelled at the major
    diameter); anything else is left for the engineer. Yields (thread, threads, [(part, bore)] or None)."""
    by_thread = {}
    for t in pp.get('unplaced_threads') or []:
        by_thread.setdefault(t['thread'], []).append(t)
    for thread, ts in by_thread.items():
        _, dmaj, pitch = normalize_thread(thread)
        targets = ([dmaj - pitch] if dmaj and pitch else []) + ([dmaj] if dmaj else [])
        hits = None
        for want in targets:
            cands = [(p, gh) for p in fparts for gh in p['geometry'].get('holes', [])
                     if (p['id'], gh['id']) not in taken and abs(float(gh['diameter']) - want) <= max(.15, .02 * want)]
            if len(cands) == len(ts):
                hits = sorted(cands, key=lambda c: tuple(round(float(x), 3) for x in c[1].get('center') or c[1].get('origin') or [0, 0, 0]))
                break
        yield thread, ts, hits


def _hardware(item, hole, side, extra):
    hw = {**item, 'side': side, 'axis': [round(float(x), 6) for x in hole.get('axis', [0, 0, 1])], 'source': 'cad'}
    hw.update(extra)
    return hw


def apply(pkg, parts, instances):
    """Link the package to the imported parts and apply it. ``parts`` are the worker's part dicts (geometry and
    spec are mutated in place); ``instances`` maps part id -> placements. Returns the summary stored in the
    revision manifest; callers persist the changed parts."""
    man = pkg['manifest']
    summary = {'schema': man['schema'], 'generator': man['generator'], 'source': man['source'], 'parts': len(pkg['parts']), 'matched_parts': 0, 'unmatched_parts': [],
               'holes': {'total': sum(len(pp['holes']) + len(pp.get('unplaced_threads') or []) for pp in pkg['parts'].values()), 'threaded': 0, 'applied': 0, 'kept': 0, 'unmatched': []},
               'inserts': {'total': 0, 'applied': 0, 'unmatched': []}, 'fasteners': {'total': 0, 'by_name': {}}, 'welds': sum(len(pp['welds']) for pp in pkg['parts'].values()),
               'k_factors': 0, 'materials': 0, 'warnings': list(pkg.get('warnings') or []), 'changed': [], 'native': man.get('native')}
    for p in parts:
        # fresh per-part containers: a spec built from DEFAULT_SPEC shares its nested dicts with every other part
        p['spec']['feature_specs'] = {k: dict(v) for k, v in (p['spec'].get('feature_specs') or {}).items()}
        p['geometry']['recognition_notes'] = list(p['geometry'].get('recognition_notes') or [])
    link = match_parts(pkg, parts)
    matched_pkg = {pp['id'] for pp in link.values()}
    summary['matched_parts'] = len(matched_pkg)
    summary['unmatched_parts'] = [pp['name'] for pid, pp in pkg['parts'].items() if pid not in matched_pkg][:50]
    comps = {}
    for c in ((pkg.get('assembly') or {}).get('components') or []):
        comps.setdefault(c['part'], []).append(c)
    changed = set()
    by_pkg = {}
    for p in parts:
        pp = link.get(p['id'])
        if pp:
            by_pkg.setdefault(pp['id'], []).append(p)
    # ---- per part: holes, sheet metal, material, properties
    for pp_id, fparts in by_pkg.items():
        pp = pkg['parts'][pp_id]
        threaded = [h for h in pp['holes'] if h['kind'] in THREADED]
        summary['holes']['threaded'] += len(threaded) + len(pp.get('unplaced_threads') or [])
        taken = set()
        for h in threaded:
            hit = None
            for p in fparts:
                g = p['geometry']
                for M in _frames(instances.get(p['id']), comps.get(pp_id, [])):
                    pt = (M @ np.r_[h['point'], 1.0])[:3]
                    dr = M[:3, :3] @ np.asarray(h['direction'], float)
                    gh = _find_hole([x for x in g.get('holes', []) if (p['id'], x['id']) not in taken], pt, dr, h['diameter'])
                    if gh:
                        hit = (p, gh)
                        break
                if hit:
                    break
            if not hit:
                summary['holes']['unmatched'].append({'part': pp['name'], 'feature': h['feature'] or h['id'], 'thread': h['thread'], 'diameter': h['diameter']})
                continue
            p, gh = hit
            taken.add((p['id'], gh['id']))
            fs = p['spec'].setdefault('feature_specs', {})
            cur = dict(fs.get(gh['id']) or {})
            if cur.get('hardware') and cur['hardware'].get('source') != 'cad':
                summary['holes']['kept'] += 1  # the engineer chose this hardware; CAD never overrides it
                continue
            item = tap_item(h)
            if h['thread_class']:
                item['thread_class'] = h['thread_class']
            extra = {'feature': h['feature'], 'kind': h['kind'], 'thread_through': bool(h['thread_through'] or h['through'])}
            if h['thread_depth'] and not extra['thread_through']:
                extra['thread_depth'] = round(h['thread_depth'], 3)
            cur['hardware'] = _hardware(item, gh, 1, extra)
            cur['designation'] = designation(cur['hardware'])
            fs[gh['id']] = cur
            summary['holes']['applied'] += 1
            changed.add(p['id'])
        placed_notes = {}
        for thread, ts, hits in _place_threads(pp, fparts, taken):
            if hits is None:
                for t in ts:
                    summary['holes']['unmatched'].append({'part': pp['name'], 'feature': t['feature'] or thread, 'thread': thread, 'diameter': t['diameter'], 'reason': 'face not in the CAD data; no unambiguous bore of the tap-drill size'})
                continue
            for t, (p, gh) in zip(ts, hits):
                taken.add((p['id'], gh['id']))
                fs = p['spec'].setdefault('feature_specs', {})
                cur = dict(fs.get(gh['id']) or {})
                if cur.get('hardware') and cur['hardware'].get('source') != 'cad':
                    summary['holes']['kept'] += 1
                    continue
                item = tap_item({'thread': thread, 'diameter': gh['diameter']})
                depth = t['thread_depth']
                through = bool(t['thread_through'] or (depth is not None and depth >= float(gh.get('depth') or 0) - .01))
                extra = {'feature': t['feature'], 'kind': 'cosmetic_thread', 'thread_through': through, 'placed_by': 'tap-drill size'}
                if depth and not through:
                    extra['thread_depth'] = round(depth, 3)
                cur['hardware'] = _hardware(item, gh, 1, extra)
                cur['designation'] = designation(cur['hardware'])
                fs[gh['id']] = cur
                summary['holes']['applied'] += 1
                changed.add(p['id'])
                placed_notes.setdefault(p['id'], []).append(f"{thread} on {gh['id']} (Ø{gh['diameter']:g})")
        for p in fparts:
            g, spec = p['geometry'], p['spec']
            notes = g.setdefault('recognition_notes', [])
            if placed_notes.get(p['id']):
                msg = f"{len(placed_notes[p['id']])} cosmetic thread{'s' if len(placed_notes[p['id']]) != 1 else ''} placed by tap-drill size — the CAD data names the thread but not its face: {', '.join(placed_notes[p['id']])}; confirm."
                notes.append(msg)
                summary['warnings'].append(f"{p['name']}: {msg}")
            n_tap = sum(1 for k, v in (spec.get('feature_specs') or {}).items() if (v.get('hardware') or {}).get('source') == 'cad' and v['hardware'].get('type') == 'tap')
            if n_tap:
                threads = sorted({v['hardware']['thread'] for v in spec['feature_specs'].values() if (v.get('hardware') or {}).get('source') == 'cad' and v['hardware'].get('type') == 'tap'})
                notes.append(f"{n_tap} tapped hole{'s' if n_tap != 1 else ''} from the CAD features ({', '.join(threads)}); confirm before release.")
            sm = pp['sheet_metal']
            if sm and g.get('category') == 'sheet_metal':
                if sm['k_factor'] is not None and .1 <= sm['k_factor'] <= .9 and not spec.get('k_factor_approved'):
                    if abs(float(spec.get('k_factor') or 0) - sm['k_factor']) > 1e-6:
                        spec['k_factor'] = round(sm['k_factor'], 4)
                        changed.add(p['id'])
                    summary['k_factors'] += 1
                    notes.append(f"K-factor {sm['k_factor']:g} from the CAD sheet-metal feature; approve it in the flat pattern.")
                elif sm['bend_allowance'] is not None or sm['bend_deduction'] is not None:
                    notes.append('CAD defines bends by allowance / deduction, not K-factor; set and approve the K-factor here.')
                if sm['thickness'] and g.get('thickness') and abs(sm['thickness'] - float(g['thickness'])) > .1:
                    notes.append(f"CAD sheet thickness {sm['thickness']:g} mm differs from the measured {float(g['thickness']):g} mm; check the model.")
                    summary['warnings'].append(f"{p['name']}: CAD thickness {sm['thickness']:g} mm vs measured {float(g['thickness']):g} mm")
                if sm['flat_pattern'] is False:
                    notes.append('The CAD system could not flatten this part.')
            if pp.get('color') and not (g.get('step') or {}).get('color'):
                g.setdefault('step', {})['color'] = pp['color']
            if pp['material'] and not spec.get('material'):
                spec['material'] = pp['material']
                summary['materials'] += 1
                notes.append('Material from the CAD part; confirm before release.')
                changed.add(p['id'])
            finish = next((v for k, v in pp['properties'].items() if k.strip().lower() in FINISH_KEYS and v), '')
            if finish and not spec.get('finish'):
                spec['finish'] = finish[:120]
                changed.add(p['id'])
            cad = {'package_part': pp['id'], 'part_number': pp['part_number'], 'description': pp['description'], 'revision': pp['revision'], 'configuration': pp['configuration'],
                   'file': pp['file'], 'mass_kg': pp['mass_kg'], 'properties': pp['properties'], 'holes': len(pp['holes']) + len(pp.get('unplaced_threads') or []), 'threaded': len(threaded) + len(pp.get('unplaced_threads') or []), 'welds': len(pp['welds']),
                   'preview': pp['id'] if pkg.get('previews') else ''}
            g['cad'] = cad
            changed.add(p['id'])  # notes and CAD facts are persisted for every linked part
    # ---- inserts: hardware on the hole whose axis passes through the insert
    asm = pkg.get('assembly') or {}
    inserts = asm.get('inserts') or []
    summary['inserts']['total'] = len(inserts)
    pkg_of = {p['id']: link[p['id']]['id'] for p in parts if p['id'] in link}
    for ins in inserts:
        T = _as_mat(ins['transform'])
        origin = T[:3, 3]
        axis = np.asarray(ins['axis'], float) if ins.get('axis') else T[:3, 2]
        best = None
        for p in parts:
            if ins.get('host') and pkg_of.get(p['id']) != ins['host']:
                continue
            g = p['geometry']
            for inst in instances.get(p['id']) or []:
                try:
                    inv = np.linalg.inv(np.array(inst['matrix'], float))
                except np.linalg.LinAlgError:
                    continue
                lp = (inv @ np.r_[origin, 1.0])[:3]
                la = inv[:3, :3] @ axis
                for h in g.get('holes', []):
                    a = np.asarray(h['axis'], float)
                    if abs(float(np.dot(a, la / max(np.linalg.norm(la), 1e-9)))) < .99:
                        continue
                    o = np.asarray(h['origin'], float)
                    v = lp - o
                    t = float(np.dot(v, a))
                    off = float(np.linalg.norm(v - t * a))
                    if off > .15 or t < h['start'] - 2 or t > h['end'] + 2:
                        continue
                    score = off + (0 if g.get('category') == 'sheet_metal' else 1)
                    if best is None or score < best[0]:
                        best = (score, p, h, 1 if float(np.dot(a, la)) >= 0 else -1)
        if not best:
            summary['inserts']['unmatched'].append({'name': ins.get('name') or ins.get('pn') or ins['type'], 'path': ins.get('path', '')})
            continue
        _, p, h, side = best
        fs = p['spec'].setdefault('feature_specs', {})
        cur = dict(fs.get(h['id']) or {})
        if cur.get('hardware') and cur['hardware'].get('source') != 'cad':
            summary['holes']['kept'] += 1
            continue
        item = insert_item(ins)
        cur['hardware'] = _hardware(item, h, side, {'feature': ins.get('name') or ins.get('pn') or '', 'kind': 'insert', 'component': ins.get('path', '')[:200]})
        cur['designation'] = designation(cur['hardware'])
        fs[h['id']] = cur
        summary['inserts']['applied'] += 1
        changed.add(p['id'])
        p['geometry'].setdefault('recognition_notes', []).append(f"{item['name']} placed in the CAD assembly at {h['id']}; confirm before release.")
    fast = asm.get('fasteners') or []
    summary['fasteners']['total'] = len(fast)
    by = {}
    for f in fast:
        by[f['name']] = by.get(f['name'], 0) + 1
    summary['fasteners']['by_name'] = dict(sorted(by.items(), key=lambda kv: -kv[1])[:40])
    summary['holes']['unmatched'] = summary['holes']['unmatched'][:50]
    summary['inserts']['unmatched'] = summary['inserts']['unmatched'][:50]
    summary['warnings'] = summary['warnings'][:50]
    summary['changed'] = sorted(changed)
    return summary
