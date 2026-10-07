import copy, json, math
from fastapi.testclient import TestClient
from app import db, costing, nesting
from app.rules import evaluate
from app.main import app
from test_platform import login_as, released_project, make_production_ready, H


def test_rate_card_lookups():
    card = costing.clean_card(copy.deepcopy(costing.BASE_CARD))
    assert costing.clean_card(card) == card                              # cleaning is idempotent
    assert costing.by_thickness(card['laser'], 2.0, 'per_m') == 12
    assert costing.by_thickness(card['laser'], 2.2, 'per_m') == 15          # next row up
    assert costing.by_thickness(card['laser'], 25, 'per_m') == 250          # scaled past the table
    assert costing.hardware_price(card, 'nut', 'M3') == 2.5 and costing.hardware_price(card, 'nut', 'M6') == 3.5
    assert costing.hardware_price(card, 'rivnut', 'M10') == 10             # '*' row
    assert costing.hardware_price(card, 'weld_nut', 'M8') == 4
    m, ok = costing.material_of(card, {'material': 'Mild steel IS 513 CR2 (CRCA)'}, 'sheet_metal')
    assert ok and m['key'] == 'crca'
    m, ok = costing.material_of(card, {'material': 'SS 316L'}, 'sheet_metal')
    assert ok and m['key'] == 'ss316'
    m, ok = costing.material_of(card, {'material': 'Unobtainium'}, 'machining')
    assert not ok and m['key'] == 'msbright'
    assert costing.finish_of(card, {'finish': 'Powder coating RAL 9005 matte'})['key'] == 'powder'
    assert costing.finish_of(card, {'finish': 'Not applicable'}) is None
    assert costing.colour_extra(card, {'coating_color': 'RAL 1023'})['extra_sqft'] == 3
    assert costing.welding_rate(card, 'TIG', 'ss')['per_m'] == 150
    assert costing.welding_rate(card, 'Laser', 'ms')['per_m'] == 80       # fallback row
    try:
        costing.clean_card({'materials': 'nope'})
        raise AssertionError('expected 422')
    except Exception as e:
        assert getattr(e, 'status_code', 0) == 422


def _sheet_part(t=2.0, finish='Powder coat RAL 9005', holes=None):
    return {'id': 'p1', 'name': 'BRACKET', 'category': 'sheet_metal', 'alias': '',
            'geometry': {'thickness': t, 'volume': 200 * 100 * t, 'area': 2 * 200 * 100, 'bends': [{'id': 'B001', 'radius': t, 'length': 100, 'angle': 90}],
                         'holes': holes or [{'id': 'H001', 'diameter': 5.41, 'center': [0, 0, 0]}]},
            'spec': {'material': 'CRCA', 'finish': finish, 'coating_color': 'RAL 9005',
                     'feature_specs': {'H001': {'hardware': {'type': 'nut', 'thread': 'M4'}}}}, 'drawing_options': {}}


def test_price_sheet_part(monkeypatch):
    card = costing.clean_card(copy.deepcopy(costing.BASE_CARD))
    flat = {'outline': [[0, 0], [200, 0], [200, 100], [0, 100]], 'holes': [[[50, 50], [55, 50], [55, 55], [50, 55]]]}
    monkeypatch.setattr(costing, '_flat', lambda rid, pid: flat)
    w = []
    r = costing.price_part(card, _sheet_part(), 10, 'rev', w)
    by = {l['process']: l for l in r['lines']}
    assert abs(by['Laser cutting']['qty'] - 0.62) < 1e-6 and by['Pierces']['qty'] == 2
    kg = 200 * 100 * 2 * 7850e-9 * 1.15
    assert abs(by['Material']['qty'] - kg) < 1e-3 and by['Material']['rate'] == 66
    assert by['Bending']['qty'] == 1 and by['Bending setup']['per_job']
    assert by['Hardware']['rate'] == 2.5 and by['Hardware insertion']['rate'] == round(2 * 0.95, 3)   # 5 % off labour at 10 pcs
    assert by['Finish']['amount'] > 0 and not w
    assert r['total'] == round(r['unit_cost'] * 10 + r['setup'], 2)
    # a curve rolled instead of bent
    p = _sheet_part()
    p['geometry']['bends'][0]['radius'] = 40
    r2 = costing.price_part(card, p, 1, 'rev', [])
    assert any(l['process'] == 'Rolling' for l in r2['lines']) and not any(l['process'] == 'Bending' for l in r2['lines'])
    # unknown finish is reported, not priced
    w = []
    costing.price_part(card, _sheet_part(finish='Cerakote'), 1, 'rev', w)
    assert any('Cerakote' in x for x in w)


def test_distortion_zone_and_hanging_hole_rules():
    g = {'valid': True, 'category': 'sheet_metal', 'thickness': 2.0, 'flat_status': 'supported',
         'bends': [{'id': 'B001', 'radius': 2.0, 'length': 100, 'angle': 90, 'axis': [0, 1, 0], 'center': [0, 0, 0]}],
         'holes': [{'id': 'H001', 'diameter': 4, 'depth': 2, 'center': [5, 0, 3]},     # flange hole right by the bend
                   {'id': 'H002', 'diameter': 4, 'depth': 2, 'center': [40, 0, 3]},    # far from it
                   {'id': 'H003', 'diameter': 4, 'depth': 2, 'center': [5, 90, 3]}]}   # past the end of the bend
    s = {'finish': 'Powder coat', 'rule_waivers': {}}
    f = [x for x in evaluate(g, s) if x['code'] == 'DFM006']
    assert [x['feature'] for x in f] == ['H001'] and '2t + r = 6.00' in f[0]['detail']
    assert not [x for x in evaluate(g, s) if x['code'] == 'DFM007']      # it has a hole >= 2.2 mm to hang from
    g['holes'] = []
    assert [x for x in evaluate(g, s) if x['code'] == 'DFM007']
    s['rule_waivers'] = {'DFM006:H001': {'by': 'x'}}
    g['holes'] = [{'id': 'H001', 'diameter': 4, 'depth': 2, 'center': [5, 0, 3]}]
    assert [x for x in evaluate(g, s) if x['code'] == 'DFM006'][0]['waiver']   # risk accepted


def test_square_nesting_keeps_edges_axis_parallel():
    a = math.radians(30)
    rot = lambda x, y: [x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a)]
    outline = [rot(0, 0), rot(120, 0), rot(120, 40), rot(60, 40), rot(60, 80), rot(0, 80)]   # an L, drawn at 30 degrees
    assert abs(nesting._dominant_angle(outline) - 30) < 1e-6
    s = nesting.Shape('l', 'L', outline, [], [], 4, square=True)
    sheets, unplaced = nesting.nest_group([s], 600, 400, 5, 10, budget=3)
    assert not unplaced
    for sh in sheets:
        for p in sh.placed:
            c = list(p['poly'].exterior.coords)
            for (x0, y0), (x1, y1) in zip(c, c[1:]):
                assert min(abs(x1 - x0), abs(y1 - y0)) < 1e-6   # every edge horizontal or vertical
    loose = nesting.Shape('l', 'L', outline, [], [], 1)
    assert nesting._rotations(loose, True) != (0, 90, 180, 270)   # the irregular L would otherwise be tried every 15 degrees


def test_vendors_rate_cards_and_job_order_estimate(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    with TestClient(app) as client:
        login_as(client, 'admin@example.com', 'admin')
        p, rev, part, tid, d = released_project(client, tmp_path)
        make_production_ready(client, rev, part)
        pr = client.get('/api/pricing', headers=H).json()
        base = pr['base_cards'][0]
        assert pr['can_manage'] and 'Coimbatore' in base['name']
        # a vendor starts from a copy of the base sheet; editing it does not touch the base
        v = client.post('/api/vendors', headers=H, json={'name': 'Kovai Laser', 'services': ['Laser cutting', 'Bending'], 'gstin': '33abcde1234f1z5'})
        assert v.status_code == 200, v.text
        v = v.json()
        assert v['gstin'] == '33ABCDE1234F1Z5' and v['rate_card']
        card = client.get('/api/rate-cards/' + v['rate_card_id']).json()
        card['data']['laser'] = [{**r, 'per_m': r['per_m'] * 2} for r in card['data']['laser']]
        card['data']['overheads']['margin_pct'] = 0
        assert client.put('/api/rate-cards/' + v['rate_card_id'], headers=H, json={'data': card['data']}).status_code == 200
        assert client.get('/api/rate-cards/' + base['id']).json()['data']['laser'][0]['per_m'] == 7
        # compare before creating
        est = client.post(f"/api/projects/{p['id']}/job-orders/estimate", headers=H, json={'quantity': 2, 'vendor_ids': ['', v['id']]})
        assert est.status_code == 200, est.text
        e_base, e_vendor = est.json()['estimates']
        assert e_base['vendor'] == 'Base rates' and e_vendor['vendor'] == 'Kovai Laser'
        assert e_base['total'] > 0 and e_vendor['parts'][0]['qty'] == 2
        lb = next(x for x in e_base['by_process'] if x['process'] == 'Laser cutting')['amount']
        lv = next(x for x in e_vendor['by_process'] if x['process'] == 'Laser cutting')['amount']
        assert abs(lv - 2 * lb) < 0.05
        # the job order keeps its vendor and estimate
        jo = client.post(f"/api/projects/{p['id']}/job-orders", headers=H, json={'title': 'Batch', 'quantity': 2, 'vendor_id': v['id']})
        assert jo.status_code == 200, jo.text
        jo = jo.json()
        assert jo['vendor_name'] == 'Kovai Laser' and jo['estimate']['total'] == e_vendor['total'] and jo['estimate_total'] == e_vendor['total']
        cmp = client.get(f"/api/job-orders/{jo['id']}/estimate/compare").json()
        assert {c['vendor'] for c in cmp} == {'Kovai Laser', 'Base rates'}
        again = client.post(f"/api/job-orders/{jo['id']}/estimate", headers=H, json={'vendor_id': ''}).json()
        assert again['vendor'] == 'Base rates' and client.get('/api/job-orders/' + jo['id']).json()['vendor_id'] == ''
        csv = client.get(f"/api/rate-cards/{base['id']}/export.csv")
        assert csv.status_code == 200 and 'laser' in csv.text
        assert client.post(f"/api/rate-cards/{base['id']}/copy", headers=H, json={'name': 'Chennai'}).json()['name'] == 'Chennai'
        assert client.post(f"/api/projects/{p['id']}/job-orders", headers=H, json={'title': 'x', 'vendor_id': 'nope'}).status_code == 422
        # the cost of one part, in the inspector: split per piece, setups spread over the quantity, curve and vendors
        pc = client.get(f"/api/parts/{part['id']}/cost?qty=10&compare=1")
        assert pc.status_code == 200, pc.text
        pc = pc.json()
        assert pc['qty'] == 10 and abs(sum(x['share'] for x in pc['split']) - 1) < 1e-3
        assert abs(pc['unit']['with_gst'] * 10 - pc['total']) < 0.1
        assert abs(sum(x['amount'] for x in pc['split']) - (pc['unit']['make'] + pc['unit']['setups'])) < 0.05
        curve = {x['qty']: x['unit_with_gst'] for x in pc['curve']}
        assert curve[1] > curve[10] >= curve[500]
        assert {x['vendor'] for x in pc['vendors']} == {'Base rates', 'Kovai Laser'}
        pv = client.get(f"/api/parts/{part['id']}/cost?qty=10&vendor_id={v['id']}").json()
        assert pv['vendor'] == 'Kovai Laser' and 'vendors' not in pv
        # people without planning rights see no money
        viewer = TestClient(app)
        login_as(viewer, 'viewer@example.com', 'viewer')
        j = viewer.get('/api/job-orders/' + jo['id']).json()
        assert 'estimate' not in j and j['estimate_total'] is None
        assert viewer.get('/api/pricing').status_code == 403
        assert viewer.post('/api/vendors', headers=H, json={'name': 'x'}).status_code == 403
        assert viewer.get(f"/api/parts/{part['id']}/cost").status_code == 403
