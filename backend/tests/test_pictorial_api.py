"""Editor pictorial views: saving new views queues a regeneration; the new scene carries the views."""
import copy,json
from fastapi.testclient import TestClient
from app.cad import analyze,BRepTools
from app.drawings import make_part
from app import db
from app.main import app
from app.security import token_hash
from test_goat_sheet import block


def test_pictorial_views_round_trip(tmp_path,monkeypatch):
 monkeypatch.setattr(db,'ROOT',tmp_path)
 with TestClient(app) as client:
  rid,pid,token='pictrev','pictpart','pictorial-session'
  with db.connect() as c:
   c.execute('INSERT INTO users(id,email,name,password,role,created) VALUES(?,?,?,?,?,?)',('u','p@example.test','Fixture','unused','engineer',db.now()))
   c.execute('INSERT INTO sessions VALUES(?,?,?)',(token_hash(token),'u','2099-01-01'))
   c.execute('INSERT INTO projects(id,name,description,created,rules) VALUES(?,?,?,?,?)',('proj','fixture','',db.now(),json.dumps(db.DEFAULT_RULES)))
   c.execute('INSERT INTO revisions(id,project_id,number,filename,sha256,state,status,created,created_by) VALUES(?,?,?,?,?,?,?,?,?)',(rid,'proj',1,'f.step','source','active','ready',db.now(),'fixture'))
  s=block();g=analyze(s,'ES-MC-009-TEST BLOCK');g['category']='machining';spec=copy.deepcopy(db.DEFAULT_SPEC)
  part={'id':pid,'name':'ES-MC-009-TEST BLOCK','category':'machining','geometry':g,'spec':spec,'quantity':1}
  folder=db.revdir(rid)/'parts'/pid;folder.mkdir(parents=True);BRepTools.Write_s(s,str(folder/'shape.brep'))
  make_part(part,{'id':rid,'number':1,'sha256':'source','status':'ready'},folder,{})
  with db.connect() as c:c.execute('INSERT INTO parts(id,revision_id,name,category,quantity,geometry,spec) VALUES(?,?,?,?,?,?,?)',(pid,rid,part['name'],'machining',1,json.dumps(g),json.dumps(spec)))
  client.cookies.set('forge_session',token);h={'X-Forge-Request':'1'};url=f'/api/parts/{pid}/drawing'
  state=client.get(url).json()
  assert [p['preset'] for p in state['pictorials']]==['iso-front-right'] and len(state['pictorial_presets'])>=8
  views=[{'id':'iso','preset':'iso-back-left'},{'id':'under','preset':'custom','azimuth':200,'elevation':-30,'roll':90,'label':'Underside'}]
  bad=client.put(url,json={'scene_hash':state['scene']['scene_hash'],'version':0,'pictorials':[{'id':'x','preset':'custom','elevation':200}]},headers=h)
  assert bad.status_code==422
  r=client.put(url,json={'scene_hash':state['scene']['scene_hash'],'version':0,'pictorials':views},headers=h).json()
  assert r['regenerating'] and [p['id'] for p in r['edits']['pictorials']]==['iso','under']
  assert client.get(url).status_code==409  # job queued
  from app.worker import run_once
  assert run_once()
  state=client.get(url).json()
  ids={g['id'] for page in state['scene']['pages'] for g in page['groups']}
  assert {'view:iso','view:under'}<=ids
  assert [p['label'] for p in state['pictorials']][1]=='Underside'
  # saving the same views again does not regenerate
  r=client.put(url,json={'scene_hash':state['scene']['scene_hash'],'version':state['version'],'objects':{'view:under':{'dx':10,'dy':5}},'pictorials':views},headers=h).json()
  assert not r['regenerating']


def test_palette_view_drop_hide_and_pdf(tmp_path,monkeypatch):
 monkeypatch.setattr(db,'ROOT',tmp_path)
 with TestClient(app) as client:
  rid,pid,token='droprev','droppart','drop-session'
  with db.connect() as c:
   c.execute('INSERT INTO users(id,email,name,password,role,created) VALUES(?,?,?,?,?,?)',('u2','d@example.test','Fixture','unused','engineer',db.now()))
   c.execute('INSERT INTO sessions VALUES(?,?,?)',(token_hash(token),'u2','2099-01-01'))
   c.execute('INSERT INTO projects(id,name,description,created,rules) VALUES(?,?,?,?,?)',('proj2','fixture','',db.now(),json.dumps(db.DEFAULT_RULES)))
   c.execute('INSERT INTO revisions(id,project_id,number,filename,sha256,state,status,created,created_by) VALUES(?,?,?,?,?,?,?,?,?)',(rid,'proj2',1,'f.step','source','active','ready',db.now(),'fixture'))
  s=block();g=analyze(s,'ES-MC-009-TEST BLOCK');g['category']='machining';spec=copy.deepcopy(db.DEFAULT_SPEC)
  part={'id':pid,'name':'ES-MC-009-TEST BLOCK','category':'machining','geometry':g,'spec':spec,'quantity':1}
  folder=db.revdir(rid)/'parts'/pid;folder.mkdir(parents=True);BRepTools.Write_s(s,str(folder/'shape.brep'))
  make_part(part,{'id':rid,'number':1,'sha256':'source','status':'ready'},folder,{})
  with db.connect() as c:c.execute('INSERT INTO parts(id,revision_id,name,category,quantity,geometry,spec) VALUES(?,?,?,?,?,?,?)',(pid,rid,part['name'],'machining',1,json.dumps(g),json.dumps(spec)))
  client.cookies.set('forge_session',token);h={'X-Forge-Request':'1'};url=f'/api/parts/{pid}/drawing'
  pic=client.get(f'/api/parts/{pid}/pictorial',params={'azimuth':-135,'elevation':35.264}).json()
  assert len(pic['lines'])>10 and pic['hi'][0]>pic['lo'][0]
  state=client.get(url).json();assert state['scene']['frame']['scale']>0
  size_before=(folder/'drawing.pdf').stat().st_size
  view={'id':'pv1','page':0,'cx':300,'cy':300,'scale':.5,'azimuth':-135,'elevation':35.264,'roll':90,'label':'Back left','caption':True,'lines':[[[0,0],[1e6,1e6]]]}
  r=client.put(url,json={'scene_hash':state['scene']['scene_hash'],'version':0,'objects':{'view:iso':{'hidden':True}},'views':[view]},headers=h)
  assert r.status_code==200,r.text
  assert 'lines' not in r.json()['edits']['views'][0]  # client lines are never stored or trusted
  loaded=client.get(url).json();v=loaded['edits']['views'][0]
  assert v['roll']==90 and len(v['lines'])==len(pic['lines']) and loaded['edits']['objects']['view:iso']['hidden']
  from pypdf import PdfReader
  assert 'BACK LEFT' in PdfReader(folder/'drawing.pdf').pages[0].extract_text()
  bad=client.put(url,json={'scene_hash':state['scene']['scene_hash'],'version':1,'objects':{'callout:main:H001':{'hidden':True}}},headers=h)
  assert bad.status_code in (409,422)
