"""Import a local reference assembly without creating any user account."""
import sys,shutil,hashlib,json
from pathlib import Path
from . import db
p=Path(sys.argv[1]).resolve();db.init();name=sys.argv[2] if len(sys.argv)>2 else p.stem
existing=db.row('SELECT id FROM projects WHERE name=?',(name,))
if existing:print('Project already exists:',existing['id']);raise SystemExit(0)
pid=db.uid();rid=db.uid();target=db.revdir(rid)/('source'+p.suffix.lower());shutil.copy2(p,target)
with db.connect() as c:
 c.execute('INSERT INTO projects(id,name,description,created,rules) VALUES(?,?,?,?,?)',(pid,name,'Reference assembly imported for validation. No engineering approvals inferred.',db.now(),json.dumps(db.DEFAULT_RULES)))
 c.execute('INSERT INTO revisions(id,project_id,number,filename,sha256,state,status,created,created_by,manifest) VALUES(?,?,?,?,?,?,?,?,?,?)',(rid,pid,1,p.name,hashlib.file_digest(p.open('rb'),'sha256').hexdigest(),'pending','processing',db.now(),'Local reference import',json.dumps({'rules_snapshot':db.DEFAULT_RULES})))
 c.execute('INSERT INTO jobs(id,revision_id,kind,status,created,error,payload) VALUES(?,?,?,?,?,?,?)',(db.uid(),rid,'import','queued',db.now(),'','{}'))
print('Queued project',pid,'revision',rid)
