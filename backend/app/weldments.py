"""Weld assemblies (weldments): a named set of parts welded into one unit.

A part belongs to at most one weldment; a weld belongs to the weldment that holds its parts. The weld
configuration dialog works on one weldment: opening it on a selection joins that selection with the
weldments it touches. Revisions from before weldments existed get one per group of parts connected by
welds, named automatically.
"""
from __future__ import annotations

import json
import re

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from . import db
from .security import revision_access

router = APIRouter()


_ready = []


def ensure_table():
    """(db.init creates the table; this covers a database opened before the upgrade without a restart)"""
    if _ready:
        return
    with db.connect() as c:
        c.execute('CREATE TABLE IF NOT EXISTS weldments(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES revisions(id),name TEXT NOT NULL,parts TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,author TEXT NOT NULL)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_weldments ON weldments(revision_id)')
    _ready.append(1)


def _rows(rid):
    ensure_table()
    return [{**w, 'parts': json.loads(w['parts'])} for w in db.rows('SELECT * FROM weldments WHERE revision_id=? ORDER BY created', (rid,))]


def _welds(rid):
    return [{**j, 'data': json.loads(j['data'])} for j in db.rows("SELECT * FROM joints WHERE revision_id=? AND kind='weld' ORDER BY created", (rid,))]


def short_name(p):
    """A readable label for a part: its alias, else the name without CAD prefixes ('_ISO11GT-SM-017,BACK COVER' → 'BACK COVER')."""
    if p.get('alias'):
        return p['alias']
    name = str(p.get('name') or '').strip()
    if ',' in name:
        tail = name.rsplit(',', 1)[1].strip()
        name = tail or name
    return re.sub(r'\s+', ' ', name)[:40] or 'Weldment'


def auto_name(rid, parts, taken):
    """WLD-01 BACK COVER: the next free number and the heaviest (else largest) part."""
    rows = db.rows(f"SELECT id,name,alias,geometry FROM parts WHERE revision_id=? AND id IN ({','.join('?' * len(parts))})", (rid, *parts)) if parts else []

    def weight(p):
        g = json.loads(p['geometry'] or '{}')
        dims = g.get('dimensions') or [0, 0, 0]
        return (float(g.get('mass_kg') or 0), float(dims[0] or 0) * float(dims[1] or 0) * float(dims[2] or 0) if len(dims) == 3 else 0)
    main = max(rows, key=weight) if rows else {}
    n = 1
    while any(re.match(rf'WLD-{n:02d}\b', t) for t in taken):
        n += 1
    name = f"WLD-{n:02d} {short_name(main) if main else ''}".strip()
    return name


def weldment_of(groups, parts):
    for w in groups:
        if set(parts) & set(w['parts']):
            return w
    return None


def sync(rid, editable):
    """Weldments for the revision; welds not covered by one (older revisions) get one per connected group.
    Stored when the revision can be edited, else returned as computed groups."""
    groups = _rows(rid)
    covered = {p for w in groups for p in w['parts']}
    parent = {}

    def find(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    loose = [w for w in _welds(rid) if not set(w['data'].get('parts') or []) & covered]
    for w in loose:
        ids = w['data'].get('parts') or []
        for a in ids[1:]:
            parent[find(a)] = find(ids[0])
        if ids:
            find(ids[0])
    new = {}
    for p in parent:
        new.setdefault(find(p), []).append(p)
    taken = [w['name'] for w in groups]
    for parts in new.values():
        name = auto_name(rid, parts, taken)
        taken.append(name)
        w = {'id': db.uid(), 'revision_id': rid, 'name': name, 'parts': sorted(parts), 'created': db.now(), 'updated': db.now(), 'author': 'Forge'}
        if editable:
            with db.connect() as c:
                c.execute('INSERT INTO weldments VALUES(?,?,?,?,?,?,?)', (w['id'], rid, w['name'], json.dumps(w['parts']), w['created'], w['updated'], w['author']))
        groups.append(w)
    return groups


def listing(rid, editable=False):
    welds = _welds(rid)
    out = []
    for w in sync(rid, editable):
        ids = [j['id'] for j in welds if set(j['data'].get('parts') or []) & set(w['parts'])]
        out.append({**w, 'welds': ids})
    return out


def _editable(rid):
    from .workspace import editable_revision
    try:
        editable_revision(rid)
        return True
    except HTTPException:
        return False


class WeldmentIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    parts: list[str] = Field(default_factory=list, max_length=200)
    name: str | None = Field(default=None, max_length=120)


def _check_parts(rid, parts):
    for pid in parts:
        if not db.row('SELECT id FROM parts WHERE id=? AND revision_id=?', (pid, rid)):
            raise HTTPException(422, 'Part outside revision')


def _unique(rid, name, own=None):
    if any(w['name'].lower() == name.lower() and w['id'] != own for w in _rows(rid)):
        raise HTTPException(409, f'Another weld assembly is already called "{name}"')


def _touch(rid):
    (db.revdir(rid) / 'welding.pdf').unlink(missing_ok=True)


@router.get('/api/revisions/{rid}/weldments')
def get_weldments(rid: str, request: Request):
    revision_access(request, rid)
    return listing(rid, _editable(rid))


@router.post('/api/revisions/{rid}/weldments')
def open_weldment(rid: str, a: WeldmentIn, request: Request):
    """The weldment for a selection: the selected parts joined with every weldment they touch (those are
    merged into the first one). A new one is named automatically unless a name is given."""
    u = revision_access(request, rid, True, 'part.edit')
    from .workspace import editable_revision
    editable_revision(rid)
    parts = list(dict.fromkeys(a.parts))
    if not parts:
        raise HTTPException(422, 'Select the parts to weld')
    _check_parts(rid, parts)
    groups = sync(rid, True)
    hit = [w for w in groups if set(w['parts']) & set(parts)]
    name = (a.name or '').strip()
    with db.connect() as c:
        if hit:
            keep = hit[0]
            merged = list(dict.fromkeys(keep['parts'] + [p for w in hit[1:] for p in w['parts']] + parts))
            if name:
                _unique(rid, name, keep['id'])
            c.execute('UPDATE weldments SET parts=?,name=?,updated=? WHERE id=?', (json.dumps(merged), name or keep['name'], db.now(), keep['id']))
            for w in hit[1:]:
                c.execute('DELETE FROM weldments WHERE id=?', (w['id'],))
            if len(hit) > 1 or len(merged) != len(keep['parts']):
                db.audit(c, u['name'], 'weldment.updated', {'id': keep['id'], 'parts': merged, 'merged': [w['id'] for w in hit[1:]]}, rid)
            wid = keep['id']
        else:
            if name:
                _unique(rid, name)
            wid = db.uid()
            name = name or auto_name(rid, parts, [w['name'] for w in groups])
            c.execute('INSERT INTO weldments VALUES(?,?,?,?,?,?,?)', (wid, rid, name, json.dumps(parts), db.now(), db.now(), u['name']))
            db.audit(c, u['name'], 'weldment.created', {'id': wid, 'name': name, 'parts': parts}, rid)
    _touch(rid)
    return next(w for w in listing(rid, True) if w['id'] == wid)


@router.put('/api/weldments/{wid}')
def edit_weldment(wid: str, a: WeldmentIn, request: Request):
    """Rename, or change the parts. Parts taken out take their welds with them."""
    ensure_table()
    w = db.row('SELECT * FROM weldments WHERE id=?', (wid,))
    if not w:
        raise HTTPException(404, 'Weld assembly not found')
    rid = w['revision_id']
    u = revision_access(request, rid, True, 'part.edit')
    from .workspace import editable_revision
    editable_revision(rid)
    old = json.loads(w['parts'])
    parts = list(dict.fromkeys(a.parts)) if a.parts else old
    _check_parts(rid, parts)
    name = (a.name if a.name is not None else w['name']).strip()
    if not name:
        name = auto_name(rid, parts, [x['name'] for x in _rows(rid) if x['id'] != wid])
    _unique(rid, name, wid)
    others = {p for x in _rows(rid) if x['id'] != wid for p in x['parts']}
    if set(parts) & others:
        raise HTTPException(409, 'A part can be in one weld assembly only')
    removed = set(old) - set(parts)
    dropped = [j for j in _welds(rid) if set(j['data'].get('parts') or []) & removed]
    with db.connect() as c:
        c.execute('UPDATE weldments SET name=?,parts=?,updated=? WHERE id=?', (name, json.dumps(parts), db.now(), wid))
        for j in dropped:
            c.execute('DELETE FROM joints WHERE id=?', (j['id'],))
        db.audit(c, u['name'], 'weldment.updated', {'id': wid, 'name': name, 'parts': parts, 'welds_removed': [j['id'] for j in dropped]}, rid)
    _touch(rid)
    return {**next(x for x in listing(rid, True) if x['id'] == wid), 'removed_welds': len(dropped)}


@router.delete('/api/weldments/{wid}')
def delete_weldment(wid: str, request: Request):
    """Removes the weld assembly and all its welds."""
    ensure_table()
    w = db.row('SELECT * FROM weldments WHERE id=?', (wid,))
    if not w:
        raise HTTPException(404, 'Weld assembly not found')
    rid = w['revision_id']
    u = revision_access(request, rid, True, 'part.edit')
    from .workspace import editable_revision
    editable_revision(rid)
    parts = set(json.loads(w['parts']))
    dropped = [j for j in _welds(rid) if set(j['data'].get('parts') or []) & parts]
    with db.connect() as c:
        c.execute('DELETE FROM weldments WHERE id=?', (wid,))
        for j in dropped:
            c.execute('DELETE FROM joints WHERE id=?', (j['id'],))
        db.audit(c, u['name'], 'weldment.deleted', {'id': wid, 'name': w['name'], 'welds_removed': [j['id'] for j in dropped]}, rid)
    _touch(rid)
    return {'ok': True, 'removed_welds': len(dropped)}


class WeldIds(BaseModel):
    model_config = ConfigDict(extra='forbid')
    ids: list[str] = Field(min_length=1, max_length=2000)


@router.post('/api/revisions/{rid}/welds/delete')
def delete_welds(rid: str, a: WeldIds, request: Request):
    """Several welds at once (select and delete, clear all)."""
    u = revision_access(request, rid, True, 'part.edit')
    from .workspace import editable_revision
    editable_revision(rid)
    found = [j for j in _welds(rid) if j['id'] in set(a.ids)]
    with db.connect() as c:
        for j in found:
            c.execute('DELETE FROM joints WHERE id=?', (j['id'],))
        db.audit(c, u['name'], 'joint.deleted', {'ids': [j['id'] for j in found], 'count': len(found)}, rid)
    _touch(rid)
    return {'removed': len(found)}


def name_of(rid, part_ids):
    """Name of the weldment holding these parts ('' when none) — for job orders and documents."""
    try:
        w = weldment_of(_rows(rid), part_ids)
    except Exception:
        return ''
    return w['name'] if w else ''
