"""Remove authoring-system traces and identifying markers from uploaded CAD before anything else reads it.

STEP (ISO 10303-21):
  * HEADER: FILE_NAME / FILE_DESCRIPTION replaced (no file name, author, organisation, preprocessor,
    originating system or authorisation); FILE_SCHEMA kept.
  * Body / shell labels (SolidWorks feature names such as 'Boss-Extrude2', 'Imported18') -> 'NONE'.
  * PERSON / ORGANIZATION records blanked; identifying user-defined properties (author, saved by, file
    name, folder, licence, GUID ...) emptied; 'SW-' property prefixes dropped.
  * Any string: GUIDs removed, file-system paths reduced to the file name, e-mail addresses removed.
  * SolidWorks files only: exporter noise in component names ('_ISO11', 'Mirror', 'T2CC', 't1',
    'name^parent-assembly') removed; a mirrored component keeps ' (MIRROR)' so opposite hands stay apart.
IGES: start section cleared; global section file name, native system, preprocessor, author, organisation
and dates neutralised.

Geometry, placements, colours, materials and part numbers are untouched. The file is streamed (multi-GB safe).
"""
import re
import datetime as _dt
from pathlib import Path

SYSTEM = 'Forge'
_STR = re.compile(r"'((?:[^']|'')*)'")
_HEAD = re.compile(r"\s*#(\d+)\s*=\s*([A-Z_0-9]+)\s*\(")
_GUID = re.compile(r'\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?')
_PATH = re.compile(r'(?:[A-Za-z]:\\\\|\\\\\\\\[^\\\s]+|/(?:Users|home|mnt|Volumes|private|var)/)')
_EMAIL = re.compile(r'[\w.+-]+@[\w-]+(?:\.[\w-]+)+')
_MARK = re.compile(_GUID.pattern + '|' + _PATH.pattern + '|' + _EMAIL.pattern)
BODY_TYPES = {'MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'FACETED_BREP', 'SHELL_BASED_SURFACE_MODEL', 'CLOSED_SHELL',
              'OPEN_SHELL', 'ORIENTED_CLOSED_SHELL', 'ORIENTED_OPEN_SHELL'}
NAME_TYPES = {'PRODUCT', 'SHAPE_REPRESENTATION', 'ADVANCED_BREP_SHAPE_REPRESENTATION', 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION',
              'FACETED_BREP_SHAPE_REPRESENTATION', 'GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION',
              'GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION', 'EDGE_BASED_WIREFRAME_SHAPE_REPRESENTATION'}
BLANK_TYPES = {'PERSON', 'ORGANIZATION', 'PERSONAL_ADDRESS', 'ORGANIZATIONAL_ADDRESS'}
PROP_TYPES = {'PROPERTY_DEFINITION', 'DESCRIPTIVE_REPRESENTATION_ITEM', 'REPRESENTATION', 'MEASURE_REPRESENTATION_ITEM',
              'VALUE_REPRESENTATION_ITEM', 'GENERAL_PROPERTY'}
IDENT_KEYS = re.compile(r'author|created\s*by|saved\s*by|last\s*saved|modified\s*by|drawn\s*by|checked\s*by|approved\s*by|engineer|designer|'
                        r'owner|user|login|computer|machine|host|file\s*name|filename|folder|path|directory|licen[cs]e|serial|guid|uuid|'
                        r'document\s*id|vault|pdm|company|organi[sz]ation|e-?mail', re.I)
TARGETS = BODY_TYPES | NAME_TYPES | BLANK_TYPES | PROP_TYPES


def is_solidworks(header):
    return bool(re.search(r'solid\s*works|swstep', header or '', re.I))


# ------------------------------------------------------------------------------------------------ names
_PRE = re.compile(r'^(?:Mirror|_ISO|1+(?=[A-Za-z_]))+')
_SUF = re.compile(r'(?:t1)*(?:T2(?:CC|11)?|CC|11)\d?(?=$|_SETTING \d+$)')


def clean_name(name):
    """'_ISO11GT-SM-046-SMPS PLATET2CC' -> 'GT-SM-046-SMPS PLATE'; 'Mirror1111GT-MC-013-…T2CC' -> '… (MIRROR)';
    'DRIVE WHEEL ASM^GT_SWING_SETUP_LEFT' -> 'DRIVE WHEEL ASM'. Uncertain names are returned unchanged."""
    raw = name or ''
    if raw in ('', 'NONE', 'UNKNOWN') or '\\X' in raw:
        return raw
    s = raw.split('^')[0].strip() or raw  # SolidWorks virtual component: "<component>^<parent assembly>"
    m = _PRE.match(s)
    prefix = m.group(0) if m else ''
    if prefix and re.match(r'(?i)(st|nd|rd|th)\b', s[len(prefix):]):
        prefix = re.sub(r'1+$', '', prefix)  # "1ST STAGE" is an ordinal, not exporter noise
    marked = bool(_SUF.search(s)) and ('T2' in s or s.endswith('CC') or bool(prefix))
    # "_ISO1148V 30Ah", "113100T13 … EyeboltCC": the "11" also precedes names that start with a digit
    if ('Mirror' in prefix or '_ISO' in prefix or marked) and re.match(r'11+\d', s[len(prefix):]):
        prefix += '11'
    body = s[len(prefix):]
    if prefix or 'T2' in body or '^' in raw:
        body = _SUF.sub('', body)
        if re.match(r'c[A-Z]', body) and re.search(r'1$|\^', prefix + ('^' if '^' in raw else '')):
            body = body[1:]  # "11cTERMINAL_BLOCK" / "^cTERMINAL_BLOCK": SolidWorks copy marker
    body = body.strip(' _') or s
    if 'Mirror' in prefix:
        body += ' (MIRROR)'
    return body


# ------------------------------------------------------------------------------------------------ STEP
def _step_str(v):
    return "'" + v.replace("'", "''") + "'"


def _scrub_value(v, report):
    if not _MARK.search(v):
        return v
    out = _GUID.sub('', v)
    if _PATH.search(out):
        out = re.split(r'\\\\|/', out)[-1]
    out = _EMAIL.sub('', out)
    if out != v:
        report['markers'] += 1
    return out


def _map_strings(rec, fn):
    i = [-1]

    def sub(m):
        i[0] += 1
        v = m.group(1).replace("''", "'")
        n = fn(i[0], v)
        return m.group(0) if n is None or n == v else _step_str(n)
    return _STR.sub(sub, rec)


def _record(rec, etype, sw, report):
    if etype in BODY_TYPES:
        def f(i, v):
            if i == 0 and v not in ('', 'NONE'):
                report['bodies'] += 1
                return 'NONE'
            return _scrub_value(v, report)
        return _map_strings(rec, f)
    if etype in NAME_TYPES:
        def f(i, v):
            v2 = _scrub_value(v, report)
            limit = 2 if etype == 'PRODUCT' else 1
            if sw and i < limit:
                c = clean_name(v2)
                if c != v2:
                    report['names'] += 1
                return c
            return v2
        return _map_strings(rec, f)
    if etype in BLANK_TYPES:
        def f(i, v):
            if v:
                report['people'] += 1
            return ''
        return _map_strings(rec, f)
    if etype in PROP_TYPES:
        state = {'ident': False}

        def f(i, v):
            v = _scrub_value(v, report)
            if i == 0:
                key = re.sub(r'^SW-', '', v)
                state['ident'] = bool(IDENT_KEYS.search(key))
                return key
            if state['ident'] and v:
                report['properties'] += 1
                return ''
            return v
        return _map_strings(rec, f)
    return _map_strings(rec, lambda i, v: _scrub_value(v, report)) if _MARK.search(rec) else rec


def _neutral_header(schema, file_name, now):
    return ('HEADER;\n'
            "FILE_DESCRIPTION(('Forge sanitized model'),'2;1');\n"
            f"FILE_NAME({_step_str(file_name)},'{now}',(''),(''),'{SYSTEM}','{SYSTEM}','');\n"
            f'{schema}\n'
            'ENDSEC;\n')


def _quotes_open(text):
    return text.count("'") % 2 == 1


def scrub_step(src, dst, file_name='source.step', clean_names=None):
    """Write a sanitized copy of STEP file src to dst. clean_names: None = only for SolidWorks exports."""
    report = {'format': 'step', 'header': False, 'names': 0, 'bodies': 0, 'people': 0, 'properties': 0, 'markers': 0, 'comments': 0}
    now = _dt.datetime.now(_dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')
    with open(src, 'r', encoding='latin-1', newline='') as f, open(dst, 'w', encoding='latin-1', newline='') as out:
        # ---- header (everything up to the first ENDSEC)
        head = ''
        for line in f:
            head += line
            if re.search(r'^\s*ENDSEC\s*;', line, re.M) and 'HEADER' in head:
                break
            if len(head) > 2_000_000:
                raise ValueError('STEP header too large')
        pre, _, rest = head.partition('HEADER;')
        if not rest:
            raise ValueError('Not a STEP file (no HEADER section)')
        sw = is_solidworks(rest) if clean_names is None else bool(clean_names)
        report['solidworks'] = sw
        sm = re.search(r'FILE_SCHEMA\s*\(.*?\)\s*;', rest, re.S)
        schema = re.sub(r'\s+', ' ', sm.group(0)) if sm else "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));"
        out.write((pre.strip() or 'ISO-10303-21;') + '\n' + _neutral_header(schema, file_name, now))
        report['header'] = True
        # ---- data: whole records only where they need rewriting; everything else streams through
        buf = ''
        etype = None
        for line in f:
            if buf:
                buf += line
                if _quotes_open(buf) or not buf.rstrip().endswith(';'):
                    continue
                out.write(_record(buf, etype, sw, report))
                buf = ''
                continue
            if "'" not in line:
                if '/*' in line:
                    line = re.sub(r'/\*.*?\*/', '', line)
                    report['comments'] += 1
                out.write(line)
                continue
            m = _HEAD.match(line)
            etype = m.group(2) if m else None
            if _quotes_open(line) or (etype in TARGETS and not line.rstrip().endswith(';')):
                buf = line
                continue
            if etype in TARGETS:
                out.write(_record(line, etype, sw, report))
            elif _MARK.search(line):
                out.write(_record(line, etype, sw, report))
            else:
                out.write(line)
        if buf:
            out.write(buf)
    return report


# ------------------------------------------------------------------------------------------------ IGES
def _iges_params(text, pd, rd):
    """Split an IGES global section (Hollerith strings nH...) into raw parameter strings."""
    out = []
    i = 0
    cur = ''
    while i < len(text):
        m = re.match(r'\s*(\d+)H', text[i:])
        if m and not cur.strip():
            n = int(m.group(1))
            start = i + m.end()
            cur = text[i:start + n]
            i = start + n
            continue
        ch = text[i]
        if ch in (pd, rd):
            out.append(cur)
            cur = ''
            if ch == rd:
                return out
        else:
            cur += ch
        i += 1
    if cur:
        out.append(cur)
    return out


def _holl(s):
    return f'{len(s)}H{s}' if s else ''


def scrub_iges(src, dst, file_name='source.igs'):
    report = {'format': 'iges', 'header': False, 'names': 0, 'bodies': 0, 'people': 0, 'properties': 0, 'markers': 0, 'comments': 0, 'solidworks': False}
    lines = Path(src).read_text(encoding='latin-1').splitlines()
    sec = lambda c: [l for l in lines if len(l) >= 73 and l[72] == c]
    s_lines, g_lines = sec('S'), sec('G')
    if not g_lines:
        raise ValueError('Not an IGES file (no global section)')
    g = ''.join(l[:72] for l in g_lines)
    report['solidworks'] = is_solidworks(g + ''.join(l[:72] for l in s_lines))
    pd = g[2] if g[:2] == '1H' else ','
    rd = g[6] if g[:2] == '1H' and g[4:6] == '1H' else ';'
    p = _iges_params(g, pd, rd)
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime('%Y%m%d.%H%M%S')

    def setp(k, v):  # 1-based IGES global parameter index
        while len(p) < k:
            p.append('')
        p[k - 1] = v
    setp(3, _holl(Path(file_name).stem))
    setp(4, _holl(file_name))
    setp(5, _holl(SYSTEM))
    setp(6, _holl(SYSTEM))
    setp(18, _holl(stamp))
    setp(21, '')
    setp(22, '')
    if len(p) >= 25:
        setp(25, _holl(stamp))
    report['header'] = True
    gtext = pd.join(p) + rd
    new_g = [gtext[i:i + 72] for i in range(0, len(gtext), 72)]
    new_s = ['']
    other = [l for l in lines if not (len(l) >= 73 and l[72] in 'SGT')]
    with open(dst, 'w', encoding='latin-1', newline='\n') as out:
        for i, l in enumerate(new_s):
            out.write(f'{l:<72}S{i + 1:07d}\n')
        for i, l in enumerate(new_g):
            out.write(f'{l:<72}G{i + 1:07d}\n')
        nd = np_ = 0
        for l in other:
            out.write(l + '\n')
            if len(l) >= 73:
                nd += l[72] == 'D'
                np_ += l[72] == 'P'
        out.write(f'S{len(new_s):07d}G{len(new_g):07d}D{nd:07d}P{np_:07d}'.ljust(72) + 'T0000001\n')
    return report


def scrub(path, file_name=None):
    """Sanitize an uploaded CAD file in place. Returns the report, or None for formats without metadata."""
    path = Path(path)
    ext = path.suffix.lower()
    if ext in ('.step', '.stp'):
        fn = scrub_step
        name = file_name or 'source.step'
    elif ext in ('.igs', '.iges'):
        fn = scrub_iges
        name = file_name or 'source.igs'
    else:
        return None
    tmp = path.with_name(path.name + '.clean')
    try:
        report = fn(path, tmp, name)
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)
    return report
