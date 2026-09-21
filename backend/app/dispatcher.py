"""Dispatch persisted CAD jobs to self-destructing DigitalOcean Droplets."""
import base64,datetime,json,os,shlex,shutil,sqlite3,tempfile,time,zipfile
from pathlib import Path
from . import db,digitalocean,storage

RUN_PREFIX='runs'

def _utc_after(seconds):
 return (datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=seconds)).isoformat()

def _fail(job,message):
 with db.connect() as c:
  c.execute('UPDATE jobs SET status="failed",error=? WHERE id=?',(message[:1000],job['id']))
  if job['kind']=='import':c.execute('UPDATE revisions SET status="failed",message=? WHERE id=?',(message[:1000],job['revision_id']))
  if json.loads(job['payload']).get('release'):c.execute('UPDATE revisions SET status="ready",release_by=NULL,release_at=NULL WHERE id=?',(job['revision_id'],))
  db.audit(c,'dispatcher','job.failed',{'reason':message[:300]},job['revision_id'])

def _job_paths(job):
 prefix=f'{RUN_PREFIX}/{job["id"]}'
 return prefix+'/input.zip',prefix+'/result.zip'

def _safe_extract(archive,destination):
 root=destination.resolve()
 with zipfile.ZipFile(archive) as z:
  for member in z.infolist():
   target=(root/member.filename).resolve()
   if target!=root and root not in target.parents:raise ValueError('Unsafe remote result archive')
  z.extractall(root)

def _bundle(job):
 """Make a minimal snapshot: settings and CAD metadata, but no user data."""
 stage=Path(tempfile.mkdtemp(prefix='forge-dispatch-'))
 try:
  data=stage/'data';data.mkdir();copy=data/'forge.sqlite'
  # SQLite WAL means a filesystem copy can omit committed recent rows.
  source_db=sqlite3.connect(db.ROOT/'forge.sqlite');target_db=sqlite3.connect(copy)
  try:source_db.backup(target_db)
  finally:target_db.close();source_db.close()
  with sqlite3.connect(copy) as c:
   for table in ('users','sessions','shares','comments','inspections','audit','production'):c.execute(f'DELETE FROM {table}')
   c.execute('UPDATE jobs SET status="held" WHERE status="queued" AND id!=?',(job['id'],))
   c.execute('UPDATE jobs SET status="queued",error="" WHERE id=?',(job['id'],))
  target=data/'revisions'/job['revision_id'];target.parent.mkdir(parents=True,exist_ok=True)
  shutil.copytree(db.revdir(job['revision_id']),target,dirs_exist_ok=True)
  archive=stage/'input.zip'
  with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
   for path in data.rglob('*'):
    if path.is_file() and path.name not in ('forge.sqlite-wal','forge.sqlite-shm'):z.write(path,path.relative_to(data))
  return stage,archive
 except Exception:
  shutil.rmtree(stage,ignore_errors=True);raise

def _cloud_init(config):
 encoded=base64.b64encode(json.dumps(config,separators=(',',':')).encode()).decode()
 image=os.environ['DO_WORKER_IMAGE']
 command='\n'.join([
  'export DEBIAN_FRONTEND=noninteractive',
  'apt-get update -qq',
  'apt-get install -y -qq docker.io ca-certificates',
  'systemctl enable --now docker',
  'docker pull '+shlex.quote(image),
  'docker run --rm --read-only --tmpfs /tmp:rw,size=4g --memory=7g --cpus=4 -e FORGE_EPHEMERAL_CONFIG='+shlex.quote(encoded)+' '+shlex.quote(image)+' python -m app.ephemeral_worker',
  'shutdown -h now'])
 return '#cloud-config\nruncmd:\n  - [ sh, -ec, '+json.dumps(command)+ ' ]\n'

def _start(job):
 if not storage.enabled():raise RuntimeError('S3_BUCKET is required: an ephemeral worker cannot use the API host volume')
 if not digitalocean.configured():raise RuntimeError('Set DO_TOKEN, DO_WORKER_REGION and DO_WORKER_IMAGE before enabling ephemeral workers')
 stage,archive=_bundle(job)
 try:
  input_key,result_key=_job_paths(job);storage.upload_path(job['revision_id'],archive,input_key)
  timeout=int(os.getenv('DO_WORKER_TIMEOUT_SECONDS','7200'))
  config={'revision_id':job['revision_id'],'input_url':storage.presigned_get(job['revision_id'],input_key,timeout),'result_post':storage.presigned_post(job['revision_id'],result_key,timeout)}
  droplet_id=digitalocean.create('forge-job-'+job['id'][:12],_cloud_init(config),['forge-ephemeral','forge-job-'+job['id']])
  try:
   with db.connect() as c:
    c.execute('UPDATE jobs SET provider_id=?,provider_started=?,provider_deadline=? WHERE id=?',(droplet_id,db.now(),_utc_after(timeout),job['id']))
    db.audit(c,'dispatcher','droplet.created',{'droplet_id':droplet_id,'timeout_seconds':timeout},job['revision_id'])
  except Exception:
   digitalocean.delete(droplet_id);raise
 finally:shutil.rmtree(stage,ignore_errors=True)

def _apply_result(job,result):
 stage=Path(tempfile.mkdtemp(prefix='forge-result-'))
 try:
  _safe_extract(result,stage);remote_db=stage/'forge.sqlite'
  if not remote_db.exists():raise ValueError('Remote result has no database')
  remote=sqlite3.connect(remote_db);remote.row_factory=sqlite3.Row
  revision=dict(remote.execute('SELECT * FROM revisions WHERE id=?',(job['revision_id'],)).fetchone() or {})
  remote_job=dict(remote.execute('SELECT * FROM jobs WHERE id=?',(job['id'],)).fetchone() or {})
  if not revision or not remote_job:raise ValueError('Remote result does not match dispatched job')
  parts=[dict(r) for r in remote.execute('SELECT * FROM parts WHERE revision_id=?',(job['revision_id'],))]
  fits=[dict(r) for r in remote.execute('SELECT * FROM fits WHERE revision_id=?',(job['revision_id'],))];remote.close()
  folder=stage/'revisions'/job['revision_id']
  if not folder.exists():raise ValueError('Remote result has no revision artifacts')
  shutil.copytree(folder,db.revdir(job['revision_id']),dirs_exist_ok=True)
  with db.connect() as c:
   c.execute('BEGIN IMMEDIATE');c.execute('DELETE FROM parts WHERE revision_id=?',(job['revision_id'],));c.execute('DELETE FROM fits WHERE revision_id=?',(job['revision_id'],))
   fields=['id','revision_id','name','category','quantity','geometry','spec','reviewed','hidden','excluded','exclusion_reason','excluded_by','excluded_at']
   for part in parts:c.execute('INSERT INTO parts('+','.join(fields)+') VALUES('+','.join('?' for _ in fields)+')',tuple(part.get(k,'') for k in fields))
   for fit in fits:c.execute('INSERT INTO fits VALUES(?,?,?,?)',(fit['id'],fit['revision_id'],fit['data'],fit['approved']))
   c.execute('UPDATE revisions SET state=?,status=?,progress=?,message=?,manifest=?,release_by=?,release_at=? WHERE id=?',(revision['state'],revision['status'],revision['progress'],revision['message'],revision['manifest'],revision.get('release_by'),revision.get('release_at'),job['revision_id']))
   c.execute('UPDATE jobs SET status=?,error=? WHERE id=?',(remote_job['status'],remote_job.get('error',''),job['id']))
   db.audit(c,'dispatcher','remote.job.applied',{'status':remote_job['status']},job['revision_id'])
  storage.sync_revision(job['revision_id'],db.revdir(job['revision_id']))
 finally:shutil.rmtree(stage,ignore_errors=True)

def _delete(job):
 if job.get('provider_id'):
  digitalocean.delete(job['provider_id'])
  with db.connect() as c:db.audit(c,'dispatcher','droplet.deleted',{'droplet_id':job['provider_id']},job['revision_id'])
 for key in _job_paths(job):
  try:storage.delete_path(job['revision_id'],key)
  except Exception:pass

def _reconcile(job):
 _,result_key=_job_paths(job)
 if storage.exists(job['revision_id'],result_key):
  fd,name=tempfile.mkstemp(prefix='forge-remote-result-',suffix='.zip');os.close(fd);path=Path(name)
  try:
   if not storage.download_path(job['revision_id'],result_key,path):raise RuntimeError('Unable to retrieve remote result')
   _apply_result(job,path)
  except Exception as e:_fail(job,'Remote result rejected: '+str(e))
  finally:
   path.unlink(missing_ok=True);_delete(job)
  return True
 try:expired=datetime.datetime.fromisoformat(job['provider_deadline'])<=datetime.datetime.now(datetime.timezone.utc)
 except Exception:expired=True
 if expired:
  try:_delete(job)
  finally:_fail(job,'Ephemeral Droplet timed out without returning a result')
  return True
 return False

def run_once():
 # One worker at a time makes the SQLite result merge deterministic and caps spend.
 active=db.row('SELECT * FROM jobs WHERE status="running" AND provider_id!="" ORDER BY provider_started LIMIT 1')
 if active:return _reconcile(active)
 job=db.row('SELECT * FROM jobs WHERE status="queued" ORDER BY created LIMIT 1')
 if not job:return False
 with db.connect() as c:
  c.execute('UPDATE jobs SET status="running" WHERE id=? AND status="queued"',(job['id'],))
  if not c.total_changes:return False
 job=db.row('SELECT * FROM jobs WHERE id=?',(job['id'],))
 try:_start(job)
 except Exception as e:_fail(job,'Unable to create ephemeral Droplet: '+str(e))
 return True

if __name__=='__main__':
 db.init()
 while True:
  try:run_once();time.sleep(2)
  except Exception:time.sleep(5)
