r"""Forge exporter for SolidWorks — writes a .forge package (docs/FORGE_PACKAGE.md) from a part or assembly.

Runs on a Windows machine next to a licensed SolidWorks seat and drives it through its COM API, so every seat
can export without any extra licence (no MBD needed). What it collects and STEP cannot carry:

  * Hole Wizard holes: tapped / clearance / counterbore / countersink / dowel, thread size + class + depth,
    hole depth, through/blind, one entry per hole instance with its axis in part coordinates
  * cosmetic threads applied to plain holes
  * sheet-metal data: thickness, bend radius, K-factor (or allowance / deduction), bends, flat-pattern presence
  * material, mass, bounding box, custom properties (part number, description, revision, finish ...)
  * assembly tree with every component's placement; Toolbox fasteners; press-in inserts (PEM-style nuts, studs,
    standoffs, rivnuts, weld nuts) so Forge can put the hardware on the right hole

Usage (Windows, SolidWorks installed, Python 3.9+ with pywin32):

    pip install pywin32
    python forge_export.py                                           # the document active in SolidWorks
    python forge_export.py "C:\models\GT400.SLDASM"                 # writes C:\models\GT400.forge
    python forge_export.py part.SLDPRT --out D:\exports\part.forge
    python forge_export.py asm.SLDASM --probe                        # list features / components, write nothing
    python forge_export.py asm.SLDASM --push https://forge.example --project GT400 --email you@co --password ...

From inside SolidWorks: the ForgeExport macro (ForgeExport.vba, see README.md) runs this script on the active
document with --from-macro. With a forge-export.json next to the script the package is uploaded automatically.

An assembly is exported in one go: every component, its placement, Toolbox fasteners and press-in inserts.
The exporter never guesses a thread from a diameter: a hole is exported as tapped only when its Hole Wizard
feature (or a cosmetic thread) says so. Everything it could not read is listed in manifest.warnings and printed.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import re
import sys
import tempfile
import zipfile

VERSION = '0.1.0'
SCHEMA = 'forge-package/1'
M = 1000.0  # SolidWorks API lengths are metres; the package is millimetres

# SolidWorks constants used (swconst), written out so the script runs without the swconst type library.
SW_DOC_PART, SW_DOC_ASSEMBLY = 1, 2            # swDocumentTypes_e
SW_OPEN_SILENT, SW_OPEN_READONLY = 1, 2         # swOpenDocOptions_e
SW_SAVE_CURRENT_VERSION, SW_SAVE_SILENT = 0, 1  # swSaveAsVersion_e / swSaveAsOptions_e
SW_STEP_AP_PREF = 214                           # swUserPreferenceIntegerValue_e.swStepAP
SW_END_BLIND, SW_END_THROUGH_ALL = 0, 1         # swEndConditions_e
SW_BODY_SOLID = 0                               # swBodyType_e.swSolidBody
SW_COMPONENT_RESOLVED = 2                       # swComponentSuppressionState_e.swComponentFullyResolved
SW_BEND_ALLOWANCE = {0: 'table', 1: 'k_factor', 2: 'allowance', 3: 'deduction', 4: 'calculation'}  # swBendAllowanceTypes_e

PATTERN_TYPES = {'LPattern', 'CirPattern', 'MirrorPattern', 'SketchPattern', 'TablePattern', 'CurvePattern', 'FillPattern', 'VarPattern', 'MirrorStretch', 'Mirror'}
SKETCH_TYPES = {'ProfileFeature', '3DProfileFeature'}
FASTENER_WORDS = (('screw', 'screw'), ('bolt', 'bolt'), ('washer', 'washer'), ('rivet', 'rivet'), ('nut', 'nut'), ('pin', 'pin'))
INSERT_PATTERNS = [  # (regex on name / description / file name, insert type)
    (r'\b(?:S|SS|CLS|CLSS|SP|SMPS|SMPP|CLA|CLAS|SL|H|U|UL)-M?\d', 'nut'), (r'\b(?:F|FE|FS|FEO|FEOX)-M?\d', 'flush_nut'), (r'\b(?:FH|FHS|FHA|FHL|HFH|TFH|FH4)-M?\d', 'stud'),
    (r'\b(?:SO|SOS|SOA|BSO|BSOS|BSOA|TSO|TSOS|TSOA|DSO|DSOS)-M?\d', 'standoff'), (r'riv\s*nut|rivet\s*nut|blind\s*rivet\s*nut|nutsert', 'rivnut'), (r'weld\s*nut', 'weld_nut'),
    (r'self[- ]?clinch\w*\s*(?:nut)?|clinch\s*nut|pem\s*nut', 'nut'), (r'(?:self[- ]?clinch\w*|pem)\s*stud', 'stud'), (r'(?:self[- ]?clinch\w*|pem)\s*standoff|standoff', 'standoff')]
THREAD_RE = re.compile(r'(M\s?\d+(?:\.\d+)?(?:\s?[xX×]\s?\d+(?:\.\d+)?)?|#\d+-\d+|\d+/\d+-\d+)')
NOMINAL_RE = re.compile(r'(M\d+(?:\.\d+)?|#\d+-\d+|\d+/\d+-\d+)')  # fastener / insert size without the length
PN_RE = re.compile(r'\b([A-Z]{1,4}-M?\d+(?:\.\d+)?-\d+(?:[A-Z]+)?)\b')
STANDARD_RE = re.compile(r'\b((?:ISO|DIN|ANSI|ASME|JIS|BS|GB|AS|EN|IS)\s?[A-Z]?\d+(?:[-.]\d+)*)\b', re.I)
LENGTH_RE = re.compile(r'[xX×]\s?(\d+(?:\.\d+)?)\b')


# ------------------------------------------------------------------------------------------------ COM helpers
def connect(late=False):
    """Attach to the running SolidWorks (or start it). Early binding (makepy from the SolidWorks type library;
    slow the first time, then cached) makes ByRef out-parameters come back as tuples and lets CastTo work;
    --late skips it and relies on IDispatch plus VARIANT ByRef arguments."""
    try:
        import win32com.client  # noqa: F401
    except ImportError:
        sys.exit('pywin32 is required: pip install pywin32')
    import win32com.client as wc
    app, early = None, False
    try:
        running = wc.GetActiveObject('SldWorks.Application')  # the instance the user is working in (macro button)
    except Exception:
        running = None
    if not late:
        try:
            app = wc.gencache.EnsureDispatch(running or 'SldWorks.Application')
            early = True
        except Exception as e:
            print(f'  ! early binding unavailable ({e}); using late binding')
    if app is None:
        app = wc.Dispatch(running or 'SldWorks.Application')
    app.Visible = True
    return app, early


def cast(obj, iface):
    """IModelDoc2 -> IPartDoc / IAssemblyDoc. SolidWorks documents expose all three through one IDispatch, so
    the plain object usually works; CastTo is tried for early-bound sessions."""
    if obj is None:
        return None
    try:
        import win32com.client as wc
        return wc.CastTo(obj, iface)
    except Exception:
        return obj


def byref_int():
    import pythoncom
    import win32com.client as wc
    return wc.VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)


def byref_str():
    import pythoncom
    import win32com.client as wc
    return wc.VARIANT(pythoncom.VT_BYREF | pythoncom.VT_BSTR, '')


def first(x):
    """The document from an early-bound (doc, errors, warnings) tuple or a late-bound plain return."""
    return x[0] if isinstance(x, tuple) else x


def seq(x):
    """COM arrays arrive as tuples, None or a scalar; always iterate a list."""
    if x is None:
        return []
    if isinstance(x, (list, tuple)):
        return list(x)
    return [x]


def get(obj, name, default=None):
    try:
        v = getattr(obj, name)
        return v() if callable(v) else v
    except Exception:
        return default


# ------------------------------------------------------------------------------------------------ maths
def sw_matrix(array_data):
    """SolidWorks IMathTransform.ArrayData (row-vector convention, metres) -> 4x4 row-major, column-vector
    convention, millimetres: p_root = R^T·p·scale + t."""
    a = list(array_data)
    if len(a) < 13:
        return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    s = a[12] or 1.0
    r = [[a[0], a[3], a[6]], [a[1], a[4], a[7]], [a[2], a[5], a[8]]]
    t = [a[9] * M, a[10] * M, a[11] * M]
    return [r[0][0] * s, r[0][1] * s, r[0][2] * s, t[0], r[1][0] * s, r[1][1] * s, r[1][2] * s, t[1], r[2][0] * s, r[2][1] * s, r[2][2] * s, t[2], 0, 0, 0, 1]


def apply_matrix(m, p):
    return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]]


def mirrored(m):
    r = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]]
    det = (r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]))
    return det < 0


def norm(v):
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def dist_to_line(p, o, d):
    v = [p[i] - o[i] for i in range(3)]
    t = sum(v[i] * d[i] for i in range(3))
    w = [v[i] - t * d[i] for i in range(3)]
    return math.sqrt(sum(x * x for x in w)), t


def slug(s):
    s = re.sub(r'[^a-z0-9._-]+', '-', (s or '').lower()).strip('-.')
    return (s or 'part')[:80]


def clean_component_name(name):
    """'GT-SM-046 SMPS PLATE-1' -> 'GT-SM-046 SMPS PLATE'; 'plate^GT400' -> 'plate'."""
    n = (name or '').split('/')[-1].split('^')[0]
    return re.sub(r'-\d+$', '', n).strip()


# ------------------------------------------------------------------------------------------------ geometry from faces
def cylinder_of(face):
    """(origin mm, unit axis, diameter mm) of a cylindrical face, or None."""
    try:
        surf = face.GetSurface()
        if not surf or not surf.IsCylinder():
            return None
        p = seq(surf.CylinderParams)
        if len(p) < 7:
            return None
        return [p[0] * M, p[1] * M, p[2] * M], norm([p[3], p[4], p[5]]), p[6] * 2 * M
    except Exception:
        return None


def axial_span(face, origin, axis):
    """[t_min, t_max] of the face's edge end points projected on the axis (mm)."""
    ts = []
    try:
        for e in seq(face.GetEdges()):
            cp = seq(e.GetCurveParams2())
            for i in (0, 3):
                if len(cp) >= i + 3:
                    p = [cp[i] * M, cp[i + 1] * M, cp[i + 2] * M]
                    ts.append(dist_to_line(p, origin, axis)[1])
    except Exception:
        pass
    if not ts:
        try:
            b = seq(face.GetBox())
            for x in (b[0], b[3]):
                for y in (b[1], b[4]):
                    for z in (b[2], b[5]):
                        ts.append(dist_to_line([x * M, y * M, z * M], origin, axis)[1])
        except Exception:
            return None
    return [min(ts), max(ts)]


def group_cylinders(faces):
    """Faces of one feature -> distinct bores: same axis line and diameter, overlapping spans merged."""
    bores = []
    for f in faces:
        c = cylinder_of(f)
        if not c:
            continue
        o, a, d = c
        span = axial_span(f, o, a)
        if not span:
            continue
        for b in bores:
            if abs(b['diameter'] - d) < .02 and abs(sum(a[i] * b['axis'][i] for i in range(3))) > .9999 and dist_to_line(o, b['origin'], b['axis'])[0] < .02:
                lo, hi = dist_to_line([o[i] + a[i] * span[0] for i in range(3)], b['origin'], b['axis'])[1], dist_to_line([o[i] + a[i] * span[1] for i in range(3)], b['origin'], b['axis'])[1]
                b['span'] = [min(b['span'][0], lo, hi), max(b['span'][1], lo, hi)]
                break
        else:
            bores.append({'origin': o, 'axis': a, 'diameter': d, 'span': span})
    return bores


def sketch_points(feat):
    """Hole positions from the feature's placement sketch, in part coordinates (mm)."""
    pts = []
    try:
        sub = feat.GetFirstSubFeature()
        while sub:
            if sub.GetTypeName2() in SKETCH_TYPES:
                sk = sub.GetSpecificFeature2()
                xf = None
                try:
                    if not sk.Is3D():
                        xf = seq(sk.ModelToSketchTransform.Inverse().ArrayData)
                except Exception:
                    xf = None
                m = sw_matrix(xf) if xf else None
                for sp in seq(sk.GetSketchPoints2()):
                    p = [sp.X * M, sp.Y * M, sp.Z * M]  # sketch space (3D sketches are already in part space)
                    pts.append(apply_matrix(m, p) if m else p)
            sub = sub.GetNextSubFeature()
    except Exception:
        pass
    return pts


def entry_for(bore, points):
    """Entry point + direction into the material for a bore: the sketch point on its axis if there is one,
    otherwise the end of the span (any point on the axis inside the bore links correctly in Forge)."""
    o, a, (lo, hi) = bore['origin'], bore['axis'], bore['span']
    for p in points:
        off, t = dist_to_line(p, o, a)
        if off < .05 and lo - .5 <= t <= hi + .5:
            mid = (lo + hi) / 2
            d = a if mid >= t else [-x for x in a]
            return [round(x, 4) for x in p], [round(x, 6) for x in d], True
    p = [o[i] + a[i] * hi for i in range(3)]
    return [round(x, 4) for x in p], [round(-x, 6) for x in a], False


# ------------------------------------------------------------------------------------------------ feature readers
def thread_text(size, name):
    """'M5x0.8' from the Hole Wizard fastener size, else from the feature name ('M5 Tapped Hole1')."""
    for s in (size or '', name or ''):
        m = THREAD_RE.search(s)
        if m:
            return m.group(1).replace(' ', '')
    return ''


def read_hole_wizard(feat, warnings):
    """One Hole Wizard feature -> list of hole dicts (one per bore it created)."""
    name = get(feat, 'Name', '')
    d = feat.GetDefinition()
    if d is None:
        warnings.append(f'{name}: no feature data')
        return []
    try:
        d.AccessSelections(None, None)
    except Exception:
        pass
    try:
        size = str(get(d, 'FastenerSize', '') or '')
        diameter = (get(d, 'Diameter', 0) or 0) * M
        depth = (get(d, 'Depth', 0) or 0) * M
        end = get(d, 'EndCondition', None)
        thread_depth = (get(d, 'ThreadDepth', 0) or 0) * M
        thread_end = get(d, 'ThreadEndCondition', None)
        cb_d = (get(d, 'CounterBoreDiameter', 0) or 0) * M
        cb_h = (get(d, 'CounterBoreDepth', 0) or 0) * M
        cs_d = (get(d, 'CounterSinkDiameter', 0) or 0) * M
        cs_a = get(d, 'CounterSinkAngle', 0) or 0
        hole_type = get(d, 'Type', None)
        standard = get(d, 'Standard', None)
        fastener_type = get(d, 'FastenerType', None)
    finally:
        try:
            d.ReleaseSelectionAccess()
        except Exception:
            pass
    low = name.lower()
    threaded = thread_depth > 1e-6 or ('x' in size.lower() and size.lower().startswith('m')) or 'tap' in low or 'thread' in low
    if cb_d > 1e-6 and not threaded:
        kind = 'counterbore'
    elif cs_d > 1e-6 and not threaded:
        kind = 'countersink'
    elif threaded:
        kind = 'tap'
    elif 'dowel' in low:
        kind = 'dowel'
    elif size:
        kind = 'clearance'
    else:
        kind = 'simple'
    through = end == SW_END_THROUGH_ALL
    thread = thread_text(size, name) if threaded else ''
    if threaded and not thread:
        warnings.append(f'{name}: tapped hole without a readable thread size (FastenerSize={size!r}); exported as a plain hole')
        kind = 'simple'
    thread_through = bool(threaded and (thread_end == SW_END_THROUGH_ALL or (through and thread_depth >= depth - 1e-3)))
    faces = seq(feat.GetFaces())
    bores = group_cylinders(faces)
    pts = sketch_points(feat)
    out = []
    # the hole's own bore is the one at the Hole Wizard diameter; counterbore / countersink faces are wider
    target = diameter if diameter > 1e-6 else (min(b['diameter'] for b in bores) if bores else 0)
    for b in bores:
        if abs(b['diameter'] - target) > max(.05, .01 * target):
            continue
        point, direction, exact = entry_for(b, pts)
        span = b['span'][1] - b['span'][0]
        out.append({'feature': name, 'kind': kind, 'standard': str(standard) if standard is not None else '', 'fastener': size, 'thread': thread or None,
                    'thread_class': '', 'thread_depth': round(thread_depth, 3) if threaded and thread_depth > 0 else None, 'thread_through': thread_through,
                    'diameter': round(b['diameter'], 4), 'depth': round(depth if depth > 0 else span, 3), 'through': through,
                    'counterbore': {'diameter': round(cb_d, 3), 'depth': round(cb_h, 3)} if cb_d > 1e-6 else None,
                    'countersink': {'diameter': round(cs_d, 3), 'angle': round(math.degrees(cs_a) if cs_a < 7 else cs_a, 2)} if cs_d > 1e-6 else None,
                    'point': point, 'direction': direction, 'face': None,
                    'cad': {'type': hole_type, 'standard': standard, 'fastener_type': fastener_type, 'entry_from_sketch': exact}})
    if not out:
        warnings.append(f'{name}: no cylindrical bore found for the Hole Wizard feature (diameter {diameter:.2f} mm)')
    return out


def read_cosmetic_thread(feat, warnings):
    """Cosmetic thread on a plain bore -> hole dict with kind cosmetic_thread."""
    name = get(feat, 'Name', '')
    d = feat.GetDefinition()
    size = str(get(d, 'Size', '') or get(d, 'ThreadSize', '') or '') if d else ''
    length = (get(d, 'ThreadLength', 0) or 0) * M if d else 0
    end = get(d, 'EndCondition', None) if d else None
    dia = (get(d, 'Diameter', 0) or 0) * M if d else 0
    thread = thread_text(size, name)
    faces = seq(feat.GetFaces())
    if not faces and d is not None:
        try:
            edge = get(d, 'Edge', None) or (d.GetEdge() if hasattr(d, 'GetEdge') else None)
            if edge:
                faces = seq(edge.GetTwoAdjacentFaces2())
        except Exception:
            pass
    bores = [b for b in group_cylinders(faces) if dia <= 1e-6 or abs(b['diameter'] - dia) < 1.0 or b['diameter'] < dia]
    if not thread:
        warnings.append(f'{name}: cosmetic thread without a readable size')
        return []
    if not bores:
        warnings.append(f'{name}: cosmetic thread with no cylindrical bore to attach to')
        return []
    out = []
    for b in bores:
        point, direction, _ = entry_for(b, [])
        out.append({'feature': name, 'kind': 'cosmetic_thread', 'standard': '', 'fastener': size, 'thread': thread, 'thread_class': '',
                    'thread_depth': round(length, 3) if length > 0 else None, 'thread_through': end == SW_END_THROUGH_ALL,
                    'diameter': round(b['diameter'], 4), 'depth': round(b['span'][1] - b['span'][0], 3), 'through': end == SW_END_THROUGH_ALL,
                    'counterbore': None, 'countersink': None, 'point': point, 'direction': direction, 'face': None, 'cad': {'entry_from_sketch': False}})
    return out


def read_pattern(feat, seeds, warnings):
    """Pattern / mirror of Hole Wizard holes: the pattern's own bores at a seed's diameter inherit that seed's spec."""
    name = get(feat, 'Name', '')
    d = feat.GetDefinition()
    seed_feats = []
    try:
        seed_feats = seq(d.PatternFeatureArray) if d is not None else []
    except Exception:
        try:
            seed_feats = seq(d.GetPatternFeatureArray())
        except Exception:
            seed_feats = []
    specs = []
    for sf in seed_feats:
        key = get(sf, 'Name', '')
        specs.extend(seeds.get(key, []))
    if not specs:
        return []
    out = []
    for b in group_cylinders(seq(feat.GetFaces())):
        spec = next((s for s in specs if abs(s['diameter'] - b['diameter']) < max(.05, .01 * b['diameter'])), None)
        if not spec:
            continue
        point, direction, _ = entry_for(b, [])
        h = dict(spec)
        h.update({'feature': f"{name} ({spec['feature']})", 'point': point, 'direction': direction, 'depth': round(b['span'][1] - b['span'][0], 3), 'cad': {**(spec.get('cad') or {}), 'pattern': name, 'entry_from_sketch': False}})
        out.append(h)
    return out


def read_sheet_metal(model, warnings):
    """Sheet-metal parameters and bends from the feature tree (None for non sheet-metal parts)."""
    sm = None
    bends = []
    flat = False
    feat = model.FirstFeature()
    while feat:
        t = get(feat, 'GetTypeName2', '')
        if t == 'SheetMetal' and sm is None:
            d = feat.GetDefinition()
            if d is not None:
                bt = SW_BEND_ALLOWANCE.get(get(d, 'BendAllowanceType', 1), 'k_factor')
                sm = {'thickness': round((get(d, 'Thickness', 0) or 0) * M, 4), 'bend_radius': round((get(d, 'BendRadius', 0) or 0) * M, 4), 'k_factor': None, 'bend_allowance': None, 'bend_deduction': None, 'flat_pattern': False, 'flat_size': None, 'bends': []}
                if bt == 'k_factor':
                    sm['k_factor'] = round(float(get(d, 'KFactor', 0) or 0), 4) or None
                elif bt == 'allowance':
                    sm['bend_allowance'] = round((get(d, 'BendAllowance', 0) or 0) * M, 4)
                elif bt == 'deduction':
                    sm['bend_deduction'] = round((get(d, 'BendDeduction', 0) or 0) * M, 4)
                else:
                    warnings.append(f'{get(feat, "Name", "")}: bend allowance by {bt}; no K-factor exported')
        elif t == 'FlatPattern':
            flat = True
        sub = feat.GetFirstSubFeature()
        while sub:
            if get(sub, 'GetTypeName2', '') == 'OneBend':
                d = sub.GetDefinition()
                if d is not None:
                    bends.append({'feature': get(sub, 'Name', ''), 'angle': round(math.degrees(get(d, 'BendAngle', 0) or 0), 3), 'radius': round((get(d, 'BendRadius', 0) or 0) * M, 4), 'direction': None,
                                  'k_factor': round(float(get(d, 'KFactor', 0) or 0), 4) or None})
            sub = sub.GetNextSubFeature()
        feat = feat.GetNextFeature()
    if sm:
        sm['bends'] = bends
        sm['flat_pattern'] = flat
    return sm


def read_properties(model, config):
    props = {}
    for cfg in ('', config or ''):
        try:
            cpm = model.Extension.CustomPropertyManager(cfg)
            for n in seq(cpm.GetNames()):
                try:
                    v = cpm.Get(n)
                except Exception:
                    v = None
                if v not in (None, ''):
                    props[str(n)] = str(v)
        except Exception:
            pass
    return props


def read_material(model):
    part = cast(model, 'IPartDoc')
    for getter in (lambda: part.MaterialIdName, lambda: model.MaterialIdName):
        try:
            v = getter()
            if v:
                return str(v).split('|')[-1].strip()
        except Exception:
            pass
    try:
        v = part.GetMaterialPropertyName2('', byref_str())
        v = v[0] if isinstance(v, tuple) else v
        if v:
            return str(v).strip()
    except Exception:
        pass
    return ''


def read_part(model, config, warnings, probe=None):
    """Everything the package needs from one open part document."""
    part = cast(model, 'IPartDoc')
    title = str(get(model, 'GetTitle', '') or '')
    path = str(get(model, 'GetPathName', '') or '')
    out = {'name': re.sub(r'\.sldprt$', '', title, flags=re.I).strip() or os.path.splitext(os.path.basename(path))[0], 'file': os.path.basename(path), 'configuration': config or '',
           'holes': [], 'welds': [], 'sheet_metal': None, 'material': read_material(model), 'properties': read_properties(model, config), 'density': None, 'mass_kg': None, 'volume_mm3': None, 'bbox': None, 'bodies': 0}
    out['part_number'] = next((v for k, v in out['properties'].items() if k.lower().replace(' ', '') in ('partnumber', 'partno', 'pn', 'number', 'drawingno', 'drawingnumber')), '')
    out['description'] = next((v for k, v in out['properties'].items() if k.lower() == 'description'), '')
    out['revision'] = next((v for k, v in out['properties'].items() if k.lower() in ('revision', 'rev')), '')
    try:
        mp = model.Extension.CreateMassProperty()
        out['mass_kg'] = round(float(mp.Mass), 6)
        out['volume_mm3'] = round(float(mp.Volume) * M ** 3, 3)
        out['density'] = round(float(mp.Density) / 1000.0, 4)
    except Exception as e:
        warnings.append(f'{out["name"]}: mass properties unavailable ({e})')
    try:
        b = seq(part.GetPartBox(True))
        out['bbox'] = [round(abs(b[3] - b[0]) * M, 4), round(abs(b[4] - b[1]) * M, 4), round(abs(b[5] - b[2]) * M, 4)]
        out['bbox_min'] = [round(min(b[0], b[3]) * M, 4), round(min(b[1], b[4]) * M, 4), round(min(b[2], b[5]) * M, 4)]
    except Exception:
        pass
    try:
        out['bodies'] = len(seq(part.GetBodies2(SW_BODY_SOLID, True)))
    except Exception:
        pass
    seeds = {}
    feat = model.FirstFeature()
    n = 0
    while feat:
        t = get(feat, 'GetTypeName2', '')
        name = get(feat, 'Name', '')
        if probe is not None:
            probe.append((name, t))
        try:
            if get(feat, 'IsSuppressed', False):
                pass
            elif t == 'HoleWzd':
                hs = read_hole_wizard(feat, warnings)
                seeds[name] = hs
                out['holes'].extend(hs)
            elif t == 'CosmeticThread':
                out['holes'].extend(read_cosmetic_thread(feat, warnings))
            elif t in PATTERN_TYPES:
                out['holes'].extend(read_pattern(feat, seeds, warnings))
            elif t == 'Thread':
                warnings.append(f'{out["name"]} / {name}: modelled Thread features are not exported yet; use a Hole Wizard tapped hole or a cosmetic thread')
            elif t == 'WeldBead' or t.lower().startswith('weld'):
                out['welds'].append({'feature': name, 'type': t, 'size': None, 'length': None})
        except Exception as e:
            warnings.append(f'{out["name"]} / {name}: {e}')
        feat = feat.GetNextFeature()
        n += 1
        if n > 20000:
            break
    for i, h in enumerate(out['holes'], 1):
        h['id'] = f'h{i}'
    try:
        out['sheet_metal'] = read_sheet_metal(model, warnings)
    except Exception as e:
        warnings.append(f'{out["name"]}: sheet metal data unavailable ({e})')
    return out


# ------------------------------------------------------------------------------------------------ assembly
def classify_library_part(name, description, is_toolbox):
    """Toolbox fastener or press-in insert from the component's names; None for ordinary parts."""
    text = f'{name} {description}'
    low = text.lower()
    for pat, kind in INSERT_PATTERNS:
        if re.search(pat, text if pat.startswith(r'\b(?:') else low, re.I):
            th = NOMINAL_RE.search(text)
            pn = PN_RE.search(text.upper())
            return {'role': 'insert', 'type': kind, 'thread': th.group(1).replace(' ', '') if th else '', 'pn': pn.group(1) if pn else '', 'name': (description or name)[:200]}
    if is_toolbox or re.search(r'\b(iso|din|ansi|asme)\s?\d{3,5}\b', low) or any(w in low for w in ('screw', 'bolt', 'washer', 'rivet', 'hex nut', 'lock nut', 'nyloc', 'dowel pin')):
        kind = next((k for w, k in FASTENER_WORDS if w in low), 'other')
        std = STANDARD_RE.search(text)
        th = NOMINAL_RE.search(text)
        ln = LENGTH_RE.search(text)
        return {'role': 'fastener', 'kind': kind, 'standard': std.group(1).upper().replace('  ', ' ') if std else '', 'size': th.group(1).replace(' ', '') if th else '',
                'length': float(ln.group(1)) if ln else None, 'name': (description or name)[:200]}
    return None


def walk_assembly(app, model, warnings, probe=None):
    """Flat component list with root placements; one package part per (part file, configuration)."""
    asm = cast(model, 'IAssemblyDoc')
    try:
        asm.ResolveAllLightWeightComponents(False)
    except Exception:
        pass
    root = model.ConfigurationManager.ActiveConfiguration.GetRootComponent3(True)
    parts, components, fasteners, inserts = {}, [], [], []
    counter = [0]

    def visit(comp, path):
        counter[0] += 1
        cname = str(get(comp, 'Name2', '') or '')
        here = path + [cname]
        suppressed = bool(get(comp, 'IsSuppressed', False))
        children = seq(comp.GetChildren()) if not suppressed else []
        doc = None if suppressed else comp.GetModelDoc2()
        if children or (doc is not None and get(doc, 'GetType', 0) == SW_DOC_ASSEMBLY):
            for ch in children:
                visit(ch, here)
            return
        pathname = str(get(comp, 'GetPathName', '') or '')
        config = str(get(comp, 'ReferencedConfiguration', '') or '')
        key = (pathname.lower(), config)
        if doc is None and not suppressed:
            warnings.append(f'{" / ".join(here)}: component not loaded (lightweight or missing file); geometry only')
        try:
            T = sw_matrix(seq(comp.Transform2.ArrayData))
        except Exception:
            T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        if key not in parts:
            pid = slug(f'{os.path.splitext(os.path.basename(pathname))[0]}' + (f'-{config}' if config and config.lower() not in ('default', 'standard') else ''))
            base = pid
            k = 2
            while any(p['id'] == pid for p in parts.values()):
                pid = f'{base}-{k}'
                k += 1
            entry = {'id': pid, 'data': None, 'library': None}
            if doc is not None:
                try:
                    is_toolbox = bool(get(doc.Extension, 'ToolboxPartType', 0))
                except Exception:
                    is_toolbox = False
                props = read_properties(doc, config)
                desc = props.get('Description') or props.get('DESCRIPTION') or ''
                entry['library'] = classify_library_part(f'{os.path.basename(pathname)} {config}', desc, is_toolbox)
                if entry['library'] is None:
                    entry['data'] = read_part(doc, config, warnings, probe)
                    entry['data']['id'] = pid
                    entry['data']['step_names'] = [os.path.splitext(os.path.basename(pathname))[0], clean_component_name(cname)]
            parts[key] = entry
        entry = parts[key]
        lib = entry['library']
        if lib and lib['role'] == 'fastener':
            fasteners.append({'id': f'f{len(fasteners) + 1}', 'kind': lib['kind'], 'standard': lib['standard'], 'size': lib['size'], 'length': lib['length'], 'name': lib['name'], 'path': ' / '.join(here), 'transform': T})
        elif lib and lib['role'] == 'insert':
            inserts.append({'id': f'i{len(inserts) + 1}', 'type': lib['type'], 'thread': lib['thread'], 'pn': lib['pn'], 'name': lib['name'], 'host': None, 'path': ' / '.join(here), 'transform': T, 'axis': norm([T[2], T[6], T[10]])})
        elif entry['data'] is not None:
            components.append({'id': f'c{len(components) + 1}', 'part': entry['id'], 'name': clean_component_name(cname), 'instance': cname, 'path': ' / '.join(here), 'configuration': config, 'transform': T,
                               'suppressed': suppressed, 'exclude_from_bom': bool(get(comp, 'ExcludeFromBOM', False)), 'virtual': bool(get(comp, 'IsVirtual', False)), 'fixed': bool(get(comp, 'IsFixed', False)), 'mirrored': mirrored(T)})

    for ch in seq(root.GetChildren()):
        visit(ch, [str(get(model, 'GetTitle', '') or 'assembly')])
    for ins in inserts:
        ins['host'] = host_for(ins, components, {e['id']: e['data'] for e in parts.values() if e['data']})
    return [e['data'] for e in parts.values() if e['data']], components, fasteners, inserts


def host_for(ins, components, part_data):
    """The package part whose bounding box (placed in root coordinates) contains the insert origin, when exactly
    one does; Forge then only looks for the insert's hole in that part."""
    o = ins['transform'][3], ins['transform'][7], ins['transform'][11]
    hits = []
    for c in components:
        pd = part_data.get(c['part'])
        if not pd or not pd.get('bbox') or not pd.get('bbox_min'):
            continue
        T = c['transform']  # rigid: inverse rotation is the transpose
        r = [[T[0], T[1], T[2]], [T[4], T[5], T[6]], [T[8], T[9], T[10]]]
        v = [o[0] - T[3], o[1] - T[7], o[2] - T[11]]
        lp = [sum(r[j][i] * v[j] for j in range(3)) for i in range(3)]
        lo, size = pd['bbox_min'], pd['bbox']
        if all(lo[i] - 2 <= lp[i] <= lo[i] + size[i] + 2 for i in range(3)):
            hits.append(c['part'])
    hits = sorted(set(hits))
    return hits[0] if len(hits) == 1 else None


# ------------------------------------------------------------------------------------------------ STEP + package
def export_step(app, model, path, warnings):
    try:
        app.SetUserPreferenceIntegerValue(SW_STEP_AP_PREF, 214)
    except Exception as e:
        warnings.append(f'could not set STEP AP214 export preference ({e}); the SolidWorks default applies')
    try:
        r = model.Extension.SaveAs3(path, SW_SAVE_CURRENT_VERSION, SW_SAVE_SILENT, None, None, byref_int(), byref_int())
        ok = r[0] if isinstance(r, tuple) else r
    except Exception:
        try:
            ok = model.SaveAs(path)
        except Exception as e:
            raise SystemExit(f'STEP export failed: {e}')
    if not ok or not os.path.exists(path) or os.path.getsize(path) < 100:
        raise SystemExit('STEP export failed (SolidWorks returned an error); check that the document is saved and fully resolved')


def write_package(out, step_path, source_file, kind, parts, assembly, warnings, sw_version):
    with open(step_path, 'rb') as fh:
        sha = hashlib.sha256()
        while chunk := fh.read(1 << 20):
            sha.update(chunk)
    manifest = {'schema': SCHEMA, 'generator': {'name': 'forge-solidworks-exporter', 'version': VERSION}, 'source': {'cad': 'SolidWorks', 'version': sw_version, 'file': os.path.basename(source_file), 'kind': kind},
                'created': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'units': 'mm', 'model': {'path': 'model.step', 'format': 'step-ap214', 'sha256': sha.hexdigest()},
                'root': (assembly or {}).get('name') or (parts[0]['id'] if parts else ''), 'warnings': warnings[:200]}
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('manifest.json', json.dumps(manifest, indent=1))
        z.write(step_path, 'model.step')
        for p in parts:
            z.writestr(f'parts/{p["id"]}.json', json.dumps(p))
        if assembly is not None:
            z.writestr('assembly.json', json.dumps(assembly))


def load_config(script_dir, path=None):
    """forge-export.json next to the script (or --config): {"url", "project", "email", "password", "notes"} for
    automatic upload after the export. Missing file -> {}."""
    p = path or os.path.join(script_dir, 'forge-export.json')
    if not os.path.exists(p):
        return {}
    try:
        with open(p, encoding='utf-8') as fh:
            cfg = json.load(fh)
        return cfg if isinstance(cfg, dict) else {}
    except (OSError, ValueError) as e:
        print(f'  ! {p}: not readable ({e}); no automatic upload')
        return {}


def main():
    ap = argparse.ArgumentParser(description='Export a SolidWorks part or assembly as a Forge package (.forge).')
    ap.add_argument('file', nargs='?', help='.SLDPRT or .SLDASM (omit to export the document active in SolidWorks)')
    ap.add_argument('--out', help='output .forge path (default: next to the model)')
    ap.add_argument('--probe', action='store_true', help='list the features and components found; write nothing')
    ap.add_argument('--keep-open', action='store_true', help='leave the document open in SolidWorks afterwards')
    ap.add_argument('--late', action='store_true', help='skip makepy early binding (if EnsureDispatch fails or is too slow)')
    ap.add_argument('--from-macro', action='store_true', help='launched by the SolidWorks macro: keep the document open, show the result, wait before closing the console')
    ap.add_argument('--config', help='forge-export.json with url/project/email/password for automatic upload (default: next to this script)')
    ap.add_argument('--push', help='Forge base URL to upload to (overrides the config file)')
    ap.add_argument('--project', help='Forge project id or name for the upload')
    ap.add_argument('--email')
    ap.add_argument('--password')
    ap.add_argument('--notes', default='')
    a = ap.parse_args()
    try:
        run(a)
    except SystemExit as e:
        if e.code not in (None, 0):
            print(f'\n  ! {e.code}')
        if a.from_macro:
            input('\nPress Enter to close this window.')
        raise
    except Exception as e:
        print(f'\n  ! export failed: {e}')
        if a.from_macro:
            input('\nPress Enter to close this window.')
        raise


def run(a):
    app, early = connect(a.late)
    sw_version = ''
    try:
        v = app.RevisionNumber()
        sw_version = f'{int(v.split(".")[0]) + 1992}' if v else ''  # SolidWorks 2024 reports 32.x
    except Exception:
        pass
    warnings = []
    model = None
    if a.file:
        src = os.path.abspath(a.file)
        if not os.path.exists(src):
            sys.exit(f'{src} not found')
    else:
        # the document active in SolidWorks (what the macro button exports)
        model = app.ActiveDoc
        if model is None:
            sys.exit('No document is open in SolidWorks; open the part or assembly to export')
        src = str(get(model, 'GetPathName', '') or '')
        if not src:
            sys.exit('Save the document first; the exporter works from the saved file')
        if get(model, 'GetSaveFlag', False):
            warnings.append('the document has unsaved changes; the package reflects the state on screen, the STEP the rebuilt model')
    ext = os.path.splitext(src)[1].lower()
    if ext not in ('.sldprt', '.sldasm'):
        sys.exit('Give a .SLDPRT or .SLDASM file (drawings cannot be exported)')
    kind = 'part' if ext == '.sldprt' else 'assembly'
    doc_type = SW_DOC_PART if kind == 'part' else SW_DOC_ASSEMBLY
    if model is None:
        try:
            model = first(app.OpenDoc6(src, doc_type, SW_OPEN_SILENT, '', byref_int(), byref_int()))
        except Exception:
            model = app.OpenDoc(src, doc_type)
    if model is None:
        sys.exit('SolidWorks could not open the document')
    try:
        model.ForceRebuild3(False)
    except Exception:
        pass
    keep_open = a.keep_open or a.from_macro or not a.file
    probe = [] if a.probe else None
    if kind == 'part':
        config = str(get(model.ConfigurationManager.ActiveConfiguration, 'Name', '') or '')
        p = read_part(model, config, warnings, probe)
        p['id'] = slug(p['name'])
        p['step_names'] = [p['name']]
        parts, assembly = [p], None
    else:
        parts, components, fasteners, inserts = walk_assembly(app, model, warnings, probe)
        assembly = {'name': re.sub(r'\.sldasm$', '', str(get(model, 'GetTitle', '') or ''), flags=re.I), 'configuration': str(get(model.ConfigurationManager.ActiveConfiguration, 'Name', '') or ''),
                    'components': components, 'fasteners': fasteners, 'inserts': inserts}
    n_holes = sum(len(p['holes']) for p in parts)
    n_thr = sum(1 for p in parts for h in p['holes'] if h['kind'] in ('tap', 'cosmetic_thread', 'thread'))
    print(f'{kind}: {len(parts)} part definition(s), {n_holes} hole(s) of which {n_thr} threaded, {sum(1 for p in parts if p["sheet_metal"])} sheet-metal part(s)'
          + (f', {len(assembly["components"])} placements, {len(assembly["fasteners"])} fasteners, {len(assembly["inserts"])} inserts' if assembly else ''))
    if a.probe:
        seen = {}
        for name, t in probe or []:
            seen[t] = seen.get(t, 0) + 1
        for t, c in sorted(seen.items(), key=lambda kv: -kv[1]):
            print(f'  {c:5d}  {t}')
        for p in parts:
            for h in p['holes']:
                print(f"  {p['name']}: {h['feature']} -> {h['kind']} {h['thread'] or ''} Ø{h['diameter']:.2f} at {h['point']} {'(sketch)' if h['cad'].get('entry_from_sketch') else '(axis)'}")
        for w in warnings:
            print('  !', w)
        if a.from_macro:
            input('\nPress Enter to close this window.')
        return
    out = a.out or os.path.splitext(src)[0] + '.forge'
    tmpdir = tempfile.mkdtemp(prefix='forge-')
    step_path = os.path.join(tmpdir, 'model.step')
    export_step(app, model, step_path, warnings)
    write_package(out, step_path, src, kind, parts, assembly, warnings, sw_version)
    try:
        os.remove(step_path)
        os.rmdir(tmpdir)
    except OSError:
        pass
    if not keep_open:
        try:
            app.CloseDoc(model.GetTitle())
        except Exception:
            pass
    for w in warnings:
        print('  !', w)
    print(f'wrote {out} ({os.path.getsize(out) / 1e6:.1f} MB)')
    cfg = load_config(os.path.dirname(os.path.abspath(__file__)), a.config)
    base = (a.push or cfg.get('url') or '').rstrip('/')
    pushed = False
    if base:
        try:
            push(base, a.project or cfg.get('project'), a.email or cfg.get('email'), a.password or cfg.get('password'), out, a.notes or cfg.get('notes', ''))
            pushed = True
        except Exception as e:
            print(f'  ! upload to {base} failed: {e}\n    the package is at {out}; upload it in Forge (New revision)')
    if a.from_macro and not pushed and os.name == 'nt':
        try:
            import subprocess
            subprocess.Popen(['explorer', '/select,', out])  # show the file so it can be dragged into Forge
        except Exception:
            pass
    if a.from_macro:
        input('\nDone. Press Enter to close this window.')


def push(base, project, email, password, path, notes):
    """Upload the package through Forge's chunked upload API (local login; Entra-only workspaces upload in the
    browser). ``project`` is the project id or its name."""
    import urllib.request
    import http.cookiejar
    if not (project and email and password):
        sys.exit('uploading needs the project, email and password (command line or forge-export.json)')
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def call(method, url, data=None, headers=None, raw=None):
        body = raw if raw is not None else (json.dumps(data).encode() if data is not None else None)
        req = urllib.request.Request(base + url, data=body, method=method, headers={'X-Forge-Request': '1', **({'Content-Type': 'application/json'} if data is not None else {}), **(headers or {})})
        with opener.open(req) as r:
            t = r.read()
            return json.loads(t) if t else {}
    call('POST', '/api/auth/login', {'email': email, 'password': password})
    if not re.fullmatch(r'[0-9a-f]{32}', str(project)):
        matches = [p for p in call('GET', '/api/projects') if str(p.get('name', '')).strip().lower() == str(project).strip().lower()]
        if len(matches) != 1:
            sys.exit(f'project "{project}" {"not found" if not matches else "is ambiguous"} in {base}; use the project id')
        project = matches[0]['id']
    size = os.path.getsize(path)
    start = call('POST', f'/api/projects/{project}/uploads', {'filename': os.path.basename(path), 'size': size, 'notes': notes})
    with open(path, 'rb') as fh:
        for i in range(start['chunks']):
            call('PUT', f'/api/uploads/{start["upload_id"]}/chunks/{i}', raw=fh.read(start['chunk_size']), headers={'Content-Type': 'application/octet-stream'})
    rev = call('POST', f'/api/uploads/{start["upload_id"]}/complete')
    print(f'uploaded to {base} as revision {rev.get("number")}; Forge is analysing it')


if __name__ == '__main__':
    main()
