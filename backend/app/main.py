import os,re,json,secrets,datetime,hashlib,math,time,io,csv,asyncio
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI,Request,HTTPException,UploadFile,File,Form
from fastapi.responses import FileResponse,JSONResponse,Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel,Field,ConfigDict
from . import db
from .security import user,editor,revision_access,password_hash,verify_password,token_hash
from .rules import evaluate,MANUAL_CHECKS,STANDARDS

@asynccontextmanager
async def lifespan(app):db.init();yield
app=FastAPI(title='Forge Manufacturing',version='0.1.0',lifespan=lifespan)
WRITE_LOCK=asyncio.Lock()
@app.middleware('http')
async def headers(req,call_next):
 if req.method in ('POST','PUT','PATCH','DELETE'):
  async with WRITE_LOCK:res=await call_next(req)
 else:res=await call_next(req)
 res.headers['X-Content-Type-Options']='nosniff';res.headers['Referrer-Policy']='no-referrer';res.headers['X-Frame-Options']='SAMEORIGIN';res.headers['Cache-Control']='no-store';return res
class Auth(BaseModel):email:str;password:str;name:str=''
class Project(BaseModel):name:str=Field(min_length=1,max_length=160);description:str=''
class Spec(BaseModel):
 model_config=ConfigDict(extra='forbid')
 material:str='';stock:str='';finish:str='';paint:str='';coating_color:str='';coating_hex:str='';coating_thickness:str='';masking:str='';process:str='';heat_treatment:str='';hardness:str='';general_tolerance:str='';roughness:str='';datums:str='';edge_treatment:str='';marking:str='';packaging:str='';notes:str='';k_factor:float=Field(default=.4,gt=0,lt=1);k_factor_approved:bool=False;feature_specs:dict={};rule_waivers:dict={};manual_checks:dict={};operations:list=[]
class PartEdit(BaseModel):spec:Spec;category:str;reviewed:bool=False
class Comment(BaseModel):body:str=Field(min_length=1,max_length=5000);part_id:str|None=None;feature:str=''
class Share(BaseModel):label:str=Field(min_length=1,max_length=100);days:int=Field(default=14,ge=1,le=90)
class FitEdit(BaseModel):data:dict;approved:bool=False
class Inspection(BaseModel):
 part_id:str;feature:str;serial:str=Field(min_length=1,max_length=100);nominal:float;lower_limit:float;upper_limit:float;measured:float;unit:str='mm';instrument:str=Field(min_length=1);notes:str=''

def get_rev(rid):
 r=db.row('SELECT * FROM revisions WHERE id=?',(rid,))
 if not r:raise HTTPException(404,'Revision not found')
 return r
def mutable(rid):
 r=get_rev(rid)
 if r['state']!='active' or r['status']!='ready':raise HTTPException(409,'Only an active, ready revision can be edited. Upload a new revision for archived or released designs.')
 if db.row('SELECT id FROM jobs WHERE revision_id=? AND status IN ("queued","running")',(rid,)):raise HTTPException(409,'A CAD job is active; wait for completion')
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
  for file in ['drawing.pdf','drawing.dxf','flat.dxf','flat.glb','flat.json']:(d/'parts'/pid/file).unlink(missing_ok=True)

def enqueue(c,rid,kind,payload={}):
 id=db.uid();c.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)',(id,rid,kind,'queued',db.now(),'',json.dumps(payload)));return id
@app.get('/api/health')
def health():return {'status':'ok','version':'0.1.0'}
@app.get('/api/auth/status')
def auth_status(request:Request):
 configured=bool(db.row('SELECT id FROM users LIMIT 1'))
 try:u=user(request)
 except HTTPException:u=None
 return {'configured':configured,'user':u}
@app.post('/api/auth/setup')
def setup(a:Auth):
 if len(a.password)<12 or '@' not in a.email or not a.name.strip():raise HTTPException(422,'Use a name, valid email and password of at least 12 characters')
 with db.connect() as c:
  c.execute('BEGIN IMMEDIATE')
  if c.execute('SELECT id FROM users LIMIT 1').fetchone():raise HTTPException(409,'Workspace already configured')
  c.execute('INSERT INTO users VALUES(?,?,?,?,?,?)',(db.uid(),a.email.lower(),a.name,password_hash(a.password),'owner',db.now()))
 return {'ok':True}
LOGIN_ATTEMPTS={}
@app.post('/api/auth/login')
def login(a:Auth,request:Request):
 key=(request.client.host if request.client else '',a.email.lower());attempts=[t for t in LOGIN_ATTEMPTS.get(key,[]) if t>time.time()-900]
 if len(attempts)>=10:raise HTTPException(429,'Too many attempts. Try again in 15 minutes.')
 LOGIN_ATTEMPTS[key]=attempts+[time.time()];u=db.row('SELECT * FROM users WHERE email=?',(a.email.lower(),))
 if not u or not verify_password(a.password,u['password']):raise HTTPException(401,'Incorrect email or password')
 LOGIN_ATTEMPTS.pop(key,None);token=secrets.token_urlsafe(40);expires=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=12)).isoformat()
 with db.connect() as c:c.execute('INSERT INTO sessions VALUES(?,?,?)',(token_hash(token),u['id'],expires))
 r=JSONResponse({'ok':True});r.set_cookie('forge_session',token,httponly=True,samesite='strict',secure=os.getenv('COOKIE_SECURE','false')=='true',max_age=43200);return r
@app.post('/api/auth/logout')
def logout(request:Request):
 user(request)
 with db.connect() as c:c.execute('DELETE FROM sessions WHERE hash=?',(token_hash(request.cookies.get('forge_session','')),))
 r=JSONResponse({'ok':True});r.delete_cookie('forge_session');return r
@app.get('/api/users')
def users(request:Request):
 u=user(request)
 if u['role']!='owner':raise HTTPException(403,'Owner access required')
 return db.rows('SELECT id,email,name,role,created FROM users')
class NewUser(Auth):role:str='engineer'
@app.post('/api/users')
def create_user(a:NewUser,request:Request):
 if user(request)['role']!='owner':raise HTTPException(403,'Owner access required')
 if a.role not in ('engineer','qc','viewer') or len(a.password)<12 or '@' not in a.email:raise HTTPException(422,'Invalid role, email or password')
 if db.row('SELECT id FROM users WHERE email=?',(a.email.lower(),)):raise HTTPException(409,'Email already exists')
 with db.connect() as c:c.execute('INSERT INTO users VALUES(?,?,?,?,?,?)',(db.uid(),a.email.lower(),a.name,password_hash(a.password),a.role,db.now()))
 return {'ok':True}
@app.get('/api/config')
def config():return {'standards':STANDARDS,'manual_checks':MANUAL_CHECKS,'default_rules':db.DEFAULT_RULES,'formats':['.step','.stp','.brep','.brp','.igs','.iges'],'capabilities':{'native_proprietary_cad':False,'unfolding':'Constant-thickness planar/cylindrical developable sheets; unsupported topology is blocked','rules':'Configurable workshop checks plus required engineering checks','fps':'Target 60 fps; actual FPS reported for the current device and assembly'}}
@app.get('/api/settings')
def get_settings(request:Request):user(request);return db.settings()
class SettingsEdit(BaseModel):
 model_config=ConfigDict(extra='forbid')
 sheet_prefixes:list[str]=[];machining_prefixes:list[str]=[];purchased_prefixes:list[str]=[];prefix_strict:bool=True;hide_purchased_by_default:bool=True;carry_over_specs:bool=True
@app.put('/api/settings')
def put_settings(a:SettingsEdit,request:Request):
 """Workspace-wide naming convention and import behaviour. Applies to new uploads and to Re-run classification."""
 u=editor(request);values=a.model_dump()
 for key in ('sheet_prefixes','machining_prefixes','purchased_prefixes'):
  values[key]=[str(x).strip() for x in values[key] if str(x).strip()][:50]
  if any(len(x)>40 for x in values[key]):raise HTTPException(422,'Prefixes must be at most 40 characters')
 seen=set()
 for key in ('sheet_prefixes','machining_prefixes','purchased_prefixes'):
  for x in values[key]:
   if x.lower() in seen:raise HTTPException(422,f'Prefix "{x}" is listed in more than one category')
   seen.add(x.lower())
 with db.connect() as c:db.save_settings(c,values);db.audit(c,u['name'],'settings.updated',values)
 return db.settings()
@app.get('/api/projects')
def projects(request:Request):
 user(request);return db.rows('SELECT p.*, (SELECT COUNT(*) FROM revisions r WHERE r.project_id=p.id) AS revision_count FROM projects p ORDER BY p.created DESC')
@app.post('/api/projects')
def create_project(p:Project,request:Request):
 u=editor(request);id=db.uid()
 with db.connect() as c:c.execute('INSERT INTO projects VALUES(?,?,?,?,?)',(id,p.name,p.description,db.now(),json.dumps(db.DEFAULT_RULES)));db.audit(c,u['name'],'project.created',p.model_dump())
 return db.row('SELECT * FROM projects WHERE id=?',(id,))
@app.get('/api/projects/{pid}')
def project(pid:str,request:Request):
 user(request);p=db.row('SELECT * FROM projects WHERE id=?',(pid,))
 if not p:raise HTTPException(404,'Project not found')
 p['rules']=json.loads(p['rules']);p['revisions']=db.rows('SELECT * FROM revisions WHERE project_id=? ORDER BY number DESC',(pid,));return p
@app.put('/api/projects/{pid}/rules')
async def update_rules(pid:str,request:Request):
 u=editor(request);body=await request.json()
 if not db.row('SELECT id FROM projects WHERE id=?',(pid,)):raise HTTPException(404,'Project not found')
 if set(body)!=set(db.DEFAULT_RULES) or any(not isinstance(v,(int,float)) or not math.isfinite(v) or v<=0 for v in body.values()) or not 0<body['k_factor']<1:raise HTTPException(422,'Provide all positive numeric rule values, with K between 0 and 1')
 # Rule changes are versioned by the next upload; existing revision snapshots do not change.
 with db.connect() as c:c.execute('UPDATE projects SET rules=? WHERE id=?',(json.dumps(body),pid));db.audit(c,u['name'],'project.rules.updated',body)
 return {'ok':True,'message':'Applies to future revisions'}
@app.post('/api/projects/{pid}/revisions')
async def upload(pid:str,request:Request,file:UploadFile=File(...),notes:str=Form('')):
 u=editor(request);p=db.row('SELECT * FROM projects WHERE id=?',(pid,))
 if not p:raise HTTPException(404,'Project not found')
 filename=Path(file.filename or '').name;ext=Path(filename).suffix.lower()
 if ext not in ('.step','.stp','.brep','.brp','.igs','.iges'):raise HTTPException(422,'Export CAD as STEP, BREP or IGES; native proprietary part files are not supported')
 rid=db.uid();folder=db.revdir(rid);dest=folder/('source'+ext);h=hashlib.sha256();size=0;limit=int(os.getenv('MAX_UPLOAD_MB','1024'))*1024*1024
 with dest.open('wb') as out:
  while chunk:=await file.read(1024*1024):
   size+=len(chunk)
   if size>limit:out.close();dest.unlink(missing_ok=True);raise HTTPException(413,'File exceeds configured upload limit')
   h.update(chunk);out.write(chunk)
 if size<30:dest.unlink();raise HTTPException(422,'Empty or invalid CAD file')
 with db.connect() as c:
  c.execute('BEGIN IMMEDIATE')
  if c.execute('SELECT id FROM revisions WHERE project_id=? AND status="processing"',(pid,)).fetchone():dest.unlink();raise HTTPException(409,'Another revision is processing')
  n=c.execute('SELECT COALESCE(MAX(number),0)+1 FROM revisions WHERE project_id=?',(pid,)).fetchone()[0]
  c.execute('INSERT INTO revisions(id,project_id,number,filename,sha256,state,status,created,created_by,notes,manifest) VALUES(?,?,?,?,?,?,?,?,?,?,?)',(rid,pid,n,filename,h.hexdigest(),'pending','processing',db.now(),u['name'],notes,json.dumps({'rules_snapshot':json.loads(p['rules'])})))
  enqueue(c,rid,'import');db.audit(c,u['name'],'revision.uploaded',{'filename':filename,'sha256':h.hexdigest(),'bytes':size},rid)
 return get_rev(rid)
@app.get('/api/revisions/{rid}')
def revision(rid:str,request:Request):
 access=revision_access(request,rid);r=get_rev(rid);r['manifest']=json.loads(r['manifest']);r['parts']=[]
 rules=r['manifest'].get('rules_snapshot',db.DEFAULT_RULES)
 for p in db.rows('SELECT * FROM parts WHERE revision_id=? ORDER BY name',(rid,)):
  p=deserialize(p);g=p['geometry'];p['findings']=evaluate(g,p['spec'],rules);p['assets']=[x.name for x in (db.revdir(rid)/'parts'/p['id']).glob('*') if x.suffix in ('.pdf','.dxf','.glb','.json','.step','.png')];r['parts'].append(p)
 r['assets']=[f.name for f in db.revdir(rid).glob('*') if f.suffix in ('.pdf','.dxf','.zip')];r['jobs']=db.rows('SELECT * FROM jobs WHERE revision_id=? ORDER BY created DESC LIMIT 10',(rid,));r['access']=access['role'];return r
def validate_spec(p,spec):
 """Shared checks for single and group specification edits; returns the normalised operations list."""
 for key,value in spec.rule_waivers.items():
  if not isinstance(value,str) or len(value.strip())<10:raise HTTPException(422,'Every waiver needs a written reason of at least 10 characters')
 for key,value in spec.manual_checks.items():
  if key not in MANUAL_CHECKS or (value and (not isinstance(value,str) or len(value.strip())<10)):raise HTTPException(422,'Manual checks require a substantive verification note')
 for fid,fs in spec.feature_specs.items():
  if fid not in [h['id'] for h in p['geometry']['holes']]+[b['id'] for b in p['geometry']['bends']]+['DIM_X','DIM_Y','DIM_Z']:raise HTTPException(422,'Unknown feature ID')
  if not isinstance(fs,dict) or set(fs)-{'designation','lower','upper'}:raise HTTPException(422,'Feature specification needs designation, lower and upper fields')
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
@app.patch('/api/parts/{pid}')
def update_part(pid:str,a:PartEdit,request:Request):
 p=get_part(pid);u=revision_access(request,p['revision_id'],True);mutable(p['revision_id'])
 if a.category not in ('machining','sheet_metal','purchased','other'):raise HTTPException(422,'Invalid category')
 a.spec.operations=validate_spec(p,a.spec)
 g=p['geometry'];g['category']=a.category;g['classification_confidence']='engineer classified'
 with db.connect() as c:c.execute('UPDATE parts SET category=?,spec=?,reviewed=?,geometry=? WHERE id=?',(a.category,a.spec.model_dump_json(),int(a.reviewed),json.dumps(g),pid));db.audit(c,u['name'],'part.specification.updated',{'part':pid,'before':p['spec'],'after':a.spec.model_dump()},p['revision_id'])
 invalidate(p['revision_id'],pid);return {'ok':True}
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
 ids=list(dict.fromkeys(a.ids));n=0
 with db.connect() as c:
  for pid in ids:
   row=c.execute('SELECT * FROM parts WHERE id=? AND revision_id=?',(pid,rid)).fetchone()
   if not row:raise HTTPException(422,'Part outside revision: '+pid)
   p=deserialize(dict(row));merged={**db.DEFAULT_SPEC,**p['spec'],**a.spec}
   spec=Spec(**merged);spec.operations=validate_spec(p,spec)
   g=p['geometry'];sets={'spec':spec.model_dump_json()}
   if a.category is not None:g['category']=a.category;g['classification_confidence']='engineer classified';sets['category']=a.category;sets['geometry']=json.dumps(g)
   if a.reviewed is not None:sets['reviewed']=int(a.reviewed)
   c.execute('UPDATE parts SET '+','.join(k+'=?' for k in sets)+' WHERE id=?',(*sets.values(),pid));n+=1
  db.audit(c,u['name'],'parts.group.specification.updated',{'count':n,'fields':sorted(a.spec),'category':a.category,'reviewed':a.reviewed},rid)
 invalidate(rid)
 for pid in ids:invalidate(rid,pid)
 return {'ok':True,'updated':n}
class BulkParts(BaseModel):
 model_config=ConfigDict(extra='forbid')
 ids:list[str]=Field(min_length=1,max_length=2000);excluded:bool|None=None;exclusion_reason:str=Field(default='',max_length=300);hidden:bool|None=None;category:str|None=None
@app.post('/api/revisions/{rid}/parts/bulk')
def bulk_parts(rid:str,a:BulkParts,request:Request):
 """Apply flags / a category to many parts at once (multi-select in the navigator)."""
 u=revision_access(request,rid,True);changes={}
 if a.excluded is not None or a.category is not None:mutable(rid)
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
 u=revision_access(request,rid,True);mutable(rid);changed=0;hidden=0;settings=db.settings()
 with db.connect() as c:
  for p in c.execute('SELECT * FROM parts WHERE revision_id=?',(rid,)).fetchall():
   p=dict(p);g=json.loads(p['geometry'])
   if p['reviewed'] or g.get('classification_confidence')=='engineer classified':continue
   by_prefix=classify_prefix(p['name'],settings);hint=classify_name(p['name']);category=p['category']
   if by_prefix:category=by_prefix;g['classification_confidence']='workspace prefix rule'
   elif hint=='purchased':category='purchased'
   elif hint=='custom':category=geometric_category(g) # named like a custom part: fall back to the geometric sheet/machining guess
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
 u=revision_access(request,rid);p=get_part(pid)
 if p['revision_id']!=rid:raise HTTPException(422,'Part outside revision')
 if p.get('excluded'):raise HTTPException(409,'Part is marked not for production')
 with db.connect() as c:
  c.execute('INSERT INTO production(id,revision_id,part_id,produced,quantity_done,note,actor,updated) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(revision_id,part_id) DO UPDATE SET produced=excluded.produced,quantity_done=excluded.quantity_done,note=excluded.note,actor=excluded.actor,updated=excluded.updated',(db.uid(),rid,pid,int(a.produced),a.quantity_done,a.note,u['name'],db.now()))
  db.audit(c,u['name'],'production.updated',{'part':pid,**a.model_dump()},rid)
 return {'ok':True}
@app.post('/api/revisions/{rid}/documents')
async def documents(rid:str,request:Request):
 u=revision_access(request,rid,True);r=get_rev(rid)
 if r['status']!='ready':raise HTTPException(409,'Only draft revisions can regenerate documents; released artifacts are locked')
 if db.row('SELECT id FROM jobs WHERE revision_id=? AND status IN ("queued","running")',(rid,)):raise HTTPException(409,'Job already active')
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
  if not p['reviewed']:reasons.append(p['name']+': part not reviewed')
  for f in evaluate(p['geometry'],p['spec'],rules):
   if f['severity']=='blocker' and (not f['waiver'] or f['code'] in ('GEO001','FLAT001')):reasons.append(p['name']+': '+f['title'])
 if db.row('SELECT id FROM fits WHERE revision_id=? AND approved=0',(rid,)):reasons.append('Unapproved mating records')
 return {'can_release':not reasons,'reasons':reasons}
@app.post('/api/revisions/{rid}/release')
def release(rid:str,request:Request):
 u=revision_access(request,rid,True);mutable(rid);check=release_check(rid,request)
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
 if a.part_id and get_part(a.part_id)['revision_id']!=rid:raise HTTPException(422,'Part outside revision')
 id=db.uid()
 with db.connect() as c:c.execute('INSERT INTO comments VALUES(?,?,?,?,?,?,?,0)',(id,rid,a.part_id,a.feature,u['name'],a.body,db.now()));db.audit(c,u['name'],'review.comment',a.model_dump(),rid)
 return {'id':id}
@app.post('/api/comments/{cid}/resolve')
def resolve_comment(cid:str,request:Request):
 r=db.row('SELECT * FROM comments WHERE id=?',(cid,))
 if not r:raise HTTPException(404,'Comment not found')
 u=revision_access(request,r['revision_id'],True)
 with db.connect() as c:c.execute('UPDATE comments SET resolved=1 WHERE id=?',(cid,));db.audit(c,u['name'],'comment.resolved',cid,r['revision_id'])
 return {'ok':True}
@app.get('/api/revisions/{rid}/shares')
def shares(rid:str,request:Request):revision_access(request,rid,True);return db.rows('SELECT id,label,expires,revoked,created FROM shares WHERE revision_id=?',(rid,))
@app.post('/api/revisions/{rid}/shares')
def share(rid:str,a:Share,request:Request):
 u=revision_access(request,rid,True);r=get_rev(rid)
 if r['status'] not in ('ready','released'):raise HTTPException(409,'Analysis must finish before sharing')
 token=secrets.token_urlsafe(40);id=db.uid();expires=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=a.days)).isoformat()
 with db.connect() as c:c.execute('INSERT INTO shares VALUES(?,?,?,?,?,0,?)',(id,rid,token_hash(token),a.label,expires,db.now()));db.audit(c,u['name'],'vendor.link.created',{'label':a.label,'expires':expires},rid)
 return {'id':id,'path':f'/vendor/{rid}#token={token}','expires':expires}
@app.delete('/api/shares/{sid}')
def revoke(sid:str,request:Request):
 s=db.row('SELECT * FROM shares WHERE id=?',(sid,))
 if not s:raise HTTPException(404,'Share not found')
 u=revision_access(request,s['revision_id'],True)
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
 u=user(request)
 if u['role'] not in ('owner','engineer','qc'):raise HTTPException(403,'QC access required')
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
 revision_access(request,rid);get_rev(rid)
 if filename.endswith(('.pdf','.dxf','.zip')) and db.row('SELECT id FROM jobs WHERE revision_id=? AND kind="documents" AND status IN ("queued","running")',(rid,)):raise HTTPException(409,'Documents are being generated; retry when the job completes')
 if filename not in ('assembly.glb','assembly.png','assembly.pdf','assembly.dxf','manufacturing-pack.zip','instances.json','machining-drawings.pdf','sheet-metal-drawings.pdf'):raise HTTPException(404,'Asset not found')
 p=db.revdir(rid)/filename
 if not p.exists():raise HTTPException(404,'Asset not generated yet')
 return FileResponse(p,filename=filename if filename.endswith(('.zip','.pdf')) else None)
@app.get('/api/parts/{pid}/assets/{filename}')
def part_asset(pid:str,filename:str,request:Request):
 p=get_part(pid);revision_access(request,p['revision_id'])
 if filename not in ('model.glb','thumb.png') and db.row('SELECT id FROM jobs WHERE revision_id=? AND kind="documents" AND status IN ("queued","running")',(p['revision_id'],)):raise HTTPException(409,'Documents are being generated; retry when the job completes')
 if filename not in ('model.glb','thumb.png','drawing.pdf','drawing.dxf','flat.glb','flat.dxf','flat.json','projections.json','part.step'):raise HTTPException(404,'Asset not found')
 f=db.revdir(p['revision_id'])/'parts'/pid/filename
 if filename=='thumb.png' and not f.exists() and (f.parent/'model.glb').exists():
  # Revisions imported before thumbnails existed: render once on demand from the lightweight mesh.
  try:
   import trimesh
   from .drawings import render_meshes,thumb_color
   render_meshes([(trimesh.load(f.parent/'model.glb',force='mesh'),__import__('numpy').eye(4))],f,size=(640,420),colors=[thumb_color(p)])
  except Exception as e:raise HTTPException(500,'Thumbnail rendering failed: '+str(e)[:200])
 if not f.exists():raise HTTPException(404,'Generate this document first')
 return FileResponse(f,filename=p['name'].replace('/','_')+'_'+filename if filename.endswith(('.pdf','.dxf')) else None)
# Built UI is served by the same origin; no CORS, no second production web server.
STATIC=Path(os.getenv('STATIC_DIR',Path(__file__).resolve().parents[2]/'frontend/dist'))
if STATIC.exists():
 app.mount('/assets',StaticFiles(directory=STATIC/'assets'),name='assets')
 @app.get('/{path:path}')
 def spa(path:str):
  if path.startswith('api/'):raise HTTPException(404,'Not found')
  return FileResponse(STATIC/'index.html')
