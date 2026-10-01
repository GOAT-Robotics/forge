"""Drawing semantics: sheet cut-outs survive, coordinates use local origins, heights use formed geometry."""
import copy
import json
import numpy as np
import pytest
import ezdxf
from reportlab.pdfgen import canvas
from app.cad import analyze,BRepTools
from app.db import DEFAULT_SPEC
from app.drawings import make_part,ordinate_values,spread_ordinates
from app.worker import export_flat
from app.unfold import unfold
from test_geometry import plate,bent


def test_bend_height_is_outside_not_straight_length():
 shape=bent();g=analyze(shape,'bracket');_,bends=unfold(shape,g)
 assert bends[0]['outside_height']==pytest.approx(31) # 25 straight + R4 + T2
 # Translation and rotation cannot change the physical height.
 from OCP.gp import gp_Trsf,gp_Ax1,gp_Pnt,gp_Dir,gp_Vec
 from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
 tr=gp_Trsf();tr.SetRotation(gp_Ax1(gp_Pnt(0,0,0),gp_Dir(1,2,3)),.71);tr.SetTranslationPart(gp_Vec(70,-40,21))
 moved=BRepBuilderAPI_Transform(shape,tr,True).Shape();_,bs=unfold(moved,analyze(moved,'bracket'))
 assert bs[0]['outside_height']==pytest.approx(31)


def test_ordinate_origin_translates_and_ignores_hidden_edges():
 v={'visible':[[[10,20],[50,20]],[[50,20],[50,50]],[[50,50],[10,50]],[[10,50],[10,20]]],
    'hidden':[[[12.125,24.567],[15.555,25.555]]]}
 holes=[{'center':[22,27,0]}]
 assert ordinate_values(v,holes,(0,1))==[[0,12,40],[0,7,30]]
 moved={k:[(np.array(seg)+[173,-92]).tolist() for seg in lines] for k,lines in v.items()}
 assert ordinate_values(moved,[{'center':[195,-65,0]}],(0,1))==[[0,12,40],[0,7,30]]
 labels=spread_ordinates([0,1,1.01,1.02,1.03],10,100,125)
 assert labels[-1]<=125
 assert min(np.diff(labels))>=4


@pytest.mark.parametrize('category',['sheet_metal','machining'])
def test_pdf_and_dxf_category_contract(tmp_path,monkeypatch,category):
 shape=plate();g=analyze(shape,'plate');g['category']=category
 BRepTools.Write_s(shape,str(tmp_path/'shape.brep'))
 p={'id':'test','name':'Contract plate','category':category,'geometry':g,'quantity':1,'spec':copy.deepcopy(DEFAULT_SPEC)}
 export_flat(shape,g,p['spec'],tmp_path)
 text=[];original=canvas.Canvas.drawString
 def capture(self,x,y,value,*args,**kwargs):
  text.append(str(value));return original(self,x,y,value,*args,**kwargs)
 monkeypatch.setattr(canvas.Canvas,'drawString',capture)
 make_part(p,{'number':1,'status':'ready','sha256':'0'*64},tmp_path,{})
 pdf_text='\n'.join(text)
 assert 'GOAT ROBOTICS PRIVATE LIMITED' in pdf_text
 d=ezdxf.readfile(tmp_path/'drawing.dxf');m=d.modelspace()
 labels='\n'.join(entity.dxf.text for entity in m.query('TEXT'))
 if category=='sheet_metal':
  assert 'H001' not in pdf_text and 'FEATURE SCHEDULE' not in pdf_text
  assert 'H001' not in labels
  flat=json.loads((tmp_path/'flat.json').read_text())
  assert len(flat['holes'])==1
  assert len(list(m.query('LWPOLYLINE')))>4
 else:
  scene=json.loads((tmp_path/'drawing-scene.json').read_text())
  assert any('H001' in group.get('feature_ids',[]) for page in scene['pages'] for group in page['groups'])
  assert 'FEATURE SCHEDULE' not in pdf_text
  # GOAT template: ordinate values from the top-left origin and a grouped hole callout
  assert '\u00d8 6.00 THRU' in pdf_text and '20.00' in pdf_text and '100.00' in pdf_text
  assert 'TITLE : Contract plate' in pdf_text
  assert any(dim.dxf.dimtype & 7 == 6 for dim in m.query('DIMENSION'))


def test_profile_chamfer_setback_and_angle():
 from app.drawings import profile_chamfers
 points=[[0,0],[30,0],[30,12],[22,20],[0,20],[0,0]]
 v={'visible':[[a,b] for a,b in zip(points,points[1:])],'hidden':[]}
 ch=profile_chamfers(v)
 assert len(ch)==1
 assert ch[0]['length']==pytest.approx(8)
 assert ch[0]['angle']==pytest.approx(45)
 # Non-45 bevel: horizontal setback stays 8, angle reflects a 4 mm rise.
 points[3]=[22,16];points[4]=[0,16]
 v['visible']=[[a,b] for a,b in zip(points,points[1:])]
 ch=profile_chamfers(v)
 assert ch[0]['length']==pytest.approx(8)
 assert ch[0]['angle']==pytest.approx(26.565051177)
 # A sampled curve with the same endpoints is not a chamfer.
 v['visible'][2]=[[30,12],[26,15],[22,16]]
 assert profile_chamfers(v)==[]


def test_split_straight_chamfer_and_clear_local_labels():
 from app.drawings import profile_chamfers,local_callouts,_overlap
 from shapely.geometry import LineString,box
 from shapely.ops import unary_union
 v={'visible':[[[0,0],[30,0]],[[30,0],[30,12]],[[30,12],[26,16]],[[26,16],[22,20]],[[22,20],[0,20]],[[0,20],[0,0]]],'hidden':[]}
 ch=profile_chamfers(v)
 assert len(ch)==1 and ch[0]['length']==pytest.approx(8)
 items=[{'point':[8,8],'radius':1,'lines':['DIA 2.000','X 8 Y 8']},{'point':[22,8],'radius':1,'lines':['DIA 2.000','X 22 Y 8']}]
 placed=local_callouts(None,items,v,1,np.array([30,30]),(0,0,100,90),draw=False)
 assert len(placed)==2
 assert _overlap(placed[0][1],placed[1][1])==0
 geometry=unary_union([LineString(np.array(seg)+[30,30]) for seg in v['visible']])
 for _,bounds,_,_ in placed:
  assert not geometry.intersects(box(*bounds))
  assert bounds[0]>=0 and bounds[2]<=100 and bounds[1]>=0 and bounds[3]<=90
