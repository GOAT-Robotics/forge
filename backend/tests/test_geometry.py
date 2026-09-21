import math
from pathlib import Path
import numpy as np
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox,BRepPrimAPI_MakeCylinder
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut,BRepAlgoAPI_Fuse,BRepAlgoAPI_Common
from OCP.gp import gp_Pnt,gp_Ax2,gp_Dir
from app.cad import analyze,mesh,BRepTools,import_model
from app.unfold import unfold

def plate():
 b=BRepPrimAPI_MakeBox(100,60,2).Shape();c=BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(20,20,-1),gp_Dir(0,0,1)),3,4).Shape();return BRepAlgoAPI_Cut(b,c).Shape()
def bent():
 axis=gp_Ax2(gp_Pnt(0,0,0),gp_Dir(0,1,0));ring=BRepAlgoAPI_Cut(BRepPrimAPI_MakeCylinder(axis,6,40).Shape(),BRepPrimAPI_MakeCylinder(axis,4,40).Shape()).Shape();quad=BRepAlgoAPI_Common(ring,BRepPrimAPI_MakeBox(gp_Pnt(0,0,0),7,40,7).Shape()).Shape();a=BRepPrimAPI_MakeBox(gp_Pnt(-30,0,4),30,40,2).Shape();b=BRepPrimAPI_MakeBox(gp_Pnt(4,0,-25),2,40,25).Shape();return BRepAlgoAPI_Fuse(BRepAlgoAPI_Fuse(a,quad).Shape(),b).Shape()
def test_hole_detection_and_flat_volume():
 s=plate();g=analyze(s,'Test sheet');assert g['valid'];assert g['category']=='sheet_metal';assert abs(g['thickness']-2)<1e-5;assert len(g['holes'])==1;h=g['holes'][0];assert h['id']=='H001';assert abs(h['diameter']-6)<1e-6;assert np.allclose(h['center'],[20,20,1]);assert abs(h['edge_web']-17)<.02
 poly,b=unfold(s,g,.4);assert abs(poly.area-(6000-math.pi*9))<.5;assert len(poly.interiors)==1;assert not b;assert len(mesh(s).faces)>0

def test_bend_unfold_allowance():
 s=bent();g=analyze(s,'L bracket');assert g['valid'];assert g['category']=='sheet_metal';assert abs(g['thickness']-2)<.01;assert len(g['bends'])==1;assert abs(g['bends'][0]['angle']-90)<.01
 poly,bs=unfold(s,g,.4);assert abs(bs[0]['allowance']-math.pi/2*4.8)<1e-5;assert abs(poly.area-(30+25+math.pi/2*4.8)*40)<2

def test_massive_block_is_not_sheet():
 s=BRepPrimAPI_MakeBox(60,45,30).Shape();g=analyze(s,'Machined block');assert g['category']=='machining';assert not g['holes']

def test_mating_geometry_and_document_exports(tmp_path):
 import json,ezdxf
 from app.worker import detect_fits
 from app.drawings import assembly_pdf
 from app import db
 bore=BRepAlgoAPI_Cut(BRepPrimAPI_MakeCylinder(10,20).Shape(),BRepPrimAPI_MakeCylinder(5,20).Shape()).Shape();shaft=BRepPrimAPI_MakeCylinder(4.98,25).Shape();parts=[];instances={}
 for pid,s,name in [('a',bore,'Test bushing'),('b',shaft,'Test shaft')]:
  folder=tmp_path/'parts'/pid;folder.mkdir(parents=True);BRepTools.Write_s(s,str(folder/'shape.brep'));mesh(s).export(folder/'model.glb');g=analyze(s,name);g['category']='machining';parts.append({'id':pid,'name':name,'category':'machining','geometry':g,'spec':dict(db.DEFAULT_SPEC),'quantity':1});instances[pid]=[{'matrix':np.eye(4).tolist(),'path':name}]
 fs=detect_fits(parts,instances);assert len(fs)==1;assert abs(fs[0]['nominal_clearance']-.04)<1e-8
 (tmp_path/'instances.json').write_text(json.dumps(instances));assembly_pdf({'number':1,'filename':'Test mating fixture','status':'ready'},parts,[{'id':'fixture','data':fs[0],'approved':False}],tmp_path)
 assert (tmp_path/'assembly.pdf').stat().st_size>3000;d=ezdxf.readfile(tmp_path/'assembly.dxf');assert len(d.modelspace().query('LWPOLYLINE'))>0
 # No candidate if the shaft lies outside the bore's axial span.
 instances['b'][0]['matrix'][2][3]=60;assert not detect_fits(parts,instances)

def test_step_multibody_and_unit_preservation(tmp_path):
 from OCP.STEPControl import STEPControl_Writer,STEPControl_AsIs
 from OCP.BRep import BRep_Builder
 from OCP.TopoDS import TopoDS_Compound
 from app.cad import explore,TopAbs_SOLID,bounds
 builder=BRep_Builder();assembly=TopoDS_Compound();builder.MakeCompound(assembly);builder.Add(assembly,plate());builder.Add(assembly,BRepPrimAPI_MakeBox(gp_Pnt(150,0,0),20,30,40).Shape());writer=STEPControl_Writer();writer.Transfer(assembly,STEPControl_AsIs);source=tmp_path/'multipart.step';writer.Write(str(source));leaves=import_model(source);solids=[s for leaf in leaves for s in explore(leaf['shape'],TopAbs_SOLID)];assert len(solids)==2
 envelopes=[np.array(bounds(s)[3:])-bounds(s)[:3] for s in solids];assert any(np.allclose(v,[100,60,2],atol=1e-5) for v in envelopes)

def test_curved_form_is_not_flattened():
 import pytest
 from OCP.BRepPrimAPI import BRepPrimAPI_MakeSphere
 s=BRepAlgoAPI_Cut(BRepPrimAPI_MakeSphere(20).Shape(),BRepPrimAPI_MakeSphere(18).Shape()).Shape();g=analyze(s,'Spherical shell');g['category']='sheet_metal';g['thickness']=2
 with pytest.raises(ValueError):unfold(s,g,.4)

def test_xcaf_repeated_component_placements(tmp_path):
 from OCP.STEPCAFControl import STEPCAFControl_Writer
 from OCP.STEPControl import STEPControl_AsIs
 from OCP.TDocStd import TDocStd_Document
 from OCP.TCollection import TCollection_ExtendedString
 from OCP.XCAFDoc import XCAFDoc_DocumentTool
 from OCP.TDataStd import TDataStd_Name
 from OCP.TopLoc import TopLoc_Location
 from OCP.gp import gp_Trsf,gp_Vec
 from OCP.TopoDS import TopoDS_Compound
 from OCP.BRep import BRep_Builder
 doc=TDocStd_Document(TCollection_ExtendedString('fixture'));st=XCAFDoc_DocumentTool.ShapeTool_s(doc.Main());empty=TopoDS_Compound();BRep_Builder().MakeCompound(empty);root=st.AddShape(empty,True);definition=st.AddShape(BRepPrimAPI_MakeBox(10,20,30).Shape(),False);TDataStd_Name.Set_s(definition,TCollection_ExtendedString('Repeated test block'))
 for x in [50,150]:
  tr=gp_Trsf();tr.SetTranslation(gp_Vec(x,0,0));st.AddComponent(root,definition,TopLoc_Location(tr))
 st.UpdateAssemblies();writer=STEPCAFControl_Writer();writer.Transfer(doc,STEPControl_AsIs);source=tmp_path/'assembly.step';writer.Write(str(source));leaves=import_model(source);assert len(leaves)==1;assert len(leaves[0]['instances'])==2
 assert sorted(round(i['matrix'][0][3],4) for i in leaves[0]['instances'])==[50,150]
 from app.cad import bounds
 assert np.allclose(bounds(leaves[0]['shape']),[0,0,0,10,20,30],atol=1e-5)
