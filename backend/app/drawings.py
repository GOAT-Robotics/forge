from pathlib import Path
import json,math,io,csv,zipfile,re
import numpy as np
import ezdxf
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
from reportlab.pdfbase.pdfmetrics import stringWidth
from PIL import Image,ImageDraw
from .cad import projections,read_brep
from .rules import evaluate,STANDARDS
from .drawing_scene import SceneCanvas,group,render_scene
from .hole_features import hole_features,feature_lines
from . import sheet as drafting

ASCII_MAP=str.maketrans({'–':'-','—':'-','µ':'u','°':' deg','×':'x','Ø':'D','ø':'d','→':'->','·':'|','≤':'<=','≥':'>=','±':'+/-','’':"'",'“':'"','”':'"'})
def txt(c,x,y,t,size=8):c.setFont('Helvetica',size);c.drawString(x*mm,y*mm,str(t).translate(ASCII_MAP).encode('latin-1','replace').decode('latin-1'))
def ln(c,x,y,a,b):c.line(x*mm,y*mm,a*mm,b*mm)
def wrap(c,x,y,t,width=380,size=8):
 line=''
 for word in str(t).split():
  if stringWidth(line+' '+word,'Helvetica',size)>width*mm:txt(c,x,y,line,size);y-=4;line=word
  else:line=(line+' '+word).strip()
 if line:txt(c,x,y,line,size);y-=4
 return y

def frame(c,p,revision,sheet,scale='AS SHOWN'):
 """Zoned A3 border and reference-style title block; values come from this part only."""
 spec=p['spec'];c.setStrokeColorRGB(.1,.1,.1);c.setFillColorRGB(0,0,0);c.setLineWidth(.18*mm)
 c.rect(10*mm,10*mm,400*mm,277*mm);c.rect(15*mm,15*mm,390*mm,267*mm)
 for i in range(6):
  x=15+i*65
  for y in (10,282):
   ln(c,x,y,x,y+5);txt(c,x+31,y+1,str(6-i),7)
 for i in range(6):
  y=15+i*44.5
  for x in (10,405):
   ln(c,x,y,x+5,y);txt(c,x+1,y+21,chr(65+i),7)
 # Full-width bottom block with independently bounded cells.
 def cell(x,y,w,h,label,value,size=7):
  c.rect(x*mm,y*mm,w*mm,h*mm)
  text=f'{label}: {value}' if label else str(value)
  while stringWidth(text,'Helvetica',size)> (w-3)*mm and size>5:size-=.2
  if stringWidth(text,'Helvetica',size)>(w-3)*mm:
   while stringWidth(text+'...','Helvetica',size)>(w-3)*mm:text=text[:-1]
   text+='...'
  txt(c,x+1.5,y+(h-size/mm)/2+ .6,text,size)
 cell(15,39,150,8,'','GOAT ROBOTICS PRIVATE LIMITED',11)
 cell(15,31,150,8,'TITLE',p['name'])
 cell(15,25,110,6,'DWG NO',spec.get('drawing_number') or re.split(r'-(?:E-)?STOPPER',p['name'])[0])
 cell(125,25,40,6,'REV',revision['number'])
 cell(15,20,80,5,'MODULE',spec.get('module') or '-')
 cell(95,20,70,5,'MASTER',spec.get('master') or '-')
 cell(15,15,150,5,'REV / DATE',str(revision['number'])+' / '+str(revision.get('release_at') or '-'),6)
 cell(165,39,95,8,'MATERIAL',spec.get('material') or 'UNSPECIFIED')
 cell(165,31,95,8,'TREATMENT',spec.get('finish') or 'UNSPECIFIED')
 cell(165,23,95,8,'QTY',p['quantity'])
 cell(165,15,95,8,'PROJECTION','THIRD ANGLE')
 cell(260,39,85,8,'UNITS','mm')
 cell(260,23,85,16,'TOLERANCE',spec.get('general_tolerance') or 'UNSPECIFIED')
 cell(260,15,85,8,'SURFACE FINISH',spec.get('roughness') or 'UNSPECIFIED')
 for row,(label,value) in enumerate([
  ('SHEET',sheet),('SCALE',scale),('DATE',str(revision.get('release_at') or '-')[:10]),
  ('DRN',spec.get('drawn_by') or 'FORGE'),('CHK',spec.get('checked_by') or 'PENDING'),('APD',revision.get('release_by') or 'PENDING')]):
  cell(345,47-(row+1)*32/6,60,32/6,label,value,6.5)
 status='NOT FOR PRODUCTION' if p.get('excluded') else 'NOT FOR MANUFACTURE' if revision.get('status')!='released' else 'RELEASED'
 txt(c,20,50,status,7)
 txt(c,20,273,p['name'][:100],10)


def vb(v):
 a=np.array([pt for key in ('visible','hidden') for seg in v[key] for pt in seg]);return a.min(axis=0),a.max(axis=0)
def view(c,v,box,title,holes=[],axes=(0,1),dims=True):
 x,y,w,h=box;lo,hi=vb(v);span=hi-lo;scale=min((w-32)/max(span[0],1),(h-26)/max(span[1],1));o=np.array([x+w/2,y+h/2])-(hi+lo)/2*scale
 for k in ['hidden','visible']:
  c.setStrokeColorRGB(*((.6,.65,.65) if k=='hidden' else (.1,.14,.14)));c.setLineWidth((.12 if k=='hidden' else .23)*mm);c.setDash(*([1.3*mm,.8*mm] if k=='hidden' else []))
  for seg in v[k]:
   path=c.beginPath();path.moveTo(*(np.array(seg[0])*scale+o)*mm)
   for pt in seg[1:]:path.lineTo(*(np.array(pt)*scale+o)*mm)
   c.drawPath(path)
 c.setDash();c.setStrokeColorRGB(.1,.14,.14);txt(c,x+5,y+h-3,title+f'  ({scale:.3f}:1)',8)
 avoid=[]
 if dims:
  a=lo*scale+o;b=hi*scale+o;c.setLineWidth(.12*mm);avoid=[(a[0]-9,a[1]-10,b[0]+2,a[1]-.3),(a[0]-10,a[1]-9,a[0]-.3,b[1]+2)]
  for xx in (a[0],b[0]):ln(c,xx,a[1],xx,a[1]-5)
  ln(c,a[0],a[1]-4,b[0],a[1]-4);txt(c,(a[0]+b[0])/2-5,a[1]-8,f'{span[0]:.3f} REF',7)
  for yy in (a[1],b[1]):ln(c,a[0]-5,yy,a[0],yy)
  ln(c,a[0]-4,a[1],a[0]-4,b[1]);c.saveState();c.translate((a[0]-7)*mm,((a[1]+b[1])/2)*mm);c.rotate(90);c.setFont('Helvetica',7);c.drawString(0,0,f'{span[1]:.3f} REF');c.restoreState()
 label_holes(c,holes,scale,o,axes,box,avoid)
 return scale

LABEL_SIZE=6.2
def _overlap(a,b):
 """Overlap area of two (x0,y0,x1,y1) rectangles."""
 return max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
def label_holes(c,holes,scale,o,axes,box,avoid=()):
 """Place each hole label beside its own bore with a short leader. Every label tries eight compass
 positions on two rings and takes the cheapest (no overlap with placed labels, other bores, dimension
 bands or the view border); a short relaxation pass then removes any residual overlap. This replaces
 the old margin-stacked leaders whose lines criss-crossed the whole view."""
 if not holes:return
 x,y,w,h=box;pad=1.1;lh=3.1;gap=1.6
 lo=np.array([x+1.5,y+2.5]);hi=np.array([x+w-1.5,y+h-6.5])
 items=[]
 for hole in holes:
  q=np.array([hole['center'][axes[0]],hole['center'][axes[1]]])*scale+o
  text=f"{hole['id']}  D{hole['diameter']:.2f}";tw=stringWidth(text,'Helvetica',LABEL_SIZE)/mm+2*pad
  items.append({'q':q,'r':max(hole['diameter']/2*scale,.4),'text':text,'w':tw,'h':lh,'p':None})
 bores=[(it['q'][0]-it['r'],it['q'][1]-it['r'],it['q'][0]+it['r'],it['q'][1]+it['r']) for it in items]
 rect=lambda p,it:(p[0]-it['w']/2,p[1]-it['h']/2,p[0]+it['w']/2,p[1]+it['h']/2)
 placed=[]
 # Place the outermost holes first: they own the free margin, inner holes then pack around them.
 centre=np.mean([it['q'] for it in items],axis=0)
 for it in sorted(items,key=lambda it:-np.linalg.norm(it['q']-centre)):
  best=None
  for ring in (0,1,2):
   for k in range(8):
    ang=math.radians(45*k+22.5*(ring%2));d=np.array([math.cos(ang),math.sin(ang)])
    dist=it['r']+gap+ring*(lh+1.2)+abs(d[0])*it['w']/2+abs(d[1])*it['h']/2
    p=it['q']+d*dist;r=rect(p,it)
    cost=ring*3+k*.05
    cost+=sum(_overlap(r,pr) for pr in placed)*40
    cost+=sum(_overlap(r,br) for br in bores)*25
    cost+=sum(_overlap(r,ar) for ar in avoid)*30
    cost+=(max(0,lo[0]-r[0])+max(0,r[2]-hi[0])+max(0,lo[1]-r[1])+max(0,r[3]-hi[1]))*12
    if best is None or cost<best[0]:best=(cost,p)
  it['p']=best[1];placed.append(rect(it['p'],it))
 for _ in range(80):
  moved=False
  for i,a in enumerate(items):
   push=np.zeros(2);ra=rect(a['p'],a)
   for j,b in enumerate(items):
    if i==j:continue
    delta=a['p']-b['p'];ox=(a['w']+b['w'])/2+.7-abs(delta[0]);oy=(a['h']+b['h'])/2+.5-abs(delta[1])
    if ox>0 and oy>0:
     if ox<oy:push[0]+=(1 if delta[0]>=0 else -1)*ox/2
     else:push[1]+=(1 if delta[1]>=0 else -1)*oy/2
    delta=a['p']-b['q'];need=b['r']+a['h']/2+.6;dist=np.linalg.norm(delta)
    if dist<need and _overlap(ra,bores[j])>0:push+=(delta/max(dist,1e-6))*(need-dist)/2
   for ar in avoid:
    if _overlap(ra,ar)>0:
     # leave a dimension band by the shortest route
     cands=[(ar[2]-ra[0],np.array([1,0])),(ra[2]-ar[0],np.array([-1,0])),(ar[3]-ra[1],np.array([0,1])),(ra[3]-ar[1],np.array([0,-1]))]
     amt,dirn=min(cands,key=lambda t:t[0]);push+=dirn*amt
   if np.linalg.norm(push)>.05:
    a['p']=np.clip(a['p']+push,lo+[a['w']/2,a['h']/2],hi-[a['w']/2,a['h']/2]);moved=True
  if not moved:break
 c.setLineWidth(.12*mm);c.setStrokeColorRGB(.1,.14,.14)
 for it in items:
  p=it['p'];q=it['q'];d=p-q;dist=np.linalg.norm(d)
  if dist>1e-6:
   d=d/dist;start=q+d*it['r']
   tx=np.clip(q[0],p[0]-it['w']/2,p[0]+it['w']/2);ty=np.clip(q[1],p[1]-it['h']/2,p[1]+it['h']/2)
   ln(c,start[0],start[1],tx,ty);c.circle(start[0]*mm,start[1]*mm,.35*mm,stroke=1,fill=1)
  c.setFillColorRGB(1,1,1);c.rect((p[0]-it['w']/2)*mm,(p[1]-it['h']/2)*mm,it['w']*mm,it['h']*mm,stroke=0,fill=1);c.setFillColorRGB(0,0,0)
  txt(c,p[0]-it['w']/2+pad,p[1]-it['h']/2+.85,it['text'],LABEL_SIZE)

AXES={'top':(0,1),'front':(0,2),'right':(1,2)};NORMALS={'top':2,'front':1,'right':0}
def view_holes(holes,key):
 normal=NORMALS[key]
 return [h for h in holes if abs(h['axis'][normal])>.999 or
         (max(abs(a) for a in h['axis'])<=.999 and int(np.argmax(np.abs(h['axis'])))==normal)]

def ordinate_values(v,holes,axes):
 """Ordinate visible outline vertices and bore centres, excluding hidden-edge artifacts."""
 from shapely.geometry import LineString
 from shapely.ops import polygonize,unary_union
 from shapely import set_precision
 lo,hi=vb(v);points=[lo,hi]
 lines=[set_precision(LineString(seg),1e-5) for seg in v['visible'] if len(seg)>1]
 silhouette=unary_union(list(polygonize(unary_union(lines))))
 polygons=list(silhouette.geoms) if silhouette.geom_type=='MultiPolygon' else [silhouette] if silhouette.geom_type=='Polygon' else []
 boundary=unary_union([poly.exterior for poly in polygons])
 for seg in v['visible']:
  if len(seg)==2 and not boundary.is_empty:
   # A straight segment must lie on the silhouette, not across a pocket or bore.
   line=LineString(seg)
   if boundary.buffer(.0001).covers(line):points.extend(seg)
 points.extend(np.array(h['center'])[list(axes)] for h in holes)
 return [sorted(set(max(0,round(float(pt[j]-lo[j]),3)) for pt in points if lo[j]-1e-5<=pt[j]<=hi[j]+1e-5)) for j in (0,1)]

def spread_ordinates(values,base,scale,limit,gap=4):
 """Space ordered labels in a bounded lane; callers paginate to satisfy capacity."""
 positions=[base+v*scale for v in values]
 for i in range(1,len(positions)):positions[i]=max(positions[i],positions[i-1]+gap)
 if positions and positions[-1]>limit:
  positions[-1]=limit
  for i in range(len(positions)-2,-1,-1):positions[i]=min(positions[i],positions[i+1]-gap)
 return positions

def ordinate_view(c,v,box,title,holes,axes,coordinates=None):
 x,y,w,h=box;lo,hi=vb(v);span=hi-lo
 # Reserve broad lanes below and left; use jogged leaders for close ordinates.
 scale=min((w-80)/max(span[0],1),(h-65)/max(span[1],1))
 o=np.array([x+55,y+45])-lo*scale
 for kind in ('hidden','visible'):
  c.setLineWidth((.10 if kind=='hidden' else .22)*mm);c.setDash(*([1.2*mm,.8*mm] if kind=='hidden' else []))
  for seg in v[kind]:
   path=c.beginPath();path.moveTo(*((np.array(seg[0])*scale+o)*mm))
   for pt in seg[1:]:path.lineTo(*((np.array(pt)*scale+o)*mm))
   c.drawPath(path)
 c.setDash();txt(c,x,y+h,title+f' ({scale:.3f}:1)',9)
 a=lo*scale+o;xx,yy=coordinates if coordinates is not None else ordinate_values(v,holes,axes)
 for val,label_x in zip(xx,spread_ordinates(xx,a[0],scale,x+w-5)):
  px=a[0]+val*scale;ln(c,px,a[1]-1,px,a[1]-6);ln(c,px,a[1]-6,label_x,a[1]-10);ln(c,label_x,a[1]-10,label_x,a[1]-13)
  c.saveState();c.translate(label_x*mm,(a[1]-15)*mm);c.rotate(90);c.setFont('Helvetica',7);c.drawRightString(0,0,f'{val:g}');c.restoreState()
 for val,label_y in zip(yy,spread_ordinates(yy,a[1],scale,y+h-12)):
  py=a[1]+val*scale;ln(c,a[0]-1,py,a[0]-6,py);ln(c,a[0]-6,py,a[0]-12,label_y);ln(c,a[0]-12,label_y,a[0]-15,label_y)
  c.setFont('Helvetica',7);c.drawRightString((a[0]-17)*mm,(label_y-.8)*mm,f'{val:g}')
 c.circle(a[0]*mm,a[1]*mm,.8*mm);txt(c,x,y-5,'Origin (0,0): bottom-left of this projected envelope. Coordinates in mm.',7)
 # Centre marks associate the ordinate coordinates with the bore schedule.
 for hole in holes:
  q=np.array(hole['center'])[list(axes)]*scale+o
  ln(c,q[0]-1,q[1],q[0]+1,q[1]);ln(c,q[0],q[1]-1,q[0],q[1]+1)
 txt(c,x,y-10,'Outline vertices and bore centres shown. Bore sizes: matching view schedule. Pockets/sections require detailing.',7)

def profile_chamfers(v):
 """Measure straight diagonal cuts bounded by orthogonal outline edges.

 Only true projected profiles are accepted here; 3D verification is supplied by
 make_part. Never treat a tessellated arc chord as a chamfer.
 """
 from shapely.geometry import LineString
 from shapely.ops import polygonize,unary_union
 from shapely import set_precision
 lines=[set_precision(LineString(seg),1e-5) for seg in v['visible'] if len(seg)>1]
 silhouette=unary_union(list(polygonize(unary_union(lines))))
 polys=list(silhouette.geoms) if silhouette.geom_type=='MultiPolygon' else [silhouette] if silhouette.geom_type=='Polygon' else []
 straight=[np.asarray(seg) for seg in v['visible'] if len(seg)==2]
 straight_coverage=unary_union([LineString(seg).buffer(.0001) for seg in straight])
 result=[]
 for poly in polys:
  for ring in [poly.exterior,*poly.interiors]:
   points=np.asarray(ring.simplify(.0001).coords)[:-1]
   for i,a in enumerate(points):
    b=points[(i+1)%len(points)];d=b-a
    if min(abs(d))<.05:continue
    before=a-points[i-1];after=points[(i+2)%len(points)]-b
    if min(abs(before))>.0001 or min(abs(after))>.0001:continue
    if np.argmax(abs(before))==np.argmax(abs(after)):continue
    # Require an unsampled source straight edge covering this complete segment.
    target=LineString([a,b])
    if not straight_coverage.covers(target):continue
    length=abs(d[0]);angle=math.degrees(math.atan2(abs(d[1]),abs(d[0])))
    result.append({'point':((a+b)/2).tolist(),'length':float(length),'angle':float(angle),'segment':[a.tolist(),b.tolist()]})
 return result


def local_callouts(c,items,v,scale,o,box,avoid=(),draw=True):
 """Place bounded multi-line leaders in actual white space near their feature."""
 from shapely.geometry import LineString,box as rect,Point
 from shapely.ops import unary_union
 x,y,w,h=box;size=7.5;line_height=3.5
 geometry=unary_union([LineString(np.asarray(seg)*scale+o) for kind in ('visible','hidden') for seg in v[kind] if len(seg)>1])
 geometry_band=geometry.buffer(.2)
 occupied=[rect(*r) for r in avoid];leaders=[];placements=[]
 # Start with the largest blocks: shorter callouts can use smaller remaining gaps.
 for item in sorted(items,key=lambda it:-len(it['lines'])):
  anchor=np.asarray(item['point'])*scale+o
  width=max(stringWidth(line,'Helvetica',size)/mm for line in item['lines'])+2
  height=len(item['lines'])*line_height+1
  if width>w-4 or height>h-10:raise ValueError('Feature callout exceeds drawing view; shorten the designation')
  best=None;candidates=[]
  for xx in np.arange(x+2,x+w-width-1,3):
   for yy in np.arange(y+3,y+h-height-8,3):
    endpoint=np.array([np.clip(anchor[0],xx,xx+width),np.clip(anchor[1],yy,yy+height)])
    distance=float(np.linalg.norm(endpoint-anchor))
    if distance>=1:candidates.append((distance,xx,yy,endpoint))
  for distance,xx,yy,endpoint in sorted(candidates,key=lambda row:row[0]):
   if best is not None and distance>best[0]:break
   bounds=(xx,yy,xx+width,yy+height);candidate=rect(*bounds);padded=candidate.buffer(.7)
   if any(padded.intersects(other) for other in occupied):continue
   if any(padded.intersects(other) for other in leaders):continue
   if geometry.intersects(padded):continue
   direction=endpoint-anchor;start=anchor+direction/distance*item.get('radius',0)*scale
   leader=LineString([start,endpoint])
   if any(leader.intersects(other) for other in occupied):continue
   cost=distance+sum(leader.crosses(other)*35 for other in leaders)+leader.intersection(geometry_band).length*3
   if best is None or cost<best[0]:best=(cost,bounds,start,endpoint,leader)
  if best is None:raise ValueError('No clear space for feature callout; drawing needs an additional detail view')
  _,bounds,start,endpoint,leader=best;occupied.append(rect(*bounds));leaders.append(leader);placements.append((item,bounds,start,endpoint))
 if draw:draw_callouts(c,placements)
 return placements


def draw_callouts(c,placements):
 size=7.5;line_height=3.5
 for item,(x0,y0,x1,y1),start,endpoint in placements:
  metadata={k:item[k] for k in ('feature_ids','measurements') if k in item}
  with group(c,item['id'],'callout',anchor=(start*mm).tolist(),bounds=[x0*mm,y0*mm,x1*mm,y1*mm],lines=item['lines'],size=size,**metadata):
   c.setLineWidth(.14*mm);ln(c,*start,*endpoint)
   delta=endpoint-start;delta/=np.linalg.norm(delta);normal=np.array([-delta[1],delta[0]])
   path=c.beginPath();path.moveTo(*(start*mm));path.lineTo(*((start+delta*3+normal*.9)*mm));path.lineTo(*((start+delta*3-normal*.9)*mm));path.close();c.drawPath(path,fill=1,stroke=0)
   for i,line in enumerate(item['lines']):txt(c,x0+1,y1-3-i*line_height,line,size)



def detail_items(v,holes,axes,spec,chamfers):
 lo,_=vb(v);items=[];features=v.get('hole_features')
 if features is None:
  features=[{'id':'HF_'+h['id'],'hole_ids':[h['id']],'center':h['center'],'diameter':h['diameter'],'depth':h['depth'],'through':False,'entrances':[],'steps':[]} for h in holes]
 groups={}
 for feature in features:
  lines=feature_lines(feature,v.get('normal_sign',1))
  designations=list(dict.fromkeys(spec.get('feature_specs',{}).get(id,{}).get('designation','') for id in feature['hole_ids']))
  if any(designations):lines=[d for d in designations if d]+lines[1:]
  # Group identical physical holes; different steps/depths remain separate features.
  signature=tuple(lines);groups.setdefault(signature,[]).append(feature)
 for lines,features in groups.items():
  points=[np.array(f['center'])[list(axes)] for f in features];center=np.mean(points,axis=0);chosen=min(range(len(points)),key=lambda i:np.linalg.norm(points[i]-center));point=points[chosen]
  lines=list(lines)
  if len(features)>1:lines[0]=f'{len(features)}X '+lines[0]
  positions=sorted(set(tuple(np.round(pt-lo,3)) for pt in points))
  for x,y in positions:lines.append(f'X {x:.2f}   Y {y:.2f}')
  ids=sorted(id for f in features for id in f['hole_ids'])
  items.append({'id':f"callout:{v.get('view_key','view')}:"+'-'.join(ids),'point':point,'radius':features[chosen]['diameter']/2,'lines':lines,'feature_ids':ids,'measurements':features})
 for i,ch in enumerate(chamfers):
  items.append({'id':f"chamfer:{v.get('view_key','view')}:{i}",'point':ch['point'],'lines':[f"{ch['length']:.2f} x {ch['angle']:.1f} deg"],'measurements':[ch]})
 return items


def machining_view(c,v,box,title,holes,axes,spec,chamfers):
 x,y,w,h=box;lo,hi=vb(v);span=hi-lo
 scale=min((w-65)/max(span[0],1),(h-48)/max(span[1],1))
 # Centre the geometry so all four white-space margins can hold local callouts.
 items=detail_items(v,holes,axes,spec,chamfers)
 for attempt in range(8):
  o=np.array([x+w/2,y+h/2])-(lo+hi)/2*scale
  a=lo*scale+o;b=hi*scale+o
  avoid=[(a[0]-19,a[1]-17,b[0]+5,a[1]-.5),(a[0]-19,a[1]-2,a[0]-.5,b[1]+6)]
  try:
   placements=local_callouts(c,items,v,scale,o,box,avoid,draw=False);break
  except ValueError:
   if attempt==7:raise
   scale*=.92
 for kind in ('hidden','visible'):
  c.setStrokeColorRGB(*((.55,.55,.55) if kind=='hidden' else (.05,.05,.05)))
  c.setLineWidth((.10 if kind=='hidden' else .22)*mm);c.setDash(*([1.2*mm,.8*mm] if kind=='hidden' else []))
  for seg in v[kind]:
   path=c.beginPath();path.moveTo(*((np.asarray(seg[0])*scale+o)*mm))
   for pt in seg[1:]:path.lineTo(*((np.asarray(pt)*scale+o)*mm))
   c.drawPath(path)
 c.setDash();c.setStrokeColorRGB(0,0,0);txt(c,x+2,y+h-3,title+f'  ({scale:.3f}:1)',9)
 a=lo*scale+o;b=hi*scale+o
 # Outline ordinates retain the bottom-left datum; bore XY values sit at the holes.
 c.setLineWidth(.12*mm);xx,yy=ordinate_values(v,[],axes)
 for value,label_x in zip(xx,spread_ordinates(xx,a[0],scale,x+w-4,3.2)):
  px=a[0]+value*scale;ln(c,px,a[1]-1,px,a[1]-4);ln(c,px,a[1]-4,label_x,a[1]-7)
  c.saveState();c.translate(label_x*mm,(a[1]-9)*mm);c.rotate(90);c.setFont('Helvetica',7);c.drawRightString(0,0,f'{value:g}');c.restoreState()
 for value,label_y in zip(yy,spread_ordinates(yy,a[1],scale,y+h-12,3.2)):
  py=a[1]+value*scale;ln(c,a[0]-1,py,a[0]-4,py);ln(c,a[0]-4,py,a[0]-8,label_y)
  c.setFont('Helvetica',7);c.drawRightString((a[0]-9)*mm,(label_y-.8)*mm,f'{value:g}')
 c.circle(a[0]*mm,a[1]*mm,.8*mm)
 avoid=[(a[0]-19,a[1]-17,b[0]+5,a[1]-.5),(a[0]-19,a[1]-2,a[0]-.5,b[1]+6)]
 for hole in holes:
  q=np.asarray(hole['center'])[list(axes)]*scale+o
  ln(c,q[0]-1,q[1],q[0]+1,q[1]);ln(c,q[0],q[1]-1,q[0],q[1]+1)
 draw_callouts(c,placements)

def part_sheets(c,p,rev,folder,rules,vs,views=True):
 """Legacy A3 sheets. views=True: view pages + specification + rules (fallback drawing). views=False: the
 engineering review record only (review.pdf) - specification, rules and bend schedule."""
 folder=Path(folder);g=p['geometry'];spec=p['spec'];holes=[] if p['category']=='sheet_metal' else g.get('holes',[]);axes=AXES;normals=NORMALS
 if not views:sheet=1
 elif p['category']=='machining':
  frame(c,p,rev,1)
  for key,box in [('front',(20,65,190,195)),('top',(212,65,190,195))]:
   with group(c,'view:'+key,'view',title=key.upper()):
    machining_view(c,vs[key],box,key.upper()+' - BOTTOM LEFT ORIGIN',view_holes(holes,key),axes[key],spec,vs[key].get('chamfers',[]))
  txt(c,22,56,'mm | XY from each view bottom-left (0,0). Depths from source geometry. Thread/fit only where specified.',7)
  c.showPage();frame(c,p,rev,2)
  with group(c,'view:right','view',title='RIGHT'):
   machining_view(c,vs['right'],(20,65,235,195),'RIGHT - BOTTOM LEFT ORIGIN',view_holes(holes,'right'),axes['right'],spec,vs['right'].get('chamfers',[]))
  with group(c,'view:iso','view',title='ISOMETRIC'):
   view(c,{**vs['iso'],'hidden':[]},(258,96,144,154),'ISOMETRIC',dims=False)
  txt(c,22,56,'Chamfers: setback length x angle in the indicated view. Verify machining specifications before release.',7)
  c.showPage();sheet=3
 else:
  frame(c,p,rev,1)
  for key,box in [('top',(24,164,190,96)),('front',(24,53,190,99)),('right',(215,53,190,99)),('iso',(215,164,190,96))]:
   with group(c,'view:'+key,'view',title=key.upper()):
    view(c,vs[key],box,key.upper()+' VIEW',view_holes(holes,key)[:22] if key!='iso' else [],axes.get(key,(0,1)),key!='iso')
  c.showPage();sheet=2
 frame(c,p,rev,sheet);sheet+=1;txt(c,25,253,'MANUFACTURING & INSPECTION SPECIFICATION',11);y=242
 for label,key in [('Material','material'),('Raw stock','stock'),('Process','process'),('Edge treatment','edge_treatment'),('Finish','finish'),('Coating system','paint'),('Coating colour','coating_color'),('Coating thickness','coating_thickness'),('Masking','masking'),('Heat treatment','heat_treatment'),('Hardness','hardness'),('Surface roughness','roughness'),('Functional datums','datums'),('General tolerance','general_tolerance'),('Marking','marking'),('Packaging','packaging'),('Notes','notes')]:
  if key in ('stock','edge_treatment','coating_color','coating_thickness','masking','hardness','marking','packaging') and not spec.get(key):continue
  y=wrap(c,25,y,f'{label}: {spec.get(key) or "UNSPECIFIED"}')-2
 y=wrap(c,25,y,'Nominal envelope (mm): '+' x '.join(f'{x:.3f}' for x in g['dimensions']))-3
 for b in g.get('bends',[]):
  if y<65:c.showPage();frame(c,p,rev,sheet);sheet+=1;y=250
  y=wrap(c,25,y,f"{b['id']}: bend {b['angle']:.3f} deg; inside R {b['radius']:.3f}; length {b['length']:.3f}; K={spec.get('k_factor',.4)} {'approved' if spec.get('k_factor_approved') else 'PROVISIONAL'}")
 for key,note in spec.get('manual_checks',{}).items():
  if y<78:c.showPage();frame(c,p,rev,sheet);sheet+=1;y=250
  y=wrap(c,25,y,f"Engineering check / {key}: {note or 'PENDING'}")-2
 ops=spec.get('operations',[])
 if ops:
  if y<90:c.showPage();frame(c,p,rev,sheet);sheet+=1;y=250
  txt(c,25,y,'PROCESS SEQUENCE',9);y-=5
 for n,operation in enumerate(ops,1):
  if y<78:c.showPage();frame(c,p,rev,sheet);sheet+=1;y=250
  op=operation if isinstance(operation,dict) else {'name':str(operation),'detail':''}
  y=wrap(c,25,y,f"{n*10:03d}  {op.get('name','')}{('  -  '+op['detail']) if op.get('detail') else ''}")-2
 if rev.get('release_by'):y=wrap(c,25,y,'Released by '+str(rev['release_by'])+' / '+str(rev.get('release_at','')))
 for fid,fs in spec.get('feature_specs',{}).items():
  if fid.startswith('H'):continue
  if y<78:c.showPage();frame(c,p,rev,sheet);sheet+=1;y=250
  unit='deg' if fid.startswith('B') else 'mm'
  y=wrap(c,25,y,f"QC {fid} / {fs.get('designation','')}: {fs.get('lower','UNSET')} to {fs.get('upper','UNSET')} {unit}")-2
 y=wrap(c,25,y-3,'Plan QC by feature ID. Enter approved limits and calibrated instrument before recording measured values.')
 c.showPage();checks=evaluate(g,spec,rules)
 if p['category']=='sheet_metal':checks=[ch for ch in checks if not str(ch.get('feature') or '').startswith('H')]
 for start in range(0,max(1,len(checks)),16):
  frame(c,p,rev,sheet);sheet+=1;txt(c,25,254,'DESIGN RULES & RELEASE RECORD',11);y=244
  for ch in checks[start:start+16]:
   y=wrap(c,25,y,f"{ch['code']} {ch.get('feature') or ''} | {ch['severity'].upper()} | {ch['title']}",size=8)
   y=wrap(c,29,y,ch['detail']+((' | Disposition: '+ch['waiver']) if ch['waiver'] else ''),370,7)-2
  if not checks:txt(c,25,y,'No findings displayed here; see the full release checks in the workspace.',9)
  c.showPage()
 if p.get('category')=='sheet_metal' and g.get('flat_status')=='supported' and (folder/'flat.json').exists():
  flat=json.loads((folder/'flat.json').read_text());frame(c,p,rev,sheet);txt(c,25,254,'DEVELOPED SHEET & FORMED ISOMETRIC',11)
  fv={'visible':[flat['outline']]+flat['holes'],'hidden':[]};view(c,fv,(25,64,238,177),'FLAT PATTERN - '+('APPROVED K' if spec.get('k_factor_approved') else 'PROVISIONAL K'))
  view(c,vs['iso'],(268,113,134,120),'FORMED ISOMETRIC',dims=False)
  lo,hi=vb(fv);scale=min((238-32)/max((hi-lo)[0],1),(177-26)/max((hi-lo)[1],1));o=np.array([25+238/2,64+177/2])-(hi+lo)/2*scale
  for b in flat['bends']:
   a=np.array(b['a'])*scale+o;z=np.array(b['b'])*scale+o;c.setDash(2*mm,1*mm);c.setStrokeColorRGB(.75,.3,.05);ln(c,*a,*z);c.setDash();c.setStrokeColorRGB(.1,.14,.14)
   mid=(a+z)/2;d=(z-a);ang=math.degrees(math.atan2(d[1],d[0]))
   if ang>90 or ang<-90:ang+=180
   label=f"{b['id']}  {b['angle']:.1f} deg  {b.get('direction','').upper()}"+(f"  H(out) {b['outside_height']:.2f}" if b.get('outside_height') is not None else '');c.saveState();c.translate(mid[0]*mm,mid[1]*mm);c.rotate(ang);c.setFont('Helvetica',6.5);tw=stringWidth(label,'Helvetica',6.5);c.setFillColorRGB(1,1,1);c.rect(-tw/2-1.5,-2.2,tw+3,7,stroke=0,fill=1);c.setFillColorRGB(.75,.3,.05);c.drawString(-tw/2,0,label);c.restoreState();c.setFillColorRGB(0,0,0)
  c.showPage();sheet+=1
  for start in range(0,max(1,len(flat['bends'])),20):
   frame(c,p,rev,sheet);sheet+=1;txt(c,25,253,'BEND SCHEDULE - OUTSIDE FORMED HEIGHT / mm',11)
   cols=[(25,'ID'),(50,'ANGLE'),(80,'INSIDE R'),(112,'DIR'),(140,'ALLOWANCE'),(181,'LINE LENGTH'),(225,'OUTSIDE HEIGHT')]
   for cx,ct in cols:txt(c,cx,241,ct,8)
   ln(c,25,237,395,237);y=229
   for b in flat['bends'][start:start+20]:
    height=b.get('outside_height');values=[b['id'],f"{b['angle']:.1f}",f"{b['radius']:.2f}",b.get('direction','?').upper(),f"{b['allowance']:.2f}",f"{b.get('length',0):.2f}",f'{height:.2f}' if height is not None else 'REQUIRES DETAIL']
    for (cx,_),val in zip(cols,values):txt(c,cx,y,val,8)
    y-=7
   wrap(c,25,79,'Outside height: perpendicular distance from the outside of the parent flange to the far edge of the adjoining flange. Height is reported for verified 90-degree bends.',370,7)
   wrap(c,25,68,f"Thickness {g['thickness']:.3f} mm | K {spec.get('k_factor',.4)} ({'approved' if spec.get('k_factor_approved') else 'PROVISIONAL'}). UP/DOWN is relative to the developed root skin. Verify bend sequence and tooling.",370,7)
   c.showPage()

def pictorial_for(p,folder,scene,azimuth,elevation):
 """Projected visible edges for a pictorial angle, cached per part (editor palette and dropped views)."""
 import hashlib
 fr=scene.get('frame')
 if fr:frame=(np.array(fr['n0']),np.array(fr['up0']))
 else:
  n0,up0=drafting.choose_main(p['geometry'],[],p.get('category')=='sheet_metal');frame=(n0,up0)
 key=hashlib.sha256(json.dumps([round(azimuth,3),round(elevation,3),[round(float(x),6) for x in frame[0]],[round(float(x),6) for x in frame[1]]]).encode()).hexdigest()[:20]
 cache=Path(folder)/'pictorial-cache'/(key+'.json')
 if cache.exists():return json.loads(cache.read_text())
 data=drafting.pictorial_lines(read_brep(Path(folder)/'shape.brep'),frame,azimuth,elevation)
 cache.parent.mkdir(exist_ok=True);cache.write_text(json.dumps(data));return data

EXTRA_SIZES=('A4','A3','A2')
def blank_page(p,rev,settings,size,scale=1.0):
 """An empty template sheet (frame, zones, title block) the drawing editor can move views and details to."""
 sh=drafting.Sheet(size);tb=drafting.title_values(p,rev,settings or {},1,1,scale,size);drafting.draw_template(sh,tb)
 c=SceneCanvas(io.BytesIO(),pagesize=(sh.w*mm,sh.h*mm));drafting.render_pdf(sh,c)
 return c.pages[0]


def validate_extra_pages(extra):
 if not isinstance(extra,list) or len(extra)>10:raise ValueError('At most 10 added sheets')
 out=[];ids=set()
 for e in extra:
  if not isinstance(e,dict) or set(e)-{'id','size','page'} or e.get('size') not in EXTRA_SIZES:raise ValueError('Added sheets need a size of A4, A3 or A2')
  if not isinstance(e.get('id'),str) or not 0<len(e['id'])<=40 or e['id'] in ids:raise ValueError('Invalid sheet id')
  ids.add(e['id']);out.append({'id':e['id'],'size':e['size']})
 return out


def full_scene(p,rev,settings,scene,edits):
 """The generated sheets plus the blank sheets added in the editor (appended in order)."""
 extra=(edits or {}).get('extra_pages') or []
 if not extra:return scene
 scale=(scene.get('frame') or {}).get('scale') or 1.0
 return {**scene,'pages':scene['pages']+[unique_ids(blank_page(p,rev,settings,e['size'],scale),e['id']) for e in extra]}


def unique_ids(page,prefix):
 """Group ids of an added sheet are prefixed with its id so they never collide with generated sheets."""
 return {**page,'groups':[{**g,'id':f"{prefix}:{g['id']}",**({'parent':f"{prefix}:{g['parent']}"} if g.get('parent') else {})} for g in page['groups']]}


def attach_view_lines(p,folder,scene,edits):
 """Placed pictorial views carry only angles/position; attach their projected lines from the source solid."""
 if not edits.get('views'):return edits
 out=dict(edits);out['views']=[]
 for v in edits['views']:
  data=pictorial_for(p,folder,scene,v['azimuth'],v['elevation'])
  out['views'].append({**{k:x for k,x in v.items() if k not in ('lines','lo','hi')},**data})
 return out

def make_part(p,rev,folder,rules,combined=None,settings=None):
 """Write drawing.pdf, drawing.dxf, part.step and projections.json for one part; optionally also append
 the same sheets to a combined category canvas."""
 folder=Path(folder);folder.mkdir(exist_ok=True,parents=True);g=p['geometry'];holes=[] if p['category']=='sheet_metal' else g.get('holes',[]);axes=AXES;normals=NORMALS;vs=projections(read_brep(folder/'shape.brep'))
 if p['category']=='machining':
  g['hole_features']=hole_features(read_brep(folder/'shape.brep'),g.get('holes',[]))
  from .cad import face_features
  _,planes,_,_=face_features(read_brep(folder/'shape.brep'))
  for key in AXES:
   normal=NORMALS[key];ax=AXES[key];accepted=[]
   for ch in profile_chamfers(vs[key]):
    delta=np.diff(np.asarray(ch['segment']),axis=0)[0];direction=np.zeros(3);direction[list(ax)]=delta;direction/=np.linalg.norm(direction)
    # A chamfer profile must be perpendicular to its actual planar face and
    # parallel to the viewing plane; this excludes foreshortened sloping edges.
    for plane in planes:
     n=plane['normal']
     if abs(n[normal])>1e-5 or abs(np.dot(n,direction))>1e-5:continue
     point=np.zeros(3);point[list(ax)]=ch['point'];point[normal]=plane['center'][normal]
     if abs(np.dot(point-plane['origin'],n))<.0001:
      accepted.append(ch);break
   vs[key]['chamfers']=accepted
   vs[key]['hole_features']=view_holes(g['hole_features'],key)
   vs[key]['view_key']=key;vs[key]['normal_sign']=-1 if key=='front' else 1
 (folder/'projections.json').write_text(json.dumps(vs))
 from OCP.STEPControl import STEPControl_Writer,STEPControl_AsIs
 writer=STEPControl_Writer();writer.Transfer(read_brep(folder/'shape.brep'),STEPControl_AsIs);writer.Write(str(folder/'part.step.tmp'))
 # neutral header (no writer / author / organisation), file named after the part
 from .scrub import scrub_step
 safe=re.sub(r'[^\w.+ -]+','_',p.get('name') or 'part').strip() or 'part'
 scrub_step(folder/'part.step.tmp',folder/'part.step',safe+'.step',clean_names=False);(folder/'part.step.tmp').unlink(missing_ok=True)
 # Vendor drawing: GOAT-template sheets (sheet.py) recorded as an editable scene for the drawing editor.
 settings=settings or {}
 flat=json.loads((folder/'flat.json').read_text()) if g.get('flat_status')=='supported' and (folder/'flat.json').exists() else None
 try:sheets=drafting.build_sheets(read_brep(folder/'shape.brep'),p,rev,settings,flat,(p.get('drawing_edits') or {}).get('pictorials'),p.get('drawing_options') if isinstance(p.get('drawing_options'),dict) else None)
 except Exception as e:
  import traceback;traceback.print_exc();sheets=[]
 c=SceneCanvas(io.BytesIO(),pagesize=(420*mm,297*mm));c.setTitle(drafting.clean_name(p['name']));c.setAuthor('Forge')
 if sheets:
  for sh in sheets:drafting.render_pdf(sh,c)
 else:part_sheets(c,p,rev,folder,rules,vs)
 c.save()
 scene=c.scene(rev.get('sha256',''))
 frame=getattr(sheets[0],'frame',None) if sheets else None
 if frame is not None:scene['frame']={'n0':[float(x) for x in frame[0]],'up0':[float(x) for x in frame[1]],'scale':float(sheets[0].meta['scale'])}
 (folder/'drawing-scene.json').write_text(json.dumps(scene))
 # Inspection characteristics (balloons) of the generated sheets, in scene points
 try:
  from . import inspection
  chars=inspection.to_points(inspection.extract(sheets,settings),scene) if sheets else []
  (folder/'characteristics.json').write_text(json.dumps({'scene_hash':scene['scene_hash'],'chars':chars}))
 except Exception:
  import traceback;traceback.print_exc();(folder/'characteristics.json').unlink(missing_ok=True)
 edits=attach_view_lines(p,folder,scene,p.get('drawing_edits') or {})
 fs=full_scene(p,rev,settings,scene,edits)
 render_scene(fs,edits,target=str(folder/'drawing.pdf'))
 if combined is not None:render_scene(fs,edits,c=combined)
 # Engineering record (specification, rule findings, bend schedule) stays out of the vendor drawing.
 r=canvas.Canvas(str(folder/'review.pdf'),pagesize=(420*mm,297*mm));r.setTitle(p['name']+' - engineering review');part_sheets(r,p,rev,folder,rules,vs,views=False);r.save()
 if sheets:
  # Editable DXF: same sheets 1:1, ORDINATE dimensions reading true size (DIMLFAC), MTEXT callouts, title block text.
  drafting.write_dxf(sheets,str(folder/'drawing.dxf'));return
 d=ezdxf.new('R2013');d.units=4
 d.linetypes.new('FORGE_DASH',dxfattribs={'pattern':[3,2,-1]})
 for name,color in [('VISIBLE',7),('HIDDEN',8),('FEATURES',3),('DIMENSIONS',2),('NOTES',7)]:d.layers.new(name,dxfattribs={'color':color,'linetype':'FORGE_DASH' if name=='HIDDEN' else 'Continuous'})
 m=d.modelspace();span=max(g['dimensions']);gap=span*.25+30
 for i,key in enumerate(['front','right','top','iso']):
  v=vs[key];lo,hi=vb(v);o=np.array([(i%2)*(span+gap),(i//2)*(span+gap)])-lo
  for kind in ['visible','hidden']:
   for seg in v[kind]:m.add_lwpolyline((np.array(seg)+o).tolist(),dxfattribs={'layer':kind.upper()})
  h=max(1.5,span/90);m.add_text(key.upper(),dxfattribs={'height':h,'insert':(o+lo+np.array([0,-10-h])).tolist(),'layer':'NOTES'})
  if key!='iso':
   for hole in holes:
    if abs(hole['axis'][normals[key]])<.999:continue
    pos=np.array([hole['center'][axes[key][0]],hole['center'][axes[key][1]]])+o;r=hole['diameter']/2
    tip=pos+np.array([r*.7071,r*.7071]);anchor=tip+np.array([h*1.2,h*1.2])
    m.add_line(tip.tolist(),anchor.tolist(),dxfattribs={'layer':'FEATURES'})
    m.add_text(f"{hole['id']} D{hole['diameter']:.2f}",dxfattribs={'height':h*.7,'insert':(anchor+np.array([h*.3,0])).tolist(),'layer':'FEATURES'})
   if p['category']=='machining':
    for ch in v.get('chamfers',[]):
     tip=np.asarray(ch['point'])+o;anchor=tip+np.array([h*3,h*3])
     m.add_line(tip.tolist(),anchor.tolist(),dxfattribs={'layer':'FEATURES'})
     m.add_text(f"{ch['length']:.2f} x {ch['angle']:.1f} deg",dxfattribs={'height':h*.7,'insert':anchor.tolist(),'layer':'FEATURES'})
    hs=view_holes(holes,key)
    coords=ordinate_values(v,hs,axes[key])
    for axis,values in enumerate(coords):
     for val in values:
      feature=lo.copy();feature[axis]+=val;end=feature.copy();end[1-axis]-=h*6
      dim=m.add_ordinate_dim(feature_location=(feature+o).tolist(),offset=(end-feature).tolist(),dtype=1 if axis==0 else 0,origin=(lo+o).tolist(),dimstyle='EZDXF',override={'dimtxt':h,'dimdec':3});dim.render()
   for p1,p2,base,angle in [(lo, np.array([hi[0],lo[1]]),lo-np.array([0,h*4]),0),(lo,np.array([lo[0],hi[1]]),lo-np.array([h*4,0]),90)]:
    dim=m.add_linear_dim(base=(base+o).tolist(),p1=(p1+o).tolist(),p2=(p2+o).tolist(),angle=angle,dimstyle='EZDXF',override={'dimtxt':h,'dimasz':h*.7,'dimdec':3,'dimpost':'<> REF'});dim.render()
 m.add_text('DRAFT / mm / curves sampled 0.025 mm / NOT CAM / see paired PDF',dxfattribs={'height':max(2,span/90),'insert':(0,-gap),'layer':'NOTES'})
 d.saveas(folder/'drawing.dxf')

CATEGORY_COLORS={'machining':'#8ea8c3','sheet_metal':'#c9a678','purchased':'#5d646d','other':'#b3ada2'}
def thumb_color(p):
 hexcol=str(p.get('spec',{}).get('coating_hex') or '')
 return hexcol if len(hexcol)==7 and hexcol.startswith('#') else CATEGORY_COLORS.get(p.get('category',''),'#aeb4bc')
def combined_canvas(path,title,rev,parts,settings=None):
 """Start a combined drawing set: A4 index sheet(s) listing every part in the order its drawings follow."""
 c=canvas.Canvas(str(path));c.setTitle(title);c.setAuthor('Forge')
 for sh in drafting.cover_sheets(title,rev,parts,settings or {}):drafting.render_pdf(sh,c)
 return c

def render_meshes(meshes,path,size=(1600,1050),colors=None):
 """Raster isometric of actual mesh triangles, used for assembly documentation and part thumbnails."""
 from PIL import Image,ImageDraw
 R=np.array([[.707,.707,0],[-.408,.408,.816],[.577,-.577,.577]])
 W,H=size;margin=int(min(W,H)*.04)
 polygons=[];depths=[];indices=[];colors=colors or ['#98aaa4','#c8d3bc','#d7c8b5','#a8b8c8','#b5c6ac'];allp=[];normals=[]
 for i,(mesh,T) in enumerate(meshes):
  v=np.c_[mesh.vertices,np.ones(len(mesh.vertices))]@T.T;v=(v[:,:3]@R.T).astype(np.float32);allp.append(v)
  tri=v[mesh.faces];polygons.append(tri[:,:,:2]);depths.append(tri[:,:,2].mean(axis=1));indices.append(np.full(len(tri),i%len(colors),dtype=np.int32))
  n=np.cross(tri[:,1]-tri[:,0],tri[:,2]-tri[:,0]);n/=np.maximum(np.linalg.norm(n,axis=1,keepdims=True),1e-9);normals.append(np.abs(n@np.array([-.35,.45,.82])))
 allp=np.vstack(allp);lo=allp[:,:2].min(0);hi=allp[:,:2].max(0);scale=min((W-2*margin)/max(hi[0]-lo[0],1),(H-2*margin)/max(hi[1]-lo[1],1));im=Image.new('RGB',(W,H),'white');draw=ImageDraw.Draw(im)
 polygons=np.concatenate(polygons);span=(hi-lo)*scale;offset=np.array([(W-span[0])/2,(H-span[1])/2]);polygons=(polygons-lo)*scale+offset;polygons[:,:,1]=H-polygons[:,:,1];depths=np.concatenate(depths);indices=np.concatenate(indices);normals=np.concatenate(normals)
 def shade(hexcol,k):
  r,g,b=int(hexcol[1:3],16),int(hexcol[3:5],16),int(hexcol[5:7],16);f=.5+.6*min(1,k);return (min(255,int(r*f)),min(255,int(g*f)),min(255,int(b*f)))
 for i in np.argsort(depths):draw.polygon([tuple(v) for v in polygons[i]],fill=shade(colors[indices[i]],normals[i]))
 im.save(path)

def shows_on_assembly(p,settings):
 """Bought-in items are left off the assembly drawing unless the project or the part overrides it."""
 if p.get('excluded'):return False
 if p.get('category')!='purchased':return True
 opts=p.get('drawing_options') or {}
 if isinstance(opts,str):
  try:opts=json.loads(opts or '{}')
  except Exception:opts={}
 return bool(settings.get('assembly_show_purchased') or opts.get('assembly_show'))

def assembly_picture(rev,parts,folder):
 """Isometric of the assembly as drawn: only the components that belong on the assembly drawing.
 Returns (image path or None, number of omitted purchased part types)."""
 from . import db
 import trimesh
 folder=Path(folder)
 try:settings=db.project_settings(rev['project_id'])
 except Exception:settings={}
 shown=[p for p in parts if shows_on_assembly(p,settings)]
 omitted=sum(1 for p in parts if not p.get('excluded') and p.get('category')=='purchased' and p not in shown)
 if not omitted and (folder/'assembly.png').exists():return folder/'assembly.png',0
 instances=json.loads((folder/'instances.json').read_text()) if (folder/'instances.json').exists() else {}
 meshes=[];colors=[]
 for p in shown:
  f=folder/'parts'/p['id']/'model.glb'
  if not f.exists():continue
  try:me=trimesh.load(f,force='mesh')
  except Exception:continue
  for inst in instances.get(p['id']) or [{'matrix':np.eye(4).tolist()}]:meshes.append((me,np.array(inst['matrix'])));colors.append(thumb_color(p))
 if not meshes:return None,omitted
 out=folder/'assembly-drawing.png'
 render_meshes(meshes,out,colors=colors)
 return out,omitted

def assembly_pdf(rev,parts,fits,folder,detailed=True):
 from . import db
 class AssemblyCanvas(canvas.Canvas):
  def showPage(self):
   txt(self,20,12,'RELEASED' if rev.get('status')=='released' else 'DRAFT - ENGINEERING REVIEW - NOT FOR MANUFACTURE',9);super().showPage()
 folder=Path(folder);c=AssemblyCanvas(str(folder/'assembly.pdf'),pagesize=(420*mm,297*mm));txt(c,20,276,'FORGE / ASSEMBLY & MATING RECORD',17);txt(c,20,266,f"Revision {rev['number']} | {rev['filename']} | {rev['status'].upper()}",9)
 picture,omitted=assembly_picture(rev,parts,folder)
 if picture:c.drawImage(str(picture),20*mm,57*mm,260*mm,195*mm,preserveAspectRatio=True,anchor='c')
 if omitted:txt(c,20,50,f"{omitted} purchased part{'s' if omitted!=1 else ''} not shown in this view (bought-in items appear only when enabled in project settings or per part).",8)
 txt(c,290,244,'Assembly controls',12);wrap(c,290,232,'Assembly pose is imported from STEP. Candidate mating surfaces require engineer verification. Nominal diameter difference is not an approved fit.',100,9)
 wrap(c,290,202,'Record toleranced limits, torque, assembly sequence, lubrication and retention in each mating record. Source changes invalidate previous approvals.',100,9)
 txt(c,20,25,'Isometric from actual tessellated geometry. Use released detail drawings for manufacture; do not scale this view.',8);c.showPage()
 for offset in range(0,max(1,len(fits)),12):
  txt(c,20,278,'MATING / FIT SCHEDULE',15);y=264
  for f in fits[offset:offset+12]:
   a=f['data'];txt(c,20,y,f"{a.get('label',f['id'][:8])} | {'APPROVED' if f['approved'] else 'REVIEW REQUIRED'}",10);y-=5
   y=wrap(c,20,y,f"{a.get('part_a_name',a.get('part_a',''))} / {a.get('feature_a','')} <-> {a.get('part_b_name',a.get('part_b',''))} / {a.get('feature_b','')}",375,8)
   y=wrap(c,20,y,f"Nominal diametral clearance: {a.get('nominal_clearance','not computed')} mm | Fit: {a.get('fit','UNSPECIFIED')} | Assembly: {a.get('instructions','UNSPECIFIED')} | Torque: {a.get('torque','UNSPECIFIED')}",375,8)-6
  if not fits:txt(c,20,250,'No geometric mating candidates detected. Add and verify assembly interfaces manually.',10)
  c.showPage()
 # Individual mating sheets show the actual two bodies in their assembly poses.
 instances=json.loads((folder/'instances.json').read_text()) if (folder/'instances.json').exists() else {}
 import trimesh
 lookup={p['id']:p for p in parts}
 pairdoc=ezdxf.new('R2013');pairdoc.units=4;pm=pairdoc.modelspace()
 from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
 from OCP.gp import gp_Trsf
 for index,fit in enumerate(fits if detailed else []):
  d=fit['data'];pair=[];shapes=[]
  for key,letter in [('part_a','a'),('part_b','b')]:
   pid=d.get(key);pf=folder/'parts'/str(pid)
   if pid not in lookup or not (pf/'model.glb').exists():continue
   T=np.array(d.get('matrix_'+letter) or (instances.get(pid) or [{'matrix':np.eye(4).tolist()}])[0]['matrix'])
   loaded=trimesh.load(pf/'model.glb',force='mesh');pair.append((loaded,T));tr=gp_Trsf();tr.SetValues(*T[:3,:4].flatten().tolist());shapes.append(BRepBuilderAPI_Transform(read_brep(pf/'shape.brep'),tr,True).Shape())
  if len(pair)!=2:continue
  image=folder/('mating-'+fit['id']+'.png');render_meshes(pair,image)
  txt(c,20,278,'MATING DRAWING / '+d.get('label',fit['id'][:8]),15);txt(c,20,267,f"Revision {rev['number']} | {'APPROVED INTERFACE' if fit['approved'] else 'CANDIDATE - VERIFY'}",9)
  c.drawImage(str(image),20*mm,65*mm,240*mm,190*mm,preserveAspectRatio=True,anchor='c')
  y=249
  for label,value in [('A / bore body',lookup[d['part_a']]['name']),('B / shaft body',lookup[d['part_b']]['name']),('Feature',d.get('feature_a','')),('Fit',d.get('fit') or 'UNSPECIFIED'),('Nominal clearance',str(d.get('nominal_clearance','not computed'))+' mm'),('Bore limits',str(d.get('hole_min','?'))+' to '+str(d.get('hole_max','?'))+' mm'),('Shaft limits',str(d.get('shaft_min','?'))+' to '+str(d.get('shaft_max','?'))+' mm'),('Clearance limits',str(d.get('min_clearance','?'))+' to '+str(d.get('max_clearance','?'))+' mm'),('Torque',d.get('torque') or 'UNSPECIFIED'),('Assembly method',d.get('instructions') or 'UNSPECIFIED')]:
   txt(c,270,y,label.upper(),7);y=wrap(c,270,y-5,value,125,9)-7
  txt(c,20,30,'Actual imported assembly poses; assembly orientation and axial position require engineer verification.',8);txt(c,20,23,'Use toleranced released part drawings. Nominal clearance alone does not establish a fit class or assembly method.',8);c.showPage()
  # Vector mating drawing in model-space, one separated panel per interface.
  vv=[projections(shape)['iso'] for shape in shapes];allpoints=np.array([pt for v in vv for seg in v['visible'] for pt in seg]);lo=allpoints.min(0);hi=allpoints.max(0);span=max(hi-lo);offset=np.array([0,index*max(1000,span*2)])-lo
  for j,v in enumerate(vv):
   for seg in v['visible']:pm.add_lwpolyline((np.array(seg)+offset).tolist(),dxfattribs={'color':3 if j==0 else 7})
  pm.add_text(d.get('label','Mating')+' / '+(d.get('fit') or 'FIT UNSPECIFIED'),dxfattribs={'height':max(2,span/60),'insert':(offset+lo+np.array([0,-20])).tolist()})
 pairdoc.saveas(folder/'assembly.dxf')
 c.save()
