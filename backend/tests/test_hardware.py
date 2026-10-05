import copy, json, math
import numpy as np
from fastapi.testclient import TestClient
from app import db
from app.cad import analyze, BRepTools
from app.main import app
from app.security import token_hash
from app.hardware import CATALOG, BY_ID, designation
from test_geometry import plate


def test_catalogue_is_consistent():
    ids = [i['id'] for i in CATALOG]
    assert len(ids) == len(set(ids))
    for i in CATALOG:
        assert i['type'] in ('nut', 'flush_nut', 'stud', 'standoff', 'rivnut', 'tap', 'countersink')
        assert i['hole'] is None or 0.5 < i['hole'] < 30
        if i['type'] == 'tap' and i['units'] == 'metric':
            nominal = float(i['thread'].split('×')[0][1:])
            assert i['hole'] < nominal, i  # tap drill is under the thread size
        if i['type'] == 'countersink':
            assert i['csk'] > i['hole']
    assert BY_ID['tap-M5x0.8']['hole'] == 4.2 and designation(BY_ID['tap-M5x0.8']) == 'M5 X 0.8 - 6H'
    assert BY_ID['nut-M3']['hole'] == 4.22 and 'S-M3-1' in designation(BY_ID['nut-M3'])
    assert BY_ID['flush-M3']['hole'] is None  # never guessed: per supplier datasheet


def _fixture(tmp_path, client):
    rid, pid, project, user, token = 'hwrev', 'hwpart', 'hwproject', 'hwuser', 'hw-session'
    with db.connect() as c:
        c.execute('INSERT INTO users(id,email,name,password,role,created) VALUES(?,?,?,?,?,?)', (user, 'e@example.test', 'Fixture', 'unused', 'engineer', db.now()))
        c.execute('INSERT INTO sessions VALUES(?,?,?)', (token_hash(token), user, '2099-01-01'))
        c.execute('INSERT INTO projects(id,name,description,created,rules) VALUES(?,?,?,?,?)', (project, 'fixture', '', db.now(), json.dumps(db.DEFAULT_RULES)))
        c.execute('INSERT INTO revisions(id,project_id,number,filename,sha256,state,status,created,created_by) VALUES(?,?,?,?,?,?,?,?,?)', (rid, project, 1, 'f.step', 's', 'active', 'ready', db.now(), 'f'))
    shape = plate()
    g = analyze(shape, 'plate')
    g['category'] = 'sheet_metal'
    folder = db.revdir(rid) / 'parts' / pid
    folder.mkdir(parents=True)
    BRepTools.Write_s(shape, str(folder / 'shape.brep'))
    with db.connect() as c:
        c.execute('INSERT INTO parts(id,revision_id,name,category,quantity,geometry,spec) VALUES(?,?,?,?,?,?,?)', (pid, rid, 'Plate', 'sheet_metal', 1, json.dumps(g), json.dumps(copy.deepcopy(db.DEFAULT_SPEC))))
    client.cookies.set('forge_session', token)
    return rid, pid, shape, g


def test_hole_hardware_api_flat_and_callout(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    with TestClient(app) as client:
        rid, pid, shape, g = _fixture(tmp_path, client)
        H = {'X-Forge-Request': '1'}
        url = f'/api/parts/{pid}/hardware'
        assert client.get('/api/hardware-catalog').json()['items']
        assert client.put(url, json={'holes': ['H001'], 'item': 'nut-M3'}).status_code == 403  # CSRF header required
        assert client.put(url, headers=H, json={'holes': ['H404'], 'item': 'nut-M3'}).status_code == 422
        assert client.put(url, headers=H, json={'holes': ['H001'], 'item': 'no-such'}).status_code == 422
        assert client.put(url, headers=H, json={'holes': ['H001'], 'custom': {'type': 'stud', 'name': ''}}).status_code == 422
        r = client.put(url, headers=H, json={'holes': ['H001'], 'item': 'nut-M3', 'side': -1})
        assert r.status_code == 200, r.text
        fs = r.json()['feature_specs']['H001']
        assert fs['hardware']['id'] == 'nut-M3' and fs['hardware']['side'] == -1 and 'S-M3-1' in fs['designation']
        # flip only keeps the hardware
        fs = client.put(url, headers=H, json={'holes': ['H001'], 'side': 1}).json()['feature_specs']['H001']
        assert fs['hardware']['id'] == 'nut-M3' and fs['hardware']['side'] == 1
        p = db.row('SELECT * FROM parts WHERE id=?', (pid,))
        spec = json.loads(p['spec'])

        # flat pattern: the Ø6 hole is cut at the nut's Ø4.22 mounting hole
        from app.unfold import unfold
        from app.worker import hardware_holes
        poly, _ = unfold(shape, g, .4)
        out, changes = hardware_holes(poly, g, spec)
        assert len(changes) == 1 and changes[0]['to'] == 4.22 and np.allclose(changes[0]['center'], [20, 20], atol=.05)
        d = 2 * math.sqrt(out.interiors[0].convex_hull.area / math.pi)
        assert abs(d - 4.22) < .02

        # drawing: callout gives the hole to cut, the insert and the side
        from app import sheet
        part = {'id': pid, 'name': 'Plate', 'category': 'sheet_metal', 'geometry': g, 'spec': spec, 'quantity': 1}
        sheets = sheet.build_sheets(shape, part, {'number': 1}, {})
        lines = [m['lines'] for sh in sheets for m in sh.callouts.values()]
        assert any(l[0] == 'Ø 4.22 THRU' and l[1].startswith('INSERT S-M3-1') and l[1].endswith('SIDE') for l in lines), lines

        # remove
        r = client.put(url, headers=H, json={'holes': ['H001'], 'item': None})
        assert 'H001' not in r.json()['feature_specs']


def test_weld_ranges_tacks_on_seams_and_ground(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    with TestClient(app) as client:
        rid, pid, shape, g = _fixture(tmp_path, client)
        H = {'X-Forge-Request': '1'}
        seam = {'part': pid, 'occurrence': 0, 'selection': 'edge', 'index': 3, 'type': 'line', 'length': 100.0,
                'boundaries': [[[0, 0, 0], [100, 0, 0]]], 'joint': 'fillet', 'other_part': pid, 'other_occurrence': 0}
        def post(faces, weld):
            return client.post(f'/api/revisions/{rid}/joints', headers=H, json={'kind': 'weld', 'parts': [pid], 'faces': faces, 'weld': weld})
        base = {'process': 'MIG/MAG (135)', 'size': '3'}
        r = post([{**seam, 'range': [10, 35]}], {**base, 'type': 'linear', 'ground': True, 'pattern': 'manual'})
        assert r.status_code == 200, r.text
        j = client.get(f'/api/revisions/{rid}/joints').json()[0]['data']
        assert j['faces'][0]['range'] == [10.0, 35.0] and j['weld']['ground'] is True and j['weld']['pattern'] == 'manual'
        # a tack on the seam needs no face pair / placement
        assert post([{**seam, 'range': [50, 50]}], {**base, 'type': 'tack', 'pattern': 'single'}).status_code == 200
        # tack row along the whole seam
        assert post([{**seam, 'range': [0, 100]}], {**base, 'type': 'tack', 'pitch': '40', 'pattern': 'full'}).status_code == 200
        # ranges must lie on the seam
        assert post([{**seam, 'range': [60, 30]}], {**base, 'type': 'linear'}).status_code == 422
        assert post([{**seam, 'range': [0, 180]}], {**base, 'type': 'linear'}).status_code == 422
        # a tack with neither a seam position nor a face pair is still refused
        assert post([seam], {**base, 'type': 'tack'}).status_code == 422


def test_bulk_production_ready(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    with TestClient(app) as client:
        rid, pid, shape, g = _fixture(tmp_path, client)
        g['flat_status'] = 'supported'
        with db.connect() as c:
            c.execute("UPDATE users SET role='admin'")
            c.execute('UPDATE parts SET geometry=? WHERE id=?', (json.dumps(g), pid))
        H = {'X-Forge-Request': '1'}
        url = f'/api/revisions/{rid}/parts/bulk-ready'
        # design sign-off is refused while blockers are open
        r = client.post(url, headers=H, json={'ids': [pid], 'design_review': True}).json()['results'][0]
        assert not r['design'] and any('Material' in x for x in r['open'])
        checks = {k: 'Verified for this bracket family' for k in ('load_strength', 'functional_gdt', 'threads', 'process_tooling', 'assembly', 'coating')}
        fill = {'material': 'Aluminium 5052-H32', 'process': 'Laser cutting', 'finish': 'Natural', 'general_tolerance': 'ISO 2768-mK', 'datums': 'A = bottom face'}
        assert client.post(url, headers=H, json={'ids': [pid], 'manual_checks': {'threads': 'short'}}).status_code == 422
        r = client.post(url, headers=H, json={'ids': [pid], 'fill': fill, 'manual_checks': checks, 'waive_warnings': 'Accepted for this design family', 'design_review': True, 'drawing_review': True}).json()['results'][0]
        assert r['design'] and r['drawing'] == 'regenerate' and not [x for x in r['open'] if not x.endswith('(warning)')], r['open']
        p = db.row('SELECT spec,reviewed FROM parts WHERE id=?', (pid,))
        spec = json.loads(p['spec'])
        assert p['reviewed'] == 1 and spec['material'] == 'Aluminium 5052-H32' and spec['manual_checks']['threads'].startswith('Verified')
        # existing values are kept unless overwrite is asked for
        client.post(url, headers=H, json={'ids': [pid], 'fill': {'material': 'Steel'}})
        assert json.loads(db.row('SELECT spec FROM parts WHERE id=?', (pid,))['spec'])['material'] == 'Aluminium 5052-H32'
        # a drawing that is current can be signed off in bulk
        folder = db.revdir(rid) / 'parts' / pid
        (folder / 'drawing-scene.json').write_text('{}')
        (folder / '.drawing-invalid').unlink(missing_ok=True)   # as after regeneration
        r = client.post(url, headers=H, json={'ids': [pid], 'drawing_review': True}).json()['results'][0]
        assert r['drawing'] == 'reviewed' and r['ready']


def test_welding_document(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    with TestClient(app) as client:
        rid, pid, shape, g = _fixture(tmp_path, client)
        H = {'X-Forge-Request': '1'}
        assert client.get(f'/api/revisions/{rid}/welding').json()['state'] == 'no-welds'
        seam = {'part': pid, 'occurrence': 0, 'selection': 'edge', 'index': 3, 'type': 'line', 'length': 100.0,
                'boundaries': [[[0, 0, 0], [100, 0, 0]]], 'joint': 'fillet', 'other_part': pid, 'other_occurrence': 0}
        base = {'process': 'MIG/MAG (135)', 'size': '3'}
        client.post(f'/api/revisions/{rid}/joints', headers=H, json={'kind': 'weld', 'parts': [pid], 'faces': [{**seam, 'range': [0, 100]}], 'weld': {**base, 'type': 'stitch', 'length': '20', 'pitch': '40', 'pattern': 'full', 'ground': True}})
        from app.welding import weld_rows
        r = weld_rows(rid)[0]
        assert r['symbol'] == 'a3 fillet 3 × 20 (40)' and r['weld_length'] == 60 and r['seam'] == 100 and r['ground']
        assert client.get(f'/api/revisions/{rid}/welding').json()['state'] == 'missing'
        assert client.post(f'/api/revisions/{rid}/welding', headers=H).json()['state'] == 'generating'
        assert client.get(f'/api/revisions/{rid}/welding.pdf').status_code == 409
        from app import worker
        assert worker.run_once()
        assert client.get(f'/api/revisions/{rid}/welding').json()['state'] == 'ready'
        pdf = client.get(f'/api/revisions/{rid}/welding.pdf')
        assert pdf.status_code == 200 and pdf.content[:4] == b'%PDF'
        # older welds stored free text sizes: still documented
        from app.welding import num
        assert num('50 mm') == 50 and num('3,5') == 3.5 and num(None, 7) == 7
        from pypdf import PdfReader
        import io
        assert 'W1' in PdfReader(io.BytesIO(pdf.content)).pages[0].extract_text()
