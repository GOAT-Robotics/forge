"""Hole hardware catalogue: self-clinching nuts, flush nuts, studs, standoffs, rivet nuts, tapped holes and
countersinks. A hole's hardware is manufacturing intent chosen by the engineer (never inferred); the catalogue
gives the mounting / pilot hole the hardware needs so the drawing can call out the hole to cut.

Mounting holes: PEM self-clinching bulletins (S nuts, FH studs, SO/BSO standoffs), ISO 2306 tap drills (6H),
ISO 15065 countersinks (90°, ISO 7046 heads), ASME B18.6.3 82° countersinks, common steel rivet-nut holes.
Values marked None must be taken from the supplier datasheet — Forge does not guess them.
"""
from __future__ import annotations

IN = 25.4
TYPES = {'nut': 'Nut', 'flush_nut': 'Flush nut', 'stud': 'Stud', 'standoff': 'Standoff', 'rivnut': 'Rivnut',
         'weld_nut': 'Weld nut', 'tap': 'Tap', 'countersink': 'Countersink'}
HARDWARE_TYPES = ('nut', 'flush_nut', 'stud', 'standoff', 'rivnut', 'weld_nut')


def _r(x):
    return None if x is None else round(float(x), 3)


def _items():
    out = []

    def add(**k):
        k.setdefault('pn', '')
        k.setdefault('min_sheet', None)
        k.setdefault('length', None)
        k['hole'] = _r(k.get('hole'))
        out.append(k)

    # self-clinching nuts (PEM S, code -1 = thinnest standard sheet)
    for th, hole, sheet in (('M2', 4.22, 1.0), ('M2.5', 4.22, 1.0), ('M3', 4.22, 1.0), ('M4', 5.41, 1.0), ('M5', 6.35, 1.0),
                            ('M6', 8.75, None), ('M8', 10.5, None)):
        add(id=f'nut-{th}', type='nut', units='metric', thread=th, name=f'{th} Nut', pn=f'S-{th}-1', hole=hole, min_sheet=sheet)
    for th, code, hole_in in (('#4-40', '440', .166), ('#6-32', '632', .1875), ('#8-32', '832', .213), ('#10-32', '032', .250), ('1/4-20', '0420', .344)):
        add(id=f'nut-{code}', type='nut', units='imperial', thread=th, name=f'{th} Nut', pn=f'S-{code}-1', hole=hole_in * IN, min_sheet=1.0 if code != '0420' else None)
    # flush nuts (PEM F): hole per datasheet
    for th in ('M3', 'M4', 'M5', 'M6'):
        add(id=f'flush-{th}', type='flush_nut', units='metric', thread=th, name=f'{th} Flush Nut', pn=f'F-{th}-1', hole=None)
    for th, code in (('#4-40', '440'), ('#6-32', '632'), ('#8-32', '832'), ('#10-32', '032')):
        add(id=f'flush-{code}', type='flush_nut', units='imperial', thread=th, name=f'{th} Flush Nut', pn=f'F-{code}-1', hole=None)
    # flush-head studs (PEM FH): hole = nominal thread diameter
    studs = {'M3': (3.0, (6, 8, 10, 12, 15, 20)), 'M4': (4.0, (8, 10, 12, 15, 20, 25)), 'M5': (5.0, (10, 12, 15, 20, 25)),
             'M6': (6.0, (12, 15, 20, 25, 30)), 'M8': (8.0, (15, 20, 25, 30, 35))}
    for th, (hole, lengths) in studs.items():
        for L in lengths:
            add(id=f'stud-{th}-{L}', type='stud', units='metric', thread=th, name=f'{th}×{L} Stud', pn=f'FH-{th}-{L}', hole=hole, length=L)
    for th, code, hole_in, lengths in (('#4-40', '440', .112, (.375, .5, .625)), ('#6-32', '632', .138, (.375, .5, .75)),
                                       ('#8-32', '832', .164, (.5, .75, 1.0)), ('#10-32', '032', .190, (.5, .75, 1.0)), ('1/4-20', '0420', .250, (.75, 1.0))):
        for L in lengths:
            add(id=f'stud-{code}-{L}', type='stud', units='imperial', thread=th, name=f'{th}×{L:.3f}" Stud', pn=f'FH-{code}-{int(round(L * 16))}',
                hole=hole_in * IN, length=round(L * IN, 2))
    # standoffs (PEM SO thru-threaded, BSO blind)
    for th, hole in (('M3', 4.22), ('M4', None), ('M5', None)):
        for L in (6, 8, 10, 12, 15, 20):
            add(id=f'so-{th}-{L}', type='standoff', units='metric', thread=th, name=f'{th}×{L} Standoff', pn=f'SO-{th}-{L}', hole=hole, length=L)
            add(id=f'bso-{th}-{L}', type='standoff', units='metric', thread=th, name=f'{th}×{L} Blind Standoff', pn=f'BSO-{th}-{L}', hole=hole, length=L)
    # hexagon weld nuts (DIN 929, projection welded): pilot hole per the nut / coater's datasheet
    for th in ('M4', 'M5', 'M6', 'M8', 'M10', 'M12'):
        add(id=f'weldnut-{th}', type='weld_nut', units='metric', thread=th, name=f'{th} Hex Weld Nut', pn=f'DIN 929 {th}', hole=None)
    # rivet nuts (steel, flat head)
    for th, hole in (('M3', 5.0), ('M4', 6.0), ('M5', 7.0), ('M6', 9.0), ('M8', 11.0), ('M10', 13.0)):
        add(id=f'rivnut-{th}', type='rivnut', units='metric', thread=th, name=f'{th} Rivnut', pn='', hole=hole)
    # tapped holes: ISO 2306 tap drill, 6H
    for th, pitch, drill in (('M2', .4, 1.6), ('M2.5', .45, 2.05), ('M3', .5, 2.5), ('M4', .7, 3.3), ('M5', .8, 4.2), ('M6', 1.0, 5.0),
                             ('M8', 1.25, 6.8), ('M8', 1.0, 7.0), ('M10', 1.5, 8.5), ('M10', 1.25, 8.8), ('M12', 1.75, 10.2), ('M12', 1.5, 10.5)):
        add(id=f'tap-{th}x{pitch:g}', type='tap', units='metric', thread=f'{th}×{pitch:g}', name=f'{th}×{pitch:g} Tap', hole=drill)
    for th, drill_in in (('#4-40', .089), ('#6-32', .1065), ('#8-32', .136), ('#10-24', .1495), ('#10-32', .159), ('1/4-20', .201)):
        add(id=f'tap-{th}', type='tap', units='imperial', thread=th, name=f'{th} Tap', hole=drill_in * IN)
    # countersinks: ISO 15065 (90°), ASME 82°; hole = clearance, csk = countersink diameter
    for th, clear, csk in (('M2', 2.4, 4.4), ('M2.5', 2.9, 5.5), ('M3', 3.4, 6.3), ('M4', 4.5, 9.4), ('M5', 5.5, 10.4),
                           ('M6', 6.6, 12.6), ('M8', 9.0, 17.3), ('M10', 11.0, 20.0)):
        add(id=f'csk-{th}', type='countersink', units='metric', thread=th, name=f'{th}×90° CS', hole=clear, csk=csk, angle=90)
    for th, clear_in, csk_in in (('#4', .120, .225), ('#6', .144, .279), ('#8', .170, .332), ('#10', .196, .385), ('1/4', .257, .507)):
        add(id=f'csk-{th}', type='countersink', units='imperial', thread=th, name=f'{th}×82° CS', hole=clear_in * IN, csk=round(csk_in * IN, 2), angle=82)
    return out


CATALOG = _items()
BY_ID = {i['id']: i for i in CATALOG}


def designation(item):
    """Callout line for the drawing (the side — near / far — is added per view by the drawing)."""
    t = item['type']
    if t == 'tap':
        thread = item['thread'].replace('×', ' X ')
        if item.get('units') == 'metric':
            return f'{thread} - 6H'
        return f"{thread} {'UNF' if item['thread'] == '#10-32' else 'UNC'}-2B"
    if t == 'countersink':
        return f"CSK Ø {item['csk']:.2f} X {item.get('angle', 90)}°" if item.get('csk') else f"CSK X {item.get('angle', 90)}°"
    label = {'nut': 'SELF-CLINCHING NUT', 'flush_nut': 'FLUSH NUT', 'stud': 'STUD', 'standoff': 'STANDOFF', 'rivnut': 'RIVET NUT', 'weld_nut': 'WELD NUT'}.get(t, 'HARDWARE')
    if item.get('custom'):
        ref = ' '.join(x for x in (item.get('name'), item.get('pn')) if x)
        return f"INSERT {ref}".upper() if label.split()[-1].lower() in ref.lower() else f"INSERT {ref} {label}".upper()
    ref = item.get('pn') or item.get('thread') or item.get('name')
    return f"INSERT {ref} {label}".strip()


def clean_custom(c: dict):
    """A hardware item the engineer enters (supplier part, own standard)."""
    t = c.get('type')
    if t not in TYPES:
        raise ValueError('Choose the hardware type')
    name = str(c.get('name', '')).strip()[:80]
    if not name:
        raise ValueError('Name the hardware')
    try:
        hole = float(c['hole']) if c.get('hole') not in (None, '') else None
    except (TypeError, ValueError):
        raise ValueError('Mounting hole must be a number in mm')
    if hole is not None and not (0.3 <= hole <= 60):
        raise ValueError('Mounting hole must be 0.3–60 mm')
    item = {'id': 'custom', 'type': t, 'units': 'custom', 'thread': str(c.get('thread', '')).strip()[:30], 'name': name,
            'pn': str(c.get('pn', '')).strip()[:60], 'hole': _r(hole), 'custom': True}
    if t == 'countersink':
        try:
            item['csk'] = _r(float(c.get('csk'))) if c.get('csk') not in (None, '') else None
            item['angle'] = int(c.get('angle') or 90)
        except (TypeError, ValueError):
            raise ValueError('Countersink diameter and angle must be numbers')
    return item
