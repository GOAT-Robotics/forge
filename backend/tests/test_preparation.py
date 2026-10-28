"""Preparation fills known facts/shared answers without granting approvals or overwriting engineering."""
import copy
import json

from fastapi.testclient import TestClient
from app import db
from app.main import app
from app.preparation import prepare_spec
from test_hardware import _fixture

H = {'X-Forge-Request': '1'}


def test_preparation_defaults_only_fill_known_empty_values():
    part = {'spec': {'material': 'Chosen steel', 'finish': 'Uncoated', 'operations': [{'name': 'Laser cutting'}, {'name': 'Bending'}]},
            'geometry': {'step': {'material': 'CAD aluminium'}}}
    result = prepare_spec(part, {'conventions': {'general_tolerance': 'Project tolerance'}}, {'finish': 'Paint', 'datums': 'Mounting face'})
    assert result['material'] == 'Chosen steel' and result['finish'] == 'Uncoated'
    assert result['process'] == 'Laser cutting + Bending'
    assert result['general_tolerance'] == 'Project tolerance' and result['datums'] == 'Mounting face'
    assert 'process' not in part['spec']
    assert prepare_spec(part, {'conventions': {'general_tolerance': 'Project tolerance'}}, {'general_tolerance': ''})['general_tolerance'] == 'Project tolerance'
    empty = prepare_spec({'spec': {}, 'geometry': {}}, {}, {})
    assert not empty  # no guessed material, finish, datums, process or approvals


def test_prepare_workflow_preserves_choices_queues_drawings_and_is_idempotent(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    with TestClient(app) as client:
        rid, pid, _, _ = _fixture(tmp_path, client)
        spec = {**copy.deepcopy(db.DEFAULT_SPEC), 'material': 'Chosen steel'}
        with db.connect() as c:
            c.execute('UPDATE parts SET spec=? WHERE id=?', (json.dumps(spec), pid))
        body = {'ids': [pid], 'groups': [{'ids': [pid], 'fill': {'material': 'Other steel', 'process': 'Laser cutting', 'finish': 'Uncoated', 'datums': 'A = mounting face'}}]}
        url = f'/api/revisions/{rid}/prepare'
        r = client.post(url, headers=H, json=body)
        assert r.status_code == 200, r.text
        assert r.json()['job'] and r.json()['updated'] == 1
        saved = db.row('SELECT * FROM parts WHERE id=?', (pid,))
        filled = json.loads(saved['spec'])
        assert filled['material'] == 'Chosen steel' and filled['process'] == 'Laser cutting'
        assert filled['general_tolerance'] == db.project_settings('hwproject')['conventions']['general_tolerance']
        assert not saved['reviewed'] and not saved['doc_reviewed']
        assert not filled['manual_checks'] and not filled['k_factor_approved'] and not filled['rule_waivers']
        assert client.post(url, headers=H, json=body).status_code == 409
        # Simulate successful drawing generation, then the same action does no work and preserves reviews.
        folder = db.revdir(rid) / 'parts' / pid
        (folder / 'drawing-scene.json').write_text('{}')
        (folder / '.drawing-invalid').unlink(missing_ok=True)
        with db.connect() as c:
            c.execute("UPDATE jobs SET status='complete'")
            c.execute('UPDATE parts SET reviewed=1,doc_reviewed=1 WHERE id=?', (pid,))
        again = client.post(url, headers=H, json=body).json()
        assert again['updated'] == 0 and again['job'] is None and again['results'][0]['missing'] == []
        assert db.row('SELECT reviewed,doc_reviewed FROM parts WHERE id=?', (pid,)) == {'reviewed': 1, 'doc_reviewed': 1}


def test_prepare_rejects_invalid_selection_before_changing_any_part(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    with TestClient(app) as client:
        rid, pid, _, _ = _fixture(tmp_path, client)
        before = db.row('SELECT spec FROM parts WHERE id=?', (pid,))['spec']
        url = f'/api/revisions/{rid}/prepare'
        cases = [
            {'ids': [pid, 'foreign'], 'groups': [{'ids': [pid], 'fill': {'material': 'Steel'}}]},
            {'ids': [pid], 'groups': [{'ids': ['foreign'], 'fill': {'material': 'Steel'}}]},
            {'ids': [pid], 'groups': [{'ids': [pid], 'fill': {'manual_checks': 'approved'}}]},
            {'ids': [pid], 'groups': [{'ids': [pid], 'fill': {}}, {'ids': [pid], 'fill': {}}]},
        ]
        for body in cases:
            assert client.post(url, headers=H, json=body).status_code == 422
            assert db.row('SELECT spec FROM parts WHERE id=?', (pid,))['spec'] == before
            assert not db.rows('SELECT * FROM jobs')
        assert client.post(url, json={'ids': [pid]}).status_code == 403
        with db.connect() as c:
            c.execute("UPDATE users SET role='viewer'")
        assert client.post(url, headers=H, json={'ids': [pid]}).status_code == 403


def test_prepare_skips_purchased_and_excluded_and_refuses_released(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    with TestClient(app) as client:
        rid, pid, _, _ = _fixture(tmp_path, client)
        url = f'/api/revisions/{rid}/prepare'
        with db.connect() as c:
            c.execute("UPDATE parts SET category='purchased' WHERE id=?", (pid,))
        result = client.post(url, headers=H, json={'ids': [pid]}).json()
        assert result == {'results': [], 'updated': 0, 'job': None}
        with db.connect() as c:
            c.execute("UPDATE parts SET category='sheet_metal',excluded=1 WHERE id=?", (pid,))
        assert client.post(url, headers=H, json={'ids': [pid]}).json()['job'] is None
        with db.connect() as c:
            c.execute("UPDATE revisions SET status='released' WHERE id=?", (rid,))
        assert client.post(url, headers=H, json={'ids': [pid]}).status_code == 409
