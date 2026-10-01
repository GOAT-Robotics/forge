import hashlib,hmac,secrets,datetime,os
from fastapi import HTTPException,Request
from . import db

def password_hash(p):
 salt=secrets.token_hex(16);digest=hashlib.scrypt(p.encode(),salt=salt.encode(),n=16384,r=8,p=1).hex();return salt+':'+digest
def verify_password(p,h):
 if not h or ':' not in h:return False
 salt,d=h.split(':');return hmac.compare_digest(hashlib.scrypt(p.encode(),salt=salt.encode(),n=16384,r=8,p=1).hex(),d)
def token_hash(t):return hashlib.sha256(t.encode()).hexdigest()
def user(request:Request):
 token=request.cookies.get('forge_session','');r=db.row('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND expires>?',(token_hash(token),db.now()))
 if not r:raise HTTPException(401,'Sign in required')
 if not r.get('active',1):raise HTTPException(403,'Your Forge account is disabled; ask an administrator')
 from .entra import domain_ok
 if not domain_ok(r['email']):raise HTTPException(403,'Only organisation accounts can use Forge')
 if request.method not in ('GET','HEAD','OPTIONS'):
  # CSRF: session requests must carry a same-origin custom header; CORS is disabled.
  if request.headers.get('x-forge-request')!='1':raise HTTPException(403,'Missing request verification')
 r.pop('password',None);return r
def editor(request,perm='part.edit',project_id=None):
 from .access import require
 return require(user(request),perm,project_id)
def revision_access(request,id,write=False,perm='part.edit'):
 if request.headers.get('authorization','').startswith('Bearer '):
  token=request.headers['authorization'][7:];s=db.row('SELECT * FROM shares WHERE hash=? AND revision_id=? AND revoked=0 AND expires>?',(token_hash(token),id,db.now()))
  if not s or write:raise HTTPException(403,'Link expired, revoked or read-only')
  return {'id':s['id'],'name':s['label'],'role':'vendor','allow_cad':bool(s.get('allow_cad'))}
 u=user(request)
 if write:
  from .access import require,project_of_revision
  require(u,perm,project_of_revision(id))
 return u

# ---------------------------------------------------------------- signed, expiring URLs (HMAC)
def secret():
 s=os.getenv('FORGE_SECRET')
 if s:return s.encode()
 f=db.ROOT/'.forge-secret'
 if not f.exists():f.write_text(secrets.token_hex(32));f.chmod(0o600)
 return f.read_text().strip().encode()
def sign(payload:str,ttl=120):
 exp=int(datetime.datetime.now(datetime.timezone.utc).timestamp())+ttl
 mac=hmac.new(secret(),f'{payload}|{exp}'.encode(),hashlib.sha256).hexdigest()[:40]
 return exp,mac
def verify(payload:str,exp:int,mac:str):
 if exp<datetime.datetime.now(datetime.timezone.utc).timestamp():return False
 good=hmac.new(secret(),f'{payload}|{exp}'.encode(),hashlib.sha256).hexdigest()[:40]
 return hmac.compare_digest(good,mac or '')
