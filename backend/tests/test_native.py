"""Native SolidWorks import with Forge's own reader (app/swread): container and Parasolid decoding, exact B-rep,
part data (holes, threads, material, properties), the package mapping and the worker path. The fixture part is
synthesised (sw_fixture.py), so no proprietary file is needed; FORGE_SW_SAMPLES=<folder of .sldprt files> also
reads every real part in that folder."""
import glob
import math
import os
import struct
import zlib
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import db, native, package, swread
from app.main import app
from app.swread import brep, container, xt
from app.worker import run_once
import sw_fixture


@pytest.fixture
def plate_file(tmp_path):
    p = tmp_path / 'TAP PLATE.SLDPRT'
    p.write_bytes(sw_fixture.sldprt())
    return p


def test_reader_rebuilds_the_exact_solid(plate_file):
    part = swread.read_part(plate_file)
    assert part.configuration.name == 'Default' and part.source == 'Contents/Config-0-Partition'
    assert len(part.solids) == 1
    ok, detail = brep.check(part.solids[0])
    assert ok, detail
    # exact geometry: the block less a Ø4.2 through hole, to the cylinder's analytic volume
    assert brep.volume(part.solids[0]) == pytest.approx(80 * 50 * 10 - math.pi * 2.1 ** 2 * 10, rel=1e-9)
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Cylinder
    from app.cad import explore, TopAbs_FACE
    from OCP.TopoDS import TopoDS
    cyl = [BRepAdaptor_Surface(TopoDS.Face(f)) for f in explore(part.solids[0], TopAbs_FACE)]
    cyl = [s for s in cyl if s.GetType() == GeomAbs_Cylinder]
    assert len(cyl) == 1 and cyl[0].Cylinder().Radius() == pytest.approx(2.1)


def test_reader_part_data(plate_file):
    part = swread.read_part(plate_file)
    assert part.material == 'AISI 304'
    assert part.properties == {'Part Number': 'FX-002', 'Description': 'Native fixture', 'Finish': 'Anodised'}
    assert part.holes == [{'feature': 'M5 Tapped Hole1', 'diameter': 4.2, 'point': [15.0, 15.0, 10.0], 'direction': [0.0, 0.0, -1.0], 'through': True, 'depth': None,
                           'counterbore': None, 'countersink': None, 'kind': 'tap', 'thread': 'M5', 'fastener': ''}]
    assert part.threads == [{'feature': 'Cosmetic Thread1', 'diameter': 8.0}]   # M8: no tapped hole carries that size
    assert not part.warnings


def test_hole_wizard_naming():
    assert swread.hole_spec({'name': 'M6 Tapped Hole2', 'type': ''}) == {'kind': 'tap', 'thread': 'M6', 'fastener': ''}
    assert swread.hole_spec({'name': 'M10 Clearance Hole1', 'type': ''})['kind'] == 'clearance'
    assert swread.hole_spec({'name': 'CSK for M4 Hex Socket Countersunk Cap Screw1', 'type': ''}) == {'kind': 'countersink', 'thread': '', 'fastener': 'M4'}
    assert swread.hole_spec({'name': 'CBORE for M8 Hex Socket Head Cap Screw1', 'type': ''})['kind'] == 'counterbore'
    assert swread.hole_spec({'name': 'Hole1', 'type': 'M8x1.0 Tapped Hole'})['thread'] == 'M8x1.0'


def test_package_mapping(plate_file):
    warnings = []
    part = native.part_from_sw(swread.read_part(plate_file), 'TAP PLATE', warnings)
    assert part['holes'][0]['thread'] == 'M5x0.8' and part['holes'][0]['kind'] == 'tap' and part['holes'][0]['thread_through']
    assert part['unplaced_threads'] == [{'feature': 'Cosmetic Thread1', 'thread': 'M8x1.25', 'diameter': 8.0, 'thread_depth': None, 'thread_through': False}]
    assert part['bbox'] == [80, 50, 10] and part['bbox_min'] == [0, 0, 0] and part['part_number'] == 'FX-002' and part['material'] == 'AISI 304'
    vp = package.validate_part(part, 'native')
    assert vp['holes'][0]['thread'] == 'M5×0.8' and vp['unplaced_threads'][0]['thread'] == 'M8×1.25'
    assert native._thread_from('M8x1') == 'M8x1' and native._thread_from('', 6.0) == 'M6x1'


def test_parasolid_reader_refuses_what_it_cannot_read():
    good = sw_fixture.plate_partition()
    nodes = xt.Reader(good).nodes()
    assert sum(n.name == 'FACE' for n in nodes.values()) == 7 and sum(n.name == 'EDGE' for n in nodes.values()) == 14
    with pytest.raises(xt.XTError, match='ends inside a node'):
        xt.Reader(good[:-40]).nodes()
    # a node type the schema table does not know is named in the error, not guessed
    w = sw_fixture.XTWriter()
    w.out += struct.pack('>HB', 199, 0xff)
    with pytest.raises(xt.XTError, match='node type 199 is not supported'):
        xt.Reader(w.bytes()).nodes()
    with pytest.raises(xt.XTError, match='not a Parasolid'):
        xt.Reader(b'ISO-10303-21;').nodes()


def test_container_blocks_and_errors(tmp_path):
    data = b'\x00' * 8 + sw_fixture.block('docProps/custom.xml', b'<x/>') + sw_fixture.block('Contents/Config-0-Partition', b'payload')
    p = tmp_path / 'a.sldprt'
    p.write_bytes(data)
    assert container.read(p) == {'docProps/custom.xml': b'<x/>', 'Contents/Config-0-Partition': b'payload'}
    bad = tmp_path / 'b.sldprt'
    bad.write_bytes(b'not a solidworks file' * 10)
    with pytest.raises(swread.ReadError, match='not a SolidWorks document'):
        swread.read_part(bad)
    # a block whose CRC does not match is not taken
    corrupt = bytearray(data)
    corrupt[-3] ^= 0xff
    p.write_bytes(bytes(corrupt))
    assert 'Contents/Config-0-Partition' not in container.read(p)
    # Parasolid streams are found behind the wrapper header SolidWorks writes
    ps = sw_fixture.plate_partition()
    assert container.parasolid_streams(b'\x0d\x01\x00\x00' + b'\x00' * 16 + zlib.compress(ps)) == [ps]
    assert container.kind(ps) == 'partition'


def test_part_without_geometry_is_refused(tmp_path):
    p = tmp_path / 'empty.sldprt'
    p.write_bytes(b'\x00' * 8 + sw_fixture.block('swXmlContents/KeyWords', sw_fixture.KEYWORDS.encode()))
    with pytest.raises(swread.ReadError, match='no solid geometry'):
        swread.read_part(p)
    with pytest.raises(native.NativeError, match='Export it from SolidWorks as STEP'):
        native.read(p)


def test_unplaced_cosmetic_threads_land_on_tap_drill_bores():
    """A cosmetic thread whose face is not known keeps its size, depth and count; the import puts it on the bores of
    the tap-drill size only when the counts agree."""
    part = {'id': 'arm-rh', 'name': 'ARM RH', 'step_names': ['ARM RH'], 'holes': [],
            'unplaced_threads': [{'feature': 'Cosmetic Thread1', 'thread': 'M8x1.25', 'diameter': 8.0, 'thread_depth': 48.75, 'thread_through': False}]}
    vp = package.validate_part(part, 'native')
    assert vp['unplaced_threads'][0]['thread'] == 'M8×1.25'
    pkg = {'manifest': {'schema': 'forge-package/1', 'generator': {'name': native.GENERATOR, 'version': ''}, 'source': {'cad': 'SolidWorks', 'kind': 'part'}, 'native': {}},
           'parts': {vp['id']: vp}, 'assembly': None, 'warnings': [], 'previews': 0}

    def bore(i, d, depth):
        return {'id': f'H{i:03d}', 'diameter': d, 'axis': [0, 1, 0], 'origin': [10 * i, 0, 0], 'start': 0.0, 'end': depth, 'depth': depth, 'center': [10 * i, depth / 2, 0], 'kind': 'cylindrical bore'}

    def fpart(bores):
        return {'id': 'p1', 'name': 'ARM RH', 'geometry': {'holes': bores, 'step_names': ['ARM RH'], 'recognition_notes': []}, 'spec': {**db.DEFAULT_SPEC}}
    p = fpart([bore(1, 8.0, 20), bore(2, 6.8, 60), bore(3, 8.1, 20)])
    s = package.apply(pkg, [p], {'p1': [{'matrix': np.eye(4).tolist(), 'path': 'ARM RH'}]})
    hw = p['spec']['feature_specs']['H002']['hardware']
    assert s['holes'] == {'total': 1, 'threaded': 1, 'applied': 1, 'kept': 0, 'unmatched': []}
    assert hw['id'] == 'tap-M8x1.25' and hw['source'] == 'cad' and hw['thread_depth'] == 48.75 and not hw['thread_through'] and hw['placed_by'] == 'tap-drill size'
    p = fpart([bore(1, 6.8, 40), bore(2, 6.75, 40)])
    s = package.apply(pkg, [p], {'p1': []})
    assert s['holes']['applied'] == 0 and s['holes']['unmatched'][0]['thread'] == 'M8×1.25' and not p['spec']['feature_specs']


def test_native_part_upload_end_to_end(tmp_path, monkeypatch):
    (tmp_path / 'data').mkdir()
    monkeypatch.setattr(db, 'ROOT', tmp_path / 'data')
    with TestClient(app) as client:
        h = {'X-Forge-Request': '1'}
        assert client.post('/api/auth/setup', json={'email': 'test@example.com', 'name': 'Test Engineer', 'password': 'fixture-password-123'}).status_code == 200
        assert client.post('/api/auth/login', json={'email': 'test@example.com', 'password': 'fixture-password-123'}).status_code == 200
        cfg = client.get('/api/config').json()
        assert '.sldprt' in cfg['formats'] and cfg['capabilities']['native_proprietary_cad']
        pid = client.post('/api/projects', headers=h, json={'name': 'Native fixture'}).json()['id']
        assert client.post(f'/api/projects/{pid}/uploads', headers=h, json={'filename': 'GT400.SLDASM', 'size': 1000}).status_code == 422   # needs its parts: a ZIP
        r = client.post(f'/api/projects/{pid}/revisions', headers=h, files={'file': ('TAP PLATE.SLDPRT', sw_fixture.sldprt())}).json()
        assert run_once()
        rev = client.get('/api/revisions/' + r['id']).json()
        assert rev['status'] == 'ready', rev
        pk = rev['manifest']['package']
        assert pk['generator']['name'] == native.GENERATOR and pk['matched_parts'] == 1
        assert pk['holes']['applied'] == 1 and pk['holes']['threaded'] >= 1
        part = rev['parts'][0]
        hw = [fs['hardware'] for fs in part['spec']['feature_specs'].values()]
        assert [v['id'] for v in hw] == ['tap-M5x0.8'] and hw[0]['source'] == 'cad'
        assert part['spec']['material'] == 'AISI 304' and part['spec']['finish'] == 'Anodised' and part['geometry']['cad']['part_number'] == 'FX-002'
        folder = db.revdir(r['id'])
        assert (folder / 'source.sldprt').exists() and (folder / 'source.brep').exists() and (folder / 'package' / 'manifest.json').exists()
        # a file that is not a SolidWorks part fails its revision with the reason
        bad = client.post(f'/api/projects/{pid}/revisions', headers=h, files={'file': ('BROKEN.SLDPRT', b'not a solidworks file' * 20)}).json()
        run_once()
        brev = client.get('/api/revisions/' + bad['id']).json()
        assert brev['status'] == 'failed' and 'not a SolidWorks document' in str(brev)


def test_assembly_zip_upload_end_to_end(tmp_path, monkeypatch):
    """A zipped assembly folder (here with a Pack and Go prefix on every file name): the instance tree places the
    plate twice, the virtual part comes out of the assembly file, nothing becomes a placeholder."""
    import io
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr('FRAME/ISO-FRAME.SLDASM', sw_fixture.sldasm())
        z.writestr('FRAME/ISO-TAP PLATE.SLDPRT', sw_fixture.sldprt())
        z.writestr('FRAME/ISO-EMPTY.SLDPRT', b'\x00' * 64)
    (tmp_path / 'data').mkdir()
    monkeypatch.setattr(db, 'ROOT', tmp_path / 'data')
    with TestClient(app) as client:
        h = {'X-Forge-Request': '1'}
        assert client.post('/api/auth/setup', json={'email': 'test@example.com', 'name': 'Test Engineer', 'password': 'fixture-password-123'}).status_code == 200
        assert client.post('/api/auth/login', json={'email': 'test@example.com', 'password': 'fixture-password-123'}).status_code == 200
        assert '.zip' in client.get('/api/config').json()['formats']
        pid = client.post('/api/projects', headers=h, json={'name': 'Native assembly'}).json()['id']
        r = client.post(f'/api/projects/{pid}/revisions', headers=h, files={'file': ('FRAME.zip', buf.getvalue())}).json()
        assert run_once()
        rev = client.get('/api/revisions/' + r['id']).json()
        assert rev['status'] == 'ready', rev
        man = rev['manifest']['package']
        assert man['generator']['name'] == native.GENERATOR
        names = sorted(p['name'] for p in rev['parts'])
        assert names == ['Bracket', 'TAP PLATE'], names
        assert {p['name']: p['quantity'] for p in rev['parts']} == {'Bracket': 1, 'TAP PLATE': 2}
        assert rev['manifest']['occurrences'] == 3 and 'placeholder' not in str(rev['manifest']['warnings']).lower()


def test_bundle_lookup_and_empty_files(tmp_path):
    files = {'iso-tap plate.sldprt': 'A', 'tap plate.sldprt.bak': 'B', 'iso-frame.sldasm': 'C'}
    find = native._resolver(files)
    assert find('C:\\work\\TAP PLATE.SLDPRT') == 'A' and find('frame.SLDASM') == 'C' and find('missing.sldprt') is None
    a = tmp_path / '0000-ISO-FRAME.SLDASM'
    a.write_bytes(sw_fixture.sldasm())
    virtual = native._virtual_parts([a], tmp_path / 'v')
    assert native._virtual_file(virtual, 'Bracket^FRAME.SLDPRT') is not None and native._virtual_file(virtual, 'Other^FRAME.SLDPRT') is None
    z = tmp_path / 'zero.sldasm'
    z.write_bytes(b'\x00' * 4096)
    with pytest.raises(container.ContainerError, match='every byte is zero'):
        container.read(z)


SAMPLES = os.getenv('FORGE_SW_SAMPLES')


@pytest.mark.skipif(not SAMPLES, reason='FORGE_SW_SAMPLES not set')
@pytest.mark.parametrize('path', sorted(glob.glob(os.path.join(SAMPLES or '.', '*.[sS][lL][dD][pP][rR][tT]'))))
def test_real_parts(path):
    part = swread.read_part(path)
    assert part.solids
    for s in part.solids:
        ok, detail = brep.check(s)
        assert ok, f'{Path(path).name}: {detail}'


def test_explicit_configuration_never_uses_other_geometry(plate_file, monkeypatch):
    with pytest.raises(swread.ReadError, match="configuration 'Missing' is not in the part"):
        swread.read_part(plate_file, 'Missing')
    # Punctuation distinguishes legitimate configuration names.
    streams = container.read(plate_file)
    streams['swXmlContents/KeyWords'] = sw_fixture.KEYWORDS.replace(
        '<Configuration id="0"', '<Configuration id="1" Name="Default-2"/><Configuration id="2" Name="Default2"/><Configuration id="0"').encode()
    monkeypatch.setattr(container, 'read', lambda path: streams)
    for config in ('Default-2', 'Default2'):
        with pytest.raises(swread.ReadError, match='no solid geometry'):
            swread.read_part(plate_file, config)
    assert swread.read_part(plate_file, 'default').configuration.name == 'Default'


def test_nested_assembly_placements_and_inherited_flags():
    import xml.etree.ElementTree as ET
    root = ET.fromstring(sw_fixture.instance_tree(plates=((0, 0, 100),)))
    models = root.find('swModelList')
    assembly = models.find('swModel')
    plate_ref = assembly.find('swReference')
    assembly.remove(plate_ref)
    sub = ET.SubElement(models, 'swModel', id='4', swName='Sub', swFileRef='f4')
    sub.append(plate_ref)
    ET.SubElement(root.find('swFileList'), 'swFile', id='f4', swPath='Sub.SLDASM', swDocType='ASSEMBLY')
    # Rotate 90 degrees about Z and translate 200 mm along X.
    ET.SubElement(assembly, 'swReference', swModelRef='4', swName='Sub', swHidden='YES', swExcludeFromBOM='YES',
                  swTransform='0 1 0 0 -1 0 0 0 0 0 1 0 .2 0 0 1')
    leaves = native.parse_instance_tree(ET.tostring(root))['leaves']
    plate = next(l for l in leaves if l['file'] == 'TAP PLATE.SLDPRT')
    assert plate['hidden'] and plate['exclude_from_bom']
    assert np.array(plate['matrix']) @ [10, 0, 0, 1] == pytest.approx([200, 10, 100, 1])
    bracket = next(l for l in leaves if l['virtual'])
    assert not bracket['hidden'] and not bracket['exclude_from_bom']


def test_bundle_keeps_each_configuration_separate(tmp_path, monkeypatch):
    import xml.etree.ElementTree as ET
    import zipfile
    from app.cad import read_brep
    root = ET.fromstring(sw_fixture.instance_tree())
    refs = root.find('swModelList').find('swModel').findall('swReference')
    refs[0].set('swConfigurationName', 'Default')
    refs[1].set('swConfigurationName', 'Long')
    archive = tmp_path / 'FRAME.zip'
    with zipfile.ZipFile(archive, 'w') as z:
        z.writestr('FRAME.SLDASM', b'\0' * 8 + sw_fixture.block('swXmlContents/COMPINSTANCETREE', ET.tostring(root)))
        z.writestr('TAP PLATE.SLDPRT', sw_fixture.sldprt())
    original_read = native.read
    calls = []

    def read_config(path, configuration=None):
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
        part = original_read(path)
        calls.append(configuration)
        if configuration == 'Long':
            part.configuration = swread.Configuration(1, 'Long')
            part.solids = [BRepPrimAPI_MakeBox(160, 50, 10).Solid()]
            part.holes = []
        return part

    monkeypatch.setattr(native, 'read', read_config)
    folder = tmp_path / 'revision'
    folder.mkdir()
    pkg = native.convert_bundle(archive, folder, 'FRAME', 10_000_000)
    plates = [p for p in pkg['parts'].values() if p['file'] == 'TAP PLATE.SLDPRT']
    assert len(plates) == 2
    assert calls == ['Default', 'Long']
    assert {p['configuration'] for p in plates} == {'Default', 'Long'}
    assert sorted(p['bbox'][0] for p in plates) == [80, 160]
    assert len({c['part'] for c in pkg['assembly']['components'] if c['part'] in {p['id'] for p in plates}}) == 2
    for p in plates:
        shape = read_brep(folder / 'package' / 'geometry' / f"{p['id']}.brep")
        assert native._bbox([shape])[0] == p['bbox']


def test_native_bundle_feature_mapping_uses_definition_identity():
    parts = {key: package.validate_part({'id': key, 'name': 'PLATE', 'file': 'PLATE.SLDPRT',
                                       'configuration': config}, key)
             for key, config in (('plate', 'Default'), ('plate-2', 'Long'))}
    pkg = {'parts': parts, 'bundle': True}
    imported = [{'id': 'body1', 'name': 'PLATE', 'geometry': {'source_component': 'plate'}},
                {'id': 'body2', 'name': 'PLATE', 'geometry': {'source_component': 'plate-2'}},
                {'id': 'body3', 'name': 'PLATE / Body 2', 'geometry': {'source_component': 'plate-2'}}]
    link = package.match_parts(pkg, imported)
    assert {key: p['configuration'] for key, p in link.items()} == {'body1': 'Default', 'body2': 'Long', 'body3': 'Long'}


def test_repeated_name_aliases_still_match_uniquely():
    part = package.validate_part({'id': 'plate', 'name': 'PLATE', 'file': 'PLATE.SLDPRT', 'step_names': ['PLATE']}, 'plate')
    other = package.validate_part({'id': 'other', 'name': 'OTHER'}, 'other')
    link = package.match_parts({'parts': {'plate': part, 'other': other}},
                               [{'id': 'p1', 'name': 'PLATE', 'geometry': {}}])
    assert link['p1']['id'] == 'plate'


@pytest.mark.parametrize('compressed', [False, True])
def test_assembly_xml_without_declaration(tmp_path, compressed):
    xml = sw_fixture.instance_tree().split('?>', 1)[1].encode()
    data = b'header' + (zlib.compress(xml) if compressed else xml)
    key = native.INSTANCE_TREE_STREAMS[int(compressed)]
    path = tmp_path / 'tree.sldasm'
    path.write_bytes(b'\0' * 8 + sw_fixture.block(key, data))
    assert native.parse_instance_tree(native.instance_tree_xml(path))['name'] == 'FRAME'
