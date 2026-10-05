import json
import numpy as np
from fastapi.testclient import TestClient
from app import db, bendsim
from app.cad import analyze, mesh, BRepTools
from app.main import app
from app.security import token_hash
from test_geometry import bent


def test_folded_blank_matches_the_part():
    s = bent()
    g = analyze(s, 'L bracket')
    sim = bendsim.for_part(s, g, {}, .4)
    assert len(sim['bends']) == 1 and sim['order'] == [0]
    flat = np.array(sim['vertices']).reshape(-1, 3)
    # flat blank: material is one thickness thick
    assert abs(flat[:, 2].max() - flat[:, 2].min() - 2) < 1e-6
    F = bendsim.folded_vertices(sim)
    R, t = np.array(sim['root']['R']), np.array(sim['root']['t'])
    V = mesh(s, .05).vertices @ R.T + t
    lo, hi = V.min(0), V.max(0)
    # folded blank occupies the part's envelope (neutral-fibre bend: within a few tenths of a mm)
    assert np.all(np.abs(F.min(0) - lo) < .6) and np.all(np.abs(F.max(0) - hi) < .6), (F.min(0), lo, F.max(0), hi)
    # half-folded is in between: the flange end has risen part way
    H = bendsim.folded_vertices(sim, .5)
    assert np.ptp(H[:, 2]) < np.ptp(F[:, 2]) and np.ptp(H[:, 2]) > 2.5


def test_bend_simulation_sharing_and_stream(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    with TestClient(app) as client:
        rid, pid, project, user, token = 'bsrev', 'bspart', 'bsproject', 'bsuser', 'bs-session'
        with db.connect() as c:
            c.execute('INSERT INTO users(id,email,name,password,role,created) VALUES(?,?,?,?,?,?)', (user, 'e@example.test', 'Fixture', 'unused', 'engineer', db.now()))
            c.execute('INSERT INTO sessions VALUES(?,?,?)', (token_hash(token), user, '2099-01-01'))
            c.execute('INSERT INTO projects(id,name,description,created,rules) VALUES(?,?,?,?,?)', (project, 'fixture', '', db.now(), json.dumps(db.DEFAULT_RULES)))
            c.execute('INSERT INTO revisions(id,project_id,number,filename,sha256,state,status,created,created_by) VALUES(?,?,?,?,?,?,?,?,?)', (rid, project, 1, 'f.step', 's', 'active', 'ready', db.now(), 'f'))
        s = bent()
        g = analyze(s, 'L')
        g['category'] = 'sheet_metal'
        g['flat_status'] = 'supported'
        folder = db.revdir(rid) / 'parts' / pid
        folder.mkdir(parents=True)
        BRepTools.Write_s(s, str(folder / 'shape.brep'))
        with db.connect() as c:
            c.execute('INSERT INTO parts(id,revision_id,name,category,quantity,geometry,spec) VALUES(?,?,?,?,?,?,?)', (pid, rid, 'L', 'sheet_metal', 1, json.dumps(g), json.dumps(db.DEFAULT_SPEC)))
        client.cookies.set('forge_session', token)
        H = {'X-Forge-Request': '1'}
        r = client.get(f'/api/revisions/{rid}').json()
        assert [p['bend_sim'] for p in r['parts']] == [True]  # project default: shared
        t = client.get('/api/model-ticket', params={'revision': rid, 'file': 'bend-sim.json', 'part': pid})
        assert t.status_code == 200, t.text
        body = client.get(t.json()['url'])
        assert body.status_code == 200 and (folder / 'bend-sim.json').exists()
        assert client.post(f'/api/revisions/{rid}/parts/bend-simulation', headers=H, json={'ids': [pid], 'mode': 'off'}).status_code == 200
        r = client.get(f'/api/revisions/{rid}').json()
        assert r['parts'][0]['bend_sim'] is False and r['parts'][0]['drawing_options']['bend_sim'] is False
        # an editor can still preview it; the sharing flag survives a sheet-template change
        assert client.get('/api/model-ticket', params={'revision': rid, 'file': 'bend-sim.json', 'part': pid}).status_code == 200
        client.post(f'/api/revisions/{rid}/parts/drawing-options', headers=H, json={'ids': [pid], 'size': 'A3', 'hole_table': '', 'template_id': '', 'regenerate': False})
        assert client.get(f'/api/revisions/{rid}').json()['parts'][0]['drawing_options'].get('bend_sim') is False
        # preferences follow the account
        assert client.put('/api/me/prefs', headers=H, json={'shortcuts': {'view.front': 'Q'}, 'navStyle': 'solidworks', 'evil': 1}).status_code == 200
        me = client.get('/api/auth/status').json()['user']
        assert me['prefs'] == {'shortcuts': {'view.front': 'Q'}, 'navStyle': 'solidworks'}


def test_rendered_pictorial_image():
    import io
    from PIL import Image
    from app import render
    s = bent()
    md = render.mesh_data(s)
    n = np.array([1, -1, 1]) / np.sqrt(3)
    r = np.array([1, 1, 0]) / np.sqrt(2)
    pts = md['v']
    up = np.cross(n, r)
    lo = np.array([(pts @ r).min(), (pts @ up).min()])
    hi = np.array([(pts @ r).max(), (pts @ up).max()])
    im = np.asarray(Image.open(io.BytesIO(render.view_image(md, n, r, lo, hi, px_per_mm=6))).convert('L'))
    shaded = (im < 235).mean()
    assert im.shape[1] == round((hi - lo)[0] * 6) and .15 < shaded < .9   # part fills a good share of its box
    assert len(np.unique(im[im < 235] // 8)) > 4                          # real shading, not a flat silhouette
