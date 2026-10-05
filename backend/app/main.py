import uuid,os,re,json,secrets,datetime,hashlib,math,time,io,csv,asyncio
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI,Request,HTTPException,UploadFile,File,Form
from fastapi.responses import FileResponse,JSONResponse,Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel,Field,ConfigDict
from . import db,storage
from .security import user,editor,revision_access,password_hash,verify_password,token_hash
from .access import require,can,perms_for,project_of_revision
from . import entra
from .rules import evaluate,MANUAL_CHECKS,STANDARDS

@asynccontextmanager
async def lifespan(app):db.init();yield
app=FastAPI(title='Forge Manufacturing',version='0.2.0',lifespan=lifespan)
app.include_router(entra.router)
WRITE_LOCK=asyncio.Lock()
# Long-running body transfers (CAD uploads) must not hold the write lock: they only write their own files and
# take an IMMEDIATE SQLite transaction for the final insert.
import re as _re
UNLOCKED=_re.compile(r'^/api/(uploads/[^/]+/chunks/\d+|projects/[^/]+/revisions)$')
@app.middleware('http')
async def headers(req,call_next):
 if req.method in ('POST','PUT','PATCH','DELETE') and not (req.method in ('PUT','POST') and UNLOCKED.match(req.url.path)):
  async with WRITE_LOCK:res=await call_next(req)
 else:res=await call_next(req)
 res.headers['X-Content-Type-Options']='nosniff';res.headers['Referrer-Policy']='no-referrer';res.headers['X-Frame-Options']='SAMEORIGIN';res.headers['Cache-Control']='no-store';return res
class Auth(BaseModel):email:str;password:str;name:str=''
class Project(BaseModel):
 model_config=ConfigDict(extra='forbid')
 name:str=Field(min_length=1,max_length=160);description:str=Field(default='',max_length=2000);code:str=Field(default='',max_length=24)
 settings:dict|None=None;rules:dict|None=None;members:list[dict]=Field(default_factory=list,max_length=200)
class Spec(BaseModel):
 model_config=ConfigDict(extra='forbid')
 material:str='';stock:str='';finish:str='';paint:str='';coating_color:str='';coating_hex:str='';coating_thickness:str='';masking:str='';process:str='';heat_treatment:str='';hardness:str='';general_tolerance:str='';roughness:str='';datums:str='';edge_treatment:str='';marking:str='';packaging:str='';notes:str='';k_factor:float=Field(default=.4,gt=0,lt=1);k_factor_approved:bool=False;feature_specs:dict={};rule_waivers:dict={};manual_checks:dict={};operations:list=[]
class PartEdit(BaseModel):spec:Spec;category:str;reviewed:bool=False
class Comment(BaseModel):body:str=Field(min_length=1,max_length=5000);part_id:str|None=None;feature:str=''
class Share(BaseModel):label:str=Field(min_length=1,max_length=100);days:int=Field(default=14,ge=1,le=90);allow_cad:bool=False
class FitEdit(BaseModel):data:dict;approved:bool=False
class Inspection(BaseModel):
 part_id:str;feature:str;serial:str=Field(min_length=1,max_length=100);nominal:float;lower_limit:float;upper_limit:float;measured:float;unit:str='mm';instrument:str=Field(min_length=1);notes:str=''

def cad_download(access,rid):
 """STEP / DXF leave Forge only for users with the download permission (or vendor links created with it)."""
 if access['role']=='vendor':
  if not access.get('allow_cad'):raise HTTPException(403,'This vendor link does not include CAD downloads')
 else:require(access,'cad.download',project_of_revision(rid))
 with db.connect() as c:db.audit(c,access['name'],'cad.downloaded',{},rid)
def get_rev(rid):
 r=db.row('SELECT * FROM revisions WHERE id=?',(rid,))
 if not r:raise HTTPException(404,'Revision not found')
 return r
def classifiable(rid):
 """Category / not-for-production changes only need an active, ready revision: they are allowed while drawings
 generate (the documents job re-checks categories when it finishes and marks changed parts for regeneration)."""
 r=get_rev(rid)
 if r['state']!='active' or r['status']!='ready':raise HTTPException(409,'Part types can be changed on the active revision before release. Upload a new revision to change a released design.')
 if db.row('SELECT id FROM jobs WHERE revision_id=? AND kind="import" AND status IN ("queued","running")',(rid,)):raise HTTPException(409,'The CAD import is still running; wait for it to finish')
 return r
def mutable(rid):
 r=get_rev(rid)
 if r['state']!='active' or r['status']!='ready':raise HTTPException(409,'Only an active, ready revision can be edited. Upload a new revision for archived or released designs.')
 if db.row('SELECT id FROM jobs WHERE revision_id=? AND kind!="instructions" AND status IN ("queued","running")',(rid,)):raise HTTPException(409,'A CAD job is active; wait for completion')
 return r
def deserialize(p):
 p['geometry']=json.loads(p['geometry']);p['spec']=json.loads(p['spec']);return p

def get_part(pid):
 p=db.row('SELECT * FROM parts WHERE id=?',(pid,))
 if not p:raise HTTPException(404,'Part not found')
 return deserialize(p)

def invalidate(rid,pid=None):
 d=db.revdir(rid)
 for file in ['manufacturing-pack.zip','assembly.pdf','assembly.dxf']:(d/file).unlink(missing_ok=True)
 if pid:
  (d/'parts'/pid/'.drawing-invalid').write_text('Part specification changed; regenerate documents')
  with db.connect() as c:c.execute("UPDATE parts SET doc_reviewed=0,doc_reviewed_by='',doc_reviewed_at='' WHERE id=?",(pid,))
  for file in ['drawing.pdf','drawing.dxf','review.pdf','flat.dxf','flat.glb','flat.json','drawing-scene.json','characteristics.json','bend-sim.json','render.png']:(d/'parts'/pid/file).unlink(missing_ok=True)

def enqueue(c,rid,kind,payload={}):
 id=db.uid();c.execute('INSERT INTO jobs(id,revision_id,kind,status,created,error,payload) VALUES(?,?,?,?,?,?,?)',(id,rid,kind,'queued',db.now(),'',json.dumps(payload)));return id
@app.get('/api/health')
def health():return {'status':'ok','version':'0.2.0'}
@app.get('/api/auth/status')
def auth_status(request:Request):
 configured=bool(db.row('SELECT id FROM users LIMIT 1'))
 try:u=user(request)
 except HTTPException:u=None
 if u:
  u['permissions']=sorted(perms_for(u))
  try:u['prefs']=json.loads(u.get('prefs') or '{}')
  except ValueError:u['prefs']={}
 return {'configured':configured,'user':u,'providers':entra.providers()}
PREF_KEYS={'shortcuts':dict,'navStyle':str,'displayMode':str,'showPlanes':bool,'hwUnits':str}
@app.put('/api/me/prefs')
def save_prefs(body:dict,request:Request):
 u=user(request)
 clean={k:v for k,v in body.items() if k in PREF_KEYS and isinstance(v,PREF_KEYS[k])}
 if 'shortcuts' in clean:clean['shortcuts']={str(k)[:60]:str(v)[:40] for k,v in list(clean['shortcuts'].items())[:200] if isinstance(v,str)}
 for k in ('navStyle','displayMode','hwUnits'):
  if k in clean:clean[k]=clean[k][:20]
 with db.connect() as c:c.execute('UPDATE users SET prefs=? WHERE id=?',(json.dumps(clean),u['id']))
 return clean
@app.post('/api/auth/setup')
def setup(a:Auth):
 if not entra.local_login_allowed():raise HTTPException(403,'Sign in with Microsoft; the first organisation account becomes administrator')
 if not entra.domain_ok(a.email):raise HTTPException(403,'Use an organisation e-mail address ('+', '.join(entra.allowed_domains())+')')
 if len(a.password)<12 or '@' not in a.email or not a.name.strip():raise HTTPException(422,'Use a name, valid email and password of at least 12 characters')
 with db.connect() as c:
  c.execute('BEGIN IMMEDIATE')
  if c.execute('SELECT id FROM users LIMIT 1').fetchone():raise HTTPException(409,'Workspace already configured')
  c.execute('INSERT INTO users(id,email,name,password,role,created) VALUES(?,?,?,?,?,?)',(db.uid(),a.email.lower(),a.name,password_hash(a.password),'admin',db.now()))
 return {'ok':True}
LOGIN_ATTEMPTS={}
@app.post('/api/auth/login')
def login(a:Auth,request:Request):
 if not entra.local_login_allowed():raise HTTPException(403,'Password sign-in is disabled; use Sign in with Microsoft')
 if not entra.domain_ok(a.email):raise HTTPException(403,'Only organisation accounts can use Forge')
 key=(request.client.host if request.client else '',a.email.lower());attempts=[t for t in LOGIN_ATTEMPTS.get(key,[]) if t>time.time()-900]
 if len(attempts)>=10:raise HTTPException(429,'Too many attempts. Try again in 15 minutes.')
 LOGIN_ATTEMPTS[key]=attempts+[time.time()];u=db.row('SELECT * FROM users WHERE email=?',(a.email.lower(),))
 if not u or not verify_password(a.password,u['password']):raise HTTPException(401,'Incorrect email or password')
 if not u.get('active',1):raise HTTPException(403,'Your Forge account is disabled; ask an administrator')
 LOGIN_ATTEMPTS.pop(key,None);token=secrets.token_urlsafe(40);expires=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=12)).isoformat()
 with db.connect() as c:c.execute('INSERT INTO sessions VALUES(?,?,?)',(token_hash(token),u['id'],expires))
 r=JSONResponse({'ok':True});r.set_cookie('forge_session',token,httponly=True,samesite='strict',secure=os.getenv('COOKIE_SECURE','false')=='true',max_age=43200);return r
@app.post('/api/auth/logout')
def logout(request:Request):
 user(request)
 with db.connect() as c:c.execute('DELETE FROM sessions WHERE hash=?',(token_hash(request.cookies.get('forge_session','')),))
 r=JSONResponse({'ok':True});r.delete_cookie('forge_session');return r
@app.get('/api/config')
def config():return {'standards':STANDARDS,'manual_checks':MANUAL_CHECKS,'default_rules':db.DEFAULT_RULES,'formats':['.step','.stp','.brep','.brp','.igs','.iges'],'capabilities':{'native_proprietary_cad':False,'unfolding':'Constant-thickness planar/cylindrical developable sheets; unsupported topology is blocked','rules':'Configurable workshop checks plus required engineering checks','fps':'Target 60 fps; actual FPS reported for the current device and assembly'}}
@app.get('/api/settings')
def get_settings(request:Request):user(request);return db.settings()  # workspace defaults for new projects
class SettingsEdit(BaseModel):
 model_config=ConfigDict(extra='forbid')
 sheet_prefixes:list[str]=[];machining_prefixes:list[str]=[];purchased_prefixes:list[str]=[];prefix_strict:bool=True;hide_purchased_by_default:bool=True;carry_over_specs:bool=True
 drawing:dict[str,str]={}
@app.put('/api/settings')
def put_settings(a:SettingsEdit,request:Request):
 """Workspace-wide naming convention and import behaviour. Applies to new uploads and to Re-run classification."""
 u=editor(request,'users.manage');values=a.model_dump()
 for key in ('sheet_prefixes','machining_prefixes','purchased_prefixes'):
  values[key]=[str(x).strip() for x in values[key] if str(x).strip()][:50]
  if any(len(x)>40 for x in values[key]):raise HTTPException(422,'Prefixes must be at most 40 characters')
 seen=set()
 for key in ('sheet_prefixes','machining_prefixes','purchased_prefixes'):
  for x in values[key]:
   if x.lower() in seen:raise HTTPException(422,f'Prefix "{x}" is listed in more than one category')
   seen.add(x.lower())
 values['drawing']={k:str(v).strip()[:80] for k,v in (values.get('drawing') or {}).items() if k in db.DEFAULT_DRAWING}
 with db.connect() as c:db.save_settings(c,values);db.audit(c,u['name'],'settings.updated',values)
 return db.settings()
@app.get('/api/projects')
def projects(request:Request):
 u=user(request)
 rows=db.rows("SELECT p.*, (SELECT COUNT(*) FROM revisions r WHERE r.project_id=p.id) AS revision_count, (SELECT number FROM revisions r WHERE r.project_id=p.id AND r.state='active') AS active_revision, (SELECT status FROM revisions r WHERE r.project_id=p.id AND r.state='active') AS active_status, (SELECT COUNT(*) FROM job_orders j WHERE j.project_id=p.id AND j.status IN ('open','in_progress','on_hold')) AS open_job_orders FROM projects p WHERE archived=0 ORDER BY p.created DESC")
 for r in rows:r['settings']=json.loads(r.get('settings') or '{}');r['rules']=json.loads(r['rules']);r['permissions']=sorted(perms_for(u,r['id']))
 return rows
@app.post('/api/projects')
def create_project(p:Project,request:Request):
 """Project creation collects its conventions up front: part-number prefixes, title block, drawing
 conventions, rule library and default process / drawing templates per category."""
 from .workspace import clean_project_settings,clean_rules,clean_members
 u=editor(request,'project.create');id=db.uid()
 settings=clean_project_settings(p.settings or {});rules=clean_rules(p.rules) if p.rules else dict(db.DEFAULT_RULES);members=clean_members(p.members)
 with db.connect() as c:
  c.execute('INSERT INTO projects(id,name,description,created,rules,code,settings,created_by) VALUES(?,?,?,?,?,?,?,?)',(id,p.name.strip(),p.description,db.now(),json.dumps(rules),p.code.strip().upper(),json.dumps(settings),u['name']))
  for m in members:c.execute('INSERT OR REPLACE INTO project_members VALUES(?,?,?,?)',(id,m['user_id'],m['role'],db.now()))
  db.audit(c,u['name'],'project.created',{'name':p.name,'code':p.code,'settings':settings,'members':members})
 return project(id,request)
@app.get('/api/projects/{pid}')
def project(pid:str,request:Request):
 u=user(request);p=db.row('SELECT * FROM projects WHERE id=?',(pid,))
 if not p:raise HTTPException(404,'Project not found')
 p['rules']=json.loads(p['rules']);p['settings']=json.loads(p.get('settings') or '{}');p['effective_settings']=db.project_settings(pid);p['permissions']=sorted(perms_for(u,pid))
 p['revisions']=db.rows('SELECT * FROM revisions WHERE project_id=? ORDER BY number DESC',(pid,));return p
@app.put('/api/projects/{pid}/rules')
async def update_rules(pid:str,request:Request):
 u=editor(request,'project.settings',pid);body=await request.json()
 if not db.row('SELECT id FROM projects WHERE id=?',(pid,)):raise HTTPException(404,'Project not found')
 from .workspace import clean_rules
 body=clean_rules(body)
 # Rule changes are versioned by the next upload; existing revision snapshots do not change.
 with db.connect() as c:c.execute('UPDATE projects SET rules=? WHERE id=?',(json.dumps(body),pid));db.audit(c,u['name'],'project.rules.updated',body)
 return {'ok':True,'message':'Applies to future revisions'}
CAD_EXTS=('.step','.stp','.brep','.brp','.igs','.iges')
def upload_limit():return int(os.getenv('MAX_UPLOAD_MB','1024'))*1024*1024
def cad_name(name):
 filename=Path(name or '').name;ext=Path(filename).suffix.lower()
 if ext not in CAD_EXTS:raise HTTPException(422,'Export CAD as STEP, BREP or IGES; native proprietary part files are not supported')
 return filename,ext
@app.post('/api/projects/{pid}/revisions')
async def upload(pid:str,request:Request,file:UploadFile=File(...),notes:str=Form('')):
 u=editor(request,'revision.upload',pid);p=db.row('SELECT * FROM projects WHERE id=?',(pid,))
 if not p:raise HTTPException(404,'Project not found')
 filename,ext=cad_name(file.filename)
 rid=db.uid();folder=db.revdir(rid);dest=folder/('source'+ext);h=hashlib.sha256();size=0;limit=upload_limit()
 with dest.open('wb') as out:
  while chunk:=await file.read(1024*1024):
   size+=len(chunk)
   if size>limit:out.close();dest.unlink(missing_ok=True);raise HTTPException(413,'File exceeds configured upload limit')
   h.update(chunk);out.write(chunk)
 return create_revision(pid,p,u,rid,dest,filename,notes,size,h.hexdigest())

# ---------------------------------------------------------------- chunked (resumable) uploads
# Proxies and tunnels cap request bodies (Cloudflare: 100 MB) and request time. Large CAD goes up in chunks:
# start -> PUT each chunk (retryable, any order) -> complete. Chunks land in DATA_DIR/uploads/<id>/ and are
# assembled and hashed on completion; abandoned uploads are removed after a day.
CHUNK=int(os.getenv('UPLOAD_CHUNK_MB','16'))*1024*1024
class UploadStart(BaseModel):
 model_config=ConfigDict(extra='forbid')
 filename:str=Field(min_length=1,max_length=255);size:int=Field(gt=29);notes:str=Field(default='',max_length=4000)
def upload_dir(uid):
 if not _re.fullmatch(r'[0-9a-f]{32}',uid or ''):raise HTTPException(404,'Upload not found')
 return db.ROOT/'uploads'/uid
def upload_meta(uid,u):
 d=upload_dir(uid);f=d/'meta.json'
 if not f.exists():raise HTTPException(404,'Upload not found or expired')
 m=json.loads(f.read_text())
 if m['user']!=u['id']:raise HTTPException(403,'Upload belongs to another session')
 return d,m
def sweep_uploads():
 import shutil,time
 root=db.ROOT/'uploads'
 if not root.exists():return
 for d in root.iterdir():
  try:
   if d.is_dir() and time.time()-d.stat().st_mtime>86400:shutil.rmtree(d,ignore_errors=True)
  except OSError:pass
@app.post('/api/projects/{pid}/uploads')
def upload_start(pid:str,a:UploadStart,request:Request):
 u=editor(request,'revision.upload',pid)
 if not db.row('SELECT id FROM projects WHERE id=?',(pid,)):raise HTTPException(404,'Project not found')
 filename,ext=cad_name(a.filename)
 if a.size>upload_limit():raise HTTPException(413,f'File exceeds the configured upload limit ({upload_limit()//1048576} MB)')
 sweep_uploads()
 uid=uuid.uuid4().hex;d=upload_dir(uid);d.mkdir(parents=True)
 n=(a.size+CHUNK-1)//CHUNK
 (d/'meta.json').write_text(json.dumps({'project':pid,'user':u['id'],'filename':filename,'ext':ext,'size':a.size,'notes':a.notes,'chunks':n,'chunk':CHUNK}))
 return {'upload_id':uid,'chunk_size':CHUNK,'chunks':n}
@app.put('/api/uploads/{uid}/chunks/{index}')
async def upload_chunk(uid:str,index:int,request:Request):
 u=user(request);d,m=upload_meta(uid,u)
 if not 0<=index<m['chunks']:raise HTTPException(422,'Chunk out of range')
 expect=min(m['chunk'],m['size']-index*m['chunk']);tmp=d/f'{index}.part';got=0
 with tmp.open('wb') as out:
  async for piece in request.stream():
   got+=len(piece)
   if got>expect:out.close();tmp.unlink(missing_ok=True);raise HTTPException(413,'Chunk larger than declared')
   out.write(piece)
 if got!=expect:tmp.unlink(missing_ok=True);raise HTTPException(422,f'Chunk {index} incomplete ({got} of {expect} bytes); retry it')
 tmp.replace(d/f'{index}.chunk')
 return {'ok':True,'index':index}
@app.get('/api/uploads/{uid}')
def upload_status(uid:str,request:Request):
 d,m=upload_meta(uid,user(request))
 return {'received':sorted(int(f.stem) for f in d.glob('*.chunk')),'chunks':m['chunks']}
@app.post('/api/uploads/{uid}/complete')
def upload_complete(uid:str,request:Request):
 import shutil
 d,m=upload_meta(uid,user(request));u=editor(request,'revision.upload',m['project'])
 missing=[i for i in range(m['chunks']) if not (d/f'{i}.chunk').exists()]
 if missing:raise HTTPException(409,f'{len(missing)} chunk(s) still missing: {missing[:10]}')
 p=db.row('SELECT * FROM projects WHERE id=?',(m['project'],))
 if not p:raise HTTPException(404,'Project not found')
 rid=db.uid();dest=db.revdir(rid)/('source'+m['ext']);h=hashlib.sha256();size=0
 with dest.open('wb') as out:
  for i in range(m['chunks']):
   with (d/f'{i}.chunk').open('rb') as src:
    while b:=src.read(1024*1024):h.update(b);out.write(b);size+=len(b)
 shutil.rmtree(d,ignore_errors=True)
 if size!=m['size']:dest.unlink(missing_ok=True);raise HTTPException(422,'Assembled file size does not match')
 return create_revision(m['project'],p,u,rid,dest,m['filename'],m['notes'],size,h.hexdigest())

def create_revision(pid,p,u,rid,dest,filename,notes,size,sha):
 if size<30:dest.unlink();raise HTTPException(422,'Empty or invalid CAD file')
 with db.connect() as c:
  c.execute('BEGIN IMMEDIATE')
  if c.execute('SELECT id FROM revisions WHERE project_id=? AND status="processing"',(pid,)).fetchone():dest.unlink();raise HTTPException(409,'Another revision is processing')
  n=c.execute('SELECT COALESCE(MAX(number),0)+1 FROM revisions WHERE project_id=?',(pid,)).fetchone()[0]
  c.execute('INSERT INTO revisions(id,project_id,number,filename,sha256,state,status,created,created_by,notes,manifest) VALUES(?,?,?,?,?,?,?,?,?,?,?)',(rid,pid,n,filename,sha,'pending','processing',db.now(),u['name'],notes,json.dumps({'rules_snapshot':json.loads(p['rules'])})))
  enqueue(c,rid,'import');db.audit(c,u['name'],'revision.uploaded',{'filename':filename,'sha256':sha,'bytes':size},rid)
 try:storage.upload(rid,dest,dest.name)
 except Exception as e:
  # Do not leave a revision queued when durable artifact storage is unavailable.
  with db.connect() as c:
   c.execute('UPDATE revisions SET status="failed",message=? WHERE id=?',(f'Artifact storage upload failed: {str(e)[:300]}',rid));c.execute('UPDATE jobs SET status="failed",error=? WHERE revision_id=? AND status="queued"',(str(e)[:1000],rid))
  raise HTTPException(503,'Artifact storage is unavailable; upload was not queued')
 return get_rev(rid)
@app.get('/api/revisions/{rid}')
def revision(rid:str,request:Request):
 access=revision_access(request,rid);r=get_rev(rid);r['manifest']=json.loads(r['manifest']);r['parts']=[]
 rules=r['manifest'].get('rules_snapshot',db.DEFAULT_RULES)
 for p in db.rows('SELECT * FROM parts WHERE revision_id=? ORDER BY name',(rid,)):
  p=deserialize(p);g=p['geometry'];p['findings']=evaluate(g,p['spec'],rules);p['assets']=[x.name for x in (db.revdir(rid)/'parts'/p['id']).glob('*') if x.suffix in ('.pdf','.dxf','.glb','.json','.step','.png')];r['parts'].append(p)
 for p in r['parts']:p['drawing_options']=json.loads(p.get('drawing_options') or '{}');p['assets']=[a for a in p['assets'] if a not in ('model.glb','flat.glb','shape.brep')]
 try:bend_default=bool(db.project_settings(r['project_id']).get('bend_simulation',True))
 except Exception:bend_default=True
 for p in r['parts']:
  g=p['geometry'] if isinstance(p.get('geometry'),dict) else {}
  # press-brake simulation offered for formed sheet metal; project default, per-part override
  p['bend_sim']=bool(p['drawing_options'].get('bend_sim',bend_default)) if p.get('category')=='sheet_metal' and g.get('bends') and g.get('flat_status')=='supported' else False
 attach_assembly_paths(rid,r['parts'])
 r['assets']=[f.name for f in db.revdir(rid).glob('*') if f.suffix in ('.pdf','.dxf','.zip')];r['jobs']=db.rows('SELECT * FROM jobs WHERE revision_id=? ORDER BY created DESC LIMIT 10',(rid,));r['access']=access['role']
 r['permissions']=sorted(perms_for(access,r['project_id'])) if access['role']!='vendor' else (['cad.download'] if access.get('allow_cad') else [])
 r['joints']=[{**j,'data':json.loads(j['data'])} for j in db.rows('SELECT * FROM joints WHERE revision_id=? ORDER BY created',(rid,))]
 r['job_orders']=db.rows('SELECT id,number,title,status,quantity,due FROM job_orders WHERE revision_id=? ORDER BY number',(rid,)) if access['role']!='vendor' else []
 return r
def attach_assembly_paths(rid,parts):
 """STEP assembly structure for the navigator tree: each part's sub-assembly path (first occurrence),
 without the part itself and without the top-level assembly every part shares."""
 f=db.revdir(rid)/'instances.json'
 if not f.exists():
  try:storage.restore(rid,'instances.json',f)
  except Exception:pass
 try:instances=json.loads(f.read_text()) if f.exists() else {}
 except Exception:instances={}
 paths={}
 for p in parts:
  inst=instances.get(p['id']) or []
  segs=[x.strip() for x in str(inst[0].get('path','')).split(' / ')][:-1] if inst else []
  paths[p['id']]=segs
  p['assemblies']=len({' / '.join([x.strip() for x in str(i.get('path','')).split(' / ')][:-1]) for i in inst}) if inst else 0
 roots={tuple(v[:1]) for v in paths.values() if v}
 strip=1 if len(roots)==1 and all(v for v in paths.values()) else 0
 for p in parts:p['assembly_path']=paths[p['id']][strip:]
def validate_spec(p,spec):
 """Shared checks for single and group specification edits; returns the normalised operations list."""
 for key,value in spec.rule_waivers.items():
  if not isinstance(value,str) or len(value.strip())<10:raise HTTPException(422,'Every waiver needs a written reason of at least 10 characters')
 for key,value in spec.manual_checks.items():
  if key not in MANUAL_CHECKS or (value and (not isinstance(value,str) or len(value.strip())<10)):raise HTTPException(422,'Manual checks require a substantive verification note')
 for fid,fs in spec.feature_specs.items():
  if fid not in [h['id'] for h in p['geometry']['holes']]+[b['id'] for b in p['geometry']['bends']]+['DIM_X','DIM_Y','DIM_Z']:raise HTTPException(422,'Unknown feature ID')
  if not isinstance(fs,dict) or set(fs)-{'designation','lower','upper','hardware'}:raise HTTPException(422,'Feature specification needs designation, lower and upper fields')
  if 'hardware' in fs and (not isinstance(fs['hardware'],dict) or fs['hardware'].get('type') not in HW_TYPES):raise HTTPException(422,'Invalid hole hardware')
  try:
   limits=[float(fs[k]) for k in ('lower','upper') if fs.get(k) is not None]
   if not all(math.isfinite(x) and x>0 for x in limits) or (len(limits)==2 and limits[0]>limits[1]):raise ValueError()
  except (ValueError,TypeError):raise HTTPException(422,'Feature limits must be positive finite numbers with lower <= upper')
 if spec.coating_hex and not re.fullmatch(r'#[0-9a-fA-F]{6}',spec.coating_hex):raise HTTPException(422,'Coating colour must be a #RRGGBB hex value')
 ops=[]
 for op in spec.operations:
  if isinstance(op,str):op={'name':op,'detail':''}
  if not isinstance(op,dict) or not str(op.get('name','')).strip():raise HTTPException(422,'Each process operation needs a name')
  ops.append({'name':str(op['name']).strip()[:120],'detail':str(op.get('detail',''))[:400]})
 return ops
from .hardware import CATALOG as HW_CATALOG,BY_ID as HW_BY_ID,TYPES as HW_TYPES,designation as hw_designation,clean_custom as hw_custom
@app.get('/api/hardware-catalog')
def hardware_catalog(request:Request):
 user(request)
 return {'types':HW_TYPES,'items':HW_CATALOG}
class HoleHardware(BaseModel):
 model_config=ConfigDict(extra='forbid')
 holes:list[str]=Field(min_length=1,max_length=2000)
 item:str|None=None
 custom:dict|None=None
 side:int|None=None
@app.put('/api/parts/{pid}/hardware')
def set_hole_hardware(pid:str,a:HoleHardware,request:Request):
 """Assign (or remove) hole hardware — insert, tap or countersink — on the selected holes. The side is +1 / -1
 along each hole's axis (which face the hardware is pressed in from); the drawing calls it near / far side."""
 p=get_part(pid);u=revision_access(request,p['revision_id'],True,'part.edit');mutable(p['revision_id'])
 holes={h['id']:h for h in p['geometry'].get('holes',[])}
 if any(h not in holes for h in a.holes):raise HTTPException(422,'Unknown hole')
 if a.side not in (None,1,-1):raise HTTPException(422,'Side must be 1 or -1')
 item=None
 if a.custom is not None:
  try:item=hw_custom(a.custom)
  except ValueError as e:raise HTTPException(422,str(e))
 elif a.item:
  if a.item not in HW_BY_ID:raise HTTPException(422,'Unknown hardware')
  item=dict(HW_BY_ID[a.item])
 spec=dict(p['spec']);fs={k:dict(v) for k,v in (spec.get('feature_specs') or {}).items()}
 for hid in a.holes:
  cur=fs.get(hid,{})
  if item is None and a.side is not None and cur.get('hardware'):
   cur['hardware']={**cur['hardware'],'side':a.side}  # flip only
  elif item is None:
   if cur.get('hardware'):cur.pop('hardware',None);cur.pop('designation',None)
  else:
   side=a.side if a.side is not None else (cur.get('hardware') or {}).get('side',1)
   cur['hardware']={**item,'side':side,'axis':[round(float(x),6) for x in holes[hid].get('axis',[0,0,1])]};cur['designation']=hw_designation(item)
  if cur:fs[hid]=cur
  else:fs.pop(hid,None)
 spec['feature_specs']=fs
 with db.connect() as c:
  c.execute('UPDATE parts SET spec=? WHERE id=?',(json.dumps(spec),pid))
  db.audit(c,u['name'],'part.hardware.updated',{'part':pid,'holes':a.holes,'item':(item or {}).get('id'),'name':(item or {}).get('name'),'side':a.side},p['revision_id'])
 invalidate(p['revision_id'],pid)
 return {'ok':True,'feature_specs':fs}
@app.patch('/api/parts/{pid}')
def update_part(pid:str,a:PartEdit,request:Request):
 p=get_part(pid);u=revision_access(request,p['revision_id'],True);mutable(p['revision_id'])
 if a.reviewed and not p['reviewed']:require(u,'design.review',project_of_revision(p['revision_id']))
 if a.category not in ('machining','sheet_metal','purchased','other'):raise HTTPException(422,'Invalid category')
 a.spec.operations=validate_spec(p,a.spec)
 g=p['geometry'];g['category']=a.category;g['classification_confidence']='engineer classified'
 with db.connect() as c:c.execute('UPDATE parts SET category=?,spec=?,reviewed=?,geometry=?,reviewed_by=?,reviewed_at=? WHERE id=?',(a.category,a.spec.model_dump_json(),int(a.reviewed),json.dumps(g),u['name'] if a.reviewed else '',db.now() if a.reviewed else '',pid));db.audit(c,u['name'],'part.specification.updated',{'part':pid,'before':p['spec'],'after':a.spec.model_dump()},p['revision_id'])
 invalidate(p['revision_id'],pid);return {'ok':True}
class DrawingEdit(BaseModel):
 model_config=ConfigDict(extra='forbid')
 scene_hash:str;version:int=Field(ge=0);objects:dict=Field(default_factory=dict,max_length=1000);notes:list[dict]=Field(default_factory=list,max_length=100)
 pictorials:list[dict]|None=Field(default=None,max_length=8)
 extra_pages:list[dict]|None=Field(default=None,max_length=10)
 views:list[dict]|None=Field(default=None,max_length=24)
 details:list[dict]|None=Field(default=None,max_length=12)
 page_order:list[int]|None=Field(default=None,max_length=40)

def drawing_state(p):
 folder=db.revdir(p['revision_id'])/'parts'/p['id'];path=folder/'drawing-scene.json'
 if (folder/'.drawing-invalid').exists():raise HTTPException(409,'Part specification changed; regenerate documents')
 if not path.exists():storage.restore(p['revision_id'],f"parts/{p['id']}/drawing-scene.json",path)
 if not path.exists():raise HTTPException(409,'Generate documents once to create the editable drawing')
 from .drawing_scene import unique_group_ids
 scene=unique_group_ids(json.loads(path.read_text()));r=get_rev(p['revision_id'])
 if scene['source_hash']!=r['sha256']:raise HTTPException(409,'Drawing source has changed; regenerate documents')
 saved=db.row('SELECT * FROM drawing_edits WHERE part_id=?',(p['id'],))
 edits=json.loads(saved['data']) if saved and saved['source_hash']==scene['source_hash'] else {'objects':{},'notes':[]}
 # sheets added in the editor are part of the drawing: extend the generated scene with them
 from .drawings import full_scene,validate_extra_pages
 try:edits['extra_pages']=validate_extra_pages(edits.get('extra_pages') or [])
 except ValueError:edits['extra_pages']=[]
 if not edits['extra_pages']:edits.pop('extra_pages')
 scene=full_scene(p,r,db.project_settings(r['project_id']),scene,edits)
 # Page order and detail views survive only while they still fit the regenerated scene.
 from .drawing_scene import validate_details,page_order
 if edits.get('page_order') and page_order(scene,edits['page_order'])!=edits['page_order']:edits.pop('page_order')
 try:edits['details']=validate_details(scene,edits.get('details') or [])
 except ValueError:edits['details']=[]
 # Views can disappear after regeneration (e.g. a removed pictorial): drop edits that no longer have a target.
 ids={g['id'] for page in scene['pages'] for g in page['groups']}
 edits['objects']={k:v for k,v in edits.get('objects',{}).items() if k in ids}
 return folder,scene,edits,saved['version'] if saved else 0

@app.get('/api/parts/{pid}/drawing')
def editable_drawing(pid:str,request:Request):
 p=get_part(pid);access=revision_access(request,p['revision_id']);r=get_rev(p['revision_id'])
 if db.row('SELECT id FROM jobs WHERE revision_id=? AND status IN ("queued","running")',(p['revision_id'],)):raise HTTPException(409,'Wait for drawing generation to complete')
 _,scene,edits,version=drawing_state(p)
 from . import pictorials
 from .drawings import attach_view_lines
 folder=db.revdir(p['revision_id'])/'parts'/p['id']
 edits=attach_view_lines(p,folder,scene,edits)
 pr=r['project_id'];editable=access['role']!='vendor' and can(access,'drawing.edit',pr) and r['state']=='active' and r['status']=='ready'
 tmpl=db.rows("SELECT id,name,data FROM templates WHERE kind='drawing' AND archived=0 AND (project_id IS NULL OR project_id=?) ORDER BY name",(pr,))
 return {'scene':scene,'edits':edits,'version':version,'name':p['name'],'editable':editable,
  'can_review':access['role']!='vendor' and can(access,'drawing.review',pr) and r['status']=='ready','doc_reviewed':bool(p.get('doc_reviewed')),'doc_reviewed_by':p.get('doc_reviewed_by',''),'doc_reviewed_at':p.get('doc_reviewed_at',''),
  'drawing_options':json.loads(p.get('drawing_options') or '{}'),'revision_id':p['revision_id'],'drawing_templates':[{**t,'data':json.loads(t['data'])} for t in tmpl],'category':p['category'],
  'pictorials':pictorials.normalize(edits.get('pictorials')),'pictorial_presets':pictorials.presets()}

@app.get('/api/parts/{pid}/drawing/blank-sheet')
def blank_sheet(pid:str,size:str,request:Request):
 """An empty template sheet to add in the editor (views and details can be moved onto it)."""
 p=get_part(pid);revision_access(request,p['revision_id'],True,'drawing.edit');r=get_rev(p['revision_id'])
 from .drawings import blank_page,EXTRA_SIZES
 if size not in EXTRA_SIZES:raise HTTPException(422,'Sheet size must be A4, A3 or A2')
 _,scene,_,_=drawing_state(p)
 return blank_page(p,r,db.project_settings(r['project_id']),size,(scene.get('frame') or {}).get('scale') or 1.0)

@app.get('/api/parts/{pid}/pictorial')
def pictorial_view(pid:str,azimuth:float,elevation:float,request:Request):
 """Visible edges of the part from any pictorial angle (model mm), for the editor's view palette."""
 import math
 p=get_part(pid);revision_access(request,p['revision_id'])
 if not (math.isfinite(azimuth) and math.isfinite(elevation) and -360<=azimuth<=360 and -89.5<=elevation<=89.5):raise HTTPException(422,'Angle out of range')
 folder=db.revdir(p['revision_id'])/'parts'/p['id'];path=folder/'drawing-scene.json'
 if not path.exists():storage.restore(p['revision_id'],f"parts/{p['id']}/drawing-scene.json",path)
 scene=json.loads(path.read_text()) if path.exists() else {}
 if not (folder/'shape.brep').exists():raise HTTPException(409,'Part geometry unavailable')
 from .drawings import pictorial_for
 return pictorial_for(p,folder,scene,round(azimuth,3),round(elevation,3))

@app.put('/api/parts/{pid}/drawing')
def save_drawing(pid:str,a:DrawingEdit,request:Request):
 from .drawing_scene import validate_edits,render_scene
 p=get_part(pid);u=revision_access(request,p['revision_id'],True,'drawing.edit');mutable(p['revision_id'])
 folder,scene,old,version=drawing_state(p)
 if a.scene_hash!=scene['scene_hash'] or a.version!=version:raise HTTPException(409,'Drawing changed in another session. Reload before saving.')
 from . import pictorials
 from .drawings import full_scene,validate_extra_pages
 try:
  extra=validate_extra_pages(old.get('extra_pages') or [] if a.extra_pages is None else a.extra_pages)
  base_n=len(scene['pages'])-len(old.get('extra_pages') or [])
  r_=get_rev(p['revision_id'])
  scene={**scene,'pages':scene['pages'][:base_n]}
  scene=full_scene(p,r_,db.project_settings(r_['project_id']),scene,{'extra_pages':extra})
  from .drawing_scene import validate_views
  from .drawings import attach_view_lines
  edits=validate_edits(scene,a.objects,a.notes)
  placed=validate_views(scene,old.get('views',[]) if a.views is None else a.views)
  if placed:edits['views']=placed
  if extra:edits['extra_pages']=extra
  views=old.get('pictorials') if a.pictorials is None else pictorials.normalize(a.pictorials)
  from .drawing_scene import validate_details,page_order
  details=validate_details(scene,old.get('details',[]) if a.details is None else a.details)
  if details:edits['details']=details
  order=old.get('page_order') if a.page_order is None else a.page_order
  if order:
   if page_order(scene,order)!=list(order):raise ValueError('Page order must list every sheet once')
   if list(order)!=list(range(len(scene['pages']))):edits['page_order']=list(order)
 except ValueError as e:raise HTTPException(422,str(e))
 if views is not None:edits['pictorials']=views
 # Pictorial view changes need new hidden-line projections: regenerate this part's drawing in the worker.
 regenerate=(views or None)!=(old.get('pictorials') or None)
 temporary=folder/'drawing-editor.tmp.pdf'
 try:
  render_scene(scene,attach_view_lines(p,folder,scene,edits),target=str(temporary))
  with db.connect() as c:
   c.execute('INSERT INTO drawing_edits(part_id,revision_id,source_hash,version,data,updated,author) VALUES(?,?,?,?,?,?,?) ON CONFLICT(part_id) DO UPDATE SET source_hash=excluded.source_hash,version=excluded.version,data=excluded.data,updated=excluded.updated,author=excluded.author',
    (pid,p['revision_id'],scene['source_hash'],version+1,json.dumps(edits),db.now(),u['name']))
   # Arranging the sheets reopens the document review (the design review stays).
   c.execute("UPDATE parts SET doc_reviewed=0,doc_reviewed_by='',doc_reviewed_at='' WHERE id=?",(pid,))
   db.audit(c,u['name'],'drawing.edited',{'part':pid,'before':old,'after':edits,'version':version+1},p['revision_id'])
   temporary.replace(folder/'drawing.pdf')
   if regenerate:enqueue(c,p['revision_id'],'documents',{'part_id':pid});db.audit(c,u['name'],'documents.requested',{'part_id':pid,'reason':'pictorial views changed'},p['revision_id'])
 finally:temporary.unlink(missing_ok=True)
 # The per-part PDF is current; combined packs must be rebuilt with these edits.
 revision_folder=db.revdir(p['revision_id']);(revision_folder/'.documents-stale').write_text('Drawing presentation changed')
 for name in ('manufacturing-pack.zip','machining-drawings.pdf','sheet-metal-drawings.pdf'):(revision_folder/name).unlink(missing_ok=True)
 storage.upload(p['revision_id'],folder/'drawing.pdf',f'parts/{pid}/drawing.pdf')
 return {'ok':True,'version':version+1,'edits':edits,'regenerating':regenerate}

class PartFlags(BaseModel):
 model_config=ConfigDict(extra='forbid')
 excluded:bool|None=None;exclusion_reason:str=Field(default='',max_length=300);hidden:bool|None=None
@app.patch('/api/parts/{pid}/flags')
def part_flags(pid:str,a:PartFlags,request:Request):
 """Production exclusion (engineering decision, active revisions only) and default viewer visibility."""
 p=get_part(pid);u=revision_access(request,p['revision_id'],True);changes={}
 if a.excluded is not None:
  mutable(p['revision_id'])
  if a.excluded and len(a.exclusion_reason.strip())<3:raise HTTPException(422,'Give a short reason for excluding the part from production')
  changes['excluded']=int(a.excluded);changes['exclusion_reason']=a.exclusion_reason.strip() if a.excluded else '';changes['excluded_by']=u['name'] if a.excluded else '';changes['excluded_at']=db.now() if a.excluded else ''
 if a.hidden is not None:changes['hidden']=int(a.hidden)
 if not changes:raise HTTPException(422,'Nothing to change')
 with db.connect() as c:
  c.execute('UPDATE parts SET '+','.join(k+'=?' for k in changes)+' WHERE id=?',(*changes.values(),pid))
  db.audit(c,u['name'],'part.flags.updated',{'part':pid,**changes},p['revision_id'])
 if 'excluded' in changes:invalidate(p['revision_id'])
 return {'ok':True,**changes}
class GroupSpec(BaseModel):
 model_config=ConfigDict(extra='forbid')
 ids:list[str]=Field(min_length=1,max_length=2000);spec:dict={};category:str|None=None;reviewed:bool|None=None
GROUP_KEYS={'material','stock','finish','paint','coating_color','coating_hex','coating_thickness','masking','process','heat_treatment','hardness','general_tolerance','roughness','datums','edge_treatment','marking','packaging','notes','k_factor','k_factor_approved','operations','manual_checks'}
@app.post('/api/revisions/{rid}/parts/group-spec')
def group_spec(rid:str,a:GroupSpec,request:Request):
 """Apply a partial specification to several parts: only the keys present in `spec` change; feature limits
 and rule dispositions stay per part."""
 u=revision_access(request,rid,True);mutable(rid)
 if set(a.spec)-GROUP_KEYS:raise HTTPException(422,'Unsupported group field: '+', '.join(sorted(set(a.spec)-GROUP_KEYS)))
 if a.category is not None and a.category not in ('machining','sheet_metal','purchased','other'):raise HTTPException(422,'Invalid category')
 if not a.spec and a.category is None and a.reviewed is None:raise HTTPException(422,'Nothing to change')
 if a.reviewed:require(u,'design.review',project_of_revision(rid))
 ids=list(dict.fromkeys(a.ids));n=0
 with db.connect() as c:
  for pid in ids:
   row=c.execute('SELECT * FROM parts WHERE id=? AND revision_id=?',(pid,rid)).fetchone()
   if not row:raise HTTPException(422,'Part outside revision: '+pid)
   p=deserialize(dict(row));merged={**db.DEFAULT_SPEC,**p['spec'],**a.spec}
   spec=Spec(**merged);spec.operations=validate_spec(p,spec)
   g=p['geometry'];sets={'spec':spec.model_dump_json()}
   if a.category is not None:g['category']=a.category;g['classification_confidence']='engineer classified';sets['category']=a.category;sets['geometry']=json.dumps(g)
   if a.reviewed is not None:sets['reviewed']=int(a.reviewed);sets['reviewed_by']=u['name'] if a.reviewed else '';sets['reviewed_at']=db.now() if a.reviewed else ''
   c.execute('UPDATE parts SET '+','.join(k+'=?' for k in sets)+' WHERE id=?',(*sets.values(),pid));n+=1
  db.audit(c,u['name'],'parts.group.specification.updated',{'count':n,'fields':sorted(a.spec),'category':a.category,'reviewed':a.reviewed},rid)
 invalidate(rid)
 for pid in ids:invalidate(rid,pid)
 return {'ok':True,'updated':n}
class BulkReady(BaseModel):
 model_config=ConfigDict(extra='forbid')
 ids:list[str]=Field(min_length=1,max_length=2000)
 fill:dict[str,str]=Field(default_factory=dict)
 overwrite:bool=False
 manual_checks:dict[str,str]=Field(default_factory=dict)
 approve_k:bool=False
 waive_warnings:str=Field(default='',max_length=300)
 design_review:bool=False
 drawing_review:bool=False
 regenerate:bool=False
READY_FIELDS=('material','process','finish','general_tolerance','datums')
@app.post('/api/revisions/{rid}/parts/bulk-ready')
def bulk_ready(rid:str,a:BulkReady,request:Request):
 """Make many parts production ready at once: fill the specification where it is empty, record the engineering
 verifications, accept warnings with one reason, approve K factors, then sign off the design (only parts with no
 open blocker) and the drawings (only current drawings). Every part reports what is still open."""
 u=revision_access(request,rid,True);mutable(rid);proj=project_of_revision(rid)
 if set(a.fill)-set(READY_FIELDS):raise HTTPException(422,'Unsupported field')
 if set(a.manual_checks)-set(MANUAL_CHECKS):raise HTTPException(422,'Unknown verification')
 if any(len(v.strip())<10 for v in a.manual_checks.values()):raise HTTPException(422,'Write at least 10 characters for each verification')
 if a.waive_warnings and len(a.waive_warnings.strip())<10:raise HTTPException(422,'Give a reason of at least 10 characters for accepting the warnings')
 if a.design_review:require(u,'design.review',proj)
 if a.drawing_review:require(u,'drawing.review',proj)
 rules=json.loads((db.row('SELECT rules FROM projects WHERE id=?',(proj,)) or {}).get('rules') or '{}')
 results=[];stale=[]
 for pid in dict.fromkeys(a.ids):
  row=db.row('SELECT * FROM parts WHERE id=? AND revision_id=?',(pid,rid))
  if not row:raise HTTPException(422,'Part outside revision: '+pid)
  p=deserialize(row)
  if p['category']=='purchased' or p.get('excluded'):
   results.append({'id':pid,'name':p['name'],'skipped':'purchased' if p['category']=='purchased' else 'not for production'});continue
  spec=dict(p['spec']);before=json.dumps(spec,sort_keys=True)
  for k,v in a.fill.items():
   if v.strip() and (a.overwrite or not str(spec.get(k,'')).strip()):spec[k]=v.strip()
  mc=dict(spec.get('manual_checks') or {})
  for k,v in a.manual_checks.items():
   if a.overwrite or len(str(mc.get(k,'')).strip())<10:mc[k]=v.strip()
  spec['manual_checks']=mc
  if a.approve_k and p['geometry'].get('bends'):spec['k_factor_approved']=True
  if a.waive_warnings:
   w=dict(spec.get('rule_waivers') or {})
   for f in evaluate(p['geometry'],spec,rules):
    key=f['code']+(':'+f['feature'] if f['feature'] else '')
    if f['severity']=='warning' and not w.get(key):w[key]=a.waive_warnings.strip()
   spec['rule_waivers']=w
  changed=json.dumps(spec,sort_keys=True)!=before
  if changed:
   sp=Spec(**{**db.DEFAULT_SPEC,**spec});sp.operations=validate_spec(p,sp);spec=json.loads(sp.model_dump_json())
   with db.connect() as c:c.execute('UPDATE parts SET spec=? WHERE id=?',(json.dumps(spec),pid))
   invalidate(rid,pid)
  findings=evaluate(p['geometry'],spec,rules)
  open_=[f['title'] for f in findings if f['severity']=='blocker' and (not f['waiver'] or f['code'] in ('GEO001','FLAT001'))]
  open_+=[f['title']+' (warning)' for f in findings if f['severity']=='warning' and not f['waiver']]
  reviewed=bool(p['reviewed']) and not changed
  if a.design_review and not open_ and not reviewed:
   with db.connect() as c:c.execute('UPDATE parts SET reviewed=1,reviewed_by=?,reviewed_at=? WHERE id=?',(u['name'],db.now(),pid))
   reviewed=True
  elif changed and p['reviewed']:
   with db.connect() as c:c.execute("UPDATE parts SET reviewed=0,reviewed_by='',reviewed_at='' WHERE id=?",(pid,))
  folder=db.revdir(rid)/'parts'/pid
  current=(folder/'drawing-scene.json').exists() and not (folder/'.drawing-invalid').exists()
  doc=bool(db.row('SELECT doc_reviewed FROM parts WHERE id=?',(pid,))['doc_reviewed'])
  if a.drawing_review and reviewed and current and not doc:
   with db.connect() as c:c.execute('UPDATE parts SET doc_reviewed=1,doc_reviewed_by=?,doc_reviewed_at=? WHERE id=?',(u['name'],db.now(),pid))
   doc=True
  if not current:stale.append(pid)
  results.append({'id':pid,'name':p['name'],'category':p['category'],'design':reviewed,'drawing':'reviewed' if doc else 'current' if current else 'regenerate','open':open_,'ready':reviewed and doc and not [x for x in open_ if not x.endswith('(warning)')]})
 job=None
 if a.regenerate and stale:
  with db.connect() as c:job=enqueue(c,rid,'documents',{'part_ids':stale})
 with db.connect() as c:db.audit(c,u['name'],'parts.bulk_ready',{'count':len(results),'fill':sorted(a.fill),'checks':sorted(a.manual_checks),'approve_k':a.approve_k,'waived':bool(a.waive_warnings),'design_review':a.design_review,'drawing_review':a.drawing_review,'regenerate':bool(job)},rid)
 return {'results':results,'job':job}
class BulkParts(BaseModel):
 model_config=ConfigDict(extra='forbid')
 ids:list[str]=Field(min_length=1,max_length=2000);excluded:bool|None=None;exclusion_reason:str=Field(default='',max_length=300);hidden:bool|None=None;category:str|None=None
@app.post('/api/revisions/{rid}/parts/bulk')
def bulk_parts(rid:str,a:BulkParts,request:Request):
 """Apply flags / a category to many parts at once (multi-select in the navigator)."""
 u=revision_access(request,rid,True);changes={}
 if a.excluded is not None or a.category is not None:classifiable(rid)
 if a.excluded is not None:
  if a.excluded and len(a.exclusion_reason.strip())<3:raise HTTPException(422,'Give a short reason for excluding parts from production')
  changes['excluded']=int(a.excluded);changes['exclusion_reason']=a.exclusion_reason.strip() if a.excluded else '';changes['excluded_by']=u['name'] if a.excluded else '';changes['excluded_at']=db.now() if a.excluded else ''
 if a.hidden is not None:changes['hidden']=int(a.hidden)
 if a.category is not None and a.category not in ('machining','sheet_metal','purchased','other'):raise HTTPException(422,'Invalid category')
 if not changes and a.category is None:raise HTTPException(422,'Nothing to change')
 ids=list(dict.fromkeys(a.ids));n=0
 with db.connect() as c:
  for pid in ids:
   p=c.execute('SELECT id,geometry,spec FROM parts WHERE id=? AND revision_id=?',(pid,rid)).fetchone()
   if not p:raise HTTPException(422,'Part outside revision: '+pid)
   sets=dict(changes)
   if a.category is not None:
    g=json.loads(p['geometry']);g['category']=a.category;g['classification_confidence']='engineer classified';sets['category']=a.category;sets['geometry']=json.dumps(g)
   c.execute('UPDATE parts SET '+','.join(k+'=?' for k in sets)+' WHERE id=?',(*sets.values(),pid));n+=1
  db.audit(c,u['name'],'parts.bulk.updated',{'count':n,**changes,**({'category':a.category} if a.category else {})},rid)
 if 'excluded' in changes or a.category is not None:invalidate(rid)
 return {'ok':True,'updated':n}
@app.post('/api/revisions/{rid}/reclassify')
def reclassify(rid:str,request:Request):
 """Re-run the make/buy name heuristics and hidden-by-default rule on parts an engineer has not classified."""
 from .cad import classify_name,geometric_category,hidden_by_default,classify_prefix
 u=revision_access(request,rid,True);mutable(rid);changed=0;hidden=0;settings=db.project_settings(project_of_revision(rid))
 with db.connect() as c:
  for p in c.execute('SELECT * FROM parts WHERE revision_id=?',(rid,)).fetchall():
   p=dict(p);g=json.loads(p['geometry'])
   if p['reviewed'] or g.get('classification_confidence')=='engineer classified':continue
   by_prefix=classify_prefix(p['name'],settings);hint=classify_name(p['name']);category=p['category']
   if by_prefix:category=by_prefix;g['classification_confidence']='workspace prefix rule'
   elif hint=='purchased':category='purchased'
   elif hint=='custom':category=geometric_category(g);g['classification_confidence']='name and geometry' # named like a custom part: fall back to the geometric sheet/machining guess
   h=int(p['hidden'] or hidden_by_default(p['name'],category,'',settings)) # never un-hides what an engineer hid
   if category!=p['category'] or h!=p['hidden']:
    g['category']=category;c.execute('UPDATE parts SET category=?,geometry=?,hidden=? WHERE id=?',(category,json.dumps(g),h,p['id']));changed+=int(category!=p['category']);hidden+=int(h and not p['hidden'])
  db.audit(c,u['name'],'revision.reclassified',{'recategorised':changed,'hidden':hidden},rid)
 if changed:invalidate(rid)
 return {'ok':True,'recategorised':changed,'hidden':hidden}
class ProductionEdit(BaseModel):
 model_config=ConfigDict(extra='forbid')
 produced:bool=False;quantity_done:int=Field(default=0,ge=0,le=1000000);note:str=Field(default='',max_length=1000)
@app.get('/api/revisions/{rid}/production')
def production(rid:str,request:Request):revision_access(request,rid);return db.rows('SELECT * FROM production WHERE revision_id=?',(rid,))
@app.put('/api/revisions/{rid}/production/{pid}')
def set_production(rid:str,pid:str,a:ProductionEdit,request:Request):
 """Vendor / shop checklist: mark a part as produced. Open to vendor links and internal roles alike."""
 u=revision_access(request,rid,True,'joborder.update');p=get_part(pid)
 if p['revision_id']!=rid:raise HTTPException(422,'Part outside revision')
 if p.get('excluded'):raise HTTPException(409,'Part is marked not for production')
 with db.connect() as c:
  c.execute('INSERT INTO production(id,revision_id,part_id,produced,quantity_done,note,actor,updated) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(revision_id,part_id) DO UPDATE SET produced=excluded.produced,quantity_done=excluded.quantity_done,note=excluded.note,actor=excluded.actor,updated=excluded.updated',(db.uid(),rid,pid,int(a.produced),a.quantity_done,a.note,u['name'],db.now()))
  db.audit(c,u['name'],'production.updated',{'part':pid,**a.model_dump()},rid)
 return {'ok':True}
@app.post('/api/revisions/{rid}/documents')
async def documents(rid:str,request:Request):
 u=revision_access(request,rid,True,'drawing.edit');r=get_rev(rid)
 if r['status']!='ready':raise HTTPException(409,'Only draft revisions can regenerate documents; released artifacts are locked')
 if db.row('SELECT id FROM jobs WHERE revision_id=? AND kind!="instructions" AND status IN ("queued","running")',(rid,)):raise HTTPException(409,'Job already active')
 body=await request.json()
 if set(body)-{'part_id'}:raise HTTPException(422,'Only part_id is accepted; use the release workflow for releases')
 if body.get('part_id') and get_part(body['part_id'])['revision_id']!=rid:raise HTTPException(422,'Part outside revision')
 with db.connect() as c:id=enqueue(c,rid,'documents',body);db.audit(c,u['name'],'documents.requested',body,rid)
 return {'job_id':id}
@app.get('/api/revisions/{rid}/release-check')
def release_check(rid:str,request:Request):
 revision_access(request,rid);r=get_rev(rid);reasons=[];rules=json.loads(r['manifest']).get('rules_snapshot',db.DEFAULT_RULES)
 if r['status'] not in ('ready','released'):reasons.append('Revision is not ready')
 if r['state']!='active':reasons.append('Revision is not active')
 for p in db.rows('SELECT * FROM parts WHERE revision_id=?',(rid,)):
  p=deserialize(p)
  if p['category']=='purchased' or p.get('excluded'):continue
  if not p['reviewed']:reasons.append(p['name']+': design review not complete')
  if not p.get('doc_reviewed'):reasons.append(p['name']+': drawing not reviewed')
  for f in evaluate(p['geometry'],p['spec'],rules):
   if f['severity']=='blocker' and (not f['waiver'] or f['code'] in ('GEO001','FLAT001')):reasons.append(p['name']+': '+f['title'])
 if db.row('SELECT id FROM fits WHERE revision_id=? AND approved=0',(rid,)):reasons.append('Unapproved mating records')
 return {'can_release':not reasons,'reasons':reasons}
@app.post('/api/revisions/{rid}/release')
def release(rid:str,request:Request):
 u=revision_access(request,rid,True,'revision.release');mutable(rid);check=release_check(rid,request)
 if not check['can_release']:raise HTTPException(409,check)
 with db.connect() as c:
  c.execute('UPDATE revisions SET status="release_pending",release_by=?,release_at=? WHERE id=?',(u['name'],db.now(),rid));id=enqueue(c,rid,'documents',{'release':True});db.audit(c,u['name'],'release.requested',{},rid)
 return {'job_id':id}
@app.get('/api/revisions/{rid}/fits')
def fits(rid:str,request:Request):
 revision_access(request,rid);rs=db.rows('SELECT * FROM fits WHERE revision_id=?',(rid,))
 for r in rs:r['data']=json.loads(r['data'])
 return rs
@app.post('/api/revisions/{rid}/fits')
def add_fit(rid:str,a:FitEdit,request:Request):
 u=revision_access(request,rid,True);mutable(rid)
 for key in ('part_a','part_b'):
  if get_part(a.data.get(key,''))['revision_id']!=rid:raise HTTPException(422,'Select parts in this revision')
 id=db.uid()
 with db.connect() as c:c.execute('INSERT INTO fits VALUES(?,?,?,0)',(id,rid,json.dumps(a.data)));db.audit(c,u['name'],'fit.created',a.data,rid)
 invalidate(rid);return {'id':id}
@app.patch('/api/fits/{fid}')
def edit_fit(fid:str,a:FitEdit,request:Request):
 f=db.row('SELECT * FROM fits WHERE id=?',(fid,))
 if not f:raise HTTPException(404,'Fit not found')
 u=revision_access(request,f['revision_id'],True);mutable(f['revision_id']);d=a.data
 for key in ('part_a','part_b'):
  if get_part(d.get(key,''))['revision_id']!=f['revision_id']:raise HTTPException(422,'Fit parts must belong to this revision')
 if a.approved:
  if not d.get('fit') or not d.get('instructions') or not d.get('torque'):raise HTTPException(422,'Fit, assembly instructions and torque (or N/A reason) required')
  try:
   vals=[float(d[k]) for k in ('hole_min','hole_max','shaft_min','shaft_max')]
   if not all(math.isfinite(x) for x in vals) or vals[0]>vals[1] or vals[2]>vals[3]:raise ValueError()
  except (KeyError,ValueError,TypeError):raise HTTPException(422,'Approved numeric diameter limits required')
  d['min_clearance']=vals[0]-vals[3];d['max_clearance']=vals[1]-vals[2]
 with db.connect() as c:c.execute('UPDATE fits SET data=?,approved=? WHERE id=?',(json.dumps(d),int(a.approved),fid));db.audit(c,u['name'],'fit.updated',d,f['revision_id'])
 invalidate(f['revision_id']);return {'ok':True}
@app.get('/api/revisions/{rid}/comments')
def comments(rid:str,request:Request):revision_access(request,rid);return db.rows('SELECT * FROM comments WHERE revision_id=? ORDER BY created DESC',(rid,))
@app.post('/api/revisions/{rid}/comments')
def add_comment(rid:str,a:Comment,request:Request):
 u=revision_access(request,rid);get_rev(rid)
 if u['role']=='vendor':raise HTTPException(403,'Vendor links are read-only')
 if a.part_id and get_part(a.part_id)['revision_id']!=rid:raise HTTPException(422,'Part outside revision')
 id=db.uid()
 with db.connect() as c:c.execute('INSERT INTO comments VALUES(?,?,?,?,?,?,?,0)',(id,rid,a.part_id,a.feature,u['name'],a.body,db.now()));db.audit(c,u['name'],'review.comment',a.model_dump(),rid)
 return {'id':id}
@app.post('/api/comments/{cid}/resolve')
def resolve_comment(cid:str,request:Request):
 r=db.row('SELECT * FROM comments WHERE id=?',(cid,))
 if not r:raise HTTPException(404,'Comment not found')
 u=revision_access(request,r['revision_id'],True,'design.review')
 with db.connect() as c:c.execute('UPDATE comments SET resolved=1 WHERE id=?',(cid,));db.audit(c,u['name'],'comment.resolved',cid,r['revision_id'])
 return {'ok':True}
@app.get('/api/revisions/{rid}/shares')
def shares(rid:str,request:Request):revision_access(request,rid,True,'share.manage');return db.rows('SELECT id,label,expires,revoked,created,allow_cad FROM shares WHERE revision_id=?',(rid,))
@app.post('/api/revisions/{rid}/shares')
def share(rid:str,a:Share,request:Request):
 u=revision_access(request,rid,True,'share.manage');r=get_rev(rid)
 if r['status'] not in ('ready','released'):raise HTTPException(409,'Analysis must finish before sharing')
 token=secrets.token_urlsafe(40);id=db.uid();expires=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=a.days)).isoformat()
 with db.connect() as c:c.execute('INSERT INTO shares(id,revision_id,hash,label,expires,revoked,created,allow_cad) VALUES(?,?,?,?,?,0,?,?)',(id,rid,token_hash(token),a.label,expires,db.now(),int(a.allow_cad)));db.audit(c,u['name'],'vendor.link.created',{'label':a.label,'expires':expires,'allow_cad':a.allow_cad},rid)
 return {'id':id,'path':f'/vendor/{rid}#token={token}','expires':expires}
@app.delete('/api/shares/{sid}')
def revoke(sid:str,request:Request):
 s=db.row('SELECT * FROM shares WHERE id=?',(sid,))
 if not s:raise HTTPException(404,'Share not found')
 u=revision_access(request,s['revision_id'],True,'share.manage')
 with db.connect() as c:c.execute('UPDATE shares SET revoked=1 WHERE id=?',(sid,));db.audit(c,u['name'],'vendor.link.revoked',sid,s['revision_id'])
 return {'ok':True}
@app.get('/api/revisions/{rid}/qc')
def inspections(rid:str,request:Request):revision_access(request,rid);return db.rows('SELECT * FROM inspections WHERE revision_id=? ORDER BY created DESC',(rid,))
@app.get('/api/revisions/{rid}/qc.csv')
def inspection_csv(rid:str,request:Request):
 revision_access(request,rid);get_rev(rid)
 records=db.rows('SELECT i.*,p.name AS part_name FROM inspections i JOIN parts p ON p.id=i.part_id WHERE i.revision_id=? ORDER BY i.created',(rid,));out=io.StringIO();cols=['serial','part_id','part_name','feature','nominal','lower_limit','upper_limit','measured','unit','result','instrument','operator','created','notes'];writer=csv.DictWriter(out,fieldnames=cols,extrasaction='ignore');writer.writeheader()
 for record in records:
  # Keep spreadsheet formula injection out of vendor-supplied text exports.
  writer.writerow({k:("'"+v if isinstance(v,str) and v.startswith(('=','+','-','@','\t','\r')) else v) for k,v in record.items()})
 return Response(out.getvalue(),media_type='text/csv',headers={'Content-Disposition':'attachment; filename="qc-'+rid+'.csv"'})
@app.post('/api/revisions/{rid}/qc')
def inspect(rid:str,a:Inspection,request:Request):
 u=revision_access(request,rid,True,'qc.record')
 r=get_rev(rid);p=get_part(a.part_id)
 if p['revision_id']!=rid:raise HTTPException(422,'Part outside revision')
 if r['status']!='released':raise HTTPException(409,'Record production QC against a released revision')
 expected_unit='deg' if a.feature in [b['id'] for b in p['geometry']['bends']] else 'mm'
 if a.unit!=expected_unit or not all(math.isfinite(v) for v in [a.nominal,a.lower_limit,a.upper_limit,a.measured]) or a.lower_limit>a.upper_limit:raise HTTPException(422,'Invalid measurement or limits')
 expected=p['spec'].get('feature_specs',{}).get(a.feature,{})
 if expected.get('lower') is None or expected.get('upper') is None:raise HTTPException(422,'Feature lacks approved inspection limits')
 if abs(float(expected['lower'])-a.lower_limit)>1e-8 or abs(float(expected['upper'])-a.upper_limit)>1e-8:raise HTTPException(422,'Limits differ from the released specification')
 result='PASS' if a.lower_limit<=a.measured<=a.upper_limit else 'FAIL';id=db.uid()
 with db.connect() as c:c.execute('INSERT INTO inspections VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(id,rid,a.part_id,a.feature,a.serial,a.nominal,a.lower_limit,a.upper_limit,a.measured,a.unit,result,a.instrument,u['name'],db.now(),a.notes));db.audit(c,u['name'],'qc.recorded',{'id':id,'result':result},rid)
 return {'id':id,'result':result}
@app.get('/api/revisions/{rid}/audit')
def audit(rid:str,request:Request):
 u=revision_access(request,rid)
 if u['role']=='vendor':raise HTTPException(403,'Internal audit only')
 return db.rows('SELECT * FROM audit WHERE revision_id=? ORDER BY created DESC',(rid,))
@app.get('/api/revisions/{rid}/compare/{other}')
def compare(rid:str,other:str,request:Request):
 user(request);a=get_rev(rid);b=get_rev(other)
 if a['project_id']!=b['project_id']:raise HTTPException(422,'Compare revisions of the same project')
 aa={p['name']:deserialize(p) for p in db.rows('SELECT * FROM parts WHERE revision_id=?',(rid,))};bb={p['name']:deserialize(p) for p in db.rows('SELECT * FROM parts WHERE revision_id=?',(other,))};out=[]
 for n in sorted(aa.keys()|bb.keys()):
  p,q=aa.get(n),bb.get(n);state='added' if not q else 'removed' if not p else 'unchanged' if p['geometry']['fingerprint']==q['geometry']['fingerprint'] and p['quantity']==q['quantity'] else 'changed'
  out.append({'name':n,'change':state,'old_quantity':q['quantity'] if q else 0,'new_quantity':p['quantity'] if p else 0})
 return {'parts':out,'matching':'Name and source-body number; rename/split changes require manual reconciliation. No approval carried over.'}
@app.get('/api/revisions/{rid}/assets/{filename}')
def revision_asset(rid:str,filename:str,request:Request):
 access=revision_access(request,rid);get_rev(rid)
 if filename=='assembly.glb':raise HTTPException(403,'3D models are streamed to the Forge viewer only')
 if filename in ('manufacturing-pack.zip','assembly.dxf'):cad_download(access,rid)
 if filename in ('manufacturing-pack.zip','machining-drawings.pdf','sheet-metal-drawings.pdf') and (db.revdir(rid)/'.documents-stale').exists():raise HTTPException(409,'Drawing edits changed; regenerate the manufacturing pack')
 if filename.endswith(('.pdf','.dxf','.zip')) and db.row('SELECT id FROM jobs WHERE revision_id=? AND kind="documents" AND status IN ("queued","running")',(rid,)):raise HTTPException(409,'Documents are being generated; retry when the job completes')
 if filename not in ('assembly.glb','assembly.png','assembly.pdf','assembly.dxf','manufacturing-pack.zip','instances.json','machining-drawings.pdf','sheet-metal-drawings.pdf'):raise HTTPException(404,'Asset not found')
 p=db.revdir(rid)/filename
 if not p.exists():storage.restore(rid,filename,p)
 if not p.exists():raise HTTPException(404,'Asset not generated yet')
 return FileResponse(p,filename=filename if filename.endswith(('.zip','.pdf')) else None)
@app.get('/api/parts/{pid}/assets/{filename}')
def part_asset(pid:str,filename:str,request:Request):
 p=get_part(pid);access=revision_access(request,p['revision_id'])
 if filename in ('model.glb','flat.glb'):raise HTTPException(403,'3D models are streamed to the Forge viewer only')
 if filename in ('part.step','drawing.dxf','flat.dxf'):cad_download(access,p['revision_id'])
 if filename not in ('model.glb','thumb.png') and db.row('SELECT id FROM jobs WHERE revision_id=? AND kind="documents" AND status IN ("queued","running")',(p['revision_id'],)):raise HTTPException(409,'Documents are being generated; retry when the job completes')
 if filename not in ('model.glb','thumb.png','drawing.pdf','drawing.dxf','review.pdf','flat.glb','flat.dxf','flat.json','projections.json','part.step'):raise HTTPException(404,'Asset not found')
 f=db.revdir(p['revision_id'])/'parts'/pid/filename
 if filename in ('drawing.pdf','drawing.dxf','review.pdf','flat.dxf','flat.json','flat.glb') and (f.parent/'.drawing-invalid').exists():raise HTTPException(409,'Part specification changed; regenerate documents')
 if not f.exists():storage.restore(p['revision_id'],f'parts/{pid}/{filename}',f)
 if filename=='thumb.png' and not f.exists() and (f.parent/'model.glb').exists():
  # Revisions imported before thumbnails existed: render once on demand from the lightweight mesh.
  try:
   import trimesh
   from .drawings import render_meshes,thumb_color
   render_meshes([(trimesh.load(f.parent/'model.glb',force='mesh'),__import__('numpy').eye(4))],f,size=(640,420),colors=[thumb_color(p)])
  except Exception as e:raise HTTPException(500,'Thumbnail rendering failed: '+str(e)[:200])
 if not f.exists():raise HTTPException(404,'Generate this document first')
 return FileResponse(f,filename=p['name'].replace('/','_')+'_'+filename if filename.endswith(('.pdf','.dxf')) else None)
from .workspace import router as platform_router
app.include_router(platform_router)
from .quality import router as quality_router
app.include_router(quality_router)
from .assembly import router as assembly_router
app.include_router(assembly_router)
from .welding import router as welding_router
app.include_router(welding_router)
# Built UI is served by the same origin; no CORS, no second production web server.
STATIC=Path(os.getenv('STATIC_DIR',Path(__file__).resolve().parents[2]/'frontend/dist'))
if STATIC.exists():
 app.mount('/assets',StaticFiles(directory=STATIC/'assets'),name='assets')
 @app.get('/{path:path}')
 def spa(path:str):
  if path.startswith('api/'):raise HTTPException(404,'Not found')
  f=(STATIC/path).resolve()
  if path and f.is_file() and STATIC.resolve() in f.parents and f.suffix in ('.ttf','.woff2','.svg','.png','.ico'):return FileResponse(f)
  return FileResponse(STATIC/'index.html')
