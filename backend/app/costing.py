"""Vendor pricing and job-order cost estimates.

A rate card holds what a fabricator charges: material per kg, laser cutting per metre of cut and per pierce (by
thickness), bending per stroke, plate rolling per kg, machining per hour, drilling / tapping / countersinking per
hole, hardware per piece with its insertion, welding per metre and per tack (by process and material), finishes
per square foot or per kg (with an extra per colour and a colour change), deburring, and the overheads (scrap,
stock allowance, margin, GST).

Base sheets (no vendor) are reference rate cards that can be copied; every vendor has its own card, usually a copy of
a base sheet edited to the vendor's quote. The estimate of a job order prices every make part of it from its own
geometry (flat pattern cut length and pierces, bends and rolls, holes and their hardware, surface area and mass),
the welds of the revision and the finish named in the part specification. It is an estimate for planning and vendor
comparison, not a quotation: anything Forge cannot price (bought parts, unknown materials) is listed as a warning.
"""
from __future__ import annotations

import copy
import json
import math
import re

from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel, Field, ConfigDict

from . import db, storage
from .security import user, editor
from .access import can, require

router = APIRouter()

# --------------------------------------------------------------------------------------------- base sheet
# Indicative Coimbatore job-work rates, October 2026, excluding GST. Sources: market listings for Coimbatore and
# Tamil Nadu suppliers (IndiaMART, Tata nexarc, OfBusiness) and typical shop rates; confirm with each vendor.
BASE_NAME = 'Coimbatore base sheet (Oct 2026)'
BASE_CARD = {
    'currency': 'INR',
    'region': 'Coimbatore, Tamil Nadu',
    'as_of': '2026-10',
    'notes': 'Indicative job-work rates excluding GST. Copy this sheet for a vendor and replace the rates with their quote.',
    'materials': [
        # key, name, group, form, density (kg/m³), price per kg, words that identify it in the part specification
        {'key': 'crca', 'name': 'MS CRCA (IS 513 CR)', 'group': 'ms', 'form': 'sheet', 'density': 7850, 'price_kg': 66, 'match': 'crca, cr2, cr4, is 513, is513, cold rolled, crc, dc01, spcc'},
        {'key': 'hr', 'name': 'MS HR sheet / plate (IS 2062)', 'group': 'ms', 'form': 'sheet', 'density': 7850, 'price_kg': 55, 'match': 'hr, hrpo, hot rolled, is 2062, is2062, e250, s235, s275, s355, ms plate'},
        {'key': 'gi', 'name': 'GI / GP sheet', 'group': 'gi', 'form': 'sheet', 'density': 7850, 'price_kg': 67, 'match': 'gi, gp, galvanised, galvanized, dx51d, zintec, egi'},
        {'key': 'ss316', 'name': 'SS 316 sheet', 'group': 'ss', 'form': 'sheet', 'density': 8000, 'price_kg': 330, 'match': 'ss316, ss 316, 316l, aisi 316'},
        {'key': 'ss304', 'name': 'SS 304 sheet', 'group': 'ss', 'form': 'sheet', 'density': 7930, 'price_kg': 220, 'match': 'ss304, ss 304, 304l, aisi 304, stainless, sus304'},
        {'key': 'al5052', 'name': 'Aluminium 5052 sheet', 'group': 'al', 'form': 'sheet', 'density': 2680, 'price_kg': 300, 'match': '5052, al 5052, aa5052'},
        {'key': 'al6061p', 'name': 'Aluminium 6061 plate', 'group': 'al', 'form': 'plate', 'density': 2700, 'price_kg': 330, 'match': '6061, 6082, al 6061, t6'},
        {'key': 'al1100', 'name': 'Aluminium 1100 / 3003 sheet', 'group': 'al', 'form': 'sheet', 'density': 2710, 'price_kg': 280, 'match': '1100, 3003, 1050, aluminium, aluminum'},
        {'key': 'en8', 'name': 'EN8 (C45) bar', 'group': 'ms', 'form': 'bar', 'density': 7850, 'price_kg': 78, 'match': 'en8, en 8, c45, ck45, 080m40'},
        {'key': 'en24', 'name': 'EN24 bar', 'group': 'ms', 'form': 'bar', 'density': 7850, 'price_kg': 115, 'match': 'en24, en 24, 817m40, 4340'},
        {'key': 'msbright', 'name': 'MS bright bar', 'group': 'ms', 'form': 'bar', 'density': 7850, 'price_kg': 72, 'match': 'bright bar, ms bar, en1a, en 1a, mild steel'},
        {'key': 'ss304bar', 'name': 'SS 304 bar', 'group': 'ss', 'form': 'bar', 'density': 7930, 'price_kg': 250, 'match': 'ss bar, 304 bar'},
        {'key': 'brass', 'name': 'Brass', 'group': 'brass', 'form': 'bar', 'density': 8500, 'price_kg': 620, 'match': 'brass, cuzn, cz121'},
        {'key': 'pom', 'name': 'Acetal / POM (Delrin)', 'group': 'plastic', 'form': 'bar', 'density': 1410, 'price_kg': 420, 'match': 'pom, acetal, delrin'},
        {'key': 'nylon', 'name': 'Nylon 6 / PA', 'group': 'plastic', 'form': 'bar', 'density': 1150, 'price_kg': 360, 'match': 'nylon, pa6, pa 6, polyamide'},
    ],
    'defaults': {'sheet': 'crca', 'bar': 'msbright'},
    # laser cutting of mild steel by thickness; other materials scale by the group multiplier
    'laser': [
        {'thickness': 0.8, 'per_m': 7, 'pierce': 0.5}, {'thickness': 1.0, 'per_m': 8, 'pierce': 0.5}, {'thickness': 1.2, 'per_m': 9, 'pierce': 0.5},
        {'thickness': 1.5, 'per_m': 10, 'pierce': 0.6}, {'thickness': 2.0, 'per_m': 12, 'pierce': 0.8}, {'thickness': 2.5, 'per_m': 15, 'pierce': 1.0},
        {'thickness': 3.0, 'per_m': 18, 'pierce': 1.2}, {'thickness': 4.0, 'per_m': 24, 'pierce': 1.5}, {'thickness': 5.0, 'per_m': 30, 'pierce': 2.0},
        {'thickness': 6.0, 'per_m': 38, 'pierce': 2.5}, {'thickness': 8.0, 'per_m': 60, 'pierce': 4.0}, {'thickness': 10.0, 'per_m': 80, 'pierce': 5.0},
        {'thickness': 12.0, 'per_m': 100, 'pierce': 6.0}, {'thickness': 16.0, 'per_m': 150, 'pierce': 8.0}, {'thickness': 20.0, 'per_m': 200, 'pierce': 10.0},
    ],
    'laser_group': {'ms': 1.0, 'gi': 1.05, 'ss': 1.6, 'al': 1.5, 'brass': 2.0, 'plastic': 1.0},
    'laser_min_part': 5,
    # bending per press stroke, by thickness
    'bending': [
        {'thickness': 1.5, 'per_stroke': 6}, {'thickness': 2.0, 'per_stroke': 7}, {'thickness': 3.0, 'per_stroke': 8},
        {'thickness': 4.0, 'per_stroke': 10}, {'thickness': 6.0, 'per_stroke': 15}, {'thickness': 10.0, 'per_stroke': 25},
    ],
    'bend_long_mm': 1000, 'bend_long_factor': 1.5, 'bend_setup': 100,
    'rolling': {'per_kg': 6, 'setup': 150, 'min_part': 40},
    'machining': {'per_hour': 650, 'setup_hours': 0.75, 'handling_min': 5, 'per_feature_min': 0.4, 'stock_mm': 3,
                  'mrr': {'ms': 12, 'ss': 6, 'al': 40, 'brass': 25, 'plastic': 60, 'gi': 12}},
    'drilling': [{'diameter': 6, 'per_hole': 3}, {'diameter': 12, 'per_hole': 5}, {'diameter': 20, 'per_hole': 8}, {'diameter': 50, 'per_hole': 15}],
    'tapping': [{'diameter': 4, 'per_hole': 3}, {'diameter': 6, 'per_hole': 4}, {'diameter': 8, 'per_hole': 6}, {'diameter': 12, 'per_hole': 10}, {'diameter': 30, 'per_hole': 15}],
    'countersink_per_hole': 3,
    # hardware price per piece (zinc-plated steel), insertion per piece by kind
    'hardware': [
        {'type': 'nut', 'thread': 'M2-M4', 'price': 2.5}, {'type': 'nut', 'thread': 'M5', 'price': 3}, {'type': 'nut', 'thread': 'M6', 'price': 3.5}, {'type': 'nut', 'thread': 'M8', 'price': 5},
        {'type': 'flush_nut', 'thread': '*', 'price': 5},
        {'type': 'stud', 'thread': 'M3-M4', 'price': 4}, {'type': 'stud', 'thread': 'M5-M6', 'price': 5}, {'type': 'stud', 'thread': 'M8', 'price': 8},
        {'type': 'standoff', 'thread': 'M3', 'price': 6}, {'type': 'standoff', 'thread': '*', 'price': 8},
        {'type': 'rivnut', 'thread': 'M3-M5', 'price': 4}, {'type': 'rivnut', 'thread': 'M6', 'price': 5}, {'type': 'rivnut', 'thread': 'M8', 'price': 7}, {'type': 'rivnut', 'thread': '*', 'price': 10},
        {'type': 'weld_nut', 'thread': 'M4-M6', 'price': 2.5}, {'type': 'weld_nut', 'thread': 'M8', 'price': 4}, {'type': 'weld_nut', 'thread': '*', 'price': 6},
    ],
    'insertion': {'press': 2, 'rivnut': 3, 'weld_nut': 4},
    # welding per metre of weld and per tack, by process and material group
    'welding': [
        {'process': 'MIG/MAG', 'group': 'ms', 'per_m': 60, 'per_tack': 4}, {'process': 'MIG/MAG', 'group': 'ss', 'per_m': 90, 'per_tack': 5},
        {'process': 'MIG/MAG', 'group': 'al', 'per_m': 130, 'per_tack': 6}, {'process': 'TIG', 'group': 'ms', 'per_m': 120, 'per_tack': 5},
        {'process': 'TIG', 'group': 'ss', 'per_m': 150, 'per_tack': 6}, {'process': 'TIG', 'group': 'al', 'per_m': 200, 'per_tack': 8},
        {'process': 'Spot', 'group': '*', 'per_m': 40, 'per_tack': 2}, {'process': '*', 'group': '*', 'per_m': 80, 'per_tack': 5},
    ],
    'weld_grind_per_m': 40, 'weld_setup': 200, 'weld_min': 20,
    # finishes: basis sqft (surface area) | kg | part; setup once per job; colour extras per sqft
    'finishes': [
        {'key': 'powder', 'name': 'Powder coating (standard RAL, matte / texture)', 'basis': 'sqft', 'rate': 18, 'setup': 500, 'min_part': 15, 'match': 'powder, pc, polyester, epoxy powder'},
        {'key': 'powder_special', 'name': 'Powder coating (gloss / metallic / special)', 'basis': 'sqft', 'rate': 25, 'setup': 700, 'min_part': 20, 'match': 'metallic powder, gloss powder, special powder'},
        {'key': 'pu', 'name': 'Liquid paint (primer + PU)', 'basis': 'sqft', 'rate': 35, 'setup': 400, 'min_part': 20, 'match': 'pu paint, polyurethane, liquid paint, spray paint, enamel, paint'},
        {'key': 'zinc_yellow', 'name': 'Zinc plating, yellow passivated', 'basis': 'kg', 'rate': 40, 'setup': 0, 'min_part': 10, 'match': 'yellow zinc, zinc yellow, yellow passiv, zn yellow'},
        {'key': 'zinc', 'name': 'Zinc plating, clear / blue', 'basis': 'kg', 'rate': 35, 'setup': 0, 'min_part': 10, 'match': 'zinc plat, zinc plated, zn plat, electro galv, blue passiv, clear passiv'},
        {'key': 'hdg', 'name': 'Hot-dip galvanising', 'basis': 'kg', 'rate': 40, 'setup': 0, 'min_part': 15, 'match': 'hot dip, hdg, hot-dip'},
        {'key': 'phosphate', 'name': 'Zinc phosphating', 'basis': 'kg', 'rate': 10, 'setup': 0, 'min_part': 5, 'match': 'phosphat'},
        {'key': 'anodise_black', 'name': 'Anodising, black', 'basis': 'sqft', 'rate': 28, 'setup': 300, 'min_part': 15, 'match': 'black anodi, anodised black, anodized black'},
        {'key': 'anodise', 'name': 'Anodising, clear / natural', 'basis': 'sqft', 'rate': 20, 'setup': 300, 'min_part': 15, 'match': 'anodi'},
        {'key': 'electropolish', 'name': 'Electropolishing / passivation (SS)', 'basis': 'sqft', 'rate': 40, 'setup': 300, 'min_part': 15, 'match': 'electropol, passivat, pickl'},
        {'key': 'brush', 'name': 'Brushed / buffed finish', 'basis': 'sqft', 'rate': 15, 'setup': 0, 'min_part': 10, 'match': 'brush, buff, satin, hairline, no. 4, scotch'},
    ],
    'colours': [
        {'code': 'RAL 9005', 'name': 'Jet black', 'extra_sqft': 0}, {'code': 'RAL 7035', 'name': 'Light grey', 'extra_sqft': 0},
        {'code': 'RAL 9016', 'name': 'Traffic white', 'extra_sqft': 0}, {'code': 'RAL 9010', 'name': 'Pure white', 'extra_sqft': 0},
        {'code': 'RAL 7016', 'name': 'Anthracite grey', 'extra_sqft': 1}, {'code': 'RAL 5015', 'name': 'Sky blue', 'extra_sqft': 2},
        {'code': 'RAL 3020', 'name': 'Traffic red', 'extra_sqft': 2}, {'code': 'RAL 1023', 'name': 'Traffic yellow', 'extra_sqft': 3},
        {'code': 'RAL 6018', 'name': 'Yellow green', 'extra_sqft': 3}, {'code': 'RAL 9006', 'name': 'White aluminium (metallic)', 'extra_sqft': 6},
        {'code': '*', 'name': 'Any other colour', 'extra_sqft': 3},
    ],
    'deburr_per_part': 3,
    'tap_setup': 100, 'hardware_setup': 100,
    # labour discount by job quantity (material and bought hardware are not discounted)
    'qty_breaks': [{'min_qty': 1, 'discount_pct': 0}, {'min_qty': 10, 'discount_pct': 5}, {'min_qty': 50, 'discount_pct': 10},
                   {'min_qty': 100, 'discount_pct': 15}, {'min_qty': 500, 'discount_pct': 20}],
    'overheads': {'scrap_pct': 15, 'margin_pct': 10, 'gst_pct': 18, 'min_job': 0, 'transport': 0},
}

SECTIONS = {   # list sections and the numeric columns of their rows
    'materials': ('density', 'price_kg'), 'laser': ('thickness', 'per_m', 'pierce'), 'bending': ('thickness', 'per_stroke'),
    'drilling': ('diameter', 'per_hole'), 'tapping': ('diameter', 'per_hole'), 'hardware': ('price',),
    'welding': ('per_m', 'per_tack'), 'finishes': ('rate', 'setup', 'min_part', 'per_part'), 'colours': ('extra_sqft',),
    'qty_breaks': ('min_qty', 'discount_pct'),
}
SCALARS = ('laser_min_part', 'bend_long_mm', 'bend_long_factor', 'bend_setup', 'countersink_per_hole', 'weld_grind_per_m', 'weld_setup', 'weld_min', 'deburr_per_part', 'tap_setup', 'hardware_setup')
GROUPS = ('ms', 'gi', 'ss', 'al', 'brass', 'plastic')
HW_TYPES = ('nut', 'flush_nut', 'stud', 'standoff', 'rivnut', 'weld_nut')


def _f(v, lo=0.0, hi=1e9, default=0.0):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(x):
        return default
    return min(hi, max(lo, x))


def clean_card(data):
    """Validated copy of a rate card: unknown keys dropped, numbers made numbers, sections kept in shape."""
    if not isinstance(data, dict):
        raise HTTPException(422, 'Rate card must be an object')
    base = BASE_CARD
    out = {k: str(data.get(k, base[k]))[:300] for k in ('currency', 'region', 'as_of', 'notes')}
    for sec, nums in SECTIONS.items():
        rows = data.get(sec, base[sec])
        if not isinstance(rows, list) or len(rows) > 400:
            raise HTTPException(422, f'{sec} must be a list of rows')
        clean = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            c = {k: (str(v)[:200] if not isinstance(v, (int, float)) else v) for k, v in r.items() if isinstance(k, str) and len(k) <= 40 and isinstance(v, (str, int, float))}
            for n in nums:
                c[n] = _f(c.get(n))
            clean.append(c)
        if sec == 'materials':
            for i, m in enumerate(clean):
                m['key'] = re.sub(r'[^a-z0-9_]', '', str(m.get('key') or f'm{i}').lower())[:30] or f'm{i}'
                m['group'] = m.get('group') if m.get('group') in GROUPS else 'ms'
                m['form'] = m.get('form') if m.get('form') in ('sheet', 'plate', 'bar') else 'sheet'
                m['density'] = m['density'] or 7850
        if sec in ('laser', 'bending'):
            clean.sort(key=lambda r: r['thickness'])
        if sec in ('drilling', 'tapping'):
            clean.sort(key=lambda r: r['diameter'])
        if sec == 'qty_breaks':
            clean.sort(key=lambda r: r['min_qty'])
        if sec == 'finishes':
            for i, f in enumerate(clean):
                f['key'] = re.sub(r'[^a-z0-9_]', '', str(f.get('key') or f'f{i}').lower())[:30] or f'f{i}'
                f['basis'] = f.get('basis') if f.get('basis') in ('sqft', 'kg', 'part') else 'sqft'
        out[sec] = clean
    for k in SCALARS:
        out[k] = _f(data.get(k, base[k]))
    out['laser_group'] = {g: _f((data.get('laser_group') or {}).get(g, base['laser_group'].get(g, 1)), 0, 20, 1) for g in GROUPS}
    out['defaults'] = {k: str((data.get('defaults') or {}).get(k, base['defaults'][k]))[:30] for k in ('sheet', 'bar')}
    r = data.get('rolling') or {}
    out['rolling'] = {k: _f(r.get(k, base['rolling'][k])) for k in base['rolling']}
    m = data.get('machining') or {}
    out['machining'] = {k: _f(m.get(k, base['machining'][k])) for k in base['machining'] if k != 'mrr'}
    out['machining']['mrr'] = {g: _f((m.get('mrr') or {}).get(g, base['machining']['mrr'].get(g, 12)), 0.1, 1000, 12) for g in GROUPS}
    ins = data.get('insertion') or {}
    out['insertion'] = {k: _f(ins.get(k, base['insertion'][k])) for k in base['insertion']}
    o = data.get('overheads') or {}
    out['overheads'] = {k: _f(o.get(k, base['overheads'][k]), 0, 1e9 if k in ('min_job', 'transport') else 500) for k in base['overheads']}
    return out


# --------------------------------------------------------------------------------------------- storage
def ensure_base():
    """The reference base sheet exists from the first use (an installation can add more, or edit it)."""
    if not db.row('SELECT id FROM rate_cards WHERE vendor_id IS NULL AND archived=0 LIMIT 1'):
        with db.connect() as c:
            c.execute('INSERT INTO rate_cards(id,name,vendor_id,data,created,updated,author,archived) VALUES(?,?,?,?,?,?,?,0)',
                      (db.uid(), BASE_NAME, None, json.dumps(BASE_CARD), db.now(), db.now(), 'Forge'))


def default_card():
    ensure_base()
    r = db.row('SELECT * FROM rate_cards WHERE vendor_id IS NULL AND archived=0 ORDER BY created LIMIT 1')
    return {**r, 'data': clean_card(json.loads(r['data']))}


def card_for(vendor_id=None):
    """(vendor, card): the vendor's own rate card, or the first base sheet."""
    v = None
    if vendor_id:
        v = db.row('SELECT * FROM vendors WHERE id=?', (vendor_id,))
        if not v:
            raise HTTPException(404, 'Vendor not found')
        if v.get('rate_card_id'):
            r = db.row('SELECT * FROM rate_cards WHERE id=? AND archived=0', (v['rate_card_id'],))
            if r:
                return v, {**r, 'data': clean_card(json.loads(r['data']))}
    return v, default_card()


# --------------------------------------------------------------------------------------------- the estimate
def _words(text):
    return ' ' + re.sub(r'[^a-z0-9.]+', ' ', (text or '').lower()) + ' '


def _matches(text, match):
    t = _words(text)
    for k in [x.strip().lower() for x in re.split(r'[,;]', match or '') if x.strip()]:
        if _words(k) in t or (len(k) > 4 and k in t):
            return True
    return False


def material_of(card, spec, category):
    text = ' '.join(str(spec.get(k) or '') for k in ('material', 'stock'))
    for m in card['materials']:
        if text.strip() and (_matches(text, m.get('match', '')) or _matches(text, m['name'])):
            return m, True
    key = card['defaults']['sheet' if category == 'sheet_metal' else 'bar']
    m = next((x for x in card['materials'] if x['key'] == key), None) or (card['materials'][0] if card['materials'] else
                                                                        {'key': 'none', 'name': 'Unknown', 'group': 'ms', 'density': 7850, 'price_kg': 0})
    return m, False


def by_thickness(rows, t, col):
    """The rate for thickness t: the first row at or above it; past the table, scaled from the last row."""
    if not rows:
        return 0.0
    for r in rows:
        if r['thickness'] >= t - 1e-6:
            return r[col]
    last = rows[-1]
    return last[col] * (t / last['thickness'] if last['thickness'] else 1)


def by_diameter(rows, d, col='per_hole'):
    if not rows:
        return 0.0
    for r in rows:
        if r['diameter'] >= d - 1e-6:
            return r[col]
    return rows[-1][col]


def _thread_dia(thread):
    t = str(thread or '').upper().replace(' ', '')
    m = re.match(r'M(\d+(?:\.\d+)?)', t)
    if m:
        return float(m.group(1))
    imp = {'#2': 2.18, '#4': 2.84, '#6': 3.51, '#8': 4.17, '#10': 4.83, '1/4': 6.35, '5/16': 7.94, '3/8': 9.53, '1/2': 12.7}
    for k, v in imp.items():
        if t.startswith(k):
            return v
    return 0.0


def _thread_in(thread, spec):
    """Whether a hardware thread falls in a rate row's thread spec: '*', 'M5', 'M2-M4', 'M3,M4'."""
    s = str(spec or '*').upper().replace(' ', '')
    if s in ('*', ''):
        return True
    d = _thread_dia(thread)
    for part in s.split(','):
        if '-' in part:
            a, b = [_thread_dia(x) for x in part.split('-', 1)]
            if a and b and a - 1e-6 <= d <= b + 1e-6:
                return True
        elif _thread_dia(part) and abs(_thread_dia(part) - d) < 1e-6:
            return True
    return False


def hardware_price(card, hw_type, thread):
    rows = [r for r in card['hardware'] if r.get('type') == hw_type]
    for r in rows:
        if str(r.get('thread', '*')).strip() not in ('*', '') and _thread_in(thread, r.get('thread')):
            return r['price']
    for r in rows:
        if str(r.get('thread', '*')).strip() in ('*', ''):
            return r['price']
    return None


def welding_rate(card, process, group):
    proc = (process or '').upper()
    def ok(r):
        rp = str(r.get('process', '*')).upper()
        return (rp == '*' or rp in proc or proc in rp) and r.get('group', '*') in ('*', group)
    exact = [r for r in card['welding'] if ok(r) and str(r.get('process')) != '*' and r.get('group') != '*']
    rows = exact or [r for r in card['welding'] if ok(r)]
    return rows[0] if rows else {'per_m': 0, 'per_tack': 0}


def finish_of(card, spec):
    text = ' '.join(str(spec.get(k) or '') for k in ('finish', 'paint', 'process'))
    if not text.strip() or re.search(r'not applicable|^\s*none\s*$|as cut|bare|unpainted', text, re.I):
        return None
    for f in card['finishes']:
        if _matches(text, f.get('match', '')):
            return f
    return None


def colour_extra(card, spec):
    code = (spec.get('coating_color') or '').upper().replace(' ', '')
    if not code:
        return None
    for c in card['colours']:
        if str(c.get('code', '')).upper().replace(' ', '') == code:
            return c
    return next((c for c in card['colours'] if c.get('code') == '*'), None)


def _flat(rid, pid):
    f = db.revdir(rid) / 'parts' / pid / 'flat.json'
    if not f.exists():
        try:
            storage.restore(rid, f'parts/{pid}/flat.json', f)
        except Exception:
            pass
    if f.exists():
        try:
            return json.loads(f.read_text())
        except ValueError:
            return None
    return None


def _ring_len(ring):
    return sum(math.dist(ring[i], ring[(i + 1) % len(ring)]) for i in range(len(ring))) if len(ring) > 1 else 0.0


def _ring_area(ring):
    return abs(sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1] for i in range(len(ring)))) / 2 if len(ring) > 2 else 0.0


def _line(process, basis, qty, unit, rate, note='', per_job=False):
    return {'process': process, 'basis': basis, 'qty': round(qty, 3), 'unit': unit, 'rate': round(rate, 3), 'amount': round(qty * rate, 2), 'note': note, 'per_job': per_job}


SQFT = 92903.04   # mm² per square foot


def price_part(card, p, qty, rid, warnings):
    """Cost lines of one make part for `qty` pieces. Per-piece lines are multiplied by qty; setups are per job."""
    g, spec = p['geometry'], p['spec']
    name = p.get('alias') or p['name']
    opts = p.get('drawing_options') or {}
    mat, matched = material_of(card, spec, p['category'])
    if not matched:
        warnings.append(f"{name}: material '{spec.get('material') or 'not set'}' not on the rate card, priced as {mat['name']}")
    group = mat.get('group', 'ms')
    density = float(mat.get('density') or 7850) * 1e-9   # kg/mm³
    oh = card['overheads']
    lines = []
    t = float(g.get('thickness') or 0)
    holes = g.get('holes') or []
    fs = spec.get('feature_specs') or {}
    hw = {hid: (f or {}).get('hardware') for hid, f in fs.items() if (f or {}).get('hardware')}
    if p['category'] == 'sheet_metal':
        flat = _flat(rid, p['id'])
        if flat and flat.get('outline'):
            outline = flat['outline']
            blank = _ring_area(outline)
            cut = _ring_len(outline) + sum(_ring_len(h) for h in flat.get('holes') or [])
            pierces = 1 + len(flat.get('holes') or [])
        else:
            blank = float(g.get('volume') or 0) / t if t else 0.0
            side = math.sqrt(max(blank, 0))
            cut = 4 * side + sum(math.pi * float(h.get('diameter') or 0) for h in holes)
            pierces = 1 + len(holes)
            warnings.append(f'{name}: no flat pattern yet, cut length estimated from the volume (generate documents for an exact figure)')
        kg = blank * t * density * (1 + oh['scrap_pct'] / 100)
        lines.append(_line('Material', f"{mat['name']} · {t:g} mm · blank {blank / 1e6:.4f} m² + {oh['scrap_pct']:g}% scrap", kg, 'kg', mat['price_kg']))
        per_m = by_thickness(card['laser'], t, 'per_m') * card['laser_group'].get(group, 1)
        pierce = by_thickness(card['laser'], t, 'pierce') * card['laser_group'].get(group, 1)
        laser = cut / 1000 * per_m + pierces * pierce
        if laser < card['laser_min_part']:
            lines.append(_line('Laser cutting', f'{cut / 1000:.2f} m cut, {pierces} pierces · minimum per part', 1, 'part', card['laser_min_part']))
        else:
            lines.append(_line('Laser cutting', f'{cut / 1000:.2f} m cut × ₹{per_m:g}/m', cut / 1000, 'm', per_m))
            lines.append(_line('Pierces', f'{pierces} pierces', pierces, 'pierce', pierce))
        procs = opts.get('bend_process') or {}
        from .bendplan import default_process
        brake = roll = 0
        long_bends = 0
        for b in g.get('bends') or []:
            pr = procs.get(b.get('id')) or default_process(float(b.get('radius') or 0), t or 1)
            if pr == 'roll':
                roll += 1
            else:
                brake += 1
                if float(b.get('length') or 0) > card['bend_long_mm']:
                    long_bends += 1
        if brake:
            rate = by_thickness(card['bending'], t, 'per_stroke')
            strokes = brake + long_bends * (card['bend_long_factor'] - 1)
            lines.append(_line('Bending', f"{brake} stroke{'s' if brake > 1 else ''}" + (f' ({long_bends} long)' if long_bends else ''), strokes, 'stroke', rate))
            lines.append(_line('Bending setup', 'press brake setup, once per job', 1, 'job', card['bend_setup'], per_job=True))
        if roll:
            part_kg = float(g.get('volume') or 0) * density
            r = card['rolling']
            amount = max(r['min_part'], part_kg * r['per_kg'])
            lines.append(_line('Rolling', f"{roll} rolled curve{'s' if roll > 1 else ''} · {part_kg:.2f} kg", 1, 'part', amount))
            lines.append(_line('Rolling setup', 'plate roll setup, once per job', 1, 'job', r['setup'], per_job=True))
        lines.append(_line('Deburring', 'edges deburred', 1, 'part', card['deburr_per_part']))
    else:
        dims = sorted(float(x or 0) for x in (g.get('dimensions') or [0, 0, 0]))
        m = card['machining']
        stock = 1.0
        for d in dims:
            stock *= d + 2 * m['stock_mm']
        vol = float(g.get('volume') or 0)
        kg = stock * density
        lines.append(_line('Material', f"{mat['name']} · stock " + ' × '.join('%.0f' % (d + 2 * m['stock_mm']) for d in dims) + ' mm', kg, 'kg', mat['price_kg']))
        removed_cm3 = max(0.0, stock - vol) / 1000
        mins = m['handling_min'] + removed_cm3 / max(m['mrr'].get(group, 12), .1) + m['per_feature_min'] * len(holes)
        lines.append(_line('Machining', f'{mins:.0f} min · {removed_cm3:.0f} cm³ removed (rough estimate)', mins / 60, 'h', m['per_hour']))
        lines.append(_line('Machining setup', f"{m['setup_hours']:g} h setup, once per job", m['setup_hours'], 'h', m['per_hour'], per_job=True))
        plain = [h for h in holes if h.get('id') not in hw]
        if plain:
            amount = sum(by_diameter(card['drilling'], float(h.get('diameter') or 0)) for h in plain)
            lines.append(_line('Drilling', f'{len(plain)} hole{"s" if len(plain) > 1 else ""}', len(plain), 'hole', amount / len(plain)))
    # hole hardware: taps, countersinks, inserts
    taps, csk, ins = [], 0, {}
    for hid, item in hw.items():
        t_ = item.get('type')
        if t_ == 'tap':
            taps.append(item)
        elif t_ == 'countersink':
            csk += 1
        elif t_ in HW_TYPES:
            key = (t_, item.get('thread') or item.get('name') or '')
            ins[key] = ins.get(key, 0) + 1
    if taps:
        amount = sum(by_diameter(card['tapping'], _thread_dia(x.get('thread')) or 6) for x in taps)
        lines.append(_line('Tapping', f"{len(taps)} tapped hole{'s' if len(taps) > 1 else ''}", len(taps), 'hole', amount / len(taps)))
        if card['tap_setup']:
            lines.append(_line('Tapping setup', 'once per job', 1, 'job', card['tap_setup'], per_job=True))
    if csk:
        lines.append(_line('Countersinking', f'{csk} countersunk hole{"s" if csk > 1 else ""}', csk, 'hole', card['countersink_per_hole']))
    if ins and card['hardware_setup']:
        lines.append(_line('Hardware setup', 'insertion press setup, once per job', 1, 'job', card['hardware_setup'], per_job=True))
    for (t_, thread), n in sorted(ins.items()):
        price = hardware_price(card, t_, thread)
        label = t_.replace('_', ' ')
        if price is None:
            warnings.append(f'{name}: no price for {label} {thread} on the rate card')
            price = 0
        lines.append(_line('Hardware', f'{n} × {label} {thread}', n, 'pc', price))
        kind = 'weld_nut' if t_ == 'weld_nut' else 'rivnut' if t_ == 'rivnut' else 'press'
        lines.append(_line('Hardware insertion', f'{n} × {"projection welding" if kind == "weld_nut" else "rivnut setting" if kind == "rivnut" else "press-in"}', n, 'pc', card['insertion'][kind]))
    # finish
    fin = finish_of(card, spec)
    finish_key = None
    if fin:
        area_sqft = float(g.get('area') or 0) / SQFT
        kg_part = float(g.get('mass_kg') or 0) or float(g.get('volume') or 0) * density
        if fin['basis'] == 'sqft':
            col = colour_extra(card, spec) if fin['key'].startswith('powder') or fin['key'] == 'pu' else None
            rate = fin['rate'] + (col['extra_sqft'] if col else 0)
            amount = max(fin['min_part'], area_sqft * rate + fin.get('per_part', 0))
            what = f"{fin['name']}" + (f" · {spec.get('coating_color')}" if spec.get('coating_color') else '')
            lines.append(_line('Finish', f'{what} · {area_sqft:.2f} sq ft', 1, 'part', amount))
        elif fin['basis'] == 'kg':
            lines.append(_line('Finish', f"{fin['name']} · {kg_part:.2f} kg", 1, 'part', max(fin['min_part'], kg_part * fin['rate'])))
        else:
            lines.append(_line('Finish', fin['name'], 1, 'part', fin['rate']))
        finish_key = (fin['key'], (spec.get('coating_color') or '').upper())
    elif str(spec.get('finish') or spec.get('paint') or '').strip() and not re.search(r'not applicable|none|deburr|as cut', str(spec.get('finish') or spec.get('paint')), re.I):
        warnings.append(f"{name}: finish '{spec.get('finish') or spec.get('paint')}' not on the rate card, not priced")
    disc = 0.0
    for b in card.get('qty_breaks') or []:
        if qty >= b['min_qty']:
            disc = b['discount_pct']
    if disc:
        for l in lines:
            if not l['per_job'] and l['process'] not in ('Material', 'Hardware'):
                l['rate'] = round(l['rate'] * (1 - disc / 100), 3)
                l['amount'] = round(l['qty'] * l['rate'], 2)
                l['note'] = (l['note'] + ' ' if l['note'] else '') + f'−{disc:g}% for {qty} pcs'
    per_piece = sum(l['amount'] for l in lines if not l['per_job'])
    per_job = sum(l['amount'] for l in lines if l['per_job'])
    return {'part_id': p['id'], 'part': name, 'category': p['category'], 'qty': qty, 'material': mat['name'], 'group': group,
            'lines': lines, 'unit_cost': round(per_piece, 2), 'setup': round(per_job, 2), 'total': round(per_piece * qty + per_job, 2),
            'finish': finish_key, 'finish_setup': (fin or {}).get('setup', 0)}


def estimate(rid, quantities, weld_counts, card_row, vendor=None, job_extras=True):
    """quantities: {part_id: pieces}; weld_counts: {joint_id: count}. Returns the priced estimate."""
    card = card_row['data']
    warnings = []
    parts = []
    for pid, qty in quantities.items():
        p = db.row('SELECT * FROM parts WHERE id=? AND revision_id=?', (pid, rid))
        if not p or qty <= 0:
            continue
        p['geometry'] = json.loads(p['geometry'])
        p['spec'] = json.loads(p['spec'])
        p['drawing_options'] = json.loads(p.get('drawing_options') or '{}') if isinstance(p.get('drawing_options'), str) else (p.get('drawing_options') or {})
        if p['category'] == 'purchased':
            continue
        parts.append(price_part(card, p, qty, rid, warnings))
    parts.sort(key=lambda x: -x['total'])
    groups = {x['part_id']: x['group'] for x in parts}
    # welds
    welds = []
    if weld_counts:
        from .welding import weld_rows
        try:
            rows = weld_rows(rid)
        except Exception:
            rows = []
        for r in rows:
            n = weld_counts.get(r['id'], 0)
            if n <= 0:
                continue
            grp = next((groups[x] for x in r.get('part_ids') or [] if x in groups), 'ms')
            rate = welding_rate(card, r.get('process'), grp)
            if r['type'] == 'tack':
                m = re.match(r'(\d+)', r.get('pattern') or '')
                tacks = int(m.group(1)) if m else 1
                amount = tacks * rate['per_tack']
                basis = f"{tacks} tack{'s' if tacks > 1 else ''} × ₹{rate['per_tack']:g}"
            else:
                L = float(r.get('weld_length') or 0) / 1000
                amount = L * rate['per_m'] + (L * card['weld_grind_per_m'] if r.get('ground') else 0)
                basis = f"{L * 1000:.0f} mm × ₹{rate['per_m']:g}/m" + (' + grinding' if r.get('ground') else '')
                if L <= 0:
                    warnings.append(f"W{r['n']}: weld length not measured (face-pair weld), minimum charge used")
            amount = max(card['weld_min'], amount)
            welds.append({'weld': f"W{r['n']}", 'parts': ' + '.join(r['parts']), 'process': r.get('process') or '—', 'group': grp, 'basis': basis,
                          'qty': n, 'unit_cost': round(amount, 2), 'total': round(amount * n, 2)})
    weld_setup = card['weld_setup'] if welds else 0
    # finishing setups: once per finish and colour in the job
    seen = {}
    for x in parts:
        if x['finish']:
            seen[tuple(x['finish'])] = max(seen.get(tuple(x['finish']), 0), x['finish_setup'])
    finish_setups = [{'finish': k[0], 'colour': k[1], 'amount': v} for k, v in seen.items() if v]
    by_process = {}
    for x in parts:
        for l in x['lines']:
            amt = l['amount'] if l['per_job'] else l['amount'] * x['qty']
            by_process[l['process']] = by_process.get(l['process'], 0) + amt
    if welds:
        by_process['Welding'] = sum(w['total'] for w in welds) + weld_setup
    if finish_setups:
        by_process['Finish setup (per colour)'] = sum(f['amount'] for f in finish_setups)
    transport = card['overheads']['transport'] if job_extras else 0
    subtotal = sum(by_process.values()) + transport
    if transport:
        by_process['Transport'] = transport
    if job_extras:
        subtotal = max(subtotal, card['overheads']['min_job'])
    margin = subtotal * card['overheads']['margin_pct'] / 100
    taxable = subtotal + margin
    gst = taxable * card['overheads']['gst_pct'] / 100
    for x in parts:
        x.pop('finish', None)
        x.pop('finish_setup', None)
    return {
        'currency': card.get('currency', 'INR'), 'vendor_id': (vendor or {}).get('id') or '', 'vendor': (vendor or {}).get('name') or 'Base rates',
        'rate_card_id': card_row['id'], 'rate_card': card_row['name'], 'computed': db.now(),
        'parts': parts, 'welds': welds, 'weld_setup': weld_setup, 'finish_setups': finish_setups,
        'by_process': [{'process': k, 'amount': round(v, 2)} for k, v in sorted(by_process.items(), key=lambda kv: -kv[1])],
        'subtotal': round(subtotal, 2), 'margin_pct': card['overheads']['margin_pct'], 'margin': round(margin, 2),
        'gst_pct': card['overheads']['gst_pct'], 'gst': round(gst, 2), 'total': round(taxable + gst, 2),
        'pieces': sum(x['qty'] for x in parts), 'warnings': warnings,
    }


def jo_quantities(items):
    """Pieces per make part and count per weld, from job-order lines."""
    q, w = {}, {}
    for i in items:
        pid, req = i['part_id'], int(i['required'] or 0)
        if str(pid).startswith('joint:'):
            w[pid[6:]] = max(w.get(pid[6:], 0), req)
        elif i['kind'] != 'procurement':
            q[pid] = max(q.get(pid, 0), req)
    return q, w


def estimate_job_order(j, vendor_id=None):
    items = db.rows('SELECT part_id,required,kind FROM jo_items WHERE job_order_id=?', (j['id'],))
    q, w = jo_quantities(items)
    vendor, card = card_for(vendor_id if vendor_id is not None else j.get('vendor_id'))
    return estimate(j['revision_id'], q, w, card, vendor)


def can_price(u, project_id=None):
    return can(u, 'pricing.manage', project_id) or can(u, 'joborder.create', project_id)


# --------------------------------------------------------------------------------------------- API
PART_QTYS = (1, 10, 50, 100, 500)


def part_estimate(p, qty, vendor_id=None):
    """Cost of making `qty` pieces of one part, without the per-order extras (transport, minimum order)."""
    vendor, card = card_for(vendor_id or None)
    return estimate(p['revision_id'], {p['id']: qty}, {}, card, vendor, job_extras=False)


@router.get('/api/parts/{pid}/cost')
def part_cost(pid: str, request: Request, qty: int = 0, vendor_id: str = '', compare: bool = False):
    """Approximate cost of making one part: the per-piece split by process, setups spread over the quantity, margin
    and GST, the cost per piece at other quantities and (compare=1) at every vendor."""
    from .security import revision_access
    from .access import project_of_revision
    p = db.row('SELECT * FROM parts WHERE id=?', (pid,))
    if not p:
        raise HTTPException(404, 'Part not found')
    u = revision_access(request, p['revision_id'])
    if u.get('role') == 'vendor' or not can_price(u, project_of_revision(p['revision_id'])):
        raise HTTPException(403, 'Costs are visible to job-order planners')
    if p['category'] == 'purchased':
        return {'purchased': True}
    qty = max(1, min(100000, int(qty or p.get('quantity') or 1)))
    e = part_estimate(p, qty, vendor_id)
    if not e['parts']:
        return {'purchased': False, 'unpriced': True, 'warnings': e['warnings']}
    x = e['parts'][0]
    per_job = [l for l in x['lines'] if l['per_job']]
    setups = sum(l['amount'] for l in per_job) + sum(f['amount'] for f in e['finish_setups'])
    k = 1 + e['margin_pct'] / 100
    g = 1 + e['gst_pct'] / 100
    split = {}
    for l in x['lines']:
        if not l['per_job']:
            split[l['process']] = split.get(l['process'], 0) + l['amount']
    if setups:
        split['Setups (spread over %d)' % qty] = setups / qty
    e.update({
        'qty': qty, 'part': x,
        'unit': {'ex_gst': round(e['subtotal'] * k / qty, 2), 'with_gst': round(e['total'] / qty, 2),
                 'make': round(x['unit_cost'], 2), 'setups': round(setups / qty, 2)},
        'split': [{'process': a, 'amount': round(b, 2), 'share': round(b / max(sum(split.values()), 1e-9), 4)}
                  for a, b in sorted(split.items(), key=lambda kv: -kv[1])],
        'setups': round(setups, 2),
    })
    curve = []
    for q in sorted(set(PART_QTYS) | {qty}):
        ee = e if q == qty else part_estimate(p, q, vendor_id)
        curve.append({'qty': q, 'unit_with_gst': round(ee['total'] / q, 2)})
    e['curve'] = curve
    if compare:
        rows = []
        for vid, vname in [('', 'Base rates')] + [(v['id'], v['name']) for v in db.rows('SELECT id,name FROM vendors WHERE archived=0 ORDER BY name')]:
            ee = e if (vid or '') == (vendor_id or '') else part_estimate(p, qty, vid)
            rows.append({'vendor_id': vid, 'vendor': vname, 'unit_with_gst': round(ee['total'] / qty, 2), 'total': ee['total']})
        e['vendors'] = sorted(rows, key=lambda r: r['total'])
    return e


def _vendor_payload(v):
    v = dict(v)
    v['services'] = json.loads(v.get('services') or '[]')
    card = db.row('SELECT id,name,updated FROM rate_cards WHERE id=?', (v['rate_card_id'],)) if v.get('rate_card_id') else None
    v['rate_card'] = card
    return v


@router.get('/api/pricing')
def pricing(request: Request):
    u = user(request)
    if not (can_price(u) or can(u, 'joborder.update')):
        raise HTTPException(403, 'Pricing is visible to job-order planners')
    ensure_base()
    vendors = [_vendor_payload(v) for v in db.rows('SELECT * FROM vendors WHERE archived=0 ORDER BY name')]
    cards = db.rows('SELECT id,name,vendor_id,updated,author FROM rate_cards WHERE archived=0 AND vendor_id IS NULL ORDER BY created')
    return {'vendors': vendors, 'base_cards': cards, 'can_manage': can(u, 'pricing.manage'),
            'services': SERVICES}


SERVICES = ['Laser cutting', 'Bending', 'Rolling', 'Machining', 'Drilling & tapping', 'Hardware insertion', 'Welding', 'Powder coating', 'Painting', 'Plating', 'Anodising']


class VendorIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=120)
    services: list[str] = Field(default_factory=list, max_length=30)
    contact: str = Field(default='', max_length=120)
    phone: str = Field(default='', max_length=60)
    email: str = Field(default='', max_length=160)
    gstin: str = Field(default='', max_length=20)
    address: str = Field(default='', max_length=500)
    notes: str = Field(default='', max_length=2000)
    copy_from: str = ''   # rate card to start the vendor's own card from (default: the first base sheet)


@router.post('/api/vendors')
def create_vendor(a: VendorIn, request: Request):
    u = editor(request, 'pricing.manage')
    src = db.row('SELECT * FROM rate_cards WHERE id=? AND archived=0', (a.copy_from,)) if a.copy_from else default_card()
    if not src:
        raise HTTPException(404, 'Rate card to copy not found')
    data = src['data'] if isinstance(src['data'], dict) else json.loads(src['data'])
    vid, cid = db.uid(), db.uid()
    with db.connect() as c:
        c.execute('INSERT INTO rate_cards(id,name,vendor_id,data,created,updated,author,archived) VALUES(?,?,?,?,?,?,?,0)',
                  (cid, f'{a.name.strip()} rates', vid, json.dumps(clean_card(data)), db.now(), db.now(), u['name']))
        c.execute('INSERT INTO vendors(id,name,services,contact,phone,email,gstin,address,notes,rate_card_id,archived,created,updated,author) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?,?)',
                  (vid, a.name.strip(), json.dumps([s[:60] for s in a.services]), a.contact, a.phone, a.email, a.gstin.upper(), a.address, a.notes, cid, db.now(), db.now(), u['name']))
        db.audit(c, u['name'], 'vendor.created', {'id': vid, 'name': a.name, 'copied_from': src['id']})
    return _vendor_payload(db.row('SELECT * FROM vendors WHERE id=?', (vid,)))


@router.put('/api/vendors/{vid}')
def edit_vendor(vid: str, a: VendorIn, request: Request):
    u = editor(request, 'pricing.manage')
    if not db.row('SELECT id FROM vendors WHERE id=?', (vid,)):
        raise HTTPException(404, 'Vendor not found')
    with db.connect() as c:
        c.execute('UPDATE vendors SET name=?,services=?,contact=?,phone=?,email=?,gstin=?,address=?,notes=?,updated=? WHERE id=?',
                  (a.name.strip(), json.dumps([s[:60] for s in a.services]), a.contact, a.phone, a.email, a.gstin.upper(), a.address, a.notes, db.now(), vid))
        c.execute('UPDATE rate_cards SET name=? WHERE vendor_id=? AND id=(SELECT rate_card_id FROM vendors WHERE id=?)', (f'{a.name.strip()} rates', vid, vid))
        db.audit(c, u['name'], 'vendor.updated', {'id': vid, 'name': a.name})
    return _vendor_payload(db.row('SELECT * FROM vendors WHERE id=?', (vid,)))


@router.delete('/api/vendors/{vid}')
def archive_vendor(vid: str, request: Request):
    u = editor(request, 'pricing.manage')
    with db.connect() as c:
        c.execute('UPDATE vendors SET archived=1,updated=? WHERE id=?', (db.now(), vid))
        db.audit(c, u['name'], 'vendor.archived', {'id': vid})
    return {'ok': True}


@router.get('/api/rate-cards/{cid}')
def rate_card(cid: str, request: Request):
    u = user(request)
    if not (can_price(u) or can(u, 'joborder.update')):
        raise HTTPException(403, 'Pricing is visible to job-order planners')
    r = db.row('SELECT * FROM rate_cards WHERE id=?', (cid,))
    if not r:
        raise HTTPException(404, 'Rate card not found')
    return {**r, 'data': clean_card(json.loads(r['data']))}


class CardIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str | None = Field(default=None, max_length=120)
    data: dict


@router.put('/api/rate-cards/{cid}')
def save_rate_card(cid: str, a: CardIn, request: Request):
    u = editor(request, 'pricing.manage')
    r = db.row('SELECT * FROM rate_cards WHERE id=? AND archived=0', (cid,))
    if not r:
        raise HTTPException(404, 'Rate card not found')
    data = clean_card(a.data)
    with db.connect() as c:
        c.execute('UPDATE rate_cards SET data=?,name=?,updated=?,author=? WHERE id=?', (json.dumps(data), (a.name or r['name']).strip() or r['name'], db.now(), u['name'], cid))
        db.audit(c, u['name'], 'ratecard.updated', {'id': cid, 'name': a.name or r['name']})
    return {**db.row('SELECT * FROM rate_cards WHERE id=?', (cid,)), 'data': data}


class CopyIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(default='', max_length=120)
    vendor_id: str = ''   # copy into this vendor's card (replaces its rates); empty = a new base sheet


@router.post('/api/rate-cards/{cid}/copy')
def copy_rate_card(cid: str, a: CopyIn, request: Request):
    u = editor(request, 'pricing.manage')
    src = db.row('SELECT * FROM rate_cards WHERE id=? AND archived=0', (cid,))
    if not src:
        raise HTTPException(404, 'Rate card not found')
    data = clean_card(json.loads(src['data']))
    with db.connect() as c:
        if a.vendor_id:
            v = c.execute('SELECT * FROM vendors WHERE id=?', (a.vendor_id,)).fetchone()
            if not v:
                raise HTTPException(404, 'Vendor not found')
            if v['rate_card_id']:
                c.execute('UPDATE rate_cards SET data=?,updated=?,author=? WHERE id=?', (json.dumps(data), db.now(), u['name'], v['rate_card_id']))
                new = v['rate_card_id']
            else:
                new = db.uid()
                c.execute('INSERT INTO rate_cards(id,name,vendor_id,data,created,updated,author,archived) VALUES(?,?,?,?,?,?,?,0)', (new, f"{v['name']} rates", a.vendor_id, json.dumps(data), db.now(), db.now(), u['name']))
                c.execute('UPDATE vendors SET rate_card_id=? WHERE id=?', (new, a.vendor_id))
        else:
            new = db.uid()
            c.execute('INSERT INTO rate_cards(id,name,vendor_id,data,created,updated,author,archived) VALUES(?,?,?,?,?,?,?,0)',
                      (new, (a.name or f"{src['name']} (copy)").strip()[:120], None, json.dumps(data), db.now(), db.now(), u['name']))
        db.audit(c, u['name'], 'ratecard.copied', {'from': cid, 'to': new, 'vendor': a.vendor_id})
    r = db.row('SELECT * FROM rate_cards WHERE id=?', (new,))
    return {**r, 'data': clean_card(json.loads(r['data']))}


@router.delete('/api/rate-cards/{cid}')
def archive_rate_card(cid: str, request: Request):
    u = editor(request, 'pricing.manage')
    r = db.row('SELECT * FROM rate_cards WHERE id=?', (cid,))
    if not r:
        raise HTTPException(404, 'Rate card not found')
    if r['vendor_id']:
        raise HTTPException(409, "A vendor's rate card is removed with the vendor")
    if len(db.rows('SELECT id FROM rate_cards WHERE vendor_id IS NULL AND archived=0')) <= 1:
        raise HTTPException(409, 'Keep at least one base sheet')
    with db.connect() as c:
        c.execute('UPDATE rate_cards SET archived=1,updated=? WHERE id=?', (db.now(), cid))
        db.audit(c, u['name'], 'ratecard.archived', {'id': cid})
    return {'ok': True}


@router.get('/api/rate-cards/{cid}/export.csv')
def export_card(cid: str, request: Request):
    """The rate card as one flat CSV (section, item, column, value) for a spreadsheet or a vendor to fill in."""
    import csv
    import io
    from fastapi.responses import Response
    r = rate_card(cid, request)
    d = r['data']
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(['section', 'item', 'field', 'value'])
    for sec in SECTIONS:
        for row in d[sec]:
            label = row.get('name') or row.get('key') or row.get('code') or ' '.join(f'{k}={row[k]}' for k in ('type', 'thread', 'process', 'group', 'thickness', 'diameter') if k in row)
            for k, v in row.items():
                w.writerow([sec, label, k, v])
    for k in SCALARS:
        w.writerow(['general', '', k, d[k]])
    for sec in ('rolling', 'machining', 'insertion', 'overheads', 'laser_group'):
        for k, v in d[sec].items():
            w.writerow([sec, '', k, json.dumps(v) if isinstance(v, dict) else v])
    name = re.sub(r'[^A-Za-z0-9_-]+', '-', r['name']).strip('-') or 'rate-card'
    return Response(buf.getvalue(), media_type='text/csv', headers={'Content-Disposition': f'attachment; filename="{name}.csv"', 'Cache-Control': 'no-store'})
