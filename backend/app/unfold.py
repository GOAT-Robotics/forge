"""Conservative developable sheet unfolding; refuse unsupported/double-curved topology."""
import math
import numpy as np
from shapely.geometry import Polygon
from shapely import union_all
from OCP.TopAbs import TopAbs_EDGE,TopAbs_WIRE
from OCP.TopoDS import TopoDS
from .cad import face_features,explore,wire_points,props

def unfold(s,g,k=.4):
 faces,planes,cyl,_=face_features(s);by_index={p['index']:p for p in planes};th=g['thickness']
 if not planes or th<=0:raise ValueError('Constant thickness could not be established')
 root=max(planes,key=lambda p:p['area']);n=root['normal'];x=root['x'];y=root['y'];R=np.vstack([x,y,n]);origin=root['origin'];maps={root['index']:(R,-R@origin)}
 links={};bend_lookup={}
 for b in g['bends']:
  for ci in b['faces']:
   bendface=faces[ci];edge_list=list(explore(bendface,TopAbs_EDGE));neighbors=[]
   for pi,p in by_index.items():
    if abs(np.dot(p['normal'],np.array(b['axis'])))>.001:continue
    for e in explore(p['face'],TopAbs_EDGE):
     if any(e.IsSame(other) for other in edge_list):
      w=wire_points(next(iter(explore(p['face'],TopAbs_WIRE))));neighbors.append((pi,e));break
   if len(neighbors)==2:
    a,ae=neighbors[0];c,ce=neighbors[1];links.setdefault(a,[]).append((c,b,ae,ce));links.setdefault(c,[]).append((a,b,ce,ae));bend_lookup[(a,c)]=b
 if g['bends'] and root['index'] not in links:raise ValueError('Could not connect the largest planar skin to the bend graph')
 rectangles=[];bend_lines=[];queue=[root['index']];used=set()
 from .cad import sample_edge
 while queue:
  pi=queue.pop(0);Rp,tp=maps[pi];parent=by_index[pi]
  for ci,b,pe,ce in links.get(pi,[]):
   if ci in maps:continue
   pp=sample_edge(pe);cp=sample_edge(ce);p=pp.mean(axis=0);q=cp.mean(axis=0);axis=np.array(b['axis']);axis/=np.linalg.norm(axis)
   outward=p-parent['center'];outward-=axis*np.dot(axis,outward)
   inside=by_index[ci]['center']-q;inside-=axis*np.dot(axis,inside)
   if np.linalg.norm(outward)<1e-6 or np.linalg.norm(inside)<1e-6:raise ValueError('Ambiguous flange orientation')
   outward/=np.linalg.norm(outward);inside/=np.linalg.norm(inside)
   target_t=Rp@axis;target_o=Rp@outward
   basis_source=np.column_stack([axis,inside,np.cross(axis,inside)]);basis_target=np.column_stack([target_t,target_o,np.cross(target_t,target_o)])
   Rc=basis_target@basis_source.T;ba=math.radians(b['angle'])*(b['radius']+k*th)
   target_q=Rp@p+tp+target_o*ba;tc=target_q-Rc@q;maps[ci]=(Rc,tc);queue.append(ci)
   a=Rp@pp[0]+tp;z=Rp@pp[-1]+tp
   # Bend direction as seen from the developed view: UP when the flange folds toward the viewer
   # (the root skin's outward normal), DOWN when it folds away. Sign of the bend axis offset from the
   # parent skin, corrected for parents whose outward normal maps to -Z in the flat.
   side=np.dot(Rp@parent['normal'],[0,0,1])*np.dot(np.array(b['center'])-parent['origin'],parent['normal'])
   rectangles.append(Polygon([a[:2],z[:2],(z+target_o*ba)[:2],(a+target_o*ba)[:2]]));bend_lines.append({'id':b['id'],'a':(a+target_o*ba/2)[:2].tolist(),'b':(z+target_o*ba/2)[:2].tolist(),'allowance':ba,'angle':b['angle'],'radius':b['radius'],'length':float(np.linalg.norm(z-a)),'direction':'up' if side>0 else 'down'});used.add(b['id'])
 if len(used)!=len(g['bends']):raise ValueError('Not all bends belong to a single developable skin; manual unfolding required')
 polys=[]
 from OCP.BRepTools import BRepTools
 for pi,(r,t) in maps.items():
  f=by_index[pi]['face'];outer=BRepTools.OuterWire_s(f);rings=[];shell=None
  for w in explore(f,TopAbs_WIRE):
   pts=wire_points(TopoDS.Wire(w));coords=(pts@r.T+t)[:,:2]
   if len(coords)<3:continue
   if w.IsSame(outer):shell=coords
   else:rings.append(coords)
  if shell is not None:
   poly=Polygon(shell,rings)
   if not poly.is_valid:raise ValueError('Projected flange contour is invalid')
   polys.append(poly)
 if not polys:raise ValueError('No developable faces')
 if not g['bends']:
  # Require an extruded constant-thickness plate, not an arbitrary solid's largest face.
  predicted=polys[0].area*th
  if abs(predicted-g['volume'])/max(g['volume'],1)>.04:raise ValueError('Flat projection does not match constant-thickness volume')
 else:
  projected_area=sum(p.area for p in polys)
  approx_skin_area=(g['area']-sum(2*math.radians(b['angle'])*(b['radius']+th/2)*b['length'] for b in g['bends']))/2
  if projected_area<approx_skin_area*.60:raise ValueError('Unfold coverage incomplete')
 # Snap only sub-micron round-off at shared flange/bend edges.
 merged=union_all(polys+rectangles,grid_size=0.00001)
 if merged.geom_type!='Polygon' or not merged.is_valid:raise ValueError('Unfold produced disconnected or invalid outline')
 summed=sum(p.area for p in polys+rectangles)
 if summed-merged.area>max(1,summed*.003):raise ValueError('Unfolded flanges overlap')
 return merged,bend_lines
