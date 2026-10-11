"""Native SolidWorks import: parts (.sldprt) and Pack and Go assemblies, read by Forge's own reader (app/swread).

A `.sldprt` is read in its active configuration (or the one an assembly uses): the bodies come straight from the
Parasolid data SolidWorks stores for that configuration and are rebuilt with their exact geometry, so nothing is
re-meshed or guessed. The part data the file carries — custom properties, material, colour, sheet-metal values,
Hole Wizard holes (found on the faces each Hole Wizard feature created), cosmetic thread sizes — is written as a
Forge package (docs/FORGE_PACKAGE.md), so the rest of the import is the same as for a `.forge` upload: sanitize,
analyse, link holes to the bores Forge found, apply taps as *from CAD*.

Every solid is checked before it is used: valid, closed, positive volume. A part whose geometry cannot be read
exactly is refused with the reason (and the hint to export STEP); nothing is approximated silently.

Assemblies: the assembly file holds its component instance tree as XML (`swXmlContents/COMPINSTANCETREE`, or
`COMPINSTANCETREE__ZLB` in older OLE-format files): every occurrence with its part file, configuration, 4x4
placement, suppressed / hidden / exclude-from-BOM flags, sub-assemblies nested. Forge imports a SolidWorks
*Pack and Go* ZIP (the assembly with every referenced part): the tree gives the structure and placements, each
`.sldprt` is read as above in the configuration the assembly uses, and the result is an assembly package with
per-part geometry. A `.sldasm` on its own is refused at upload with that hint; a part missing from the ZIP becomes a
placeholder box from its bounding box, flagged.
"""
from __future__ import annotations

import math
import os
import re
import shutil
import zipfile
from pathlib import Path

import numpy as np

from . import package, swread

EXTS = ('.sldprt',)
ASM_EXTS = ('.sldasm',)
BUNDLE_EXTS = ('.zip',)
STEP_EXTS = ('.step', '.stp')   # parts an assembly references as STEP (SolidWorks 3D Interconnect)
INSTANCE_TREE_STREAMS = ('swXmlContents/COMPINSTANCETREE', 'swXmlContents/COMPINSTANCETREE__ZLB')
COARSE = package.COARSE
GENERATOR = 'forge-swread'


def available():
    """The reader is part of Forge; kept for the callers that gate native uploads."""
    return True


class NativeError(ValueError):
    """The native file could not be converted (message shown on the revision)."""


def _thread_from(designation, diameter=None):
    """'M4' -> 'M4x0.7' (ISO coarse pitch), 'M8x1' kept; a bare diameter gives the coarse thread of that size."""
    m = re.match(r'M(\d+(?:\.\d+)?)(?:x(\d+(?:\.\d+)?))?$', designation or '')
    if m:
        d = float(m.group(1))
        p = float(m.group(2)) if m.group(2) else COARSE.get(round(d, 2))
        return f'M{d:g}x{p:g}' if p else f'M{d:g}'
    if designation:
        return designation
    if diameter:
        p = COARSE.get(round(float(diameter), 2))
        return f'M{float(diameter):g}x{p:g}' if p else f'M{float(diameter):g}'
    return ''


def _compound(shapes):
    from OCP.TopoDS import TopoDS_Compound
    from OCP.BRep import BRep_Builder
    comp = TopoDS_Compound()
    b = BRep_Builder()
    b.MakeCompound(comp)
    for s in shapes:
        b.Add(comp, s)
    return comp




def _bbox(shapes):
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    box = Bnd_Box()
    for s in shapes:
        BRepBndLib.AddOptimal_s(s, box, False, False)
    lo, hi = box.CornerMin(), box.CornerMax()
    lo, hi = np.array([lo.X(), lo.Y(), lo.Z()]), np.array([hi.X(), hi.Y(), hi.Z()])
    return (hi - lo).round(4).tolist(), lo.round(4).tolist()


def part_from_sw(sw, name, warnings):
    """A Forge package part dict (docs/FORGE_PACKAGE.md) from a swread.Part."""
    holes = []
    for h in sw.holes:
        kind = h['kind']
        thread = _thread_from(h['thread']) if kind == 'tap' else ''
        if kind == 'tap' and not thread:
            warnings.append(f"{h['feature']}: tapped hole without a readable thread size; imported as a plain hole")
            kind = 'simple'
        holes.append({'feature': h['feature'], 'kind': kind, 'standard': '', 'fastener': h.get('fastener') or '', 'thread': thread or None, 'thread_class': '',
                      'thread_depth': None, 'thread_through': kind == 'tap' and h['through'], 'diameter': h['diameter'], 'depth': h['depth'], 'through': h['through'],
                      'counterbore': h['counterbore'], 'countersink': h['countersink'], 'point': h['point'], 'direction': h['direction'], 'face': None})
    for i, h in enumerate(holes, 1):
        h['id'] = f'h{i}'
    unplaced = [{'feature': t['feature'], 'thread': _thread_from('', t['diameter']), 'diameter': t['diameter'], 'thread_depth': None, 'thread_through': False}
                for t in sw.threads]
    bbox, bbox_min = _bbox(sw.solids)
    volume = sum(swread.brep.volume(s) for s in sw.solids)
    props = sw.properties

    def prop(*keys):
        return next((v for k, v in props.items() if k.lower().replace(' ', '') in keys and v), '')
    part = {'id': package._norm(name).replace(' ', '-')[:80] or 'part', 'name': name[:200], 'file': '', 'configuration': sw.configuration.name,
            'step_names': [name], 'part_number': prop('partnumber', 'partno', 'pn', 'number'), 'description': prop('description'), 'revision': prop('revision', 'rev'),
            'properties': props, 'material': sw.material, 'density': round(sw.density / 1000, 4) if sw.density else None, 'mass_kg': None,
            'volume_mm3': round(volume, 3), 'bbox': bbox, 'bbox_min': bbox_min, 'bodies': len(sw.solids), 'sheet_metal': sw.sheet_metal,
            'holes': holes, 'unplaced_threads': unplaced, 'welds': [], 'color': sw.color}
    if not package.ID_RE.match(part['id']):
        part['id'] = 'part'
    return part


def read(source, configuration=None):
    """swread.Part for a .sldprt, NativeError with the reason when it cannot be read."""
    try:
        return swread.read_part(source, configuration)
    except swread.ReadError as e:
        raise NativeError(f'the SolidWorks part could not be read: {e}. Export it from SolidWorks as STEP or as a Forge package.')
    except Exception as e:  # a reader defect must not take the worker down; report it on the revision
        raise NativeError(f'the SolidWorks part could not be read ({type(e).__name__}: {e}). Export it from SolidWorks as STEP or as a Forge package.')


def convert(source, folder, name, limit, configuration=None):
    """Read `source` (.sldprt) into folder/source.brep plus folder/package/ and return the package dict;
    pkg["source"] is the geometry file the import reads."""
    from OCP.BRepTools import BRepTools
    source, folder = Path(source), Path(folder)
    if source.stat().st_size > limit:
        raise NativeError('the part exceeds the configured upload limit')
    sw = read(source, configuration)
    warnings = list(sw.warnings)
    part = part_from_sw(sw, name, warnings)
    shape = _compound(sw.solids)
    BRepTools.Write_s(shape, str(folder / 'source.brep'))
    geometry_note = f"{len(sw.solids)} solid(s) from {sw.source} ({'; '.join(sw.details)})"
    man = {'schema': package.SCHEMA, 'generator': {'name': GENERATOR, 'version': '1'}, 'source': {'cad': 'SolidWorks', 'version': sw.version, 'file': source.name if source.suffix.lower() in EXTS else name, 'kind': 'part'},
           'created': '', 'units': 'mm', 'model': {'path': 'model.brep', 'format': 'brep', 'sha256': ''}, 'root': part['id'],
           'native': {'tool': GENERATOR, 'geometry': geometry_note, 'configuration': sw.configuration.name, 'configurations': [c.name for c in sw.configurations]}}
    pkg = {'manifest': package.validate_manifest(man), 'parts': {part['id']: package.validate_part(part, 'native')}, 'assembly': None, 'warnings': warnings[:50], 'previews': 0}
    pkg['manifest']['native'] = man['native']
    pkg['parts'][part['id']]['color'] = part.get('color', '')
    pkg['source'] = str(folder / 'source.brep')
    package.write_folder(folder, pkg)
    if os.getenv('FORGE_KEEP_NATIVE', '1') not in ('1', 'true', 'yes'):
        source.unlink(missing_ok=True)
    return pkg


# ------------------------------------------------------------------------------------------------ assemblies
def instance_tree_xml(path):
    """The component instance tree XML a SolidWorks assembly stores (plain in current files, zlib-compressed in
    older OLE-format ones)."""
    import zlib
    path = Path(path)
    try:
        streams = swread.container.read(path)
    except swread.ContainerError as e:
        raise NativeError(f'{path.name}: {e}')
    for key in INSTANCE_TREE_STREAMS:
        data = streams.get(key)
        if not data:
            continue
        i = data.find(b'<?xml')
        if 0 <= i < 64:
            return data[i:]
        for off in range(0, min(64, len(data))):
            try:
                return zlib.decompress(data[off:])
            except zlib.error:
                continue
    raise NativeError(f'{path.name}: no readable component instance tree in the file (saved by a SolidWorks version that does not write one)')


def parse_instance_tree(xml_bytes):
    """The assembly's occurrences from its instance tree XML: {name, file, configuration, bbox, subassemblies,
    leaves: [{file, model, configuration, instance, path, matrix, suppressed, hidden, exclude_from_bom, virtual,
    bbox}]}. Sub-assemblies are expanded in place with their placements composed; `matrix` is the 4x4
    part-to-assembly transform in mm (column vectors), `bbox` the part's box in its own frame, mm."""
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as e:
        raise NativeError(f'component instance tree is not valid XML ({e})')
    files, models = {}, {}
    for el in root.iter():
        tag = el.tag.split('}')[-1]
        if tag == 'swFile':
            files[el.get('id')] = {'path': el.get('swPath') or '', 'type': (el.get('swDocType') or '').upper()}
        elif tag == 'swModel':
            models[el.get('id')] = el

    def refs(m):
        return [c for c in m if c.tag.split('}')[-1] == 'swReference']

    def yes(v):
        return (v or 'NO').strip().upper() == 'YES'

    def fname(m):
        return Path((files.get(m.get('swFileRef'), {}).get('path') or '').replace('\\', '/')).name

    def ftype(m):
        return files.get(m.get('swFileRef'), {}).get('type', '')

    def bbox_of(m):
        try:
            v = [float(x) for x in (m.get('swBoundingBox') or '').split()]
        except ValueError:
            return None
        return [x * 1000 for x in v] if len(v) == 6 and all(math.isfinite(x) for x in v) else None

    def mat(t):
        try:
            v = [float(x) for x in (t or '').split()]
        except ValueError:
            v = []
        if len(v) != 16 or not all(math.isfinite(x) for x in v):
            return np.eye(4)
        T = np.array(v).reshape(4, 4)  # SolidWorks: row vectors (p' = p T), translation in the last row, metres
        M = np.eye(4)
        M[:3, :3] = T[:3, :3].T
        M[:3, 3] = T[3, :3] * 1000
        return M
    referenced = {c.get('swModelRef') for m in models.values() for c in refs(m)}
    roots = [mid for mid, m in models.items() if ftype(m) == 'ASSEMBLY' and mid not in referenced]
    if not roots:
        roots = [mid for mid, m in models.items() if ftype(m) == 'ASSEMBLY']
    if not roots:
        raise NativeError('the instance tree names no assembly')
    rid = max(roots, key=lambda mid: len(refs(models[mid])))
    leaves, subs = [], []

    def walk(mid, parent, path, depth, seen):
        m = models.get(mid)
        if m is None or depth > 32 or mid in seen:
            return
        for c in refs(m):
            cm = models.get(c.get('swModelRef'))
            if cm is None:
                continue
            inst = f"{c.get('swName') or cm.get('swName') or 'component'}-{c.get('swReferenceNumber') or '1'}"
            M = parent @ mat(c.get('swTransform'))
            suppressed = yes(c.get('swSuppressed'))
            if ftype(cm) == 'ASSEMBLY':
                subs.append(fname(cm))
                if not suppressed:
                    walk(cm.get('id'), M, path + [inst], depth + 1, seen | {mid})
                continue
            leaves.append({'file': fname(cm), 'model': cm.get('swName') or '', 'configuration': c.get('swConfigurationName') or cm.get('swConfigurationName') or '',
                           'instance': inst, 'path': ' / '.join(path + [inst]), 'matrix': M.tolist(), 'suppressed': suppressed, 'hidden': yes(c.get('swHidden')),
                           'exclude_from_bom': yes(c.get('swExcludeFromBOM')), 'virtual': yes(c.get('swIsVirtualComponent')), 'bbox': bbox_of(cm)})
    rm = models[rid]
    walk(rid, np.eye(4), [rm.get('swName') or 'Assembly'], 0, frozenset())
    return {'name': rm.get('swName') or '', 'file': fname(rm), 'configuration': rm.get('swConfigurationName') or '', 'bbox': bbox_of(rm),
            'subassemblies': sorted(set(subs)), 'leaves': leaves}


def _extract_bundle(archive, dest, limit):
    """SolidWorks documents from a ZIP (Pack and Go) into dest; {lowercase file name: path}. Other members are
    skipped; paths that leave dest, and members over the upload limit, are refused."""
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    if not zipfile.is_zipfile(archive):
        raise NativeError('not a ZIP archive; use SolidWorks File ▸ Pack and Go ▸ Save to Zip and upload that file')
    files, total = {}, 0
    with zipfile.ZipFile(archive) as z:
        for info in z.infolist():
            n = info.filename.replace('\\', '/')
            if n.endswith('/') or n.startswith('/') or '..' in Path(n).parts:
                continue
            ext = Path(n).suffix.lower()
            if ext not in EXTS + ASM_EXTS + STEP_EXTS:
                continue
            if info.file_size > limit:
                raise NativeError(f'{Path(n).name} exceeds the configured upload limit')
            total += info.file_size
            if total > 8 * limit:
                raise NativeError('the ZIP unpacks to more than eight times the upload limit')
            key = Path(n).name.lower()
            if key in files:
                continue  # the first copy wins (Pack and Go keeps one of each)
            target = dest / f'{len(files):04d}-{Path(n).name}'
            with z.open(info) as src, target.open('wb') as out:
                shutil.copyfileobj(src, out, 1 << 20)
            files[key] = target
    return files


def _placeholder_shape(bbox):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt
    lo, hi = bbox[:3], bbox[3:]
    size = [max(float(b) - float(a), .5) for a, b in zip(lo, hi)]
    return BRepPrimAPI_MakeBox(gp_Pnt(*[float(x) for x in lo]), *size).Shape()


def _placed_compound(shapes_by_id, components):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
    from OCP.gp import gp_Trsf
    placed = []
    for c in components:
        shape = shapes_by_id.get(c['part'])
        if shape is None:
            continue
        M = np.array(c['transform'], float).reshape(4, 4)
        tr = gp_Trsf()
        tr.SetValues(*[float(x) for x in M[:3].ravel()])
        placed.append(BRepBuilderAPI_Transform(shape, tr, True).Shape())
    return _compound(placed)


def _resolver(files):
    """Finds the bundle file an assembly references. Pack and Go can prefix every file name (\"ISO-\", a project
    code), so a reference matches a file whose name is the referenced name, or ends with it after such a prefix."""
    def find(ref):
        key = Path(str(ref or '').replace('\\', '/')).name.lower()
        if not key:
            return None
        if key in files:
            return files[key]
        hits = [k for k in files if k.endswith(key) and len(k) - len(key) <= 40]
        return files[min(hits, key=len)] if hits else None
    return find


def _virtual_parts(asms, dest):
    """[(owner, name, path)] for every virtual component the assemblies embed, nested ones included. A virtual
    part (or sub-assembly) lives inside its assembly as a whole document in a VirtualComp/<name>-sldprt (-sldasm)
    stream; `owner` is the chain of assemblies it sits in, innermost first, ending with the assembly file's stem,
    lowercased (references name a virtual sub-assembly '<name>_<parent>'). Long names are stored cut to 25
    characters plus a counter."""
    out, dest, n = [], Path(dest), [0]

    def scan(doc, owner, depth):
        if depth > 8:
            return
        try:
            streams = swread.container.read(doc)
        except swread.ContainerError:
            return
        for k, data in streams.items():
            m = re.match(r'VirtualComp/(.+)-(sldprt|sldasm)$', k, re.I)
            if not m or not data:
                continue
            dest.mkdir(parents=True, exist_ok=True)
            p = dest / f'{n[0]:04d}-{re.sub(r"[^A-Za-z0-9._ -]+", "_", m.group(1))[:60]}.{m.group(2).lower()}'
            n[0] += 1
            p.write_bytes(data)
            name = m.group(1).lower()
            if m.group(2).lower() == 'sldprt':
                out.append((owner, name, p))
            else:
                scan(p, (name,) + owner, depth + 1)
    for a in asms:
        scan(a, (re.sub(r'^\d{4}-', '', a.stem).lower(),), 0)
    return out


def _vname_matches(stored, name):
    """A stored virtual-component name against the full one ('Copy of Copy of battery s10' for 'Copy of Copy of
    battery swap setup full assmcx-STEP')."""
    if stored == name:
        return True
    m = re.match(r'(.{25})\d+$', stored)
    return bool(m) and name.startswith(m.group(1))


def _owner_matches(stored, owner):
    """The owner a virtual part was found under (the assembly file's stem, or '<virtual asm>_<...>_<file stem>'
    with names possibly cut) against the owner its reference names (no Pack and Go prefix, names in full)."""
    top, chain = stored[-1], stored[:-1]
    if not chain:
        return top == owner or top.endswith(owner)
    head = re.sub(r'\d+$', '', chain[0]) if re.match(r'.{25}\d+$', chain[0]) else chain[0]
    if not owner.startswith(head):
        return False
    return any(owner[k] == '_' and top.endswith(owner[k + 1:]) for k in range(len(head), len(owner)))


def _virtual_file(virtual, ref):
    """The extracted file of a virtual component referenced as '<part>^<owner assembly>.sldprt'."""
    stem = Path(str(ref or '').replace('\\', '/')).stem
    if '^' not in stem:
        return None
    part, owner = (x.lower() for x in stem.split('^', 1))
    hits = [(o, p) for o, n, p in virtual if _vname_matches(n, part)]
    if not hits:
        return None
    return next((p for o, p in hits if _owner_matches(o, owner)), hits[0][1])


def _read_step(path):
    """Shape of a STEP file a component references directly (SolidWorks 3D Interconnect), mm."""
    from OCP.STEPControl import STEPControl_Reader
    from OCP.IFSelect import IFSelect_RetDone
    r = STEPControl_Reader()
    if r.ReadFile(str(path)) != IFSelect_RetDone:
        raise NativeError(f'{Path(path).name}: not a readable STEP file')
    r.TransferRoots()
    shape = r.OneShape()
    if shape is None or shape.IsNull():
        raise NativeError(f'{Path(path).name}: the STEP file holds no geometry')
    return shape


def convert_bundle(source, folder, name, limit, progress=None):
    """Decode a SolidWorks Pack and Go ZIP (an assembly with its parts) into folder/package/ (assembly package
    with per-part geometry under package/geometry/) plus folder/source.brep (every part placed), and return the
    package dict; pkg['bundle'] marks it for bundle_leaves(). A ZIP holding a single part and no assembly is
    imported as that part."""
    from .scrub import clean_name
    from .cad import import_model, BRepTools
    source, folder = Path(source), Path(folder)
    work = folder / 'native'
    files = _extract_bundle(source, work / 'bundle', limit)
    asms = [p for p in files.values() if p.suffix.lower() in ASM_EXTS]
    prts = [p for p in files.values() if p.suffix.lower() in EXTS]
    if not asms:
        if len(prts) == 1:
            return convert(prts[0], folder, clean_name(prts[0].stem[5:] if re.match(r'^\d{4}-', prts[0].name) else prts[0].stem), limit)
        raise NativeError('the ZIP holds no SolidWorks assembly (.sldasm); use SolidWorks File ▸ Pack and Go ▸ Save to Zip so the assembly and every part are in one file')
    warnings = []
    trees = {}
    for a in asms:
        try:
            trees[a] = parse_instance_tree(instance_tree_xml(a))
        except NativeError as e:
            warnings.append(str(e))
    if not trees:
        raise NativeError('no readable assembly in the ZIP: ' + '; '.join(warnings))
    find = _resolver(files)
    # the root: an assembly no other one in the ZIP uses as a sub-assembly, named like the upload when several
    subs = {find(s_) for t in trees.values() for s_ in t['subassemblies']}
    roots = [a for a in trees if a not in subs] or list(trees)
    wanted = _norm_name(name)
    root = next((a for a in roots if wanted and (_norm_name(a.stem[5:]).endswith(wanted) or _norm_name(trees[a]['name']) == wanted)), None) \
        or max(roots, key=lambda a: len(trees[a]['leaves']))
    if len(roots) > 1:
        warnings.append(f"the ZIP holds {len(roots)} top-level assemblies; imported {root.name[5:]} (others: {', '.join(a.name[5:] for a in roots if a is not root)[:200]})")
    tree = trees[root]
    leaves = [l for l in tree['leaves'] if not l['suppressed']]
    n_supp = len(tree['leaves']) - len(leaves)
    if n_supp:
        warnings.append(f'{n_supp} suppressed component(s) left out')
    if not leaves:
        raise NativeError(f"{root.name[5:]}: the assembly has no resolved components")
    virtual = _virtual_parts(asms, work / 'virtual')
    by_file = {}
    for l in leaves:
        by_file.setdefault(l['file'].lower(), []).append(l)
    parts, shapes, comps, used_ids, notes = {}, {}, [], set(), {}
    placeholder_n = 0
    (folder / 'package' / 'geometry').mkdir(parents=True, exist_ok=True)
    for i, (fkey, insts) in enumerate(by_file.items()):
        is_virtual = insts[0]['virtual'] or '^' in Path(insts[0]['file']).stem
        stem = Path(insts[0]['file']).stem.split('^', 1)[0] or insts[0]['model'] or f'part-{i + 1}'
        pname = clean_name(stem) or stem
        if progress:
            progress(i, len(by_file), pname)
        pid = package._norm(pname).replace(' ', '-')[:70] or f'part-{i + 1}'
        if not package.ID_RE.match(pid):
            pid = f'part-{i + 1}'
        while pid in used_ids:
            pid = f'{pid[:66]}-{len(used_ids) + 1}'
        used_ids.add(pid)
        path = find(insts[0]['file'])
        if path is None and is_virtual:
            path = _virtual_file(virtual, insts[0]['file'])
        step = None
        if path is None and re.search(r'\.(stp|step)\.sldprt$', insts[0]['file'], re.I):
            step = find(Path(insts[0]['file']).stem)   # 'bf_17.stp.SLDPRT' -> the bf_17.stp it was made from
        part, shape = None, None
        if step is not None:
            try:
                shape = _read_step(step)
                bb = _bbox([shape])[0]
                part = {'id': pid, 'name': pname, 'file': insts[0]['file'], 'configuration': '', 'step_names': [pname], 'properties': {'Source': f'STEP file {step.name[5:]}'},
                        'bbox': bb, 'holes': [], 'welds': [], 'bodies': 1, 'material': '', 'color': '', 'unplaced_threads': []}
                notes[pid] = f'read from the STEP file {step.name[5:]}'
            except NativeError as e:
                warnings.append(f'{pname}: {e}')
                part = shape = None
        if path is not None:
            sub = work / 'parts' / pid
            sub.mkdir(parents=True, exist_ok=True)
            try:
                ppkg = convert(path, sub, pname, limit, configuration=insts[0]['configuration'] or None)
                part = next(iter(ppkg['parts'].values()))
                shape = _compound([lf['shape'] for lf in import_model(Path(ppkg['source']))])
                warnings.extend(f'{pname}: {w}' for w in ppkg['warnings'][:12])
                notes[pid] = ppkg['manifest']['native']['geometry']
                cfg = insts[0]['configuration']
                if cfg and part.get('configuration') and _norm_name(cfg) != _norm_name(part['configuration']):
                    warnings.append(f"{pname}: the assembly uses configuration '{cfg}' but the part holds geometry only for '{part['configuration']}'; check its geometry")
            except NativeError as e:
                warnings.append(f'{pname}: {e}')
                part = shape = None
        if part is None:
            bbox = insts[0]['bbox']
            if not bbox:
                why = 'its part file is not in the ZIP' if path is None and step is None else 'its part could not be read'
                warnings.append(f'{pname}: left out — {why}, and the assembly stores no bounding box for a placeholder')
                continue
            reason = ('a virtual component the assembly file does not embed' if is_virtual and path is None else 'its part file is not in the ZIP' if path is None
                      else 'its part could not be decoded')
            warnings.append(f'{pname}: placeholder box from the bounding box — {reason}')
            shape = _placeholder_shape(bbox)
            part = {'id': pid, 'name': pname, 'file': insts[0]['file'], 'configuration': insts[0]['configuration'], 'step_names': [pname], 'properties': {'Placeholder': reason},
                    'bbox': [abs(bbox[3] - bbox[0]), abs(bbox[4] - bbox[1]), abs(bbox[5] - bbox[2])], 'holes': [], 'welds': [], 'bodies': 1, 'material': '', 'color': '', 'unplaced_threads': []}
            notes[pid] = 'placeholder box (geometry not available)'
            placeholder_n += 1
        part['id'] = pid
        part['name'] = pname
        part['file'] = insts[0]['file']
        part['step_names'] = [pname]
        parts[pid] = package.validate_part(part, pname)
        parts[pid]['color'] = part.get('color', '')
        parts[pid]['unplaced_threads'] = part.get('unplaced_threads') or parts[pid].get('unplaced_threads') or []
        shapes[pid] = shape
        BRepTools.Write_s(shape, str(folder / 'package' / 'geometry' / f'{pid}.brep'))
        for l in insts:
            comps.append({'id': f'c{len(comps) + 1}', 'part': pid, 'name': l['instance'], 'instance': l['instance'], 'path': l['path'], 'configuration': l['configuration'],
                          'transform': [float(x) for x in np.array(l['matrix'], float).ravel()], 'suppressed': False, 'exclude_from_bom': l['exclude_from_bom'], 'virtual': l['virtual'], 'hidden': l['hidden']})
    if not parts:
        raise NativeError('no component of the assembly could be imported: ' + '; '.join(warnings[:5]))
    asm_name = tree['name'] or clean_name(root.stem[5:]) or name
    asm = package.validate_assembly({'name': asm_name[:200], 'configuration': tree['configuration'], 'components': comps})
    placed = _placed_compound(shapes, asm['components'])
    BRepTools.Write_s(placed, str(folder / 'source.brep'))
    summary = f"{len(parts)} part(s) read for {len(asm['components'])} occurrence(s)" + (f', {placeholder_n} placeholder(s)' if placeholder_n else '')
    man = {'schema': package.SCHEMA, 'generator': {'name': GENERATOR, 'version': '1'}, 'source': {'cad': 'SolidWorks', 'version': '', 'file': root.name[5:], 'kind': 'assembly'},
           'created': '', 'units': 'mm', 'model': {'path': 'model.brep', 'format': 'brep', 'sha256': ''}, 'root': 'assembly',
           'native': {'tool': GENERATOR, 'geometry': summary, 'parts': [f'{pid}: {n_}' for pid, n_ in notes.items()][:200], 'bundle': True, 'placeholders': placeholder_n}}
    pkg = {'manifest': package.validate_manifest(man), 'parts': parts, 'assembly': asm, 'warnings': warnings[:50], 'previews': 0, 'source': str(folder / 'source.brep'), 'bundle': True}
    pkg['manifest']['native'] = man['native']
    package.write_folder(folder, pkg)
    if os.getenv('FORGE_KEEP_NATIVE', '1') not in ('1', 'true', 'yes'):
        shutil.rmtree(work / 'bundle', ignore_errors=True)
    return pkg


def bundle_leaves(folder, pkg):
    """Component leaves for the worker from a bundle package: one per part with its placements."""
    from .cad import read_brep
    folder = Path(folder)
    by_part = {}
    for c in (pkg.get('assembly') or {}).get('components') or []:
        by_part.setdefault(c['part'], []).append(c)
    leaves = []
    for pid, part in pkg['parts'].items():
        f = folder / 'package' / 'geometry' / f'{pid}.brep'
        if not f.exists():
            continue
        comps = by_part.get(pid) or []
        inst = [{'matrix': np.array(c['transform'], float).reshape(4, 4).tolist(), 'path': c.get('path') or c.get('name') or pid} for c in comps] or [{'matrix': np.eye(4).tolist(), 'path': part['name']}]
        meta = {'color': part['color']} if part.get('color') else {}
        leaves.append({'key': pid, 'name': part['name'], 'shape': read_brep(f), 'instances': inst, 'meta': meta,
                       'hidden': bool(comps) and all(c.get('hidden') for c in comps), 'exclude_from_bom': bool(comps) and all(c.get('exclude_from_bom') for c in comps),
                       'placeholder': 'Placeholder' in (part.get('properties') or {})})
    return leaves


def _norm_name(s):
    return re.sub(r'[^a-z0-9]+', '', str(s or '').lower())
