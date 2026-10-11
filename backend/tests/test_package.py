"""Forge package (.forge) import: STEP + CAD feature JSON (docs/FORGE_PACKAGE.md)."""
import io, json, zipfile, hashlib
import numpy as np
import pytest
from fastapi.testclient import TestClient
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.gp import gp_Pnt, gp_Ax2, gp_Dir, gp_Trsf, gp_Vec
from OCP.TopLoc import TopLoc_Location
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs
from app.main import app
from app import db, package
from app.worker import run_once
from app.cad import import_model
from test_geometry import plate


def tap_plate():
    """80 x 50 x 10 block: two blind Ø4.2 bores (M5 tap drill) from the top, one through Ø2.5 (M3), one through Ø6.6 clearance."""
    s = BRepPrimAPI_MakeBox(80, 50, 10).Shape()
    for x, y in ((15, 15), (65, 15)):
        s = BRepAlgoAPI_Cut(s, BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(x, y, 2), gp_Dir(0, 0, 1)), 2.1, 9).Shape()).Shape()
    s = BRepAlgoAPI_Cut(s, BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(40, 35, -1), gp_Dir(0, 0, 1)), 1.25, 12).Shape()).Shape()
    s = BRepAlgoAPI_Cut(s, BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(15, 38, -1), gp_Dir(0, 0, 1)), 3.3, 12).Shape()).Shape()
    return s


def write_assembly_step(path, items):
    """items: [(name, shape, (tx, ty, tz))] -> STEP assembly with named products and placements."""
    doc = TDocStd_Document(TCollection_ExtendedString('fixture'))
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    asm = st.NewShape()
    TDataStd_Name.Set_s(asm, TCollection_ExtendedString('FIXTURE ASM'))
    for name, shape, t in items:
        lbl = st.AddShape(shape, False)
        TDataStd_Name.Set_s(lbl, TCollection_ExtendedString(name))
        tr = gp_Trsf()
        tr.SetTranslation(gp_Vec(*t))
        st.AddComponent(asm, lbl, TopLoc_Location(tr))
    st.UpdateAssemblies()
    w = STEPCAFControl_Writer()
    w.SetNameMode(True)
    assert w.Transfer(doc, STEPControl_AsIs)
    w.Write(str(path))


def T(tx, ty, tz):
    return [1, 0, 0, tx, 0, 1, 0, ty, 0, 0, 1, tz, 0, 0, 0, 1]


def build_package(step_bytes, bogus_hole=True, sha=True):
    man = {'schema': 'forge-package/1', 'generator': {'name': 'test-exporter', 'version': '0'}, 'source': {'cad': 'SolidWorks', 'version': '2024', 'file': 'FIXTURE ASM.SLDASM', 'kind': 'assembly'},
           'created': '2026-10-09T00:00:00Z', 'units': 'mm', 'model': {'path': 'model.step', 'format': 'step-ap214', 'sha256': hashlib.sha256(step_bytes).hexdigest() if sha else 'f' * 64}, 'root': 'fixture-asm'}
    holes = [
        {'id': 'h1', 'feature': 'M5 Tapped Hole1', 'kind': 'tap', 'standard': 'ISO', 'fastener': 'M5', 'thread': 'M5x0.8', 'thread_class': '6H', 'thread_depth': 6.0, 'thread_through': False,
         'diameter': 4.2, 'depth': 8.0, 'through': False, 'point': [15, 15, 10], 'direction': [0, 0, -1]},
        {'id': 'h2', 'feature': 'M5 Tapped Hole1', 'kind': 'tap', 'standard': 'ISO', 'fastener': 'M5', 'thread': 'M5 X 0.8', 'thread_depth': 6.0,
         'diameter': 4.2, 'depth': 8.0, 'through': False, 'point': [65, 15, 10], 'direction': [0, 0, -1]},
        {'id': 'h3', 'feature': 'M3 Tapped Hole1', 'kind': 'tap', 'standard': 'ISO', 'fastener': 'M3', 'thread': 'M3', 'thread_through': True,
         'diameter': 2.5, 'depth': 10.0, 'through': True, 'point': [40, 35, 10], 'direction': [0, 0, -1]},
        {'id': 'h4', 'feature': 'M6 Clearance Hole1', 'kind': 'clearance', 'standard': 'ISO', 'fastener': 'M6', 'thread': None,
         'diameter': 6.6, 'depth': 10.0, 'through': True, 'point': [15, 38, 10], 'direction': [0, 0, -1]},
    ]
    if bogus_hole:
        holes.append({'id': 'h9', 'feature': 'M8 Tapped Hole1', 'kind': 'tap', 'thread': 'M8x1.25', 'diameter': 6.8, 'depth': 10, 'through': True, 'point': [70, 40, 10], 'direction': [0, 0, -1]})
    tap = {'id': 'tap-plate', 'name': 'TAP PLATE', 'file': 'TAP PLATE.SLDPRT', 'configuration': 'Default', 'part_number': 'FX-001', 'description': 'Fixture block',
           'material': 'Aluminium 6061', 'density': 2.7, 'mass_kg': 0.1, 'volume_mm3': 40000 - 500, 'bbox': [80, 50, 10], 'bodies': 1, 'holes': holes}
    sheet = {'id': 'sheet-plate', 'name': 'SHEET PLATE', 'file': 'SHEET PLATE.SLDPRT', 'material': 'AISI 304', 'properties': {'Finish': 'Powder coat RAL 9005', 'Vendor': 'in-house'},
             'sheet_metal': {'thickness': 2.0, 'bend_radius': 2.0, 'k_factor': 0.42, 'flat_pattern': True, 'bends': []}, 'holes': [], 'bbox': [100, 60, 2], 'volume_mm3': 11971.7}
    asm = {'name': 'FIXTURE ASM', 'components': [
        {'id': 'c1', 'part': 'tap-plate', 'name': 'TAP PLATE', 'instance': 'TAP PLATE-1', 'path': 'FIXTURE ASM / TAP PLATE-1', 'transform': T(0, 0, 0)},
        {'id': 'c2', 'part': 'sheet-plate', 'name': 'SHEET PLATE', 'instance': 'SHEET PLATE-1', 'path': 'FIXTURE ASM / SHEET PLATE-1', 'transform': T(200, 0, 0)}],
        'fasteners': [{'id': 'f1', 'kind': 'screw', 'standard': 'ISO 4762', 'size': 'M5', 'length': 12, 'name': 'ISO 4762 M5 x 12', 'transform': T(15, 15, 10)},
                      {'id': 'f2', 'kind': 'screw', 'standard': 'ISO 4762', 'size': 'M5', 'length': 12, 'name': 'ISO 4762 M5 x 12', 'transform': T(65, 15, 10)}],
        'inserts': [{'id': 'i1', 'type': 'nut', 'thread': 'M4', 'pn': 'S-M4-1', 'name': 'PEM S-M4-1', 'host': 'sheet-plate', 'transform': T(220, 20, 2), 'axis': [0, 0, 1]},
                    {'id': 'i2', 'type': 'rivnut', 'thread': 'M6', 'name': 'Rivnut M6', 'transform': T(900, 900, 0), 'axis': [0, 0, 1]}]}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('manifest.json', json.dumps(man))
        z.writestr('model.step', step_bytes)
        z.writestr('parts/tap-plate.json', json.dumps(tap))
        z.writestr('parts/sheet-plate.json', json.dumps(sheet))
        z.writestr('assembly.json', json.dumps(asm))
        z.writestr('previews/tap-plate.png', b'\x89PNG\r\n\x1a\n' + b'\0' * 40)
        z.writestr('../evil.txt', 'ignored')
        z.writestr('notes/readme.txt', 'ignored')
    return buf.getvalue()


@pytest.fixture
def step_bytes(tmp_path):
    p = tmp_path / 'fixture.step'
    write_assembly_step(p, [('TAP PLATE', tap_plate(), (0, 0, 0)), ('SHEET PLATE', plate(), (200, 0, 0))])
    leaves = import_model(p)
    assert sorted(l['name'] for l in leaves) == ['SHEET PLATE', 'TAP PLATE']
    return p.read_bytes()


def test_thread_normalisation_and_catalogue_taps():
    assert package.normalize_thread('M5x0.8') == ('M5×0.8', 5, .8)
    assert package.normalize_thread('M5 X 0.8-6H') == ('M5×0.8', 5, .8)
    assert package.normalize_thread('M3') == ('M3×0.5', 3, .5)
    assert package.normalize_thread('#10-32') == ('#10-32', None, None)
    assert package.normalize_thread('1/4-20 UNC-2B') == ('1/4-20', None, None)
    assert package.tap_item({'thread': 'M5x0.8', 'diameter': 4.2})['id'] == 'tap-M5x0.8'
    assert package.tap_item({'thread': '#10-32', 'diameter': 4.04})['id'] == 'tap-#10-32'
    c = package.tap_item({'thread': 'M14x2', 'diameter': 12})
    assert c['custom'] and c['hole'] == 12 and c['thread'] == 'M14×2'
    assert package.insert_item({'type': 'nut', 'thread': 'M4', 'pn': 'S-M4-1'})['id'] == 'nut-M4'
    assert package.insert_item({'type': 'rivnut', 'thread': 'M6'})['id'] == 'rivnut-M6'
    assert package.insert_item({'type': 'flush_nut', 'thread': 'M12', 'name': 'Odd nut'})['custom']


def test_package_validation_rejects_bad_members(tmp_path, step_bytes):
    good = build_package(step_bytes)
    folder = tmp_path / 'rev'
    folder.mkdir()
    pkg = package.unpack(_write(tmp_path / 'g.forge', good), folder, 10 ** 9)
    assert set(pkg['parts']) == {'tap-plate', 'sheet-plate'} and pkg['previews'] == 1 and (folder / 'source.step').stat().st_size == len(step_bytes)
    assert not list(folder.glob('**/evil.txt'))
    with pytest.raises(package.PackageError, match='not a ZIP'):
        package.unpack(_write(tmp_path / 'bad.forge', b'not a zip at all' * 10), folder, 10 ** 9)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr('manifest.json', json.dumps({'schema': 'forge-package/2', 'model': {'path': 'model.step'}}))
        z.writestr('model.step', step_bytes)
    with pytest.raises(package.PackageError, match='schema'):
        package.unpack(_write(tmp_path / 'v2.forge', buf.getvalue()), folder, 10 ** 9)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr('manifest.json', json.dumps({'schema': 'forge-package/1', 'model': {'path': 'model.step'}}))
        z.writestr('model.step', step_bytes)
        z.writestr('parts/x.json', json.dumps({'id': 'x', 'name': 'X', 'holes': [{'id': 'h', 'kind': 'tap', 'diameter': 4.2, 'point': [0, 0, 0], 'direction': [0, 0, 1]}]}))
    with pytest.raises(package.PackageError, match='thread designation'):
        package.unpack(_write(tmp_path / 'nothread.forge', buf.getvalue()), folder, 10 ** 9)
    with pytest.raises(package.PackageError, match='upload limit'):
        package.unpack(_write(tmp_path / 'big.forge', good), folder, 100)
    pkg = package.unpack(_write(tmp_path / 'nosha.forge', build_package(step_bytes, sha=False)), folder, 10 ** 9)
    assert any('checksum' in w for w in pkg['warnings'])


def _write(path, data):
    path.write_bytes(data)
    return path


def test_package_import_applies_cad_features(tmp_path, monkeypatch, step_bytes):
    (tmp_path / 'data').mkdir()
    monkeypatch.setattr(db, 'ROOT', tmp_path / 'data')
    with TestClient(app) as client:
        h = {'X-Forge-Request': '1'}
        assert client.post('/api/auth/setup', json={'email': 'test@example.com', 'name': 'Test Engineer', 'password': 'fixture-password-123'}).status_code == 200
        assert client.post('/api/auth/login', json={'email': 'test@example.com', 'password': 'fixture-password-123'}).status_code == 200
        assert '.forge' in client.get('/api/config').json()['formats']
        pid = client.post('/api/projects', headers=h, json={'name': 'Package fixture'}).json()['id']
        data = build_package(step_bytes)
        r = client.post(f'/api/projects/{pid}/revisions', headers=h, files={'file': ('FIXTURE ASM.forge', data)}).json()
        assert r['number'] == 1 and r['filename'] == 'FIXTURE ASM.forge'
        assert run_once()
        rev = client.get('/api/revisions/' + r['id']).json()
        assert rev['status'] == 'ready', rev
        pk = rev['manifest']['package']
        assert pk['parts'] == 2 and pk['matched_parts'] == 2 and pk['unmatched_parts'] == []
        assert pk['holes']['threaded'] == 4 and pk['holes']['applied'] == 3 and pk['holes']['kept'] == 0
        assert [u['feature'] for u in pk['holes']['unmatched']] == ['M8 Tapped Hole1']
        assert pk['inserts']['total'] == 2 and pk['inserts']['applied'] == 1 and pk['inserts']['unmatched'][0]['name'] == 'Rivnut M6'
        assert pk['fasteners']['total'] == 2 and pk['fasteners']['by_name'] == {'ISO 4762 M5 x 12': 2}
        assert pk['k_factors'] == 1 and pk['materials'] == 2 and 'Threads not defined as CAD features' in rev['manifest']['unsupported']
        parts = {p['name']: p for p in rev['parts']}
        tap, sheet = parts['TAP PLATE'], parts['SHEET PLATE']
        assert tap['category'] == 'machining' and sheet['category'] == 'sheet_metal'
        # taps on the right bores, catalogue items, blind depth and through flags from the CAD feature
        hw = {hid: fs['hardware'] for hid, fs in tap['spec']['feature_specs'].items()}
        holes = {x['id']: x for x in tap['geometry']['holes']}
        assert len(hw) == 3 and all(v['source'] == 'cad' and v['type'] == 'tap' for v in hw.values())
        m5 = [hid for hid, v in hw.items() if v['id'] == 'tap-M5x0.8']
        m3 = [hid for hid, v in hw.items() if v['id'] == 'tap-M3x0.5']
        assert len(m5) == 2 and len(m3) == 1
        assert all(abs(holes[hid]['diameter'] - 4.2) < 1e-6 and hw[hid]['thread_depth'] == 6 and not hw[hid]['thread_through'] for hid in m5)
        assert abs(holes[m3[0]]['diameter'] - 2.5) < 1e-6 and hw[m3[0]]['thread_through'] and 'thread_depth' not in hw[m3[0]]
        assert tap['spec']['feature_specs'][m5[0]]['designation'] == 'M5 X 0.8 - 6H'
        assert not any(abs(holes[hid]['diameter'] - 6.6) < 1e-6 for hid in hw)  # clearance hole untouched
        assert tap['spec']['material'] == 'Aluminium 6061' and tap['geometry']['cad']['part_number'] == 'FX-001'
        assert any('3 tapped holes from the CAD features' in n for n in tap['geometry']['recognition_notes'])
        # sheet metal: K-factor, material, finish, insert on the hole the component sits in
        assert sheet['spec']['k_factor'] == 0.42 and not sheet['spec']['k_factor_approved']
        assert sheet['spec']['material'] == 'AISI 304' and sheet['spec']['finish'] == 'Powder coat RAL 9005'
        ins = sheet['spec']['feature_specs']['H001']['hardware']
        assert ins['id'] == 'nut-M4' and ins['source'] == 'cad' and ins['side'] == 1 and ins['kind'] == 'insert'
        assert 'INSERT S-M4-1 SELF-CLINCHING NUT' == sheet['spec']['feature_specs']['H001']['designation']
        # the stored package is rebuilt from the sanitized STEP
        folder = db.revdir(r['id'])
        assert (folder / 'source.forge').exists() and (folder / 'package' / 'parts' / 'tap-plate.json').exists() and (folder / 'package' / 'previews' / 'tap-plate.png').exists()
        with zipfile.ZipFile(folder / 'source.forge') as z:
            man = json.loads(z.read('manifest.json'))
            assert man['sanitized'] and man['model']['sha256'] == hashlib.sha256(z.read('model.step')).hexdigest() == rev['sha256']
        audit = [a for a in client.get(f'/api/revisions/{r["id"]}/audit').json() if a['action'] == 'revision.package.applied']
        assert len(audit) == 1 and json.loads(audit[0]['detail'])['holes']['applied'] == 3
        # the engineer overrides one CAD tap; a re-import of the same package keeps that choice
        assert client.put(f'/api/parts/{tap["id"]}/hardware', headers=h, json={'holes': [m5[0]], 'custom': {'type': 'tap', 'name': 'M5 helicoil', 'thread': 'M5', 'hole': 5.2}}).status_code == 200
        r2 = client.post(f'/api/projects/{pid}/revisions', headers=h, files={'file': ('FIXTURE ASM.forge', data)}).json()
        assert run_once()
        rev2 = client.get('/api/revisions/' + r2['id']).json()
        assert rev2['status'] == 'ready', rev2
        assert rev2['manifest']['package']['holes']['applied'] == 2 and rev2['manifest']['package']['holes']['kept'] == 1
        tap2 = next(p for p in rev2['parts'] if p['name'] == 'TAP PLATE')
        kept = tap2['spec']['feature_specs'][m5[0]]['hardware']
        assert kept['name'] == 'M5 helicoil' and kept.get('source') != 'cad'
        # a package cannot replace a single part; a broken package fails the revision with a readable message
        assert client.post(f'/api/projects/{pid}/uploads', headers=h, json={'filename': 'x.forge', 'size': 1000, 'part_id': tap2['id']}).status_code == 422
        bad = client.post(f'/api/projects/{pid}/revisions', headers=h, files={'file': ('bad.forge', b'definitely not a zip ' * 10)}).json()
        assert run_once()
        failed = client.get('/api/revisions/' + bad['id']).json()
        assert failed['status'] == 'failed' and 'Not a Forge package' in (failed.get('message') or '')
        assert client.get('/api/revisions/' + r2['id']).json()['state'] == 'active'


def test_tap_callout_carries_cad_thread_depth():
    from app.sheet import callout_lines, DEPTH
    from app.hardware import BY_ID, designation
    item = dict(BY_ID['tap-M5x0.8'])
    hw = {**item, 'side': 1, 'axis': [0, 0, 1], 'source': 'cad', 'thread_depth': 6.0, 'thread_through': False}
    spec = {'feature_specs': {'H001': {'hardware': hw, 'designation': designation(hw)}}}
    blind = {'dia': 4.2, 'depth': 8.0, 'through': False, 'ids': ['H001'], 'mouth': None}
    lines, inferred = callout_lines([blind], spec)
    assert lines[1] == f'M5 X 0.8 - 6H {DEPTH} 6.00' and not inferred
    thru = {'dia': 4.2, 'depth': 10.0, 'through': True, 'ids': ['H001'], 'mouth': None}
    assert callout_lines([thru], spec)[0][1] == 'M5 X 0.8 - 6H THRU'
    hw2 = {**item, 'thread_class': '6G'}
    assert designation(hw2) == 'M5 X 0.8 - 6G'
    assert designation({**BY_ID['tap-#10-32'], 'thread_class': '3B'}) == '#10-32 UNF-3B'
