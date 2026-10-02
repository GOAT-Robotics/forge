import copy, json
from fastapi.testclient import TestClient
from app.cad import analyze, BRepTools
from app.drawings import make_part
from app import db, inspection
from app.main import app
from app.security import token_hash
from test_drawing_editor import chamfered


def test_requirements_and_general_tolerances():
    s = {'drawing': {'tol_2dec': '± 0.05', 'hole_fit': 'H7', 'shaft_fit': 'h7', 'position_tol': '±0.02 mm'}}
    q = inspection.requirements('2 x Ø 10.00 THRU', 'note')
    assert [x['label'] for x in q] == ['Hole Ø', 'Through'] and q[0]['qty'] == 2
    assert inspection.general_tolerance(q[0], s)[:2] == (0.0, 0.015)          # H7 for 10 mm
    shaft = inspection.requirements('Ø 26.00', 'note', 'shaft')[0]
    assert inspection.general_tolerance(shaft, s)[:2] == (-0.021, 0.0)        # h7 for 26 mm
    pos = inspection.requirements('123.45', 'ordinate', 'hole')[0]
    assert pos['type'] == 'position' and inspection.general_tolerance(pos, s)[:2] == (-0.02, 0.02)
    assert inspection.requirements('0', 'ordinate', 'edge') == []
    assert inspection.general_tolerance(inspection.requirements('30°', 'angle')[0], s)[:2] == (-.5, .5)
    assert inspection.evaluate({'nominal': 10, 'lower': 10, 'upper': 10.015, 'unit': 'mm'}, 10.01) == 'PASS'
    assert inspection.evaluate({'nominal': 10, 'lower': 10, 'upper': 10.015, 'unit': 'mm'}, 10.02) == 'FAIL'
    assert inspection.evaluate({'nominal': None, 'unit': 'attr'}, attr='PASS') == 'PASS'


def test_balloons_plan_record_report_and_disposition(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    with TestClient(app) as client:
        rid, pid, project, user, token = 'insprev', 'insppart', 'inspproject', 'inspuser', 'inspection-session'
        with db.connect() as c:
            c.execute('INSERT INTO users(id,email,name,password,role,created) VALUES(?,?,?,?,?,?)', (user, 'qc@example.test', 'Fixture QC', 'unused', 'engineer', db.now()))
            c.execute('INSERT INTO sessions VALUES(?,?,?)', (token_hash(token), user, '2099-01-01'))
            c.execute('INSERT INTO projects(id,name,description,created,rules) VALUES(?,?,?,?,?)', (project, 'fixture', '', db.now(), json.dumps(db.DEFAULT_RULES)))
            c.execute('INSERT INTO revisions(id,project_id,number,filename,sha256,state,status,created,created_by) VALUES(?,?,?,?,?,?,?,?,?)', (rid, project, 1, 'f.step', 'source', 'active', 'ready', db.now(), 'fixture'))
        shape = chamfered(True)
        g = analyze(shape, 'block')
        g['category'] = 'machining'
        spec = copy.deepcopy(db.DEFAULT_SPEC)
        part = {'id': pid, 'name': 'Fixture block', 'category': 'machining', 'geometry': g, 'spec': spec, 'quantity': 4}
        folder = db.revdir(rid) / 'parts' / pid
        folder.mkdir(parents=True)
        BRepTools.Write_s(shape, str(folder / 'shape.brep'))
        make_part(part, {'id': rid, 'number': 1, 'sha256': 'source', 'status': 'ready'}, folder, {})
        with db.connect() as c:
            c.execute('INSERT INTO parts(id,revision_id,name,category,quantity,geometry,spec) VALUES(?,?,?,?,?,?,?)', (pid, rid, part['name'], 'machining', 4, json.dumps(g), json.dumps(spec)))
        client.cookies.set('forge_session', token)
        h = {'X-Forge-Request': '1'}
        data = client.get(f'/api/parts/{pid}/characteristics').json()
        assert data['editable'] and data['chars']
        # nothing is ballooned until the engineer chooses what to inspect
        assert not inspection.flat_list(data['chars']) and all(c['number'] is None for c in data['chars'])
        every = inspection.flat_list(data['chars'], True)
        assert client.put(f'/api/parts/{pid}/characteristics', json={'keys': [q['key'] for q in every], 'inspect': True}, headers=h).status_code == 200
        data = client.get(f'/api/parts/{pid}/characteristics').json()
        flat = inspection.flat_list(data['chars'])
        assert len(flat) == len(every)
        numbers = [c['number'] for c in data['chars']]
        assert numbers == list(range(1, len(numbers) + 1))
        # unselect one line: the remaining balloons renumber without a gap, it cannot be recorded
        first = data['chars'][0]
        assert client.put(f'/api/parts/{pid}/characteristics', json={'keys': [q['key'] for q in first['reqs']], 'inspect': False}, headers=h).status_code == 200
        again = client.get(f'/api/parts/{pid}/characteristics').json()['chars']
        assert again[0]['number'] is None and [c['number'] for c in again if c['selected']] == list(range(1, len(numbers)))
        dropped = first['reqs'][0]
        assert client.post(f'/api/revisions/{rid}/measurements', json={'part_id': pid, 'serial': 'Z', 'entries': [{'key': dropped['key'], 'value': 1, 'attr': 'PASS'}]}, headers=h).status_code == 422
        assert client.put(f'/api/parts/{pid}/characteristics', json={'keys': [q['key'] for q in first['reqs']], 'inspect': True}, headers=h).status_code == 200
        assert all(q['zone'] and q['zone'][0] in 'ABCDEFGH' for q in flat)
        hole = next(q for q in flat if q['label'] == 'Hole Ø')
        length = next(q for q in flat if q['nominal'] is not None and q['key'] != hole['key'])
        # plan: critical flag + specified limits (nominal must lie inside)
        assert client.put(f"/api/parts/{pid}/characteristics/{hole['key']}", json={'critical': True}, headers=h).status_code == 200
        bad = client.put(f"/api/parts/{pid}/characteristics/{length['key']}", json={'lower': length['nominal'] + 1, 'upper': length['nominal'] + 2}, headers=h)
        assert bad.status_code == 422
        assert client.put(f"/api/parts/{pid}/characteristics/{length['key']}", json={'lower': length['nominal'] - .1, 'upper': length['nominal'] + .1}, headers=h).status_code == 200
        assert client.put(f"/api/parts/{pid}/balloons/{data['chars'][0]['id']}", json={'dx': 12, 'dy': -4}, headers=h).status_code == 200
        merged = {q['key']: q for q in inspection.flat_list(client.get(f'/api/parts/{pid}/characteristics').json()['chars'])}
        assert merged[hole['key']]['critical'] and merged[length['key']]['basis'] == 'specified'
        pdf = client.get(f'/api/parts/{pid}/inspection.pdf')
        assert pdf.status_code == 200 and pdf.content[:4] == b'%PDF'
        from pypdf import PdfReader
        import io
        text = '\n'.join(pg.extract_text() for pg in PdfReader(io.BytesIO(pdf.content)).pages)
        assert 'INSPECTION CHARACTERISTICS' in text and 'KC' in text
        assert 'Hole' in client.get(f'/api/parts/{pid}/characteristics.csv').text
        # first article: every characteristic; one hole out of tolerance
        entries = []
        for q in merged.values():
            if q['nominal'] is None:
                entries.append({'key': q['key'], 'attr': 'PASS'})
            else:
                entries.append({'key': q['key'], 'value': q['nominal'] + (.5 if q['key'] == hole['key'] else 0)})
        r = client.post(f'/api/revisions/{rid}/measurements', json={'part_id': pid, 'serial': 'SN-001', 'first_article': True, 'instrument': 'CMM-1', 'entries': entries}, headers=h)
        assert r.status_code == 200, r.text
        assert r.json()['nonconforming'] == 1
        # production serial: critical only
        r = client.post(f'/api/revisions/{rid}/measurements', json={'part_id': pid, 'serial': 'SN-002', 'entries': [{'key': hole['key'], 'value': hole['nominal'] + .005}]}, headers=h)
        assert r.json()['nonconforming'] == 0
        summary = client.get(f'/api/parts/{pid}/measurements').json()['summary']
        by = {s['serial']: s for s in summary['serials']}
        assert by['SN-001']['first_article'] and by['SN-001']['status'] == 'nonconforming' and by['SN-001']['open_ncr'] == 1
        assert by['SN-002']['status'] == 'complete' and by['SN-002']['required'] == 1
        assert summary['fai'] == 'nonconforming'
        fail = next(m for m in client.get(f'/api/parts/{pid}/measurements').json()['latest'] if m['result'] == 'FAIL')
        assert client.post(f"/api/measurements/{fail['id']}/disposition", json={'disposition': 'keep', 'note': 'nope nope'}, headers=h).status_code == 422
        assert client.post(f"/api/measurements/{fail['id']}/disposition", json={'disposition': 'rework', 'note': 'Ream to size'}, headers=h).status_code == 200
        assert client.get(f'/api/parts/{pid}/measurements').json()['summary']['open_ncr'] == 0
        rep = client.get(f'/api/parts/{pid}/report.pdf', params={'serial': 'SN-001'})
        rtext = '\n'.join(pg.extract_text() for pg in PdfReader(io.BytesIO(rep.content)).pages)
        assert 'FIRST ARTICLE INSPECTION REPORT' in rtext and 'NONCONFORMING' in rtext and 'rework' in rtext
        assert 'SN-002' in client.get(f'/api/revisions/{rid}/measurements.csv').text
        rows = client.get(f'/api/revisions/{rid}/inspection').json()
        assert rows[0]['critical'] == 1 and len(rows[0]['serials']) == 2
        # vendors read only; viewers cannot record
        with db.connect() as c:
            c.execute('INSERT INTO shares(id,revision_id,hash,label,expires,revoked,created) VALUES(?,?,?,?,?,?,?)', ('v', rid, token_hash('vend'), 'Vendor', '2099-01-01', 0, db.now()))
        vh = {'Authorization': 'Bearer vend', 'X-Forge-Request': '1'}
        assert not client.get(f'/api/parts/{pid}/characteristics', headers=vh).json()['editable']
        assert client.post(f'/api/revisions/{rid}/measurements', json={'part_id': pid, 'serial': 'X', 'entries': entries[:1]}, headers=vh).status_code == 403
        with db.connect() as c:
            c.execute('UPDATE users SET role="viewer" WHERE id=?', (user,))
        assert client.post(f'/api/revisions/{rid}/measurements', json={'part_id': pid, 'serial': 'X', 'entries': entries[:1]}, headers=h).status_code == 403
