import time,json,traceback,os,zipfile,hashlib
from pathlib import Path
import numpy as np
import trimesh,ezdxf
from . import db,storage
from .cad import import_model,explore,analyze,mesh,BRepTools,TopAbs_SOLID,bounds,classify_name,hidden_by_default,classify_prefix
from .unfold import unfold
from .drawings import make_part,assembly_pdf,render_meshes,combined_canvas,thumb_color

def progress(rid,p,message):
 with db.connect() as c:c.execute('UPDATE revisions SET progress=?,message=? WHERE id=?',(p,message,rid))
def parts_for(rid):
 ps=db.rows('SELECT * FROM parts WHERE revision_id=? ORDER BY name',(rid,))
 for p in ps:p['geometry']=json.loads(p['geometry']);p['spec']=json.loads(p['spec'])
 return ps

def export_flat(shape,g,spec,folder):
 if g['category']!='sheet_metal':return
 try:
  poly,bends=unfold(shape,g,spec.get('k_factor',.4));flat={'outline':list(poly.exterior.coords),'holes':[list(r.coords) for r in poly.interiors],'bends':bends,'k_factor':spec.get('k_factor',.4),'status':'provisional' if not spec.get('k_factor_approved') else 'approved_k'}
  (folder/'flat.json').write_text(json.dumps(flat));d=ezdxf.new('R2013');d.units=4;m=d.modelspace();d.layers.new('CUT');d.layers.new('BEND',dxfattribs={'color':3});d.layers.new('LABELS',dxfattribs={'color':2})
  for coords in [flat['outline']]+flat['holes']:m.add_lwpolyline(coords,close=True,dxfattribs={'layer':'CUT'})
  for b in bends:m.add_line(b['a'],b['b'],dxfattribs={'layer':'BEND'});m.add_text(f"{b['id']} {b['angle']:.1f}deg {b.get('direction','').upper()} R{b['radius']:.2f}",dxfattribs={'height':2.5,'insert':b['a'],'layer':'LABELS'})
  m.add_text('DEVELOPED GEOMETRY - '+flat['status'].upper()+' - VERIFY TOOLING',dxfattribs={'height':3,'insert':(poly.bounds[0],poly.bounds[1]-8),'layer':'LABELS'});d.saveas(folder/'flat.dxf')
  flatmesh=trimesh.creation.extrude_polygon(poly,g['thickness'],engine='earcut');flatmesh.export(folder/'flat.glb');g['flat_status']='supported';g['flat_bounds']=list(poly.bounds);g['flat_message']='Developed using configured K; tooling verification required.'
 except Exception as e:
  g['flat_status']='needs_review';g['flat_message']=str(e)
  for name in ['flat.json','flat.dxf','flat.glb']:(folder/name).unlink(missing_ok=True)

def detect_fits(parts,instances):
 buckets={};result=[]
 for p in parts:
  g=p['geometry']
  if p['category']=='purchased':continue
  for instance in instances.get(p['id'],[]):
   T=np.array(instance['matrix']);R=T[:3,:3];t=T[:3,3]
   for kind,features in [('hole',g['holes']),('shaft',g['shafts'])]:
    for f in features:
     d=R@np.array(f['axis']);d*=1 if d[np.argmax(abs(d))]>=0 else -1;o=R@np.array(f['center'])+t;o-=d*np.dot(o,d)
     key=tuple(np.round(d,3))+tuple(np.round(o,1));buckets.setdefault(key,[]).append((p,f,kind,T,instance))
 for group in buckets.values():
  for a,h,_,Ta,ia in [x for x in group if x[2]=='hole']:
   for b,shaft,_,Tb,ib in [x for x in group if x[2]=='shaft']:
    if a['id']==b['id'] or abs(h['diameter']-shaft['diameter'])>1.0:continue
    axis=Ta[:3,:3]@np.array(h['axis']);ca=Ta[:3,:3]@np.array(h['center'])+Ta[:3,3];cb=Tb[:3,:3]@np.array(shaft['center'])+Tb[:3,3]
    if np.linalg.norm((cb-ca)-axis*np.dot(cb-ca,axis))>.05:continue
    if abs(np.dot(cb-ca,axis))>=(h['depth']+shaft['depth'])/2:continue
    data={'label':f'M{len(result)+1:03d}','part_a':a['id'],'part_a_name':a['name'],'feature_a':h['id'],'part_b':b['id'],'part_b_name':b['name'],'feature_b':'External cylinder','nominal_clearance':round(h['diameter']-shaft['diameter'],5),'fit':'','instructions':'','torque':'','hole_min':None,'hole_max':None,'shaft_min':None,'shaft_max':None,'evidence':'Coaxial full cylinders with axial overlap; nominal candidate only','instance_a':ia['path'],'instance_b':ib['path'],'matrix_a':ia['matrix'],'matrix_b':ib['matrix']}
    if not any(r['part_a']==data['part_a'] and r['part_b']==data['part_b'] and r['feature_a']==data['feature_a'] for r in result):result.append(data)
 return result

def process_import(rid):
 rev=db.row('SELECT * FROM revisions WHERE id=?',(rid,));folder=db.revdir(rid);project=db.row('SELECT * FROM projects WHERE id=?',(rev['project_id'],));rules=json.loads(rev['manifest']).get('rules_snapshot',json.loads(project['rules']));source=folder/('source'+Path(rev['filename']).suffix.lower())
 progress(rid,3,'Reading CAD assembly and preserving component placements');leaves=import_model(source)
 if source.suffix in ('.brep','.brp','.igs','.iges') and len(leaves)==1:leaves[0]['name']=Path(rev['filename']).stem
 scene=trimesh.Scene();parts=[];instances={};assembly_meshes=[];warnings=[];num=0;settings=db.settings()
 # Engineering data from the current active revision is carried into the new one (by name, then by shape),
 # so specifications only need editing where the design changed. Approvals are never carried.
 previous={};prev_rev=db.row('SELECT * FROM revisions WHERE project_id=? AND state="active" AND id!=?',(rev['project_id'],rid))
 if prev_rev and settings.get('carry_over_specs',True):
  for old in db.rows('SELECT * FROM parts WHERE revision_id=?',(prev_rev['id'],)):
   old['geometry']=json.loads(old['geometry']);old['spec']=json.loads(old['spec'])
   previous.setdefault('name:'+old['name'],old);previous.setdefault('fp:'+old['geometry'].get('fingerprint',''),old)
 carried=0
 with db.connect() as c:c.execute('DELETE FROM fits WHERE revision_id=?',(rid,));c.execute('DELETE FROM parts WHERE revision_id=?',(rid,))
 for i,leaf in enumerate(leaves):
  progress(rid,5+int(65*i/max(len(leaves),1)),f"Analyzing {i+1}/{len(leaves)}: {leaf['name'][:80]}")
  solids=list(explore(leaf['shape'],TopAbs_SOLID))
  if not solids:
   # Surface-only supplier models can still appear in the assembly viewer, but cannot be released as solids.
   warnings.append({'component':leaf['name'],'reason':'No closed solid; represented as surface model if tessellation succeeds'})
   try:
    me=mesh(leaf['shape'],rules['mesh_deflection'])
    scene.geometry['surface_'+leaf['key']]=me
    for j,inst in enumerate(leaf['instances']):scene.graph.update(frame_to='surface_'+leaf['key']+'::'+str(j),matrix=np.array(inst['matrix']),geometry='surface_'+leaf['key'])
   except Exception:pass
   continue
  for bi,solid in enumerate(solids,1):
   num+=1;pid=rid[:10]+'_'+leaf['key']+'_'+str(bi);name=leaf['name']+(f' / Body {bi}' if len(solids)>1 else '');pf=folder/'parts'/pid;pf.mkdir(parents=True,exist_ok=True);BRepTools.Write_s(solid,str(pf/'shape.brep'))
   g=analyze(solid,name)
   import re
   provenance=' / '.join(i['path'] for i in leaf['instances'][:1])
   supplier=bool(re.search(r'T806-ZJ|HKT-WDS|FD125|ELVM|iHawk|Southco|MICHCASTER|WAVESHARE|JK_FENNER|XWST|LTO 48|XB5AS|XB5AW|P3767|2ELD',provenance,re.I))
   if supplier and classify_name(name)!='custom':g['category']='purchased';g['recognition_notes'].append('Purchased candidate inferred from supplier assembly ancestry; confirm make/buy classification.')
   by_prefix=classify_prefix(name,settings)
   if by_prefix:g['category']=by_prefix;g['classification_confidence']='workspace prefix rule';g['recognition_notes'].append('Category set by the workspace part-number prefix rule.')
   g['source_component']=leaf['key'];g['source_body']=bi;g['fingerprint']=hashlib.sha256((pf/'shape.brep').read_bytes()).hexdigest();spec=dict(db.DEFAULT_SPEC);spec['k_factor']=rules['k_factor']
   excluded=0;exclusion_reason='';hidden_override=None;excluded_by='';excluded_at=''
   old=previous.get('name:'+name) or previous.get('fp:'+g['fingerprint'])
   if old:
    same_shape=old['geometry'].get('fingerprint')==g['fingerprint'];carried+=1
    for key,value in old['spec'].items():
     if key in ('feature_specs','rule_waivers','manual_checks'):spec[key]=value if same_shape else {}
     elif key=='k_factor_approved':spec[key]=bool(value) and same_shape
     else:spec[key]=value
    if old['geometry'].get('classification_confidence')=='engineer classified':g['category']=old['category'];g['classification_confidence']='engineer classified'
    excluded=int(old.get('excluded') or 0);exclusion_reason=old.get('exclusion_reason') or '';hidden_override=int(old.get('hidden') or 0);excluded_by=old.get('excluded_by') or '';excluded_at=old.get('excluded_at') or ''
    g['carried_from']={'revision':prev_rev['number'],'match':'name' if previous.get('name:'+name) is old else 'shape','same_shape':same_shape,'part':old['name']}
    g['recognition_notes'].append(f"Specification carried over from revision {prev_rev['number']} ({'identical shape' if same_shape else 'shape changed: feature limits, verification notes and dispositions were not carried'}). Review before release.")
   export_flat(solid,g,spec,pf)
   me=mesh(solid,rules['mesh_deflection']);me.export(pf/'model.glb');g['triangles']=len(me.faces)
   # Small bought-in items (terminal blocks, lidars, connectors, fasteners ...) clutter the viewer; hide them by default.
   hidden=hidden_override if hidden_override is not None else int(hidden_by_default(name,g['category'],provenance,settings))
   p={'id':pid,'revision_id':rid,'name':name,'category':g['category'],'quantity':len(leaf['instances']),'geometry':g,'spec':spec,'reviewed':0,'hidden':hidden,'excluded':excluded,'exclusion_reason':exclusion_reason};parts.append(p);instances[pid]=leaf['instances']
   try:render_meshes([(me,np.eye(4))],pf/'thumb.png',size=(640,420),colors=[thumb_color(p)])
   except Exception:pass
   scene.geometry[pid]=me
   for j,inst in enumerate(leaf['instances']):
    T=np.array(inst['matrix']);scene.graph.update(frame_to=pid+'::'+str(j),matrix=T,geometry=pid)
    assembly_meshes.append((me,T))
   with db.connect() as c:c.execute('INSERT INTO parts(id,revision_id,name,category,quantity,geometry,spec,reviewed,hidden,excluded,exclusion_reason,excluded_by,excluded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',(pid,rid,name,p['category'],p['quantity'],json.dumps(g),json.dumps(spec),0,hidden,excluded,exclusion_reason,excluded_by,excluded_at))
 if not parts:raise ValueError('No usable solid bodies found; export solids as STEP or BREP')
 progress(rid,73,'Writing lightweight assembly mesh');scene.export(folder/'assembly.glb');(folder/'instances.json').write_text(json.dumps(instances));progress(rid,78,'Detecting mating surfaces')
 fits=detect_fits(parts,instances)
 with db.connect() as c:
  for f in fits:c.execute('INSERT INTO fits VALUES(?,?,?,0)',(db.uid(),rid,json.dumps(f)))
 progress(rid,82,'Rendering assembly documentation')
 if assembly_meshes:render_meshes(assembly_meshes,folder/'assembly.png')
 manifest={'rules_snapshot':rules,'part_count':len(parts),'component_definitions':len(leaves),'occurrences':sum(p['quantity'] for p in parts),'triangles':sum(p['geometry']['triangles']*p['quantity'] for p in parts),'warnings':warnings,'units':'mm','mesh_deflection':rules['mesh_deflection'],'fit_candidates':len(fits),'carried_over':carried,'carried_from':prev_rev['number'] if prev_rev else None,'rule_coverage':'Configured geometry and workflow rules only; manual checks explicitly required','unsupported':['Native proprietary CAD formats','General double-curved sheet forming','Automatic structural certification','Automatic thread specification recovery'],'instances_file':'instances.json'}
 # Only promote successful revisions; archive the prior active version atomically.
 with db.connect() as c:
  c.execute('UPDATE revisions SET state="archived" WHERE project_id=? AND state="active"',(rev['project_id'],));c.execute('UPDATE revisions SET state="active",status="ready",progress=100,message="Analysis complete",manifest=? WHERE id=?',(json.dumps(manifest),rid));db.audit(c,'worker','revision.activated',manifest,rid)
 rev=db.row('SELECT * FROM revisions WHERE id=?',(rid,));assembly_pdf(rev,parts,[{'id':str(i),'data':f,'approved':False} for i,f in enumerate(fits)],folder,detailed=False)

def process_documents(rid,payload):
 rev=db.row('SELECT * FROM revisions WHERE id=?',(rid,));folder=db.revdir(rid);project=db.row('SELECT * FROM projects WHERE id=?',(rev['project_id'],));rules=json.loads(rev['manifest']).get('rules_snapshot',json.loads(project['rules']));
 if payload.get('release'):rev['status']='released'
 parts=parts_for(rid);full=not payload.get('part_id')
 selected=[p for p in parts if p['id']==payload.get('part_id')] if not full else [p for p in parts if p['category']!='purchased' and not p.get('excluded')]
 from .cad import read_brep
 # Whole-pack runs also produce one PDF per discipline: every machining sheet in one file, every sheet-metal sheet in another.
 combined={}
 if full:
  groups={'machining':[p for p in selected if p['category']!='sheet_metal'],'sheet_metal':[p for p in selected if p['category']=='sheet_metal']}
  for key,group in groups.items():
   name='machining-drawings.pdf' if key=='machining' else 'sheet-metal-drawings.pdf'
   (folder/name).unlink(missing_ok=True)
   if group:combined[key]=combined_canvas(folder/name,'Machining drawings' if key=='machining' else 'Sheet metal drawings',rev,group)
 for i,p in enumerate(selected):
  progress(rid,int(85*i/max(len(selected),1)),f"Drawing {i+1}/{len(selected)}: {p['name'][:60]}");pf=folder/'parts'/p['id'];export_flat(read_brep(pf/'shape.brep'),p['geometry'],p['spec'],pf)
  if payload.get('release'):
   from .rules import evaluate
   failures=[f for f in evaluate(p['geometry'],p['spec'],rules) if f['severity']=='blocker' and (not f['waiver'] or f['code'] in ('GEO001','FLAT001'))]
   if failures:raise ValueError('Release checks changed during regeneration: '+p['name']+' '+str([f['code'] for f in failures]))
  make_part(p,rev,pf,rules,combined=combined.get('sheet_metal' if p['category']=='sheet_metal' else 'machining'))
  if not (pf/'thumb.png').exists():
   try:render_meshes([(trimesh.load(pf/'model.glb',force='mesh'),np.eye(4))],pf/'thumb.png',size=(640,420),colors=[thumb_color(p)])
   except Exception:pass
  with db.connect() as c:c.execute('UPDATE parts SET geometry=? WHERE id=?',(json.dumps(p['geometry']),p['id']))
 for c in combined.values():c.save()
 progress(rid,88,'Generating assembly and mating drawings')
 fits=db.rows('SELECT * FROM fits WHERE revision_id=?',(rid,))
 for f in fits:f['data']=json.loads(f['data'])
 if not payload.get('part_id') or not (folder/'assembly.pdf').exists():assembly_pdf(rev,parts,fits,folder,detailed=not bool(payload.get('part_id')))
 if not payload.get('part_id'):
  progress(rid,97,'Packaging manufacturing documents')
  with zipfile.ZipFile(folder/'manufacturing-pack.zip','w',zipfile.ZIP_DEFLATED) as z:
   z.write(folder/'assembly.pdf','assembly.pdf');
   for extra in ['assembly.dxf','machining-drawings.pdf','sheet-metal-drawings.pdf']:
    if (folder/extra).exists():z.write(folder/extra,extra)
   z.writestr('parts.json',json.dumps(parts,indent=2));z.writestr('fits.json',json.dumps(fits,indent=2));z.writestr('revision.json',json.dumps(rev,indent=2))
   for p in selected:
    for fn in ['drawing.pdf','drawing.dxf','flat.dxf','flat.json','part.step']:
     f=folder/'parts'/p['id']/fn
     if f.exists():z.write(f,f"parts/{p['id']}/{fn}")
 if payload.get('release'):
  with db.connect() as c:c.execute('UPDATE revisions SET status="released" WHERE id=?',(rid,));db.audit(c,'worker','revision.released',{},rid)
 progress(rid,100,'Documents generated')

def run_once():
 with db.connect() as c:
  c.execute('BEGIN IMMEDIATE');job=c.execute('SELECT * FROM jobs WHERE status="queued" ORDER BY created LIMIT 1').fetchone()
  if not job:return False
  job=dict(job);c.execute('UPDATE jobs SET status="running" WHERE id=?',(job['id'],))
 try:
  (process_import(job['revision_id']) if job['kind']=='import' else process_documents(job['revision_id'],json.loads(job['payload'])))
  storage.sync_revision(job['revision_id'],db.revdir(job['revision_id']))
  with db.connect() as c:c.execute('UPDATE jobs SET status="complete" WHERE id=?',(job['id'],))
 except Exception as e:
  traceback.print_exc()
  if json.loads(job['payload']).get('release'):
   # Never leave partial outputs stamped RELEASED after a failed release.
   folder=db.revdir(job['revision_id'])
   for artifact in folder.rglob('*'):
    if artifact.suffix in ('.pdf','.dxf','.zip') or artifact.name in ('flat.json','flat.glb','projections.json'):artifact.unlink(missing_ok=True)
  with db.connect() as c:
   c.execute('UPDATE jobs SET status="failed",error=? WHERE id=?',(str(e)[:1000],job['id']))
   if json.loads(job['payload']).get('release'):c.execute('UPDATE revisions SET status="ready",release_by=NULL,release_at=NULL WHERE id=?',(job['revision_id'],))
   if job['kind']=='import':c.execute('UPDATE revisions SET status="failed",message=? WHERE id=?',(str(e)[:1000],job['revision_id']))
 return True
if __name__=='__main__':
 db.init()
 with db.connect() as c:c.execute('UPDATE jobs SET status="queued" WHERE status="running"')
 while True:
  if not run_once():time.sleep(1)
