import json
from fastapi.testclient import TestClient
from app import db
from app.cad import analyze, BRepTools
from app.main import app
from app.security import token_hash
from test_geometry import plate, bent


def _fixture(client):
    rid, project, user, token = 'asrev', 'asproject', 'asuser', 'as-session'
    with db.connect() as c:
        c.execute('INSERT INTO users(id,email,name,password,role,created) VALUES(?,?,?,?,?,?)', (user, 'e@example.test', 'Fixture', 'unused', 'engineer', db.now()))
        c.execute('INSERT INTO sessions VALUES(?,?,?)', (token_hash(token), user, '2099-01-01'))
        c.execute('INSERT INTO projects(id,name,description,created,rules) VALUES(?,?,?,?,?)', (project, 'fixture', '', db.now(), json.dumps(db.DEFAULT_RULES)))
        c.execute('INSERT INTO revisions(id,project_id,number,filename,sha256,state,status,created,created_by) VALUES(?,?,?,?,?,?,?,?,?)', (rid, project, 1, 'f.step', 's', 'active', 'ready', db.now(), 'f'))
    for pid, shape, qty in (('base', plate(), 1), ('bracket', bent(), 2)):
        g = analyze(shape, pid)
        folder = db.revdir(rid) / 'parts' / pid
        folder.mkdir(parents=True)
        BRepTools.Write_s(shape, str(folder / 'shape.brep'))
        with db.connect() as c:
            c.execute('INSERT INTO parts(id,revision_id,name,category,quantity,geometry,spec) VALUES(?,?,?,?,?,?,?)', (pid, rid, pid.title(), g['category'], qty, json.dumps(g), json.dumps(db.DEFAULT_SPEC)))
    (db.revdir(rid) / 'instances.json').write_text(json.dumps({'base': [{'matrix': [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], 'path': ''}],
                                                               'bracket': [{'matrix': [[1, 0, 0, 40], [0, 1, 0, 0], [0, 0, 1, 2], [0, 0, 0, 1]], 'path': ''},
                                                                           {'matrix': [[1, 0, 0, 80], [0, 1, 0, 0], [0, 0, 1, 2], [0, 0, 0, 1]], 'path': ''}]}))
    client.cookies.set('forge_session', token)
    return rid


def test_assembly_steps_crud_order_and_instructions(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    with TestClient(app) as client:
        rid = _fixture(client)
        H = {'X-Forge-Request': '1'}
        cfg = client.get('/api/assembly-config').json()
        assert 'screw' in cfg['fasteners'] and 'weld' in cfg['methods']
        url = f'/api/revisions/{rid}/assembly-steps'
        a = client.post(url, headers=H, json={'title': 'Lay the base plate', 'parts': [{'part': 'base', 'occurrences': [0]}], 'notes': 'Burr side down.'})
        assert a.status_code == 200, a.text
        screw = {'kind': 'screw', 'standard': 'ISO 4762', 'size': 'M5', 'length': 12, 'qty': 1, 'torque': '6 N·m', 'threadlock': 'Loctite 243 (medium)',
                 'holes': [{'part': 'base', 'occurrence': 0, 'hole': 'H001'}]}
        b = client.post(url, headers=H, json={'title': 'Fit both brackets', 'method': 'screw', 'parts': [{'part': 'bracket', 'occurrences': [0, 1]}], 'fasteners': [screw], 'tools': '4 mm hex key'})
        assert b.status_code == 200, b.text
        assert b.json()['fasteners'][0]['designation'] == 'ISO 4762 M5×12 Socket head cap screw'
        # validation: unknown standard, missing length, bad hole, occurrence out of range, guessed nothing
        assert client.post(url, headers=H, json={'fasteners': [{**screw, 'standard': 'XYZ'}]}).status_code == 422
        assert client.post(url, headers=H, json={'fasteners': [{**screw, 'length': 0}]}).status_code == 422
        assert client.post(url, headers=H, json={'fasteners': [{**screw, 'holes': [{'part': 'base', 'hole': 'H404'}]}]}).status_code == 422
        assert client.post(url, headers=H, json={'parts': [{'part': 'bracket', 'occurrences': [2]}]}).status_code == 422
        assert client.post(url, json={'title': 'x'}).status_code == 403  # CSRF header required
        steps = client.get(url).json()
        assert [s['title'] for s in steps] == ['Lay the base plate', 'Fit both brackets']
        # insert at the front, reorder, update, delete
        c = client.post(url + '?at=0', headers=H, json={'title': 'Clean parts', 'method': 'other'}).json()
        assert [s['title'] for s in client.get(url).json()][0] == 'Clean parts'
        ids = [s['id'] for s in client.get(url).json()]
        assert client.post(url + '/order', headers=H, json={'ids': ids[1:] + ids[:1]}).status_code == 200
        assert client.get(url).json()[-1]['id'] == c['id']
        assert client.put(f"/api/assembly-steps/{c['id']}", headers=H, json={'title': 'Final check', 'method': 'other', 'check': 'All screws marked'}).json()['check'] == 'All screws marked'
        # the PDF is rendered by the worker: missing → queued (generating) → ready
        assert client.get(f'/api/revisions/{rid}/assembly-instructions.pdf').status_code == 404
        assert client.post(f'/api/revisions/{rid}/assembly-instructions', headers=H).json()['state'] == 'generating'
        assert client.get(f'/api/revisions/{rid}/assembly-instructions').json()['state'] == 'generating'
        assert client.get(f'/api/revisions/{rid}/assembly-instructions.pdf').status_code == 409
        from app import worker
        assert worker.run_once()
        assert client.get(f'/api/revisions/{rid}/assembly-instructions').json()['state'] == 'ready'
        pdf = client.get(f'/api/revisions/{rid}/assembly-instructions.pdf')
        assert pdf.status_code == 200 and pdf.content[:4] == b'%PDF'
        from pypdf import PdfReader
        import io
        r = PdfReader(io.BytesIO(pdf.content))
        assert len(r.pages) == 3
        text = r.pages[1].extract_text()
        assert 'Fit both brackets' in text and 'ISO 4762 M5' in text
        assert client.delete(f"/api/assembly-steps/{c['id']}", headers=H).status_code == 200
        assert [s['seq'] for s in client.get(url).json()] == [0, 1]


def test_sub_assemblies_build_then_fit_into_main(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    with TestClient(app) as client:
        rid = _fixture(client)
        H = {'X-Forge-Request': '1'}
        url = f'/api/revisions/{rid}/assembly-steps'
        g = client.post(f'/api/revisions/{rid}/assembly-groups', headers=H, json={'name': 'Bracket pair'}).json()
        assert client.get(f'/api/revisions/{rid}/assembly-groups').json()[0]['name'] == 'Bracket pair'
        s1 = client.post(url, headers=H, json={'title': 'Bracket 1', 'group': g['id'], 'parts': [{'part': 'bracket', 'occurrences': [0]}]}).json()
        client.post(url, headers=H, json={'title': 'Bracket 2', 'group': g['id'], 'parts': [{'part': 'bracket', 'occurrences': [1]}]})
        m1 = client.post(url, headers=H, json={'title': 'Base', 'parts': [{'part': 'base', 'occurrences': [0]}]}).json()
        m2 = client.post(url, headers=H, json={'title': 'Fit the bracket pair', 'method': 'screw', 'subs': [g['id']]})
        assert m2.status_code == 200, m2.text
        steps = client.get(url).json()
        assert [s['title'] for s in steps] == ['Bracket 1', 'Bracket 2', 'Base', 'Fit the bracket pair']   # sub-assemblies first
        assert steps[0]['group'] == g['id'] and steps[3]['group'] == '' and steps[3]['subs'] == [g['id']]
        # a sub-assembly is fitted once and never into itself
        assert client.put(f"/api/assembly-steps/{m1['id']}", headers=H, json={'title': 'Base', 'subs': [g['id']]}).status_code == 422
        assert client.put(f"/api/assembly-steps/{s1['id']}", headers=H, json={'title': 'Bracket 1', 'subs': [g['id']]}).status_code == 422
        from app.assembly import build_states, steps_of
        st = build_states(steps_of(rid))
        assert st[1] == {('bracket', 0): 'done', ('bracket', 1): 'new'}                     # only the sub-assembly
        assert st[2] == {('base', 0): 'new'}                                                   # main starts on its own
        assert st[3] == {('base', 0): 'done', ('bracket', 0): 'new', ('bracket', 1): 'new'}   # whole unit fitted
        # the PDF is rendered by the worker: missing → queued (generating) → ready
        assert client.get(f'/api/revisions/{rid}/assembly-instructions.pdf').status_code == 404
        assert client.post(f'/api/revisions/{rid}/assembly-instructions', headers=H).json()['state'] == 'generating'
        assert client.get(f'/api/revisions/{rid}/assembly-instructions').json()['state'] == 'generating'
        assert client.get(f'/api/revisions/{rid}/assembly-instructions.pdf').status_code == 409
        from app import worker
        assert worker.run_once()
        assert client.get(f'/api/revisions/{rid}/assembly-instructions').json()['state'] == 'ready'
        pdf = client.get(f'/api/revisions/{rid}/assembly-instructions.pdf')
        assert pdf.status_code == 200 and pdf.content[:4] == b'%PDF'
        # reorder inside the sub-assembly only
        sub_ids = [s['id'] for s in steps if s['group'] == g['id']]
        assert client.post(url + '/order', headers=H, json={'ids': sub_ids[::-1], 'group': g['id']}).status_code == 200
        assert client.post(url + '/order', headers=H, json={'ids': sub_ids[::-1]}).status_code == 422
        # deleting the sub-assembly removes its steps and the fitting reference
        assert client.delete(f"/api/assembly-groups/{g['id']}", headers=H).status_code == 200
        left = client.get(url).json()
        assert [s['title'] for s in left] == ['Base', 'Fit the bracket pair'] and left[1]['subs'] == []
