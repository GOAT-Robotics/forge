"""The SolidWorks exporter's pure-Python logic (no COM): transforms, bore grouping, library-part detection and the
package it writes being accepted by the importer. The COM surface itself is exercised on a Windows seat."""
import importlib.util, io, json, math, zipfile
from pathlib import Path
import pytest
from app import package

SRC = Path(__file__).resolve().parents[2] / 'tools' / 'solidworks' / 'forge_export.py'
spec = importlib.util.spec_from_file_location('forge_export', SRC)
fx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fx)


class Surface:
    def __init__(self, params):
        self.params = params

    def IsCylinder(self):
        return self.params is not None

    @property
    def CylinderParams(self):
        return tuple(self.params)


class Edge:
    def __init__(self, a, b):
        self.a, self.b = a, b

    def GetCurveParams2(self):
        return (*self.a, *self.b, 0, 0, 0, 0, 0)


class Face:
    """A cylindrical face in metres: origin, axis, radius, axial span [lo, hi] (metres)."""
    def __init__(self, origin, axis, radius, lo, hi):
        self.params = (*origin, *axis, radius)
        self.lo, self.hi = lo, hi
        self.origin, self.axis, self.radius = origin, axis, radius

    def GetSurface(self):
        return Surface(self.params)

    def GetEdges(self):
        o, a, r = self.origin, self.axis, self.radius
        p = lambda t: [o[0] + a[0] * t + r, o[1] + a[1] * t, o[2] + a[2] * t]
        return (Edge(p(self.lo), p(self.lo)), Edge(p(self.hi), p(self.hi)))


def test_transform_convention_matches_solidworks_row_vectors():
    # SolidWorks: [x y z] * R * scale + T with ArrayData = (a b c d e f g h i j k l m 0 0 0); 90° about Z, 100 mm along X
    c, s = math.cos(math.pi / 2), math.sin(math.pi / 2)
    arr = (c, s, 0, -s, c, 0, 0, 0, 1, .1, 0, 0, 1, 0, 0, 0)
    m = fx.sw_matrix(arr)
    # a point at x=1 m in part space: SolidWorks gives [1 0 0]*R = (c, s, 0) -> (0, 1, 0) m, plus 100 mm
    assert [round(v, 6) for v in fx.apply_matrix(m, [1000, 0, 0])] == [100, 1000, 0]
    assert not fx.mirrored(m)
    assert fx.mirrored(fx.sw_matrix((-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0)))


def test_bores_from_faces_and_entry_points():
    # two half-faces of one Ø4.2 bore along Z from z=2..10 mm, and another bore 50 mm away
    faces = [Face((.015, .015, 0), (0, 0, 1), .0021, .002, .006), Face((.015, .015, 0), (0, 0, 1), .0021, .006, .010), Face((.065, .015, 0), (0, 0, -1), .0021, -.010, -.002)]
    bores = fx.group_cylinders(faces)
    assert len(bores) == 2
    b = next(b for b in bores if abs(b['origin'][0] - 15) < 1e-6)
    assert abs(b['diameter'] - 4.2) < 1e-9 and [round(x, 6) for x in b['span']] == [2, 10]
    point, direction, exact = fx.entry_for(b, [[15, 15, 10]])
    assert exact and point == [15, 15, 10] and direction == [0, 0, -1]
    point, direction, exact = fx.entry_for(b, [])
    assert not exact and point == [15, 15, 10] and direction == [0, 0, -1]


def test_thread_text_and_library_parts():
    assert fx.thread_text('M5x0.8', 'M5 Tapped Hole1') == 'M5x0.8'
    assert fx.thread_text('', 'M5 Tapped Hole1') == 'M5'
    assert fx.thread_text('#10-32', '') == '#10-32'
    assert fx.thread_text('', 'CBORE for M6 Socket Head Cap Screw1') == 'M6'
    f = fx.classify_library_part('socket head cap screw_iso.sldprt ISO 4762 - M5 x 12 --- 12N', 'Socket Head Cap Screw ISO 4762 M5 x 12', True)
    assert f == {'role': 'fastener', 'kind': 'screw', 'standard': 'ISO 4762', 'size': 'M5', 'length': 12.0, 'name': 'Socket Head Cap Screw ISO 4762 M5 x 12'}
    i = fx.classify_library_part('S-M3-1.SLDPRT Default', 'PEM self-clinching nut S-M3-1', False)
    assert i == {'role': 'insert', 'type': 'nut', 'thread': 'M3', 'pn': 'S-M3-1', 'name': 'PEM self-clinching nut S-M3-1'}
    assert fx.classify_library_part('FH-M5-20.SLDPRT Default', '', False)['type'] == 'stud'
    assert fx.classify_library_part('BSO-M3-10.SLDPRT', 'blind standoff', False)['type'] == 'standoff'
    assert fx.classify_library_part('rivnut m6 flat head.sldprt', '', False)['type'] == 'rivnut'
    assert fx.classify_library_part('GT-SM-046 SMPS PLATE.SLDPRT Default', 'SMPS mounting plate', False) is None
    assert fx.clean_component_name('GT-SM-046 SMPS PLATE-1') == 'GT-SM-046 SMPS PLATE' and fx.clean_component_name('plate^GT400-3') == 'plate'
    assert fx.slug('GT-SM-046 SMPS PLATE') == 'gt-sm-046-smps-plate'


def test_host_detection_uses_placed_bounding_boxes():
    parts = {'plate': {'bbox': [100, 60, 2], 'bbox_min': [0, 0, 0]}, 'block': {'bbox': [80, 50, 10], 'bbox_min': [0, 0, 0]}}
    comps = [{'part': 'plate', 'transform': [1, 0, 0, 200, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]}, {'part': 'block', 'transform': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]}]
    ins = {'transform': [1, 0, 0, 220, 0, 1, 0, 20, 0, 0, 1, 2, 0, 0, 0, 1]}
    assert fx.host_for(ins, comps, parts) == 'plate'
    assert fx.host_for({'transform': [1, 0, 0, 500, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]}, comps, parts) is None


def test_written_package_is_accepted_by_the_importer(tmp_path):
    step = tmp_path / 'model.step'
    step.write_bytes(b'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n' * 2)
    parts = [{'id': 'tap-plate', 'name': 'TAP PLATE', 'file': 'TAP PLATE.SLDPRT', 'configuration': 'Default', 'step_names': ['TAP PLATE'], 'part_number': 'FX-001', 'description': '', 'revision': 'A',
              'properties': {'Finish': 'Zinc'}, 'material': 'AISI 304', 'density': 8.0, 'mass_kg': .1, 'volume_mm3': 39500.0, 'bbox': [80, 50, 10], 'bbox_min': [0, 0, 0], 'bodies': 1, 'sheet_metal': None, 'welds': [],
              'holes': [{'id': 'h1', 'feature': 'M5 Tapped Hole1', 'kind': 'tap', 'standard': '2', 'fastener': 'M5x0.8', 'thread': 'M5x0.8', 'thread_class': '', 'thread_depth': 6.0, 'thread_through': False, 'diameter': 4.2,
                         'depth': 8.0, 'through': False, 'counterbore': None, 'countersink': None, 'point': [15, 15, 10], 'direction': [0, 0, -1], 'face': None, 'cad': {'type': 37, 'entry_from_sketch': True}}]}]
    asm = {'name': 'FIXTURE', 'configuration': 'Default', 'components': [{'id': 'c1', 'part': 'tap-plate', 'name': 'TAP PLATE', 'instance': 'TAP PLATE-1', 'path': 'FIXTURE / TAP PLATE-1', 'configuration': 'Default',
                                                                             'transform': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 'suppressed': False, 'exclude_from_bom': False, 'virtual': False, 'fixed': True, 'mirrored': False}],
           'fasteners': [{'id': 'f1', 'kind': 'screw', 'standard': 'ISO 4762', 'size': 'M5', 'length': 12.0, 'name': 'ISO 4762 M5 x 12', 'path': 'FIXTURE / screw-1', 'transform': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]}],
           'inserts': []}
    out = tmp_path / 'fixture.forge'
    fx.write_package(str(out), str(step), 'FIXTURE.SLDASM', 'assembly', parts, asm, ['one warning'], '2024')
    folder = tmp_path / 'rev'
    folder.mkdir()
    pkg = package.unpack(out, folder, 10 ** 9)
    assert pkg['manifest']['source'] == {'cad': 'SolidWorks', 'version': '2024', 'file': 'FIXTURE.SLDASM', 'kind': 'assembly'} and not pkg['warnings']
    assert pkg['parts']['tap-plate']['holes'][0]['thread'] == 'M5×0.8' and pkg['assembly']['fasteners'][0]['length'] == 12.0
    assert (folder / 'source.step').read_bytes() == step.read_bytes()


@pytest.mark.parametrize('fails', [False, True])
def test_part_export_reads_referenced_configuration_and_restores_active(monkeypatch, fails):
    from types import SimpleNamespace
    active = SimpleNamespace(Name='Default')
    changes = []

    def activate(name):
        changes.append(name)
        active.Name = name
        return True

    model = SimpleNamespace(ConfigurationManager=SimpleNamespace(ActiveConfiguration=active), ShowConfiguration2=activate)

    def read_active(model, config, warnings, probe):
        assert active.Name == config == 'Long'
        if fails:
            raise ValueError('unreadable feature')
        return {'configuration': config}

    monkeypatch.setattr(fx, '_read_active_part', read_active)
    if fails:
        with pytest.raises(ValueError, match='unreadable feature'):
            fx.read_part(model, 'Long', [])
    else:
        assert fx.read_part(model, 'Long', []) == {'configuration': 'Long'}
    assert active.Name == 'Default' and changes == ['Long', 'Default']


def test_part_export_refuses_unavailable_configuration(monkeypatch):
    from types import SimpleNamespace
    model = SimpleNamespace(ConfigurationManager=SimpleNamespace(ActiveConfiguration=SimpleNamespace(Name='Default')),
                            ShowConfiguration2=lambda name: False)
    monkeypatch.setattr(fx, '_read_active_part', lambda *args: pytest.fail('wrong configuration read'))
    with pytest.raises(RuntimeError, match='could not activate'):
        fx.read_part(model, 'Missing', [])
