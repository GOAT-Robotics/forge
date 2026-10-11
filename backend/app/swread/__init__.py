"""Forge's SolidWorks reader: exact geometry and part data from .sldprt files, no SolidWorks or third-party decoder.

    part = swread.read_part(path)            # active configuration
    part = swread.read_part(path, 'Flat')    # a named configuration
    part.solids                              # OpenCascade solids, millimetres, exactly as SolidWorks modelled them

Geometry: a SolidWorks part keeps each configuration's bodies as Parasolid transmit data (the "partition" stream
Contents/Config-<n>-Partition); bodies a part imported and never rebuilt live in Config-<n>-FeatureBodies. The
Parasolid data is decoded node by node (xt.py) and rebuilt as OpenCascade B-rep (brep.py): planes, cylinders,
cones, spheres, tori, B-spline surfaces and curves, trimmed and surface-parameter curves keep their exact form;
intersection curves are rebuilt on both surfaces.

Part data: feature names, types and configuration materials come from swXmlContents/KeyWords; custom properties
from docProps/*.xml; sheet-metal values from the cut-list properties; colour and density from the Parasolid body
attributes. Hole Wizard holes are found on the geometry: SolidWorks tags every face with the feature that created
it (FACE_ID_2001), so each hole's bore, countersink, counterbore and drill point come from the faces themselves
and its thread from the Hole Wizard feature.
"""
from __future__ import annotations

import html
import math
import re
import struct
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

from . import brep, container, xt

from .container import ContainerError
from .xt import XTError

PART_EXTS = ('.sldprt',)
BrepError = brep.BrepError


class ReadError(ValueError):
    """The file could not be read as a SolidWorks part (message is user-facing)."""


@dataclass
class Configuration:
    id: int
    name: str
    material: str = ''
    description: str = ''


@dataclass
class Part:
    configuration: Configuration
    configurations: list
    solids: list = field(default_factory=list)       # TopoDS_Solid, mm
    details: list = field(default_factory=list)      # per solid: check summary
    source: str = ''                                 # stream the bodies came from
    properties: dict = field(default_factory=dict)
    material: str = ''
    density: float | None = None                     # kg/m3, when a material is applied
    color: str = ''                                  # '#RRGGBB'
    holes: list = field(default_factory=list)
    threads: list = field(default_factory=list)      # cosmetic threads not tied to a Hole Wizard hole
    sheet_metal: dict | None = None
    features: dict = field(default_factory=dict)     # feature id -> {name, type, tag, dims}
    warnings: list = field(default_factory=list)
    version: str = ''


# ------------------------------------------------------------------------------------------------ XML part data
def _xml(streams, name):
    raw = streams.get(name)
    if not raw:
        return None
    i = raw.find(b'<')
    try:
        return ET.fromstring(raw[i:]) if i >= 0 else None
    except ET.ParseError:
        return None


def _local(tag):
    return tag.rsplit('}', 1)[-1]


def keywords(streams):
    """(features {id: {...}}, configurations [Configuration]) from swXmlContents/KeyWords."""
    root = _xml(streams, 'swXmlContents/KeyWords')
    feats, cfgs = {}, []
    if root is None:
        return feats, cfgs
    for el in root:
        tag = _local(el.tag)
        try:
            fid = int(el.get('id'))
        except (TypeError, ValueError):
            continue
        if tag == 'Configuration':
            mat = (el.get('Material') or '').strip()
            if re.search(r'not specified|<none>', mat, re.I):
                mat = ''
            cfgs.append(Configuration(fid, el.get('Name') or f'Config-{fid}', mat, el.get('Description') or ''))
            continue
        dims = {}
        for d in el:
            if _local(d.tag) == 'Dimension' and d.get('Name'):
                dims[d.get('Name')] = d.text or ''
        feats[fid] = {'id': fid, 'name': el.get('Name') or '', 'type': el.get('Type') or '', 'tag': tag, 'dims': dims}
    return feats, cfgs


def _active_config_id(streams):
    x = streams.get('swXmlContents/Features') or b''
    m = re.search(rb'<swModel id="2"[^>]*swConfigurationId="(-?\d+)"', x)
    return int(m.group(1)) if m else None


def _active_config_name(streams):
    root = _xml(streams, 'docProps/ISolidWorksInformation.xml')
    if root is None:
        return None
    for p in root.iter():
        if _local(p.tag) == 'property' and p.get('name') == 'SW-Configuration Name':
            return ''.join(p.itertext()).strip() or None
    return None


def _props_from(root):
    out = {}
    if root is None:
        return out
    for sec in root.iter():
        if _local(sec.tag) != 'propertySection' or sec.get('name') != 'UserDefinedProperties':
            continue
        for p in sec:
            if _local(p.tag) != 'property':
                continue
            name = (p.get('name') or '').strip()
            if not name or name.startswith('SW-'):
                continue
            # the value is the first vt:* child; FPVals repeats it (evaluated form)
            vt = next((c for c in p if _local(c.tag) != 'FPVals'), None)
            val = ''.join(vt.itertext()).strip() if vt is not None else ''
            out[name[:60]] = html.unescape(val)[:200]
    return out


def properties(streams, cfg_id):
    """Custom properties: file-level, then the configuration's own (which win)."""
    props = _props_from(_xml(streams, 'docProps/custom.xml'))
    props.update(_props_from(_xml(streams, f'docProps/Config-{cfg_id}-Properties.xml')))
    return dict(list(props.items())[:60])


def cutlist(streams, cfg_id):
    root = _xml(streams, f'docProps/Config-{cfg_id}-Cutlist-Properties.xml')
    out = []
    if root is None:
        return out
    for feat in root:
        vals = {}
        for p in feat:
            if _local(p.tag) == 'CustomProperty' and p.get('Name'):
                vals[p.get('Name')] = html.unescape((p.text or '').strip())
        out.append({'name': feat.get('Name') or '', 'type': feat.get('Type') or '', 'values': vals})
    return out


def _num(s):
    m = re.search(r'-?\d+(?:\.\d+)?', str(s or ''))
    return float(m.group(0)) if m else None


def sheet_metal(items):
    for it in items:
        v = it['values']
        t = _num(v.get('Sheet Metal Thickness'))
        if not t:
            continue
        L, W = _num(v.get('Bounding Box Length')), _num(v.get('Bounding Box Width'))
        k = _num(v.get('K-Factor'))
        return {'thickness': t, 'bend_radius': _num(v.get('Bend Radius')), 'k_factor': k if k and 0 < k < 1 else None,
                'bend_allowance': _num(v.get('Bend Allowance')), 'bend_deduction': _num(v.get('Bend Deduction')),
                'flat_pattern': True, 'flat_size': [L, W] if L and W else None, 'bends': []}
    return None


# ------------------------------------------------------------------------------------------------ attributes
def attributes(nodes):
    """{owner node index: {attribute name: [field values]}} from the Parasolid attributes."""
    defs = {}
    for x in nodes.values():
        if x.name == 'ATTRIB_DEF':
            ident = nodes.get(x.identifier)
            if ident is not None:
                defs[x.index] = bytes(ident.values).decode('latin-1')
    out = {}
    for x in nodes.values():
        if x.name != 'ATTRIBUTE' or x.definition not in defs:
            continue
        vals = []
        for f in x.fields:
            n = nodes.get(f)
            if n is None:
                continue
            v = n.values
            if n.name.startswith('CHAR_VALUES'):
                v = bytes(v).decode('latin-1')
            elif n.name == 'UNICODE_VALUES':
                v = ''.join(map(chr, v))
            vals.append(v)
        out.setdefault(x.owner, {})[defs[x.definition]] = vals
    return out


def _hex(rgb):
    try:
        return '#%02X%02X%02X' % tuple(int(round(max(0.0, min(1.0, float(c))) * 255)) for c in rgb[:3])
    except (TypeError, ValueError):
        return ''


# ------------------------------------------------------------------------------------------------ holes
PATTERN_TYPES = re.compile(r'mirror|pattern', re.I)


def hole_spec(feat):
    """Hole Wizard naming -> {kind, thread, fastener}. SolidWorks names Hole Wizard features after their spec:
    'M6 Tapped Hole1', 'M10 Clearance Hole2', 'CSK for M4 Hex Socket Countersunk Head1', 'CBORE for M8 ...'."""
    text = f"{feat.get('type') or ''} {feat.get('name') or ''}"
    size = re.search(r'(M\d+(?:\.\d+)?(?:\s?[xX×]\s?\d+(?:\.\d+)?)?|#\d+-\d+|\d+/\d+-\d+)', text)
    size = size.group(1).replace(' ', '').replace('×', 'x').replace('X', 'x') if size else ''
    if re.search(r'tap|thread', text, re.I):
        return {'kind': 'tap', 'thread': size, 'fastener': ''}
    if re.search(r'\bCSK\b|countersink', text, re.I):
        return {'kind': 'countersink', 'thread': '', 'fastener': size}
    if re.search(r'\bCBORE\b|counterbore', text, re.I):
        return {'kind': 'counterbore', 'thread': '', 'fastener': size}
    if re.search(r'clearance', text, re.I):
        return {'kind': 'clearance', 'thread': '', 'fastener': size}
    return {'kind': 'simple', 'thread': '', 'fastener': size}


def _unit(v):
    n = math.sqrt(sum(c * c for c in v)) or 1.0
    return [c / n for c in v]


def _canon_axis(p, d):
    d = _unit(d)
    for c in d:
        if abs(c) > 1e-9:
            if c < 0:
                d = [-x for x in d]
            break
    t = sum(p[k] * d[k] for k in range(3))
    q = [p[k] - t * d[k] for k in range(3)]
    return tuple(round(c * 1000, 2) for c in q) + tuple(round(c, 4) for c in d), q, d


def _face_samples(nodes, face, q, d):
    """(t along the axis, r from the axis) of a face's boundary: its vertices, and the centre / radius of circular
    edges (closed circular edges carry no vertex)."""
    out = []

    def add(p, r=None):
        t = sum((p[k] - q[k]) * d[k] for k in range(3))
        if r is None:
            r = math.sqrt(max(0.0, sum((p[k] - q[k] - t * d[k]) ** 2 for k in range(3))))
        out.append((t, r))

    lp = nodes.get(face.loop)
    while lp is not None:
        f0 = nodes.get(lp.fin)
        f, guard = f0, 0
        while f is not None and guard < 10000:
            v = nodes.get(f.vertex)
            if v is not None and v.point in nodes:
                add(nodes[v.point].pvec)
            e = nodes.get(f.edge)
            c = nodes.get(e.curve) if e is not None else None
            if c is not None and c.name == 'CIRCLE':
                add(c.centre, c.radius)
            f = nodes.get(f.forward)
            guard += 1
            if f is None or f.index == f0.index:
                break
        lp = nodes.get(lp.next)
    return out


def _signature(h):
    """What a mirrored / patterned instance shares with its seed: bore, depth and the shape of its entry."""
    cs, cb = h['countersink'] or {}, h['counterbore'] or {}
    return (h['diameter'], h['depth'], round(cs.get('diameter') or 0, 2), round(cb.get('diameter') or 0, 2))


def holes(nodes, attrs, feats, warnings, bodies=None):
    """Hole entries (Forge package form, mm) for faces created by Hole Wizard features — and by mirrors /
    patterns of them when the bore size identifies the seed unambiguously."""
    groups = {}
    owner_body = {x.index: x.body for x in nodes.values() if x.name == 'REGION'}
    shell_body = {}
    for x in nodes.values():
        if x.name == 'SHELL':
            shell_body[x.index] = owner_body.get(x.region, x.body)
    for face in nodes.values():
        if face.name != 'FACE':
            continue
        if bodies is not None and shell_body.get(face.shell) not in bodies:
            continue
        fid = attrs.get(face.index, {}).get('FACE_ID_2001')
        if not fid or not isinstance(fid[0], list) or len(fid[0]) < 2:
            continue
        feat = feats.get(fid[0][1])
        if feat is None or not (feat['tag'] == 'HoleWizard' or PATTERN_TYPES.search(feat['type'] or '')):
            continue
        surf = nodes.get(face.surface)
        if surf is None or surf.name not in ('CYLINDER', 'CONE'):
            continue
        key, q, d = _canon_axis(surf.pvec, surf.axis)
        inward = (face.sense == ord('+')) != (surf.sense == ord('+'))
        smp = _face_samples(nodes, face, q, d)
        ts, rs = [t for t, _ in smp], [r for _, r in smp]
        groups.setdefault((feat['id'], key), {'feat': feat, 'q': q, 'd': d, 'faces': []})['faces'].append(
            {'type': surf.name, 'surf': surf, 'inward': inward, 'ts': ts, 'rs': rs})
    seeds = {}
    out = []
    pending = []
    for (_fid, _key), g in groups.items():
        cyl = [f for f in g['faces'] if f['type'] == 'CYLINDER' and f['inward']]
        if not cyl:
            continue
        bore = min(cyl, key=lambda f: f['surf'].radius)
        dia = round(bore['surf'].radius * 2000, 4)
        lo = min(min(f['ts']) for f in g['faces'] if f['ts']) if any(f['ts'] for f in g['faces']) else 0.0
        hi = max(max(f['ts']) for f in g['faces'] if f['ts']) if any(f['ts'] for f in g['faces']) else 0.0
        cones = [f for f in g['faces'] if f['type'] == 'CONE' and f['ts']]
        tip = next((f for f in cones if min(f['rs']) < bore['surf'].radius * 0.5), None)   # drill point
        sink = next((f for f in cones if max(f['rs']) > bore['surf'].radius * 1.05), None)  # countersink
        wider = [f for f in cyl if f['surf'].radius > bore['surf'].radius * 1.05 and f['ts']]
        if tip is not None:
            entry_hi = (sum(tip['ts']) / len(tip['ts'])) < (lo + hi) / 2
        elif sink is not None:
            entry_hi = (sum(sink['ts']) / len(sink['ts'])) > (lo + hi) / 2
        elif wider:
            entry_hi = (sum(wider[0]['ts']) / len(wider[0]['ts'])) > (lo + hi) / 2
        else:
            entry_hi = True
        d = g['d'] if entry_hi else [-c for c in g['d']]
        t0 = hi if entry_hi else lo
        point = [round((g['q'][k] + t0 * g['d'][k]) * 1000, 4) for k in range(3)]
        bore_ts = bore['ts'] or [0.0]
        h = {'feature': g['feat']['name'][:200], 'diameter': dia, 'point': point, 'direction': [round(-c, 6) + 0.0 for c in d],
             'through': tip is None, 'depth': None if tip is None else round((max(bore_ts) - min(bore_ts)) * 1000, 4),
             'counterbore': None, 'countersink': None}
        if sink is not None:
            s = sink['surf']
            h['countersink'] = {'diameter': round(max(sink['rs']) * 2000, 4), 'angle': round(math.degrees(2 * math.atan2(s.sin_half_angle, s.cos_half_angle)), 3)}
        if wider:
            w = max(wider, key=lambda f: f['surf'].radius)
            h['counterbore'] = {'diameter': round(w['surf'].radius * 2000, 4), 'depth': round((max(w['ts']) - min(w['ts'])) * 1000, 4)}
        if g['feat']['tag'] == 'HoleWizard':
            spec = hole_spec(g['feat'])
            seeds.setdefault(_signature(h), set()).add((spec['kind'], spec['thread'], spec['fastener']))
            out.append({**h, **spec})
        else:
            pending.append(h)
    for h in pending:
        cand = seeds.get(_signature(h)) or set()
        if len(cand) == 1:
            kind, thread, fastener = next(iter(cand))
            out.append({**h, 'kind': kind, 'thread': thread, 'fastener': fastener})
        elif cand:
            warnings.append(f"{h['feature']}: Ø{h['diameter']:g} bore matches several Hole Wizard specs; set it in Forge")
    return out


def cosmetic_threads(feats, hole_list):
    """Cosmetic threads ('Hole Thread' / 'Cosmetic Thread' features) whose size no tapped Hole Wizard hole
    already carries; Forge places them on bores of the tap-drill size."""
    tapped = {_num(h['thread']) for h in hole_list if h['kind'] == 'tap' and h['thread']}
    out, seen = [], set()
    for f in feats.values():
        if not re.search(r'cosmetic thread|hole thread', f['type'] or f['name'], re.I):
            continue
        dia = None
        for v in f['dims'].values():
            if '<MOD-DIAM>' in v or 'Ø' in v:
                dia = _num(v.replace('<MOD-DIAM>', ''))
                break
        if not dia or dia in tapped or dia in seen:
            continue
        seen.add(dia)
        out.append({'feature': f['name'][:200], 'diameter': round(dia, 4)})
    return out


# ------------------------------------------------------------------------------------------------ part
def _body_streams(streams, cfg_id):
    """(label, [Parasolid stream]) candidates for a configuration, best first."""
    out = []
    for key in (f'Contents/Config-{cfg_id}-Partition', f'Config-{cfg_id}-Partition'):
        if key in streams:
            parts = [s for s in container.parasolid_streams(streams[key]) if container.kind(s) == 'partition']
            if parts:
                out.append((key, parts[:1]))
    for key in sorted(k for k in streams if re.match(rf'(Contents/)?Config-{cfg_id}-FeatureBodies/', k)):
        ss = [s for s in container.parasolid_streams(streams[key]) if container.kind(s) != 'deltas']
        if ss:
            out.append((key, ss))
    return out


BODY_NAME = re.compile(rb'\x01\x00\x00\x00\x06\x00\x00\x00[\x00\x01]\x00\x00\x00[\x00\x01]\x00\x00\x00\x00\x00\x00\x00\xff\xfe\xff', re.S)


BODY_ID = re.compile(rb'\x01\x00\x00\x00(.{4})\x00\x00\x00\x00\x01\x00\x00\x00\xff\xff\xff\xff', re.S)


def displayed_bodies(streams):
    """What the display list shows: {'atoms': {body atom id}, 'names': {body name}}, or None. Each displayed body
    has a uoBodyPropInfo record — its atom id (the body's ATOM_ID_2001 attribute) before it, its name in it.
    The atom id is what identifies it: a name can be stale (a body a later feature cut keeps its old name here)."""
    dl = streams.get('Contents/DisplayLists') or b''
    atoms, names = set(), set()
    prev = 0
    for m in BODY_NAME.finditer(dl):
        j = m.end()
        n = dl[j]
        try:
            names.add(dl[j + 1:j + 1 + 2 * n].decode('utf-16-le'))
        except UnicodeDecodeError:
            pass
        # the id sits just before the record, or before an appearance block (material, colour) when the body
        # has one: the last id since the previous record
        ids = list(BODY_ID.finditer(dl, max(prev, m.start() - 4096), m.start()))
        if ids:
            atoms.add(struct.unpack('<i', ids[-1].group(1))[0])
        prev = m.end()
    return {'atoms': atoms, 'names': names} if names else None


def _active_num(owner, aid):
    return next((n for n, c in owner.items() if c.id == aid), next(iter(owner), None))


def _records(streams, num, sheets):
    """Body records (brep.build_bodies) of every stream of Config-<num>, each with its source, nodes and display
    name ('<body name>' or '<body name>[k]' when several share it, k by atom id). Bodies a later stream repeats
    (same atom id) are taken from the partition."""
    recs, errs, seen = [], [], set()
    for label, ss in _body_streams(streams, num):
        for s_ in ss:
            try:
                nodes = xt.Reader(s_).nodes()
            except XTError as e:
                errs.append(f'{label}: {e}')
                continue
            attrs = attributes(nodes)
            try:
                built = brep.build_bodies(nodes, sheets=sheets)
            except Exception as e:
                errs.append(f'{label}: {type(e).__name__} {e}'.strip())
                continue
            for r in built:
                a = attrs.get(r['body'].index, {})
                nm = a.get('SWIMPLICITBODYNAME_ID_U') or a.get('SW_INTERNAL_BODY_NAME') or ['']
                atom = a.get('ATOM_ID_2001')
                atom = atom[0][0] if atom and isinstance(atom[0], list) and atom[0] else None
                # one atom id is one body: a later stream repeating it (named or not) holds an earlier state
                if atom is not None and atom in seen:
                    continue
                seen.add(atom)
                r.update(source=label, nodes=nodes, base=nm[0], atom=atom)
                recs.append(r)
    groups = {}
    for r in recs:
        groups.setdefault(r['base'], []).append(r)
    for base, rs in groups.items():
        rs.sort(key=lambda r: (r['atom'] is None, r['atom'] or 0))
        for k, r in enumerate(rs, 1):
            r['name'] = base if len(rs) == 1 else f'{base}[{k}]'
            r['alt'] = f'{base}[{k}]'
    for r in recs:
        r.setdefault('name', r['base'])
    return recs, errs


def _stream_configs(streams, cfgs):
    """{n: Configuration} for the Contents/Config-<n> streams. The stream number is usually the configuration id but
    not always (a configuration never rebuilt keeps an empty slot); each Config-<n> object stream names its
    configuration, so the longest configuration name it contains decides."""
    nums = sorted({int(m.group(1)) for k in streams for m in [re.match(r'(?:Contents/)?Config-(\d+)(?:-|$)', k)] if m})
    out = {}
    for n in nums:
        blob = streams.get(f'Contents/Config-{n}') or b''
        named = [c for c in cfgs if c.name and (c.name.encode('utf-16-le') in blob or c.name.encode() in blob)]
        same = next((c for c in named if c.id == n), None)   # the object names its own configuration among others
        out[n] = same or (max(named, key=lambda c: len(c.name)) if named else next((c for c in cfgs if c.id == n), Configuration(n, f'Config-{n}')))
    return out


def read_part(path, configuration=None):
    """Read a .sldprt: the solids of `configuration` (name; default the active one) and the part data."""
    try:
        streams = container.read(path)
    except ContainerError as e:
        raise ReadError(str(e))
    feats, cfgs = keywords(streams)
    if not cfgs:
        ids = sorted({int(m.group(1)) for k in streams for m in [re.match(r'(?:Contents/)?Config-(\d+)-Partition$', k)] if m})
        cfgs = [Configuration(i, f'Config-{i}') for i in ids] or [Configuration(0, 'Default')]
    warnings = []
    cfg = None
    if configuration:
        want = re.sub(r'\W+', '', configuration).lower()
        cfg = next((c for c in cfgs if re.sub(r'\W+', '', c.name).lower() == want), None)
        if cfg is None:
            warnings.append(f"configuration '{configuration}' is not in the part; read the active one")
    if cfg is None:
        aid = _active_config_id(streams)
        aname = _active_config_name(streams)
        cfg = next((c for c in cfgs if c.id == aid), None) or next((c for c in cfgs if c.name == aname), None) or cfgs[0]
    part = Part(configuration=cfg, configurations=cfgs, features=feats, warnings=warnings)
    head = streams.get('swXmlContents/Features') or b''
    m = re.search(rb'swVersion="(\d+)"', head)
    part.version = m.group(1).decode() if m else ''
    # the configuration asked for first; a configuration SolidWorks never rebuilt has an empty partition, so the
    # others follow (named in a warning). Solid bodies are preferred; surface bodies only when nothing else exists.
    owner = _stream_configs(streams, cfgs)
    nums = sorted(owner)
    order = [n for n in nums if owner[n] is cfg] + [n for n in nums if owner[n] is not cfg]
    displayed = displayed_bodies(streams)
    active = owner.get(_active_num(owner, _active_config_id(streams)))
    errors, chosen = [], []
    for sheets in (False, True):
        for num in order:
            c = owner[num]
            # the display list names the bodies SolidWorks shows (hidden ones, and the originals a feature
            # replaced, are not in it) — for the configuration it was saved in. Shown surface bodies count too.
            shown = displayed if displayed and c is active else None
            recs, errs = _records(streams, num, sheets or shown is not None)
            if not sheets and shown is None:
                recs = [r for r in recs if r['kind'] == 'solid']
            errors.extend(errs)
            sel = []
            if shown is not None:
                sel = [r for r in recs if r['atom'] is not None and r['atom'] in shown['atoms']]
                if not sel:
                    sel = [r for r in recs if r['name'] in shown['names'] or r['alt'] in shown['names']]
            how = 'shown'
            if not sel:
                part_recs = [r for r in recs if r['source'].endswith('Partition')]
                sel = [r for r in (part_recs if any(r['shape'] is not None or r['error'] for r in part_recs) else recs)]
                how = 'all'
            # a shown surface body that cannot be built is left out (named); a solid that cannot be built fails
            # the configuration — its geometry would be missing
            for r in [r for r in sel if r['error'] and r['kind'] == 'sheet' and any(x['kind'] == 'solid' and not x['error'] for x in sel)]:
                warnings.append(f"surface body '{r['name']}' left out: {r['error']}")
                sel.remove(r)
            bad = [r for r in sel if r['error']]
            if bad:
                errors.extend(f"{r['source']}: {r['error']}" for r in bad)
                continue
            sel = [r for r in sel if r['shape'] is not None]
            if not sel:
                if not sheets and not errs:
                    errors.append(f'Config-{num}: no solid bodies')
                continue
            chosen = sel
            if c is not cfg:
                if re.search(r'SM-FLAT-PATTERN$', c.name, re.I):
                    warnings.append(f"the part was saved showing its flat pattern, and SolidWorks kept no folded geometry for '{cfg.name}': "
                                    f"read the flat pattern. Open the part in SolidWorks, activate '{cfg.name}', save and upload again for the folded part")
                else:
                    warnings.append(f"configuration '{cfg.name}' holds no geometry in the file (never rebuilt in SolidWorks); read '{c.name}'")
                part.configuration = cfg = c
            surf = [r for r in sel if r['kind'] == 'sheet']
            if surf and len(surf) == len(sel):
                warnings.append('the part holds surface bodies, not solids (an imported model that was never knit); '
                                + '; '.join(sorted({r['detail'] for r in sel})))
            elif surf:
                warnings.append(f'{len(surf)} surface bod{"y" if len(surf) == 1 else "ies"} shown with the solids; '
                                + '; '.join(sorted({r['detail'] for r in surf})))
            hidden = len([r for r in recs if r['kind'] == 'solid']) - len([r for r in sel if r['kind'] == 'solid'])
            if how == 'shown' and hidden > 0:
                warnings.append(f'{hidden} hidden or replaced bod{"y" if hidden == 1 else "ies"} left out (not shown in SolidWorks)')
            break
        if chosen:
            break
    if not chosen:
        why = '; '.join(dict.fromkeys(errors)) or 'the file holds no body data for its configurations'
        raise ReadError(f'no solid geometry could be read ({why})')
    part.solids = [r['shape'] for r in chosen]
    part.details = [r['detail'] for r in chosen]
    part.source = ', '.join(dict.fromkeys(r['source'] for r in chosen))
    nodesets = []
    for r in chosen:
        if not any(r['nodes'] is n_ for n_, _ in nodesets):
            nodesets.append((r['nodes'], {x['body'].index for x in chosen if x['nodes'] is r['nodes']}))
    # part data
    part.properties = properties(streams, cfg.id)
    part.material = cfg.material
    items = cutlist(streams, cfg.id)
    part.sheet_metal = sheet_metal(items)
    for nodes, bodies in nodesets:
        attrs = attributes(nodes)
        for b in (x for x in nodes.values() if x.name == 'BODY' and x.index in bodies):
            a = attrs.get(b.index, {})
            if not part.color and a.get('SDL/TYSA_COLOUR_2'):
                part.color = _hex(a['SDL/TYSA_COLOUR_2'][0])
            if part.density is None and part.material and a.get('SDL/TYSA_DENSITY'):
                v = a['SDL/TYSA_DENSITY'][0]
                part.density = float(v[0] if isinstance(v, list) else v)
        if not part.color:
            cols = [a['SDL/TYSA_COLOUR'][0] for a in attrs.values() if a.get('SDL/TYSA_COLOUR')]
            if cols:
                part.color = _hex(cols[0])
        part.holes.extend(holes(nodes, attrs, feats, warnings, bodies))
    part.threads = cosmetic_threads(feats, part.holes)
    return part
