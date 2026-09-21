import hashlib,hmac,secrets,datetime
from fastapi import HTTPException,Request
from . import db

def password_hash(p):
 salt=secrets.token_hex(16);digest=hashlib.scrypt(p.encode(),salt=salt.encode(),n=16384,r=8,p=1).hex();return salt+':'+digest
def verify_password(p,h):
 salt,d=h.split(':');return hmac.compare_digest(hashlib.scrypt(p.encode(),salt=salt.encode(),n=16384,r=8,p=1).hex(),d)
def token_hash(t):return hashlib.sha256(t.encode()).hexdigest()
def user(request:Request):
 token=request.cookies.get('forge_session','');r=db.row('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND expires>?',(token_hash(token),db.now()))
 if not r:raise HTTPException(401,'Sign in required')
 if request.method not in ('GET','HEAD','OPTIONS'):
  # CSRF: session requests must carry a same-origin custom header; CORS is disabled.
  if request.headers.get('x-forge-request')!='1':raise HTTPException(403,'Missing request verification')
 r.pop('password',None);return r
def editor(request):
 u=user(request)
 if u['role'] not in ('owner','engineer'):raise HTTPException(403,'Engineer access required')
 return u
def revision_access(request,id,write=False):
 if request.headers.get('authorization','').startswith('Bearer '):
  token=request.headers['authorization'][7:];s=db.row('SELECT * FROM shares WHERE hash=? AND revision_id=? AND revoked=0 AND expires>?',(token_hash(token),id,db.now()))
  if not s or write:raise HTTPException(403,'Link expired, revoked or read-only')
  return {'id':s['id'],'name':s['label'],'role':'vendor'}
 return editor(request) if write else user(request)
