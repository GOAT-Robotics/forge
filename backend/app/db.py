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
 CREATE TABLE IF NOT EXISTS production(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES revisions(id),part_id TEXT NOT NULL REFERENCES parts(id),produced INTEGER DEFAULT 0,quantity_done INTEGER DEFAULT 0,note TEXT DEFAULT '',actor TEXT NOT NULL,updated TEXT NOT NULL,UNIQUE(revision_id,part_id));
 CREATE INDEX IF NOT EXISTS idx_parts_revision ON parts(revision_id);
 CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
 ''')
  # Additive migrations for installations created before these columns existed.
  existing={r[1] for r in c.execute('PRAGMA table_info(parts)').fetchall()}
  for column,definition in [('excluded','INTEGER DEFAULT 0'),('exclusion_reason',"TEXT DEFAULT ''"),('hidden','INTEGER DEFAULT 0'),('excluded_by',"TEXT DEFAULT ''"),('excluded_at',"TEXT DEFAULT ''")]:
   if column not in existing:c.execute(f'ALTER TABLE parts ADD COLUMN {column} {definition}')
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

DEFAULT_SETTINGS={'sheet_prefixes':[],'machining_prefixes':[],'purchased_prefixes':[],'prefix_strict':True,'hide_purchased_by_default':True,'carry_over_specs':True}
def settings():
 """Workspace-wide settings (name prefixes for make/buy segregation etc.), merged over defaults."""
 out=dict(DEFAULT_SETTINGS)
 for r in rows('SELECT key,value FROM settings'):
  if r['key'] in out:
   try:out[r['key']]=json.loads(r['value'])
   except ValueError:pass
 return out
def save_settings(c,values):
 for k,v in values.items():
  if k in DEFAULT_SETTINGS:c.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(k,json.dumps(v)))
