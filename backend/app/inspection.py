"""Inspection characteristics ("ballooning") for the vendor drawing, and first-article / production inspection.

Every dimension and note requirement printed on a generated drawing becomes a numbered characteristic with a
nominal, limits and a sheet zone. Limits come from the drawing's own general tolerances (title block: decimal
places, hole / shaft fit, position tolerance, ISO 2768 angles) unless an engineer overrides them. Characteristics
can be marked critical (CTQ): those are measured on every part, everything else on the first article.

Balloons are an overlay: the drawing scene itself is unchanged, so balloons follow views and callouts the
engineer moves in the drawing editor and can be shown on the inspection copy only.
"""
import hashlib, io, json, math, re
from reportlab.lib.units import mm
from reportlab.pdfbase.pdfmetrics import stringWidth

# ------------------------------------------------------------------------------------------- tolerances
# ISO 286-1 standard tolerance grades IT5..IT11 (µm) for nominal size ranges up to 500 mm.
IT_RANGES = [3, 6, 10, 18, 30, 50, 80, 120, 180, 250, 315, 400, 500]
IT_TABLE = {
    5: [4, 5, 6, 8, 9, 11, 13, 15, 18, 20, 23, 25, 27],
    6: [6, 8, 9, 11, 13, 16, 19, 22, 25, 29, 32, 36, 40],
    7: [10, 12, 15, 18, 21, 25, 30, 35, 40, 46, 52, 57, 63],
    8: [14, 18, 22, 27, 33, 39, 46, 54, 63, 72, 81, 89, 97],
    9: [25, 30, 36, 43, 52, 62, 74, 87, 100, 115, 130, 140, 155],
    10: [40, 48, 58, 70, 84, 100, 120, 140, 160, 185, 210, 230, 250],
    11: [60, 75, 90, 110, 130, 160, 190, 220, 250, 290, 320, 360, 400],
}


def it_value(size, grade):
    """Tolerance width (mm) of an IT grade for a nominal size, or None outside the table."""
    if grade not in IT_TABLE or not 0 < size <= 500:
        return None
    for i, top in enumerate(IT_RANGES):
        if size <= top:
            return IT_TABLE[grade][i] / 1000.0
    return None


def fit_limits(size, fit):
    """(lower, upper) deviations for H / h fits (the basic hole / basic shaft system); None for other letters."""
    m = re.fullmatch(r'\s*([Hh])(\d{1,2})\s*', str(fit or ''))
    if not m:
        return None
    t = it_value(size, int(m.group(2)))
    if t is None:
        return None
    return (0.0, t) if m.group(1) == 'H' else (-t, 0.0)


def plusminus(text, default):
    m = re.search(r'(\d+(?:\.\d+)?)', str(text or ''))
    return float(m.group(1)) if m else default


def decimals(num_text):
    return len(num_text.split('.')[1]) if '.' in num_text else 0


def general_tolerance(req, settings):
    """Default limits for one requirement from the drawing's general tolerance block. Returns (lower, upper,
    basis) as deviations from nominal, or (None, None, basis) for attribute checks."""
    d = (settings or {}).get('drawing') or {}
    if req['unit'] == 'attr':
        return None, None, 'attribute'
    if req['unit'] == 'deg':
        # ISO 2768-m angular tolerance for the shorter leg up to 10 mm is ±1°; Forge uses ±0.5° (10..50 mm)
        return -0.5, 0.5, 'ISO 2768-m angle'
    if req['type'] == 'position':
        t = plusminus(d.get('position_tol'), .02)
        return -t, t, 'position tol (title block)'
    if req['type'] == 'hole_dia' and fit_limits(req['nominal'], d.get('hole_fit', 'H7')):
        lo, hi = fit_limits(req['nominal'], d.get('hole_fit', 'H7'))
        return lo, hi, f"{d.get('hole_fit', 'H7')} (title block)"
    if req['type'] == 'shaft_dia' and fit_limits(req['nominal'], d.get('shaft_fit', 'h7')):
        lo, hi = fit_limits(req['nominal'], d.get('shaft_fit', 'h7'))
        return lo, hi, f"{d.get('shaft_fit', 'h7')} (title block)"
    n = min(max(req.get('decimals', 2), 1), 3)
    t = plusminus(d.get(f'tol_{n}dec'), {1: .1, 2: .05, 3: .02}[n])
    return -t, t, f'{n} dec. ±{t:g} (title block)'


# ------------------------------------------------------------------------------------------- requirements
NUM = r'(\d+(?:\.\d+)?)'


def requirements(text, kind='note', dim_kind=None):
    """What has to be checked in one printed line: [{'label', 'nominal', 'unit', 'type', 'decimals'}].
    'kind' is where the text came from: 'ordinate' / 'angle' / 'note' / 'thk'."""
    t = text.strip()
    out = []
    if not t or t == '0':
        return out  # the datum itself is not a measurement
    qty = 1
    m = re.match(r'^(\d+)\s*[xX]\s+', t)
    if m:
        qty = int(m.group(1))
        t = t[m.end():]
    add = lambda label, num, unit, typ: out.append({'label': label, 'nominal': float(num), 'unit': unit, 'type': typ,
                                                    'decimals': decimals(num), 'qty': qty})
    if kind == 'ordinate' and re.fullmatch(NUM, t):
        add('Position' if dim_kind in ('hole', 'centre') else 'Length', t, 'mm', 'position' if dim_kind in ('hole', 'centre') else 'linear')
        return out
    if kind == 'angle' or re.fullmatch(NUM + '°', t):
        m = re.search(NUM, t)
        if m:
            add('Angle', m.group(1), 'deg', 'angle')
        return out
    m = re.match(r'^THK\s+' + NUM, t)
    if m:
        add('Thickness', m.group(1), 'mm', 'linear')
        return out
    # thread designations are checked with gauges
    m = re.match(r'^(M\d+(?:\.\d+)?(?:\s*[xX]\s*\d+(?:\.\d+)?)?)\s*-\s*(\w+)(.*)$', t)
    if m:
        out.append({'label': f'Thread {m.group(1)}-{m.group(2)}', 'nominal': None, 'unit': 'attr', 'type': 'thread', 'decimals': 0, 'qty': qty})
        d = re.search('↧\\s*' + NUM, m.group(3))
        if d:
            add('Thread depth', d.group(1), 'mm', 'depth')
        return out
    m = re.search('\u00d8\\s*' + NUM, t)
    if m:
        if t.startswith('\u2335'):
            typ = 'csk_dia'
        elif t.startswith('\u2334'):
            typ = 'cbore_dia'
        else:
            typ = 'shaft_dia' if dim_kind == 'shaft' else 'hole_dia'
        label = {'csk_dia': 'Countersink Ø', 'cbore_dia': 'Counterbore Ø', 'shaft_dia': 'Diameter'}.get(typ, 'Hole Ø')
        add(label, m.group(1), 'mm', typ)
        d = re.search('↧\\s*' + NUM, t)
        if d:
            add('Depth', d.group(1), 'mm', 'depth')
        a = re.search(r'X\s*' + NUM + '°', t)
        if a:
            add('Countersink angle', a.group(1), 'deg', 'angle')
        if 'THRU' in t and not d:
            out.append({'label': 'Through', 'nominal': None, 'unit': 'attr', 'type': 'thru', 'decimals': 0, 'qty': qty})
        return out
    m = re.match(r'^R\s*' + NUM, t)
    if m:
        add('Radius', m.group(1), 'mm', 'radius')
        return out
    m = re.match('^' + NUM + r'\s*X\s*' + NUM + '°', t)
    if m:
        add('Chamfer', m.group(1), 'mm', 'chamfer')
        return out
    m = re.search('(POCKET|SLOT)\\s*↧\\s*' + NUM, t)
    if m:
        add(m.group(1).title() + ' depth', m.group(2), 'mm', 'depth')
        return out
    m = re.search(NUM, t)
    if m and kind in ('note', 'bend'):
        add('Requirement', m.group(1), 'mm', 'linear')
    return out


# ------------------------------------------------------------------------------------------- extraction
def zone(page_w, page_h, x, y, size):
    """Drawing-frame zone ('C4') of a point in mm, matching sheet.draw_template."""
    from .sheet import SHEETS
    cols = SHEETS.get(size, SHEETS['A4'])[2]
    rows = 6 if size != 'A2' else 8
    x0, y0, x1, y1 = 6.0, 6.0, page_w - 6.0, page_h - 6.0
    i = min(cols - 1, max(0, int((x - x0) / ((x1 - x0) / cols))))
    j = min(rows - 1, max(0, int((y - y0) / ((y1 - y0) / rows))))
    return 'ABCDEFGH'[j] + str(cols - i)


BALLOON_R = 2.3   # mm (ASME Y14.41 style numbered balloon ~ 2x text height)


def _place(cm, placed, rect, prefer, r):
    """Balloon centre near a text rect: the first free spot on rings around it (collision map + other balloons)."""
    from .sheet import _seg_hits_rect
    cx, cy = (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2
    best = None
    for ring in (1.0, 2.2, 3.6, 5.5, 8.0):
        for k in range(16):
            ang = prefer + ((k + 1) // 2) * (1 if k % 2 else -1) * math.pi / 8  # preferred side first, then alternating
            dx, dy = math.cos(ang), math.sin(ang)
            # distance from the rect centre to its edge along (dx, dy), then the ring gap and the balloon radius
            hw, hh = (rect[2] - rect[0]) / 2, (rect[3] - rect[1]) / 2
            edge = min(hw / abs(dx) if abs(dx) > 1e-9 else 1e9, hh / abs(dy) if abs(dy) > 1e-9 else 1e9)
            px, py = cx + dx * (edge + ring + r), cy + dy * (edge + ring + r)
            box = (px - r, py - r, px + r, py + r)
            cost = cm.rect_cost(box, text_weight=60.0) if cm is not None else 0.0
            cost += sum(80.0 for q in placed if math.hypot(q[0] - px, q[1] - py) < 2 * r + .4)
            cost += ring * 1.5 + abs(((k + 1) // 2)) * .3
            if best is None or cost < best[0]:
                best = (cost, px, py)
        if best and best[0] < 6:
            break
    return best[1], best[2]


def extract(sheets, settings=None):
    """Characteristics of the generated sheets (paper mm): one balloon per printed requirement line, each with
    its requirements. Returns [{'page', 'sg', 'text', 'source', 'reqs', 'rect', 'balloon', 'zone', 'size'}]."""
    from .sheet import CollisionMap, text_rect
    out = []
    for pi, sh in enumerate(sheets):
        cm = CollisionMap(sh)
        dims = {d.get('grp'): d for d in sh.dims if d.get('grp')}
        placed = []
        texts = [it for it in sh.items if it['k'] == 'text' and it['layer'] in ('DIM', 'BEND') and it['s'].strip()]
        rows = []
        for it in texts:
            d = dims.get(it.get('grp'))
            if it['layer'] == 'BEND':
                if re.fullmatch(r'B\d+', it['s'].strip()):
                    continue  # tag balloon; the bend table row carries the requirement
                kind, dk = 'bend', None
            elif d is not None and d['axis'] in ('x', 'y'):
                kind, dk = 'ordinate', d.get('kind')
            elif d is not None and d['axis'] == 'angle':
                kind, dk = 'angle', None
            else:
                kind, dk = 'note', ('shaft' if str(it.get('grp', '')).startswith('note:dia') else None)
            reqs = requirements(it['s'], kind, dk)
            if not reqs:
                continue
            r = text_rect(it)
            sg = it.get('sg')
            if d is not None and d['axis'] in ('x', 'y', 'angle') and str(sg or '').startswith('view:'):
                sg = 'dim:' + d['grp']  # the balloon follows its dimension when the value is moved
            rows.append({'page': pi, 'sg': sg, 'text': it['s'].strip(), 'source': kind, 'reqs': reqs, 'rect': r, 'rot': it.get('rot', 0)})
        # reading order: zone rows top to bottom, then left to right
        rows.sort(key=lambda c: (-round(((c['rect'][1] + c['rect'][3]) / 2) / 12.0), (c['rect'][0] + c['rect'][2]) / 2))
        for c in rows:
            r = c['rect']
            prefer = -math.pi / 2 if c['rot'] == 90 else (0.0 if c['source'] != 'note' else math.pi / 2)
            if c['source'] == 'ordinate' and c['rot'] != 90:
                prefer = math.pi  # vertical ordinate band: values right-aligned left of the band
            bx, by = _place(cm, placed, r, prefer, BALLOON_R)
            placed.append((bx, by))
            cm.add_rect((bx - BALLOON_R, by - BALLOON_R, bx + BALLOON_R, by + BALLOON_R), 'NOTES')
            c['balloon'] = [bx, by]
        out += rows
        # hole / bend tables: one balloon per row just left of the row
        for tr in getattr(sh, 'table_rows', []):
            row = tr['row']
            x0, y0, x1, y1 = tr['box']
            rb = min(BALLOON_R, (y1 - y0) * .48)
            if tr['kind'] == 'hole':
                reqs = [{'label': f"{row['tag']} position X", 'nominal': float(row['x']), 'unit': 'mm', 'type': 'position', 'decimals': 2, 'qty': 1},
                        {'label': f"{row['tag']} position Y", 'nominal': float(row['y']), 'unit': 'mm', 'type': 'position', 'decimals': 2, 'qty': 1}]
                for line in re.split(r'\s{2,}', str(row.get('size', ''))):
                    for q in requirements(line, 'note', 'hole'):
                        reqs.append({**q, 'label': f"{row['tag']} {q['label']}"})
                text = f"{row['tag']}  X {row['x']:.2f}  Y {row['y']:.2f}  {row.get('size', '')}"
            else:
                reqs = [{'label': f"{row['tag']} bend angle", 'nominal': float(row['angle']), 'unit': 'deg', 'type': 'angle', 'decimals': 1, 'qty': 1},
                        {'label': f"{row['tag']} inner radius", 'nominal': float(row['radius']), 'unit': 'mm', 'type': 'radius', 'decimals': 2, 'qty': 1}]
                if row.get('outside_height') is not None:
                    reqs.append({'label': f"{row['tag']} outside height", 'nominal': float(row['outside_height']), 'unit': 'mm', 'type': 'linear', 'decimals': 2, 'qty': 1})
                text = f"{row['tag']} {row['direction']} {row['angle']:.1f}° R{row['radius']:.2f}"
            out.append({'page': pi, 'sg': None, 'text': text, 'source': tr['kind'] + '_table', 'reqs': reqs, 'rect': [x0, y0, x1, y1],
                        'balloon': [x0 - rb - .4, (y0 + y1) / 2], 'balloon_r': rb, 'rot': 0})
        for c in out:
            if c['page'] == pi:
                c['zone'] = zone(sh.w, sh.h, c['balloon'][0], c['balloon'][1], sh.size)
                c['size'] = sh.size
    # numbering: sheets in order; one number per printed line, n.1 n.2 ... for several requirements on it
    keys, lines = {}, {}
    for n, c in enumerate(out, 1):
        c['index'] = n
        lb = f"{c['page']}|{c['source']}|{c['text']}"
        lines[lb] = lines.get(lb, 0) + 1
        c['id'] = hashlib.sha1(f"{lb}|{lines[lb]}".encode()).hexdigest()[:12]  # stable line id (balloon edits)
        for k, q in enumerate(c['reqs'], 1):
            base = f"{c['source']}|{c['text']}|{q['label']}|{q['nominal']}"
            keys[base] = keys.get(base, 0) + 1
            q['key'] = hashlib.sha1(f"{base}|{keys[base]}".encode()).hexdigest()[:16]
            lo, hi, basis = general_tolerance(q, settings)
            q['lower'] = None if lo is None else round(q['nominal'] + lo, 4)
            q['upper'] = None if hi is None else round(q['nominal'] + hi, 4)
            q['basis'] = basis
    return out


def to_points(chars, scene):
    """Paper mm -> PDF points, and the scene group each balloon follows (ids made unique per sheet)."""
    out = []
    for c in chars:
        page = scene['pages'][c['page']] if c['page'] < len(scene['pages']) else None
        ids = {g['id'] for g in page['groups']} if page else set()
        sg = c.get('sg')
        if sg and sg not in ids:
            sg = f"p{c['page']}:{sg}" if f"p{c['page']}:{sg}" in ids else None
        out.append({**c, 'sg': sg, 'rect': [v * mm for v in c['rect']], 'balloon': [v * mm for v in c['balloon']],
                    'balloon_r': c.get('balloon_r', BALLOON_R) * mm})
    return out


def merged(chars, overrides):
    """Characteristics with the engineer's overrides applied. Only requirements the engineer chose to inspect
    (or marked critical) are ballooned; balloons are numbered 1..n over those lines in reading order, n.1 n.2 when
    one line carries several inspected requirements."""
    out = []
    n = 0
    for c in chars:
        c = json.loads(json.dumps(c))
        for q in c['reqs']:
            o = overrides.get(q['key']) or {}
            q['critical'] = bool(o.get('critical'))
            q['inspect'] = bool(o.get('inspect')) or q['critical']
            q['method'] = o.get('method', '')
            q['note'] = o.get('note', '')
            if o.get('lower') is not None or o.get('upper') is not None:
                q['lower'], q['upper'], q['basis'] = o.get('lower'), o.get('upper'), 'specified'
        o = overrides.get('balloon:' + str(c.get('id'))) or {}
        c['dx'], c['dy'] = o.get('dx', 0), o.get('dy', 0)
        sel = [q for q in c['reqs'] if q['inspect']]
        c['selected'] = bool(sel)
        c['critical'] = any(q['critical'] for q in c['reqs'])
        if sel:
            n += 1
            c['number'] = n
            for k, q in enumerate(sel, 1):
                q['no'] = f'{n}.{k}' if len(sel) > 1 else str(n)
        else:
            c['number'] = None
        for q in c['reqs']:
            if not q['inspect']:
                q['no'] = ''
        out.append(c)
    return out


def flat_list(chars, everything=False):
    """Inspected requirements (or every candidate with everything=True), one row each."""
    return [{**q, 'number': c.get('number'), 'line': c.get('id'), 'zone': c.get('zone', ''), 'page': c['page'], 'text': c['text'], 'source': c['source']}
            for c in chars for q in c['reqs'] if everything or q.get('inspect', True)]


# ------------------------------------------------------------------------------------------- painting
def paint_balloons(c, chars, groups, objects):
    """Numbered balloons on a sheet (points). Critical characteristics get a hexagon balloon (key characteristic)."""
    from .drawing_scene import group_offset
    for ch in chars:
        if not ch.get('selected', True) or ch.get('number') is None:
            continue
        ox = oy = 0.0
        sg = ch.get('sg')
        if sg and f"p{ch.get('page', 0)}:{sg}" in groups:
            sg = f"p{ch.get('page', 0)}:{sg}"  # ids repeated on a later sheet carry its prefix
        if sg and sg in groups:
            ox, oy = group_offset(groups[sg], groups, objects)
        r = ch.get('balloon_r', BALLOON_R * mm)
        bx, by = ch['balloon'][0] + ox + ch.get('dx', 0), ch['balloon'][1] + oy + ch.get('dy', 0)
        x0, y0, x1, y1 = [ch['rect'][0] + ox, ch['rect'][1] + oy, ch['rect'][2] + ox, ch['rect'][3] + oy]
        c.saveState()
        c.setDash([])
        c.setLineWidth(.18 * mm)
        col = (0.75, 0.05, 0.05) if ch.get('critical') else (0.0, 0.25, 0.75)
        c.setStrokeColorRGB(*col)
        c.setFillColorRGB(*col)
        if ch['source'] not in ('hole_table', 'bend_table'):
            # short leader from the balloon to the nearest point of the annotation it numbers
            nx, ny = max(x0, min(bx, x1)), max(y0, min(by, y1))
            d = math.hypot(nx - bx, ny - by)
            if d > r + .5:
                c.line(bx + (nx - bx) / d * r, by + (ny - by) / d * r, nx, ny)
        c.setFillColorRGB(1, 1, 1)
        if ch.get('critical'):
            p = c.beginPath()
            for k in range(6):
                a = math.pi / 6 + k * math.pi / 3
                (p.moveTo if k == 0 else p.lineTo)(bx + r * 1.12 * math.cos(a), by + r * 1.12 * math.sin(a))
            p.close()
            c.drawPath(p, stroke=1, fill=1)
        else:
            c.circle(bx, by, r, stroke=1, fill=1)
        c.setFillColorRGB(*col)
        s = str(ch['number'])
        size = r * (1.0 if len(s) < 3 else .8)
        c.setFont('Helvetica-Bold', size)
        c.drawString(bx - stringWidth(s, 'Helvetica-Bold', size) / 2, by - size * .36, s)
        c.restoreState()


def characteristic_sheets(c, part, rev, chars, settings, page_size):
    """'Characteristic accountability' pages (AS9102 form 3 layout without results) after the ballooned sheets."""
    rows = flat_list(chars)
    W, H = page_size
    per = 38
    for start in range(0, max(1, len(rows)), per):
        c.setPageSize(page_size)
        _form_header(c, W, H, 'INSPECTION CHARACTERISTICS', part, rev, start // per + 1, (len(rows) + per - 1) // per or 1)
        cols = [('NO.', 16), ('ZONE', 14), ('CHARACTERISTIC', 92), ('NOMINAL', 30), ('LOWER', 30), ('UPPER', 30), ('BASIS', 58), ('KC', 12), ('METHOD', 60), ('NOTE', 68)]
        y = H - 38 * mm
        _table_row(c, 10 * mm, y, cols, [k for k, _ in cols], bold=True)
        for q in rows[start:start + per]:
            y -= 5.2 * mm
            _table_row(c, 10 * mm, y, cols, [q['no'], q['zone'], q['label'] + (f"  ({q['qty']}x)" if q.get('qty', 1) > 1 else ''), _num(q['nominal'], q.get('decimals')),
                                             _lim(q['lower'], q), _lim(q['upper'], q), q.get('basis', ''), 'KC' if q.get('critical') else '', q.get('method', ''), q.get('note', '')],
                       red=q.get('critical'))
        c.showPage()


def _num(v, dec=None):
    if v is None:
        return ''
    if dec is not None:
        return f'{v:.{dec}f}'
    return f'{v:.4f}'.rstrip('0').rstrip('.')


def _lim(v, q):
    """Limits keep at least the drawing's decimals (and show fit limits to the micron)."""
    if v is None:
        return ''
    d = max(q.get('decimals', 2), len(f'{v:.4f}'.rstrip('0').split('.')[1]) if '.' in f'{v:.4f}'.rstrip('0') else 0)
    return f'{v:.{d}f}'


def _form_header(c, W, H, title, part, rev, page, pages):
    c.setStrokeColorRGB(0, 0, 0)
    c.setFillColorRGB(0, 0, 0)
    c.setLineWidth(.4)
    c.rect(8 * mm, 8 * mm, W - 16 * mm, H - 16 * mm)
    c.setFont('Helvetica-Bold', 13)
    c.drawString(12 * mm, H - 18 * mm, title)
    c.setFont('Helvetica', 9)
    c.drawString(12 * mm, H - 25 * mm, f"PART: {part.get('name', '')}    REVISION: {rev.get('number', '')}    FILE: {rev.get('filename', '')}")
    c.drawRightString(W - 12 * mm, H - 18 * mm, f'PAGE {page} OF {pages}')
    c.drawRightString(W - 12 * mm, H - 25 * mm, 'KC = key / critical characteristic (hexagon balloon)')


def _table_row(c, x, y, cols, cells, bold=False, red=False):
    c.setFont('Helvetica-Bold' if bold else 'Helvetica', 7.5)
    c.setFillColorRGB(.7, 0, 0) if red else c.setFillColorRGB(0, 0, 0)
    for (_, w), cell in zip(cols, cells):
        s = str(cell)
        while s and stringWidth(s, 'Helvetica', 7.5) > (w - 2) * mm:
            s = s[:-2] + '…' if len(s) > 2 else ''
        c.drawString(x + 1 * mm, y + 1.5 * mm, s)
        c.setStrokeColorRGB(.6, .6, .6)
        c.rect(x, y, w * mm, 5.2 * mm)
        x += w * mm
    c.setFillColorRGB(0, 0, 0)


def evaluate(q, value=None, attr=None):
    """PASS / FAIL of one measurement against the characteristic limits."""
    if q.get('unit') == 'attr' or q.get('nominal') is None:
        return 'PASS' if str(attr or '').upper() in ('PASS', 'OK', 'GO') else 'FAIL'
    if value is None or not math.isfinite(value):
        return 'FAIL'
    lo = q.get('lower') if q.get('lower') is not None else -math.inf
    hi = q.get('upper') if q.get('upper') is not None else math.inf
    return 'PASS' if lo - 1e-9 <= value <= hi + 1e-9 else 'FAIL'


def fai_report(c, part, rev, chars, records, serial, page_size, first_article=False):
    """First article / inspection report for one serial (AS9102 form 3 style: characteristic, requirement,
    result, tool, conformance) plus a summary. A first article lists every characteristic; a production
    serial lists the critical ones and anything else that was measured."""
    by_key = {r['char_key']: r for r in records if r['serial'] == serial}
    rows = [q for q in flat_list(chars) if first_article or q.get('critical') or q['key'] in by_key]
    W, H = page_size
    per = 34
    total = len(rows)
    measured = [q for q in rows if q['key'] in by_key]
    fails = [q for q in measured if by_key[q['key']]['result'] != 'PASS']
    pages = (total + per - 1) // per or 1
    for start in range(0, max(1, total), per):
        c.setPageSize(page_size)
        _form_header(c, W, H, f"{'FIRST ARTICLE ' if first_article else ''}INSPECTION REPORT  -  SERIAL {serial}", part, rev, start // per + 1, pages)
        cols = [('NO.', 16), ('ZONE', 14), ('CHARACTERISTIC', 80), ('REQUIREMENT [LOW / HIGH]', 66), ('KC', 12), ('RESULT', 34), ('OK', 18), ('TOOL', 52), ('BY / DATE', 54), ('DISPOSITION', 54)]
        y = H - 38 * mm
        _table_row(c, 10 * mm, y, cols, [k for k, _ in cols], bold=True)
        for q in rows[start:start + per]:
            y -= 5.2 * mm
            m = by_key.get(q['key'])
            req = 'ATTRIBUTE' if q['nominal'] is None else f"{_num(q['nominal'], q.get('decimals'))} [{_lim(q['lower'], q)} / {_lim(q['upper'], q)}]" + (' °' if q['unit'] == 'deg' else '')
            res = '' if not m else (m['attr'] or '') if q['nominal'] is None else _num(m['value'], max(3, q.get('decimals', 2)))
            _table_row(c, 10 * mm, y, cols, [q['no'], q['zone'], q['label'], req, 'KC' if q.get('critical') else '', res,
                                             '' if not m else m['result'], '' if not m else m.get('instrument', ''),
                                             '' if not m else f"{m['actor']} {m['created'][:10]}", '' if not m else m.get('disposition', '')], red=bool(m and m['result'] != 'PASS'))
        if start + per >= total:
            y -= 12 * mm
            c.setFont('Helvetica-Bold', 10)
            verdict = 'CONFORMING' if measured and not fails and len(measured) == total else ('NONCONFORMING' if fails else 'INCOMPLETE')
            c.drawString(12 * mm, y, f'RESULT: {verdict}    measured {len(measured)} of {total}    nonconforming {len(fails)}')
            c.setFont('Helvetica', 9)
            c.drawString(12 * mm, y - 8 * mm, 'Inspected by: ____________________    Approved by: ____________________    Date: ____________')
        c.showPage()
