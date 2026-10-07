import time,json,traceback,os,zipfile,hashlib,re,math
from pathlib import Path
import numpy as np
import trimesh,ezdxf
from . import db,storage
from .cad import import_model,explore,analyze,mesh,BRepTools,TopAbs_SOLID,bounds,classify_name,hidden_by_default,classify_prefix,step_materials,step_header,density_for
from .unfold import unfold
from .scrub import clean_name
from .drawings import make_part,assembly_pdf,render_meshes,combined_canvas,thumb_color

def progress(rid,p,message):
 with db.connect() as c:c.execute('UPDATE revisions SET progress=?,message=? WHERE id=?',(p,message,rid))
def _beat(rid,p,message,started):
 while True:
  time.sleep(3);s=int(time.time()-started)
  try:progress(rid,p,f"{message} · {s//60} min {s%60:02d} s" if s>=60 else f"{message} · {s} s")
  except Exception:pass
class stage:
 """A long single step (reading a large STEP file, meshing the assembly ...) gives no progress of its own and
 the OpenCascade calls hold the interpreter, so a small side process keeps the status line ticking with the
 elapsed time. The UI then shows the import is alive instead of a frozen percentage."""
 def __init__(self,rid,p,message):self.rid,self.p,self.message=rid,p,message;self.proc=None
 def __enter__(self):
  progress(self.rid,self.p,self.message)
  try:
   import multiprocessing as mp
   self.proc=mp.get_context('fork').Process(target=_beat,args=(self.rid,self.p,self.message,time.time()),daemon=True);self.proc.start()
  except Exception:self.proc=None
  return self
 def __exit__(self,*exc):
  if self.proc:
   self.proc.terminate();self.proc.join(2)
  return False
def size_text(path):
 n=Path(path).stat().st_size
 return f'{n/1e6:.0f} MB' if n>=1e6 else f'{n/1e3:.0f} kB'
def parts_for(rid):
 ps=db.rows('SELECT * FROM parts WHERE revision_id=? ORDER BY name',(rid,))
 for p in ps:p['geometry']=json.loads(p['geometry']);p['spec']=json.loads(p['spec'])
 return ps

def hardware_holes(poly,g,spec):
 """Holes with hole hardware are cut at the hardware's mounting / pilot hole (like a quoting portal's auto-adjust):
 the hole centre is mapped into the flat with its skin's development transform and the matching cut-out is
 replaced by a circle of the required diameter. Returns the new outline and what changed."""
 from shapely.geometry import Polygon,Point
 fs=spec.get('feature_specs') or {};maps=getattr(unfold,'maps',None) or [];th=float(g.get('thickness') or 0)
 holes={h['id']:h for h in g.get('holes',[])};changes=[];rings=[list(r.coords) for r in poly.interiors]
 for hid,f in fs.items():
  hw=(f or {}).get('hardware') or {}
  h=holes.get(hid)
  if not h or not hw.get('hole'):continue
  c=np.array(h['center'],float);ax=np.array(h['axis'],float)
  # several (coplanar) flanges can hold the hole's plane: the right one maps the hole onto a matching cut-out
  best=None
  for o,n,R,t in maps:
   if abs(np.dot(n,ax))<.99 or abs(np.dot(c-o,n))>th+.05:continue
   q_=(R@(c-n*np.dot(c-o,n))+t)[:2]
   for i,r in enumerate(rings):
    pg=Polygon(r)
    if pg.area<=0:continue
    d=Point(pg.centroid).distance(Point(q_))
    if d<.25 and abs(2*math.sqrt(pg.area/math.pi)-h['diameter'])<.1 and (best is None or d<best[0]):best=(d,i,q_)
  if best is None:continue
  q=best[2]
  want=float(hw['hole'])
  if abs(want-h['diameter'])<=.02:continue
  k=64;rings[best[1]]=[(q[0]+want/2*math.cos(2*math.pi*j/k),q[1]+want/2*math.sin(2*math.pi*j/k)) for j in range(k+1)]
  changes.append({'hole':hid,'center':[round(float(q[0]),4),round(float(q[1]),4)],'from':h['diameter'],'to':want,'item':hw.get('pn') or hw.get('name')})
 if not changes:return poly,[]
 out=Polygon(list(poly.exterior.coords),rings)
 return (out if out.is_valid else poly),(changes if out.is_valid else [])
FLAT_ENGINE=4   # bump when the unfolder changes: failed flats from an older engine are re-run once by the idle worker
def export_flat(shape,g,spec,folder,opts=None):
 if g['category']!='sheet_metal':return
 g['flat_engine']=FLAT_ENGINE
 try:
  poly,bends=unfold(shape,g,spec.get('k_factor',.4));poly,hw_holes=hardware_holes(poly,g,spec);flat={'outline':list(poly.exterior.coords),'holes':[list(r.coords) for r in poly.interiors],'bends':bends,'k_factor':spec.get('k_factor',.4),'status':'provisional' if not spec.get('k_factor_approved') else 'approved_k','hardware_holes':hw_holes}
  (folder/'flat.json').write_text(json.dumps(flat));d=ezdxf.new('R2013');d.units=4;m=d.modelspace();d.layers.new('CUT');d.layers.new('BEND',dxfattribs={'color':3});d.layers.new('LABELS',dxfattribs={'color':2})
  for coords in [flat['outline']]+flat['holes']:m.add_lwpolyline(coords,close=True,dxfattribs={'layer':'CUT'})
  from .bendplan import default_process
  proc=(opts or {}).get('bend_process') or {}
  for b in bends:
   roll=(proc.get(b['id']) or default_process(b['radius'],g['thickness']))=='roll'
   m.add_line(b['a'],b['b'],dxfattribs={'layer':'BEND'});m.add_text(f"{b['id']} {'ROLL ' if roll else ''}{b['angle']:.1f}deg {b.get('direction','').upper()} R{b['radius']:.2f}",dxfattribs={'height':2.5,'insert':b['a'],'layer':'LABELS'})
  m.add_text('DEVELOPED GEOMETRY - '+flat['status'].upper()+' - VERIFY TOOLING',dxfattribs={'height':3,'insert':(poly.bounds[0],poly.bounds[1]-8),'layer':'LABELS'});d.saveas(folder/'flat.dxf')
  flatmesh=trimesh.creation.extrude_polygon(poly,g['thickness'],engine='earcut');flatmesh.export(folder/'flat.glb');g['flat_status']='supported';g['flat_bounds']=list(poly.bounds);g['flat_message']='Developed using configured K; tooling verification required.';g.pop('flat_issues',None)
 except Exception as e:
  g['flat_status']='needs_review';g['flat_message']=str(e);g['flat_issues']=getattr(e,'issues',None) or []
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

def apply_defaults(spec,g,settings,carried):
 """Project defaults per category: the process template (routing) and drawing template."""
 cat=g['category']
 tid=(settings.get('process_templates') or {}).get(cat)
 if tid and not carried and not spec.get('operations'):
  t=db.row("SELECT * FROM templates WHERE id=? AND kind='process' AND archived=0",(tid,))
  if t:spec['operations']=[{'name':x['name'],'detail':x.get('detail','')} for x in json.loads(t['data']).get('steps',[])];g['_process_template']=tid
 did=(settings.get('drawing_templates') or {}).get(cat)
 if did:
  t=db.row("SELECT * FROM templates WHERE id=? AND kind='drawing' AND archived=0",(did,))
  if t:g['_drawing_options']={'template_id':did,**{k:v for k,v in json.loads(t['data']).items() if k in ('size','hole_table')}}

def process_import(rid):
 rev=db.row('SELECT * FROM revisions WHERE id=?',(rid,));folder=db.revdir(rid);project=db.row('SELECT * FROM projects WHERE id=?',(rev['project_id'],));rules=json.loads(rev['manifest']).get('rules_snapshot',json.loads(project['rules']));source=folder/('source'+Path(rev['filename']).suffix.lower())
 # Authoring-system traces (SolidWorks header, feature names, exporter name noise, users, paths, GUIDs) are removed
 # before anything reads the file; only the sanitized copy is kept, hashed, served and downloaded.
 sanitized=None
 if source.suffix.lower() in ('.step','.stp','.igs','.iges'):
  with stage(rid,2,f'Removing authoring-system metadata ({size_text(source)})'):
   from .scrub import scrub
   sanitized=scrub(source,'source'+source.suffix.lower())
  if sanitized:
   h=hashlib.sha256()
   with source.open('rb') as fh:
    while b:=fh.read(1<<20):h.update(b)
   with db.connect() as c:
    c.execute('UPDATE revisions SET sha256=? WHERE id=?',(h.hexdigest(),rid));db.audit(c,'worker','revision.sanitized',{k:v for k,v in sanitized.items() if k!='solidworks'}|{'sha256':h.hexdigest()},rid)
   rev['sha256']=h.hexdigest()
   storage.upload(rid,source,source.name)
 with stage(rid,3,f'Reading CAD file ({size_text(source)}) and preserving component placements'):leaves=import_model(source)
 if source.suffix in ('.brep','.brp','.igs','.iges') and len(leaves)==1:leaves[0]['name']=Path(rev['filename']).stem
 scene=trimesh.Scene();parts=[];instances={};assembly_meshes=[];warnings=[];num=0;settings=db.project_settings(rev['project_id'])
 # Engineering data from the current active revision is carried into the new one (by name, then by shape),
 # so specifications only need editing where the design changed. Approvals are never carried.
 previous={};prev_rev=db.row('SELECT * FROM revisions WHERE project_id=? AND state="active" AND id!=?',(rev['project_id'],rid))
 if prev_rev and settings.get('carry_over_specs',True):
  for old in db.rows('SELECT * FROM parts WHERE revision_id=?',(prev_rev['id'],)):
   old['geometry']=json.loads(old['geometry']);old['spec']=json.loads(old['spec'])
   previous.setdefault('name:'+old['name'],old);previous.setdefault('fp:'+old['geometry'].get('fingerprint',''),old)
   # revisions imported before sanitizing carry SolidWorks name noise; match them by the cleaned name too
   m=re.match(r'(.*?)(\s*/\s*Body \d+)?$',old['name']);previous.setdefault('name:'+clean_name(m.group(1))+(m.group(2) or ''),old)
 carried=0;pid_map={}
 with db.connect() as c:c.execute('DELETE FROM fits WHERE revision_id=?',(rid,));c.execute('DELETE FROM parts WHERE revision_id=?',(rid,))
 for i,leaf in enumerate(leaves):
  if i==0 and source.suffix.lower() in ('.step','.stp'):
   with stage(rid,5,'Reading materials and properties from STEP'):step_mat=step_materials(source);header=step_header(source)
  elif i==0:step_mat={};header={}
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
   provenance=' / '.join(i['path'] for i in leaf['instances'][:1])
   supplier=bool(re.search(r'T806-ZJ|HKT-WDS|FD125|ELVM|iHawk|Southco|MICHCASTER|WAVESHARE|JK_FENNER|XWST|LTO 48|XB5AS|XB5AW|P3767|2ELD',provenance,re.I))
   if supplier and classify_name(name)!='custom':g['category']='purchased';g['recognition_notes'].append('Purchased candidate inferred from supplier assembly ancestry; confirm make/buy classification.')
   by_prefix=classify_prefix(name,settings)
   if by_prefix:g['category']=by_prefix;g['classification_confidence']='workspace prefix rule';g['recognition_notes'].append('Category set by the workspace part-number prefix rule.')
   elif settings.get('prefix_strict',True) and any(settings.get(k) for k in ('sheet_prefixes','machining_prefixes','purchased_prefixes')):g['classification_confidence']='no part number';g['recognition_notes'].append('No configured part-number prefix in the name; classified as a made part from its name and geometry. Confirm and give it a part number.')
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
   # STEP product data (material, density, appearance) prefills what the engineer has not specified.
   meta=dict(leaf.get('meta') or {});meta.update(step_mat.get(leaf['name']) or (step_mat.get('*') if len(leaves)==1 else None) or {})
   if meta:g['step']=meta
   if meta.get('material') and not spec.get('material'):spec['material']=meta['material'];g['recognition_notes'].append('Material read from the STEP file; confirm before release.')
   apply_defaults(spec,g,settings,old is not None)
   rho=(meta.get('density')*1000 if meta.get('density') and meta['density']<30 else meta.get('density')) or density_for(spec.get('material'))
   if rho:g['mass_kg']=round(g['volume']*1e-9*rho,4);g['mass_basis']='STEP density' if meta.get('density') else 'material density'
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
   ptpl=(old or {}).get('process_template_id') or g.pop('_process_template','');dopt=(old or {}).get('drawing_options') or json.dumps(g.pop('_drawing_options',{}))
   g.pop('_process_template',None);g.pop('_drawing_options',None)
   with db.connect() as c:
    c.execute('INSERT INTO parts(id,revision_id,name,category,quantity,geometry,spec,reviewed,hidden,excluded,exclusion_reason,excluded_by,excluded_at,process_template_id,drawing_options) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(pid,rid,name,p['category'],p['quantity'],json.dumps(g),json.dumps(spec),0,hidden,excluded,exclusion_reason,excluded_by,excluded_at,ptpl,dopt))
    # inspection plan (critical flags, specified limits, balloon positions) follows an unchanged part
    if old:pid_map[old['id']]=(pid,old['geometry'].get('fingerprint')==g['fingerprint'],len(leaf['instances']))
    if old and old.get('alias'):c.execute('UPDATE parts SET alias=? WHERE id=?',(old['alias'],pid))   # the easy name follows the part
    if old and old['geometry'].get('fingerprint')==g['fingerprint']:
     c.execute('INSERT OR IGNORE INTO char_overrides(part_id,key,data,actor,updated) SELECT ?,key,data,actor,updated FROM char_overrides WHERE part_id=?',(pid,old['id']))
 if not parts:raise ValueError('No usable solid bodies found; export solids as STEP or BREP')
 if prev_rev and pid_map:carry_assembly_steps(prev_rev['id'],rid,pid_map)
 with stage(rid,73,'Writing lightweight assembly mesh'):scene.export(folder/'assembly.glb');(folder/'instances.json').write_text(json.dumps(instances))
 fits=[]  # mates come from the STEP assembly itself (placements); no geometric fit guessing
 with db.connect() as c:
  for f in fits:c.execute('INSERT INTO fits VALUES(?,?,?,0)',(db.uid(),rid,json.dumps(f)))
 with stage(rid,82,'Rendering assembly documentation'):
  if assembly_meshes:render_meshes(assembly_meshes,folder/'assembly.png')
 manifest={'step_header':header,'sanitized':{k:v for k,v in (sanitized or {}).items() if k!='solidworks'},'rules_snapshot':rules,'part_count':len(parts),'component_definitions':len(leaves),'occurrences':sum(p['quantity'] for p in parts),'triangles':sum(p['geometry']['triangles']*p['quantity'] for p in parts),'warnings':warnings,'units':'mm','mesh_deflection':rules['mesh_deflection'],'fit_candidates':len(fits),'carried_over':carried,'carried_from':prev_rev['number'] if prev_rev else None,'rule_coverage':'Configured geometry and workflow rules only; manual checks explicitly required','unsupported':['Native proprietary CAD formats','General double-curved sheet forming','Automatic structural certification','Automatic thread specification recovery'],'instances_file':'instances.json'}
 # Only promote successful revisions; archive the prior active version atomically.
 with db.connect() as c:
  c.execute('UPDATE revisions SET state="archived" WHERE project_id=? AND state="active"',(rev['project_id'],));c.execute('UPDATE revisions SET state="active",status="ready",progress=100,message="Analysis complete",manifest=? WHERE id=?',(json.dumps(manifest),rid));db.audit(c,'worker','revision.activated',manifest,rid)
 rev=db.row('SELECT * FROM revisions WHERE id=?',(rid,));assembly_pdf(rev,parts,[{'id':str(i),'data':f,'approved':False} for i,f in enumerate(fits)],folder,detailed=False)

def carry_assembly_steps(old_rid,rid,pid_map):
 """Assembly steps follow the design: components matched by name / shape keep their step; fastener holes only
 where the shape is unchanged (hole ids are stable); weld links are dropped (welds belong to one revision)."""
 out=[];gmap={g['id']:db.uid() for g in db.rows('SELECT id FROM assembly_groups WHERE revision_id=?',(old_rid,))}
 for r in db.rows('SELECT * FROM assembly_steps WHERE revision_id=? ORDER BY seq',(old_rid,)):
  d=json.loads(r['data']);parts=[]
  for e in d.get('parts',[]):
   m=pid_map.get(e['part'])
   if not m:continue
   occ=[o for o in e.get('occurrences',[0]) if o<max(m[2],1)]
   if occ:parts.append({'part':m[0],'occurrences':occ})
  for f in d.get('fasteners',[]):f['holes']=[{**h,'part':pid_map[h['part']][0]} for h in f.get('holes',[]) if pid_map.get(h['part']) and pid_map[h['part']][1]]
  if not parts and not d.get('notes') and not d.get('subs'):continue
  d['parts']=parts;d['welds']=[];d['subs']=[gmap[x] for x in d.get('subs',[]) if x in gmap];out.append((gmap.get(r['grp'] or '',''),r['seq'],d))
 with db.connect() as c:
  c.execute('DELETE FROM assembly_steps WHERE revision_id=?',(rid,));c.execute('DELETE FROM assembly_groups WHERE revision_id=?',(rid,))
  for g in db.rows('SELECT * FROM assembly_groups WHERE revision_id=?',(old_rid,)):c.execute('INSERT INTO assembly_groups(id,revision_id,seq,name,notes,created,author) VALUES(?,?,?,?,?,?,?)',(gmap[g['id']],rid,g['seq'],g['name'],g['notes'] or '',db.now(),'carried over'))
  seqs={}
  for grp,_,d in out:
   seqs[grp]=seqs.get(grp,-1)+1;c.execute('INSERT INTO assembly_steps(id,revision_id,seq,data,created,author,updated,grp) VALUES(?,?,?,?,?,?,?,?)',(db.uid(),rid,seqs[grp],json.dumps(d),db.now(),'carried over',db.now(),grp))

def drawing_options(p):
 opts=json.loads(p.get('drawing_options') or '{}') if isinstance(p.get('drawing_options'),str) else dict(p.get('drawing_options') or {})
 if opts.get('template_id'):
  t=db.row("SELECT data FROM templates WHERE id=? AND kind='drawing'",(opts['template_id'],))
  if t:opts={**{k:v for k,v in json.loads(t['data']).items() if k in ('size','hole_table')},**{k:v for k,v in opts.items() if k!='template_id' and v not in (None,'')}}
 return {k:v for k,v in opts.items() if k in ('size','hole_table')}

def draw_part(p,rev,folder,rules,settings):
 """One part's drawing set (runs in a worker process). Returns the updated geometry record."""
 from .cad import read_brep
 pf=Path(folder)/'parts'/p['id']
 if os.getenv('FORGE_JOB_ID'):(pf/'.drawing-job').write_text(os.environ['FORGE_JOB_ID'])   # lets a cancel know what this run touched
 shape=read_brep(pf/'shape.brep')
 opts=p.get('drawing_options') if isinstance(p.get('drawing_options'),dict) else json.loads(p.get('drawing_options') or '{}')
 export_flat(shape,p['geometry'],p['spec'],pf,opts)
 if p['category']=='sheet_metal' and p['geometry'].get('flat_status')!='supported':
  # only when the flat failed: parts analysed before mitred-corner bends were recognised may miss bends
  try:
   fresh=analyze(shape,p['name'])
   if len(fresh.get('bends') or [])>len(p['geometry'].get('bends') or []):
    p['geometry']['bends']=fresh['bends'];p['geometry'].setdefault('recognition_notes',[]).append(f"Bend recognition updated: {len(fresh['bends'])} bends (closed / mitred corners).")
    export_flat(shape,p['geometry'],p['spec'],pf,opts)
  except Exception:traceback.print_exc()
 make_part(p,rev,pf,rules,settings=settings)
 (pf/'.drawing-invalid').unlink(missing_ok=True)
 if not (pf/'thumb.png').exists():
  try:render_meshes([(trimesh.load(pf/'model.glb',force='mesh'),np.eye(4))],pf/'thumb.png',size=(640,420),colors=[thumb_color(p)])
  except Exception:pass
 return p['geometry']

def process_documents(rid,payload):
 rev=db.row('SELECT * FROM revisions WHERE id=?',(rid,));folder=db.revdir(rid);
 if payload.get('assembly_only'):
  progress(rid,40,'Updating the assembly drawing');fits=db.rows('SELECT * FROM fits WHERE revision_id=?',(rid,))
  for f in fits:f['data']=json.loads(f['data'])
  assembly_pdf(rev,parts_for(rid),fits,folder,detailed=False);progress(rid,100,'Assembly drawing updated');return
 project=db.row('SELECT * FROM projects WHERE id=?',(rev['project_id'],));rules=json.loads(rev['manifest']).get('rules_snapshot',json.loads(project['rules']));
 if payload.get('release'):rev['status']='released'
 parts=parts_for(rid);full=not payload.get('part_id') and not payload.get('part_ids');settings=db.project_settings(rev['project_id'])
 pick=set(payload.get('part_ids') or [payload.get('part_id')])
 selected=[p for p in parts if p['id'] in pick] if not full else [p for p in parts if p['category']!='purchased' and not p.get('excluded')]
 from .cad import read_brep
 # Whole-pack runs also produce one PDF per discipline: every machining sheet in one file, every sheet-metal sheet in another.
 combined={}
 if full:
  groups={'machining':[p for p in selected if p['category']!='sheet_metal'],'sheet_metal':[p for p in selected if p['category']=='sheet_metal']}
  for key,group in groups.items():
   name='machining-drawings.pdf' if key=='machining' else 'sheet-metal-drawings.pdf'
   (folder/name).unlink(missing_ok=True)
   if group:combined[key]=combined_canvas(folder/name,'Machining drawings' if key=='machining' else 'Sheet metal drawings',rev,group,settings)
 if payload.get('release'):
  from .rules import evaluate
  for p in selected:
   failures=[f for f in evaluate(p['geometry'],p['spec'],rules) if f['severity']=='blocker' and (not f['waiver'] or f['code']=='GEO001')]
   if failures:raise ValueError('Release checks changed during regeneration: '+p['name']+' '+str([f['code'] for f in failures]))
 for p in selected:
  saved=db.row('SELECT * FROM drawing_edits WHERE part_id=?',(p['id'],))
  if saved and saved['source_hash']==rev['sha256']:p['drawing_edits']=json.loads(saved['data'])
  conv=settings.get('conventions') or {};p['drawing_options']={'size':conv.get('sheet_size','auto'),'hole_table':conv.get('hole_table','auto'),**drawing_options(p)}
 # Parts are independent: draw them in parallel worker processes, then assemble the discipline PDFs in order.
 workers=max(1,min(int(os.getenv('FORGE_DRAWING_WORKERS',str(min(4,os.cpu_count() or 1)))),len(selected)))
 done=0
 if workers>1:
  import multiprocessing as mp
  from concurrent.futures import ProcessPoolExecutor,as_completed
  from concurrent.futures.process import BrokenProcessPool
  finished=set()
  try:
   with ProcessPoolExecutor(workers,mp_context=mp.get_context('fork')) as pool:
    futures={pool.submit(draw_part,p,rev,str(folder),rules,settings):p for p in selected}
    for f in as_completed(futures):
     futures[f]['geometry']=f.result();finished.add(futures[f]['id']);done+=1;progress(rid,int(80*done/len(selected)),f"Drawings {done}/{len(selected)}")
  except BrokenProcessPool:
   # a drawing process died (out of memory, or a CAD kernel crash on one part): finish the rest one part per
   # process so a single bad part cannot fail the whole run; a part that crashes again is marked for review
   for p in [x for x in selected if x['id'] not in finished]:
    progress(rid,int(80*done/len(selected)),f"Drawing {done+1}/{len(selected)} (one at a time): {p['name'][:50]}")
    try:
     # a fresh interpreter (spawn): a fork of a process that already ran the CAD kernel's thread pools can deadlock
     with ProcessPoolExecutor(1,mp_context=mp.get_context('spawn')) as one:p['geometry']=one.submit(draw_part,p,rev,str(folder),rules,settings).result()
    except BrokenProcessPool:
     pf=folder/'parts'/p['id'];pf.mkdir(parents=True,exist_ok=True)
     (pf/'.drawing-invalid').write_text('The drawing process stopped on this part (memory or CAD kernel); regenerate it on its own')
     if p['category']=='sheet_metal' and p['geometry'].get('flat_status')!='supported':
      p['geometry']['flat_message']='The unfolder stopped on this part (memory or CAD kernel crash); regenerate this part on its own'
      p['geometry']['flat_engine']=FLAT_ENGINE
     with db.connect() as c:db.audit(c,'worker','documents.part_crashed',{'part':p['id'],'name':p['name']},rid)
    done+=1
 else:
  for p in selected:
   progress(rid,int(80*done/max(len(selected),1)),f"Drawing {done+1}/{len(selected)}: {p['name'][:60]}")
   p['geometry']=draw_part(p,rev,str(folder),rules,settings);done+=1
 from .drawing_scene import render_scene
 from .drawings import attach_view_lines
 for p in selected:
  pf=folder/'parts'/p['id']
  with db.connect() as c:
   c.execute('UPDATE parts SET geometry=? WHERE id=?',(json.dumps(p['geometry']),p['id']))
   # regenerated sheets must be looked at again (a release keeps the reviews it was checked against)
   if not payload.get('release'):c.execute("UPDATE parts SET doc_reviewed=0,doc_reviewed_by='',doc_reviewed_at='' WHERE id=?",(p['id'],))
  target=combined.get('sheet_metal' if p['category']=='sheet_metal' else 'machining')
  if target is not None and (pf/'drawing-scene.json').exists():
   from .drawing_scene import unique_group_ids
   scene=unique_group_ids(json.loads((pf/'drawing-scene.json').read_text()))
   from .drawings import full_scene
   ed=attach_view_lines(p,pf,scene,p.get('drawing_edits') or {})
   render_scene(full_scene(p,rev,settings,scene,ed),ed,c=target)
 for c in combined.values():c.save()
 fits=db.rows('SELECT * FROM fits WHERE revision_id=?',(rid,))
 for f in fits:f['data']=json.loads(f['data'])
 with stage(rid,88,'Generating assembly and mating drawings'):
  if full or not (folder/'assembly.pdf').exists():assembly_pdf(rev,parts,fits,folder,detailed=full)
 if full and db.row('SELECT id FROM assembly_steps WHERE revision_id=? LIMIT 1',(rid,)):
  with stage(rid,92,'Rendering assembly work instructions'):
   from .assembly import instructions_pdf
   instructions_pdf(rid)
 if full and db.row("SELECT id FROM joints WHERE revision_id=? AND kind='weld' LIMIT 1",(rid,)):
  with stage(rid,94,'Drawing the welding document'):
   from .welding import welding_pdf
   welding_pdf(rid)
 if full:
  with stage(rid,97,'Packaging manufacturing documents'),zipfile.ZipFile(folder/'manufacturing-pack.zip','w',zipfile.ZIP_DEFLATED) as z:
   z.write(folder/'assembly.pdf','assembly.pdf');
   for extra in ['assembly.dxf','machining-drawings.pdf','sheet-metal-drawings.pdf','assembly-instructions.pdf','welding.pdf']:
    if (folder/extra).exists():z.write(folder/extra,extra)
   z.writestr('parts.json',json.dumps(parts,indent=2));z.writestr('fits.json',json.dumps(fits,indent=2));z.writestr('revision.json',json.dumps(rev,indent=2))
   for p in selected:
    try:
     # ballooned inspection copy of every drawing (characteristics, limits, critical flags)
     from .quality import inspection_pdf
     inspection_pdf(p,rev,settings,str(folder/'parts'/p['id']/'inspection.pdf'))
    except Exception:traceback.print_exc()
    for fn in ['drawing.pdf','drawing.dxf','review.pdf','flat.dxf','flat.json','part.step','drawing-scene.json','characteristics.json','inspection.pdf']:
     f=folder/'parts'/p['id']/fn
     if f.exists():z.write(f,f"parts/{p['id']}/{fn}")
 # parts re-typed (or excluded) while this job ran were drawn with their old category: regenerate them later
 changed=False
 now={r['id']:r for r in db.rows('SELECT id,category,excluded FROM parts WHERE revision_id=?',(rid,))}
 for p in parts:
  cur=now.get(p['id'])
  if cur and (cur['category']!=p['category'] or int(cur['excluded'] or 0)!=int(p.get('excluded') or 0)):
   d=folder/'parts'/p['id'];d.mkdir(parents=True,exist_ok=True)
   (d/'.drawing-invalid').write_text('Part type changed while documents were generated; regenerate')
   full=False;changed=True
 if payload.get('release') and changed:raise RuntimeError('Part types changed while the release pack was generated; regenerate documents and release again')
 if payload.get('release'):
  with db.connect() as c:c.execute('UPDATE revisions SET status="released" WHERE id=?',(rid,));db.audit(c,'worker','revision.released',{},rid)
 if full:(folder/'.documents-stale').unlink(missing_ok=True)
 progress(rid,100,'Documents generated')

def process_instructions(rid):
 """Assembly work instructions: one rendered page per step (can take minutes on a large assembly)."""
 from .assembly import instructions_pdf
 instructions_pdf(rid,progress=lambda k,n:progress(rid,int(100*k/max(n,1)),f'Assembly instructions: page {k}/{n}'))
 progress(rid,100,'Assembly instructions ready')

def process_welding(rid):
 from .welding import welding_pdf
 progress(rid,20,'Drawing the welding document');welding_pdf(rid);progress(rid,100,'Welding document ready')

# Messages written only by the over-strict pre-checks shipped briefly on 2026-10-07 (removed again): parts whose saved
# flat result came from them are regenerated once so they show the unfolder's real result.
_BAD_FLAT=('not recognised as a bend','Conical or freeform faces cannot be developed')
_HEAL_TRIED=set()
def heal_flat_results():
 for rev in db.rows("SELECT id FROM revisions WHERE state='active' AND status='ready'"):
  ids=[]
  for p in db.rows("SELECT id,geometry FROM parts WHERE revision_id=? AND category='sheet_metal' AND COALESCE(excluded,0)=0",(rev['id'],)):
   g=json.loads(p['geometry'])
   if p['id'] not in _HEAL_TRIED and g.get('flat_status')!='supported' and (g.get('flat_engine')!=FLAT_ENGINE or any(m in (g.get('flat_message') or '') for m in _BAD_FLAT)):ids.append(p['id'])
  # wait only for a documents run that would cover them anyway (other jobs, e.g. instructions, do not matter)
  if not ids or db.row('SELECT id FROM jobs WHERE revision_id=? AND kind="documents" AND status IN ("queued","running","cancelling")',(rev['id'],)):continue
  _HEAL_TRIED.update(ids)   # once per worker start, even if that run fails
  with db.connect() as c:
   c.execute('INSERT INTO jobs(id,revision_id,kind,status,created,error,payload) VALUES(?,?,?,?,?,?,?)',(db.uid(),rev['id'],'documents','queued',db.now(),'',json.dumps({'part_ids':ids})))
   db.audit(c,'worker','documents.requested',{'part_ids':ids,'reason':'re-check flat patterns'},rev['id'])

def perform_job(job):
 (process_import(job['revision_id']) if job['kind']=='import' else process_instructions(job['revision_id']) if job['kind']=='instructions' else process_welding(job['revision_id']) if job['kind']=='welding' else __import__('app.replace',fromlist=['x']).process_replace(job['revision_id'],json.loads(job['payload'])) if job['kind']=='replace' else process_documents(job['revision_id'],json.loads(job['payload'])))
 progress(job['revision_id'],99,'Uploading generated artifacts')
 storage.sync_revision(job['revision_id'],db.revdir(job['revision_id']))

def run_once():
 with db.connect() as c:
  c.execute('BEGIN IMMEDIATE');job=c.execute('SELECT * FROM jobs WHERE status="queued" ORDER BY created LIMIT 1').fetchone()
  if not job:return False
  job=dict(job);c.execute('UPDATE jobs SET status="running" WHERE id=?',(job['id'],))
  c.execute('UPDATE revisions SET progress=0,message=? WHERE id=?',('Starting '+job['kind'],job['revision_id']))
 try:
  if job['kind']=='import':perform_job(job)
  else:
   import sys
   from .job_timeout import run_bounded
   timeout=float(os.getenv('FORGE_DOCUMENT_TIMEOUT_SECONDS','1800'))
   if not math.isfinite(timeout) or timeout<=0:raise ValueError('FORGE_DOCUMENT_TIMEOUT_SECONDS must be positive')
   stop=lambda:(db.row('SELECT status FROM jobs WHERE id=?',(job['id'],)) or {}).get('status')=='cancelling'
   run_bounded([sys.executable,'-m','app.worker','--job',job['id']],timeout,env={**os.environ,'DATA_DIR':str(db.ROOT),'PYTHONPATH':str(Path(__file__).resolve().parent.parent)+os.pathsep+os.getenv('PYTHONPATH','')},should_stop=stop)
  with db.connect() as c:
   c.execute('UPDATE jobs SET status="complete" WHERE id=?',(job['id'],))
   c.execute('UPDATE revisions SET progress=100,message=? WHERE id=?',({'import':'Analysis complete','instructions':'Assembly instructions ready','welding':'Welding document ready','replace':'Part geometry updated'}.get(job['kind'],'Documents generated'),job['revision_id']))
 except Exception as e:
  from .job_timeout import JobCancelled
  cancelled=isinstance(e,JobCancelled)
  if not cancelled:traceback.print_exc()
  payload=json.loads(job['payload'])
  if job['kind']=='documents' and not payload.get('assembly_only'):
   ids=payload.get('part_ids') or ([payload['part_id']] if payload.get('part_id') else [p['id'] for p in db.rows('SELECT id FROM parts WHERE revision_id=?',(job['revision_id'],))])
   for pid in ids:
    part_folder=db.revdir(job['revision_id'])/'parts'/pid;part_folder.mkdir(parents=True,exist_ok=True)
    # a cancelled run only touched the parts it started; parts it never reached keep their drawings
    if cancelled:
     mark=part_folder/'.drawing-job'
     if not mark.exists() or mark.read_text().strip()!=job['id']:continue
    (part_folder/'.drawing-invalid').write_text('Document generation '+('cancelled' if cancelled else 'failed')+'; regenerate before review')
  if payload.get('release'):
   # Never leave partial outputs stamped RELEASED after a failed release.
   folder=db.revdir(job['revision_id'])
   for artifact in folder.rglob('*'):
    if artifact.suffix in ('.pdf','.dxf','.zip') or artifact.name in ('flat.json','flat.glb','projections.json','drawing-scene.json','characteristics.json'):artifact.unlink(missing_ok=True)
  with db.connect() as c:
   who=(db.row('SELECT error FROM jobs WHERE id=?',(job['id'],)) or {}).get('error') or ''
   c.execute('UPDATE jobs SET status=?,error=? WHERE id=?',('cancelled' if cancelled else 'failed',(who or 'Cancelled') if cancelled else str(e)[:1000],job['id']))
   c.execute('UPDATE revisions SET progress=0,message=? WHERE id=?',(('Cancelled' if cancelled else 'Job failed: '+str(e)[:900]),job['revision_id']))
   if json.loads(job['payload']).get('release'):c.execute('UPDATE revisions SET status="ready",release_by=NULL,release_at=NULL WHERE id=?',(job['revision_id'],))
   if job['kind']=='import':c.execute('UPDATE revisions SET status="failed" WHERE id=?',(job['revision_id'],))
   if job['kind']=='replace' and payload.get('version_id'):c.execute('UPDATE part_versions SET status="failed",message=? WHERE id=? AND status="processing"',(('Cancelled' if cancelled else str(e)[:1000]),payload['version_id']))
 return True
if __name__=='__main__':
 import sys
 if len(sys.argv)==3 and sys.argv[1]=='--job':
  os.environ['FORGE_JOB_ID']=sys.argv[2]
  perform_job(db.row('SELECT * FROM jobs WHERE id=?',(sys.argv[2],)))
 else:
  db.init()
  # An interrupted job must not silently restart indefinitely after container restarts.
  with db.connect() as c:
   c.execute('UPDATE jobs SET status="failed",error="Worker restarted before job completed; retry generation" WHERE status="running" AND kind!="import"')
   c.execute('UPDATE jobs SET status="queued" WHERE status="running" AND kind="import"')
  healed=0.0
  while True:
   if run_once():continue
   if time.time()-healed>60:
    healed=time.time()
    try:heal_flat_results()
    except Exception:traceback.print_exc()
   time.sleep(1)
