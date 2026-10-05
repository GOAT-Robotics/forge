import os,sqlite3,json,uuid,datetime,contextlib
from pathlib import Path
ROOT=Path(os.getenv('DATA_DIR','./.data')).resolve();ROOT.mkdir(parents=True,exist_ok=True)
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def uid():return uuid.uuid4().hex
@contextlib.contextmanager
def connect():
 c=sqlite3.connect(ROOT/'forge.sqlite',timeout=30);c.row_factory=sqlite3.Row;c.execute('PRAGMA foreign_keys=ON');c.execute('PRAGMA busy_timeout=30000')
 try:yield c;c.commit()
 except: c.rollback();raise
 finally:c.close()
def init():
 with connect() as c:
  c.execute('PRAGMA journal_mode=WAL')
  c.executescript('''
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL,created TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,created TEXT NOT NULL,rules TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),number INTEGER NOT NULL,filename TEXT NOT NULL,sha256 TEXT NOT NULL,state TEXT NOT NULL,status TEXT NOT NULL,progress INTEGER DEFAULT 0,message TEXT DEFAULT '',created TEXT NOT NULL,created_by TEXT NOT NULL,notes TEXT DEFAULT '',manifest TEXT DEFAULT '{}',release_by TEXT,release_at TEXT,UNIQUE(project_id,number));
 CREATE TABLE IF NOT EXISTS parts(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES revisions(id),name TEXT NOT NULL,category TEXT NOT NULL,quantity INTEGER NOT NULL,geometry TEXT NOT NULL,spec TEXT NOT NULL,reviewed INTEGER DEFAULT 0);
 CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES revisions(id),kind TEXT NOT NULL,status TEXT NOT NULL,created TEXT NOT NULL,error TEXT DEFAULT '',payload TEXT DEFAULT '{}');
 CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES revisions(id),part_id TEXT,feature TEXT,author TEXT NOT NULL,body TEXT NOT NULL,created TEXT NOT NULL,resolved INTEGER DEFAULT 0);
 CREATE TABLE IF NOT EXISTS shares(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES revisions(id),hash TEXT UNIQUE NOT NULL,label TEXT NOT NULL,expires TEXT NOT NULL,revoked INTEGER DEFAULT 0,created TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS fits(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES revisions(id),data TEXT NOT NULL,approved INTEGER DEFAULT 0);
 CREATE TABLE IF NOT EXISTS inspections(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES revisions(id),part_id TEXT NOT NULL REFERENCES parts(id),feature TEXT NOT NULL,serial TEXT NOT NULL,nominal REAL NOT NULL,lower_limit REAL NOT NULL,upper_limit REAL NOT NULL,measured REAL NOT NULL,unit TEXT NOT NULL,result TEXT NOT NULL,instrument TEXT NOT NULL,operator TEXT NOT NULL,created TEXT NOT NULL,notes TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,revision_id TEXT,actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,created TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS drawing_edits(part_id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,source_hash TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL DEFAULT '{}',updated TEXT NOT NULL,author TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS production(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES revisions(id),part_id TEXT NOT NULL REFERENCES parts(id),produced INTEGER DEFAULT 0,quantity_done INTEGER DEFAULT 0,note TEXT DEFAULT '',actor TEXT NOT NULL,updated TEXT NOT NULL,UNIQUE(revision_id,part_id));
 CREATE TABLE IF NOT EXISTS project_members(project_id TEXT NOT NULL REFERENCES projects(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL,added TEXT NOT NULL,PRIMARY KEY(project_id,user_id));
 CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,description TEXT DEFAULT '',data TEXT NOT NULL,project_id TEXT,created TEXT NOT NULL,updated TEXT NOT NULL,author TEXT NOT NULL,archived INTEGER DEFAULT 0);
 CREATE TABLE IF NOT EXISTS joints(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES revisions(id),kind TEXT NOT NULL,data TEXT NOT NULL,created TEXT NOT NULL,author TEXT NOT NULL,updated TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS job_orders(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),revision_id TEXT NOT NULL REFERENCES revisions(id),number INTEGER NOT NULL,title TEXT NOT NULL,requirement TEXT DEFAULT '',quantity INTEGER NOT NULL,due TEXT DEFAULT '',priority TEXT DEFAULT 'normal',customer TEXT DEFAULT '',status TEXT NOT NULL,created TEXT NOT NULL,created_by TEXT NOT NULL,closed TEXT DEFAULT '',UNIQUE(project_id,number));
 CREATE TABLE IF NOT EXISTS jo_items(id TEXT PRIMARY KEY,job_order_id TEXT NOT NULL REFERENCES job_orders(id),part_id TEXT NOT NULL,part_name TEXT NOT NULL,category TEXT NOT NULL,seq INTEGER NOT NULL,step TEXT NOT NULL,kind TEXT NOT NULL,required INTEGER NOT NULL,done INTEGER DEFAULT 0,rejected INTEGER DEFAULT 0,status TEXT DEFAULT 'pending',started TEXT DEFAULT '',finished TEXT DEFAULT '',updated TEXT DEFAULT '',updated_by TEXT DEFAULT '');
 CREATE TABLE IF NOT EXISTS jo_events(id TEXT PRIMARY KEY,job_order_id TEXT NOT NULL REFERENCES job_orders(id),item_id TEXT,actor TEXT NOT NULL,action TEXT NOT NULL,quantity INTEGER DEFAULT 0,note TEXT DEFAULT '',created TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS char_overrides(part_id TEXT NOT NULL,key TEXT NOT NULL,data TEXT NOT NULL,actor TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(part_id,key));
 CREATE TABLE IF NOT EXISTS measurements(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,part_id TEXT NOT NULL,serial TEXT NOT NULL,char_key TEXT NOT NULL,char_no TEXT NOT NULL,label TEXT NOT NULL,nominal REAL,lower_limit REAL,upper_limit REAL,unit TEXT NOT NULL,critical INTEGER DEFAULT 0,value REAL,attr TEXT DEFAULT '',result TEXT NOT NULL,instrument TEXT DEFAULT '',note TEXT DEFAULT '',actor TEXT NOT NULL,created TEXT NOT NULL,first_article INTEGER DEFAULT 0,disposition TEXT DEFAULT '',disposition_note TEXT DEFAULT '',disposition_by TEXT DEFAULT '',disposition_at TEXT DEFAULT '');
 CREATE TABLE IF NOT EXISTS assembly_steps(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES revisions(id),seq INTEGER NOT NULL,data TEXT NOT NULL,created TEXT NOT NULL,author TEXT NOT NULL,updated TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS assembly_groups(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES revisions(id),seq INTEGER NOT NULL,name TEXT NOT NULL,notes TEXT DEFAULT '',created TEXT NOT NULL,author TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_assembly_steps ON assembly_steps(revision_id,seq);
 CREATE INDEX IF NOT EXISTS idx_measurements ON measurements(part_id,serial);
 CREATE INDEX IF NOT EXISTS idx_jo_items ON jo_items(job_order_id);
 CREATE INDEX IF NOT EXISTS idx_jo_events ON jo_events(job_order_id,created);
 CREATE INDEX IF NOT EXISTS idx_joints ON joints(revision_id);
 CREATE INDEX IF NOT EXISTS idx_parts_revision ON parts(revision_id);
 CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
 ''')
  # Additive migrations for installations created before these columns existed.
  existing={r[1] for r in c.execute('PRAGMA table_info(parts)').fetchall()}
  for column,definition in [('excluded','INTEGER DEFAULT 0'),('exclusion_reason',"TEXT DEFAULT ''"),('hidden','INTEGER DEFAULT 0'),('excluded_by',"TEXT DEFAULT ''"),('excluded_at',"TEXT DEFAULT ''")]:
   if column not in existing:c.execute(f'ALTER TABLE parts ADD COLUMN {column} {definition}')
  for table,cols in {'parts':[('process_template_id',"TEXT DEFAULT ''"),('drawing_options',"TEXT DEFAULT '{}'"),('doc_reviewed',"INTEGER DEFAULT 0"),('doc_reviewed_by',"TEXT DEFAULT ''"),('doc_reviewed_at',"TEXT DEFAULT ''"),('reviewed_by',"TEXT DEFAULT ''"),('reviewed_at',"TEXT DEFAULT ''")],
                     'shares':[('allow_cad','INTEGER DEFAULT 0')],
                     'assembly_steps':[('grp',"TEXT DEFAULT ''")],
                     'users':[('provider',"TEXT DEFAULT 'local'"),('oid',"TEXT DEFAULT ''"),('active','INTEGER DEFAULT 1'),('last_login',"TEXT DEFAULT ''"),('prefs',"TEXT DEFAULT '{}'")],
                     'projects':[('code',"TEXT DEFAULT ''"),('settings',"TEXT DEFAULT '{}'"),('created_by',"TEXT DEFAULT ''"),('archived','INTEGER DEFAULT 0')]}.items():
   have={r[1] for r in c.execute(f'PRAGMA table_info({table})').fetchall()}
   for column,definition in cols:
    if column not in have:c.execute(f'ALTER TABLE {table} ADD COLUMN {column} {definition}')
  c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oid ON users(oid) WHERE oid!=''")
  # A remote CAD run is still one persisted job.  These fields make an
  # interrupted dispatcher able to find and terminate its own Droplet.
  job_columns={r[1] for r in c.execute('PRAGMA table_info(jobs)').fetchall()}
  for column,definition in [('provider_id',"TEXT DEFAULT ''"),('provider_started',"TEXT DEFAULT ''"),('provider_deadline',"TEXT DEFAULT ''")]:
   if column not in job_columns:c.execute(f'ALTER TABLE jobs ADD COLUMN {column} {definition}')
def row(sql,args=()):
 with connect() as c:
  r=c.execute(sql,args).fetchone();return dict(r) if r else None
def rows(sql,args=()):
 with connect() as c:return [dict(r) for r in c.execute(sql,args).fetchall()]
def audit(c,actor,action,detail='',revision=None):c.execute('INSERT INTO audit VALUES(?,?,?,?,?,?)',(uid(),revision,actor,action,json.dumps(detail),now()))
def revdir(id):
 if not id.isalnum():raise ValueError('Invalid revision ID')
 p=ROOT/'revisions'/id;p.mkdir(parents=True,exist_ok=True);return p
DEFAULT_RULES={'min_hole_diameter':1.0,'min_sheet_hole_ratio':1.0,'min_edge_web_ratio':1.5,'min_bend_radius_ratio':1.0,'max_drill_aspect':5.0,'k_factor':0.4,'mesh_deflection':0.8}
DEFAULT_SPEC={'material':'','stock':'','finish':'','paint':'','coating_color':'','coating_hex':'','coating_thickness':'','masking':'','process':'','heat_treatment':'','hardness':'','general_tolerance':'','roughness':'','datums':'','edge_treatment':'','marking':'','packaging':'','notes':'','k_factor':0.4,'k_factor_approved':False,'feature_specs':{},'rule_waivers':{},'manual_checks':{},'operations':[]}

DEFAULT_DRAWING={'company':'GOAT ROBOTICS PRIVATE LIMITED','drawn_by':'','checked_by':'','approved_by':'','module':'','master':'','note':'REMOVE ALL SHARP EDGES','tol_1dec':'\u00b1 0.1','tol_2dec':'\u00b1 0.05','tol_3dec':'\u00b1 0.02','hole_fit':'H7','shaft_fit':'h7','position_tol':'\u00b10.02 mm','surface_finish':''}
DEFAULT_SETTINGS={'sheet_prefixes':[],'machining_prefixes':[],'purchased_prefixes':[],'prefix_strict':True,'hide_purchased_by_default':True,'carry_over_specs':True,'assembly_show_purchased':False,'bend_simulation':True,'drawing':DEFAULT_DRAWING}
def settings():
 """Workspace-wide settings (name prefixes for make/buy segregation etc.), merged over defaults."""
 out=dict(DEFAULT_SETTINGS)
 for r in rows('SELECT key,value FROM settings'):
  if r['key'] in out:
   try:out[r['key']]=json.loads(r['value'])
   except ValueError:pass
 out['drawing']={**DEFAULT_DRAWING,**{k:str(v) for k,v in (out.get('drawing') or {}).items() if k in DEFAULT_DRAWING}}
 return out
def save_settings(c,values):
 for k,v in values.items():
  if k in DEFAULT_SETTINGS:c.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(k,json.dumps(v)))

# ---------------------------------------------------------------- project-wise settings
# Chosen at project creation: naming prefixes, title block, drawing conventions, default templates.
DEFAULT_CONVENTIONS={'standard':'ISO','projection':'third','units':'mm','sheet_size':'auto','hole_table':'auto','general_tolerance':'ISO 2768-mK','dimension_style':'ordinate','thread_callouts':'explicit'}
PROJECT_KEYS=('sheet_prefixes','machining_prefixes','purchased_prefixes','prefix_strict','hide_purchased_by_default','carry_over_specs','assembly_show_purchased','bend_simulation','drawing','conventions','process_templates','drawing_templates')
def project_settings(project_id):
 """Workspace defaults overlaid with the project's own settings (what the worker and editor use)."""
 base=settings();base['conventions']=dict(DEFAULT_CONVENTIONS);base['process_templates']={};base['drawing_templates']={}
 p=row('SELECT settings FROM projects WHERE id=?',(project_id,)) if project_id else None
 own=json.loads(p['settings'] or '{}') if p else {}
 for k in PROJECT_KEYS:
  if k not in own:continue
  if k=='drawing':base['drawing']={**base['drawing'],**{a:str(b) for a,b in own['drawing'].items() if a in DEFAULT_DRAWING}}
  elif k=='conventions':base['conventions']={**base['conventions'],**{a:b for a,b in own['conventions'].items() if a in DEFAULT_CONVENTIONS}}
  else:base[k]=own[k]
 return base
