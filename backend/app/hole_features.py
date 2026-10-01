"""Connected coaxial bores, entrance cones and drill tips from the source solid.

Thread class, pitch and fit are manufacturing intent, never inferred as facts.
"""
import math
import numpy as np
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.TopAbs import TopAbs_OUT
from .cad import (explore,TopAbs_FACE,TopAbs_EDGE,TopAbs_REVERSED,TopoDS,
 BRepAdaptor_Surface,GeomAbs_Cone,xyz,sample_edge,gp_Pnt)


def hole_features(shape,holes):
 cones=[];seen=set()
 for f in explore(shape,TopAbs_FACE):
  a=BRepAdaptor_Surface(TopoDS.Face(f),True)
  if a.GetType()!=GeomAbs_Cone or f.Orientation()!=TopAbs_REVERSED:continue
  cone=a.Cone();axis=xyz(cone.Axis().Direction());axis*=1 if axis[np.argmax(abs(axis))]>=0 else -1
  origin=xyz(cone.Location());origin-=axis*np.dot(origin,axis)
  vertices=np.vstack([sample_edge(e) for e in explore(f,TopAbs_EDGE)])
  ts=vertices@axis;rs=np.linalg.norm(vertices-origin-ts[:,None]*axis,axis=1)
  item={'axis':axis.tolist(),'origin':origin.tolist(),'start':float(ts.min()),'end':float(ts.max()),'small':float(rs.min()*2),'large':float(rs.max()*2),'angle':abs(math.degrees(cone.SemiAngle())*2),'kind':'cone'}
  item['start_diameter']=float(np.max(rs[np.abs(ts-ts.min())<1e-5])*2);item['end_diameter']=float(np.max(rs[np.abs(ts-ts.max())<1e-5])*2)
  key=tuple(np.round(np.r_[axis,origin,item['start'],item['end'],item['small'],item['large']],4))
  if key not in seen:cones.append(item);seen.add(key)
 nodes=[{**h,'kind':'bore'} for h in holes]+cones;used=set();features=[]
 def connected(a,b):
  if np.dot(a['axis'],b['axis'])<.99999 or np.linalg.norm(np.array(a['origin'])-b['origin'])>.001:return False
  # Cylindrical lands touching at a step, or meeting an entrance/drill cone.
  if max(a['start'],b['start'])>min(a['end'],b['end'])+.002:return False
  for left,right in ((a,b),(b,a)):
   if abs(left['end']-right['start'])<.002:
    ld=left.get('end_diameter',left.get('diameter',0));rd=right.get('start_diameter',right.get('diameter',0))
    if min(ld,rd)<.001:return False # Opposed drill tips touching at a point are not one open bore.
  return True
 for index,h in enumerate(holes):
  if index in used:continue
  queue=[index];used.add(index);component=[]
  while queue:
   i=queue.pop();component.append(nodes[i])
   for j,node in enumerate(nodes):
    if j not in used and connected(nodes[i],node):used.add(j);queue.append(j)
  bores=[n for n in component if n['kind']=='bore'];cc=[n for n in component if n['kind']=='cone']
  lo=min(n['start'] for n in component);hi=max(n['end'] for n in component);axis=np.array(h['axis']);origin=np.array(h['origin'])
  opened=[]
  for t in (lo-.02,hi+.02):
   probe=origin+axis*t
   classifier=BRepClass3d_SolidClassifier(shape,gp_Pnt(*probe),1e-6)
   opened.append(classifier.State()==TopAbs_OUT)
  bore=min(bores,key=lambda b:b['diameter']);entrances=[]
  for cone in cc:
   if cone['small']<.01:continue # drill tip, not a mouth chamfer
   side='low' if abs(cone['start']-lo)<.003 else 'high' if abs(cone['end']-hi)<.003 else 'internal'
   entrances.append({'diameter':round(cone['large'],5),'angle':round(cone['angle'],3),'side':side})
  features.append({'id':'HF_'+min(b['id'] for b in bores),'hole_ids':sorted(b['id'] for b in bores),'axis':h['axis'],'origin':h['origin'],
   'center':(origin+axis*(lo+hi)/2).tolist(),'start':lo,'end':hi,'diameter':bore['diameter'],
   'through':all(opened),'depth':max(b['end'] for b in bores)-min(b['start'] for b in bores),
   'entrances':entrances,'steps':[{'diameter':b['diameter'],'depth':b['depth']} for b in bores if abs(b['diameter']-bore['diameter'])>.001],
   'recognition':'connected source geometry; thread and fit unspecified'})
 return features


def feature_lines(feature,normal_sign=1):
 end='THRU' if feature['through'] else f"DEPTH {feature['depth']:.2f}"
 lines=[f"DIA {feature['diameter']:.3f} {end}"]
 for step in feature['steps']:lines.append(f"STEP DIA {step['diameter']:.3f} DEPTH {step['depth']:.2f}")
 for e in feature['entrances']:
  near=('high' if normal_sign>0 else 'low')
  side='Near side' if e['side']==near else 'Far side' if e['side']!='internal' else 'Internal transition'
  lines.append(f"CSK DIA {e['diameter']:.2f} x {e['angle']:.1f} deg, {side}")
 return lines
