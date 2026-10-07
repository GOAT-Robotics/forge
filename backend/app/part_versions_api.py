"""API for part-level CAD replacement (see replace.py)."""
import json, shutil
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from . import db
from .security import revision_access, editor
from .access import project_of_revision
from . import replace as R

router = APIRouter()


def _part(pid):
    p = db.row('SELECT * FROM parts WHERE id=?', (pid,))
    if not p:
        raise HTTPException(404, 'Part not found')
    return p


def _mutable(rid):
    r = db.row('SELECT * FROM revisions WHERE id=?', (rid,))
    if not r:
        raise HTTPException(404, 'Revision not found')
    if r['state'] != 'active' or r['status'] != 'ready':
        raise HTTPException(409, 'Part geometry can only be replaced in the active revision before it is released.')
    if db.row('SELECT id FROM jobs WHERE revision_id=? AND kind NOT IN ("instructions","welding") AND status IN ("queued","running","cancelling")', (rid,)):
        raise HTTPException(409, 'A CAD job is running on this revision; try again when it finishes')
    return r


def check_replace_allowed(request, pid):
    """Permission + state check before an upload is accepted for a part."""
    p = _part(pid)
    u = editor(request, 'part.edit', project_of_revision(p['revision_id']))
    _mutable(p['revision_id'])
    return p, u


def start_replacement(pid, u, assembled, filename, ext, size, sha, note=''):
    """Called when the (chunked) upload of a replacement file completes: records the version and queues the job."""
    p = _part(pid)
    rid = p['revision_id']
    try:
        _mutable(rid)
    except HTTPException:
        assembled.unlink(missing_ok=True)
        raise
    if size < 30:
        assembled.unlink(missing_ok=True)
        raise HTTPException(422, 'Empty or invalid CAD file')
    R.ensure_original(pid, u['name'])
    from .main import enqueue
    with db.connect() as c:
        c.execute('BEGIN IMMEDIATE')
        if c.execute('SELECT id FROM part_versions WHERE part_id=? AND status="processing"', (pid,)).fetchone():
            assembled.unlink(missing_ok=True)
            raise HTTPException(409, 'A replacement for this part is already being processed')
        n = c.execute('SELECT COALESCE(MAX(number),0)+1 FROM part_versions WHERE part_id=?', (pid,)).fetchone()[0]
        vd = R.version_dir(rid, pid, n)
        vd.mkdir(parents=True, exist_ok=True)
        shutil.move(str(assembled), vd / ('source' + ext))
        vid = db.uid()
        c.execute('INSERT INTO part_versions(id,part_id,revision_id,number,filename,sha256,note,created,author,status,message,active) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)',
                  (vid, pid, rid, n, filename, sha, note[:2000], db.now(), u['name'], 'processing', 'Queued'))
        job = enqueue(c, rid, 'replace', {'part_id': pid, 'version_id': vid})
        db.audit(c, u['name'], 'part.replacement_uploaded', {'part': pid, 'name': p['name'], 'version': n, 'filename': filename, 'sha256': sha, 'bytes': size}, rid)
    return {'part_id': pid, 'version_id': vid, 'number': n, 'job_id': job, 'revision_id': rid}


@router.get('/api/parts/{pid}/versions')
def list_versions(pid: str, request: Request):
    p = _part(pid)
    revision_access(request, p['revision_id'])
    out = R.versions(pid)
    if not out:   # never replaced: the imported geometry is the only version
        g = json.loads(p['geometry'])
        rev = db.row('SELECT filename,created,created_by FROM revisions WHERE id=?', (p['revision_id'],)) or {}
        out = [{'id': 'original', 'number': 1, 'filename': rev.get('filename', ''), 'note': 'Imported with the revision', 'created': rev.get('created', ''),
                'author': rev.get('created_by', ''), 'status': 'ready', 'message': '', 'active': True, 'warnings': [], 'dimensions': g.get('dimensions'),
                'mass_kg': g.get('mass_kg'), 'thickness': g.get('thickness'), 'bends': len(g.get('bends') or []), 'holes': len(g.get('holes') or []),
                'flat_status': g.get('flat_status'), 'flat_message': g.get('flat_message'), 'files': [], 'current_files': True}]
    return {'versions': out}


class Activate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    note: str = Field(default='', max_length=500)


@router.post('/api/parts/{pid}/versions/{vid}/activate')
def activate_version(pid: str, vid: str, request: Request):
    p, u = check_replace_allowed(request, pid)
    v = db.row('SELECT * FROM part_versions WHERE id=? AND part_id=?', (vid, pid))
    if not v:
        raise HTTPException(404, 'Version not found')
    if v['active']:
        raise HTTPException(409, 'This version is already in use')
    if v['status'] != 'ready':
        raise HTTPException(409, 'Only a successfully processed version can be used')
    from .main import enqueue
    with db.connect() as c:
        job = enqueue(c, p['revision_id'], 'replace', {'part_id': pid, 'activate': vid})
        db.audit(c, u['name'], 'part.version_requested', {'part': pid, 'version': v['number']}, p['revision_id'])
    return {'job_id': job}


@router.get('/api/parts/{pid}/versions/{vid}/files/{filename}')
def version_file(pid: str, vid: str, filename: str, request: Request):
    p = _part(pid)
    access = revision_access(request, p['revision_id'])
    v = db.row('SELECT * FROM part_versions WHERE id=? AND part_id=?', (vid, pid))
    if not v:
        raise HTTPException(404, 'Version not found')
    if filename not in R.DOWNLOADS:
        raise HTTPException(404, 'File not available')
    if filename in ('part.step', 'drawing.dxf', 'flat.dxf'):
        from .main import cad_download
        cad_download(access, p['revision_id'])
    f = R.version_dir(p['revision_id'], pid, v['number']) / filename
    if not f.is_file():
        raise HTTPException(404, 'This version has no such file')
    stem = p['name'].replace('/', '_') + f'_v{v["number"]}_'
    return FileResponse(f, filename=stem + filename if filename.endswith(('.pdf', '.dxf', '.step')) else None)
