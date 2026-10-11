"""Parasolid XT neutral-binary (transmit) reader.

SolidWorks keeps every body as Parasolid transmit data inside the part file. A stream is a header (title, schema
key) followed by nodes until a terminator. Each node is its type (u16), on the first occurrence of a type the
type's field layout, a length for variable-length types, its index (a pointer) and its fields, big-endian.

Field layouts come from Parasolid's base schema 13006 (BASE below). A file written by a newer Parasolid describes how
its schema differs when it first uses a type: 0xFF means "as in the base schema", otherwise a field count and an
edit script — C copies the next base field, D drops it, I/A insert a field described inline (name, pointer class or
a type code, element count), Z ends the script. Types the base schema does not have are defined in full inline.

Field codes: d int32, n int16, p pointer, f double, c char, l logical, u byte, v vector (3 f), i interval (2 f),
b box (6 f), h hvec (4 f), w wide char. Pointers are node indices; 0 and 1 are null. Lengths are metres.
"""
import struct

NULL_DOUBLE = -3.14158e13

def F(spec):
    """'name:code[:count] ...' -> [(name, code, count)]."""
    out = []
    for x in spec.split():
        p = x.split(':')
        out.append((p[0], p[1], int(p[2]) if len(p) > 2 else 1))
    return out

H = 'node_id:d attributes_groups:p owner:p next:p previous:p geometric_owner:p sense:c '  # common geometry header

# node type -> (name, variable length, base fields). Verified field by field against SolidWorks 2015-2024 partitions:
# every stream must parse to its terminator with every pointer resolving, and decoded geometry must reproduce the
# display tessellation's volume. Field names marked x* are present but unused here.
BASE = {
    13: ('SHELL', False, F('node_id:d attributes_groups:p body:p next:p face:p edge:p vertex:p region:p front_face:p')),
    14: ('FACE', False, F('node_id:d attributes_groups:p tolerance:f next:p previous:p loop:p shell:p surface:p sense:c next_on_surface:p previous_on_surface:p next_front:p previous_front:p front_shell:p')),
    15: ('LOOP', False, F('node_id:d attributes_groups:p fin:p face:p next:p')),
    16: ('EDGE', False, F('node_id:d attributes_groups:p tolerance:f fin:p previous:p next:p curve:p next_on_curve:p previous_on_curve:p owner:p')),
    17: ('FIN', False, F('attributes_groups:p loop:p forward:p backward:p vertex:p other:p edge:p curve:p next_at_vx:p sense:c')),
    18: ('VERTEX', False, F('node_id:d attributes_groups:p fin:p previous:p next:p point:p tolerance:f owner:p')),
    19: ('REGION', False, F('node_id:d attributes_groups:p body:p next:p previous:p shell:p type:c')),
    29: ('POINT', False, F('node_id:d attributes_groups:p owner:p next:p previous:p pvec:v')),
    30: ('LINE', False, F(H + 'pvec:v direction:v')),
    31: ('CIRCLE', False, F(H + 'centre:v normal:v x_axis:v radius:f')),
    51: ('CYLINDER', False, F(H + 'pvec:v axis:v radius:f x_axis:v')),
    50: ('PLANE', False, F(H + 'pvec:v normal:v x_axis:v')),
    70: ('LIST', False, F('node_id:d owner:p next:p previous:p deleted0:? list_length:d block_length:d deleted1:? first_block:p')),
    101: ('PARTITION', False, F('p0:p p1:p p2:p p3:p p4:p p5:p p6:p l0:l p7:p d0:d d1:d')),
    74: ('POINTER_LIST_BLOCK', True, F('n_entries:d next_block:p entries:p')),
    84: ('CHAR_VALUES_84', True, F('values:c')),
    52: ('CONE', False, F(H + 'pvec:v axis:v radius:f sin_half_angle:f cos_half_angle:f x_axis:v')),
    53: ('SPHERE', False, F(H + 'centre:v radius:f axis:v x_axis:v')),
    54: ('TORUS', False, F(H + 'centre:v axis:v major_radius:f minor_radius:f x_axis:v')),
    133: ('TRIMMED_CURVE', False, F(H + 'basis_curve:p point_1:v point_2:v parm_1:f parm_2:f')),
    134: ('B_CURVE', False, F(H + 'nurbs:p data:p')),
    137: ('SP_CURVE', False, F(H + 'surface:p b_curve:p original:p tolerance_to_original:f')),
    141: ('GEOMETRIC_OWNER', False, F('owner:p next:p previous:p shared_geometry:p')),
    45: ('BSPLINE_VERTICES', True, F('vertices:f')),
    135: ('CURVE_DATA', False, F('self_int:u extension:p')),
    136: ('NURBS_CURVE', False, F('degree:n n_vertices:d vertex_dim:n n_knots:d knot_type:u periodic:l closed:l rational:l curve_form:u bspline_vertices:p knot_mult:p knots:p')),
    127: ('KNOT_MULT', True, F('mult:n')),
    128: ('KNOT_SET', True, F('knots:f')),
    124: ('B_SURFACE', False, F(H + 'nurbs:p data:p')),
    125: ('SURFACE_DATA', False, F('original_uint:i original_vint:i extended_uint:i extended_vint:i self_int:u flags:u:12 extra:p:4')),
    126: ('NURBS_SURF', False, F('u_periodic:l v_periodic:l u_degree:n v_degree:n n_u_vertices:d n_v_vertices:d u_knot_type:u v_knot_type:u n_u_knots:d n_v_knots:d rational:l u_closed:l v_closed:l surface_form:u vertex_dim:n bspline_vertices:p u_knot_mult:p v_knot_mult:p u_knots:p v_knots:p')),
    38: ('INTERSECTION', False, F(H + 'surface:p:2 chart:p start:p end:p')),
    40: ('CHART', True, F('base_parameter:f base_scale:f chart_count:d chordal_error:f angular_error:f parameter_error:f:2 hvec:v')),
    41: ('LIMIT', True, F('type:c hvec:v')),
    79: ('CHAR_VALUES', True, F('values:c')),
    80: ('ATTRIB_DEF', True, F('next:p identifier:p type_id:d actions:u:8 class0:u deleted0:? fields:u')),
    81: ('ATTRIBUTE', True, F('node_id:d definition:p owner:p next:p previous:p next_of_type:p previous_of_type:p fields:p')),
    82: ('INT_VALUES', True, F('values:d')),
    100: ('TRANSFORM', False, F('node_id:d owner:p next:p previous:p rotation_matrix:f:9 translation_vector:v scale:f flag:d perspective_vector:v')),
    184: ('CURVE_FORM', False, F('v0:v v1:v f0:f f1:f f2:f sense:c f3:f f4:f f5:f f6:f')),
    163: ('SURFACE_FORM', False, F('v0:v v1:v sense:c f0:f f1:f f2:f f3:f f4:f')),
    86: ('VECTOR_VALUES', True, F('values:v')),
    83: ('REAL_VALUES', True, F('values:f')),
    98: ('UNICODE_VALUES', True, F('values:w')),
}
# BODY: reconstructed from the edit scripts SolidWorks writes (it always edits BODY); 23 base fields. body_type 1 is
# a solid, 2 a sheet/wire (construction geometry).
BASE[12] = ('BODY', False, F('highest_node_id:d attributes_groups:p attribute_chains:p x0:p x1:p x2:p x3:p '
                             'body_size:f resolution:f x4:p x5:p x6:p x7:l x8:? body_type:c nom_geom_state:c shell:p '
                             'x9:p x10:p x11:p x12:p x13:p x14:p'))
# Types the base schema has but these files have not shown yet; layouts as published for schema 13006.
BASE.update({
    32: ('ELLIPSE', False, F(H + 'centre:v normal:v x_axis:v major_radius:f minor_radius:f')),
    60: ('OFFSET_SURF', False, F(H + 'check:c true_offset:l surface:p offset:f scale:f')),
    67: ('SWEPT_SURF', False, F(H + 'section:p sweep:v scale:f')),
    68: ('SPUN_SURF', False, F(H + 'profile:p base:v axis:v start:v end:v start_param:f end_param:f x_axis:v scale:f')),
})

SIZES = {'d': 4, 'f': 8, 'c': 1, 'l': 1, 'u': 1, 'n': 2, 'w': 2, 'v': 24, 'b': 48, 'h': 32, 'i': 16}


class XTError(ValueError):
    pass


class Node:
    __slots__ = ('type', 'name', 'index', 'f')

    def __init__(self, t, name, index):
        self.type, self.name, self.index, self.f = t, name, index, {}

    def __getattr__(self, k):
        try:
            return self.f[k]
        except KeyError:
            raise AttributeError(k)

    def __repr__(self):
        return f'<{self.name}#{self.index} {self.f}>'


class Reader:
    def __init__(self, data, base=BASE):
        self.b, self.o = data, 0
        self.base = base
        self.schema = {}  # type -> (name, variable, fields)

    # primitives
    def u8(self):
        v = self.b[self.o]; self.o += 1; return v

    def u16(self):
        v = struct.unpack_from('>H', self.b, self.o)[0]; self.o += 2; return v

    def i32(self):
        v = struct.unpack_from('>i', self.b, self.o)[0]; self.o += 4; return v

    def f64(self):
        v = struct.unpack_from('>d', self.b, self.o)[0]; self.o += 8; return v

    def ptr(self):
        v = self.u16()
        if v & 0x8000:
            v = ((v & 0x7fff) << 16) | self.u16()
        return v

    def text(self, n):
        v = self.b[self.o:self.o + n]; self.o += n; return v

    def value(self, code, n=1, many=False):
        many = many or n != 1
        if code == 'p':
            return [self.ptr() for _ in range(n)] if many else self.ptr()
        if code in 'cul':
            v = self.text(n)
            return v if many else v[0]
        out = []
        for _ in range(n):
            if code == 'd': out.append(self.i32())
            elif code == 'f': out.append(self.f64())
            elif code == 'n': out.append(self.u16())
            elif code == 'w': out.append(self.u16())
            elif code in 'vbhi':
                out.append(tuple(self.f64() for _ in range(SIZES[code] // 8)))
            else:
                raise XTError(f'field type {code!r} not readable (at byte {self.o})')
        return out if many else out[0]

    # schema
    def edited_schema(self, t, nfields):
        name, variable, base = self.base.get(t, (f'T{t}', None, None))
        if base is None:
            base = []
        fields, bi = [], 0
        while True:
            op = chr(self.u8())
            if op == 'Z':
                break
            if op == 'C':
                if bi >= len(base):
                    raise XTError(f'{name}: copy past base field list ({bi}) at {self.o}')
                fields.append(base[bi]); bi += 1
            elif op == 'D':
                if bi >= len(base):
                    raise XTError(f'{name}: delete past base field list at {self.o}')
                bi += 1
            elif op in 'IA':
                fields.append(self.field_def())
            else:
                raise XTError(f'{name}: bad schema op {op!r} at {self.o - 1}')
        if bi != len(base):
            raise XTError(f'{name}: edit script consumed {bi}/{len(base)} base fields')
        if len(fields) != nfields:
            raise XTError(f'{name}: {len(fields)} fields, header says {nfields}')
        return name, variable, fields

    def field_def(self):
        n = self.u8(); fname = self.text(n).decode('latin-1')
        cls = self.u16(); cnt = self.u16()
        if cls == 0:
            k = self.u8(); code = self.text(k).decode()
        else:
            code = 'p'
        return fname, code, cnt

    def new_type(self, t, nfields):
        n = self.u8(); name = self.text(n).decode('latin-1')
        n = self.u8(); self.text(n)  # description
        fields = [self.field_def() for _ in range(nfields)]
        variable = bool(self.u8())
        return name, variable, fields

    def header(self):
        if self.b[:4] != b'PS\x00\x00':
            raise XTError('not a Parasolid neutral binary stream')
        self.o = 4
        n = self.u16(); self.title = self.text(n).decode('latin-1')
        n = self.i32(); self.schema_key = self.text(n).decode('latin-1')
        self.h1 = self.u16(); self.user_field_size = self.i32()

    def nodes(self):
        """{index: Node} for the whole stream; XTError when it does not parse exactly to its terminator."""
        try:
            return self._nodes()
        except (struct.error, IndexError) as e:
            raise XTError(f'stream ends inside a node (byte {self.o}): {e}')

    def _nodes(self):
        self.header()
        out = {}
        while True:
            start = self.o
            t = self.u16()
            if t == 1:
                self.ptr()
                break
            if t not in self.schema:
                flag = self.u8()
                if flag == 0xff:
                    if t not in self.base:
                        raise XTError(f'Parasolid node type {t} is not supported yet (byte {start})')
                    name, variable, base = self.base[t]
                    self.schema[t] = (name, variable, base)
                elif t not in self.base and self.b[self.o] not in b'CDIAZ':
                    self.schema[t] = self.new_type(t, flag)
                else:
                    self.schema[t] = self.edited_schema(t, flag)
            name, variable, fields = self.schema[t]
            if variable is None:
                raise XTError(f'{name}: unknown whether variable-length at {start}')
            vlen = self.i32() if variable else None
            idx = self.ptr()
            node = Node(t, name, idx)
            last = len(fields) - 1
            for k, (fname, code, cnt) in enumerate(fields):
                if variable and k == last:
                    node.f[fname] = self.value(code, vlen, many=True)
                else:
                    node.f[fname] = self.value(code, cnt)
            if idx in out:
                raise XTError(f'duplicate node index {idx} ({name}) at {start}')
            out[idx] = node
        if self.o != len(self.b):
            raise XTError(f'{len(self.b) - self.o} trailing bytes after terminator')
        return out
