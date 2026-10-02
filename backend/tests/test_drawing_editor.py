import copy,io,json,hashlib
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox,BRepPrimAPI_MakeCylinder,BRepPrimAPI_MakeCone
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut,BRepAlgoAPI_Fuse
from OCP.gp import gp_Ax2,gp_Pnt,gp_Dir
from app.cad import analyze,BRepTools
from app.hole_features import hole_features,feature_lines
from app.drawing_scene import SceneCanvas,render_scene,validate_edits,group
from app.drawings import make_part
from app import db
from app.main import app
from app.security import token_hash


def chamfered(stepped=False):
 block=BRepPrimAPI_MakeBox(40,30,10).Shape()
 axis=lambda z:gp_Ax2(gp_Pnt(10,10,z),gp_Dir(0,0,1))
 hole=BRepPrimAPI_MakeCylinder(axis(0),3,10).Shape()
 if stepped:hole=BRepAlgoAPI_Fuse(hole,BRepPrimAPI_MakeCylinder(axis(7),4,3).Shape()).Shape()
 cone=BRepPrimAPI_MakeCone(axis(9),4 if stepped else 3,5 if stepped else 4,1).Shape()
 return BRepAlgoAPI_Cut(BRepAlgoAPI_Cut(block,hole).Shape(),cone).Shape()

@pytest.mark.parametrize('stepped',[False,True])
def test_connected_bore_and_chamfer_are_one_hole(stepped):
 shape=chamfered(stepped);g=analyze(shape,'block');features=hole_features(shape,g['holes'])
 assert len(features)==1
 f=features[0];assert f['diameter']==pytest.approx(6);assert f['through']
 assert f['entrances'][0]['angle']==pytest.approx(90)
 assert f['entrances'][0]['diameter']==pytest.approx(10 if stepped else 8)
 assert len(f['hole_ids'])==(2 if stepped else 1)
 assert len(f['steps'])==(1 if stepped else 0)
 assert feature_lines(f)[0]=='DIA 6.000 THRU'
 assert 'Near side' in feature_lines(f)[-1]
 assert not any('M6' in line or '6H' in line for line in feature_lines(f))


def test_collinear_holes_across_a_gap_stay_separate():
 axis=lambda z:gp_Ax2(gp_Pnt(10,10,z),gp_Dir(0,0,1))
 bodies=[]
 for z in (0,10):
  b=BRepPrimAPI_MakeBox(gp_Pnt(0,0,z),40,30,5).Shape()
  bodies.append(BRepAlgoAPI_Cut(b,BRepPrimAPI_MakeCylinder(axis(z),3,5).Shape()).Shape())
 shape=BRepAlgoAPI_Fuse(*bodies).Shape();features=hole_features(shape,analyze(shape,'block')['holes'])
 assert len(features)==2 and all(f['through'] for f in features)


def test_scene_records_circles_and_replays_edits():
 c=SceneCanvas(io.BytesIO());c.circle(30,40,5)
 with group(c,'v','view'):c.line(0,0,10,10)
 with group(c,'h','callout',anchor=[20,20],bounds=[40,40,100,60],lines=['DIA 6 THRU'],size=8):c.drawString(40,50,'DIA 6 THRU')
 c.showPage();c.save();scene=c.scene('source')
 assert any(n['type']=='path' and any(op[0]=='C' for op in n['commands']) for g in scene['pages'][0]['groups'] for n in g['nodes'])
 edits=validate_edits(scene,{'h':{'dx':12,'dy':6,'text':'M6 - 6H DEPTH 12\nPRESS FIT FOR DOWEL'}},[])
 out=io.BytesIO();render_scene(scene,edits,target=out)
 from pypdf import PdfReader
 text=PdfReader(out).pages[0].extract_text()
 assert 'M6 - 6H DEPTH 12' in text and 'PRESS FIT FOR DOWEL' in text and 'DIA 6 THRU' not in text
 with pytest.raises(ValueError):validate_edits(scene,{'v':{'text':'change geometry'}},[])
 with pytest.raises(ValueError):validate_edits(scene,{'h':{'dx':float('nan')}},[])


def test_editor_save_reload_permissions_conflict_and_regeneration(tmp_path,monkeypatch):
 monkeypatch.setattr(db,'ROOT',tmp_path)
 with TestClient(app) as client:
  rid='testrevision';pid='testpart';project='testproject';user='testuser';token='isolated-test-session'
  with db.connect() as c:
   c.execute('INSERT INTO users(id,email,name,password,role,created) VALUES(?,?,?,?,?,?)',(user,'editor@example.test','Fixture Editor','unused','engineer',db.now()))
   c.execute('INSERT INTO sessions VALUES(?,?,?)',(token_hash(token),user,'2099-01-01'))
   c.execute('INSERT INTO projects(id,name,description,created,rules) VALUES(?,?,?,?,?)',(project,'fixture','',db.now(),json.dumps(db.DEFAULT_RULES)))
   c.execute('INSERT INTO revisions(id,project_id,number,filename,sha256,state,status,created,created_by) VALUES(?,?,?,?,?,?,?,?,?)',(rid,project,1,'fixture.step','source','active','ready',db.now(),'fixture'))
  shape=chamfered(True);g=analyze(shape,'block');g['category']='machining';spec=copy.deepcopy(db.DEFAULT_SPEC)
  part={'id':pid,'name':'Fixture block','category':'machining','geometry':g,'spec':spec,'quantity':1}
  folder=db.revdir(rid)/'parts'/pid;folder.mkdir(parents=True);BRepTools.Write_s(shape,str(folder/'shape.brep'))
  rev={'id':rid,'number':1,'sha256':'source','status':'ready'};make_part(part,rev,folder,{})
  with db.connect() as c:c.execute('INSERT INTO parts(id,revision_id,name,category,quantity,geometry,spec) VALUES(?,?,?,?,?,?,?)',(pid,rid,part['name'],part['category'],1,json.dumps(g),json.dumps(spec)))
  original=(folder/'shape.brep').read_bytes();client.cookies.set('forge_session',token);headers={'X-Forge-Request':'1'}
  url=f'/api/parts/{pid}/drawing';state=client.get(url).json();assert state['editable']
  callout=next(group for page in state['scene']['pages'] for group in page['groups'] if group['kind']=='callout' and group.get('feature_ids'))
  payload={'scene_hash':state['scene']['scene_hash'],'version':0,'objects':{callout['id']:{'dx':20,'dy':-15,'text':'M6 - 6H DEPTH 12\nPRESS FIT FOR DOWEL'}},'notes':[{'id':'note:fixture','page':0,'x':150,'y':150,'size':9,'text':'DEBURR AFTER MACHINING'}]}
  assert client.put(url,json=payload).status_code==403
  response=client.put(url,json=payload,headers=headers);assert response.status_code==200,response.text
  assert client.put(url,json=payload,headers=headers).status_code==409
  loaded=client.get(url).json();assert loaded['version']==1 and loaded['edits']['objects']==payload['objects']
  assert client.get(f'/api/revisions/{rid}/assets/machining-drawings.pdf').status_code==409
  from pypdf import PdfReader
  text='\n'.join(p.extract_text() for p in PdfReader(folder/'drawing.pdf').pages)
  assert 'PRESS FIT FOR DOWEL' in text and 'DEBURR AFTER MACHINING' in text
  # Regeneration uses stored presentation edits; source remains unchanged.
  from app.worker import process_documents
  process_documents(rid,{'part_id':pid})
  text='\n'.join(p.extract_text() for p in PdfReader(folder/'drawing.pdf').pages)
  assert 'PRESS FIT FOR DOWEL' in text
  assert (folder/'shape.brep').read_bytes()==original
  assert json.loads(db.row('SELECT spec FROM parts WHERE id=?',(pid,))['spec'])==spec
  with db.connect() as c:c.execute('INSERT INTO shares(id,revision_id,hash,label,expires,revoked,created) VALUES(?,?,?,?,?,?,?)',('vendor',rid,token_hash('fixture-vendor'),'Fixture vendor','2099-01-01',0,db.now()))
  vendor_headers={'Authorization':'Bearer fixture-vendor','X-Forge-Request':'1'}
  assert not client.get(url,headers=vendor_headers).json()['editable']
  assert client.put(url,json={**payload,'version':1},headers=vendor_headers).status_code==403
  with db.connect() as c:c.execute('UPDATE revisions SET status="released" WHERE id=?',(rid,))
  assert not client.get(url).json()['editable']
  assert client.put(url,json={**payload,'version':1},headers=headers).status_code==409
  with db.connect() as c:
   c.execute('UPDATE revisions SET status="ready" WHERE id=?',(rid,));c.execute('UPDATE users SET role="viewer" WHERE id=?',(user,))
  assert not client.get(url).json()['editable']
  assert client.put(url,json={**payload,'version':1},headers=headers).status_code==403


def test_blind_bore_is_depth_not_through():
 shape=BRepPrimAPI_MakeBox(40,30,10).Shape()
 tool=BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(10,10,2),gp_Dir(0,0,1)),3,8).Shape()
 shape=BRepAlgoAPI_Cut(shape,tool).Shape()
 features=hole_features(shape,analyze(shape,'blind block')['holes'])
 assert len(features)==1 and not features[0]['through']
 assert features[0]['depth']==pytest.approx(8)
 assert feature_lines(features[0])[0]=='DIA 6.000 DEPTH 8.00'


def test_hidden_lines_can_be_switched_off_per_view():
 import io as _io
 from reportlab.lib.units import mm
 from app import sheet
 from app.cad import analyze
 from app.drawing_scene import is_hidden_line
 from reportlab.pdfgen import canvas
 from test_goat_sheet import block
 s=block();g=analyze(s,'BLOCK');p={'id':'b','name':'BLOCK','category':'machining','quantity':1,'geometry':g,'spec':{}}
 c=SceneCanvas(_io.BytesIO(),pagesize=(297*mm,210*mm))
 for sh in sheet.build_sheets(s,p,{'number':1},{}):sheet.render_pdf(sh,c)
 c.save();scene=c.scene('x')
 views=[gr for gr in scene['pages'][0]['groups'] if gr['kind']=='view' and any(is_hidden_line(n) for n in gr['nodes'])]
 assert views, 'the test block has blind holes drawn hidden'
 edits={'objects':{v['id']:{'hidden_lines':False} for v in views}}
 assert validate_edits(scene,edits['objects'],[])
 with pytest.raises(ValueError):validate_edits(scene,{views[0]['id']:{'hidden_lines':'no'}},[])
 drawn=[]
 class Rec(canvas.Canvas):
  def drawPath(self,path,stroke=1,fill=0,fillMode=None):drawn.append(getattr(self,'_dash',None));super().drawPath(path,stroke,fill,fillMode)
  def setDash(self,array=[],phase=0):self._dash=list(array) if isinstance(array,(list,tuple)) else [array];super().setDash(array,phase)
 render_scene(scene,{},c=Rec(_io.BytesIO()));with_hidden=sum(1 for d in drawn if d and len(d)==2)
 drawn.clear();render_scene(scene,edits,c=Rec(_io.BytesIO()));without=sum(1 for d in drawn if d and len(d)==2)
 assert with_hidden>0 and without==0


def test_callout_arrow_flips_and_callouts_can_be_hidden():
 import io as _io
 from reportlab.lib.units import mm
 from app import sheet
 from app.cad import analyze
 from test_goat_sheet import block
 s=block();g=analyze(s,'BLOCK');p={'id':'b','name':'BLOCK','category':'machining','quantity':1,'geometry':g,'spec':{}}
 c=SceneCanvas(_io.BytesIO(),pagesize=(297*mm,210*mm))
 for sh in sheet.build_sheets(s,p,{'number':1},{}):sheet.render_pdf(sh,c)
 c.save();scene=c.scene('x')
 call=next(gr for gr in scene['pages'][0]['groups'] if gr['kind']=='callout')
 view=next(gr for gr in scene['pages'][0]['groups'] if gr['kind']=='view')
 assert validate_edits(scene,{call['id']:{'flip':True,'hidden':False}},[])
 with pytest.raises(ValueError):validate_edits(scene,{view['id']:{'flip':True}},[])
 with pytest.raises(ValueError):validate_edits(scene,{call['id']:{'flip':'yes'}},[])
 from reportlab.pdfgen import canvas
 lines=[]
 class Rec(canvas.Canvas):
  def line(self,*a):lines.append(a);super().line(*a)
 render_scene(scene,{},c=Rec(_io.BytesIO()));plain=len(lines)
 lines.clear();render_scene(scene,{'objects':{call['id']:{'flip':True}}},c=Rec(_io.BytesIO()))
 assert len(lines)==plain+1, 'flipped arrow draws the extension beyond the feature'
 lines.clear();render_scene(scene,{'objects':{call['id']:{'hidden':True}}},c=Rec(_io.BytesIO()))
 assert len(lines)<plain


def test_pocket_depth_slot_and_arc_radius_are_called_out():
 """Pocket floors get a depth note and are located; outline / cut-out arcs get R notes with centres."""
 from app import sheet
 from app.cad import analyze
 from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox,BRepPrimAPI_MakeCylinder
 from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
 from OCP.gp import gp_Pnt,gp_Ax2,gp_Dir
 plate=BRepPrimAPI_MakeBox(200,120,12).Shape()
 pocket=BRepPrimAPI_MakeBox(gp_Pnt(40,30,8),60,40,10).Shape()
 moon=BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(200,60,-1),gp_Dir(0,0,1)),30,20).Shape()
 s=BRepAlgoAPI_Cut(BRepAlgoAPI_Cut(plate,pocket).Shape(),moon).Shape()
 g=analyze(s,'PLATE')
 feats=sheet.profile_features(s,g)
 pk=[f for f in feats if f['kind']=='pocket']
 assert len(pk)==1 and abs(pk[0]['depth']-4)<1e-6 and not pk[0]['open']
 _,_,arcs=sheet.edge_notes(s,g)
 assert 30.0 in arcs and arcs[30.0][0]['angle']<2*3.15
 p={'id':'p','name':'PLATE','category':'machining','quantity':1,'geometry':g,'spec':{}}
 shs=sheet.build_sheets(s,p,{'number':1},{})
 texts=[c['lines'][0] for sh in shs for c in sh.callouts.values()]
 assert any(t.startswith('POCKET') and '4.00' in t for t in texts), texts
 assert any(t.startswith('R30.00') for t in texts), texts


def test_turned_part_gets_diameters_and_shoulders():
 from app import sheet
 from app.cad import analyze
 from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder
 from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse
 from OCP.gp import gp_Pnt,gp_Ax2,gp_Dir
 ax=lambda z:gp_Ax2(gp_Pnt(0,0,z),gp_Dir(0,0,1))
 s=BRepAlgoAPI_Fuse(BRepAlgoAPI_Fuse(BRepPrimAPI_MakeCylinder(ax(0),8,20).Shape(),BRepPrimAPI_MakeCylinder(ax(20),13,5).Shape()).Shape(),BRepPrimAPI_MakeCylinder(ax(25),11,30).Shape()).Shape()
 tp=sheet.turned_profile(s)
 assert tp and sorted({round(r*2) for r,_,_ in tp['segs']})==[16,22,26]
 g=analyze(s,'PIN');p={'id':'p','name':'PIN','category':'machining','quantity':1,'geometry':g,'spec':{}}
 texts=[c['lines'][0] for sh in sheet.build_sheets(s,p,{'number':1},{}) for c in sh.callouts.values()]
 for d in ('16.00','22.00','26.00'):assert any(t.startswith('Ø '+d) for t in texts),texts
