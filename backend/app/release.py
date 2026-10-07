"""Release rules and the manufacturing pack.

One place decides what blocks a release (the API's release check and the worker's re-check both call it), and one
place builds the pack that goes to the shop: a readable index, a bill of materials, every drawing grouped the way
the shops use them (machining, sheet metal + flat patterns, assembly, welding, inspection) and the raw data.
"""
import csv
import io
import json
import re
import zipfile
from pathlib import Path

from . import db

CATEGORY_LABEL = {'sheet_metal': 'Sheet metal', 'machining': 'Machining', 'purchased': 'Purchased', 'other': 'Other'}
CATEGORY_ORDER = {'sheet_metal': 0, 'machining': 1, 'other': 2, 'purchased': 3}


def _load(v, default):
    try:
        return json.loads(v) if isinstance(v, str) else (v if v is not None else default)
    except ValueError:
        return default


# ---------------------------------------------------------------------------------------------- release rules
def needs_checks(p):
    """Parts that must pass design checks and reviews before release: made parts that are for production."""
    return p['category'] not in ('purchased', 'other') and not p.get('excluded')


def release_blockers(rid, rules=None):
    """What stops this revision from being released, and what is only worth knowing.
    reasons: must be fixed (missing reviews, open blockers, invalid solids). warnings: released anyway, listed in
    the release dialog and the pack (flat pattern not generated, old unapproved mating records)."""
    from .rules import evaluate
    r = db.row('SELECT * FROM revisions WHERE id=?', (rid,))
    if not r:
        return {'can_release': False, 'reasons': ['Revision not found'], 'warnings': []}
    rules = rules or _load(r['manifest'], {}).get('rules_snapshot', db.DEFAULT_RULES)
    reasons, warnings = [], []
    if r['status'] not in ('ready', 'released', 'release_pending'):
        reasons.append('Revision is not ready')
    if r['state'] != 'active':
        reasons.append('Revision is not active')
    for p in db.rows('SELECT * FROM parts WHERE revision_id=? ORDER BY name', (rid,)):
        p = dict(p)
        g, spec = _load(p['geometry'], {}), _load(p['spec'], {})
        if not needs_checks(p):
            continue
        if not p['reviewed']:
            reasons.append(p['name'] + ': design review not complete')
        if not p.get('doc_reviewed'):
            reasons.append(p['name'] + ': drawing not reviewed')
        for f in evaluate(g, spec, rules):
            if f['severity'] == 'blocker' and (not f['waiver'] or f['code'] == 'GEO001'):
                reasons.append(p['name'] + ': ' + f['title'])
        if p['category'] == 'sheet_metal' and g.get('flat_status') != 'supported' and not (spec.get('rule_waivers') or {}).get('FLAT001'):
            warnings.append(f"{p['name']}: flat pattern not generated - cut from a CAD flat")
    n = db.row('SELECT COUNT(*) AS n FROM fits WHERE revision_id=? AND approved=0', (rid,))['n']
    if n:
        warnings.append(f'{n} unapproved mating record{"s" if n != 1 else ""} from an earlier import will appear in the assembly record as not approved')
    return {'can_release': not reasons, 'reasons': reasons, 'warnings': warnings}


# ---------------------------------------------------------------------------------------------- naming
def safe_name(name, limit=60):
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', '_', str(name or '')).strip(' ._')
    s = re.sub(r'\s+', ' ', s)
    return (s[:limit].rstrip(' ._') or 'part')


def part_folders(parts):
    """Stable, readable folder name per part: '012 - LED BACK LIGHT PLATE' (BOM item number + name)."""
    out, seen = {}, {}
    for row in bom_rows(parts):
        base = f"{row['item']:03d} - {safe_name(row['alias'] or row['part'])}"
        n = seen.get(base, 0)
        seen[base] = n + 1
        out[row['id']] = base if n == 0 else f'{base} ({n + 1})'
    return out


# ---------------------------------------------------------------------------------------------- BOM
def _drawing_number(p):
    from .sheet import clean_name, part_number
    spec = p.get('spec') or {}
    return spec.get('part_number') or part_number(clean_name(p['name'])) or p['id'][:12].upper()


def bom_rows(parts):
    """Bill of materials, one row per part definition, ordered the way the shops read it: sheet metal, machining,
    other made parts, then purchased items. Not-for-production parts come last and say so."""
    rows = []
    ordered = sorted(parts, key=lambda p: (int(bool(p.get('excluded'))), CATEGORY_ORDER.get(p['category'], 9), str(p.get('alias') or ''), p['name']))
    for i, p in enumerate(ordered, 1):
        g, spec = p.get('geometry') or {}, p.get('spec') or {}
        dims = g.get('dimensions') or []
        bypass = (spec.get('rule_waivers') or {}).get('FLAT001')
        flat = ''
        if p['category'] == 'sheet_metal':
            flat = 'Included' if g.get('flat_status') == 'supported' else ('From CAD (bypassed): ' + str(bypass) if bypass else 'NOT GENERATED')
        notes = []
        if p.get('excluded'):
            notes.append('NOT FOR PRODUCTION' + (': ' + p['exclusion_reason'] if p.get('exclusion_reason') else ''))
        if spec.get('notes'):
            notes.append(str(spec['notes']))
        if g.get('replaced'):
            notes.append(f"geometry v{g['replaced'].get('version')} ({g['replaced'].get('filename', '')})")
        rows.append({
            'item': i, 'id': p['id'], 'part': p['name'], 'alias': p.get('alias') or '', 'type': CATEGORY_LABEL.get(p['category'], p['category']),
            'qty': p.get('quantity', 1), 'drawing': _drawing_number(p) if p['category'] not in ('purchased',) else '',
            'material': spec.get('material') or ('' if p['category'] == 'purchased' else 'UNSPECIFIED'),
            'thickness': f"{g['thickness']:.2f}" if p['category'] == 'sheet_metal' and g.get('thickness') else '',
            'finish': ' + '.join(x for x in [spec.get('finish'), spec.get('paint')] if x),
            'coating': ' '.join(x for x in [spec.get('coating_color'), spec.get('coating_hex')] if x),
            'process': spec.get('process') or '',
            'mass_kg': f"{g['mass_kg']:.3f}" if g.get('mass_kg') is not None else '',
            'size_mm': ' x '.join(f'{d:.1f}' for d in dims) if dims else '',
            'flat_pattern': flat, 'notes': ' | '.join(notes),
        })
    return rows


BOM_COLUMNS = [('item', 'Item'), ('drawing', 'Drawing no'), ('part', 'Part'), ('alias', 'Alias'), ('type', 'Type'), ('qty', 'Qty'), ('material', 'Material'),
               ('thickness', 'Thk (mm)'), ('finish', 'Finish'), ('coating', 'Coating'), ('process', 'Process'), ('mass_kg', 'Mass (kg)'), ('size_mm', 'Size (mm)'),
               ('flat_pattern', 'Flat pattern'), ('notes', 'Notes')]


def bom_csv(rows):
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow([label for _, label in BOM_COLUMNS])
    for r in rows:
        w.writerow([r[k] for k, _ in BOM_COLUMNS])
    return out.getvalue()


def bom_pdf(path, rows, rev, warnings=()):
    """Printable BOM: landscape A4 table, repeated header, totals by type, release status in the footer."""
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.units import mm
    from reportlab.pdfbase.pdfmetrics import stringWidth
    from reportlab.pdfgen import canvas
    W, H = landscape(A4)
    c = canvas.Canvas(str(path), pagesize=(W, H))
    c.setTitle(f"Bill of materials - {rev.get('project_name') or ''} rev {rev.get('number')}")
    cols = [('item', 'ITEM', 10, 'r'), ('drawing', 'DWG NO', 30, 'l'), ('part', 'PART', 68, 'l'), ('type', 'TYPE', 20, 'l'), ('qty', 'QTY', 10, 'r'),
            ('material', 'MATERIAL', 40, 'l'), ('thickness', 'THK', 11, 'r'), ('finish', 'FINISH / TREATMENT', 42, 'l'), ('process', 'PROCESS', 24, 'l'),
            ('mass_kg', 'KG', 13, 'r'), ('flat_pattern', 'FLAT', 24, 'l')]
    x0, y_top, row_h = 10 * mm, H - 22 * mm, 5.2 * mm
    released = rev.get('status') == 'released'

    def fit(text, width, size):
        text = str(text or '')
        while text and stringWidth(text, 'Helvetica', size) > width - 1.5 * mm:
            text = text[:-2] + '…' if len(text) > 2 else ''
        return text

    def header(page):
        c.setFillColorRGB(.06, .09, .16)
        c.setFont('Helvetica-Bold', 11)
        c.drawString(x0, H - 11 * mm, 'BILL OF MATERIALS')
        c.setFont('Helvetica', 8.5)
        c.drawString(x0 + 42 * mm, H - 11 * mm, f"{rev.get('project_code') or ''} {rev.get('project_name') or ''}  ·  Revision {rev.get('number')}  ·  {'RELEASED' if released else 'DRAFT - NOT FOR MANUFACTURE'}")
        c.drawRightString(W - 10 * mm, H - 11 * mm, f'Page {page}')
        y = y_top
        c.setFillColorRGB(.93, .94, .96)
        c.rect(x0, y - row_h + 1.2 * mm, sum(w for *_, w, _a in cols) * mm, row_h, stroke=0, fill=1)
        c.setFillColorRGB(.25, .3, .36)
        c.setFont('Helvetica-Bold', 6.8)
        x = x0
        for _, label, w, align in cols:
            (c.drawRightString if align == 'r' else c.drawString)(x + (w * mm - 1 * mm if align == 'r' else 1 * mm), y - 2.3 * mm, label)
            x += w * mm
        return y - row_h

    page = 1
    y = header(page)
    c.setFont('Helvetica', 7.2)
    for r in rows:
        if y < 18 * mm:
            c.showPage()
            page += 1
            y = header(page)
            c.setFont('Helvetica', 7.2)
        x = x0
        c.setFillColorRGB(.06, .09, .16)
        if 'NOT FOR PRODUCTION' in r['notes']:
            c.setFillColorRGB(.55, .55, .58)
        for key, _, w, align in cols:
            val = r[key]
            if key == 'flat_pattern' and val == 'NOT GENERATED':
                c.setFillColorRGB(.78, .2, .1)
            (c.drawRightString if align == 'r' else c.drawString)(x + (w * mm - 1 * mm if align == 'r' else 1 * mm), y - 2.3 * mm, fit(val, w * mm, 7.2))
            if key == 'flat_pattern' and val == 'NOT GENERATED':
                c.setFillColorRGB(.06, .09, .16)
            x += w * mm
        c.setStrokeColorRGB(.86, .88, .9)
        c.setLineWidth(.3)
        c.line(x0, y - row_h + 1.2 * mm, x, y - row_h + 1.2 * mm)
        y -= row_h
    # totals
    y -= 3 * mm
    counts = {}
    for r in rows:
        if 'NOT FOR PRODUCTION' in r['notes']:
            continue
        k = r['type']
        counts[k] = (counts.get(k, (0, 0))[0] + 1, counts.get(k, (0, 0))[1] + int(r['qty'] or 0))
    c.setFont('Helvetica', 7.5)
    c.setFillColorRGB(.3, .35, .42)
    line = '   ·   '.join(f'{k}: {n} part types, {q} pieces' for k, (n, q) in counts.items())
    if y < 14 * mm:
        c.showPage()
        page += 1
        y = header(page)
    c.drawString(x0, y - 2 * mm, line)
    y -= 5 * mm
    for w_ in warnings:
        if y < 12 * mm:
            c.showPage()
            page += 1
            y = header(page)
        c.setFillColorRGB(.72, .4, .05)
        c.drawString(x0, y - 2 * mm, fit('! ' + w_, W - 20 * mm, 7.5))
        y -= 4.2 * mm
    c.save()
    return path


# ---------------------------------------------------------------------------------------------- cut list
def cut_list_csv(parts, folder):
    """Laser / shear cut list: every sheet-metal part with its material, thickness, pieces and flat blank size."""
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(['Item', 'Part', 'Alias', 'Material', 'Thickness (mm)', 'Pieces', 'Blank X (mm)', 'Blank Y (mm)', 'Bends', 'Flat DXF', 'Note'])
    items = {r['id']: r for r in bom_rows(parts)}
    for p in parts:
        if p['category'] != 'sheet_metal' or p.get('excluded'):
            continue
        g, spec = p.get('geometry') or {}, p.get('spec') or {}
        b = g.get('flat_bounds')
        ok = g.get('flat_status') == 'supported' and (Path(folder) / 'parts' / p['id'] / 'flat.dxf').exists()
        bypass = (spec.get('rule_waivers') or {}).get('FLAT001')
        w.writerow([items[p['id']]['item'], p['name'], p.get('alias') or '', spec.get('material') or 'UNSPECIFIED',
                    f"{g['thickness']:.2f}" if g.get('thickness') else '', p.get('quantity', 1),
                    f'{b[2] - b[0]:.1f}' if ok and b else '', f'{b[3] - b[1]:.1f}' if ok and b else '', len(g.get('bends') or []),
                    'included' if ok else 'NOT INCLUDED', '' if ok else ('flat from CAD - ' + str(bypass) if bypass else 'flat pattern not generated')])
    return out.getvalue()


# ---------------------------------------------------------------------------------------------- pack
def readme(rev, parts, rows, folders, failures, missing, warnings, included):
    released = rev.get('status') == 'released'
    L = []
    L.append(f"MANUFACTURING PACK - {rev.get('project_code') or ''} {rev.get('project_name') or ''} - Revision {rev.get('number')}")
    L.append(('RELEASED FOR PRODUCTION' if released else 'DRAFT - ENGINEERING REVIEW - NOT FOR MANUFACTURE') + (f"  ·  released by {rev.get('release_by')} on {str(rev.get('release_at') or '')[:10]}" if released and rev.get('release_by') else ''))
    L.append(f"Generated {db.now()[:19].replace('T', ' ')} UTC by Forge  ·  source file {rev.get('filename') or ''}  ·  SHA-256 {rev.get('sha256') or ''}")
    L.append('')
    made = [r for r in rows if r['type'] not in ('Purchased',) and 'NOT FOR PRODUCTION' not in r['notes']]
    L.append(f"{len(rows)} part types  ·  {len(made)} made in-house  ·  {sum(1 for r in rows if r['type'] == 'Purchased')} purchased  ·  {sum(1 for r in rows if 'NOT FOR PRODUCTION' in r['notes'])} not for production")
    L.append('')
    L.append('CONTENTS')
    L.append('  BOM.pdf / BOM.csv ............ bill of materials: every part, quantity, material, finish, process, mass, drawing number')
    L.append('  drawings/machining-drawings.pdf ..... every machined part drawing in one file (index sheet first)')
    L.append('  drawings/sheet-metal-drawings.pdf ... every sheet-metal drawing in one file, with flat patterns and bend tables')
    L.append('  flat-patterns/ ............... one DXF per sheet-metal part (CUT / BEND / LABELS layers) + cut-list.csv for the laser')
    L.append('  assembly/assembly.pdf ........ assembly views and mating record;  assembly.dxf')
    if 'assembly-instructions.pdf' in included:
        L.append('  assembly/assembly-instructions.pdf ... step-by-step build order with fasteners and camera shots')
    if 'welding.pdf' in included:
        L.append('  assembly/welding.pdf ......... weld assemblies, seams and weld specifications')
    L.append('  parts/<item - name>/ ......... per part: drawing.pdf, drawing.dxf (editable), part.step, review.pdf (design rules record),')
    L.append('                                 inspection.pdf (ballooned), characteristics.csv (inspection plan), flat.dxf for sheet metal')
    L.append('  data/ ........................ parts.json, fits.json, revision.json (machine-readable copies of everything above)')
    if failures or missing:
        L.append('  failures.txt ................. what could not be generated in this run, and why')
    L.append('')
    if warnings:
        L.append('WARNINGS')
        L.extend('  ! ' + w for w in warnings)
        L.append('')
    if failures:
        L.append('NOT GENERATED - PARTS')
        L.extend(f"  x {name}: {msg}" for name, msg in failures)
        L.append('')
    if missing:
        L.append('NOT GENERATED - DOCUMENTS')
        L.extend(f"  x {name}: {msg}" for name, msg in missing)
        L.append('')
    L.append('PART FOLDERS')
    for r in rows:
        f = folders.get(r['id'])
        if f:
            L.append(f"  {f}{'  (not for production)' if 'NOT FOR PRODUCTION' in r['notes'] else ''}{'  [' + r['type'].lower() + ']' if r['type'] in ('Purchased', 'Other') else ''}")
    L.append('')
    L.append('Drawings marked DRAFT are not for manufacture. Dimensions in mm unless stated. Flat patterns are developed with the configured K factor; verify against tooling.')
    return '\n'.join(L) + '\n'


def build_pack(rid, rev, parts, selected, fits, folder, failures=(), missing=(), warnings=()):
    """Write manufacturing-pack.zip. Everything that exists goes in; what does not is listed in failures.txt and the
    README, never silently left out. Returns the zip path."""
    folder = Path(folder)
    rows = bom_rows(parts)
    folders = part_folders(parts)
    failed_ids = {pid for pid, _, _ in failures}
    failures_named = [(name, msg) for _, name, msg in failures]
    bom_pdf(folder / 'BOM.pdf', rows, rev, warnings)
    (folder / 'BOM.csv').write_text(bom_csv(rows), encoding='utf-8')
    (folder / 'cut-list.csv').write_text(cut_list_csv(parts, folder), encoding='utf-8')
    top = {'assembly.pdf': 'assembly/assembly.pdf', 'assembly.dxf': 'assembly/assembly.dxf', 'assembly-instructions.pdf': 'assembly/assembly-instructions.pdf',
           'welding.pdf': 'assembly/welding.pdf', 'machining-drawings.pdf': 'drawings/machining-drawings.pdf', 'sheet-metal-drawings.pdf': 'drawings/sheet-metal-drawings.pdf'}
    included = [name for name in top if (folder / name).exists()]
    tmp = folder / 'manufacturing-pack.zip.tmp'
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('README.txt', readme(rev, parts, rows, folders, failures_named, list(missing), list(warnings), included))
        z.write(folder / 'BOM.pdf', 'BOM.pdf')
        z.write(folder / 'BOM.csv', 'BOM.csv')
        for name in included:
            z.write(folder / name, top[name])
        z.write(folder / 'cut-list.csv', 'flat-patterns/cut-list.csv')
        from .quality import characteristics_csv_text
        for p in parts:
            pf = folder / 'parts' / p['id']
            sub = 'parts/' + folders[p['id']]
            if p['category'] == 'sheet_metal' and not p.get('excluded') and (pf / 'flat.dxf').exists() and p['id'] not in failed_ids:
                z.write(pf / 'flat.dxf', f"flat-patterns/{folders[p['id']]}.dxf")
            if p['category'] == 'purchased' or p.get('excluded') or p['id'] not in {x['id'] for x in selected}:
                # purchased / not-for-production parts: the model, so the item can be identified, nothing to make
                if (pf / 'part.step').exists():
                    z.write(pf / 'part.step', f'{sub}/part.step')
                if (pf / 'thumb.png').exists():
                    z.write(pf / 'thumb.png', f'{sub}/preview.png')
                continue
            if p['id'] in failed_ids:
                continue
            for fn in ['drawing.pdf', 'drawing.dxf', 'review.pdf', 'inspection.pdf', 'part.step', 'flat.dxf']:
                if (pf / fn).exists():
                    z.write(pf / fn, f'{sub}/{fn}')
            try:
                txt = characteristics_csv_text(p)
                if txt:
                    z.writestr(f'{sub}/characteristics.csv', txt)
            except Exception:
                pass
        if failures_named or missing:
            z.writestr('failures.txt', '\n'.join(['PARTS'] + [f'{n}: {m}' for n, m in failures_named] + ['', 'DOCUMENTS'] + [f'{n}: {m}' for n, m in missing]) + '\n')
        z.writestr('data/parts.json', json.dumps(parts, indent=2, default=str))
        z.writestr('data/fits.json', json.dumps(fits, indent=2, default=str))
        z.writestr('data/revision.json', json.dumps(rev, indent=2, default=str))
        z.writestr('data/bom.json', json.dumps(rows, indent=2))
    tmp.replace(folder / 'manufacturing-pack.zip')
    return folder / 'manufacturing-pack.zip'
