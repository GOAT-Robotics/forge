"""GOAT-template manufacturing drawings.

One drafting model in paper millimetres (origin bottom-left, y up) is rendered twice:
  * PDF via reportlab (vendor drawing), and
  * an editable DXF: the same sheet 1:1 with real ORDINATE DIMENSION entities (DIMLFAC = 1/scale, so they
    measure true size), MTEXT hole callouts, and the title block as plain TEXT on its own layer.

Sheet template, line weights (0.25 visible / 0.18 thin), arrowheads (3.3 x 1.0 filled), ordinate style
(baseline 3 mm off the part, origin circle, 90-degree rotated values, jogged when crowded) and the title
block are taken from the GOAT SolidWorks A4 template.

Machined parts: third-angle views chosen from where the holes enter, ordinate dimensions for hole centres and
step edges, grouped hole callouts (count, diameter, depth/THRU, counterbore/countersink, thread), chamfer and
radius notes, isometric. Sheet metal (laser cut): no hole locations or callouts; overall and flange ordinates,
bend lines and table on a flat-pattern sheet.
"""
import math, re, datetime
from pathlib import Path
import numpy as np
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.units import mm
from OCP.gp import gp_Pnt, gp_Dir, gp_Ax2
from OCP.HLRBRep import HLRBRep_Algo, HLRBRep_HLRToShape
from OCP.HLRAlgo import HLRAlgo_Projector
from OCP.TopAbs import TopAbs_FACE, TopAbs_EDGE, TopAbs_REVERSED, TopAbs_OUT
from OCP.TopoDS import TopoDS
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.GeomAbs import GeomAbs_Plane, GeomAbs_Cylinder, GeomAbs_Cone
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from .cad import explore, sample_edge, props, bounds, xyz

from .fonts import FONT_DIR, DIM_FONT  # registers the dimension font
from . import pictorials as pictorial_defs
CAP = {'ForgeDim': 0.700, 'Helvetica': 0.718, 'Helvetica-Bold': 0.718, 'Helvetica-BoldOblique': 0.718}

THICK, THIN = 0.25, 0.18          # visible / thin (dims, hidden, title block rules)
ARROW_L, ARROW_W = 2.5, 0.83      # filled arrowhead (3:1)
DIM_H = 1.8                       # cap height of dimension / callout text (ISO 3098 h = 1.8 mm, smallest standard height)
TAG_H = 1.8                       # hole-table tag letters in the views
TB_SIZE = 2.82                    # title block font size (Arial 8 pt in the template)
DEPTH, CSK, CBORE = '↧', '⌵', '⌴'
SYMBOLS = (DEPTH, CSK, CBORE)
# Thread class / size is manufacturing intent: only printed when entered as a feature designation (or in the
# drawing editor). Set True to print ISO coarse sizes guessed from tap-drill diameters.
INFER_THREADS = False
DEBUG_LAYOUT = False
HOLE_TABLE_MIN = 8   # more holes than this in one view -> tagged hole table instead of per-hole ordinates
HIDDEN_DASH = (1.6, 0.8)
PHANTOM_DASH = (6.0, 1.0, 1.0, 1.0)
SCALES = [5, 4, 3, 2, 1.5, 1, 1 / 1.5, 1 / 2, 1 / 2.5, 1 / 3, 1 / 4, 1 / 5, 1 / 7.5, 1 / 10, 1 / 15, 1 / 20, 1 / 25, 1 / 30, 1 / 40, 1 / 50, 1 / 75, 1 / 100]
SHEETS = {'A4': (297.0, 210.0, 6), 'A3': (420.0, 297.0, 8), 'A2': (594.0, 420.0, 12)}
# ISO metric coarse tap drills -> (designation, pitch)
TAP_DRILLS = [(1.6, 'M2', .4), (2.05, 'M2.5', .45), (2.5, 'M3', .5), (3.3, 'M4', .7), (4.2, 'M5', .8), (5.0, 'M6', 1.0),
              (6.8, 'M8', 1.25), (8.5, 'M10', 1.5), (10.2, 'M12', 1.75), (12.0, 'M14', 2.0), (14.0, 'M16', 2.0), (17.5, 'M20', 2.5)]
DEFAULT_TITLE = {'company': 'GOAT ROBOTICS PRIVATE LIMITED', 'drawn_by': '', 'checked_by': '', 'approved_by': '',
                 'tol_1dec': '± 0.1', 'tol_2dec': '± 0.05', 'tol_3dec': '± 0.02', 'hole_fit': 'H7', 'shaft_fit': 'h7',
                 'position_tol': '±0.02 mm', 'note': 'REMOVE ALL SHARP EDGES', 'module': '', 'master': '', 'surface_finish': ''}


def fmt(v):
    return '0' if abs(v) < 0.005 else f'{v:.2f}'


def scale_label(s):
    if s >= 1:
        return f'{s:g}:1'
    d = 1 / s
    return f'1:{round(d, 2):g}'


# --------------------------------------------------------------------------------------------- sheet model
class Sheet:
    """Paper-space drafting model; every primitive carries a DXF layer."""

    def __init__(self, size='A4'):
        self.size = size
        self.w, self.h, self.cols = SHEETS[size]
        self.items = []
        self.dims = []           # semantic ordinate dimensions for the DXF writer
        self.occupied = []       # rects (x0,y0,x1,y1) for label placement
        self.textrects = []      # dimension / note text: leaders must not cross these
        self.overlaps = 0.0
        self.sg = None           # current editor scene group ('view:main', 'callout:...') or None = fixed
        self.callouts = {}       # scene-group id -> callout metadata for the drawing editor
        self.view_meta = {}      # scene-group id -> extra metadata (pictorial settings) for the editor
        self.overflow = []       # pictorial views that did not fit on this sheet

    def line(self, a, b, w=THIN, layer='DIM', dash=None, grp=None):
        self.items.append({'sg': self.sg, 'k': 'poly', 'pts': [tuple(map(float, a)), tuple(map(float, b))], 'w': w, 'layer': layer, 'dash': dash, 'grp': grp, 'closed': False})

    def poly(self, pts, w=THICK, layer='VISIBLE', dash=None, closed=False, grp=None):
        self.items.append({'sg': self.sg, 'k': 'poly', 'pts': [tuple(map(float, p)) for p in pts], 'w': w, 'layer': layer, 'dash': dash, 'grp': grp, 'closed': closed})

    def circle(self, c, r, w=THIN, layer='DIM', fill=False, grp=None):
        self.items.append({'sg': self.sg, 'k': 'circle', 'c': tuple(map(float, c)), 'r': float(r), 'w': w, 'layer': layer, 'fill': fill, 'grp': grp})

    def tri(self, pts, layer='DIM', grp=None):
        self.items.append({'sg': self.sg, 'k': 'tri', 'pts': [tuple(map(float, p)) for p in pts], 'layer': layer, 'grp': grp})

    def text(self, x, y, s, size, font='Helvetica', layer='TITLE', rot=0, ha='l', grp=None, hscale=1.0):
        """(x,y) is the baseline point; ha l/c/r aligns along the text direction. size = font size in mm."""
        self.items.append({'sg': self.sg, 'k': 'text', 'x': float(x), 'y': float(y), 's': str(s), 'size': float(size), 'font': font, 'layer': layer, 'rot': rot, 'ha': ha, 'grp': grp, 'hscale': hscale})

    def arrow(self, tip, direction, layer='DIM', grp=None):
        d = np.asarray(direction, float)
        d = d / max(np.linalg.norm(d), 1e-9)
        n = np.array([-d[1], d[0]])
        tip = np.asarray(tip, float)
        base = tip - d * ARROW_L
        self.tri([tip, base + n * ARROW_W / 2, base - n * ARROW_W / 2], layer, grp)

    def occupy(self, r, pad=0.0):
        self.occupied.append((r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad))


def text_width(s, size, font):
    """Width in mm of a text run at font size `size` mm, drafting symbols included."""
    total = 0.0
    run = ''
    for ch in s:
        if ch in SYMBOLS:
            total += pdfmetrics.stringWidth(run, font, size) + sym_width(size, font)
            run = ''
        else:
            run += ch
    return total + pdfmetrics.stringWidth(run, font, size)


def sym_width(size, font):
    return CAP.get(font, .7) * size * 1.05


def dim_size():
    return DIM_H / CAP.get(DIM_FONT, .7)


# --------------------------------------------------------------------------------------------- template
def draw_template(sh, title):
    """Border, zones and title block, copied from the GOAT A4 SolidWorks template (dimensions in mm)."""
    W, H = sh.w, sh.h
    sh.poly([(1, 1), (W - 1, 1), (W - 1, H - 1), (1, H - 1)], THICK, 'FRAME', closed=True)
    x0, y0, x1, y1 = 6.0, 6.0, W - 6.0, H - 6.0
    sh.poly([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], THICK, 'FRAME', closed=True)
    cols = sh.cols
    rows = 6 if sh.size != 'A2' else 8
    cw = (x1 - x0) / cols
    rh = (y1 - y0) / rows
    zs = 4.81
    for i in range(cols):
        cx = x0 + cw * (i + .5)
        label = str(cols - i)
        for yy in (y1 + 1.2, 1.9):
            sh.text(cx, yy, label, zs, 'Helvetica', 'FRAME', ha='c', hscale=.82)
        if i:
            xx = x0 + cw * i
            sh.line((xx, y1), (xx, H - 1), THICK, 'FRAME')
            sh.line((xx, y0), (xx, 1), THICK, 'FRAME')
    letters = 'ABCDEFGH'
    for j in range(rows):
        cy = y0 + rh * (j + .5) - zs * .36
        for xx in (3.55, W - 3.45):
            sh.text(xx, cy, letters[j], zs, 'Helvetica', 'FRAME', ha='c', hscale=.82)
        if j:
            yy = y0 + rh * j
            sh.line((x1, yy), (W - 1, yy), THICK, 'FRAME')
            sh.line((x0, yy), (1, yy), THICK, 'FRAME')

    # Title block: template coordinates are top-down on A4; anchor to the bottom-right frame corner.
    ox = x1 - 284.97  # template spans x 6.00 .. 290.97
    T = lambda y: 210.0 - y  # template top-down -> y-up (block bottom sits on y=6)
    def L(xa, ya, xb, yb, w=THIN):
        sh.line((ox + xa - 6.0 + 6.0, T(ya)), (ox + xb - 6.0 + 6.0, T(yb)), w, 'TITLE')
    X = lambda x: ox + x - 6.0
    def TL(x, ytop, s, size=TB_SIZE, font='Helvetica', ha='l', maxw=None):
        hs = 1.0
        if maxw:
            wdt = text_width(s, size, font)
            hs = min(1.0, maxw / max(wdt, 1e-6))
        sh.text(X(x), T(ytop) - size * .74, s, size, font, 'TITLE', ha=ha, hscale=hs)
    # rules
    for xa, ya, xb, yb in [(6, 182.38, 290.97, 182.38), (6, 186.26, 192.44, 186.26), (243.59, 186.93, 290.97, 186.93),
                           (22.47, 191.34, 290.97, 191.34), (22.47, 195.15, 192.44, 195.15), (243.59, 195.15, 290.97, 195.15),
                           (6, 200.05, 290.97, 200.05), (22.47, 186.26, 22.47, 204), (52.49, 200.05, 52.49, 204),
                           (74.4, 191.34, 74.4, 195.15), (82.48, 195.15, 82.48, 204), (112.5, 182.38, 112.5, 204),
                           (142.49, 200.05, 142.49, 204), (162.07, 182.38, 162.07, 204), (178.51, 186.26, 178.51, 200.05),
                           (192.44, 182.38, 192.44, 204), (211.24, 191.34, 211.24, 200.05), (225.0, 191.34, 225.0, 200.05),
                           (243.59, 182.38, 243.59, 204), (270.58, 186.93, 270.58, 204)]:
        sh.line((X(xa), T(ya)), (X(xb), T(yb)), THIN, 'TITLE')
    if ox > 6.01:  # larger sheets: close the block on the left
        sh.line((X(6), T(182.38)), (X(6), T(204)), THIN, 'TITLE')
    t = title
    sh.text(X(59.25), T(186.26) + .9, t['company'], 4.23, 'Helvetica-BoldOblique', 'TITLE', ha='c')
    TL(23.77, 187.2, f"TITLE : {t['title']}", maxw=87.5)
    TL(23.6, 192.0, f"DWG NO : {t['dwg_no']}", maxw=50)
    TL(75.9, 192.0, f"VER:{t['ver']}")
    TL(23.6, 196.6, f"MODULE : {t['module']}", maxw=58)
    TL(83.05, 196.6, f"MASTER : {t['master']}", maxw=29)
    TL(23.6, 200.7, f"REV/DATE :{t['rev_date']}")
    TL(113.36, 183.3, f"MATERIAL: {t['material']}", maxw=48)
    TL(113.36, 188.0, f"TREATMENT : {t['treatment']}", maxw=48)
    TL(113.97, 192.0, f"QTY : {t['qty']}")
    TL(113.36, 196.7, 'PROJECTION :' + ('FIRST ANGLE' if title.get('projection') == 'first' else 'THIRD ANGLE'))
    TL(163.5, 183.6, 'TOLERANCES  (MM)')
    for i, (lab, val) in enumerate([('1 DEC.', t['tol_1dec']), ('2 DEC.', t['tol_2dec']), ('3 DEC.', t['tol_3dec'])]):
        yy = [187.9, 192.3, 196.6][i]
        TL(165.45, yy, lab)
        TL(180.3, yy, val)
    TL(163.5, 200.9, 'SURFACE FINISH' + (f"  {t['surface_finish']}" if t.get('surface_finish') else ''), maxw=28.5)
    TL(195.1, 183.6, 'GENERAL TOLERANCE')
    TL(195.0, 186.9, '(UNLESS OTHERWISE STATED)')
    TL(197.9, 192.4, 'For Holes')
    TL(213.5, 192.4, 'For shaft')
    TL(204.6, 197.3, t['hole_fit'], ha='c')
    TL(218.4, 197.3, t['shaft_fit'], ha='c')
    TL(193.7, 200.6, 'Diametric position tolarence ' + t['position_tol'])
    TL(244.45, 183.5, f"SHEET :      {t['sheet']}")
    TL(244.4, 187.9, f"SCALE :{t['scale']}")
    TL(280.1, 187.9, 'DATE', ha='c')
    TL(244.2, 192.0, f"DRN: {t['drawn_by']}", maxw=26)
    TL(271.9, 192.3, t['date'])
    TL(244.4, 196.2, f"CHK: {t['checked_by']}", maxw=26)
    TL(244.35, 200.6, f"APD: {t['approved_by']}", maxw=26)
    title_top = T(182.38)
    sh.occupy((X(6), 6.0, x1, title_top), 1.0)
    return title_top


def first_angle(settings):
    return ((settings or {}).get('conventions') or {}).get('projection') == 'first'


def title_values(p, rev, settings, sheet_no, sheets, scale, sheet_size='A4'):
    spec = p.get('spec', {})
    tb = dict(DEFAULT_TITLE)
    tb.update({k: v for k, v in ((settings or {}).get('drawing') or {}).items() if v not in (None,)})
    for key in ('drawn_by', 'checked_by', 'approved_by', 'module', 'master', 'surface_finish'):
        if spec.get(key):
            tb[key] = spec[key]
    if spec.get('roughness') and not tb.get('surface_finish'):
        tb['surface_finish'] = spec['roughness']
    name = clean_name(p['name'])
    num = spec.get('part_number') or part_number(name) or p['id'][:12].upper()
    treat = ' + '.join(x for x in [spec.get('finish'), spec.get('paint')] if x) or '-'
    mat = spec.get('material') or 'UNSPECIFIED'
    if p.get('category') == 'sheet_metal' and p['geometry'].get('thickness') and 'THK' not in mat.upper():
        mat += f" {p['geometry']['thickness']:.2f} THK"
    date = rev.get('release_at') or ''
    try:
        date = datetime.datetime.fromisoformat(str(date).replace('Z', '')).strftime('%d-%m-%Y') if date else datetime.date.today().strftime('%d-%m-%Y')
    except ValueError:
        date = datetime.date.today().strftime('%d-%m-%Y')
    tb['projection'] = 'first' if first_angle(settings) else 'third'
    tb.update({'title': name[:60], 'dwg_no': num, 'ver': rev.get('number', 1), 'rev_date': f" {rev.get('number', 1)}", 'material': mat[:40],
               'treatment': treat[:40], 'qty': f"{p.get('quantity', 1)}-NO", 'sheet': f'{sheet_no}  OF  {sheets}', 'scale': scale_label(scale), 'date': date})
    return tb


def clean_name(name):
    base = re.sub(r'\s*/\s*Body \d+$', '', name or '').strip()
    base = re.sub(r'\.(step|stp|sldprt)$', '', base, flags=re.I)
    return re.sub(r'\s+\d+$', '', base).strip() or base


def part_number(name):
    m = re.match(r'^([A-Z0-9]{1,6}(?:-[A-Z0-9]{1,6}){1,3}?-\d{2,5})(?=\b|-|_|\s|$)', name.upper())
    return m.group(1) if m else None


# --------------------------------------------------------------------------------------------- geometry
def hlr(shape, n, right, hidden=True):
    """Hidden-line projection on a plane with normal n (toward the viewer) and in-plane x = right."""
    algo = HLRBRep_Algo()
    algo.Add(shape)
    algo.Projector(HLRAlgo_Projector(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(*map(float, n)), gp_Dir(*map(float, right)))))
    algo.Update()
    algo.Hide()
    h = HLRBRep_HLRToShape(algo)
    out = {}
    for key, shapes in [('visible', [h.VCompound(), h.OutLineVCompound()]), ('hidden', [h.HCompound(), h.OutLineHCompound()] if hidden else [])]:
        segs = []
        for s in shapes:
            if s is None or s.IsNull():
                continue
            for e in explore(s, TopAbs_EDGE):
                pts = sample_edge(e, .02)[:, :2]
                if len(pts) >= 2 and np.ptp(pts, axis=0).max() > 1e-6:
                    segs.append(pts)
        out[key] = segs
    return out


class View:
    def __init__(self, name, n, right, lines, label=None):
        self.name = name
        self.n = np.array(n, float)
        self.right = np.array(right, float)
        self.up = np.cross(self.n, self.right)
        self.vis = lines['visible']
        self.hid = lines.get('hidden', [])
        pts = np.vstack(self.vis + self.hid) if (self.vis or self.hid) else np.zeros((1, 2))
        self.lo = pts.min(0)
        self.hi = pts.max(0)
        self.span = np.maximum(self.hi - self.lo, 1e-6)
        self.label = label
        self.scale = 1.0
        self.off = np.zeros(2)
        self.hords = []  # (value_along_right, start_point_model2d, kind)
        self.vords = []
        self.origin_right = False  # H ordinate origin on the right edge (right/rear views)
        self.band_side = 'left'

    def to2d(self, p):
        p = np.asarray(p, float)
        return np.array([p @ self.right, p @ self.up])

    def P(self, q):
        return self.off + np.asarray(q, float) * self.scale

    def paper_box(self):
        a = self.P(self.lo)
        b = self.P(self.hi)
        return (a[0], a[1], b[0], b[1])


def classify_out(classifier, p):
    classifier.Perform(gp_Pnt(*map(float, p)), 1e-6)
    return classifier.State() == TopAbs_OUT


def hole_features(shape, g):
    """Coaxial cylinder/cone stacks -> drilled hole features with entry side, THRU, counterbore/countersink."""
    faces = [TopoDS.Face(f) for f in explore(shape, TopAbs_FACE)]
    cyl = {}
    cones = []
    for f in faces:
        a = BRepAdaptor_Surface(f, True)
        t = a.GetType()
        if t == GeomAbs_Cylinder and f.Orientation() == TopAbs_REVERSED:
            c = a.Cylinder()
            d = xyz(c.Axis().Direction())
            d = d * (1 if d[np.argmax(abs(d))] >= 0 else -1)
            o = xyz(c.Location())
            o = o - d * np.dot(o, d)
            pts = np.vstack([sample_edge(e, .05) for e in explore(f, TopAbs_EDGE)])
            v = pts @ d
            key = tuple(np.round(np.r_[d, o, c.Radius(), v.min(), v.max()], 3))
            ang = min(2 * math.pi, abs(a.LastUParameter() - a.FirstUParameter()))
            if key in cyl:
                cyl[key]['angle'] += ang
            else:
                cyl[key] = {'kind': 'cyl', 'd': d, 'o': o, 'r': c.Radius(), 't0': float(v.min()), 't1': float(v.max()), 'angle': ang}
        elif t == GeomAbs_Cone and f.Orientation() == TopAbs_REVERSED:
            c = a.Cone()
            d = xyz(c.Axis().Direction())
            d = d * (1 if d[np.argmax(abs(d))] >= 0 else -1)
            o = xyz(c.Location())
            o = o - d * np.dot(o, d)
            pts = np.vstack([sample_edge(e, .05) for e in explore(f, TopAbs_EDGE)])
            v = pts @ d
            rad = np.linalg.norm((pts - o) - np.outer(pts @ d, d), axis=1)
            cones.append({'kind': 'cone', 'd': d, 'o': o, 't0': float(v.min()), 't1': float(v.max()), 'rmax': float(rad.max()), 'rmin': float(rad.min()),
                          'angle': 2 * math.degrees(abs(c.SemiAngle())), 'r_at': (float(rad[np.argmin(v)]), float(rad[np.argmax(v)]))})
    segs = [c for c in cyl.values() if c['angle'] > 2 * math.pi - .05 and c['r'] > .15] + cones
    lines = {}
    for s in segs:
        k = tuple(np.round(s['d'], 3)) + tuple(np.round(s['o'], 2))
        lines.setdefault(k, []).append(s)
    classifier = BRepClass3d_SolidClassifier(shape)
    ghole = g.get('holes', [])
    out = []
    for segsl in lines.values():
        if not any(s['kind'] == 'cyl' for s in segsl):
            continue
        segsl.sort(key=lambda s: s['t0'])
        chains = [[segsl[0]]]
        for s in segsl[1:]:
            if s['t0'] <= max(x['t1'] for x in chains[-1]) + .05:
                chains[-1].append(s)
            else:
                chains.append([s])
        for ch in chains:
            cyls = [s for s in ch if s['kind'] == 'cyl']
            if not cyls:
                continue
            d = ch[0]['d']
            o = ch[0]['o']
            t0 = min(s['t0'] for s in ch)
            t1 = max(s['t1'] for s in ch)
            open0 = classify_out(classifier, o + d * (t0 - .05))
            open1 = classify_out(classifier, o + d * (t1 + .05))
            if not (open0 or open1):
                continue
            through = open0 and open1
            rmain = min(s['r'] for s in cyls)

            def mouth(at_lo):
                """Counterbore / countersink description at one mouth of the stack."""
                end = t0 if at_lo else t1
                first = min(ch, key=lambda s: abs((s['t0'] if at_lo else s['t1']) - end))
                if first['kind'] == 'cone' and first['rmax'] > rmain + .05:
                    return ('csk', 2 * first['rmax'], first['angle'])
                if first['kind'] == 'cyl' and first['r'] > rmain + .05:
                    return ('cbore', 2 * first['r'], first['t1'] - first['t0'])
                return None
            m0 = mouth(True) if open0 else None
            m1 = mouth(False) if open1 else None
            if through:
                entry_lo = bool(m0) or not m1
            else:
                entry_lo = open0
            mouth_desc = m0 if entry_lo else m1
            entry_t = t0 if entry_lo else t1
            # cylinder sequence from the entry inward (counterbore consumed by the mouth; drill points ignored)
            seq = sorted(cyls, key=lambda c: (c['t0'] - entry_t) if entry_lo else (entry_t - c['t1']))
            if mouth_desc and mouth_desc[0] == 'cbore':
                seq = seq[1:] or seq
            steps = []
            for c in seq:
                ln = c['t1'] - c['t0']
                if steps and abs(steps[-1][0] - 2 * c['r']) < 1e-3:
                    steps[-1][1] += ln
                else:
                    steps.append([2 * c['r'], ln])
            far = max(abs(c['t1'] - entry_t) if entry_lo else abs(entry_t - c['t0']) for c in cyls if abs(c['r'] - rmain) < 1e-3)
            centre = o + d * ((t0 + t1) / 2)
            ids = sorted({h['id'] for h in ghole if any(abs(h['diameter'] - 2 * c['r']) < .01 for c in cyls)
                          and np.linalg.norm(np.cross(np.array(h['center']) - o, d)) < .05
                          and t0 - .01 <= float(np.dot(h['center'], d)) <= t1 + .01})
            out.append({'axis': d, 'line': tuple(np.round(d, 3)) + tuple(np.round(o, 2)), 'point': o + d * entry_t, 'centre': centre,
                        'dia': steps[0][0] if steps else 2 * rmain, 'through': through, 'depth': far if len(steps) <= 1 else steps[0][1],
                        'steps': steps, 'entry': -d if entry_lo else d, 'mouth': mouth_desc, 'ids': ids, 'thru_all': False})
    # coaxial chains of one drilling (e.g. through both arms of a fork) -> one feature, THRU ALL
    merged = []
    for h in out:
        twin = next((m for m in merged if m['line'] == h['line'] and abs(m['dia'] - h['dia']) < 1e-3 and m['through'] and h['through']), None)
        if twin is None:
            merged.append(h)
            continue
        twin['thru_all'] = True
        twin['ids'] = sorted(set(twin['ids']) | set(h['ids']))
        if h['mouth'] and not twin['mouth']:
            h['thru_all'] = True
            h['ids'] = twin['ids']
            merged[merged.index(twin)] = h
    return merged


def thread_for(dia):
    for drill, name, pitch in TAP_DRILLS:
        if abs(dia - drill) <= .06:
            return name, pitch
    return None


def edge_notes(shape, g):
    """Chamfers (45 deg planar strips) and fillet radii (partial cylinders) for leader notes."""
    faces = [TopoDS.Face(f) for f in explore(shape, TopAbs_FACE)]
    size = max(g['dimensions'])
    chamfers, fillets = {}, {}
    for f in faces:
        a = BRepAdaptor_Surface(f, True)
        t = a.GetType()
        if t == GeomAbs_Plane:
            n = xyz(a.Plane().Axis().Direction())
            nz = np.abs(n)
            big = np.sort(nz)
            if not (big[0] < .01 and big[1] > .17 and big[2] < .985):
                continue
            pts = np.vstack([sample_edge(e, .05) for e in explore(f, TopAbs_EDGE)])
            long_axis = int(np.argmin(nz))
            u = np.zeros(3)
            u[long_axis] = 1
            wdir = np.cross(n, u)
            width = float(np.ptp(pts @ wdir))
            # a narrow bevel strip between two faces, not a sloped main face
            others = [i for i in range(3) if i != long_axis]
            length = float(np.ptp(pts @ u))
            if width > max(6.0, .25 * min(x for x in g['dimensions'] if x > 1e-6) * 2) or width < .1 or length < 2 * width:
                continue
            la, lb = width * nz[others[1]], width * nz[others[0]]
            if abs(la - lb) < .02:
                leg = round(width / math.sqrt(2), 2)
            else:
                leg = (round(min(la, lb), 2), round(math.degrees(math.atan2(max(la, lb), min(la, lb))), 1))
            centre = props(f)[1]
            chamfers.setdefault(leg, []).append({'centre': centre, 'axis': u, 'pts': pts})
        elif t == GeomAbs_Cylinder:
            ang = abs(a.LastUParameter() - a.FirstUParameter())
            r = a.Cylinder().Radius()
            if ang > math.pi / 2 + .05 or r > .15 * size or r < .2:
                continue
            d = xyz(a.Cylinder().Axis().Direction())
            um = (a.FirstUParameter() + a.LastUParameter()) / 2
            vm = (a.FirstVParameter() + a.LastVParameter()) / 2
            mid = xyz(a.Value(um, vm))
            pts = np.vstack([sample_edge(e, .05) for e in explore(f, TopAbs_EDGE)])
            fillets.setdefault(round(r, 2), []).append({'centre': mid, 'axis': d, 'pts': pts})
    return chamfers, fillets


# --------------------------------------------------------------------------------------------- views
def view_frames(main_n, main_up):
    n0 = np.array(main_n, float)
    u0 = np.array(main_up, float)
    r0 = np.cross(u0, n0)
    return {'main': (n0, r0), 'top': (u0, r0), 'bottom': (-u0, r0), 'right': (r0, -n0), 'left': (-r0, n0), 'rear': (-n0, -r0)}


def choose_main(g, holes, sheet_metal, flat_ok=False, landscape=True):
    """Main view = largest projected area; ties broken by hole entries; Y-up models keep Y up."""
    dims = np.array(g['dimensions'])
    best = None
    for ax in range(3):
        for sgn in (1, -1):
            n = np.zeros(3)
            n[ax] = sgn
            others = [i for i in range(3) if i != ax]
            # Landscape sheets: the longer in-plane extent runs left-right. A part standing tall (a rod,
            # a long cover) is laid down instead of being drawn small and upright; near-square parts keep
            # the model's natural up (Z, or Y when looking down Z).
            up = np.array([0, 1, 0.]) if ax == 2 else np.array([0, 0, 1.])
            iu = int(np.argmax(np.abs(up)))
            ih = others[0] if others[1] == iu else others[1]
            if landscape and dims[iu] > 1.3 * dims[ih]:
                up = np.zeros(3)
                up[ih] = 1.0
            area = dims[others[0]] * dims[others[1]]
            entries = sum(1 for h in holes if h['through'] and abs(h['axis'] @ n) > .99 or h['entry'] @ n > .99)
            score = area * (1 + .02 * entries) + (1e-6 if sgn > 0 else 0)
            if best is None or score > best[0]:
                best = (score, n, up)
    return best[1], best[2]


def ordinate_candidates(v, holes, claimed, claimed_holes, sheet_metal, edge_tol=0.0):
    """Values to dimension in this view: extents, visible hole centres (machining) and long step edges."""
    lo, hi = v.lo, v.hi
    hvals, vvals = [], []
    # silhouettes of holes lying across the view are not steps
    sil_x, sil_y = [], []
    for h in holes:
        if abs(h['axis'] @ v.n) < .02:
            c = v.to2d(h['centre'])
            r = h['dia'] / 2
            if abs(h['axis'] @ v.up) > .98:
                sil_x += [c[0] - r, c[0] + r]
            if abs(h['axis'] @ v.right) > .98:
                sil_y += [c[1] - r, c[1] + r]
    vert, horiz = {}, {}
    for seg in v.vis:
        if len(seg) != 2:
            continue
        a, b = seg
        if abs(a[0] - b[0]) < 1e-4 * max(v.span):
            k = round(float(a[0]), 3)
            e = vert.setdefault(k, [0.0, -1e9, 1e9])
            e[0] += abs(a[1] - b[1])
            e[1] = max(e[1], a[1], b[1])
            e[2] = min(e[2], a[1], b[1])
        elif abs(a[1] - b[1]) < 1e-4 * max(v.span):
            k = round(float(a[1]), 3)
            e = horiz.setdefault(k, [0.0, 1e9, -1e9])
            e[0] += abs(a[0] - b[0])
            e[1] = min(e[1], a[0], b[0])
            e[2] = max(e[2], a[0], b[0])

    def top_at(x):  # lowest visible point at x: extension lines run down to the baseline under the view
        e = vert.get(round(x, 3))
        if e:
            return e[2]
        ys = [p[1] for seg in v.vis for p in (seg[0], seg[-1]) if abs(p[0] - x) < 1e-3]
        return min(ys) if ys else lo[1]

    def side_at(y):
        e = horiz.get(round(y, 3))
        if e:
            return e[2] if v.origin_right else e[1]
        xs = [p[0] for seg in v.vis for p in (seg[0], seg[-1]) if abs(p[1] - y) < 1e-3]
        return (max(xs) if v.origin_right else min(xs)) if xs else (hi[0] if v.origin_right else lo[0])

    xo = hi[0] if v.origin_right else lo[0]
    hvals.append((0.0, np.array([xo, top_at(xo)]), 'extent'))
    xe = lo[0] if v.origin_right else hi[0]
    hvals.append((abs(xe - xo), np.array([xe, top_at(xe)]), 'extent'))
    # 0,0 = bottom-left corner of the view envelope
    vvals.append((0.0, np.array([side_at(lo[1]), lo[1]]), 'extent'))
    vvals.append((abs(hi[1] - lo[1]), np.array([side_at(hi[1]), hi[1]]), 'extent'))
    used_x = {round(xo, 2), round(xe, 2)}
    used_y = {round(lo[1], 2), round(hi[1], 2)}
    if not sheet_metal:
        for i, h in enumerate(holes):
            if i in claimed_holes:
                continue
            if abs(h['axis'] @ v.n) < .99:
                continue
            if not (h['through'] or h['entry'] @ v.n > .99):
                continue
            c = v.to2d(h['centre'])
            claimed_holes.add(i)
            h.setdefault('views', []).append(v.name)
            if round(c[0], 2) not in used_x:
                used_x.add(round(c[0], 2))
                hvals.append((abs(c[0] - xo), c + np.array([0, 0]), 'hole'))
            if round(c[1], 2) not in used_y:
                used_y.add(round(c[1], 2))
                vvals.append((abs(c[1] - lo[1]), c.copy(), 'hole'))
    # step edges
    minlen_x = max(1.0, (.6 if sheet_metal else .12) * v.span[1])
    minlen_y = max(1.0, (.6 if sheet_metal else .12) * v.span[0])
    ex = sorted(((e[0], x) for x, e in vert.items() if e[0] >= minlen_x), reverse=True)
    ey = sorted(((e[0], y) for y, e in horiz.items() if e[0] >= minlen_y), reverse=True)
    wr = int(np.argmax(np.abs(v.right)))
    wu = int(np.argmax(np.abs(v.up)))
    count = 0
    for _, x in ex:
        if count >= 6:
            break
        if any(abs(x - s) < .02 for s in sil_x) or any(abs(x - u) < .02 for u in used_x):
            continue
        if min(abs(x - lo[0]), abs(x - hi[0])) < edge_tol:
            continue  # chamfer / break-edge lines next to the outline
        key = (wr, round(x * np.sign(v.right[wr]), 2))
        if key in claimed:
            continue
        claimed.add(key)
        used_x.add(round(x, 2))
        hvals.append((abs(x - xo), np.array([x, top_at(x)]), 'edge'))
        count += 1
    count = 0
    for _, y in ey:
        if count >= 6:
            break
        if any(abs(y - s) < .02 for s in sil_y) or any(abs(y - u) < .02 for u in used_y):
            continue
        if min(abs(y - lo[1]), abs(y - hi[1])) < edge_tol:
            continue
        key = (wu, round(y * np.sign(v.up[wu]), 2))
        if key in claimed:
            continue
        claimed.add(key)
        used_y.add(round(y, 2))
        vvals.append((abs(y - lo[1]), np.array([side_at(y), y]), 'edge'))
        count += 1
    v.hords = sorted(hvals, key=lambda t: t[0])
    v.vords = sorted(vvals, key=lambda t: t[0])


def needs_jog(vals, scale, gap):
    p = sorted(v * scale for v in vals)
    return any(b - a < gap for a, b in zip(p, p[1:]))


def band_sizes(v, scale=None):
    """Paper space needed by the ordinate bands (top, side) at a given scale."""
    scale = scale or v.scale
    ds = dim_size()
    th = max((text_width(fmt(val), ds, DIM_FONT) for val, _, _ in v.hords), default=0)
    tv = max((text_width(fmt(val), ds, DIM_FONT) for val, _, _ in v.vords), default=0)
    top = 3.0 + 1.0 + 1.3 + th + .8 + (2.0 if needs_jog([t[0] for t in v.hords], scale, DIM_H + 1.0) else 0) if v.hords else 1.5
    side = 3.0 + 1.0 + 1.3 + tv + .8 + (2.0 if needs_jog([t[0] for t in v.vords], scale, DIM_H + 1.2) else 0) if v.vords else 1.5
    return top, side


def spread(desired, gap, lo=-1e9, hi=1e9):
    """1-D label de-overlap (exact least-squares cluster merging): keeps order, neighbours >= gap apart,
    each cluster centred on its members' desired positions."""
    n = len(desired)
    if n == 0:
        return []
    order = np.argsort(desired, kind='stable')
    d = np.asarray(desired, float)[order]
    clusters = []  # [first index, count, sum of (d[k] - (k - first) * gap)]
    for i in range(n):
        clusters.append([i, 1, d[i]])
        while len(clusters) > 1:
            f1, n1, s1 = clusters[-2]
            f2, n2, s2 = clusters[-1]
            p1 = min(max(s1 / n1, lo), hi - (n1 - 1) * gap)
            p2 = min(max(s2 / n2, lo), hi - (n2 - 1) * gap)
            if p1 + n1 * gap <= p2 + 1e-9:
                break
            clusters[-2:] = [[f1, n1 + n2, s1 + s2 - n2 * (f2 - f1) * gap]]
    t = np.empty(n)
    for f, cnt, sm in clusters:
        p = min(max(sm / cnt, lo), hi - (cnt - 1) * gap)
        t[f:f + cnt] = p + np.arange(cnt) * gap
    out = np.empty(n)
    out[order] = t
    return out.tolist()


def draw_ordinates(sh, v, gid):
    """GOAT/SolidWorks ordinate style for one view, 0,0 at the bottom-left corner: X values below the view
    (text rotated 90 deg), Y values to the left."""
    ds = dim_size()
    box = v.paper_box()
    # ---- horizontal positions (text rotated 90 deg, below the view)
    if v.hords:
        yb = box[1] - 3.0
        px = [v.P(q)[0] for _, q, _ in v.hords]
        tx = spread(px, DIM_H + 1.0)
        origin_px = px[0]
        sgn = -1 if v.origin_right else 1
        far = max(px) if sgn > 0 else min(px)
        sh.line((origin_px, yb), (far, yb), THIN, 'DIM', grp=gid)
        sh.circle((origin_px, yb), .67, THIN, 'DIM', grp=gid)
        band_bottom = yb
        for i, ((val, q, kind), p, t) in enumerate(zip(v.hords, px, tx)):
            oid = f'{gid}h{i}'
            start = v.P(q)[1] - (1.0 if kind == 'hole' else 0.35)
            jog = abs(t - p) > .05
            if jog:
                pts = [(p, start), (p, yb - .5), (t, yb - 2.5), (t, yb - 3.0)]
            else:
                pts = [(p, start), (p, yb - 1.0)]
            sh.poly(pts, THIN, 'DIM', grp=oid)
            if abs(val) > 1e-6:
                room = min([abs(p - o) for o in px if abs(o - p) > 1e-6] or [99])
                if room >= ARROW_L + .4:
                    sh.arrow((p, yb), (sgn, 0), 'DIM', grp=gid)
                else:
                    sh.circle((p, yb), .3, THIN, 'DIM', fill=True, grp=gid)
            ty = pts[-1][1] - 1.3          # text reads bottom-to-top and ends just under the extension line
            s = fmt(val)
            sh.text(t + DIM_H / 2, ty, s, ds, DIM_FONT, 'DIM', rot=90, ha='r', grp=oid)
            w = text_width(s, ds, DIM_FONT)
            band_bottom = min(band_bottom, ty - w)
            sh.textrects.append((t - DIM_H / 2 - .2, ty - w - .2, t + DIM_H / 2 + .2, ty + .2))
            sh.dims.append({'axis': 'x', 'origin': (origin_px, yb), 'feature': (p, start), 'leader': (t, ty), 'value': val, 'scale': v.scale,
                            'origin_right': v.origin_right, 'grp': oid})
        xs = px + tx
        sh.occupy((min(xs) - DIM_H / 2 - .5, band_bottom, max(xs) + DIM_H / 2 + .5, box[1]), .4)
    # ---- vertical positions (text horizontal, beside the view)
    if v.vords:
        right = v.band_side == 'right'
        xb = box[2] + 3.0 if right else box[0] - 3.0
        sx = 1 if right else -1
        py = [v.P(q)[1] for _, q, _ in v.vords]
        ty_ = spread(py, DIM_H + 1.2)
        origin_py = py[0]
        sh.line((xb, origin_py), (xb, max(py)), THIN, 'DIM', grp=gid)
        sh.circle((xb, origin_py), .67, THIN, 'DIM', grp=gid)
        band_x = xb
        for i, ((val, q, kind), p, t) in enumerate(zip(v.vords, py, ty_)):
            oid = f'{gid}v{i}'
            start = v.P(q)[0] + sx * (1.0 if kind == 'hole' else 0.35)
            jog = abs(t - p) > .05
            if jog:
                pts = [(start, p), (xb + sx * .5, p), (xb + sx * 2.5, t), (xb + sx * 3.0, t)]
            else:
                pts = [(start, p), (xb + sx * 1.0, p)]
            sh.poly(pts, THIN, 'DIM', grp=oid)
            if abs(val) > 1e-6:
                room = min([abs(p - o) for o in py if abs(o - p) > 1e-6] or [99])
                if room >= ARROW_L + .4:
                    sh.arrow((xb, p), (0, 1), 'DIM', grp=gid)
                else:
                    sh.circle((xb, p), .3, THIN, 'DIM', fill=True, grp=gid)
            s = fmt(val)
            w = text_width(s, ds, DIM_FONT)
            tx = pts[-1][0] + sx * 1.3
            sh.text(tx, t - DIM_H / 2, s, ds, DIM_FONT, 'DIM', ha='l' if right else 'r', grp=oid)
            x0 = tx if right else tx - w
            band_x = max(band_x, x0 + w) if right else min(band_x, x0)
            sh.textrects.append((x0 - .2, t - DIM_H / 2 - .2, x0 + w + .2, t + DIM_H / 2 + .2))
            sh.dims.append({'axis': 'y', 'origin': (xb, origin_py), 'feature': (start, p), 'leader': (tx, t), 'value': val, 'scale': v.scale,
                            'right': right, 'grp': oid})
        ys = py + ty_
        sh.occupy((box[2], min(ys) - DIM_H / 2 - .5, band_x, max(ys) + DIM_H / 2 + .5) if right else
                  (band_x, min(ys) - DIM_H / 2 - .5, box[0], max(ys) + DIM_H / 2 + .5), .4)


# --------------------------------------------------------------------------------------------- collision engine
# Everything drawn on the sheet goes into a spatial grid, so annotation placement can ask "what would this
# rectangle / leader hit?" — view outlines, hidden lines, extension lines, hole circles and other text — and
# the layout search can count the collisions that remain.
LAYER_COST = {'VISIBLE': 8.0, 'HIDDEN': 3.0, 'DIM': 5.0, 'CENTER': 1.0, 'NOTES': 5.0, 'TITLE': 8.0}


def text_rect(it):
    """Paper rect of a text item (x, y baseline; rot 0 or 90)."""
    w = text_width(it['s'], it['size'], it['font']) * it.get('hscale', 1.0)
    h = it['size'] * CAP.get(it['font'], .7)
    off = {'l': 0.0, 'c': -w / 2, 'r': -w}.get(it.get('ha', 'l'), 0.0)
    if it.get('rot', 0) == 90:
        return (it['x'] - h, it['y'] + off, it['x'], it['y'] + off + w)
    return (it['x'] + off, it['y'], it['x'] + off + w, it['y'] + h)


def _seg_hits_rect(a, b, r):
    return seg_box_len(a, b, r) > 1e-6 or (r[0] <= a[0] <= r[2] and r[1] <= a[1] <= r[3])


class CollisionMap:
    CELL = 4.0

    def __init__(self, sh=None, skip_grp=None):
        self.segs, self.rects, self.circles = {}, {}, {}
        self.n = 0
        if sh is not None:
            for it in sh.items:
                if skip_grp and it.get('grp') and str(it['grp']).startswith(skip_grp):
                    continue
                self.add_item(it)

    def _cells(self, r):
        c = self.CELL
        for i in range(int(math.floor(r[0] / c)), int(math.floor(r[2] / c)) + 1):
            for j in range(int(math.floor(r[1] / c)), int(math.floor(r[3] / c)) + 1):
                yield (i, j)

    def _put(self, store, r, obj):
        self.n += 1
        for k in self._cells(r):
            store.setdefault(k, []).append((self.n, obj))

    def add_item(self, it):
        k = it['k']
        if k == 'poly':
            pts = it['pts'] + ([it['pts'][0]] if it.get('closed') else [])
            for a, b in zip(pts, pts[1:]):
                self.add_seg(a, b, it['layer'])
        elif k == 'circle' and not it.get('fill'):
            c, rr = it['c'], it['r']
            self._put(self.circles, (c[0] - rr, c[1] - rr, c[0] + rr, c[1] + rr), (c, rr, it['layer']))
        elif k == 'text':
            self.add_rect(text_rect(it), it['layer'])
        elif k == 'labelrect':
            self.add_rect(it['r'], 'NOTES')

    def add_seg(self, a, b, layer):
        r = (min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))
        self._put(self.segs, r, (tuple(a), tuple(b), layer))

    def add_rect(self, r, layer='NOTES'):
        self._put(self.rects, r, (tuple(r), layer))

    def _near(self, store, r):
        seen = set()
        for k in self._cells(r):
            for n, obj in store.get(k, ()):
                if n not in seen:
                    seen.add(n)
                    yield obj

    def rect_cost(self, r, text_weight=60.0):
        """Weighted count of what a text box at r would collide with."""
        cost = 0.0
        for a, b, layer in self._near(self.segs, r):
            if _seg_hits_rect(a, b, r):
                cost += LAYER_COST.get(layer, 4.0)
        for q, layer in self._near(self.rects, r):
            ox = min(r[2], q[2]) - max(r[0], q[0])
            oy = min(r[3], q[3]) - max(r[1], q[1])
            if ox > 0 and oy > 0:
                cost += text_weight + 4 * ox * oy
        for c, rr, layer in self._near(self.circles, r):
            # closest point of the rect to the circle centre inside the circle, but the circle not around the rect
            dx = c[0] - max(r[0], min(c[0], r[2]))
            dy = c[1] - max(r[1], min(c[1], r[3]))
            far = max(math.hypot(c[0] - x, c[1] - y) for x in (r[0], r[2]) for y in (r[1], r[3]))
            if dx * dx + dy * dy < rr * rr and far > rr:
                cost += LAYER_COST.get(layer, 4.0)
        return cost

    def seg_cost(self, a, b, ignore_r=None):
        """Crossings of a leader a→b with drawn lines and text."""
        r = (min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))
        near = list(self._near(self.segs, r))
        cost = 0.0
        if near:
            P = np.array([s[0] for s in near], float); Q = np.array([s[1] for s in near], float)
            A = np.asarray(a, float); B = np.asarray(b, float)
            def orient(p, q, r_):
                return (q[..., 0] - p[..., 0]) * (r_[..., 1] - p[..., 1]) - (q[..., 1] - p[..., 1]) * (r_[..., 0] - p[..., 0])
            d1 = orient(P, Q, A[None]); d2 = orient(P, Q, B[None])
            d3 = orient(A[None], B[None], P); d4 = orient(A[None], B[None], Q)
            hit = (d1 * d2 < 0) & (d3 * d4 < 0)
            w = np.array([LAYER_COST.get(s[2], 4.0) for s in near])
            cost += float((w * hit).sum()) * .6
        for q, layer in self._near(self.rects, r):
            if ignore_r is not None and q == tuple(ignore_r):
                continue
            if seg_box_len(a, b, q) > 1e-6:
                cost += 30.0
        return cost


def drawing_collisions(sh):
    """Remaining annotation collisions on a finished sheet: text over text, and dimension / note text
    struck through by view or dimension lines. Used to score layouts and by tests."""
    texts = [(i, it, text_rect(it)) for i, it in enumerate(sh.items) if it['k'] == 'text' and it['layer'] in ('DIM', 'NOTES')]
    cm = CollisionMap()
    for it in sh.items:
        if it['k'] == 'poly' and it['layer'] in ('VISIBLE', 'HIDDEN', 'DIM'):
            pts = it['pts'] + ([it['pts'][0]] if it.get('closed') else [])
            for a, b in zip(pts, pts[1:]):
                cm.add_seg(a, b, it['layer'] + ('|' + str(it.get('grp')) if it.get('grp') else ''))
    out = {'text_text': 0, 'text_line': 0, 'examples': []}
    shrink = lambda r, d: (r[0] + d, r[1] + d, r[2] - d, r[3] - d)
    for n, (i, it, r) in enumerate(texts):
        for j, jt, q in texts[n + 1:]:
            if it.get('grp') and it.get('grp') == jt.get('grp'):
                continue
            if min(r[2], q[2]) - max(r[0], q[0]) > .15 and min(r[3], q[3]) - max(r[1], q[1]) > .15:
                out['text_text'] += 1
                if len(out['examples']) < 12:
                    out['examples'].append(('text', it['s'], jt['s']))
        inner = shrink(r, .12)
        for a, b, layer in cm._near(cm.segs, inner):
            base, _, grp = layer.partition('|')
            if grp and grp == str(it.get('grp')):
                continue  # its own extension line / shoulder
            if _seg_hits_rect(a, b, inner):
                out['text_line'] += 1
                if len(out['examples']) < 12:
                    out['examples'].append(('line', it['s'], base))
                break
    return out


def place_tags(sh, v, scale, cmap=None):
    """Hole-table tags beside their holes. Every candidate spot around a hole (8 directions, close and a
    little further out) is scored against everything already on the sheet — view outlines, hidden lines,
    extension lines, hole circles and text. When no spot next to the hole is clear, the tag moves to the
    nearest clear spot further out with a thin leader that avoids crossing outlines."""
    ts = TAG_H / CAP.get(DIM_FONT, .7)
    cm = cmap if cmap is not None else CollisionMap(sh)
    dirs = [(.7071, .7071), (-.7071, .7071), (.7071, -.7071), (-.7071, -.7071), (1, 0), (-1, 0), (0, 1), (0, -1)]
    tags = sorted(getattr(v, 'tags', []), key=lambda t: (t[1][1], t[1][0]))
    centres = [(np.asarray(v.P(c2), float), r * scale) for _, c2, r in tags]
    for tag, c2, r in tags:
        c = v.P(c2)
        rp = r * scale
        w = text_width(tag, ts, DIM_FONT)
        best = None
        for gap, leader in ((.35, False), (1.2, False), (2.6, True), (4.5, True), (7.0, True)):
            for di, (dx, dy) in enumerate(dirs):
                ax, ay = c[0] + dx * (rp + gap), c[1] + dy * (rp + gap)
                x0 = ax if dx > .1 else ax - w if dx < -.1 else ax - w / 2
                y0 = ay if dy > .1 else ay - TAG_H if dy < -.1 else ay - TAG_H / 2
                rect = (x0 - .15, y0 - .15, x0 + w + .15, y0 + TAG_H + .15)
                cost = cm.rect_cost(rect) + gap * 1.5 + di * .05
                # a tag must read as belonging to its own hole: no other hole may sit closer to it
                m = np.array([(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2])
                own = max(0.0, float(np.linalg.norm(m - c)) - rp)
                if any(max(0.0, float(np.linalg.norm(m - oc)) - orr) < own - .2 for oc, orr in centres if float(np.linalg.norm(oc - c)) > 1e-6):
                    cost += 8.0
                if leader:
                    a = (c[0] + dx * rp, c[1] + dy * rp)
                    tip = (ax - dx * .3, ay - dy * .3)
                    cost += cm.seg_cost(a, tip) + 2.0
                if best is None or cost < best[0]:
                    best = (cost, rect, leader, (dx, dy), gap)
            if best[0] < 3.0:   # clean enough at this distance: do not wander further
                break
        cost, rect, leader, (dx, dy), gap = best
        sh.overlaps += max(0.0, cost - 3.0) * .02
        if leader:
            a = (c[0] + dx * rp, c[1] + dy * rp)
            # attach to the nearest side of the tag box
            tip = (min(max(a[0], rect[0]), rect[2]), min(max(a[1], rect[1]), rect[3]))
            sh.line(a, tip, THIN * .8, 'NOTES')
            cm.add_seg(a, tip, 'DIM')
        sh.text(rect[0] + .15, rect[1] + .15, tag, ts, DIM_FONT, 'NOTES')
        cm.add_rect(rect, 'NOTES')
        sh.textrects.append(rect)


def draw_view_geometry(sh, v, hidden=True, layer='VISIBLE'):
    for seg in v.vis:
        sh.poly([v.P(q) for q in seg], THICK, layer)
    if hidden:
        for seg in v.hid:
            sh.poly([v.P(q) for q in seg], THIN, 'HIDDEN', dash=HIDDEN_DASH)


# --------------------------------------------------------------------------------------------- labels
def callout_lines(group, spec):
    """SolidWorks hole-callout wording: count, diameter, depth/THRU, thread, counterbore/countersink."""
    h = group[0]
    n = len(group)
    pre = f'{n} x ' if n > 1 else ''
    thru = 'THRU ALL' if h.get('thru_all') else 'THRU'
    steps = h.get('steps') or [[h['dia'], h['depth']]]
    lines = []
    for i, (dia, ln) in enumerate(steps):
        last = i == len(steps) - 1
        tail = thru if (last and h['through']) else f"{DEPTH} {(h['depth'] if len(steps) == 1 else ln):.2f}"
        lines.append((pre if i == 0 else '') + f"\u00d8 {dia:.2f} {tail}")
    fs = spec.get('feature_specs', {}) or {}
    desig = next((fs.get(i, {}).get('designation') for i in h['ids'] if (fs.get(i) or {}).get('designation')), None)
    inferred = False
    if desig:
        lines.insert(1, str(desig))
    else:
        th = thread_for(steps[0][0]) if INFER_THREADS and len(steps) == 1 and not (h['mouth'] and h['mouth'][0] == 'cbore') else None
        if th:
            lines.insert(1, f"{th[0]} - 6H" + (' ' + thru if h['through'] else ''))
            inferred = True
    m = h.get('mouth')
    if m and m[0] == 'cbore':
        lines.append(f"{CBORE} \u00d8 {m[1]:.2f} {DEPTH} {m[2]:.2f}")
    elif m and m[0] == 'csk':
        lines.append(f"{CSK} \u00d8 {m[1]:.2f} X {m[2]:.0f}\u00b0, Near Side")
    return lines, inferred


def place_labels(sh, labels, area, views):
    """Greedy placement of leader notes in free paper space (vectorised candidate search)."""
    x0, y0, x1, y1 = area
    ds = dim_size()
    pitch = DIM_H * 1.75
    placed_leaders = []
    cm = CollisionMap(sh)
    for lab in sorted(labels, key=lambda l: (-len(l['targets']), l.get('id', ''))):
        w = max(text_width(s, ds, DIM_FONT) for s in lab['lines']) + 1.0
        h = pitch * (len(lab['lines']) - 1) + DIM_H + 1.2
        xs = np.arange(x0, x1 - w, 1.5)
        ys = np.arange(y0 + .8, y1 - h, 1.5)
        if len(xs) == 0 or len(ys) == 0:
            continue
        BX, BY = np.meshgrid(xs, ys)
        BX = BX.ravel()
        BY = BY.ravel()
        occ = np.array(sh.occupied) if sh.occupied else np.zeros((0, 4))
        R = np.stack([BX, BY - .6, BX + w, BY + h], 1)
        if len(occ):
            ox = np.clip(np.minimum(R[:, None, 2], occ[None, :, 2]) - np.maximum(R[:, None, 0], occ[None, :, 0]), 0, None)
            oy = np.clip(np.minimum(R[:, None, 3], occ[None, :, 3]) - np.maximum(R[:, None, 1], occ[None, :, 1]), 0, None)
            overlap = (ox * oy).sum(1)
        else:
            overlap = np.zeros(len(R))
        best = None
        for tgt in lab['targets']:
            c = np.asarray(tgt['p'], float)
            left_attach = BX + w / 2 > c[0]
            AX = np.where(left_attach, BX, BX + w)
            AY = BY
            dx = AX - c[0]
            dy = AY - c[1]
            L = np.hypot(dx, dy)
            ang = np.degrees(np.arctan2(np.abs(dy), np.abs(dx)))
            cost = L + overlap * 200 + np.where((ang < 20) | (ang > 80), 12, 0) + np.where(L < 6, 20, 0)
            # stay near the owning view but outside geometry
            vb = tgt.get('box')
            order = np.argsort(cost)[:400]
            for i in order:
                a = np.array([AX[i], AY[i]])
                pen = cost[i]
                if best is not None and pen >= best[0]:
                    break
                # leader must not cut through other labels / dimension text
                seg_pen = 0
                for lr in placed_leaders:
                    if seg_intersect(a, tgt_tip(c, tgt, a), lr[0], lr[1]):
                        seg_pen += 25
                for vv in views:
                    b = vv.paper_box()
                    frac = seg_box_len(a, c, b)
                    seg_pen += frac * (0.3 if vv is tgt.get('view') else 3.0)
                for r in sh.textrects:
                    if seg_box_len(a, c, r) > 0:
                        seg_pen += 40
                total = pen + seg_pen
                if best is not None and total >= best[0]:
                    continue
                # what the note box and its leader would actually hit on the sheet
                rect_i = (BX[i] - 1.2, BY[i] - 1.4, BX[i] + w + 1.2, BY[i] + h + .8)   # keep a clear margin round the note
                total += cm.rect_cost(rect_i) * 3 + cm.seg_cost(a, tgt_tip(c, tgt, a)) * .5
                if best is None or total < best[0]:
                    best = (total, i, tgt, a, bool(left_attach[i]), overlap[i])
        if best is None:
            continue
        total, i, tgt, a, left, ov = best
        sh.overlaps += ov
        c = np.asarray(tgt['p'], float)
        tip = tgt_tip(c, tgt, a)
        gid = lab.get('id') or f"lab{len(placed_leaders)}"
        bx, by = BX[i], BY[i]
        sh.sg = gid
        sh.line(a, tip, THIN, 'DIM', grp=gid)
        sh.arrow(tip, tip - a, 'DIM', grp=gid)
        sh.line((bx, by), (bx + w, by), THIN, 'DIM', grp=gid)
        n = len(lab['lines'])
        for k, s in enumerate(lab['lines']):
            yy = by + .9 + pitch * (n - 1 - k)
            if left:
                sh.text(bx + .5, yy, s, ds, DIM_FONT, 'DIM', grp=gid)
            else:
                sh.text(bx + w - .5, yy, s, ds, DIM_FONT, 'DIM', ha='r', grp=gid)
        sh.sg = None
        rect = (bx, by - .6, bx + w, by + h)
        sh.callouts[gid] = {'view': 'view:' + tgt['view'].name if tgt.get('view') is not None else None, 'style': 'goat',
                            'anchor': [float(tip[0] * mm), float(tip[1] * mm)], 'center': [float(c[0] * mm), float(c[1] * mm)],
                            'radius': float(tgt.get('r', 0) * mm), 'bounds': [float(bx * mm), float((by - .6) * mm), float((bx + w) * mm), float((by + h) * mm)],
                            'shoulder_y': float(by * mm), 'pitch': float(pitch * mm), 'size': float(ds * mm), 'font': DIM_FONT,
                            'lines': list(lab['lines']), 'feature_ids': lab.get('feature_ids', []), 'measurements': lab.get('measurements', [])}
        sh.occupy(rect, .6)
        sh.textrects.append(rect)
        sh.items.append({'k': 'labelrect', 'r': rect})
        cm.add_rect(rect, 'NOTES')
        cm.add_seg(tuple(a), tuple(tip), 'DIM')
        sh.dims.append({'axis': 'note', 'grp': gid, 'lines': lab['lines'], 'at': (bx + (.5 if left else w - .5), by + .9), 'left': left, 'pitch': pitch,
                        'leader': [tuple(a), tuple(tip)], 'shoulder': [(bx, by), (bx + w, by)]})
        placed_leaders.append((a, tip))


def lab_rects(sh):
    return [it['r'] for it in sh.items if it['k'] == 'labelrect']


def tgt_tip(c, tgt, a):
    r = tgt.get('r', 0)
    if r <= 0:
        return c
    d = a - c
    n = np.linalg.norm(d)
    return c + d / max(n, 1e-9) * r


def seg_intersect(p1, p2, p3, p4):
    def ccw(a, b, c):
        return (c[1] - a[1]) * (b[0] - a[0]) > (b[1] - a[1]) * (c[0] - a[0])
    return ccw(p1, p3, p4) != ccw(p2, p3, p4) and ccw(p1, p2, p3) != ccw(p1, p2, p4)


def seg_box_len(a, b, box):
    """Length of segment ab inside an axis-aligned box (Liang-Barsky)."""
    x0, y0, x1, y1 = box[:4]
    dx, dy = b[0] - a[0], b[1] - a[1]
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, a[0] - x0), (dx, x1 - a[0]), (-dy, a[1] - y0), (dy, y1 - a[1])):
        if abs(p) < 1e-12:
            if q < 0:
                return 0.0
        else:
            t = q / p
            if p < 0:
                t0 = max(t0, t)
            else:
                t1 = min(t1, t)
    return max(0.0, t1 - t0) * math.hypot(dx, dy)


# --------------------------------------------------------------------------------------------- layout
FIRST_ANGLE_SLOTS = {'top': 'bottom', 'bottom': 'top', 'left': 'right', 'right': 'left'}


def layout_views(views, order, area, scale, first_angle=False):
    """Third-angle grid: columns [left, main(+top/bottom), right, rear]; rows [top, main, bottom].
    First-angle projection (ISO 128-30 method E) mirrors the slots: the view from above goes below the main view,
    the view from the right goes on its left."""
    if first_angle:
        views = {FIRST_ANGLE_SLOTS.get(k, k): v for k, v in views.items()}
    x0, y0, x1, y1 = area
    for v in views.values():
        v.scale = scale
    band = {k: band_sizes(v, scale) for k, v in views.items()}
    has = lambda k: k in views
    m = views['main']
    colM_side = max(band[k][1] for k in ('main', 'top', 'bottom') if has(k))
    cols = []
    if has('left'):
        cols.append(('left', band['left'][1] + views['left'].span[0] * scale))
    cols.append(('main', colM_side + m.span[0] * scale))
    if has('right'):
        cols.append(('right', band['right'][1] + views['right'].span[0] * scale))
    if has('rear'):
        cols.append(('rear', band['rear'][1] + views['rear'].span[0] * scale))
    # ordinate bands sit below (X values) and left (Y values) of every view
    rowM_band = max(band[k][0] for k in ('main', 'left', 'right', 'rear') if has(k))
    rows = []
    if has('top'):
        rows.append(('top', views['top'].span[1] * scale + band['top'][0]))
    rows.append(('main', m.span[1] * scale + rowM_band))
    if has('bottom'):
        rows.append(('bottom', views['bottom'].span[1] * scale + band['bottom'][0]))
    W = sum(c[1] for c in cols)
    H = sum(r[1] for r in rows)
    gap = 6.0
    free_w = (x1 - x0) - W - gap * (len(cols) - 1)
    free_h = (y1 - y0) - H - gap * (len(rows) - 1)
    if free_w < 0 or free_h < 0:
        return None
    gx = gap + min(free_w / (len(cols) + 1), 16.0)
    gy = gap + min(free_h / (len(rows) + 1), 12.0)
    mx_w = (x1 - x0) - W - gx * (len(cols) - 1)
    my_h = (y1 - y0) - H - gy * (len(rows) - 1)
    # column x positions (cluster centred horizontally, pushed slightly left to leave the iso corner free)
    cx = {}
    x = x0 + mx_w * .42
    for name, wdt in cols:
        cx[name] = (x, x + wdt)
        x += wdt + gx
    ry = {}
    y = y1 - my_h * .5
    for name, hgt in rows:
        ry[name] = (y - hgt, y)
        y -= hgt + gy
    mx = cx['main'][0] + colM_side
    mtop = ry['main'][1]

    def place(v, left, top):
        v.off = np.array([left, top]) - np.array([v.lo[0], v.hi[1]]) * scale
    place(m, mx, mtop)
    if has('top'):
        place(views['top'], mx, ry['top'][1])
    if has('bottom'):
        place(views['bottom'], mx, ry['bottom'][1])
    for k in ('left', 'right', 'rear'):
        if has(k):
            place(views[k], cx[k][0] + band[k][1], mtop)
    return True


def item_bbox(it):
    """Paper bounding box of one drawing primitive (text measured with its font, alignment and rotation)."""
    k = it['k']
    if k in ('poly', 'tri'):
        a = np.asarray(it['pts'])
        return a[:, 0].min(), a[:, 1].min(), a[:, 0].max(), a[:, 1].max()
    if k == 'circle':
        (x, y), r = it['c'], it['r']
        return x - r, y - r, x + r, y + r
    if k == 'text':
        w = text_width(it['s'], it['size'], it['font']) * it['hscale']
        x0 = {'l': 0, 'c': -w / 2, 'r': -w}[it['ha']]
        cap = CAP.get(it['font'], .7) * it['size']
        corners = np.array([[x0, -.25 * it['size']], [x0 + w, -.25 * it['size']], [x0, cap], [x0 + w, cap]])
        t = math.radians(it['rot'])
        R = np.array([[math.cos(t), -math.sin(t)], [math.sin(t), math.cos(t)]])
        c = corners @ R.T + [it['x'], it['y']]
        return c[:, 0].min(), c[:, 1].min(), c[:, 0].max(), c[:, 1].max()
    return None


def bounds_violation(sh, area, fixed):
    """Area (mm^2, scaled) by which views, dimensions and notes leave the drawing area or cover the title block,
    note lines, tables or zone margins. Zero means a clean sheet."""
    x0, y0, x1, y1 = area[0] - 3.0, 7.5, area[2] + 3.0, area[3] + 3.0   # inside the 6 mm zone frame
    bad = 0.0
    for it in sh.items:
        if it.get('sg') is None or it['k'] == 'labelrect':
            continue
        b = item_bbox(it)
        if b is None:
            continue
        bad += max(0, x0 - b[0]) + max(0, b[2] - x1) + max(0, y0 - b[1]) + max(0, b[3] - y1)
        for r in fixed:
            ox = min(b[2], r[2]) - max(b[0], r[0])
            oy = min(b[3], r[3]) - max(b[1], r[1])
            if ox > 0 and oy > 0:
                bad += ox * oy + 1.0
    return bad * 10


def fit_box(v, box, max_scale):
    """Largest scale (<= max_scale) that fits view v inside box, centred."""
    bw, bh = box[2] - box[0], box[3] - box[1]
    if bw <= 5 or bh <= 5:
        return 0
    s = min(bw / v.span[0], bh / v.span[1], max_scale)
    v.scale = s
    c = np.array([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2])
    v.off = c - (v.lo + v.hi) / 2 * s
    return s


def free_corner_box(sh, area, corner, aspect):
    """Grow a box from a corner of `area` until it hits occupied space; returns the largest box found."""
    x0, y0, x1, y1 = area
    occ = sh.occupied
    best = None
    for frac in np.linspace(.05, 1.0, 60):
        w = (x1 - x0) * frac
        h = w / aspect
        if h > (y1 - y0):
            break
        if corner == 'tr':
            b = (x1 - w, y1 - h, x1, y1)
        elif corner == 'tl':
            b = (x0, y1 - h, x0 + w, y1)
        elif corner == 'br':
            b = (x1 - w, y0, x1, y0 + h)
        else:
            b = (x0, y0, x0 + w, y0 + h)
        if any(not (b[2] <= r[0] or b[0] >= r[2] or b[3] <= r[1] or b[1] >= r[3]) for r in occ):
            break
        best = b
    return best


# --------------------------------------------------------------------------------------------- sheets
def pictorial_views(shape, n0, up0, defs, cache):
    out = []
    for d in defs:
        n, r = pictorial_defs.frame(n0, up0, d['azimuth'], d['elevation'], d['roll'])
        key = ('pict',) + tuple(np.round(np.r_[n, r], 6))
        if key not in cache:
            cache[key] = hlr(shape, n, r, hidden=False)
        v = View(d['id'], n, r, cache[key], label=d['label'])
        v.pdef = d
        out.append(v)
    return out


def machined_sheet(shape, p, rev, settings, cache, pictorials=None):
    g = p['geometry']
    sm = p.get('category') == 'sheet_metal'
    holes = [] if sm else cache.setdefault('holes', hole_features(shape, g))
    chamfers, fillets = ({}, {}) if sm else cache.setdefault('edges', edge_notes(shape, g))
    n0, up0 = choose_main(g, holes, sm, landscape=cache.get('landscape', True))
    cache['frame'] = (n0, up0)
    frames = view_frames(n0, up0)
    wanted = ['main', 'top', 'right']
    if sm and not g.get('bends'):
        # flat laser-cut plate: face view + one edge view for the thickness
        dims = np.array(g['dimensions'])
        wanted = ['main', 'top']
    if not sm:
        for side in ('left', 'bottom', 'rear'):
            n = frames[side][0]
            need = [h for h in holes if not h['through'] and h['entry'] @ n > .99]
            if need:
                wanted.append(side)
    views = {}
    for k in wanted:
        n, r = frames[k]
        lines = cache.get(('hlr', k))
        if lines is None:
            lines = hlr(shape, n, r, hidden=not sm)
            cache[('hlr', k)] = lines
        v = View(k, n, r, lines)
        v.origin_right = False  # every view dimensions from its bottom-left corner
        v.band_side = 'left'
        views[k] = v
    iso = pictorial_views(shape, n0, up0, pictorial_defs.normalize(pictorials), cache)
    claimed, claimed_holes = set(), set()
    for h in holes:
        h.pop('views', None)
    for k in ('main', 'top', 'right', 'left', 'bottom', 'rear'):
        if k in views:
            tol = (g.get('thickness', 0) + .01) if sm else ((max(k if not isinstance(k, tuple) else k[0] for k in chamfers) + .01) if chamfers else 0.0)
            ordinate_candidates(views[k], holes, claimed, claimed_holes, sm, tol)

    for v in views.values():
        v.angles, v.centrelines = [], []
    if sm and not g.get('bends') and 'top' in views and g.get('thickness'):
        views['top'].vords = []
        views['top'].thk = float(g['thickness'])
    if not sm:
        oblique_features(views, holes, g)
        for v in views.values():
            slope_angles(v)

    # hole groups per view -> callouts, or a tagged hole table when a view is crowded (ASME Y14.5 / ISO 129 practice)
    spec = p.get('spec', {})
    opts = cache.get('options') or {}
    inferred_any = False
    labels_proto = []
    table_rows = []
    letters = iter('ABCDEFGHJKLMNPQRSTUVWXYZ')
    letter_of = {}
    tool_of = {}
    for k, v in views.items():
        in_view = [h for h in holes if h.get('views') and h['views'][0] == k]
        mode = opts.get('hole_table', 'auto')
        crowded = len(in_view) > HOLE_TABLE_MIN
        v.table_mode = bool(in_view) and (mode == 'always' or (mode == 'auto' and crowded))
        if not v.table_mode:
            continue
        v.hords = [t for t in v.hords if t[2] != 'hole']
        v.vords = [t for t in v.vords if t[2] != 'hole']
        v.tags = []
        bygroup = {}
        for h in in_view:
            st = h['steps']
            key = (tuple((round(a, 2), None if (h['through'] and i == len(st) - 1) else round(b, 2)) for i, (a, b) in enumerate(st)),
                   h['through'], h['thru_all'], None if h['through'] else round(h['depth'], 2), h['mouth'] and tuple(round(x, 2) for x in h['mouth'][1:]))
            bygroup.setdefault(key, []).append(h)
        # CNC order: one tool at a time (smallest drill first; same drill with a counterbore / countersink right
        # after it), and within a tool the shortest path through its holes, starting where the last tool ended.
        pos = np.array(v.lo[:2], float)
        for key, grp in sorted(bygroup.items(), key=lambda kv: (round(kv[1][0]['dia'], 3), str(kv[0]))):
            size_lines, inferred = callout_lines([grp[0]], spec)
            inferred_any |= inferred
            if key not in letter_of:
                letter_of[key] = next(letters, 'Z')
            L = letter_of[key]
            pts = np.array([v.to2d(h['centre']) for h in grp], float)
            order = drill_path(pts, pos)
            grp = [grp[i] for i in order]
            pos = pts[order[-1]]
            tool = tool_of.setdefault(round(grp[0]['dia'], 3), len(tool_of) + 1)
            for i, h in enumerate(grp, 1):
                c2 = v.to2d(h['centre'])
                tag = f'{L}{i}'
                v.tags.append((tag, c2, (h['mouth'][1] if h['mouth'] else h['dia']) / 2))
                table_rows.append({'tag': tag, 'view': k, 'x': float(c2[0] - v.lo[0]), 'y': float(c2[1] - v.lo[1]),
                                   'tool': f"T{tool} Ø{grp[0]['dia']:.2f}", 'size': '  '.join(size_lines), 'ids': h['ids']})
    for k, v in views.items():
        if getattr(v, 'table_mode', False):
            continue
        groups = {}
        for h in holes:
            if not h.get('views') or h['views'][0] != k:
                continue
            st = h['steps']
            key = (tuple((round(a, 2), None if (h['through'] and i == len(st) - 1) else round(b, 2)) for i, (a, b) in enumerate(st)),
                   h['through'], h['thru_all'], None if h['through'] else round(h['depth'], 2), h['mouth'] and tuple(round(x, 2) for x in h['mouth'][1:]))
            groups.setdefault(key, []).append(h)
        for grp in groups.values():
            lines, inferred = callout_lines(grp, spec)
            inferred_any |= inferred
            labels_proto.append({'view': k, 'lines': lines, 'holes': grp})
    notes_proto = []
    for leg, items in sorted(chamfers.items(), key=lambda kv: str(kv[0])):
        text = f"{leg:.2f} X 45°" if not isinstance(leg, tuple) else f"{leg[0]:.2f} X {leg[1]:g}°"
        notes_proto.append({'kind': 'chamfer', 'lines': [text + (' TYP' if len(items) > 1 else '')], 'items': items})
    for r, items in sorted(fillets.items()):
        notes_proto.append({'kind': 'fillet', 'lines': [f"R{r:.2f}" + (' TYP' if len(items) > 1 else '')], 'items': items})

    title_notes = []
    if inferred_any:
        title_notes.append('THREAD SIZES INFERRED FROM TAP-DRILL Ø - CONFIRM')
    if spec.get('notes'):
        title_notes.append(str(spec['notes'])[:90].upper())
    cache['hole_table'] = table_rows
    return views, iso, labels_proto, notes_proto, title_notes


def _add_ordinate(v, q2, kind='hole'):
    """Extra ordinate pair for a point (model 2D) in a view, unless that coordinate is already dimensioned."""
    xo = v.hi[0] if v.origin_right else v.lo[0]
    if all(abs(q2[0] - t[1][0]) > .01 for t in v.hords):
        v.hords = sorted(v.hords + [(abs(q2[0] - xo), np.array(q2, float), kind)], key=lambda t: t[0])
    if all(abs(q2[1] - t[1][1]) > .01 for t in v.vords):
        v.vords = sorted(v.vords + [(abs(q2[1] - v.lo[1]), np.array(q2, float), kind)], key=lambda t: t[0])


def oblique_features(views, holes, g):
    """Holes drilled at an angle (no view looks down their axis) were never located or called out. Locate where
    the axis pierces the part envelope (ordinates in the view facing that face), call the hole out in the view
    that shows its axis true length, draw its centre line there and dimension the drilling angle."""
    b = g.get('bounds')
    if not b:
        return
    bmin, bmax = np.array(b[:3], float), np.array(b[3:], float)
    for h in holes:
        if h.get('views') or any(abs(h['axis'] @ v.n) > .99 for v in views.values()):
            continue
        d = np.asarray(h['axis'], float)
        c = np.asarray(h['centre'], float)
        ends = (1.0, -1.0) if h['through'] else (float(np.sign(h['entry'] @ d)) or 1.0,)
        best = None
        for sgn in ends:
            for i in range(3):
                if abs(d[i]) < .25:
                    continue
                bound = bmax[i] if d[i] * sgn > 0 else bmin[i]
                t = (bound - c[i]) / d[i]
                q = c + d * t
                if any(not (bmin[j] - .5 <= q[j] <= bmax[j] + .5) for j in range(3) if j != i):
                    continue
                score = abs(d[i]) + (.05 * sgn if h['through'] else 0) + .02 * (q[2] - bmin[2]) / max(bmax[2] - bmin[2], 1e-6)
                if best is None or score > best[0]:
                    nrm = np.zeros(3)
                    nrm[i] = np.sign(d[i] * sgn)
                    best = (score, q, nrm, d * sgn)
        if best is None:
            continue
        _, q, nrm, out = best
        prof = min(views.values(), key=lambda v: abs(d @ v.n))
        h['views'] = [prof.name]
        h['pierce'] = q
        face = next((v for v in views.values() if v.n @ nrm > .99), None)
        _add_ordinate(face or prof, (face or prof).to2d(q))
        # chain centre line through the bore in the profile view
        other = 2 * c - q
        prof.centrelines.append((prof.to2d(q + out * 1.0), prof.to2d(other - out * 1.0)))
        if abs(d @ prof.n) < .35:
            u, r = prof.to2d(out), prof.to2d(nrm)
            if np.linalg.norm(u) > 1e-6 and np.linalg.norm(r) > .5:
                u, r = u / np.linalg.norm(u), r / np.linalg.norm(r)
                ang = math.degrees(math.acos(float(np.clip(u @ r, -1, 1))))
                if .3 < ang < 89.7:
                    prof.angles.append({'vertex': prof.to2d(q), 'dir': u, 'ref': r, 'value': ang, 'kind': 'hole', 'ext': True})


def slope_angles(v, _tol=0.0):
    """Long visible edges that are neither horizontal nor vertical in a view (sloped faces, tapers): dimension
    their angle from the nearest view axis at the end that sits on the view envelope."""
    span = float(max(v.span))
    segs = []
    for seg in v.vis:
        seg = np.asarray(seg, float)
        if len(seg) < 2:
            continue
        a, z = seg[0], seg[-1]
        if len(seg) > 2:
            dd = z - a
            L = np.linalg.norm(dd)
            if L < 1e-9 or np.abs((seg[:, 0] - a[0]) * dd[1] / L - (seg[:, 1] - a[1]) * dd[0] / L).max() > 1e-3 * span:
                continue
        dd = z - a
        L = float(np.linalg.norm(dd))
        if L < max(.15 * span, 2.0):
            continue
        th = math.degrees(math.atan2(dd[1], dd[0])) % 180
        dev = min(th % 90, 90 - th % 90)
        if dev < 1.0:
            continue
        segs.append((L, a, z, th))
    seen = []
    for L, a, z, th in sorted(segs, key=lambda t: -t[0]):
        if any(abs(th - s) < .5 for s in seen) or len(seen) >= 2:
            continue
        seen.append(th)
        edge = lambda p: min(p[0] - v.lo[0], v.hi[0] - p[0], p[1] - v.lo[1], v.hi[1] - p[1])
        vx, other = (a, z) if edge(a) <= edge(z) else (z, a)
        u = (other - vx) / L
        horiz = abs(u[0]) >= abs(u[1])
        r = np.array([np.sign(u[0]) or 1.0, 0.0]) if horiz else np.array([0.0, np.sign(u[1]) or 1.0])
        ang = math.degrees(math.acos(float(np.clip(u @ r, -1, 1))))
        v.angles.append({'vertex': vx, 'dir': u, 'ref': r, 'value': ang, 'kind': 'slope', 'ext': False, 'len': L})


def draw_thickness(sh, v, gid):
    """Edge view of a plate / blank: 'THK t' with outside arrows at its right end instead of crowded ordinates."""
    thk = getattr(v, 'thk', 0)
    if not thk:
        return
    ds = dim_size()
    a, b = v.P((v.hi[0], v.lo[1])), v.P((v.hi[0], v.hi[1]))
    xd = a[0] + 4.0
    sh.line((a[0] + .6, a[1]), (xd + 1.0, a[1]), THIN, 'DIM', grp=gid)
    sh.line((b[0] + .6, b[1]), (xd + 1.0, b[1]), THIN, 'DIM', grp=gid)
    sh.line((xd, a[1] - ARROW_L - 1.5), (xd, b[1] + ARROW_L + 1.5), THIN, 'DIM', grp=gid)
    sh.arrow((xd, a[1]), (0, 1), 'DIM', grp=gid)
    sh.arrow((xd, b[1]), (0, -1), 'DIM', grp=gid)
    label = f'THK {thk:.2f}'
    ty = (a[1] + b[1]) / 2 - DIM_H / 2
    sh.text(xd + 1.8, ty, label, ds, DIM_FONT, 'DIM', grp=gid)
    w = text_width(label, ds, DIM_FONT)
    sh.textrects.append((xd + 1.6, ty - .2, xd + 2 + w, ty + DIM_H + .2))
    sh.occupy((a[0], min(a[1] - ARROW_L - 1.5, ty), xd + 2 + w, max(b[1] + ARROW_L + 1.5, ty + DIM_H)), .3)


def fmt_angle(a):
    return (f'{a:.0f}°' if abs(a - round(a)) < .05 else f'{a:.1f}°')


def draw_angles(sh, v, gid, cmap=None):
    """Angular dimensions (arc with arrows, value clear of the arc) and oblique-hole centre lines. Arc radius and
    text spot are chosen with the collision map: beside the arc on its bisector, or past either arrow."""
    ds = dim_size()
    for a, z in getattr(v, 'centrelines', []):
        sh.poly([v.P(a), v.P(z)], THIN, 'CENTER', dash=PHANTOM_DASH, grp=gid + 'c')
    for i, an in enumerate(getattr(v, 'angles', [])):
        oid = f'{gid}a{i}'
        vx = v.P(an['vertex'])
        u, r = np.asarray(an['dir'], float), np.asarray(an['ref'], float)
        a0, a1 = math.atan2(r[1], r[0]), math.atan2(u[1], u[0])
        da = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
        lo_a, hi_a = (a0, a0 + da) if da >= 0 else (a0 + da, a0)
        s = fmt_angle(an['value'])
        w = text_width(s, ds, DIM_FONT)
        rmax = float(np.clip(.6 * an.get('len', 1e9) * v.scale, 6.0, 12.0))
        best = None
        for R in sorted({6.0, min(8.0, rmax), min(10.0, rmax), rmax}):
            short = abs(da) * R < 2 * ARROW_L + 1.0
            extra = (ARROW_L + 1.2) / R if short else 0.0
            n = max(6, int(abs(hi_a - lo_a + 2 * extra) * R / .6))
            arc = [vx + R * np.array([math.cos(t), math.sin(t)]) for t in np.linspace(lo_a - extra, hi_a + extra, n)]
            lines = [(vx + r * .6, vx + r * (R + 1.5))] + ([(vx + u * .6, vx + u * (R + 1.5))] if an.get('ext') else [])
            own = lines + list(zip(arc[:-1], arc[1:]))
            mid = (lo_a + hi_a) / 2
            spots = [('bis', vx + np.array([math.cos(mid), math.sin(mid)]) * (R + 1.4 + .5 * w * abs(math.cos(mid)) + .5 * DIM_H * abs(math.sin(mid))))]
            gap = extra + (w / 2 + 1.6) / R
            spots += [('hi', vx + (R) * np.array([math.cos(hi_a + gap), math.sin(hi_a + gap)])),
                      ('lo', vx + (R) * np.array([math.cos(lo_a - gap), math.sin(lo_a - gap)]))]
            for mode, c in spots:
                rect = (c[0] - w / 2 - .3, c[1] - DIM_H / 2 - .3, c[0] + w / 2 + .3, c[1] + DIM_H / 2 + .3)
                cost = sum(8.0 for p, q in own if _seg_hits_rect(p, q, rect))
                if cmap is not None:
                    cost += cmap.rect_cost(rect) + .4 * sum(cmap.seg_cost(p, q) for p, q in zip(arc[:-1:2], arc[2::2]))
                cost += {'bis': 0.0, 'hi': .4, 'lo': .4}[mode] + .05 * R
                if best is None or cost < best[0]:
                    best = (cost, R, short, extra, arc, lines, c, rect)
        _, R, short, extra, arc, lines, c, rect = best
        start = len(sh.items)
        for p, q in lines:
            sh.line(p, q, THIN, 'DIM', grp=oid)
        sh.poly(arc, THIN, 'DIM', grp=oid)
        for t, sgn in ((lo_a, -1), (hi_a, 1)):
            tip = vx + R * np.array([math.cos(t), math.sin(t)])
            tang = np.array([-math.sin(t), math.cos(t)]) * sgn
            sh.arrow(tip, -tang if short else tang, 'DIM', grp=oid)
        sh.text(c[0], c[1] - DIM_H / 2, s, ds, DIM_FONT, 'DIM', ha='c', grp=oid)
        sh.textrects.append(rect)
        if cmap is not None:
            for it in sh.items[start:]:
                cmap.add_item(it)
        xs = [p[0] for p in arc] + [rect[0], rect[2]]
        ys = [p[1] for p in arc] + [rect[1], rect[3]]
        sh.occupy((min(xs), min(ys), max(xs), max(ys)), .2)
        sh.dims.append({'axis': 'angle', 'grp': oid, 'vertex': tuple(vx), 'value': an['value']})


def drill_path(pts, start):
    """Visiting order of drill positions: nearest neighbour from `start`, improved by 2-opt (open path)."""
    n = len(pts)
    if n <= 1:
        return list(range(n))
    left = list(range(n))
    cur = np.asarray(start, float)
    order = []
    while left:
        j = min(left, key=lambda i: float(np.hypot(*(pts[i] - cur))))
        order.append(j)
        left.remove(j)
        cur = pts[j]
    dist = lambda a, b: float(np.hypot(*(pts[a] - pts[b])))
    improved = n <= 200
    while improved:
        improved = False
        for i in range(n - 2):
            for j in range(i + 2, n):
                a, b = order[i], order[i + 1]
                c = order[j]
                d = order[j + 1] if j + 1 < n else None
                old = dist(a, b) + (dist(c, d) if d is not None else 0)
                new = dist(a, c) + (dist(b, d) if d is not None else 0)
                if new < old - 1e-9:
                    order[i + 1:j + 1] = order[i + 1:j + 1][::-1]
                    improved = True
    return order


def hole_table_layout(rows, max_h, multi_view):
    """Column layout of the hole table: [(x offset, rows)], total width/height (mm)."""
    size = 2.0
    rh = 3.2
    cols = [('TAG', 'tag'), ('X', 'x'), ('Y', 'y'), ('SIZE', 'size')]
    if rows and 'tool' in rows[0]:
        cols.insert(1, ('TOOL', 'tool'))
    if multi_view:
        cols.insert(1, ('VIEW', 'view'))
    fmtv = lambda r, k: f"{r[k]:.2f}" if k in ('x', 'y') else str(r[k]).upper()
    widths = [max(text_width(t, size, 'Helvetica-Bold'), *(text_width(fmtv(r, k), size, DIM_FONT if k == 'size' else 'Helvetica') for r in rows)) + 3.0 for t, k in cols]
    per = max(3, int((max_h - rh) // rh))
    blocks = [rows[i:i + per] for i in range(0, len(rows), per)]
    bw = sum(widths)
    return {'cols': cols, 'widths': widths, 'blocks': blocks, 'rh': rh, 'size': size, 'w': bw * len(blocks) + 4.0 * (len(blocks) - 1),
            'h': rh * (1 + max(len(b) for b in blocks)) + 3.4, 'bw': bw, 'fmt': fmtv}


def draw_hole_table(sh, lay, x0, ytop):
    rh, size = lay['rh'], lay['size']
    if any(k == 'tool' for _, k in lay['cols']):
        sh.text(x0, ytop - 2.4, 'HOLES IN MACHINING ORDER - ONE TOOL AT A TIME, SHORTEST PATH', size, 'Helvetica-Bold', 'TITLE')
    ytop -= 3.4
    for bi, block in enumerate(lay['blocks']):
        bx = x0 + bi * (lay['bw'] + 4.0)
        rows = [None] + block
        for i, r in enumerate(rows):
            y = ytop - rh * (i + 1)
            x = bx
            for (t, k), w in zip(lay['cols'], lay['widths']):
                if r is None:
                    sh.text(x + w / 2, y + 1.15, t, size, 'Helvetica-Bold', 'TITLE', ha='c')
                elif k == 'size':
                    sh.text(x + 1.5, y + 1.15, lay['fmt'](r, k), size, DIM_FONT, 'TITLE')
                else:
                    sh.text(x + w / 2, y + 1.15, lay['fmt'](r, k), size, 'Helvetica', 'TITLE', ha='c')
                x += w
            sh.line((bx, y), (bx + lay['bw'], y), THIN, 'TITLE')
        yb = ytop - rh * len(rows)
        sh.line((bx, ytop), (bx + lay['bw'], ytop), THIN, 'TITLE')
        x = bx
        for w in lay['widths'] + [0]:
            sh.line((x, ytop), (x, yb), THIN, 'TITLE')
            x += w


def free_rect(sh, area, w, h, prefer=(1, 1)):
    """Free spot of w x h inside area (largest clearance, then nearest to the preferred corner)."""
    x0, y0, x1, y1 = area
    xs = np.arange(x0, x1 - w + .01, 2.0)
    ys = np.arange(y0, y1 - h + .01, 2.0)
    if not len(xs) or not len(ys):
        return None
    BX, BY = np.meshgrid(xs, ys)
    R = np.stack([BX.ravel(), BY.ravel(), BX.ravel() + w, BY.ravel() + h], 1)
    occ = np.array(sh.occupied) if sh.occupied else np.zeros((0, 4))
    if len(occ):
        ox = np.clip(np.minimum(R[:, None, 2], occ[None, :, 2]) - np.maximum(R[:, None, 0], occ[None, :, 0]), 0, None)
        oy = np.clip(np.minimum(R[:, None, 3], occ[None, :, 3]) - np.maximum(R[:, None, 1], occ[None, :, 1]), 0, None)
        ok = (ox * oy).sum(1) <= 0
    else:
        ok = np.ones(len(R), bool)
    if not ok.any():
        return None
    R = R[ok]
    tx = x1 if prefer[0] else x0
    ty = y1 if prefer[1] else y0
    d = np.hypot((R[:, 0] + R[:, 2]) / 2 - tx, (R[:, 1] + R[:, 3]) / 2 - ty)
    return tuple(R[int(np.argmin(d))])


# a layout whose only flaws are a few tag leaders / residual near-misses is accepted without trying more sheets
GOOD_ENOUGH = 1.5


def assemble(p, rev, settings, views, iso, labels_proto, notes_proto, notes, sheet_no, sheets, extra=None, hidden=True, reserve=None,
             hole_table=None, sizes=('A4', 'A3', 'A2')):
    iso_required = bool(iso)
    hole_table = hole_table or []
    """Try sheet sizes and scales until views, dimensions, callouts and the isometric fit without overlap."""
    best = None
    for size in sizes:
        too_small = False
        last, worse, flat_run = None, 0, 0
        for scale in SCALES:
          if too_small:
              break
          for variant in range(3 if reserve else 1):
                sh = Sheet(size)
                tb = title_values(p, rev, settings, sheet_no, sheets, scale, size)
                title_top = draw_template(sh, tb)
                note_lines = [f"NOTE:  {tb['note']}"] if tb.get('note') else []
                stamp = draft_stamp(p, rev)
                note_lines = ([stamp] if stamp else []) + notes + note_lines
                ny = title_top + 1.4
                for s in reversed(note_lines):
                    sh.text(sh.w - 8.5, ny, s, TB_SIZE, 'Helvetica-Bold', 'NOTES', ha='r')
                    wdt = text_width(s, TB_SIZE, 'Helvetica-Bold')
                    sh.occupy((sh.w - 8.5 - wdt, ny - .6, sh.w - 8.5, ny + 2.4), .5)
                    ny += 3.6
                area = (10.0, title_top + 2.0, sh.w - 10.0, sh.h - 10.0)
                view_area = (area[0], title_top + 5.0, area[2], area[3])
                note_rects = list(sh.occupied[1:])
                fixed = [sh.occupied[0]] + note_rects      # title block + note lines
                if reserve:
                    # fixed tables (bend table ...): views go below them, or to their left, or around them
                    rects = reserve(sh, area)
                    for r in rects:
                        sh.occupy(r, 1.5)
                    fixed += rects
                    if variant == 1:
                        view_area = (view_area[0], view_area[1], view_area[2], min(r[1] for r in rects) - 4.0)
                    elif variant == 2:
                        view_area = (view_area[0], view_area[1], min(r[0] for r in rects) - 4.0, view_area[3])
                if not layout_views(views, None, view_area, scale, first_angle(settings)):
                    continue
                main_extent = max(views['main'].span) * scale
                if size != 'A2' and main_extent < 38 and max(views['main'].span) > 38 / 5:
                    # too small on this sheet: try the next sheet size rather than shrinking further
                    too_small = True
                    break
                if size != sizes[-1] and tag_spacing(views, scale) < 3.0:
                    too_small = True
                    break
                for v in views.values():
                    sh.occupy(v.paper_box(), 1.2)
                n_occ = len(sh.occupied)
                gidn = 0
                for k, v in views.items():
                    sh.sg = 'view:' + k
                    draw_view_geometry(sh, v, hidden)
                    draw_ordinates(sh, v, f'ord{gidn}')
                    draw_thickness(sh, v, f'thk{gidn}')
                    if extra and k == 'main':
                        extra(sh, scale, area, 'view')
                    gidn += 1
                # tags go in last, when every outline and dimension of every view is known
                cmap = CollisionMap(sh)
                for gidn, (k, v) in enumerate(views.items()):
                    sh.sg = 'view:' + k
                    draw_angles(sh, v, f'ang{gidn}', cmap)
                for k, v in views.items():
                    sh.sg = 'view:' + k
                    place_tags(sh, v, scale, cmap)
                sh.sg = None
                if extra:
                    extra(sh, scale, area, 'fixed')
                # pictorial views in the largest free corners (first one prefers top-right)
                isos = iso if isinstance(iso, list) else ([iso] if iso is not None else [])
                iso_ok = False
                sh.overflow = []
                for idx, pv in enumerate(isos):
                    aspect = pv.span[0] / pv.span[1]
                    cands = []
                    for corner in ('tr', 'tl', 'br', 'bl'):
                        b = free_corner_box(sh, area, corner, aspect)
                        if b:
                            cands.append(((b[2] - b[0]) * (1.25 if corner == 'tr' and idx == 0 else 1.0), corner, b))
                    placed = False
                    if cands:
                        cands.sort(key=lambda t: -t[0])
                        b = cands[0][2]
                        inner = (b[0] + 3.0, b[1] + 3.0, b[2] - 3.0, b[3] - 3.0)
                        want = pv.pdef.get('scale') if getattr(pv, 'pdef', None) else None
                        s_iso = fit_box(pv, inner, want if want else scale)
                        fits = s_iso >= (want * .999 if want else scale * (.45 if idx == 0 else .35)) and max(pv.span) * s_iso > (25 if idx == 0 else 18)
                        if idx == 0:
                            iso_ok = fits
                        if s_iso > 0 and (fits or idx == 0):
                            sh.sg = 'view:' + pv.name
                            draw_view_geometry(sh, pv, False, 'VISIBLE')
                            sh.sg = None
                            sh.occupy(pv.paper_box(), 1.0)
                            sh.view_meta['view:' + pv.name] = {'title': pv.label or 'ISOMETRIC', 'pictorial': pv.name, 'scale_used': round(s_iso, 4)}
                            placed = True
                    if not placed:
                        sh.overflow.append(pv)
                # hole table (tags drawn in the views): a movable block in free space, else an extra sheet
                sh.table_overflow = False
                if hole_table:
                    lay = hole_table_layout(hole_table, (area[3] - area[1]) * .8, len({r['view'] for r in hole_table}) > 1)
                    spot = free_rect(sh, area, lay['w'] + 2, lay['h'] + 2, (1, 1))
                    if spot:
                        sh.sg = 'view:holetable'
                        draw_hole_table(sh, lay, spot[0] + 1, spot[3] - 1)
                        sh.sg = None
                        sh.view_meta['view:holetable'] = {'title': 'HOLE TABLE'}
                        sh.occupy((spot[0], spot[1], spot[2], spot[3]), .5)
                    else:
                        sh.table_overflow = True
                        # a long schedule belongs on its own sheet (keeps the views large); a short one should fit
                        sh.overlaps += 0 if lay['h'] > .4 * (area[3] - area[1]) or len(hole_table) > 30 else 30
                # leader notes
                labels = []
                for lp in labels_proto:
                    v = views[lp['view']]
                    targets = [{'p': v.P(v.to2d(h['centre'])), 'r': h['dia'] / 2 * scale if h['mouth'] is None else h['mouth'][1] / 2 * scale, 'view': v, 'box': v.paper_box()} for h in lp['holes']]
                    ids = sorted({i for h in lp['holes'] for i in h['ids']})
                    labels.append({'lines': lp['lines'], 'targets': targets, 'feature_ids': ids,
                                   'id': f"callout:{lp['view']}:" + ('-'.join(ids) or f"{lp['holes'][0]['dia']:.2f}"),
                                   'measurements': [{'hole_ids': h['ids'], 'diameter': h['dia'], 'through': h['through'], 'depth': h['depth'],
                                                     'entrances': [{'diameter': h['mouth'][1], 'angle': h['mouth'][2]}] if h['mouth'] and h['mouth'][0] == 'csk' else [],
                                                     'steps': [{'diameter': a, 'depth': b} for a, b in h['steps'][1:]]} for h in lp['holes']]})
                corners = np.array([[x, y, z] for x in p['geometry']['bounds'][0::3] for y in p['geometry']['bounds'][1::3] for z in p['geometry']['bounds'][2::3]])
                for npr in notes_proto:
                    front_t, any_t = [], []
                    for k, v in views.items():
                        front = float((corners @ v.n).max())
                        for it in npr['items']:
                            if abs(np.asarray(it['axis']) @ v.n) < .99:
                                continue
                            t = {'p': v.P(v.to2d(it['centre'])), 'r': 0, 'view': v, 'box': v.paper_box()}
                            (front_t if float((it['pts'] @ v.n).max()) >= front - .01 else any_t).append(t)
                    targets = front_t or any_t
                    if targets:
                        first = targets[0]['view']
                        labels.append({'lines': npr['lines'], 'targets': [t for t in targets if t['view'] is first][:6],
                                       'id': f"note:{npr['kind']}:{npr['lines'][0].split()[0]}", 'measurements': []})
                # views/bands must stay clear of the note lines above the title block
                for r in sh.occupied[n_occ - len(views):]:
                    for nr in note_rects:
                        sh.overlaps += max(0, min(r[2], nr[2]) - max(r[0], nr[0])) * max(0, min(r[3], nr[3]) - max(r[1], nr[1]))
                seen_ids = {}
                for lab in labels:
                    base = lab.get('id')
                    if base in seen_ids:
                        seen_ids[base] += 1
                        lab['id'] = f'{base}#{seen_ids[base]}'
                    else:
                        seen_ids[base] = 0
                place_labels(sh, labels, area, list(views.values()))
                # every view / dimension / callout primitive must stay inside the frame and clear of fixed blocks
                sh.overlaps += bounds_violation(sh, area, fixed)
                # what is still colliding (text on text, text struck by lines) makes this layout worse
                col = drawing_collisions(sh)
                sh.collisions = col
                sh.overlaps += col['text_text'] * 2.0 + col['text_line'] * .5
                score = sh.overlaps + (0 if (iso_ok or not iso_required) else 50)
                if DEBUG_LAYOUT:
                    print('LAYOUT', size, round(scale, 4), variant, 'score', round(score, 2), 'table_over', sh.table_overflow, 'iso', iso_ok)
                if score < GOOD_ENOUGH:
                    sh.meta = {'scale': scale, 'size': size}
                    return sh
                if best is None or score < best[0]:
                    sh.meta = {'scale': scale, 'size': size}
                    best = (score, sh)
                # smaller scales only crowd the annotation further: stop once the score keeps rising
                # ...or stays flat: a fixed penalty (e.g. a table that only fits on another sheet) does not go
                # away by shrinking the views, so further scales only make the drawing smaller
                worse = worse + 1 if last is not None and score > last + .5 else 0
                flat_run = flat_run + 1 if last is not None and score > last - .25 else 0
                last = score
                if worse >= 2 or flat_run >= 2:
                    too_small = True
                    break
                if len(views) and scale < 1 / 100:
                    break
    return best[1] if best else None


def tag_spacing(views, scale):
    """Smallest paper distance (mm) between tagged hole centres in any view (inf without tags)."""
    best = float('inf')
    for v in views.values():
        pts = np.array([c2 for _, c2, _ in getattr(v, 'tags', [])], float)
        if len(pts) < 2:
            continue
        d = np.sqrt(((pts[:, None, :] - pts[None, :, :]) ** 2).sum(-1)) + np.eye(len(pts)) * 1e9
        # coincident centres (a hole seen in two tags) do not count
        d[d < 1e-3] = 1e9
        best = min(best, float(d.min()) * scale)
    return best


def flat_sheet(p, rev, settings, flat, iso_lines, sheet_no, sheets):
    """Developed blank for laser cutting: outline, bend lines (UP/DOWN), overall and bend ordinates, bend table."""
    outline = np.array(flat['outline'])
    vis = [outline] + [np.array(h) for h in flat['holes']]
    v = View('flat', (0, 0, 1), (1, 0, 0), {'visible': [np.asarray(s)[:, :2] for s in vis], 'hidden': []})
    lo, hi = v.lo, v.hi
    hv = [(0.0, np.array([lo[0], lo[1]]), 'extent'), (hi[0] - lo[0], np.array([hi[0], lo[1]]), 'extent')]
    vv = [(0.0, np.array([lo[0], lo[1]]), 'extent'), (hi[1] - lo[1], np.array([lo[0], hi[1]]), 'extent')]
    for b in flat['bends']:
        a = np.array(b['a'])
        z = np.array(b['b'])
        if abs(a[0] - z[0]) < 1e-3:
            x = a[0]
            if all(abs(x - t[1][0]) > .01 for t in hv):
                hv.append((x - lo[0], np.array([x, min(a[1], z[1])]), 'edge'))
        elif abs(a[1] - z[1]) < 1e-3:
            y = a[1]
            if all(abs(y - t[1][1]) > .01 for t in vv):
                vv.append((y - lo[1], np.array([min(a[0], z[0]), y]), 'edge'))
    v.hords = sorted(hv, key=lambda t: t[0])
    v.vords = sorted(vv, key=lambda t: t[0])
    iso = None
    g = p['geometry']
    spec = p.get('spec', {})
    k = spec.get('k_factor', .4)
    notes = [f"FLAT PATTERN - THK {g.get('thickness', 0):.2f} - K {k} ({'APPROVED' if spec.get('k_factor_approved') else 'PROVISIONAL'})",
             'LASER CUT FROM DXF - HOLES AS PER DXF']

    cache_inline = {}

    def extra(sh, scale, area, part):
        if part == 'view':
            bend_lines(sh)
            return
        bend_table(sh, area)

    def bend_lines(sh):
        """Bend lines with their note written along the line (DIRECTION ANGLE R) when every note fits clear of
        the outline, holes and the other notes; otherwise tag balloons (B1, B2 ...) that refer to the bend table."""
        from shapely.geometry import LineString, Polygon
        ds = dim_size()
        geo = [LineString([v.P(q) for q in seg]) for seg in v.vis if len(seg) > 1]
        placed, inline = [], []
        for b in flat['bends']:
            a = v.P(b['a'])
            z = v.P(b['b'])
            d = z - a
            L = float(np.linalg.norm(d))
            u = d / max(L, 1e-9)
            if u[0] < -1e-9 or (abs(u[0]) < 1e-9 and u[1] < 0):
                u = -u
                a, z = z, a
            nrm = np.array([-u[1], u[0]])
            label = f"{b.get('direction', '').upper()} {b['angle']:.0f}° R{b['radius']:.2f}".strip()
            w = text_width(label, ds, DIM_FONT)
            best = None
            for frac in (.5, .3, .7, .15, .85):
                for side in (1, -1):
                    c = a + u * (L * frac)
                    base = c + nrm * (.8 if side > 0 else -(.8 + DIM_H))
                    p0 = base - u * w / 2
                    poly = Polygon([p0, p0 + u * w, p0 + u * w + nrm * DIM_H, p0 + nrm * DIM_H]).buffer(.3)
                    if L * min(frac, 1 - frac) * 2 < w + 1:
                        continue
                    if any(poly.intersects(g) for g in geo) or any(poly.intersects(q) for q in placed):
                        continue
                    best = (base, poly)
                    break
                if best:
                    break
            inline.append((a, z, u, label, best))
            if best:
                placed.append(best[1])
        ok = all(t[4] for t in inline)
        from shapely.geometry import Point
        blank = Polygon([v.P(q) for q in outline]).buffer(0)
        bend_segs = [LineString([v.P(b2['a']), v.P(b2['b'])]) for b2 in flat['bends']]
        placed_tags = []
        R_TAG = 2.2
        cmap = CollisionMap(sh)   # ordinates, holes, outline already on the sheet

        def balloon(a, z, u, label):
            line = LineString([a, z])
            nrm = np.array([-u[1], u[0]])
            L = float(np.linalg.norm(z - a))
            cands = []
            for e, d in ((a, -u), (z, u)):
                for dist in (4.2, 6.5, 9.0):
                    cands.append((e + d * dist, e, .0))
            for frac in (.5, .3, .7, .15, .85):
                p = a + u * (L * frac)
                for side in (1, -1):
                    for dist in (4.2, 6.5, 9.0, 13.0, 18.0, 25.0, 35.0):
                        cands.append((p + nrm * side * dist, p, .3))
            best = None
            for c, foot, pref in cands:
                circ = Point(c).buffer(R_TAG + .4)
                lead = LineString([foot, c])
                cost = pref + .15 * float(np.linalg.norm(c - foot))
                if circ.intersects(blank):
                    cost += 25 + 40 * circ.intersection(blank).area / circ.area
                cost += sum(60 for t in placed_tags if circ.intersects(t))
                cost += sum(40 for sg in bend_segs if sg.distance(line) > 1e-6 and circ.intersects(sg))
                cost += sum(6 for sg in bend_segs if sg.distance(line) > 1e-6 and lead.crosses(sg))
                rr = (c[0] - R_TAG - .3, c[1] - R_TAG - .3, c[0] + R_TAG + .3, c[1] + R_TAG + .3)
                cost += 2.0 * cmap.rect_cost(rr) + .8 * cmap.seg_cost(tuple(foot), tuple(c - (c - foot) / max(np.linalg.norm(c - foot), 1e-9) * R_TAG))
                if best is None or cost < best[0]:
                    best = (cost, c, foot)
            _, c, foot = best
            dvec = c - foot
            dn = float(np.linalg.norm(dvec)) or 1.0
            dvec = dvec / dn
            sh.line(foot, c - dvec * R_TAG, THIN, 'BEND')
            sh.circle(foot, .35, THIN, 'BEND', fill=True)
            sh.circle(c, R_TAG, THIN, 'BEND')
            sh.text(c[0], c[1] - .9, label, 2.5, 'Helvetica', 'BEND', ha='c')
            for it in sh.items[-4:]:
                cmap.add_item(it)
            return Point(c).buffer(R_TAG + .6)
        for (a, z, u, label, best), b in zip(inline, flat['bends']):
            sh.line(a, z, THIN, 'BEND', dash=PHANTOM_DASH)
            if ok:
                ang = math.degrees(math.atan2(u[1], u[0]))
                sh.text(best[0][0], best[0][1], label, ds, DIM_FONT, 'BEND', rot=ang, ha='c')
                continue
            # crowded: a balloon tag (details in the bend table). It must read as belonging to THIS line:
            # outside the blank where possible, never on another bend line or tag, with a short leader
            # that touches the bend line itself.
            placed_tags.append(balloon(a, z, u, 'B' + str(int(b['id'][1:]))))
        cache_inline['inline'] = ok

    def bend_table(sh, area):
        # bend table (title-block style) in the top-right corner
        rows = [('TAG', 'DIRECTION', 'ANGLE', 'INNER R', 'OUTSIDE H')] + [
            ('B' + str(int(b['id'][1:])), b.get('direction', '?').upper(), f"{b['angle']:.1f}\u00b0", f"{b['radius']:.2f}",
             f"{b['outside_height']:.2f}" if b.get('outside_height') is not None else '-') for b in flat['bends'][:14]]
        cw = [12, 20, 16, 16, 20]
        rh = 4.6
        x0 = area[2] - sum(cw)
        ytop = area[3]
        for i, row in enumerate(rows):
            y = ytop - rh * (i + 1)
            x = x0
            for j, cell in enumerate(row):
                sh.text(x + cw[j] / 2, y + 1.3, cell, TB_SIZE, 'Helvetica-Bold' if i == 0 else 'Helvetica', 'TITLE', ha='c')
                x += cw[j]
            sh.line((x0, y), (x0 + sum(cw), y), THIN, 'TITLE')
        sh.line((x0, ytop), (x0 + sum(cw), ytop), THIN, 'TITLE')
        x = x0
        for c in cw + [0]:
            sh.line((x, ytop), (x, ytop - rh * len(rows)), THIN, 'TITLE')
            x += c
        sh.occupy((x0, ytop - rh * len(rows), x0 + sum(cw), ytop), 1.5)
    views = {'main': v}
    v.band_side = 'left'
    thk = float(g.get('thickness') or 0)
    if thk > 0:
        # edge view of the blank above the flat pattern: the sheet thickness the laser operator cuts from
        x0, x1 = float(lo[0]), float(hi[0])
        strip = [np.array([[x0, 0.0], [x1, 0.0]]), np.array([[x1, 0.0], [x1, thk]]), np.array([[x1, thk], [x0, thk]]), np.array([[x0, thk], [x0, 0.0]])]
        ev = View('top', (0, -1, 0), (1, 0, 0), {'visible': strip, 'hidden': []}, label='BLANK EDGE')
        ev.band_side = 'left'
        views['top'] = ev

        ev.thk = thk
    nrows = 1 + min(len(flat['bends']), 14)

    def reserve(sh, area):
        return [(area[2] - 84.0, area[3] - 4.6 * nrows, area[2], area[3])] if flat['bends'] else []
    return assemble(p, rev, settings, views, iso, [], [], notes, sheet_no, sheets, extra=extra, hidden=False,
                    reserve=reserve if flat['bends'] else None)


def build_sheets(shape, p, rev, settings, flat=None, pictorials=None, options=None):
    """All drawing sheets for one part: main sheet, flat pattern (formed sheet metal), and a pictorial sheet
    when the requested pictorial views do not fit beside the orthographic views."""
    cache = {'options': options or {}}
    views, iso, labels_proto, notes_proto, notes = machined_sheet(shape, p, rev, settings, cache, pictorials)
    table = cache.get('hole_table') or []
    size_opt = (options or {}).get('size', 'auto')
    sizes = (size_opt,) if size_opt in SHEETS else ('A4', 'A3', 'A2')
    sm = p.get('category') == 'sheet_metal'
    has_flat = sm and flat is not None and p['geometry'].get('bends')
    if sm and not flat and p['geometry'].get('bends'):
        notes = notes + ['FLAT PATTERN NOT DEVELOPED - ENGINEERING REVIEW']
    if sm:
        notes = notes + [f"SHEET METAL - LASER CUT - THK {p['geometry'].get('thickness', 0):.2f}"]
    gt = (p.get('spec') or {}).get('general_tolerance') or ((settings or {}).get('conventions') or {}).get('general_tolerance')
    if gt and not any('TOLERANC' in n.upper() for n in notes):
        notes = notes + ['GENERAL TOLERANCES: ' + str(gt).upper()[:40]]
    total = 2 if has_flat else 1
    main = assemble(p, rev, settings, views, iso, labels_proto, notes_proto, notes, 1, total, hidden=not sm, hole_table=table, sizes=sizes)
    # A part laid down for the landscape sheet must not cost an extra sheet: if it spills (pictorial or
    # hole table) and the model's natural orientation differs, keep whichever needs fewer sheets / reads larger.
    if main is not None and (main.overflow or getattr(main, 'table_overflow', False)):
        g0 = p['geometry']
        if not np.allclose(choose_main(g0, cache.get('holes', []), sm)[1], choose_main(g0, cache.get('holes', []), sm, landscape=False)[1]):
            alt_cache = {'options': options or {}, 'landscape': False}
            a_views, a_iso, a_labels, a_notes_proto, a_notes = machined_sheet(shape, p, rev, settings, alt_cache, pictorials)
            a_table = alt_cache.get('hole_table') or []
            alt = assemble(p, rev, settings, a_views, a_iso, a_labels, a_notes_proto, notes, 1, total, hidden=not sm, hole_table=a_table, sizes=sizes)
            spill = lambda sh: (1 if sh.overflow else 0) + (1 if getattr(sh, 'table_overflow', False) else 0)
            if alt is not None and (spill(alt), -alt.meta['scale']) < (spill(main), -main.meta['scale']):
                main, views, cache, table, iso, labels_proto, notes_proto = alt, a_views, alt_cache, a_table, a_iso, a_labels, a_notes_proto
    extra_pages = (1 if main is not None and main.overflow else 0) + (1 if main is not None and getattr(main, 'table_overflow', False) else 0)
    if extra_pages:
        total += extra_pages
        main = assemble(p, rev, settings, views, iso, labels_proto, notes_proto, notes, 1, total, hidden=not sm, hole_table=table, sizes=sizes)
    sheets = [main]
    if main is not None:
        main.frame = cache.get('frame')
    if has_flat:
        sheets.append(flat_sheet(p, rev, settings, flat, None, 2, total))
    if main is not None and getattr(main, 'table_overflow', False):
        sheets.append(table_sheet(p, rev, settings, table, main.meta['scale'], main.size, len(sheets) + 1, total))
    if main is not None and main.overflow:
        sheets.append(pictorial_sheet(p, rev, settings, main.overflow, main.meta['scale'], main.size, len(sheets) + 1, total))
    return [s for s in sheets if s is not None]


def table_sheet(p, rev, settings, rows, scale, size, sheet_no, sheets):
    sh = Sheet(size)
    tb = title_values(p, rev, settings, sheet_no, sheets, scale, size)
    title_top = draw_template(sh, tb)
    area = (10.0, title_top + 6.0, sh.w - 10.0, sh.h - 10.0)
    lay = hole_table_layout(rows, area[3] - area[1] - 4, len({r['view'] for r in rows}) > 1)
    sh.sg = 'view:holetable'
    draw_hole_table(sh, lay, area[0] + 2, area[3] - 2)
    sh.sg = None
    sh.view_meta['view:holetable'] = {'title': 'HOLE TABLE'}
    sh.meta = {'scale': scale, 'size': size}
    return sh


def pictorial_sheet(p, rev, settings, pviews, scale, size, sheet_no, sheets):
    """Extra sheet holding pictorial views in a grid, each labelled, at a common scale where possible."""
    sh = Sheet(size)
    tb = title_values(p, rev, settings, sheet_no, sheets, scale, size)
    title_top = draw_template(sh, tb)
    stamp = draft_stamp(p, rev)
    if stamp:
        sh.text(sh.w - 8.5, title_top + 1.4, stamp, TB_SIZE, 'Helvetica-Bold', 'NOTES', ha='r')
    area = (10.0, title_top + 8.0, sh.w - 10.0, sh.h - 10.0)
    n = len(pviews)
    cols = int(math.ceil(math.sqrt(n)))
    rows = int(math.ceil(n / cols))
    cw = (area[2] - area[0]) / cols
    rh = (area[3] - area[1]) / rows
    fits = []
    for i, pv in enumerate(pviews):
        r_, c_ = divmod(i, cols)
        cell = (area[0] + c_ * cw + 4, area[3] - (r_ + 1) * rh + 9, area[0] + (c_ + 1) * cw - 4, area[3] - r_ * rh - 4)
        want = pv.pdef.get('scale')
        fits.append((pv, cell, want))
    common = min(min((c[2] - c[0]) / pv.span[0], (c[3] - c[1]) / pv.span[1]) for pv, c, _ in fits)
    common = max([s for s in SCALES if s <= common] or [common])
    for pv, cell, want in fits:
        s_used = fit_box(pv, cell, want or common)
        sh.sg = 'view:' + pv.name
        draw_view_geometry(sh, pv, False, 'VISIBLE')
        box = pv.paper_box()
        sh.text((box[0] + box[2]) / 2, box[1] - 6.0, f"{pv.label.upper()}  ({scale_label(s_used)})", TB_SIZE, 'Helvetica', 'NOTES', ha='c')
        sh.sg = None
        sh.view_meta['view:' + pv.name] = {'title': pv.label or 'PICTORIAL', 'pictorial': pv.name, 'scale_used': round(s_used, 4)}
    sh.meta = {'scale': scale, 'size': size}
    return sh


def draft_stamp(p, rev):
    return ''  # drawings carry no draft/NFM stamp; release status lives in Forge


def _unused_draft_stamp(p, rev):
    if p.get('excluded'):
        return 'NOT FOR PRODUCTION - EXCLUDED FROM THIS REVISION'
    if rev.get('status') != 'released':
        return 'DRAFT - NOT FOR MANUFACTURE'
    return ''


# --------------------------------------------------------------------------------------------- PDF
def _draw_symbol(c, ch, x, size, font):
    """Vector drafting symbols at baseline x (points, canvas already in text space)."""
    cap = CAP.get(font, .7) * size
    w = sym_width(size, font)
    p = c.beginPath()
    if ch == DEPTH:
        xm = x + w / 2
        p.moveTo(xm, cap)
        p.lineTo(xm, 0)
        p.moveTo(xm - w * .3, cap * .38)
        p.lineTo(xm, 0)
        p.lineTo(xm + w * .3, cap * .38)
        p.moveTo(x + w * .12, 0)
        p.lineTo(x + w * .88, 0)
    elif ch == CSK:
        p.moveTo(x + w * .1, cap * .9)
        p.lineTo(x + w / 2, 0)
        p.lineTo(x + w * .9, cap * .9)
    elif ch == CBORE:
        p.moveTo(x + w * .12, cap * .85)
        p.lineTo(x + w * .12, 0)
        p.lineTo(x + w * .88, 0)
        p.lineTo(x + w * .88, cap * .85)
    c.drawPath(p, stroke=1, fill=0)
    return w


def _group(c, gid, kind, **meta):
    from .drawing_scene import group
    return group(c, gid, kind, **meta)


def draw_text_pt(c, x, y, s, size, font, ha='l'):
    """Text with vector drafting symbols; x, y, size in points (baseline, current transform)."""
    w = text_width(s, size, font)
    x = {'l': x, 'c': x - w / 2, 'r': x - w}[ha]
    c.setLineWidth(THIN * mm * .8)
    c.setDash([])
    run = ''
    for ch in s + '\0':
        if ch in SYMBOLS or ch == '\0':
            if run:
                c.setFont(font, size)
                c.drawString(x, y, run)
                x += pdfmetrics.stringWidth(run, font, size)
                run = ''
            if ch in SYMBOLS:
                c.saveState()
                c.translate(x, y)
                x += _draw_symbol(c, ch, 0, size, font)
                c.restoreState()
        else:
            run += ch


def paint_callout(c, g, lines, dx=0.0, dy=0.0, px=0.0, py=0.0):
    """GOAT leader note in points: arrow on the feature, leader to the nearer shoulder end, text on the shoulder.
    (dx, dy) moves the note, (px, py) moves the owning view (the feature end of the leader follows it)."""
    font = g.get('font', DIM_FONT)
    size = g['size']
    pitch = g['pitch']
    lines = [l for l in lines] or ['']
    w = max(text_width(l, size, font) for l in lines) + 1.0 * mm
    x0, _, x1, _ = g['bounds']
    left = (x0 + x1) / 2 > g['center'][0]
    bx = x0 + dx if left else x1 + dx - w
    by = g['shoulder_y'] + dy
    cx, cy = g['center'][0] + px, g['center'][1] + py
    ax, ay = (bx, by) if (bx + w / 2) > cx else (bx + w, by)
    vx, vy = ax - cx, ay - cy
    d = math.hypot(vx, vy) or 1.0
    r = g.get('radius', 0)
    tx, ty = cx + vx / d * r, cy + vy / d * r
    c.saveState()
    c.setStrokeColorRGB(0, 0, 0)
    c.setFillColorRGB(0, 0, 0)
    c.setDash([])
    c.setLineWidth(THIN * mm)
    c.line(ax, ay, tx, ty)
    c.line(bx, by, bx + w, by)
    ux, uy = (tx - ax) / (math.hypot(tx - ax, ty - ay) or 1), (ty - ay) / (math.hypot(tx - ax, ty - ay) or 1)
    L, W2 = ARROW_L * mm, ARROW_W * mm / 2
    p = c.beginPath()
    p.moveTo(tx, ty)
    p.lineTo(tx - ux * L - uy * W2, ty - uy * L + ux * W2)
    p.lineTo(tx - ux * L + uy * W2, ty - uy * L - ux * W2)
    p.close()
    c.drawPath(p, stroke=0, fill=1)
    n = len(lines)
    right_aligned = ax > bx + w / 2
    for k, line in enumerate(lines):
        yy = by + .9 * mm + pitch * (n - 1 - k)
        knockout(c, bx + w - .5 * mm if right_aligned else bx + .5 * mm, yy, text_width(line, size, font), size, 'r' if right_aligned else 'l')
        if right_aligned:
            draw_text_pt(c, bx + w - .5 * mm, yy, line, size, font, 'r')
        else:
            draw_text_pt(c, bx + .5 * mm, yy, line, size, font, 'l')
    c.restoreState()


def knockout(c, x, y, w, size, ha='l'):
    """White ground behind a text run (current transform, points) so crossing lines never run through it."""
    x = {'l': x, 'c': x - w / 2, 'r': x - w}[ha]
    c.saveState()
    c.setFillColorRGB(1, 1, 1)
    c.rect(x - .25 * mm, y - .22 * size, w + .5 * mm, size * .98, stroke=0, fill=1)
    c.restoreState()


def _paint_item(c, it, ground=False):
    k = it['k']
    if k == 'poly':
        c.setLineWidth(it['w'] * mm)
        c.setDash([d * mm for d in it['dash']] if it['dash'] else [])
        pts = it['pts']
        path = c.beginPath()
        path.moveTo(pts[0][0] * mm, pts[0][1] * mm)
        for q in pts[1:]:
            path.lineTo(q[0] * mm, q[1] * mm)
        if it['closed']:
            path.close()
        c.drawPath(path, stroke=1, fill=0)
    elif k == 'circle':
        c.setDash([])
        c.setLineWidth(it['w'] * mm)
        c.circle(it['c'][0] * mm, it['c'][1] * mm, it['r'] * mm, stroke=1, fill=1 if it['fill'] else 0)
    elif k == 'tri':
        c.setDash([])
        path = c.beginPath()
        q = it['pts']
        path.moveTo(q[0][0] * mm, q[0][1] * mm)
        path.lineTo(q[1][0] * mm, q[1][1] * mm)
        path.lineTo(q[2][0] * mm, q[2][1] * mm)
        path.close()
        c.drawPath(path, stroke=0, fill=1)
    elif k == 'text':
        c.saveState()
        c.translate(it['x'] * mm, it['y'] * mm)
        c.rotate(it['rot'])
        if it['hscale'] != 1.0:
            c.scale(it['hscale'], 1)
        if ground:
            knockout(c, 0, 0, text_width(it['s'], it['size'], it['font']) * mm, it['size'] * mm, it['ha'])
        draw_text_pt(c, 0, 0, it['s'], it['size'] * mm, it['font'], it['ha'])
        c.restoreState()


def render_pdf(sh, c):
    """Paint one sheet. On a SceneCanvas every view (geometry + its ordinates) becomes a movable 'view' group
    and every leader note a 'callout' group nested in its view, for the drawing editor."""
    c.setPageSize((sh.w * mm, sh.h * mm))
    c.setLineJoin(1)
    c.setLineCap(0)
    c.setStrokeColorRGB(0, 0, 0)
    c.setFillColorRGB(0, 0, 0)
    order = []
    buckets = {}
    for it in sh.items:
        if it['k'] == 'labelrect':
            continue
        sg = it.get('sg')
        if sg not in buckets:
            buckets[sg] = []
            order.append(sg)
        buckets[sg].append(it)
    for it in buckets.get(None, []):
        _paint_item(c, it)
    titles = {'main': 'MAIN', 'top': 'TOP', 'bottom': 'BOTTOM', 'left': 'LEFT', 'right': 'RIGHT', 'rear': 'REAR', 'iso': 'ISOMETRIC'}
    done = set()
    for sg in order:
        if sg is None or not sg.startswith('view:'):
            continue
        meta = dict(sh.view_meta.get(sg, {}))
        if getattr(sh, 'meta', None) and sh.meta.get('scale'):
            meta.setdefault('scale_used', round(float(sh.meta['scale']), 4))
        title = meta.pop('title', None) or titles.get(sg[5:], sg[5:].upper())
        with _group(c, sg, 'view', title=title, **meta):
            # lines first, then dimension text on a white ground (ISO 129: lines must not cross dimension values)
            for it in buckets[sg]:
                if it['k'] != 'text':
                    _paint_item(c, it)
            for it in buckets[sg]:
                if it['k'] == 'text':
                    _paint_item(c, it, ground=it.get('layer') == 'DIM')
            for cid, meta in sh.callouts.items():
                if meta['view'] == sg:
                    with _group(c, cid, 'callout', **meta):
                        paint_callout(c, meta, meta['lines'])
                    done.add(cid)
    for cid, meta in sh.callouts.items():
        if cid not in done:
            with _group(c, cid, 'callout', **meta):
                paint_callout(c, meta, meta['lines'])
    c.setDash([])
    c.showPage()


# --------------------------------------------------------------------------------------------- DXF
def write_dxf(sheets, path):
    import ezdxf
    from ezdxf.enums import TextEntityAlignment
    doc = ezdxf.new('R2013', setup=True)
    doc.units = 4
    doc.header['$LWDISPLAY'] = 1
    doc.header['$MEASUREMENT'] = 1
    for name, color, lw, lt in [('FRAME', 7, 25, 'Continuous'), ('TITLE', 7, 18, 'Continuous'), ('VISIBLE', 7, 25, 'Continuous'),
                                ('HIDDEN', 8, 18, 'DASHED'), ('DIM', 7, 18, 'Continuous'), ('NOTES', 7, 18, 'Continuous'), ('BEND', 3, 18, 'PHANTOM'), ('CENTER', 7, 13, 'CENTER')]:
        if name not in doc.layers:
            doc.layers.add(name, color=color, linetype=lt if lt in doc.linetypes else 'Continuous', lineweight=lw)
    for nm, font in [('GOAT_DIM', 'GOTHIC.TTF'), ('GOAT_TB', 'arial.ttf'), ('GOAT_TB_BOLD', 'arialbd.ttf'), ('GOAT_CO', 'arialbi.ttf')]:
        doc.styles.add(nm, font=font)
    ds = doc.dimstyles.duplicate_entry('EZDXF', 'GOAT_ORD')
    ds.dxf.dimtxt = DIM_H
    ds.dxf.dimtxsty = 'GOAT_DIM'
    ds.dxf.dimdec = 2
    ds.dxf.dimzin = 0
    ds.dxf.dimgap = 1.3
    ds.dxf.dimexo = 0
    ds.dxf.dimasz = ARROW_L
    ds.dxf.dimtad = 0
    ds.dxf.dimlwd = 18
    ds.dxf.dimlwe = 18
    msp = doc.modelspace()
    fontstyle = {DIM_FONT: 'GOAT_DIM', 'Helvetica': 'GOAT_TB', 'Helvetica-Bold': 'GOAT_TB_BOLD', 'Helvetica-BoldOblique': 'GOAT_CO'}
    xoff = 0.0
    for sh in sheets:
        O = np.array([xoff, 0.0])
        written = set()
        for d in sh.dims:
            if d['axis'] in ('x', 'y'):
                try:
                    f = np.array(d['feature']) + O
                    lead = np.array(d['leader']) + O
                    org = np.array(d['origin']) + O
                    # measured value (x from a left origin) stays associative ('<>'); values measured from a right
                    # or top origin would read negative, so those carry their value as dimension text
                    assoc = not d.get('origin_right')
                    txt = '0' if abs(d['value']) < .005 else ('<>' if assoc else fmt(d['value']))
                    attrs = dict(feature_location=tuple(f), offset=tuple(lead - f), origin=tuple(org), text=txt, dimstyle='GOAT_ORD',
                                 override={'dimlfac': 1.0 / d['scale']}, dxfattribs={'layer': 'DIM'})
                    dim = msp.add_ordinate_x_dim(**attrs) if d['axis'] == 'x' else msp.add_ordinate_y_dim(**attrs)
                    dim.render()
                    written.add(d['grp'])
                except Exception:
                    pass
        note_groups = {d['grp']: d for d in sh.dims if d['axis'] == 'note'}
        done_notes = set()
        for it in sh.items:
            k = it['k']
            if k == 'labelrect':
                continue
            grp = it.get('grp')
            if grp in note_groups and k == 'text':
                if grp in done_notes:
                    continue
                d = note_groups[grp]
                done_notes.add(grp)
                txt = '\\P'.join(dxf_symbols(s) for s in d['lines'])
                mt = msp.add_mtext(txt, dxfattribs={'layer': 'DIM', 'style': 'GOAT_DIM', 'char_height': DIM_H, 'line_spacing_factor': d['pitch'] / (DIM_H * 1.667)})
                mt.set_location((d['at'][0] + xoff, d['at'][1]), attachment_point=7 if d['left'] else 9)
                continue
            if grp in written:
                continue  # extension line / value regenerated by the DIMENSION entity
            if k == 'poly':
                pts = [(x + xoff, y) for x, y in it['pts']]
                msp.add_lwpolyline(pts, close=it['closed'], dxfattribs={'layer': it['layer']})
            elif k == 'circle':
                msp.add_circle((it['c'][0] + xoff, it['c'][1]), it['r'], dxfattribs={'layer': it['layer']})
            elif k == 'tri':
                q = [(x + xoff, y) for x, y in it['pts']]
                msp.add_solid([q[0], q[1], q[2], q[2]], dxfattribs={'layer': it['layer']})
            elif k == 'text':
                t = msp.add_text(dxf_symbols(it['s']), height=it['size'] * CAP.get(it['font'], .7),
                                 rotation=it['rot'], dxfattribs={'layer': it['layer'], 'style': fontstyle.get(it['font'], 'GOAT_TB'), 'width': it['hscale']})
                align = {'l': TextEntityAlignment.LEFT, 'c': TextEntityAlignment.CENTER, 'r': TextEntityAlignment.RIGHT}[it['ha']]
                t.set_placement((it['x'] + xoff, it['y']), align=align)
        xoff += sh.w + 30.0
    doc.saveas(path)


def dxf_symbols(s):
    return (s.replace('Ø', '%%c').replace('°', '%%d').replace('±', '%%p')
            .replace(DEPTH, '{\\Fgdt;x}').replace(CSK, '{\\Fgdt;w}').replace(CBORE, '{\\Fgdt;v}'))


# --------------------------------------------------------------------------------------------- set cover
def cover_sheets(title, rev, parts, settings):
    """Index sheet(s) for a combined drawing set, in the same A4 frame as the part drawings."""
    tb = dict(DEFAULT_TITLE)
    tb.update(((settings or {}).get('drawing') or {}))
    rows_per = 30
    chunks = [parts[i:i + rows_per] for i in range(0, max(len(parts), 1), rows_per)] or [[]]
    out = []
    cols = [(12, '#', 'l'), (22, 'DWG NO', 'l'), (62, 'TITLE', 'l'), (150, 'QTY', 'r'), (158, 'MATERIAL', 'l'), (200, 'TREATMENT', 'l'), (250, 'CATEGORY', 'l')]
    n = 0
    for k, chunk in enumerate(chunks):
        sh = Sheet('A4')
        W, H = sh.w, sh.h
        sh.poly([(1, 1), (W - 1, 1), (W - 1, H - 1), (1, H - 1)], THICK, 'FRAME', closed=True)
        sh.poly([(6, 6), (W - 6, 6), (W - 6, H - 6), (6, H - 6)], THICK, 'FRAME', closed=True)
        sh.text(12, H - 18, tb['company'], 4.23, 'Helvetica-BoldOblique', 'TITLE')
        sh.text(12, H - 26, title.upper(), 5.0, 'Helvetica-Bold', 'TITLE')
        status = 'RELEASED' if rev.get('status') == 'released' else 'DRAFT - NOT FOR MANUFACTURE'
        sh.text(12, H - 32, f"REVISION {rev.get('number', '')}  |  {rev.get('filename', '')}  |  {len(parts)} PARTS  |  {status}  |  SHEET {k + 1} OF {len(chunks)}", TB_SIZE, 'Helvetica', 'TITLE')
        y = H - 42
        for x, t, ha in cols:
            sh.text(x + (6 if ha == 'r' else 0), y, t, TB_SIZE, 'Helvetica-Bold', 'TITLE', ha=ha)
        sh.line((10, y - 1.6), (W - 10, y - 1.6), THIN, 'TITLE')
        y -= 6
        for p in chunk:
            n += 1
            s = p.get('spec', {})
            name = clean_name(p['name'])
            num = s.get('part_number') or part_number(name) or ''
            mat = s.get('material') or 'UNSPECIFIED'
            if p.get('category') == 'sheet_metal' and p['geometry'].get('thickness'):
                mat += f" {p['geometry']['thickness']:.2f} THK"
            vals = [str(n), num, name, str(p.get('quantity', 1)), mat, ' + '.join(x for x in [s.get('finish'), s.get('paint')] if x) or '-',
                    p.get('category', '').replace('_', ' ').upper()]
            widths = [9, 38, 86, 6, 40, 48, 30]
            for (x, _, ha), v, wmax in zip(cols, vals, widths):
                hs = min(1.0, wmax / max(text_width(v, TB_SIZE, 'Helvetica'), 1e-6))
                sh.text(x + (6 if ha == 'r' else 0), y, v, TB_SIZE, 'Helvetica', 'TITLE', ha=ha, hscale=hs)
            sh.line((10, y - 1.7), (W - 10, y - 1.7), THIN * .7, 'TITLE')
            y -= 5.2
        out.append(sh)
    return out


def pictorial_lines(shape, frame, azimuth, elevation):
    """Visible edges of a pictorial view (model mm, 2D) for views dropped on a sheet in the editor."""
    n0, up0 = frame
    d, r = pictorial_defs.frame(n0, up0, azimuth, elevation, 0)
    lines = hlr(shape, d, r, hidden=False)['visible']
    out = []
    for seg in lines:
        a = np.round(np.asarray(seg), 3)
        # drop near-duplicate points to keep the payload small
        keep = [a[0]] + [q for i, q in enumerate(a[1:-1], 1) if np.abs(q - a[i - 1]).max() > .02] + [a[-1]]
        out.append(np.asarray(keep).tolist())
    pts = np.vstack([np.asarray(l) for l in out]) if out else np.zeros((1, 2))
    return {'lines': out, 'lo': pts.min(0).tolist(), 'hi': pts.max(0).tolist()}
