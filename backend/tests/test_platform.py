import os, json, base64
from fastapi.testclient import TestClient
from app.main import app
from app import db, entra
from app.worker import run_once
from app.cad import BRepTools
from app.security import token_hash, password_hash
from test_geometry import plate

H = {'X-Forge-Request': '1'}


def login_as(client, email, role, name=None):
    uid = db.uid()
    token = 'session-' + uid
    with db.connect() as c:
        c.execute('INSERT INTO users(id,email,name,password,role,created) VALUES(?,?,?,?,?,?)', (uid, email, name or email, '', role, db.now()))
        c.execute('INSERT INTO sessions VALUES(?,?,?)', (token_hash(token), uid, '2099-01-01'))
    client.cookies.set('forge_session', token)
    return uid


def released_project(client, tmp_path):
    t = client.post('/api/templates', headers=H, json={'kind': 'process', 'name': 'Laser + bend + powder', 'data': {'steps': [
        {'name': 'Laser cut'}, {'name': 'CNC bend'}, {'name': 'Powder coat', 'kind': 'outsourced'}, {'name': 'Final inspection', 'kind': 'inspection'}]}})
    assert t.status_code == 200, t.text
    tid = t.json()['id']
    d = client.post('/api/templates', headers=H, json={'kind': 'drawing', 'name': 'A3 with hole table', 'data': {'size': 'A3', 'hole_table': 'always'}}).json()['id']
    p = client.post('/api/projects', headers=H, json={'name': 'Platform fixture', 'code': 'pf', 'settings': {
        'sheet_prefixes': ['GT-SM'], 'prefix_strict': False, 'machining_prefixes': ['GT-MC'], 'drawing': {'drawn_by': 'NAVEEN', 'module': 'LIFTER'},
        'conventions': {'sheet_size': 'A4', 'hole_table': 'auto'}, 'process_templates': {'other': tid, 'machining': tid, 'sheet_metal': tid},
        'drawing_templates': {'machining': d}}})
    assert p.status_code == 200, p.text
    p = p.json()
    assert p['code'] == 'PF' and p['effective_settings']['drawing']['drawn_by'] == 'NAVEEN'
    source = tmp_path / 'fixture.brep'
    BRepTools.Write_s(plate(), str(source))
    r = client.post(f"/api/projects/{p['id']}/revisions", headers=H, files={'file': ('fixture.brep', source.read_bytes())}).json()
    assert run_once()
    rev = client.get('/api/revisions/' + r['id']).json()
    part = rev['parts'][0]
    # project default templates were applied at import
    assert part['process_template_id'] == tid and [o['name'] for o in part['spec']['operations']][:2] == ['Laser cut', 'CNC bend']
    return p, rev, part, tid, d


def make_production_ready(client, rev, part):
    spec = part['spec']
    spec.update({'material': 'Test material', 'process': 'Laser', 'finish': 'Deburred', 'datums': 'A = bottom; B = left; C = front', 'general_tolerance': 'Fixture tolerance',
                 'manual_checks': {k: 'Verified against synthetic test fixture' for k in ['load_strength', 'functional_gdt', 'threads', 'process_tooling', 'assembly', 'coating']},
                 'feature_specs': {'H001': {'designation': '6 mm through bore', 'lower': 5.9, 'upper': 6.1}}})
    assert client.patch('/api/parts/' + part['id'], headers=H, json={'spec': spec, 'category': 'sheet_metal', 'reviewed': True}).status_code == 200
    assert client.post(f"/api/revisions/{rev['id']}/documents", headers=H, json={}).status_code == 200
    assert run_once()
    assert client.post('/api/parts/' + part['id'] + '/doc-review', headers=H, json={'reviewed': True}).status_code == 200
    assert client.post('/api/revisions/' + rev['id'] + '/release', headers=H).status_code == 200
    assert run_once()
    assert client.get('/api/revisions/' + rev['id']).json()['status'] == 'released'


def test_rbac_project_settings_templates_joints_models_and_job_orders(tmp_path):
    with TestClient(app) as client:
        viewer = TestClient(app)
        login_as(viewer, 'viewer@example.com', 'viewer')
        assert viewer.post('/api/projects', headers=H, json={'name': 'nope'}).status_code == 403
        login_as(client, 'lead@example.com', 'admin')
        p, rev, part, tid, did = released_project(client, tmp_path)
        rid = rev['id']
        assert 'cad.download' in rev['permissions']
        # viewers read but cannot change or download CAD
        assert viewer.get('/api/revisions/' + rid).status_code == 200
        assert viewer.patch('/api/parts/' + part['id'], headers=H, json={'spec': part['spec'], 'category': 'machining'}).status_code == 403
        assert viewer.post(f'/api/revisions/{rid}/parts/process-template', headers=H, json={'ids': [part['id']], 'template_id': ''}).status_code == 403

        # joints: two parts needed; weld requires process and type
        assert client.post(f'/api/revisions/{rid}/joints', headers=H, json={'kind': 'weld', 'parts': [part['id'], part['id']]}).status_code == 422
        face = client.post(f"/api/parts/{part['id']}/face-at", headers=H, json={'point': [0, 0, 0]})
        assert face.status_code == 200, face.text
        assert face.json()['boundaries'] and face.json()['preview_mesh']['triangles']
        edge = client.post(f"/api/parts/{part['id']}/edge-at", headers=H, json={'point': [0, 0, 0]})
        assert edge.status_code == 200, edge.text
        assert edge.json()['type'] in ('line', 'circle', 'curve') and edge.json()['length'] > 0
        assert edge.json()['boundaries'][0]
        picked = [{'part': part['id'], 'selection': 'face', 'index': 0, 'type': 'plane'}, {'part': part['id'], 'selection': 'face', 'index': 1, 'type': 'plane'}]
        weld = client.post(f'/api/revisions/{rid}/joints', headers=H, json={'kind': 'weld', 'parts': [part['id']], 'faces': picked,
            'weld': {'process': 'MIG/MAG (135)', 'type': 'linear', 'thickness': '2'}})
        assert weld.status_code == 200, weld.text  # same-body welds are valid when two faces define the seam
        from app.workspace import job_order_items
        with db.connect() as c:
            c.execute('UPDATE parts SET quantity=2 WHERE id=?', (part['id'],))
        rows = job_order_items('preview-order', rid, 3, None, True)
        assert next(row for row in rows if row[2] == 'joint:' + weld.json()['id'])[-1] == 6
        scoped = job_order_items('preview-order', rid, 3, [{'part_id': part['id'], 'quantity': 4}], True)
        assert next(row for row in scoped if row[2] == 'joint:' + weld.json()['id'])[-1] == 4
        with db.connect() as c:
            c.execute('UPDATE parts SET quantity=1 WHERE id=?', (part['id'],))
        edge_weld = client.post(f'/api/revisions/{rid}/joints', headers=H, json={'kind': 'weld', 'parts': [part['id']], 'faces': [{'part': part['id'], 'selection': 'edge', 'occurrence': 0, **edge.json()}],
            'weld': {'process': 'MIG/MAG (135)', 'type': 'linear', 'thickness': '2'}})
        assert edge_weld.status_code == 200, edge_weld.text
        saved_welds = client.get(f'/api/revisions/{rid}/joints').json()
        assert next(j for j in saved_welds if j['id'] == edge_weld.json()['id'])['data']['faces'][0]['occurrence'] == 0
        assert client.delete('/api/joints/' + edge_weld.json()['id'], headers=H).status_code == 200
        # a tab-and-slot weld easily has 100+ seams: all of them save; straight seams keep only their end points
        many = [{'part': part['id'], 'selection': 'edge', 'occurrence': 0, 'index': i, 'type': 'line', 'start': [0, 0, i], 'end': [0, 0, i + 1], 'length': 1,
                 'boundaries': [[[0, 0, i + k / 8] for k in range(9)]], 'joint': 'fillet', 'legs': [[1, 0, 0], [0, 1, 0]]} for i in range(130)]
        big = client.post(f'/api/revisions/{rid}/joints', headers=H, json={'kind': 'weld', 'parts': [part['id']], 'faces': many,
            'weld': {'process': 'MIG/MAG (135)', 'type': 'linear', 'thickness': '2'}})
        assert big.status_code == 200, big.text
        stored = next(j for j in client.get(f'/api/revisions/{rid}/joints').json() if j['id'] == big.json()['id'])['data']['faces']
        assert len(stored) == 130 and len(stored[0]['boundaries'][0]) == 2
        assert client.delete('/api/joints/' + big.json()['id'], headers=H).status_code == 200
        assert client.post(f'/api/revisions/{rid}/joints', headers=H, json={'kind': 'weld', 'parts': [part['id']], 'faces': picked,
            'weld': {'process': 'MIG/MAG (135)', 'type': 'tack', 'width': '2', 'length': '3'}}).status_code == 422
        assert client.delete('/api/joints/' + weld.json()['id'], headers=H).status_code == 200

        # secure model streaming: no raw GLB; ticket + encrypted stream bound to the session
        assert client.get(f"/api/parts/{part['id']}/assets/model.glb").status_code == 403
        t = client.get(f'/api/model-ticket?revision={rid}&file=assembly.glb').json()
        body = client.get(t['url'])
        assert body.status_code == 200 and body.headers['cache-control'].startswith('no-store')
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        raw = body.content
        aad = base64.b64decode(body.headers['x-forge-aad'])
        glb = AESGCM(base64.b64decode(t['key'])).decrypt(raw[:12], raw[12:], aad)
        assert glb[:4] == b'glTF'
        assert viewer.get(t['url']).status_code == 403  # another principal cannot use the link
        forged = t['url'][:-3] + ('aaa' if not t['url'].endswith('aaa') else 'bbb')
        assert client.get(forged).status_code == 403

        # job orders need a production-ready revision
        assert client.post(f"/api/projects/{p['id']}/job-orders", headers=H, json={'title': 'Batch 1', 'quantity': 2}).status_code == 409
        make_production_ready(client, rev, part)
        jo = client.post(f"/api/projects/{p['id']}/job-orders", headers=H, json={'title': 'Batch 1', 'quantity': 2, 'due': '2030-01-01', 'requirement': 'Two lifters for customer trial'})
        assert jo.status_code == 200, jo.text
        jo = jo.json()
        steps = [i for i in jo['items'] if i['part_id'] == part['id']]
        assert [i['step'] for i in steps][:2] == ['Laser cut', 'CNC bend'] and all(i['required'] == 2 for i in steps)
        first, second = steps[0], steps[1]
        # a part cannot pass step 2 before step 1
        assert client.post(f"/api/job-orders/{jo['id']}/items/{second['id']}", headers=H, json={'add': 1}).status_code == 409
        ok = client.post(f"/api/job-orders/{jo['id']}/items/{first['id']}", headers=H, json={'add': 2, 'note': 'sheet 1', 'at': '2026-09-01T10:15:00+05:30'})
        assert ok.status_code == 200 and ok.json()['status'] == 'done'
        assert client.post(f"/api/job-orders/{jo['id']}/items/{second['id']}", headers=H, json={'add': 3}).status_code == 422
        assert client.post(f"/api/job-orders/{jo['id']}/items/{second['id']}/issue", headers=H, json={'body': 'Flange cracks at bend B001'}).status_code == 200
        detail = client.get('/api/job-orders/' + jo['id']).json()
        assert detail['status'] == 'in_progress' and detail['progress'] > 0
        assert any(e['created'].startswith('2026-09-01T04:45') for e in detail['events'])
        comments = client.get(f'/api/revisions/{rid}/comments').json()
        assert any(c['feature'] == 'production' and 'Flange cracks' in c['body'] for c in comments)
        assert viewer.post(f"/api/job-orders/{jo['id']}/items/{first['id']}", headers=H, json={'add': 0}).status_code == 403
        dash = client.get('/api/dashboard').json()
        assert dash['summary']['active'] == 1 and dash['summary']['open_issues'] == 1

        # operators may record progress but not create job orders
        op = TestClient(app)
        login_as(op, 'op@example.com', 'operator')
        assert op.post(f"/api/projects/{p['id']}/job-orders", headers=H, json={'title': 'x'}).status_code == 403
        assert op.post(f"/api/job-orders/{jo['id']}/items/{second['id']}", headers=H, json={'add': 1}).status_code == 200  # 2 passed step 1
        # mistakes can be taken back, but not below what the next step already counted
        assert op.post(f"/api/job-orders/{jo['id']}/items/{first['id']}", headers=H, json={'done': 0}).status_code == 409
        back = op.post(f"/api/job-orders/{jo['id']}/items/{second['id']}", headers=H, json={'add': -1, 'note': 'Correction'})
        assert back.status_code == 200 and back.json()['done'] == 0 and back.json()['status'] == 'pending'
        reset = op.post(f"/api/job-orders/{jo['id']}/items/{first['id']}", headers=H, json={'done': 0})
        assert reset.status_code == 200 and reset.json()['status'] == 'pending'
        # deadlines are real dates
        assert client.patch(f"/api/job-orders/{jo['id']}", headers=H, json={'due': 'next week'}).status_code == 422
        assert client.patch(f"/api/job-orders/{jo['id']}", headers=H, json={'due': '2030-01-15'}).status_code == 200


def test_admin_user_management_and_last_admin_guard():
    with TestClient(app) as client:
        admin = login_as(client, 'admin2@example.com', 'admin')
        assert client.post('/api/users', headers=H, json={'email': 'x@evil.org', 'name': 'X', 'role': 'viewer'}).status_code == 422
        assert client.post('/api/users', headers=H, json={'email': 'new@example.com', 'name': 'New', 'role': 'reviewer'}).status_code == 200
        others = [u for u in client.get('/api/users').json() if u['role'] == 'admin' and u['id'] != admin]
        for o in others:
            assert client.patch('/api/users/' + o['id'], headers=H, json={'active': False}).status_code == 200
        assert client.patch('/api/users/' + admin, headers=H, json={'role': 'viewer'}).status_code == 409


def test_entra_claims_rules(monkeypatch):
    monkeypatch.setenv('AUTH_MICROSOFT_ENTRA_ID_ID', 'client')
    monkeypatch.setenv('AUTH_MICROSOFT_ENTRA_ID_SECRET', 'secret')
    monkeypatch.setenv('AUTH_MICROSOFT_ENTRA_ID_ISSUER', 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0/')
    monkeypatch.setenv('ALLOWED_EMAIL_DOMAINS', 'goat-robotics.com')
    assert entra.enabled() and not entra.local_login_allowed()
    tid = '11111111-2222-3333-4444-555555555555'
    base = {'tid': tid, 'oid': 'oid-1', 'email': 'dev@goat-robotics.com', 'name': 'Dev', 'iss': f'https://login.microsoftonline.com/{tid}/v2.0'}
    assert entra.upsert_user({**base, 'tid': 'other'})[1] == 'WrongTenant'
    assert entra.upsert_user({**base, 'email': 'dev@gmail.com'})[1] == 'DomainNotAllowed'
    assert entra.upsert_user({**base, 'idp': 'https://sts.windows.net/9999/'})[1] == 'GuestsNotAllowed'
    u, err = entra.upsert_user(base)
    assert err is None and u['provider'] == 'entra'
    # e-mail cannot take over an account bound to another object id
    assert entra.upsert_user({**base, 'oid': 'oid-2'})[1] == 'AccountConflict'
    with TestClient(app) as client:
        assert client.post('/api/auth/login', json={'email': 'dev@goat-robotics.com', 'password': 'whatever-password'}).status_code == 403
        r = client.get('/api/auth/entra/login?next=//evil.com', follow_redirects=False)
        assert r.status_code == 302 and 'login.microsoftonline.com/' + tid in r.headers['location'] and 'code_challenge' in r.headers['location']
        assert client.get('/api/auth/entra/callback?code=x&state=y', follow_redirects=False).headers['location'].startswith('/?signin_error=')
    assert entra.safe_next('//evil.com') == '/' and entra.safe_next('/projects/1') == '/projects/1'


def test_step_materials(tmp_path):
    from app.cad import step_materials, step_header
    f = tmp_path / 'm.step'
    f.write_text("""ISO-10303-21;
HEADER;
FILE_NAME ('X.STEP','2026-09-21T06:42:57',( 'N' ),( 'GOAT' ),'SwSTEP 2.0','SolidWorks 2026','' );
FILE_SCHEMA (( 'AUTOMOTIVE_DESIGN' ));
ENDSEC;
DATA;
#5 = PRODUCT_DEFINITION('design','',#6,#9);
#6 = PRODUCT_DEFINITION_FORMATION('','',#7);
#7 = PRODUCT('GT-SM-001 BRACKET','GT-SM-001 BRACKET','',(#8));
#351 = REPRESENTATION('material name',(#352),#345);
#352 = DESCRIPTIVE_REPRESENTATION_ITEM('SS304','Stainless');
#358 = REPRESENTATION('density',(#359),#345);
#359 = MEASURE_REPRESENTATION_ITEM('density',POSITIVE_RATIO_MEASURE(7.93
    ),#353);
#360 = PROPERTY_DEFINITION('material property','material name',#5);
#361 = PROPERTY_DEFINITION_REPRESENTATION(#360,#351);
#362 = PROPERTY_DEFINITION('material property','density',#5);
#363 = PROPERTY_DEFINITION_REPRESENTATION(#362,#358);
ENDSEC;
END-ISO-10303-21;
""")
    m = step_materials(f)
    assert m['GT-SM-001 BRACKET'] == {'material': 'SS304', 'material_description': 'Stainless', 'density': 7.93}
    h = step_header(f)
    assert h['originating_system'] == 'SolidWorks 2026' and h['organization'] == 'GOAT'


def test_detail_view_and_page_order_render():
    from app.drawing_scene import SceneCanvas, group, render_scene, validate_details, page_order
    import io
    c = SceneCanvas(io.BytesIO(), pagesize=(595, 842))
    with group(c, 'view:main', 'view'):
        c.setLineWidth(.71)
        c.rect(100, 100, 200, 100)
        c.setLineWidth(.4)
        c.line(100, 90, 300, 90)
    c.showPage()
    c.rect(10, 10, 20, 20)
    c.showPage()
    scene = c.scene('h')
    d = validate_details(scene, [{'label': 'A', 'page': 0, 'view': 'view:main', 'x': 110, 'y': 110, 'r': 20, 'scale': 2, 'target_page': 0, 'cx': 450, 'cy': 600}])
    assert d[0]['id'] == 'A'
    for bad in ({'label': 'I'}, {'scale': 30}, {'view': 'fixed:0:1'}):
        try:
            validate_details(scene, [{**d[0], **bad}])
            assert False, bad
        except ValueError:
            pass
    assert page_order(scene, [1, 0]) == [1, 0] and page_order(scene, [0, 0]) == [0, 1]
    out = io.BytesIO()
    render_scene(scene, {'details': d, 'page_order': [1, 0]}, target=out)
    from pypdf import PdfReader
    r = PdfReader(io.BytesIO(out.getvalue()))
    assert len(r.pages) == 2 and 'DETAIL A' in r.pages[1].extract_text()


def test_first_angle_projection_mirrors_view_positions():
    from app import sheet
    from app.cad import analyze
    from test_goat_sheet import block, REV, SETTINGS
    s = block()
    g = analyze(s, 'MC-01 BLOCK')
    p = {'id': 'fa', 'name': 'MC-01 BLOCK', 'category': 'machining', 'quantity': 1, 'geometry': g, 'spec': {'material': 'AL'}}
    def centres(conv):
        sh = sheet.build_sheets(s, p, REV, {**SETTINGS, 'conventions': conv})[0]
        out = {}
        for it in sh.items:
            if it['k'] == 'poly' and it.get('sg', '') and it['sg'].startswith('view:') and it.get('layer') == 'VISIBLE':
                out.setdefault(it['sg'][5:], []).extend(it['pts'])
        return {k: (sum(x for x, _ in v) / len(v), sum(y for _, y in v) / len(v)) for k, v in out.items()}, [t['s'] for t in sh.items if t['k'] == 'text']
    third, t3 = centres({'projection': 'third'})
    first, t1 = centres({'projection': 'first', 'general_tolerance': 'ISO 2768-mK'})
    assert third['top'][1] > third['main'][1] and first['top'][1] < first['main'][1]
    assert third['right'][0] > third['main'][0] and first['right'][0] < first['main'][0]
    assert any('FIRST ANGLE' in x for x in t1) and any('THIRD ANGLE' in x for x in t3)
    assert any('ISO 2768-MK' in x for x in t1)


def test_added_sheet_moved_view_detail_annotations_and_sheet_numbers():
    import io
    from app.drawing_scene import SceneCanvas, render_scene, validate_edits, detail_plan
    from app.drawings import full_scene, validate_extra_pages
    from app.sheet import draw_template, Sheet, title_values, render_pdf
    from pypdf import PdfReader
    p = {'id': 'x', 'name': 'PLATE', 'category': 'machining', 'quantity': 1, 'geometry': {}, 'spec': {}}
    c = SceneCanvas(io.BytesIO(), pagesize=(842, 595))
    sh = Sheet('A4'); draw_template(sh, title_values(p, {'number': 1}, {}, 1, 1, 1, 'A4'))
    sh.sg = 'view:main'; sh.poly([(50, 50), (150, 50), (150, 100), (50, 100)], .25, 'VISIBLE', closed=True)
    sh.text(100, 40, '42.00', 2.5, 'ForgeDim', 'DIM'); sh.sg = None
    sh.meta = {'scale': 1, 'size': 'A4'}
    render_pdf(sh, c)
    scene = c.scene('h')
    extra = validate_extra_pages([{'id': 'sheetA', 'size': 'A3'}])
    fs = full_scene(p, {'number': 1}, {}, scene, {'extra_pages': extra})
    assert len(fs['pages']) == 2 and all(g['id'].startswith('sheetA:') for g in fs['pages'][1]['groups'])
    edits = validate_edits(fs, {'view:main': {'page': 1}}, [])
    try:
        validate_edits(scene, {'view:main': {'page': 1}}, [])
        assert False
    except ValueError:
        pass
    mm = 72 / 25.4
    d = {'id': 'A', 'label': 'A', 'page': 0, 'view': 'view:main', 'x': 100 * mm, 'y': 45 * mm, 'r': 12 * mm, 'scale': 2, 'target_page': 1, 'cx': 300, 'cy': 400}
    view = next(g for g in fs['pages'][0]['groups'] if g['id'] == 'view:main')
    scaled, moved, calls = detail_plan(d, view, [], {})
    assert scaled and any(n['type'] == 'text' and n['text'] == '42.00' for n, _, _ in moved)
    out = io.BytesIO()
    render_scene(fs, {**edits, 'details': [d]}, target=out)
    r = PdfReader(io.BytesIO(out.getvalue()))
    t1, t2 = r.pages[0].extract_text(), r.pages[1].extract_text()
    assert '42.00' in t2 and '42.00' not in t1          # the view (with its dimension) moved to the added sheet
    assert 'OF 2' in t1.replace('  ', ' ') and 'DETAIL A' in t2


def test_corner_chamfers_are_called_out():
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.BRepFilletAPI import BRepFilletAPI_MakeChamfer
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopoDS import TopoDS
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from app.cad import analyze
    from app import sheet
    s = BRepPrimAPI_MakeBox(70, 50, 69).Shape()
    ch = BRepFilletAPI_MakeChamfer(s); e = TopExp_Explorer(s, TopAbs_EDGE)
    while e.More():
        ed = TopoDS.Edge(e.Current()); g = GProp_GProps(); BRepGProp.LinearProperties_s(ed, g); c = g.CentreOfMass()
        if abs(c.Z() - 69) < 1e-6 and abs(c.X() - 35) > 30:
            ch.Add(5, ed)
        e.Next()
    s = ch.Shape()
    g = analyze(s, 'MC-007 BLOCK')
    p = {'id': 'c', 'name': 'MC-007 BLOCK', 'category': 'machining', 'quantity': 1, 'geometry': g, 'spec': {}}
    texts = [it['s'] for sh in sheet.build_sheets(s, p, {'number': 1}, {}) for it in sh.items if it['k'] == 'text']
    texts += [l for sh in sheet.build_sheets(s, p, {'number': 1}, {}) for m in sh.callouts.values() for l in m['lines']]
    assert any('5.00 X 45°' in t for t in texts), texts


def test_group_ids_unique_across_sheets_and_free_detail_enlargement():
    from app.drawing_scene import unique_group_ids, validate_details
    scene = {'pages': [{'groups': [{'id': 'view:main', 'kind': 'view', 'nodes': []}, {'id': 'callout:a', 'kind': 'callout', 'parent': 'view:main', 'nodes': []}]},
                       {'groups': [{'id': 'view:main', 'kind': 'view', 'nodes': []}, {'id': 'callout:b', 'kind': 'callout', 'parent': 'view:main', 'nodes': []}]}]}
    unique_group_ids(scene)
    ids = [g['id'] for pg in scene['pages'] for g in pg['groups']]
    assert len(ids) == len(set(ids)) and scene['pages'][1]['groups'][0]['id'] == 'p1:view:main'
    assert scene['pages'][1]['groups'][1]['parent'] == 'p1:view:main'
    d = {'label': 'A', 'page': 1, 'view': 'p1:view:main', 'x': 10, 'y': 10, 'r': 20, 'scale': 1.35, 'target_page': 0, 'cx': 100, 'cy': 100}
    assert validate_details(scene, [d])[0]['scale'] == 1.35
    for bad in (1.0, 25):
        try:
            validate_details(scene, [{**d, 'scale': bad}]); assert False
        except ValueError:
            pass


def test_drill_path_orders_one_tool_at_a_time_and_short():
    import numpy as np
    from app.sheet import drill_path
    pts = np.array([[100, 0], [0, 0], [50, 0], [10, 0], [90, 0]], float)
    order = drill_path(pts, np.array([0, 0.]))
    assert [int(pts[i][0]) for i in order] == [0, 10, 50, 90, 100]


def write_frame_step(path):
    """Welded frame (base + upright + rib), an IPC sub-assembly (cover, PCB, cover) and a surface-only boundary circle."""
    from OCP.TDocStd import TDocStd_Document
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.XCAFDoc import XCAFDoc_DocumentTool
    from OCP.STEPCAFControl import STEPCAFControl_Writer
    from OCP.STEPControl import STEPControl_AsIs
    from OCP.TDataStd import TDataStd_Name
    from OCP.gp import gp_Trsf, gp_Vec, gp_Circ, gp_Ax2, gp_Pnt, gp_Dir
    from OCP.TopLoc import TopLoc_Location
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeWire, BRepBuilderAPI_MakeFace
    doc = TDocStd_Document(TCollection_ExtendedString('t'))
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    def label(shape, name):
        l = st.AddShape(shape, False); TDataStd_Name.Set_s(l, TCollection_ExtendedString(name)); return l
    def place(parent, l, pos):
        t = gp_Trsf(); t.SetTranslation(gp_Vec(*pos)); st.AddComponent(parent, l, TopLoc_Location(t))
    root = st.NewShape(); TDataStd_Name.Set_s(root, TCollection_ExtendedString('FRAME ASM'))
    box = lambda x, y, z: BRepPrimAPI_MakeBox(x, y, z).Shape()
    place(root, label(box(300, 200, 8), 'BASE PLATE'), (0, 0, 0))
    place(root, label(box(300, 8, 150), 'UPRIGHT'), (0, 0, 8))
    place(root, label(box(8, 184, 150), 'RIB'), (146, 8, 8))
    ipc = st.NewShape(); TDataStd_Name.Set_s(ipc, TCollection_ExtendedString('IPC ASM'))
    place(ipc, label(box(100, 60, 4), 'IPC TOP COVER'), (0, 0, 20))
    place(ipc, label(box(90, 50, 1.6), 'IPC PCB'), (5, 5, 10))
    place(ipc, label(box(100, 60, 4), 'IPC BOTTOM COVER'), (0, 0, 0))
    place(root, ipc, (20, 40, 8))
    circle = BRepBuilderAPI_MakeFace(BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(gp_Circ(gp_Ax2(gp_Pnt(150, 100, 0), gp_Dir(0, 0, 1)), 180)).Edge()).Wire()).Face()
    place(root, label(circle, 'BOUNDARY CIRCLE'), (0, 0, 0))
    st.UpdateAssemblies()
    w = STEPCAFControl_Writer(); w.SetNameMode(True); w.Transfer(doc, STEPControl_AsIs); w.Write(str(path))


def test_weld_seams_assembly_tree_and_purchased_left_off_assembly_drawing(tmp_path):
    with TestClient(app) as client:
        login_as(client, 'welder@example.com', 'admin')
        p = client.post('/api/projects', headers=H, json={'name': 'Weld fixture', 'code': 'wf', 'settings': {'prefix_strict': False}}).json()
        src = tmp_path / 'frame.step'
        write_frame_step(src)
        r = client.post(f"/api/projects/{p['id']}/revisions", headers=H, files={'file': ('frame.step', src.read_bytes())}).json()
        assert run_once()
        rev = client.get('/api/revisions/' + r['id']).json()
        parts = {x['name']: x for x in rev['parts']}
        # surface-only geometry (sketch / boundary circle) is not a part
        assert 'BOUNDARY CIRCLE' not in parts and len(parts) == 6
        # STEP sub-assembly structure, without the shared top-level assembly
        assert parts['IPC PCB']['assembly_path'] == ['IPC ASM'] and parts['RIB']['assembly_path'] == []
        # seams where the welded plates touch: inside fillets at the rib and upright feet, flush outside seam at the front
        s = client.post(f"/api/revisions/{r['id']}/weld-seams", headers=H, json={'parts': [parts['BASE PLATE']['id'], parts['UPRIGHT']['id'], parts['RIB']['id']]})
        assert s.status_code == 200, s.text
        seams = s.json()['seams']
        fillets = [x for x in seams if x['joint'] == 'fillet' and not x['minor']]
        assert sorted(round(x['length']) for x in fillets) == [150, 150, 184, 184, 300]
        assert any(x['joint'] == 'butt' and round(x['length']) == 300 for x in seams)
        assert all(x['size'] == 4.0 and x['legs'] for x in fillets)  # a = half of 8 mm plate
        # untouched parts: no seams, a helpful message
        none = client.post(f"/api/revisions/{r['id']}/weld-seams", headers=H, json={'parts': [parts['RIB']['id'], parts['IPC TOP COVER']['id']]}).json()
        assert none['seams'] == [] and 'do not touch' in none['message']
        # detected seams save as a weld and keep their joint data for the 3D bead
        faces = [{k: x[k] for k in ('part', 'occurrence', 'selection', 'index', 'type', 'start', 'end', 'length', 'boundaries', 'joint', 'legs', 'normal', 'other_part', 'other_occurrence')} for x in fillets]
        j = client.post(f"/api/revisions/{r['id']}/joints", headers=H, json={'kind': 'weld', 'parts': [parts['BASE PLATE']['id'], parts['UPRIGHT']['id'], parts['RIB']['id']], 'faces': faces,
                                                                         'weld': {'type': 'linear', 'process': 'MIG/MAG (135)', 'size': '4', 'sides': 'one'}})
        assert j.status_code == 200, j.text
        saved = client.get('/api/revisions/' + r['id']).json()['joints'][0]['data']
        assert len(saved['faces']) == 5 and all(f['joint'] == 'fillet' and len(f['legs']) == 2 for f in saved['faces'])
        # purchased parts are left off the assembly drawing unless overridden
        from app.drawings import shows_on_assembly
        pcb = parts['IPC PCB']
        assert pcb['category'] == 'purchased' or client.post(f"/api/revisions/{r['id']}/parts/bulk", headers=H, json={'ids': [pcb['id']], 'category': 'purchased'}).status_code == 200
        assert not shows_on_assembly({**pcb, 'category': 'purchased'}, {}) and shows_on_assembly(parts['RIB'], {})
        assert shows_on_assembly({**pcb, 'category': 'purchased'}, {'assembly_show_purchased': True})
        assert client.post(f"/api/revisions/{r['id']}/parts/assembly-drawing", headers=H, json={'ids': [pcb['id']], 'show': True}).status_code == 200
        assert run_once()  # assembly-only regeneration
        pcb = next(x for x in client.get('/api/revisions/' + r['id']).json()['parts'] if x['id'] == pcb['id'])
        assert pcb['drawing_options']['assembly_show'] is True
        assert (db.revdir(r['id']) / 'assembly.pdf').exists()


def test_gap_seams_bridge_parts_and_bent_corners():
    import numpy as np
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse
    from OCP.gp import gp_Pnt
    from app.seams import Body, find_seams, face_gap_seams
    from app.cad import explore, TopAbs_SOLID
    box = lambda p, x, y, z: BRepPrimAPI_MakeBox(gp_Pnt(*p), x, y, z).Shape()
    # one bent-box body whose two side flanges stop 1.5 mm short of each other at the corner
    s = BRepAlgoAPI_Fuse(box((0, 0, 0), 200, 100, 2), box((0, 0, 2), 200, 2, 80)).Shape()
    s = list(explore(BRepAlgoAPI_Fuse(s, box((0, 3.5, 2), 2, 96.5, 80)).Shape(), TopAbs_SOLID))[0]
    corner = find_seams([Body('box', 0, s, np.eye(4), 2)], self_mode=True)
    assert [(x['joint'], x['gap'], round(x['length'])) for x in corner] == [('gap', 1.5, 80), ('gap', 1.5, 80)]
    assert all(x['size'] >= 2.0 for x in corner)  # the bead must fill the gap
    # two plates 3 mm apart: bridged automatically (≤ 1.5 × 2 mm) and when the two faces are picked
    a, c = Body('A', 0, box((0, 0, 0), 100, 50, 2), np.eye(4), 2), Body('C', 0, box((0, 0, 5), 100, 2, 40), np.eye(4), 2)
    assert {(x['joint'], x['gap']) for x in find_seams([a, c])} == {('gap', 3.0)}
    top = next(i for i, f in enumerate(a.faces) if abs(a.face_boxes[i].CornerMin().Z() - 2) < .5 and abs(a.face_boxes[i].CornerMax().Z() - 2) < .5)
    bottom = next(i for i, f in enumerate(c.faces) if abs(c.face_boxes[i].CornerMin().Z() - 5) < .5 and abs(c.face_boxes[i].CornerMax().Z() - 5) < .5)
    picked = face_gap_seams((a, top), (c, bottom))
    assert picked and all(x['gap'] == 3.0 and round(x['length']) == 100 for x in picked)


def test_face_pair_seams_any_two_faces():
    import numpy as np
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
    from OCP.gp import gp_Pnt, gp_Ax2, gp_Dir
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from app.seams import Body, face_pair_seams
    box = lambda p, x, y, z: BRepPrimAPI_MakeBox(gp_Pnt(*p), x, y, z).Shape()
    def face(body, test):
        for i, f in enumerate(body.faces):
            g = GProp_GProps(); BRepGProp.SurfaceProperties_s(f, g); c = g.CentreOfMass()
            if test(np.array([c.X(), c.Y(), c.Z()])):
                return i
    base = Body('base', 0, box((0, 0, 0), 300, 200, 8), np.eye(4), 8)
    rib = Body('rib', 0, box((146, 8, 8), 8, 184, 150), np.eye(4), 8)
    top = face(base, lambda c: abs(c[2] - 8) < 1e-6)
    # T-joint: rib side face + base top face → exact intersection line, fillet legs along both faces
    seams, d = face_pair_seams((rib, face(rib, lambda c: abs(c[0] - 146) < 1e-6)), (base, top))
    assert d < 1e-6 and len(seams) == 1 and seams[0]['joint'] == 'fillet' and round(seams[0]['length']) == 184
    assert seams[0]['legs'] == [[-1.0, 0.0, 0.0], [0.0, 0.0, 1.0]] and seams[0]['angle'] == 90.0
    # lap: rib bottom face lying on the base top face → the rib's foot edges on the plate
    lap, _ = face_pair_seams((rib, face(rib, lambda c: abs(c[2] - 8) < 1e-6)), (base, top))
    assert sorted(round(s['length']) for s in lap if not s['minor']) == [184, 184]
    # tube standing on the plate: a closed circular seam
    tube = Body('tube', 0, BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(60, 100, 8), gp_Dir(0, 0, 1)), 20, 60).Shape(), np.eye(4), 3)
    side = face(tube, lambda c: 8 < c[2] < 68 and abs(c[0] - 60) < 1e-3)
    ring, _ = face_pair_seams((tube, side), (base, top))
    assert len(ring) == 1 and abs(ring[0]['length'] - 2 * np.pi * 20) < 1
    # faces apart: bridged across the gap; too far: nothing
    a, c = Body('A', 0, box((0, 0, 0), 100, 50, 2), np.eye(4), 2), Body('C', 0, box((0, 0, 5), 100, 2, 40), np.eye(4), 2)
    gap, d = face_pair_seams((a, face(a, lambda q: abs(q[2] - 2) < 1e-6)), (c, face(c, lambda q: abs(q[2] - 5) < 1e-6)))
    assert round(d, 3) == 3.0 and gap and all(s['joint'] == 'gap' for s in gap)
    far = Body('F', 0, box((0, 0, 60), 100, 2, 40), np.eye(4), 2)
    none, d = face_pair_seams((a, face(a, lambda q: abs(q[2] - 2) < 1e-6)), (far, face(far, lambda q: abs(q[2] - 60) < 1e-6)))
    assert none == [] and d > 25
