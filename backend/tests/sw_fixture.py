"""A synthetic SolidWorks part for the reader's tests: an 80 x 50 x 10 mm plate with one through hole, written the
way SolidWorks writes it — marker-framed raw-DEFLATE blocks holding KeyWords / property XML and a zlib-compressed
Parasolid partition (base schema 13006 with the BODY / ATTRIB_DEF edits SolidWorks makes). No proprietary file is
needed: the Parasolid nodes are encoded here from the reader's own schema table."""
import struct
import zlib

from app.swread import xt

MM = 1e-3


class XTWriter:
    """Encodes nodes as Parasolid neutral binary. Fields are given by name; missing pointers are null (1)."""

    EDITS = {12: 'C' * 13 + 'D' + 'C' * 9 + 'Z',   # BODY: SolidWorks drops one base field
             80: 'C' * 5 + 'D' + 'C' + 'Z'}         # ATTRIB_DEF: likewise

    def __init__(self, title=': TRANSMIT FILE (partition) created by modeller version 3701229'):
        self.out = bytearray(b'PS\x00\x00')
        self.out += struct.pack('>H', len(title)) + title.encode()
        key = b'SCH_3701229_37102_13006'
        self.out += struct.pack('>i', len(key)) + key + struct.pack('>Hi', 0xef, 0)
        self.seen = set()
        self.next = 2

    def index(self):
        i = self.next
        self.next += 1
        return i

    def node(self, t, idx, **vals):
        name, variable, base = xt.BASE[t]
        fields = [f for f in base if not (t in self.EDITS and f[1] == '?')]
        self.out += struct.pack('>H', t)
        if t not in self.seen:
            self.seen.add(t)
            if t in self.EDITS:
                self.out += bytes([len(fields)]) + self.EDITS[t].encode()
            else:
                self.out += b'\xff'
        last = vals.get(fields[-1][0]) if variable else None
        if variable:
            self.out += struct.pack('>i', len(last))
        self.out += struct.pack('>H', idx)
        for k, (fname, code, cnt) in enumerate(fields):
            v = vals.get(fname)
            many = cnt != 1 or (variable and k == len(fields) - 1)
            seq = (v if isinstance(v, (list, tuple, bytes)) and many else [v]) if v is not None else [None] * (cnt if not variable or k < len(fields) - 1 else 0)
            for x in seq:
                self.out += self.enc(code, x)

    @staticmethod
    def enc(code, x):
        if code == 'p':
            return struct.pack('>H', x if x is not None else 1)
        if code == 'd':
            return struct.pack('>i', x or 0)
        if code in ('c', 'l', 'u'):
            return bytes([x if isinstance(x, int) else ord(x or '\x00')])
        if code == 'n':
            return struct.pack('>H', x or 0)
        if code == 'f':
            return struct.pack('>d', xt.NULL_DOUBLE if x is None else x)
        if code == 'v':
            return struct.pack('>3d', *x)
        raise ValueError(code)

    def bytes(self):
        return bytes(self.out) + struct.pack('>HH', 1, 1)


def plate_partition(hole_feature_id=117):
    """Parasolid partition of the plate; the hole's face carries FACE_ID_2001 naming feature `hole_feature_id`."""
    w = XTWriter()
    I = w.index
    body, shell, solid, void = I(), I(), I(), I()
    V = [(0, 0, 0), (80, 0, 0), (80, 50, 0), (0, 50, 0), (0, 0, 10), (80, 0, 10), (80, 50, 10), (0, 50, 10)]
    V = [tuple(c * MM for c in p) for p in V]
    vtx = [I() for _ in V]
    pts = [I() for _ in V]
    edges, edge_list = {}, []

    def edge(a, b):
        key = frozenset((a, b))
        if key not in edges:
            edges[key] = {'id': I(), 'curve': I(), 'a': a, 'b': b, 'fins': []}
            edge_list.append(edges[key])
        e = edges[key]
        return e, e['a'] == a

    faces = []

    def face(surface_t, surf_vals, sense, loops):
        f = {'id': I(), 'surf': I(), 't': surface_t, 'vals': surf_vals, 'sense': sense, 'loops': []}
        for lp in loops:
            f['loops'].append({'id': I(), 'fins': lp})
        faces.append(f)
        return f

    def poly(*vs):
        out = []
        for a, b in zip(vs, vs[1:] + vs[:1]):
            e, fwd = edge(a, b)
            out.append((e, fwd))
        return out
    c = (15 * MM, 15 * MM)
    r = 2.1 * MM
    ring_top = {'id': I(), 'curve': I(), 'a': None, 'b': None, 'fins': [], 'circle': (c[0], c[1], 10 * MM)}
    ring_bot = {'id': I(), 'curve': I(), 'a': None, 'b': None, 'fins': [], 'circle': (c[0], c[1], 0.0)}
    edge_list += [ring_top, ring_bot]
    z, x, y = (0, 0, 1), (1, 0, 0), (0, 1, 0)
    neg = lambda v: tuple(-a for a in v)
    face(50, {'pvec': V[0], 'normal': neg(z), 'x_axis': x}, '+', [poly(0, 3, 2, 1), [(ring_bot, True)]])
    face(50, {'pvec': V[4], 'normal': z, 'x_axis': x}, '+', [poly(4, 5, 6, 7), [(ring_top, False)]])
    face(50, {'pvec': V[0], 'normal': neg(y), 'x_axis': x}, '+', [poly(0, 1, 5, 4)])
    face(50, {'pvec': V[1], 'normal': x, 'x_axis': y}, '+', [poly(1, 2, 6, 5)])
    face(50, {'pvec': V[2], 'normal': y, 'x_axis': x}, '+', [poly(2, 3, 7, 6)])
    face(50, {'pvec': V[3], 'normal': neg(x), 'x_axis': y}, '+', [poly(3, 0, 4, 7)])
    hole = face(51, {'pvec': (c[0], c[1], 0.0), 'axis': z, 'radius': r, 'x_axis': x}, '-', [[(ring_top, True)], [(ring_bot, False)]])
    # fins
    for f in faces:
        for lp in f['loops']:
            lp['fin_ids'] = []
            for e, fwd in lp['fins']:
                fid = I()
                e['fins'].append((fid, fwd, f, lp))
                lp['fin_ids'].append((fid, e, fwd))
    attr_def, ident, a_int, attr = I(), I(), I(), I()
    # nodes
    w.node(12, body, highest_node_id=100, body_size=1000.0, resolution=1e-8, body_type=1, nom_geom_state=1, shell=shell)
    w.node(19, solid, node_id=2, body=body, shell=shell, type='S')
    w.node(19, void, node_id=3, body=body, type='V')
    w.node(13, shell, node_id=4, body=body, face=faces[0]['id'], region=solid)
    for k, f in enumerate(faces):
        nxt = faces[k + 1]['id'] if k + 1 < len(faces) else None
        w.node(14, f['id'], node_id=10 + k, attributes_groups=attr if f is hole else None, next=nxt, loop=f['loops'][0]['id'], shell=shell, surface=f['surf'], sense=f['sense'])
        w.node(f['t'], f['surf'], node_id=40 + k, owner=f['id'], sense='+', **f['vals'])
        for j, lp in enumerate(f['loops']):
            nl = f['loops'][j + 1]['id'] if j + 1 < len(f['loops']) else None
            fins = lp['fin_ids']
            w.node(15, lp['id'], node_id=0, fin=fins[0][0], face=f['id'], next=nl)
            for m, (fid, e, fwd) in enumerate(fins):
                other = next(o for o in e['fins'] if o[0] != fid)[0]
                end = (e['b'] if fwd else e['a']) if e['a'] is not None else None
                w.node(17, fid, loop=lp['id'], forward=fins[(m + 1) % len(fins)][0], backward=fins[m - 1][0], vertex=vtx[end] if end is not None else None,
                       other=other, edge=e['id'], sense='+' if fwd else '-')
    for k, e in enumerate(edge_list):
        plus = next(f for f in e['fins'] if f[1])[0]
        w.node(16, e['id'], node_id=60 + k, fin=plus, curve=e['curve'], owner=body)
        if e['a'] is not None:
            pa, pb = V[e['a']], V[e['b']]
            d = [b - a for a, b in zip(pa, pb)]
            n = sum(t * t for t in d) ** .5
            w.node(30, e['curve'], node_id=80 + k, owner=e['id'], sense='+', pvec=pa, direction=tuple(t / n for t in d))
        else:
            w.node(31, e['curve'], node_id=80 + k, owner=e['id'], sense='+', centre=e['circle'], normal=z, x_axis=x, radius=r)
    for k, (v, p) in enumerate(zip(vtx, pts)):
        w.node(18, v, node_id=100 + k, point=p, owner=body)
        w.node(29, p, node_id=120 + k, owner=v, pvec=V[k])
    w.node(80, attr_def, identifier=ident, type_id=9000, actions=b'\x00' * 8, class0=0, fields=b'\x03')
    w.node(79, ident, values=b'FACE_ID_2001')
    w.node(81, attr, node_id=200, definition=attr_def, owner=hole['id'], fields=[a_int])
    w.node(82, a_int, values=[49, hole_feature_id, 0, 0, 8, -1, 0])
    return w.bytes()


def block(name, payload):
    raw = zlib.compressobj(9, zlib.DEFLATED, -15)
    comp = raw.compress(payload) + raw.flush()
    nm = bytes(((b << 4) | (b >> 4)) & 0xff for b in name.encode())
    return (b'\x14\x00\x06\x00\x08\x00' + struct.pack('<5I', 0x7ff0ffdf, zlib.crc32(payload), len(comp), len(payload), len(nm)) + nm + comp)


KEYWORDS = ('<?xml version="1.0" encoding="UTF-8"?><Keywords id="1" Name="TAP PLATE">'
            '<Configuration id="0" Name="Default" Type="ConfigurationManager" Material="AISI 304"/>'
            '<Extrusion id="36" Name="Boss-Extrude1" Type="Boss-Extrude"><Dimension Name="D1">10</Dimension></Extrusion>'
            '<HoleWizard id="117" Name="M5 Tapped Hole1" Type="M5 Tapped Hole"/>'
            '<Feature id="140" Name="Cosmetic Thread1" Type="Cosmetic Thread"><Dimension Name="D2">&lt;MOD-DIAM&gt;8</Dimension></Feature></Keywords>')
CUSTOM = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" '
          'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><propertySection name="UserDefinedProperties">'
          '<property name="Part Number" pid="3"><vt:lpstr>FX-002</vt:lpstr><FPVals><vt:lpstr>FX-002</vt:lpstr></FPVals></property>'
          '<property name="Description" pid="4"><vt:lpstr>Native fixture</vt:lpstr></property>'
          '<property name="Finish" pid="5"><vt:lpstr>Anodised</vt:lpstr></property></propertySection></Properties>')
FEATURES = ('<?xml version="1.0" encoding="UTF-8"?><swSolidWorks swVersion="19000"><swModelList><swModel id="2" swName="TAP PLATE" '
            'swConfigurationName="Default" swConfigurationId="0"/></swModelList></swSolidWorks>')


def sldprt(hole_feature_id=117):
    """Bytes of the synthetic .sldprt."""
    part = plate_partition(hole_feature_id)
    wrapped = struct.pack('<I', 0x10d) + b'\x00' * 16 + zlib.compress(part)
    out = b'\x00\x00\x00\x00\x00\x00\x00\x04'
    out += block('Contents/Config-0-Partition', wrapped)
    out += block('swXmlContents/KeyWords', KEYWORDS.encode())
    out += block('swXmlContents/Features', FEATURES.encode())
    out += block('docProps/custom.xml', CUSTOM.encode())
    return out


def instance_tree(asm='FRAME', plates=((0, 0, 0), (0, 0, 100)), virtual='Bracket'):
    """A COMPINSTANCETREE: `asm` holding the plate at each offset (mm) and one virtual component."""
    def tr(o):
        m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, o[0] / 1000, o[1] / 1000, o[2] / 1000, 1]
        return ' '.join(str(x) for x in m)
    refs = ''.join(f'<swReference swModelRef="2" swName="TAP PLATE" swReferenceNumber="{k + 1}" swTransform="{tr(o)}" swSuppressed="NO"/>' for k, o in enumerate(plates))
    refs += f'<swReference swModelRef="3" swName="{virtual}^{asm}" swReferenceNumber="1" swTransform="{tr((200, 0, 0))}" swIsVirtualComponent="YES"/>'
    return ('<?xml version="1.0" encoding="UTF-8"?><swSolidWorks><swFileList>'
            f'<swFile id="f1" swPath="C:\\\\work\\\\{asm}.SLDASM" swDocType="ASSEMBLY"/>'
            '<swFile id="f2" swPath="C:\\\\work\\\\TAP PLATE.SLDPRT" swDocType="PART"/>'
            f'<swFile id="f3" swPath="C:\\\\work\\\\{virtual}^{asm}.SLDPRT" swDocType="PART"/></swFileList><swModelList>'
            f'<swModel id="1" swName="{asm}" swFileRef="f1" swConfigurationName="Default">{refs}</swModel>'
            '<swModel id="2" swName="TAP PLATE" swFileRef="f2" swConfigurationName="Default" swBoundingBox="0 0 0 0.08 0.05 0.01"/>'
            f'<swModel id="3" swName="{virtual}^{asm}" swFileRef="f3" swConfigurationName="Default" swBoundingBox="0 0 0 0.08 0.05 0.01"/>'
            '</swModelList></swSolidWorks>')


def sldasm(asm='FRAME', virtual='Bracket'):
    """Bytes of a synthetic .sldasm: its instance tree and one virtual part (the plate) embedded."""
    out = b'\x00\x00\x00\x00\x00\x00\x00\x04'
    out += block('swXmlContents/COMPINSTANCETREE', instance_tree(asm, virtual=virtual).encode())
    out += block(f'VirtualComp/{virtual}-sldprt', sldprt())
    return out
