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


def test_collinear_bends_are_one_stroke():
    from app.unfold import bend_groups
    line = lambda i, a, b, ang=90, r=1.6, d='up': {'id': f'B{i:03d}', 'a': a, 'b': b, 'angle': ang, 'radius': r, 'direction': d}
    lines = [line(1, [0, 10], [40, 10]), line(2, [50, 10], [90, 10]), line(3, [100, 10.01], [140, 10.01]),
             line(4, [0, 50], [40, 50]),                       # parallel, other line
             line(5, [150, 10], [190, 10], d='down'),          # same line, other direction
             line(6, [200, 10], [240, 10], r=3.0)]             # same line, other radius
    assert bend_groups(lines) == [[0, 1, 2], [3], [4], [5]]


def test_bend_sequence_avoids_tool_clashes():
    from shapely.geometry import box
    line = lambda i, y, d='up': {'id': f'B{i:03d}', 'a': [0, y], 'b': [200, y], 'angle': 90, 'radius': 1.5, 'direction': d, 'allowance': 3.5}
    # C-channel with inward returns: returns first, then the flanges (the last one over a gooseneck punch)
    lines = [line(1, 15), line(2, 55), line(3, 115), line(4, 155)]
    sim = bendsim.build(box(0, 0, 200, 170), lines, 1.5, root_point=[100, 85])
    ids = [sim['bends'][s['bend']]['id'] for s in sim['plan']]
    assert set(ids[:2]) == {'B001', 'B004'} and not any(s['clash'] for s in sim['plan'])
    assert sim['order'] == [s['bend'] for s in sim['plan']] and sim['sequence'] == 'planned'
    assert all(s['segments'] == [[-100.0, 100.0]] for s in sim['plan'])          # sectional tools: the bend line
    # the shop's order is kept and re-checked: flanges first leaves the returns hitting the punch
    shop = bendsim.build(box(0, 0, 200, 170), lines, 1.5, root_point=[100, 85], order_ids=['B002', 'B003', 'B001', 'B004'])
    assert shop['sequence'] == 'custom' and [shop['bends'][s['bend']]['id'] for s in shop['plan']] == ['B002', 'B003', 'B001', 'B004']
    assert any('punch' in s['clash'] for s in shop['plan'])
    # a 12 mm Z with long legs: the first leg hangs beside a tall die
    z = bendsim.build(box(0, 0, 200, 260), [line(1, 100), line(2, 112, 'down')], 1.5, root_point=[100, 20])
    assert not any(s['clash'] for s in z['plan']) and z['plan'][1]['die'] == 'tall-die'


def test_bend_order_endpoint_and_drawing_sequence(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    from app.sheet import bend_sequence
    with TestClient(app) as client:
        rid, pid, project, user, token = 'borev', 'bopart', 'boproject', 'bouser', 'bo-session'
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
        (folder / 'drawing-scene.json').write_text('{}')
        with db.connect() as c:
            c.execute('INSERT INTO parts(id,revision_id,name,category,quantity,geometry,spec,doc_reviewed) VALUES(?,?,?,?,?,?,?,1)', (pid, rid, 'L', 'sheet_metal', 1, json.dumps(g), json.dumps(db.DEFAULT_SPEC)))
        client.cookies.set('forge_session', token)
        H = {'X-Forge-Request': '1'}
        bid = g['bends'][0]['id']
        url = f'/api/revisions/{rid}/parts/{pid}/bend-order'
        assert client.put(url, headers=H, json={'order': ['B999']}).status_code == 422
        r = client.put(url, headers=H, json={'order': [bid]})
        assert r.status_code == 200 and r.json()['job']
        # the drawing is out of date (it carries the sequence) and is regenerated for this part
        assert (folder / '.drawing-invalid').exists()
        part = db.row('SELECT doc_reviewed, drawing_options FROM parts WHERE id=?', (pid,))
        assert part['doc_reviewed'] == 0 and json.loads(part['drawing_options'])['bend_order'] == [bid]
        job = db.row('SELECT kind, payload FROM jobs WHERE id=?', (r.json()['job'],))
        assert job['kind'] == 'documents' and json.loads(job['payload']) == {'part_ids': [pid]}
        seq = bend_sequence(s, {'geometry': g, 'spec': {}}, {'bend_order': [bid]})
        assert seq['custom'] and seq['bends'][bid] == {'seq': 1, 'tool': 'STD', 'clash': False, 'process': 'brake'}


def _band(r=100.0, t=1.2, deg=90, h=50):
    import math
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
    from OCP.gp import gp_Ax2, gp_Pnt, gp_Dir
    ax = gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1))
    return BRepAlgoAPI_Cut(BRepPrimAPI_MakeCylinder(ax, r + t, h, math.radians(deg)).Shape(), BRepPrimAPI_MakeCylinder(ax, r, h, math.radians(deg)).Shape()).Shape()


def test_rolled_band_is_developed_and_rolled():
    import math
    from app.unfold import unfold
    s = _band()
    g = analyze(s, 'band')
    assert g['category'] == 'sheet_metal' and abs(g['thickness'] - 1.2) < 1e-6
    poly, lines = unfold(s, g, .4)                     # no planar skin: developed as a profile
    L = math.pi / 2 * (100 + .4 * 1.2)
    assert abs(poly.bounds[2] - poly.bounds[0] - L) < .05 and abs(poly.bounds[3] - poly.bounds[1] - 50) < .01
    assert len(lines) == 1 and lines[0]['rolled'] and abs(lines[0]['allowance'] - L) < .05
    sim = bendsim.for_part(s, g, {}, .4)
    st = sim['plan'][0]
    assert st['process'] == 'roll' and st['roll']['passes'] == 2 and st['roll']['top'] < 100 and not st['clash']
    # the shop can press-brake it instead (bump bending): same stroke, press tools
    br = bendsim.for_part(s, g, {}, .4, process={lines[0]['id']: 'brake'})
    assert br['plan'][0]['process'] == 'brake' and br['plan'][0]['punch']
    # folding the whole strip reproduces the band: a 90 degree arc of the neutral radius
    F = bendsim.folded_vertices(sim)
    span = np.ptp(F, axis=0)
    assert sorted(span)[-1] < 110 and sorted(span)[-2] > 90, span


def test_tangent_curves_without_a_flange_between_them_fold():
    from shapely.geometry import box
    line = lambda i, y, r: {'id': f'B{i:03d}', 'a': [0, y], 'b': [200, y], 'angle': 30, 'radius': r, 'direction': 'up', 'allowance': 20}
    sim = bendsim.build(box(0, 0, 200, 100), [line(1, 40, 40.0), line(2, 60, 40.0)], 1.5, root_point=[100, 10])
    assert len(sim['plan']) == 2 and all(s['process'] == 'roll' for s in sim['plan'])
    F = bendsim.folded_vertices(sim)
    assert np.isfinite(F).all() and np.ptp(F[:, 2]) > 10
