"""Welding document: weld schedule + one page per weldment with the welds drawn and numbered on a rendered
picture of the welded parts. Everything comes from the welds the engineer configured (process, size, pattern,
range on the seam); nothing is inferred.
"""
from __future__ import annotations

import io
import json
import math

import numpy as np
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from . import db, storage
from .security import revision_access

router = APIRouter()
JOINT_NAMES = {'fillet': 'Fillet', 'corner': 'Corner', 'butt': 'Butt'}
TYPE_NAMES = {'linear': 'Continuous', 'stitch': 'Stitch', 'tack': 'Tack', 'patch': 'Plug / patch'}


def load(v, default):
    try:
        return json.loads(v) if isinstance(v, str) else (v if v is not None else default)
    except ValueError:
        return default


def _path_len(path):
    p = np.asarray(path, float)
    return float(np.linalg.norm(np.diff(p, axis=0), axis=1).sum()) if len(p) > 1 else 0.0


def _section(path, a, b):
    """Part of a polyline between arc lengths a and b."""
    p = np.asarray(path, float)
    if len(p) < 2:
        return p
    seg = np.linalg.norm(np.diff(p, axis=0), axis=1)
    cum = np.r_[0, np.cumsum(seg)]
    a, b = max(0.0, a), min(float(cum[-1]), b)

    def at(s):
        i = int(np.clip(np.searchsorted(cum, s) - 1, 0, len(seg) - 1))
        t = (s - cum[i]) / max(seg[i], 1e-12)
        return p[i] + (p[i + 1] - p[i]) * t
    inner = [p[i] for i in range(len(p)) if a < cum[i] < b]
    return np.array([at(a)] + inner + [at(b)])


def weld_rows(rid):
    """One row per weld: numbering, parts, joint, size, length, pattern, process, paths (assembly coordinates)."""
    from .assembly import instances_of
    inst = instances_of(rid)
    names = {p['id']: p['name'] for p in db.rows('SELECT id,name FROM parts WHERE revision_id=?', (rid,))}
    rows = []
    for k, j in enumerate(db.rows("SELECT * FROM joints WHERE revision_id=? AND kind='weld' ORDER BY created", (rid,))):
        d = load(j['data'], {})
        w = d.get('weld') or {}
        paths, length, joint, bodies = [], 0.0, '', set()
        for f in d.get('faces') or []:
            occ = int(f.get('occurrence') or 0)
            bodies.add((f['part'], occ))
            if f.get('other_part'):
                bodies.add((f['other_part'], int(f.get('other_occurrence') or 0)))
            joint = joint or f.get('joint', '')
            lst = inst.get(f['part']) or []
            M = np.array(lst[occ]['matrix'], float) if occ < len(lst) else np.eye(4)
            for path in f.get('boundaries') or []:
                if len(path) < 2:
                    continue
                L = _path_len(path)
                a, b = (f.get('range') or [0, L])[:2]
                sec = _section(path, a, b) if (a > 1e-6 or b < L - 1e-6) else np.asarray(path, float)
                world = sec @ M[:3, :3].T + M[:3, 3]
                paths.append((world, a, b))
                length += max(0.0, b - a)
        t = w.get('type', 'linear')
        pitch = float(w.get('pitch') or 0)
        seg = float(w.get('length') or 0)
        if t == 'stitch' and pitch > 0:
            n = max(1, int(math.floor((length - seg) / pitch + 1e-6)) + 1) if length > seg else 1
            pattern = f"{n} × {seg:g} ({pitch:g})"
            weld_len = n * min(seg, length)
        elif t == 'tack':
            n = max(1, int(math.floor(length / pitch + 1e-6)) + 1) if pitch > 0 and length > 0 else 1
            pattern = f"{n} tack{'s' if n > 1 else ''}"
            weld_len = 0.0
        else:
            pattern = 'Continuous' if t == 'linear' else TYPE_NAMES.get(t, t)
            weld_len = length
        size = str(w.get('size') or '').strip()
        rows.append({'n': k + 1, 'id': j['id'], 'name': d.get('name') or '', 'parts': [names.get(p, p) for p in d.get('parts', [])],
                     'part_ids': d.get('parts', []), 'joint': JOINT_NAMES.get(joint, joint.title() or '—'), 'type': t, 'size': size,
                     'symbol': iso2553(joint, size, t, seg, pitch, length), 'seam': round(length, 1), 'weld_length': round(weld_len, 1),
                     'pattern': pattern, 'process': w.get('process', ''), 'ground': bool(w.get('ground')), 'sides': w.get('sides', 'one'),
                     'notes': d.get('notes') or '', 'paths': paths, 'bodies': sorted(bodies)})
    return rows


def iso2553(joint, size, t, seg, pitch, length):
    """Text form of the ISO 2553 dimensioning: a3 fillet 4 × 50 (100). Fillet welds give the throat a; butt welds s."""
    glyph = {'fillet': 'fillet', 'corner': 'fillet', 'butt': 'butt'}.get(joint, 'fillet')
    dim = (('a' if joint != 'butt' else 's') + size) if size else ''
    if t == 'stitch' and pitch > 0:
        n = max(1, int(math.floor((length - seg) / pitch + 1e-6)) + 1) if length > seg else 1
        return f"{dim} {glyph} {n} × {seg:g} ({pitch:g})".strip()
    if t == 'tack':
        return f"{dim} {glyph} TACK".strip()
    return f"{dim} {glyph}".strip()


def weldments(rows):
    """Groups of welds whose parts are connected by welds (one picture per welded unit)."""
    parent = {}

    def find(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for r in rows:
        ids = r['part_ids'] or []
        for a in ids[1:]:
            parent[find(a)] = find(ids[0])
        if ids:
            find(ids[0])
    groups = {}
    for r in rows:
        if r['part_ids']:
            groups.setdefault(find(r['part_ids'][0]), []).append(r)
    return list(groups.values())


def welding_pdf(rid):
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.units import mm
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase.pdfmetrics import stringWidth
    from .assembly import part_mesh, placed, merge, instances_of, DONE, VIEW_N
    from .render import view_image
    rows = weld_rows(rid)
    rev = db.row('SELECT r.*, p.name AS project_name, p.code AS project_code FROM revisions r JOIN projects p ON p.id=r.project_id WHERE r.id=?', (rid,))
    out = db.revdir(rid) / 'welding.pdf'
    W, H = landscape(A4)
    c = canvas.Canvas(str(out), pagesize=(W, H))
    c.setTitle(f"Welding — {rev['project_name']} rev {rev['number']}")
    sym_font = 'Helvetica'

    def header(title, page, pages):
        c.setFillColorRGB(.06, .09, .16)
        c.setFont('Helvetica-Bold', 9)
        c.drawString(12 * mm, H - 10 * mm, 'WELDING')
        c.setFont('Helvetica', 9)
        c.drawString(34 * mm, H - 10 * mm, f"{rev['project_code'] or ''} {rev['project_name']} · rev {rev['number']}")
        c.drawRightString(W - 12 * mm, H - 10 * mm, title)
        c.setStrokeColorRGB(.8, .83, .87)
        c.line(12 * mm, H - 12.5 * mm, W - 12 * mm, H - 12.5 * mm)
        c.setFont('Helvetica', 7)
        c.setFillColorRGB(.45, .5, .56)
        c.drawString(12 * mm, 8 * mm, 'Weld sizes, processes and patterns as configured in Forge. ISO 2553 notation: a = fillet throat, s = butt penetration, n × l (e) = stitch count × length (pitch).')
        c.drawRightString(W - 12 * mm, 8 * mm, f'Page {page}/{pages}')

    def fit(text, width, font, size):
        text = str(text)
        if stringWidth(text, font, size) <= width:
            return text
        while text and stringWidth(text + '…', font, size) > width:
            text = text[:-1]
        return text + '…'

    groups = weldments(rows)
    per_page = 24
    sched_pages = max(1, math.ceil(len(rows) / per_page))
    pages = sched_pages + len(groups)
    # ---- schedule
    cols = [('W', 10), ('Parts', 80), ('Joint', 18), ('Symbol (ISO 2553)', 42), ('Process', 32), ('Seam mm', 18), ('Weld mm', 18), ('Pattern', 28), ('Finish', 20)]
    if not rows:
        header('Weld schedule', 1, 1)
        c.setFont('Helvetica', 12)
        c.drawString(20 * mm, H / 2, 'No welds are configured for this revision.')
        c.save()
        return out
    for pg in range(sched_pages):
        header('Weld schedule', pg + 1, pages)
        y = H - 22 * mm
        x = 12 * mm
        c.setFillColorRGB(.95, .96, .98)
        c.rect(x, y - 2 * mm, sum(w for _, w in cols) * mm, 7 * mm, stroke=0, fill=1)
        c.setFillColorRGB(.25, .3, .38)
        c.setFont('Helvetica-Bold', 7.5)
        for name, w in cols:
            c.drawString(x + 1.5 * mm, y, name.upper())
            x += w * mm
        y -= 7 * mm
        for r in rows[pg * per_page:(pg + 1) * per_page]:
            x = 12 * mm
            cells = [f"W{r['n']}", ' + '.join(r['parts']), r['joint'], r['symbol'], r['process'], f"{r['seam']:g}", f"{r['weld_length']:g}" if r['type'] != 'tack' else '—',
                     r['pattern'], 'Ground flush' if r['ground'] else 'As welded']
            for (name, w), val in zip(cols, cells):
                font = 'Helvetica-Bold' if name == 'W' else (sym_font if name.startswith('Symbol') else 'Helvetica')
                c.setFont(font, 8)
                c.setFillColorRGB(.85, .2, .1) if name == 'W' else c.setFillColorRGB(.06, .09, .16)
                c.drawString(x + 1.5 * mm, y, fit(str(val), (w - 3) * mm, font, 8))
                x += w * mm
            c.setStrokeColorRGB(.9, .91, .93)
            c.line(12 * mm, y - 2.2 * mm, x, y - 2.2 * mm)
            y -= 6.6 * mm
        if pg == sched_pages - 1:
            y -= 4 * mm
            c.setFont('Helvetica-Bold', 9)
            c.setFillColorRGB(.06, .09, .16)
            c.drawString(12 * mm, y, 'Totals')
            y -= 5 * mm
            c.setFont('Helvetica', 9)
            by = {}
            for r in rows:
                by.setdefault(r['process'] or '—', [0, 0.0, 0])
                by[r['process'] or '—'][0] += 1
                by[r['process'] or '—'][1] += r['weld_length']
                by[r['process'] or '—'][2] += r['type'] == 'tack'
            for proc, (n, L, tacks) in by.items():
                c.drawString(12 * mm, y, f"{proc}: {n} weld{'s' if n != 1 else ''} · {L:.0f} mm weld length{f' · {tacks} tack weld(s)' if tacks else ''}")
                y -= 5 * mm
        c.showPage()
    # ---- one page per weldment
    inst = instances_of(rid)
    right = np.cross([0, 0, 1.0], VIEW_N)
    right /= np.linalg.norm(right)
    up = np.cross(VIEW_N, right)
    for gi, grp in enumerate(groups):
        names = sorted({n for r in grp for n in r['parts']})
        header(f"Weldment {gi + 1} of {len(groups)}", sched_pages + gi + 1, pages)
        c.setFillColorRGB(.06, .09, .16)
        c.setFont('Helvetica-Bold', 13)
        c.drawString(12 * mm, H - 21 * mm, fit('Weldment ' + str(gi + 1) + ': ' + ', '.join(names), W - 24 * mm, 'Helvetica-Bold', 13))
        bodies = sorted({b for r in grp for b in r['bodies']})
        meshes = []
        for pid, o in bodies:
            md = part_mesh(rid, pid)
            if md is None:
                continue
            lst = inst.get(pid) or []
            M = np.array(lst[o]['matrix'], float) if o < len(lst) else np.eye(4)
            meshes.append(placed(md, M, DONE))
        box = (12 * mm, 16 * mm, 196 * mm, H - 28 * mm)
        if meshes:
            md = merge(meshes)
            P2 = np.c_[md['v'] @ right, md['v'] @ up]
            lo, hi = P2.min(0), P2.max(0)
            pad = (hi - lo) * .06 + 1
            lo, hi = lo - pad, hi + pad
            img = view_image(md, VIEW_N, right, lo, hi, px_per_mm=1500 / max(hi - lo), max_px=1500)
            bw, bh = box[2] - box[0], box[3] - box[1]
            sc = min(bw / (hi - lo)[0], bh / (hi - lo)[1])
            iw, ih = (hi - lo)[0] * sc, (hi - lo)[1] * sc
            ix, iy = box[0] + (bw - iw) / 2, box[1] + (bh - ih) / 2
            c.drawImage(ImageReader(io.BytesIO(img)), ix, iy, iw, ih)
            P = lambda q: (ix + (q @ right - lo[0]) * sc, iy + (q @ up - lo[1]) * sc)  # noqa: E731
            placed_tags = []
            for r in grp:
                c.setStrokeColorRGB(.86, .15, .1)
                c.setFillColorRGB(.86, .15, .1)
                pts_all = []
                for world, a, b in r['paths']:
                    pts = [P(q) for q in world]
                    pts_all += pts
                    if r['type'] == 'tack':
                        for q in pts[::max(1, len(pts) // 3)]:
                            c.circle(q[0], q[1], 1.1 * mm, stroke=0, fill=1)
                        continue
                    c.setLineWidth(2.2)
                    c.setDash([3, 2] if r['type'] == 'stitch' else [])
                    p = c.beginPath()
                    p.moveTo(*pts[0])
                    for q in pts[1:]:
                        p.lineTo(*q)
                    c.drawPath(p, stroke=1, fill=0)
                c.setDash([])
                if not pts_all:
                    continue
                mid = pts_all[len(pts_all) // 2]
                # balloon placed outward from the picture centre, away from other tags
                cx, cy = ix + iw / 2, iy + ih / 2
                d = np.array([mid[0] - cx, mid[1] - cy])
                d = d / (np.linalg.norm(d) or 1)
                tag = np.array(mid) + d * 14 * mm
                for _ in range(12):
                    if all(np.linalg.norm(tag - t) > 9 * mm for t in placed_tags):
                        break
                    tag = tag + np.array([-d[1], d[0]]) * 6 * mm
                placed_tags.append(tag)
                c.setLineWidth(.6)
                c.line(mid[0], mid[1], tag[0], tag[1])
                c.setFillColorRGB(1, 1, 1)
                c.circle(tag[0], tag[1], 3.6 * mm, stroke=1, fill=1)
                c.setFillColorRGB(.86, .15, .1)
                c.setFont('Helvetica-Bold', 8)
                c.drawCentredString(tag[0], tag[1] - 1 * mm, f"W{r['n']}")
        # weld list for this weldment
        x0, y = 204 * mm, H - 30 * mm
        for r in grp:
            if y < 22 * mm:
                c.setFont('Helvetica', 8)
                c.drawString(x0, y, '… see weld schedule')
                break
            c.setFillColorRGB(.86, .15, .1)
            c.setFont('Helvetica-Bold', 10)
            c.drawString(x0, y, f"W{r['n']}")
            c.setFillColorRGB(.06, .09, .16)
            c.setFont(sym_font, 10)
            c.drawString(x0 + 11 * mm, y, fit(r['symbol'], 70 * mm, sym_font, 10))
            y -= 4.6 * mm
            c.setFont('Helvetica', 8)
            for line in (f"{r['joint']} · {r['process']}", f"{r['pattern']} · seam {r['seam']:g} mm" + (f" · weld {r['weld_length']:g} mm" if r['type'] != 'tack' else ''),
                         ('Ground flush' if r['ground'] else 'As welded') + (' · both sides' if r['sides'] == 'both' else ' · all around' if r['sides'] == 'all_around' else ''),
                         r['notes']):
                if line:
                    c.drawString(x0 + 11 * mm, y, fit(line, 70 * mm, 'Helvetica', 8))
                    y -= 4 * mm
            y -= 2.5 * mm
        c.showPage()
    c.save()
    return out


def touch(rid):
    (db.revdir(rid) / 'welding.pdf').unlink(missing_ok=True)


@router.get('/api/revisions/{rid}/welding.pdf')
def welding(rid: str, request: Request):
    revision_access(request, rid)
    out = db.revdir(rid) / 'welding.pdf'
    if not out.exists():
        if not db.row("SELECT id FROM joints WHERE revision_id=? AND kind='weld' LIMIT 1", (rid,)):
            raise HTTPException(404, 'No welds are configured for this revision')
        welding_pdf(rid)
    return FileResponse(out, media_type='application/pdf', filename='welding.pdf')
