"""Part-level CAD replacement inside one revision.

A part keeps its id (so welds, assembly steps, aliases, specs, comments and job links stay attached); only its
geometry is swapped. The active version always lives in the part folder (parts/<pid>/), which every other part of
Forge reads. Every version also has a complete, frozen copy of its own files in parts/<pid>/versions/v<n>/ -
model, B-rep, flat pattern and its drawings - so an earlier version stays downloadable and can be made active
again, but is never used unless someone asks for it.

Version 1 is the geometry that came with the revision import; it is recorded the first time a part is replaced.
"""
import json, shutil, hashlib, traceback
from pathlib import Path
import numpy as np
from . import db

# Files that belong to one geometry version of a part (everything else in the part folder is per-part state).
VERSION_FILES = ('shape.brep', 'model.glb', 'thumb.png', 'flat.json', 'flat.dxf', 'flat.glb', 'drawing.pdf', 'drawing.dxf',
                 'review.pdf', 'part.step', 'projections.json', 'drawing-scene.json', 'characteristics.json', 'inspection.pdf',
                 'source.step', 'source.stp', 'source.igs', 'source.iges', 'source.brep')
DOWNLOADS = ('drawing.pdf', 'drawing.dxf', 'flat.dxf', 'part.step', 'thumb.png', 'review.pdf')


def part_dir(rid, pid):
    return db.revdir(rid) / 'parts' / pid


def version_dir(rid, pid, number):
    return part_dir(rid, pid) / 'versions' / f'v{int(number)}'


def _copy_files(src: Path, dst: Path, names=VERSION_FILES, clear=False):
    dst.mkdir(parents=True, exist_ok=True)
    if clear:
        for n in VERSION_FILES:
            if not n.startswith('source.'):
                (dst / n).unlink(missing_ok=True)
    for n in names:
        f = src / n
        if f.is_file():
            shutil.copy2(f, dst / n)


def versions(pid):
    rows = db.rows('SELECT * FROM part_versions WHERE part_id=? ORDER BY number', (pid,))
    out = []
    for r in rows:
        g = json.loads(r.get('geometry') or '{}')
        d = version_dir(r['revision_id'], pid, r['number'])
        out.append({'id': r['id'], 'number': r['number'], 'filename': r['filename'], 'sha256': r['sha256'], 'note': r['note'],
                    'created': r['created'], 'author': r['author'], 'status': r['status'], 'message': r['message'], 'active': bool(r['active']),
                    'warnings': json.loads(r.get('warnings') or '[]'),
                    'dimensions': g.get('dimensions'), 'mass_kg': g.get('mass_kg'), 'thickness': g.get('thickness'),
                    'bends': len(g.get('bends') or []), 'holes': len(g.get('holes') or []),
                    'flat_status': g.get('flat_status'), 'flat_message': g.get('flat_message'),
                    'files': [n for n in DOWNLOADS if (d / n).is_file()]})
    return out


def _snapshot_row(pid):
    """Current part state (as it would be restored)."""
    p = db.row('SELECT * FROM parts WHERE id=?', (pid,))
    edits = db.row('SELECT data FROM drawing_edits WHERE part_id=?', (pid,))
    return p, (edits or {}).get('data') or ''


def ensure_original(pid, actor='worker'):
    """Record version 1 (the imported geometry) with a frozen copy of its files, once."""
    if db.row('SELECT id FROM part_versions WHERE part_id=? LIMIT 1', (pid,)):
        return
    p, edits = _snapshot_row(pid)
    rid = p['revision_id']
    rev = db.row('SELECT filename,created,created_by FROM revisions WHERE id=?', (rid,))
    _copy_files(part_dir(rid, pid), version_dir(rid, pid, 1))
    g = json.loads(p['geometry'])
    with db.connect() as c:
        c.execute('INSERT INTO part_versions(id,part_id,revision_id,number,filename,sha256,note,created,author,status,message,active,geometry,spec,drawing_edits,warnings) '
                  'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                  (db.uid(), pid, rid, 1, (rev or {}).get('filename', 'revision import'), g.get('fingerprint', ''), 'Imported with the revision',
                   (rev or {}).get('created', db.now()), (rev or {}).get('created_by', actor), 'ready', '', 1, p['geometry'], p['spec'], edits, '[]'))


def _freeze_active(c, pid):
    """Store the current spec / drawing edits on the active version before it is superseded, and refresh its
    frozen files (drawings regenerated or reviewed after it became active)."""
    p = c.execute('SELECT * FROM parts WHERE id=?', (pid,)).fetchone()
    p = dict(p)
    cur = c.execute('SELECT * FROM part_versions WHERE part_id=? AND active=1', (pid,)).fetchone()
    if not cur:
        return None
    cur = dict(cur)
    edits = c.execute('SELECT data FROM drawing_edits WHERE part_id=?', (pid,)).fetchone()
    c.execute('UPDATE part_versions SET geometry=?,spec=?,drawing_edits=?,active=0 WHERE id=?',
              (p['geometry'], p['spec'], edits[0] if edits else '', cur['id']))
    _copy_files(part_dir(p['revision_id'], pid), version_dir(p['revision_id'], pid, cur['number']), clear=True)
    return cur


def _update_assembly_mesh(rid, pid, mesh_path):
    """Swap one part's mesh inside assembly.glb; placements (instances) are kept."""
    import trimesh
    folder = db.revdir(rid)
    asm = folder / 'assembly.glb'
    if not asm.exists():
        return
    scene = trimesh.load(asm, force='scene')
    if pid not in scene.geometry:
        raise ValueError('Part is not in the assembly model')
    scene.geometry[pid] = trimesh.load(mesh_path, force='mesh')
    tmp = folder / 'assembly.glb.tmp'
    scene.export(tmp, file_type='glb')
    tmp.replace(asm)


def _references(rid, pid):
    """Welds / joints / assembly steps that point at faces of this part: they must be re-checked."""
    n_joints = sum(1 for j in db.rows('SELECT data FROM joints WHERE revision_id=?', (rid,)) if pid in j['data'])
    n_steps = sum(1 for s in db.rows('SELECT data FROM assembly_steps WHERE revision_id=?', (rid,)) if pid in s['data'])
    return n_joints, n_steps


def _mark_pack_stale(rid, reason):
    (db.revdir(rid) / '.documents-stale').write_text(reason)


def process_replace(rid, payload):
    """Worker job: develop a new geometry version of one part (payload: part_id, version_id) or make an existing
    version active again (payload: part_id, activate=version_id)."""
    from .worker import progress
    pid = payload['part_id']
    if payload.get('activate'):
        return _activate(rid, pid, payload['activate'])
    vid = payload['version_id']
    try:
        _develop(rid, pid, vid, progress)
    except Exception as e:
        traceback.print_exc()
        with db.connect() as c:
            c.execute('UPDATE part_versions SET status="failed",message=? WHERE id=?', (str(e)[:1000], vid))
            db.audit(c, 'worker', 'part.replacement_failed', {'part': pid, 'version': vid, 'error': str(e)[:300]}, rid)
        raise


def _develop(rid, pid, vid, progress):
    from .cad import import_model, explore, analyze, mesh, BRepTools, TopAbs_SOLID, step_materials, density_for, bounds
    from .worker import export_flat, apply_defaults, process_documents
    from .drawings import render_meshes, thumb_color
    from .scrub import scrub
    import trimesh
    ver = db.row('SELECT * FROM part_versions WHERE id=?', (vid,))
    part = db.row('SELECT * FROM parts WHERE id=?', (pid,))
    if not ver or not part:
        raise ValueError('Part or version not found')
    rev = db.row('SELECT * FROM revisions WHERE id=?', (rid,))
    project = db.row('SELECT * FROM projects WHERE id=?', (rev['project_id'],))
    rules = json.loads(rev['manifest']).get('rules_snapshot', json.loads(project['rules']))
    settings = db.project_settings(rev['project_id'])
    vd = version_dir(rid, pid, ver['number'])
    source = next((vd / n for n in ('source.step', 'source.stp', 'source.igs', 'source.iges', 'source.brep') if (vd / n).exists()), None)
    if source is None:
        raise ValueError('Uploaded file is missing')
    name = part['name']
    progress(rid, 5, f'Replacing {name[:60]}: removing authoring metadata')
    if source.suffix.lower() in ('.step', '.stp', '.igs', '.iges'):
        scrub(source, 'source' + source.suffix.lower())
    progress(rid, 12, f'Replacing {name[:60]}: reading CAD')
    leaves = import_model(source)
    solids = [s for leaf in leaves for s in explore(leaf['shape'], TopAbs_SOLID)]
    if not solids:
        raise ValueError('No closed solid in the file; export the part as a solid body')
    if len(solids) > 1:
        raise ValueError(f'The file has {len(solids)} solid bodies; export only this one part (a single body)')
    solid = solids[0]
    old_g = json.loads(part['geometry']);old_spec = json.loads(part['spec'])
    g = analyze(solid, name)
    BRepTools.Write_s(solid, str(vd / 'shape.brep'))
    g['fingerprint'] = hashlib.sha256((vd / 'shape.brep').read_bytes()).hexdigest()
    same = g['fingerprint'] == old_g.get('fingerprint')
    # the engineer's classification and the source placement stay with the part
    g['category'] = part['category']
    g['classification_confidence'] = old_g.get('classification_confidence', 'engineer classified')
    for k in ('source_component', 'source_body', 'carried_from'):
        if k in old_g:
            g[k] = old_g[k]
    g['replaced'] = {'version': ver['number'], 'filename': ver['filename'], 'at': db.now(), 'by': ver['author']}
    g['recognition_notes'].append(f"Geometry replaced in this revision (version {ver['number']}, {ver['filename']}).")
    spec = dict(old_spec)
    if not same:
        # limits, verification notes and dispositions referred to the old features
        for k in ('feature_specs', 'rule_waivers', 'manual_checks'):
            spec[k] = {}
        spec['k_factor_approved'] = False
    try:
        sm = step_materials(source) if source.suffix.lower() in ('.step', '.stp') else {}
        meta = sm.get('*') or (next(iter(sm.values())) if len(sm) == 1 else {}) or {}
    except Exception:
        meta = {}
    if meta:
        g['step'] = meta
    apply_defaults(spec, g, settings, True)
    rho = (meta.get('density') * 1000 if meta.get('density') and meta['density'] < 30 else meta.get('density')) or density_for(spec.get('material'))
    if rho:
        g['mass_kg'] = round(g['volume'] * 1e-9 * rho, 4);g['mass_basis'] = 'STEP density' if meta.get('density') else 'material density'
    # Placement check: the assembly places the part by its own origin. A part re-exported from a different origin
    # would appear shifted - warn rather than guess an alignment.
    warnings = []
    ob, nb = np.array(old_g.get('bounds') or [0] * 6, float), np.array(g.get('bounds') or [0] * 6, float)
    if ob.any() and nb.any():
        oc, nc = (ob[:3] + ob[3:]) / 2, (nb[:3] + nb[3:]) / 2
        size = max(float(np.max(ob[3:] - ob[:3])), 1.0)
        if np.linalg.norm(oc - nc) > .25 * size:
            warnings.append(f'The new part is {np.linalg.norm(oc - nc):.0f} mm away from where the old one sat. Check it was exported in the part\'s own coordinates (same origin as in the assembly).')
        od, nd = sorted(ob[3:] - ob[:3]), sorted(nb[3:] - nb[:3])
        if any(abs(a - b) > max(1, .5 * a) for a, b in zip(od, nd)):
            warnings.append('Overall size changed a lot (' + ' x '.join(f'{v:.0f}' for v in sorted(ob[3:] - ob[:3], reverse=True)) + ' -> ' + ' x '.join(f'{v:.0f}' for v in sorted(nb[3:] - nb[:3], reverse=True)) + ' mm). Make sure this is the right part.')
    if part['category'] == 'sheet_metal' and g.get('thickness') and old_g.get('thickness') and abs(g['thickness'] - old_g['thickness']) > .01:
        warnings.append(f"Sheet thickness changed from {old_g['thickness']:.2f} to {g['thickness']:.2f} mm.")
    joints, steps = _references(rid, pid)
    if joints:
        warnings.append(f'{joints} weld/joint record{"s" if joints != 1 else ""} use faces of this part - re-check {"them" if joints != 1 else "it"} in Weld configuration.')
    if steps:
        warnings.append(f'{steps} assembly step{"s" if steps != 1 else ""} include this part - check the step views.')
    progress(rid, 30, f'Replacing {name[:60]}: features and flat pattern')
    export_flat(solid, g, spec, vd, json.loads(part.get('drawing_options') or '{}'))
    me = mesh(solid, rules['mesh_deflection']);me.export(vd / 'model.glb');g['triangles'] = len(me.faces)
    try:
        render_meshes([(me, np.eye(4))], vd / 'thumb.png', size=(640, 420), colors=[thumb_color({**dict(part), 'geometry': g, 'spec': spec})])
    except Exception:
        pass
    # ---- swap: freeze the active version, move the new files into the part folder
    progress(rid, 45, f'Replacing {name[:60]}: activating version {ver["number"]}')
    pf = part_dir(rid, pid)
    with db.connect() as c:
        c.execute('BEGIN IMMEDIATE')
        _freeze_active(c, pid)
        for n in VERSION_FILES:
            if not n.startswith('source.'):
                (pf / n).unlink(missing_ok=True)
        _copy_files(vd, pf, names=[n for n in VERSION_FILES if not n.startswith('source.')])
        c.execute("UPDATE parts SET geometry=?,spec=?,reviewed=0,reviewed_by='',reviewed_at='',doc_reviewed=0,doc_reviewed_by='',doc_reviewed_at='' WHERE id=?",
                  (json.dumps(g), json.dumps(spec), pid))
        c.execute('DELETE FROM drawing_edits WHERE part_id=?', (pid,))   # sheet edits referred to the old geometry; kept on the old version
        if not same:
            c.execute('DELETE FROM char_overrides WHERE part_id=?', (pid,))
        c.execute('UPDATE part_versions SET active=0 WHERE part_id=?', (pid,))
        c.execute('UPDATE part_versions SET active=1,status="ready",message=?,geometry=?,spec=?,warnings=? WHERE id=?',
                  ('Active', json.dumps(g), json.dumps(spec), json.dumps(warnings), vid))
        db.audit(c, ver['author'], 'part.replaced', {'part': pid, 'name': name, 'version': ver['number'], 'filename': ver['filename'], 'same_shape': same, 'warnings': warnings}, rid)
    _update_assembly_mesh(rid, pid, pf / 'model.glb')
    # ---- drawings for the new geometry (same pipeline as a single-part regeneration)
    progress(rid, 55, f'Replacing {name[:60]}: drawings')
    if part['category'] != 'purchased' and not part.get('excluded'):
        process_documents(rid, {'part_id': pid})
    _copy_files(pf, vd)
    with db.connect() as c:
        row = c.execute('SELECT geometry FROM parts WHERE id=?', (pid,)).fetchone()
        c.execute('UPDATE part_versions SET geometry=? WHERE id=?', (row[0], vid))
    _mark_pack_stale(rid, f'{name} replaced; regenerate the combined drawing PDFs and manufacturing pack')
    progress(rid, 100, f'{name[:60]} replaced (version {ver["number"]})')


def _activate(rid, pid, vid):
    """Make an earlier (or later) version the active one again, with its frozen files and drawings."""
    from .worker import progress
    ver = db.row('SELECT * FROM part_versions WHERE id=? AND part_id=?', (vid, pid))
    if not ver or ver['status'] != 'ready':
        raise ValueError('Only a successfully processed version can be used')
    vd = version_dir(rid, pid, ver['number']);pf = part_dir(rid, pid)
    if not (vd / 'shape.brep').exists() or not (vd / 'model.glb').exists():
        raise ValueError(f'Version {ver["number"]} files are missing')
    progress(rid, 20, f'Switching part to version {ver["number"]}')
    with db.connect() as c:
        c.execute('BEGIN IMMEDIATE')
        _freeze_active(c, pid)
        for n in VERSION_FILES:
            if not n.startswith('source.'):
                (pf / n).unlink(missing_ok=True)
        _copy_files(vd, pf, names=[n for n in VERSION_FILES if not n.startswith('source.')])
        g = ver['geometry'];spec = ver['spec']
        # the version's own drawings come back; reviews are not carried - the active geometry changed
        c.execute("UPDATE parts SET geometry=?,spec=?,reviewed=0,reviewed_by='',reviewed_at='',doc_reviewed=0,doc_reviewed_by='',doc_reviewed_at='' WHERE id=?", (g, spec, pid))
        c.execute('DELETE FROM drawing_edits WHERE part_id=?', (pid,))
        if ver.get('drawing_edits'):
            rev = c.execute('SELECT sha256 FROM revisions WHERE id=?', (rid,)).fetchone()
            c.execute('INSERT INTO drawing_edits(part_id,revision_id,source_hash,version,data,updated,author) VALUES(?,?,?,?,?,?,?)',
                      (pid, rid, rev[0], 0, ver['drawing_edits'], db.now(), ver['author']))
        c.execute('UPDATE part_versions SET active=0 WHERE part_id=?', (pid,))
        c.execute('UPDATE part_versions SET active=1 WHERE id=?', (vid,))
        db.audit(c, 'worker', 'part.version_activated', {'part': pid, 'version': ver['number']}, rid)
    _update_assembly_mesh(rid, pid, pf / 'model.glb')
    _mark_pack_stale(rid, 'A part version was changed; regenerate the combined drawing PDFs and manufacturing pack')
    progress(rid, 100, f'Part switched to version {ver["number"]}')
