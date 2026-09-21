"""OCC geometry extraction. All decisions retain geometric evidence and confidence."""
import math,json,re,hashlib
from pathlib import Path
import numpy as np
import trimesh
from shapely.geometry import Polygon,Point
from OCP.BRep import BRep_Builder,BRep_Tool
from OCP.BRepTools import BRepTools
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepGProp import BRepGProp
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepAdaptor import BRepAdaptor_Surface,BRepAdaptor_Curve
from OCP.Bnd import Bnd_Box
from OCP.GProp import GProp_GProps
from OCP.TopoDS import TopoDS,TopoDS_Shape
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE,TopAbs_SOLID,TopAbs_EDGE,TopAbs_REVERSED,TopAbs_WIRE
from OCP.TopLoc import TopLoc_Location
from OCP.GeomAbs import GeomAbs_Plane,GeomAbs_Cylinder,GeomAbs_Circle,GeomAbs_Line,GeomAbs_Cone
from OCP.GCPnts import GCPnts_QuasiUniformDeflection
from OCP.gp import gp_Pnt,gp_Dir,gp_Ax2
from OCP.HLRBRep import HLRBRep_Algo,HLRBRep_HLRToShape
from OCP.HLRAlgo import HLRAlgo_Projector

def explore(s,kind):
 e=TopExp_Explorer(s,kind)
 while e.More():yield e.Current();e.Next()
def xyz(p):return np.array([p.X(),p.Y(),p.Z()],dtype=float)
def bounds(s):
 b=Bnd_Box();BRepBndLib.AddOptimal_s(s,b);return np.r_[xyz(b.CornerMin()),xyz(b.CornerMax())].tolist()
def props(s,volume=False):
 p=GProp_GProps();(BRepGProp.VolumeProperties_s if volume else BRepGProp.SurfaceProperties_s)(s,p);return abs(p.Mass()),xyz(p.CentreOfMass())
def read_brep(p):
 s=TopoDS_Shape();BRepTools.Read_s(s,str(p),BRep_Builder());return s

def sample_edge(e,deflection=.025):
 c=BRepAdaptor_Curve(TopoDS.Edge(e));a,b=c.FirstParameter(),c.LastParameter()
 if c.GetType()==GeomAbs_Line:return np.array([xyz(c.Value(a)),xyz(c.Value(b))])
 d=GCPnts_QuasiUniformDeflection(c,deflection,a,b)
 if d.IsDone():return np.array([xyz(d.Value(i)) for i in range(1,d.NbPoints()+1)])
 return np.array([xyz(c.Value(a+(b-a)*i/64)) for i in range(65)])
def wire_points(w):
 # Chain unoriented sampled edges geometrically; STEP edge direction can differ from wire traversal.
 seg=[sample_edge(e) for e in explore(w,TopAbs_EDGE)]
 if not seg:return np.empty((0,3))
 out=seg.pop(0).tolist()
 while seg:
  end=np.array(out[-1]);best=min(((np.linalg.norm(s[k]-end),i,k) for i,s in enumerate(seg) for k in (0,-1)),key=lambda t:t[0]);_,i,k=best;s=seg.pop(i)
  if k==-1:s=s[::-1]
  out.extend(s[1:].tolist())
 pts=np.array(out)
 if len(pts)>2 and np.linalg.norm(pts[0]-pts[-1])<1e-6:pts[-1]=pts[0]
 return pts
def plane_data(face):
 a=BRepAdaptor_Surface(face,True)
 if a.GetType()!=GeomAbs_Plane:return None
 p=a.Plane();n=xyz(p.Axis().Direction());x=xyz(p.Position().XDirection());y=np.cross(n,x);o=xyz(p.Location())
 outer=BRepTools.OuterWire_s(face);w=wire_points(outer);ring=np.c_[(w-o)@x,(w-o)@y]
 return {'normal':n,'x':x,'y':y,'origin':o,'ring':ring,'face':face,'area':props(face)[0],'center':props(face)[1]}

def face_features(s):
 faces=[TopoDS.Face(f) for f in explore(s,TopAbs_FACE)];planes=[];cyl=[];cones=[]
 for i,f in enumerate(faces):
  a=BRepAdaptor_Surface(f,True);t=a.GetType()
  if t==GeomAbs_Plane:
   p=plane_data(f)
   if p:p['index']=i;planes.append(p)
  elif t==GeomAbs_Cylinder:
   c=a.Cylinder();d=xyz(c.Axis().Direction());d=d*(1 if d[np.argmax(abs(d))]>=0 else -1);o=xyz(c.Location());o=o-d*np.dot(o,d)
   vertices=np.vstack([sample_edge(e) for e in explore(f,TopAbs_EDGE)]);v=vertices@d
   cyl.append({'index':i,'radius':c.Radius(),'axis':d,'origin':o,'start':float(v.min()),'end':float(v.max()),'angle':min(2*math.pi,abs(a.LastUParameter()-a.FirstUParameter())),'internal':f.Orientation()==TopAbs_REVERSED})
  elif t==GeomAbs_Cone:cones.append(i)
 return faces,planes,cyl,cones

# Name-based make/buy hints. Supplier downloads keep their .stp/.STEP names; catalogue items carry
# component words; custom parts are named after their function (mount, plate, cover ...).
PURCHASED_WORDS=r'terminal|relay|mcb|rccb|contactor|plc\b|nvidia|jetson|jenson|pcb|nut\b|bolt|screw|washer|rivet|bearing|motor|gearbox|reducer|encoder|caster|castor|fuse|breaker|battery|charger|speaker|buzzer|beacon|lidar|lider|camera|sensor|proximity|switch|duct|connector|\bcon\b|conector|插座|socket|\bport\b|usb|ethernet|hdmi|antenna|module|card\b|\bsim\b|heat.?sink|gland|grommet|converter|inverter|\bhub\b|\bpin\b|spring|rubber|\bpad\b|tyre|tire|cable|harness|\bled\b|lock\b|\brail(?:\b|_)|manifold_solid|mcadid|^part\d+\^|tl-q5|als-0|xb5|zb5|zbe|2eld|hgh\d|hgr\d|^080-|southco|waveshare|xwst|fenner|pizzato|realsense$|arandela|tuerca|rondelle|vis-|tornillo|vossloh'
STRONG_PURCHASED=r'terminal|relay|mcb|rccb|contactor|plc\b|nvidia|jetson|jenson|pcb|nut\b|bolt|screw|washer|rivet|bearing|motor|gearbox|reducer|encoder|caster|castor|fuse|breaker|manifold_solid|mcadid|^080-|2eld|hgh\d|hgr\d'
CUSTOM_WORDS=r'mount|plate|block|clamp|cover|covr|bracket|stand|door|hinge|\brod\b|stopper|spacer|shaft|frame|chassis|gusset|stiffener|lft1500|chrome|gto-la'
def classify_name(name):
 """Return 'purchased', 'custom' or None from the component name alone."""
 base=re.sub(r'\s*/\s*Body \d+$','',name or '').strip()
 if re.search(r'\.st(e)?p\s*\d*$',base,re.I):return 'purchased'
 custom=bool(re.search(CUSTOM_WORDS,base,re.I));strong=bool(re.search(STRONG_PURCHASED,base,re.I));bought=bool(re.search(PURCHASED_WORDS,base,re.I))
 if custom and not strong:return 'custom'
 if bought:return 'purchased'
 return None
HIDDEN_WORDS=r'terminal|lidar|lider|sensor|connector|cable|harness|relay|switch|screw|bolt|nut\b|washer|rivet|plug|antenna|camera|fuse|breaker|mcb|\bled\b|buzzer|beacon|ihawk|waveshare|xb5a|zb5|zbe|2eld|rail|pcb|module|card\b|\bsim\b|charger|battery|duct|plc\b|speaker|gland|\bpin\b|hub\b|usb|port\b|ethernet'
def hidden_by_default(name,category,provenance='',settings=None):
 """Small bought-in items and multi-body supplier models clutter the viewer; hide them unless asked for."""
 if category!='purchased' or (settings and not settings.get('hide_purchased_by_default',True)):return False
 return bool(re.search(HIDDEN_WORDS,name+' '+provenance,re.I)) or ' / Body ' in name
def classify_prefix(name,settings):
 """Workspace naming convention: part-number prefixes decide the category outright. Returns a category or
 None when no prefix rule applies. In strict mode any name outside the configured prefixes is purchased."""
 if not settings:return None
 base=re.sub(r'\s*/\s*Body \d+$','',name or '').strip().lower()
 groups=[('sheet_metal',settings.get('sheet_prefixes') or []),('machining',settings.get('machining_prefixes') or []),('purchased',settings.get('purchased_prefixes') or [])]
 configured=any(g[1] for g in groups)
 if not configured:return None
 for category,prefixes in groups:
  if any(base.startswith(str(pf).strip().lower()) for pf in prefixes if str(pf).strip()):return category
 return 'purchased' if settings.get('prefix_strict',True) else None
def geometric_category(g):
 """Sheet / machining guess from stored geometry only (used when re-running classification)."""
 th=g.get('thickness',0) or 0;est=2*g.get('volume',0)/max(g.get('area',1e-10),1e-10)
 return 'sheet_metal' if th and (g.get('bends') or th<=6) and est/th>.35 else 'machining'

def analyze(s,name):
 b=bounds(s);size=np.array(b[3:])-b[:3];vol,center=props(s,True);area,_=props(s);faces,planes,cyl,cones=face_features(s)
 thickness_candidates=[];bend_pairs=[]
 for i,a in enumerate(cyl):
  if a['angle']>math.pi+0.02 or a['angle']<.15:continue
  for j,c in enumerate(cyl[i+1:],i+1):
   dr=abs(a['radius']-c['radius'])
   if .2<dr<20 and np.dot(a['axis'],c['axis'])>.99999 and np.linalg.norm(a['origin']-c['origin'])<.01 and abs(a['start']-c['start'])<.1 and abs(a['end']-c['end'])<.1 and abs(a['angle']-c['angle'])<.02:
    thickness_candidates.append(dr);bend_pairs.append((a,c))
 # A constant thickness plane pair should have substantial matching area.
 largest=sorted(planes,key=lambda p:-p['area'])[:24]
 for i,p in enumerate(largest):
  for q in largest[i+1:]:
   if abs(np.dot(p['normal'],q['normal']))>.999999 and min(p['area'],q['area'])/max(p['area'],q['area'])>.65:
    d=abs(np.dot(q['origin']-p['origin'],p['normal']))
    if .2<d<20 and d<max(size)*.12:thickness_candidates.append(d)
 est=2*vol/max(area,1e-10)
 vals=[t for t in thickness_candidates if .7*est<t<2.4*est]
 thickness=float(min(vals,key=lambda t:abs(t-est))) if vals else 0.
 sheet=bool(thickness and (bend_pairs or thickness<=6) and est/thickness>.35)
 category='purchased' if classify_name(name)=='purchased' else 'sheet_metal' if sheet else 'machining'
 # Merge split cylindrical faces before identifying full bores.
 groups={}
 for c in cyl:
  key=tuple(np.round(np.r_[c['axis'],c['origin'],c['radius'],c['start'],c['end']],4))+(c['internal'],)
  if key in groups:groups[key]['angle']+=c['angle']
  else:groups[key]=dict(c)
 holes=[];shafts=[]
 for c in groups.values():
  if c['angle']<2*math.pi-.03:continue
  f={'diameter':round(c['radius']*2,5),'axis':c['axis'].tolist(),'origin':c['origin'].tolist(),'start':c['start'],'end':c['end'],'depth':c['end']-c['start'],'center':(c['origin']+c['axis']*(c['start']+c['end'])/2).tolist(),'kind':'cylindrical bore' if c['internal'] else 'external cylinder','confidence':'geometry','edge_web':None}
  if c['internal']:
   for p in sorted(planes,key=lambda p:-p['area']):
    if abs(np.dot(p['normal'],c['axis']))<.999:continue
    v=c['origin']-p['origin'];point=Point(np.dot(v,p['x']),np.dot(v,p['y']));poly=Polygon(p['ring'])
    if poly.is_valid and poly.covers(point):f['edge_web']=round(poly.exterior.distance(point)-c['radius'],5);break
   holes.append(f)
  else:shafts.append(f)
 holes.sort(key=lambda h:tuple(round(v,4) for v in h['center'])+(h['diameter'],))
 for i,h in enumerate(holes,1):h['id']=f'H{i:03d}';h['name']=f"Bore {h['diameter']:g} mm"
 bends=[]
 for a,c in bend_pairs:
  if abs(abs(a['radius']-c['radius'])-thickness)>.05:continue
  centerline=a['origin']+a['axis']*(a['start']+a['end'])/2
  bends.append({'id':f'B{len(bends)+1:03d}','radius':min(a['radius'],c['radius']),'angle':round(math.degrees(a['angle']),3),'length':a['end']-a['start'],'axis':a['axis'].tolist(),'center':centerline.tolist(),'faces':[a['index'],c['index']]})
 return {'bounds':b,'dimensions':size.tolist(),'volume':vol,'area':area,'center':center.tolist(),'valid':BRepCheck_Analyzer(s).IsValid(),'face_count':len(faces),'category':category,'classification_confidence':'inferred','thickness':round(thickness,5),'holes':holes,'shafts':shafts,'bends':bends,'cone_faces':len(cones),'flat_status':'not_applicable','recognition_notes':['Hole labels identify geometric bores, not inferred thread callouts.','Category is heuristic and requires review.','Freeform pockets, threads, welds and native design intent are not fully recovered from neutral geometry.']}

def mesh(s,deflection=.8):
 BRepMesh_IncrementalMesh(s,deflection,False,.45,True).Perform();vertices=[];triangles=[];offset=0
 for f in explore(s,TopAbs_FACE):
  face=TopoDS.Face(f);loc=TopLoc_Location();t=BRep_Tool.Triangulation_s(face,loc)
  if t is None:continue
  tr=loc.Transformation();verts=np.array([xyz(t.Node(i).Transformed(tr)) for i in range(1,t.NbNodes()+1)])
  tris=np.array([list(t.Triangle(i).Get()) for i in range(1,t.NbTriangles()+1)])-1
  if face.Orientation()==TopAbs_REVERSED:tris=tris[:,::-1]
  vertices.extend(verts);triangles.extend(tris+offset);offset+=len(verts)
 return trimesh.Trimesh(vertices=np.array(vertices),faces=np.array(triangles),process=False)

def projections(s):
 out={}
 for name,normal,x in [('top',(0,0,1),(1,0,0)),('front',(0,-1,0),(1,0,0)),('right',(1,0,0),(0,1,0)),('iso',(1,-1,1),(1,1,0))]:
  a=HLRBRep_Algo();a.Add(s);a.Projector(HLRAlgo_Projector(gp_Ax2(gp_Pnt(0,0,0),gp_Dir(*normal),gp_Dir(*x))));a.Update();a.Hide();h=HLRBRep_HLRToShape(a)
  out[name]={}
  for key,shapes in [('visible',[h.VCompound(),h.OutLineVCompound()]),('hidden',[h.HCompound(),h.OutLineHCompound()])]:
   out[name][key]=[sample_edge(e)[:,:2].tolist() for shape in shapes if not shape.IsNull() for e in explore(shape,TopAbs_EDGE)]
 return out

def transform_matrix(t):
 m=np.eye(4)
 for i in range(3):
  for j in range(4):m[i,j]=t.Value(i+1,j+1)
 return m

def import_model(path):
 from OCP.STEPCAFControl import STEPCAFControl_Reader
 from OCP.TDocStd import TDocStd_Document
 from OCP.TCollection import TCollection_ExtendedString
 from OCP.XCAFDoc import XCAFDoc_DocumentTool
 from OCP.TDF import TDF_Label
 from OCP.TDataStd import TDataStd_Name
 from OCP.collections import Sequence_TDF_Label
 if path.suffix.lower() in ('.brep','.brp'):
  return [{'key':'1','name':path.stem,'shape':read_brep(path),'instances':[{'matrix':np.eye(4).tolist(),'path':path.stem}]}]
 if path.suffix.lower() in ('.igs','.iges'):
  from OCP.IGESControl import IGESControl_Reader
  r=IGESControl_Reader()
  if int(r.ReadFile(str(path)))!=1:raise ValueError('Cannot read IGES')
  r.TransferRoots();return [{'key':'1','name':path.stem,'shape':r.OneShape(),'instances':[{'matrix':np.eye(4).tolist(),'path':path.stem}]}]
 doc=TDocStd_Document(TCollection_ExtendedString('forge'));r=STEPCAFControl_Reader();r.SetNameMode(True)
 if int(r.ReadFile(str(path)))!=1:raise ValueError('Cannot parse STEP file')
 if not r.Transfer(doc):raise ValueError('STEP geometry transfer failed')
 st=XCAFDoc_DocumentTool.ShapeTool_s(doc.Main());roots=Sequence_TDF_Label();st.GetFreeShapes(roots);leaves={}
 def name(l):
  a=TDataStd_Name();return a.Get().ToExtString() if l.FindAttribute(TDataStd_Name.GetID_s(),a) else str(l.Tag())
 def walk(l,parent,ancestry):
  local=transform_matrix(st.GetLocation_s(l).Transformation());matrix=parent@local;ref=TDF_Label()
  if st.IsReference_s(l):st.GetReferredShape_s(l,ref);l=ref
  n=name(l);anc=ancestry+[n]
  if st.IsAssembly_s(l):
   seq=Sequence_TDF_Label();st.GetComponents_s(l,seq)
   for i in range(1,seq.Length()+1):walk(seq.Value(i),matrix,anc)
  else:
   key=str(l.Tag())
   if key not in leaves:leaves[key]={'key':key,'name':n,'shape':st.GetShape_s(l),'instances':[]}
   leaves[key]['instances'].append({'matrix':matrix.tolist(),'path':' / '.join(anc)})
 for i in range(1,roots.Length()+1):walk(roots.Value(i),np.eye(4),[])
 return list(leaves.values())
