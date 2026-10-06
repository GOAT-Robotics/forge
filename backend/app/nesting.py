"""True-shape nesting of flat patterns onto stock sheets, for the laser.

Parts are grouped by material and thickness. Every flat pattern (outline with its holes, the same geometry the flat
DXF is cut from) is turned to its tightest bounding rectangle; boxy parts are tried at quarter turns, irregular ones
(arcs, L shapes) every 15 degrees. The sheet is a raster occupancy grid: a part's footprint is its outline grown by
half the spacing plus half a cell diagonal, so a grid placement never brings two cuts closer than the spacing. Free
positions come from an FFT correlation of the grid with the footprint (holes stay free, so small parts sit inside
the cut-outs of big ones). A placement keeps the used length of the sheet where possible (leftmost, then lowest),
else grows it least; then the part is slid left and down on the exact geometry until it meets its neighbours at
exactly the spacing. Several part orders (by area, longest side, shortest side, envelope, then local swaps) are tried
within a time budget; the layout with the fewest sheets and the shortest used length (largest remnant) wins.
Output: one DXF per sheet (CUT / BEND / LABEL / SHEET layers), a combined DXF per material, a summary PDF and a JSON
summary with previews.
"""
import io
import json
import math
import re
import time
import zipfile
import numpy as np
import shapely
from shapely import affinity
from shapely.geometry import Polygon, LineString, box


try:   # pocketfft through scipy is threaded and works in float32; numpy is the fallback
    import scipy.fft as _sf
    _rfft2 = lambda a, s: _sf.rfft2(a, s, workers=-1)
    _irfft2 = lambda a, s: _sf.irfft2(a, s, workers=-1)
except ImportError:
    _rfft2, _irfft2 = np.fft.rfft2, np.fft.irfft2


def _slug(s):
    return re.sub(r'[^A-Za-z0-9]+', '-', s).strip('-')[:60] or 'material'


class Shape:
    """One flat pattern, pre-turned to its tightest bounding rectangle (long side along X)."""

    def __init__(self, key, label, outline, holes, bends, qty):
        poly = Polygon(outline, [h for h in holes if len(h) >= 3]).buffer(0)
        if poly.geom_type != 'Polygon':
            poly = max(getattr(poly, 'geoms', [poly]), key=lambda g: g.area)
        mrr = poly.minimum_rotated_rectangle
        c = np.array(mrr.exterior.coords)[:4]
        e = [c[1] - c[0], c[2] - c[1]]
        long = e[0] if np.linalg.norm(e[0]) >= np.linalg.norm(e[1]) else e[1]
        self.base_angle = -math.degrees(math.atan2(long[1], long[0]))
        self.key, self.label, self.qty = key, label, int(qty)
        self.poly = affinity.rotate(poly, self.base_angle, origin=(0, 0))
        self.bends = [affinity.rotate(LineString([b['a'], b['b']]), self.base_angle, origin=(0, 0)) for b in bends]
        self.area = poly.area

    def turned(self, angle):
        """(polygon, bend lines) turned by angle (multiple of 90) and moved to the origin."""
        p = affinity.rotate(self.poly, angle, origin=(0, 0))
        bl = [affinity.rotate(b, angle, origin=(0, 0)) for b in self.bends]
        x0, y0 = p.bounds[0], p.bounds[1]
        return affinity.translate(p, -x0, -y0), [affinity.translate(b, -x0, -y0) for b in bl]


def _raster(poly, cell, grow):
    """Footprint mask of a polygon grown by `grow` (cells whose centre is inside the grown outline)."""
    g = poly.buffer(grow, join_style=1)
    x0, y0, x1, y1 = g.bounds
    nx, ny = max(1, int(math.ceil((x1 - x0) / cell))), max(1, int(math.ceil((y1 - y0) / cell)))
    xs = x0 + (np.arange(nx) + .5) * cell
    ys = y0 + (np.arange(ny) + .5) * cell
    X, Y = np.meshgrid(xs, ys)
    m = shapely.contains_xy(g, X.ravel(), Y.ravel()).reshape(ny, nx)
    return m.astype(np.float32), (x0, y0)


class Sheet:
    """Raster occupancy of one stock sheet plus the exact placed outlines."""

    def __init__(self, W, H, cell, border, pad, gap, margin, grow):
        self.W, self.H, self.cell, self.gap, self.margin, self.grow = W, H, cell, gap, margin, grow
        self.ny, self.nx = int(math.ceil(H / cell)), int(math.ceil(W / cell))
        self.occ = np.zeros((self.ny, self.nx), np.float32)
        b = int(math.ceil(border / cell))
        if b:
            self.occ[:b, :] = self.occ[-b:, :] = 1
            self.occ[:, :b] = self.occ[:, -b:] = 1
        self.shape = (self.ny + pad[0], self.nx + pad[1])
        self.placed = []
        self.extent = 0          # columns in use (the used length of the sheet, in cells)
        self._F = None

    def occupy(self, poly):
        """Mark the footprint of a placed outline (grown by half the spacing and a cell) on the grid."""
        g = poly.buffer(self.grow, join_style=1)
        x0, y0, x1, y1 = g.bounds
        j0, i0 = max(0, int(x0 // self.cell)), max(0, int(y0 // self.cell))
        j1, i1 = min(self.nx, int(math.ceil(x1 / self.cell))), min(self.ny, int(math.ceil(y1 / self.cell)))
        if j1 <= j0 or i1 <= i0:
            return
        X, Y = np.meshgrid((np.arange(j0, j1) + .5) * self.cell, (np.arange(i0, i1) + .5) * self.cell)
        m = shapely.contains_xy(g, X.ravel(), Y.ravel()).reshape(i1 - i0, j1 - j0)
        self.occ[i0:i1, j0:j1] = np.maximum(self.occ[i0:i1, j0:j1], m)
        self.extent = max(self.extent, int(math.ceil(poly.bounds[2] / self.cell)))
        self._F = None

    def candidates(self, Fm, mh, mw):
        """Best free cell offset for a footprint: keep the used length if possible (leftmost, then lowest), else
        grow it as little as possible. Returns ((new_extent, j, i), (i, j)) or None."""
        if mh > self.ny or mw > self.nx:
            return None
        if self._F is None:   # one transform of the grid serves every footprint tried until the next placement
            self._F = _rfft2(self.occ, self.shape)
        C = _irfft2(self._F * Fm, self.shape)[: self.ny - mh + 1, : self.nx - mw + 1]
        ok = C < .5
        cols = np.nonzero(ok.any(axis=0))[0]
        if not len(cols):
            return None
        inside = cols[cols + mw <= self.extent]
        j = int(inside[0] if len(inside) else cols[0])
        i = int(np.nonzero(ok[:, j])[0][0])
        return (max(self.extent, j + mw), j, i), (i, j)

    def fits(self, poly):
        """Exact check: inside the margins and at least the spacing from every placed part."""
        x0, y0, x1, y1 = poly.bounds
        m = self.margin - 1e-6
        if x0 < m or y0 < m or x1 > self.W - m or y1 > self.H - m:
            return False
        g = self.gap - 1e-6
        for q in self.placed:
            b = q['bbox']
            if b[0] - g > x1 or b[2] + g < x0 or b[1] - g > y1 or b[3] + g < y0:
                continue
            if q['poly'].distance(poly) < g:
                return False
        return True

    def compact(self, poly):
        """Slide a raster-placed part left and down onto its neighbours (exact geometry): the raster is
        conservative by about a cell, this takes the slack out."""
        moved = (0.0, 0.0)
        for _ in range(2):
            for d in ((-1.0, 0.0), (0.0, -1.0)):
                lo, hi = 0.0, 4 * self.cell
                if self.fits(affinity.translate(poly, d[0] * hi, d[1] * hi)):
                    lo = hi
                else:
                    for _k in range(7):
                        mid = (lo + hi) / 2
                        if self.fits(affinity.translate(poly, d[0] * mid, d[1] * mid)):
                            lo = mid
                        else:
                            hi = mid
                if lo > 1e-3:
                    poly = affinity.translate(poly, d[0] * lo, d[1] * lo)
                    moved = (moved[0] + d[0] * lo, moved[1] + d[1] * lo)
        return poly, moved


def _rotations(s, rotate):
    """Angles to try: quarter turns for boxy parts, 15 degree steps for irregular ones (arcs, L shapes), whose
    best fit is rarely axis-aligned."""
    if not rotate:
        return (0,)
    boxy = s.poly.area / max(s.poly.envelope.area, 1e-9) > .75
    return (0, 90, 180, 270) if boxy else tuple(range(0, 360, 15))


def _nest_once(shapes, order, variants, W, H, gap, margin, cell, grow, border, pad, ffts, deadline):
    sheets, unplaced = [], []
    for s in order:
        if time.time() > deadline:
            return None
        if not any(v['mask'].shape[0] * cell <= H and v['mask'].shape[1] * cell <= W for v in variants[s.key]):
            unplaced.append({'key': s.key, 'label': s.label, 'reason': 'larger than the sheet'})
            continue
        done = False
        for sheet in sheets + [None]:
            if sheet is None:
                sheet = Sheet(W, H, cell, border, pad, gap, margin, grow)
                sheets.append(sheet)
            best = None
            for vi, v in enumerate(variants[s.key]):
                k = (s.key, vi, sheet.shape)
                if k not in ffts:
                    ffts[k] = np.conj(_rfft2(v['mask'], sheet.shape))
                r = sheet.candidates(ffts[k], *v['mask'].shape)
                if r and (best is None or r[0] < best[0]):
                    best = (r[0], r[1], v)
            if best:
                _, (i, j), v = best
                dx, dy = j * cell - v['off'][0], i * cell - v['off'][1]
                poly, (mx, my) = sheet.compact(affinity.translate(v['poly'], dx, dy))
                sheet.placed.append({'key': s.key, 'label': s.label, 'angle': (v['angle'] + s.base_angle) % 360, 'poly': poly, 'bbox': poly.bounds,
                                     'bends': [affinity.translate(b, dx + mx, dy + my) for b in v['bends']]})
                sheet.occupy(poly)
                done = True
                break
            if not sheet.placed:   # a fresh sheet that cannot take it: nothing will
                sheets.remove(sheet)
                break
        if not done:
            unplaced.append({'key': s.key, 'label': s.label, 'reason': 'no room found'})
    return sheets, unplaced


def _score(result, W):
    sheets, unplaced = result
    used = [max((p['bbox'][2] for p in sh.placed), default=0) for sh in sheets]
    # fewer parts left out, fewer sheets, then the shortest used length (the longest remnant)
    return (len(unplaced), len(sheets), sum(used[:-1]) / max(W, 1) + (used[-1] if used else 0))


def nest_group(shapes, W, H, gap, margin, rotations=(0, 90, 180, 270), budget=40.0, progress=None):
    """Place all copies of `shapes` on as few W x H sheets as possible, then on the shortest length of the last
    sheet. Several part orders are tried within the time budget; the best layout wins. Returns (sheets, unplaced)."""
    import random
    cell = max(1.0, min(6.0, math.sqrt(W * H / 300000.0)))
    grow = gap / 2 + cell * .72          # half spacing + half a cell diagonal: no grid conflict, no real clash
    border = max(0.0, margin - gap / 2)
    rotate = len(rotations) > 1
    variants, pad = {}, [1, 1]
    for s in shapes:
        vs, seen = [], []
        for a in (_rotations(s, rotate) if rotate else rotations):
            poly, bl = s.turned(a)
            m, (ox, oy) = _raster(poly, cell, grow)
            if any(m.shape == q.shape and np.array_equal(m, q) for q in seen):
                continue   # symmetric: the same footprint
            seen.append(m)
            vs.append({'angle': a, 'poly': poly, 'bends': bl, 'mask': m, 'off': (ox, oy)})
            pad = [max(pad[0], m.shape[0]), max(pad[1], m.shape[1])]
        variants[s.key] = vs
    copies = lambda key: [s for s in key for _ in range(s.qty)]
    dims = {s.key: (s.poly.bounds[2] - s.poly.bounds[0], s.poly.bounds[3] - s.poly.bounds[1]) for s in shapes}
    orders = [
        copies(sorted(shapes, key=lambda s: -s.area)),
        copies(sorted(shapes, key=lambda s: -max(dims[s.key]))),
        copies(sorted(shapes, key=lambda s: -min(dims[s.key]))),
        copies(sorted(shapes, key=lambda s: -s.poly.envelope.area)),
    ]
    rng = random.Random(7)
    t0 = time.time()
    deadline = t0 + budget
    ffts, best, k = {}, None, 0
    while True:
        if k < len(orders):
            order = orders[k]
        else:   # local search: swap a few neighbours in the best order so far
            order = list(best[2])
            for _ in range(max(1, len(order) // 15)):
                i = rng.randrange(max(1, len(order) - 1))
                j = min(len(order) - 1, i + rng.randint(1, 4))
                order[i], order[j] = order[j], order[i]
        start = time.time()
        res = _nest_once(shapes, order, variants, W, H, gap, margin, cell, grow, border, (pad[0], pad[1]), ffts, deadline if best else float('inf'))
        k += 1
        if res is not None:
            sc = _score(res, W)
            if best is None or sc < best[0]:
                best = (sc, res, order)
        if progress:
            progress(min(1.0, (time.time() - t0) / budget), 1)
        took = time.time() - start
        if time.time() + took > deadline or k >= 40:
            break
    sheets, unplaced = best[1]
    return sheets, unplaced


# ------------------------------------------------------------------------------------------------ output
def _dxf(sheets_geo, W, H, title):
    """One DXF with the given sheets side by side (index, placements)."""
    import ezdxf
    d = ezdxf.new('R2013')
    d.units = 4
    for name, color in (('SHEET', 8), ('CUT', 7), ('BEND', 3), ('LABEL', 2)):
        d.layers.new(name, dxfattribs={'color': color})
    m = d.modelspace()
    for k, (n, placed) in enumerate(sheets_geo):
        ox = k * (W + 100)
        m.add_lwpolyline([(ox, 0), (ox + W, 0), (ox + W, H), (ox, H)], close=True, dxfattribs={'layer': 'SHEET'})
        m.add_text(f'{title} - SHEET {n}', dxfattribs={'layer': 'LABEL', 'height': 12, 'insert': (ox, H + 15)})
        for p in placed:
            poly = affinity.translate(p['poly'], ox, 0)
            for ring in [poly.exterior, *poly.interiors]:
                m.add_lwpolyline(list(ring.coords), close=True, dxfattribs={'layer': 'CUT'})
            for b in p['bends']:
                for seg in getattr(b.intersection(p['poly']), 'geoms', [b.intersection(p['poly'])]):
                    if seg.geom_type == 'LineString' and seg.length > 0:
                        c = list(seg.coords)
                        m.add_line((c[0][0] + ox, c[0][1]), (c[-1][0] + ox, c[-1][1]), dxfattribs={'layer': 'BEND'})
            pt = poly.representative_point()
            h = max(2.5, min(8.0, math.sqrt(poly.area) / 12))
            m.add_text(p['label'][:40], dxfattribs={'layer': 'LABEL', 'height': h, 'insert': (pt.x, pt.y)})
    buf = io.StringIO()
    d.write(buf)
    return buf.getvalue().encode()


def _pdf(groups, title):
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.units import mm
    out = io.BytesIO()
    c = canvas.Canvas(out, pagesize=landscape(A4))
    PW, PH = landscape(A4)
    c.setFont('Helvetica-Bold', 16)
    c.drawString(15 * mm, PH - 20 * mm, f'Nesting - {title}')
    c.setFont('Helvetica', 10)
    y = PH - 32 * mm
    for g in groups:
        c.drawString(15 * mm, y, f"{g['material'] or 'Material not set'} - {g['thickness']:g} mm: {len(g['sheets'])} sheet(s) {g['sheet'][0]:g} x {g['sheet'][1]:g}, "
                     f"{g['placed']} of {g['parts']} parts placed, average use {g['utilization']:.0f} %")
        y -= 6 * mm
        for u in g['unplaced'][:6]:
            c.drawString(22 * mm, y, f"Not placed: {u['label']} ({u['reason']})")
            y -= 5 * mm
    c.setFont('Helvetica-Oblique', 8)
    c.drawString(15 * mm, 12 * mm, 'Generic true-shape nesting (raster bottom-left). Check part spacing, lead-ins and grain with your laser CAM before cutting.')
    c.showPage()
    for g in groups:
        W, H = g['sheet']
        for sh in g['_sheets']:
            c.setFont('Helvetica-Bold', 12)
            c.drawString(15 * mm, PH - 15 * mm, f"{g['material'] or 'Material not set'} {g['thickness']:g} mm - sheet {sh['n']} of {len(g['_sheets'])}  ({sh['utilization']:.0f} % used)")
            s = min((PW - 110 * mm) / W, (PH - 35 * mm) / H)
            ox, oy = 15 * mm, PH - 25 * mm - H * s
            index = {label: k for k, label in enumerate(sorted(sh['parts']), 1)}   # parts are numbered, the table names them
            c.setLineWidth(.6)
            c.rect(ox, oy, W * s, H * s)
            c.setLineWidth(.3)
            for p in sh['placed']:
                for ring in [p['poly'].exterior, *p['poly'].interiors]:
                    pts = list(ring.coords)
                    path = c.beginPath()
                    path.moveTo(ox + pts[0][0] * s, oy + pts[0][1] * s)
                    for q in pts[1:]:
                        path.lineTo(ox + q[0] * s, oy + q[1] * s)
                    path.close()
                    c.drawPath(path, stroke=1, fill=0)
                pt = p['poly'].representative_point()
                c.setFont('Helvetica-Bold', 6)
                c.drawCentredString(ox + pt.x * s, oy + pt.y * s - 2, str(index[p['label']]))
            c.setFont('Helvetica-Bold', 9)
            tx = PW - 90 * mm
            c.drawString(tx, PH - 25 * mm, '#  Part')
            c.drawString(tx + 62 * mm, PH - 25 * mm, 'Qty')
            c.setFont('Helvetica', 8)
            yy = PH - 31 * mm
            for label, n in sorted(sh['parts'].items()):
                c.drawString(tx, yy, f'{index[label]:>2}  {label[:42]}')
                c.drawRightString(tx + 70 * mm, yy, str(n))
                yy -= 4.5 * mm
                if yy < 15 * mm:
                    break
            c.showPage()
    c.save()
    return out.getvalue()


def run(parts, W, H, gap=0.0, margin=10.0, rotate=True, title='', progress=None):
    """parts: [{key, label, material, thickness, qty, flat{outline, holes, bends}}]. Returns (summary, zip bytes)."""
    groups = {}
    for p in parts:
        groups.setdefault((p['material'] or '', round(float(p['thickness'] or 0), 3)), []).append(p)
    out_groups, files = [], {}
    keys = sorted(groups)
    for gi, gk in enumerate(keys):
        mat, th = gk
        g_gap = gap if gap > 0 else max(3.0, 2 * th)
        shapes = [Shape(p['key'], p['label'], p['flat']['outline'], p['flat'].get('holes') or [], p['flat'].get('bends') or [], p['qty']) for p in groups[gk]]
        rot = (0, 90, 180, 270) if rotate else (0,)
        n_copies = sum(sh.qty for sh in shapes)
        sheets, unplaced = nest_group(shapes, W, H, g_gap, margin, rot, budget=min(30.0, 4.0 + .2 * n_copies),
                                      progress=(lambda n, t, gi=gi: progress((gi + n / max(t, 1)) / len(keys))) if progress else None)
        out_sheets = []
        for n, sh in enumerate(sheets, 1):
            used = sum(p['poly'].area for p in sh.placed)
            counts = {}
            for p in sh.placed:
                counts[p['label']] = counts.get(p['label'], 0) + 1
            length = min(W, max(p['bbox'][2] for p in sh.placed) + margin)   # used length; the rest is a remnant
            out_sheets.append({'n': n, 'placed': sh.placed, 'utilization': 100 * used / (W * H), 'parts': counts,
                               'length': length, 'dense': 100 * used / max(length * H, 1)})
        name = f"{_slug(mat or 'material')}-{th:g}mm"
        for s in out_sheets:
            files[f'{name}/sheet-{s["n"]:02d}.dxf'] = _dxf([(s['n'], s['placed'])], W, H, f'{mat} {th:g}mm')
        if out_sheets:
            files[f'{name}/{name}-all-sheets.dxf'] = _dxf([(s['n'], s['placed']) for s in out_sheets], W, H, f'{mat} {th:g}mm')
        n_parts = sum(sh.qty for sh in shapes)
        out_groups.append({
            'material': mat, 'thickness': th, 'sheet': [W, H], 'gap': g_gap, 'margin': margin, 'parts': n_parts,
            'placed': sum(len(s['placed']) for s in out_sheets), 'unplaced': unplaced,
            'utilization': (sum(s['utilization'] for s in out_sheets) / len(out_sheets)) if out_sheets else 0.0,
            'files': [k for k in files if k.startswith(name + '/')],
            'sheets': [{'n': s['n'], 'utilization': round(s['utilization'], 1), 'parts': s['parts'], 'length': round(s['length'], 1),
                        'dense': round(s['dense'], 1), 'remnant': [round(W - s['length'], 1), H] if W - s['length'] > 100 else None,
                        'preview': [{'label': p['label'], 'd': _svg(p['poly'])} for p in s['placed']]} for s in out_sheets],
            '_sheets': out_sheets,
        })
    files['nesting-summary.pdf'] = _pdf(out_groups, title)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for k, v in files.items():
            z.writestr(k, v)
    for g in out_groups:
        g.pop('_sheets', None)
    return {'groups': out_groups, 'sheets': sum(len(g['sheets']) for g in out_groups)}, buf.getvalue()


def _svg(poly):
    """SVG path (y up) of a placed part, simplified for the preview."""
    p = poly.simplify(.6)
    parts = []
    for ring in [p.exterior, *p.interiors]:
        c = np.round(np.array(ring.coords), 1)
        parts.append('M' + ' L'.join(f'{x:g} {y:g}' for x, y in c) + 'Z')
    return ''.join(parts)
