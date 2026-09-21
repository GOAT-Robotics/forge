from pathlib import Path
import json,math,io,csv,zipfile
import numpy as np
import ezdxf
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
from reportlab.pdfbase.pdfmetrics import stringWidth
from PIL import Image,ImageDraw
from .cad import projections,read_brep
from .rules import evaluate,STANDARDS

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

def frame(c,p,revision,sheet,scale='NTS'):
 g=p['geometry'];s=p['spec'];c.setStrokeColorRGB(.1,.14,.14);c.setLineWidth(.25*mm);c.rect(20*mm,10*mm,390*mm,277*mm)
 txt(c,25,278,'FORGE  /  '+p['name'][:100],12);txt(c,25,271,f"{p['id'].upper()} | REV {revision['number']} | {p['category'].replace('_',' ').upper()}",8)
 ln(c,20,265,410,265);ln(c,20,47,410,47)
 txt(c,25,40,f"Material: {s.get('material') or 'UNSPECIFIED'}{(' | Stock: '+s['stock']) if s.get('stock') else ''} | Process: {s.get('process') or 'UNSPECIFIED'}"[:150],8)
 colour=(s.get('coating_color') or s.get('coating_hex') or '')
 txt(c,25,34,f"Finish: {s.get('finish') or 'UNSPECIFIED'} | Coating: {s.get('paint') or 'not specified'}{(' | Colour: '+colour) if colour else ''}{(' | '+s['coating_thickness']) if s.get('coating_thickness') else ''}"[:150],8)
 if s.get('coating_hex') and len(s['coating_hex'])==7:
  try:
   c.setFillColorRGB(*[int(s['coating_hex'][i:i+2],16)/255 for i in (1,3,5)]);c.rect(322*mm,32.5*mm,12*mm,5*mm,stroke=1,fill=1);c.setFillColorRGB(0,0,0)
  except ValueError:pass
 txt(c,25,28,f"General tolerance: {s.get('general_tolerance') or 'UNSPECIFIED'}{(' | Ra: '+s['roughness']) if s.get('roughness') else ''} | Units: mm | Third-angle projection | Scale: {scale}",8)
 txt(c,25,22,'ISO drawing conventions template; standards conformance requires an engineering check.',7)
 status='RELEASED' if revision.get('status')=='released' else 'DRAFT - ENGINEERING REVIEW - NOT FOR MANUFACTURE'
 if p.get('excluded'):status='NOT FOR PRODUCTION - EXCLUDED FROM THIS REVISION'+((' - '+p['exclusion_reason']) if p.get('exclusion_reason') else '')
 txt(c,25,16,status[:150],9);txt(c,340,40,f"QTY {p['quantity']} | SHEET {sheet}",8)
 txt(c,340,34,f"{revision['sha256'][:16]}",7)

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
def part_sheets(c,p,rev,folder,rules,vs):
 """Draw every sheet of one part onto canvas c (used for the per-part PDF and the combined category PDFs)."""
 folder=Path(folder);g=p['geometry'];spec=p['spec'];frame(c,p,rev,1)
 holes=g.get('holes',[]);axes=AXES;normals=NORMALS
 for key,box in [('top',(24,164,190,96)),('front',(24,53,190,99)),('right',(215,53,190,99)),('iso',(215,164,190,96))]:
  hs=[h for h in holes if abs(h['axis'][normals.get(key,2)])>.999] if key!='iso' else []
  view(c,vs[key],box,key.upper()+' VIEW',hs[:22],axes.get(key,(0,1)),key!='iso')
 c.showPage();sheet=2
 # Large feature sets get dedicated numbered maps, so every hole appears in a labeled drawing.
 for start in range(0,len(holes),12):
  chunk=holes[start:start+12];frame(c,p,rev,sheet);sheet+=1
  main=max(['top','front','right'],key=lambda k:sum(abs(h['axis'][normals[k]])>.999 for h in chunk))
  view(c,vs[main],(25,52,235,205),'HOLE IDENTIFICATION MAP',chunk,axes[main])
  txt(c,267,252,'FEATURE SCHEDULE / mm',9);y=243
  for h in chunk:
   hs=spec.get('feature_specs',{}).get(h['id'],{});txt(c,267,y,f"{h['id']}  DIA {h['diameter']:.3f}  L {h['depth']:.3f}",8)
   txt(c,267,y-3.6,'XYZ '+', '.join(f'{x:.2f}' for x in h['center']),6.5)
   label=hs.get('designation') or 'Bore; thread/depth interpretation unconfirmed';txt(c,267,y-7,label[:74],6.5)
   txt(c,267,y-10.4,f"QC limits: {hs.get('lower','not set')} to {hs.get('upper','not set')} mm",6.5);y-=16
  c.showPage()
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
 for start in range(0,max(1,len(checks)),16):
  frame(c,p,rev,sheet);sheet+=1;txt(c,25,254,'DESIGN RULES & RELEASE RECORD',11);y=244
  for ch in checks[start:start+16]:
   y=wrap(c,25,y,f"{ch['code']} {ch.get('feature') or ''} | {ch['severity'].upper()} | {ch['title']}",size=8)
   y=wrap(c,29,y,ch['detail']+((' | Disposition: '+ch['waiver']) if ch['waiver'] else ''),370,7)-2
  if not checks:txt(c,25,y,'Configured automated checks and recorded manual checks have no open findings.',9)
  c.showPage()
 if g.get('flat_status')=='supported':
  flat=json.loads((folder/'flat.json').read_text());frame(c,p,rev,sheet);txt(c,25,254,'DEVELOPED SHEET & FORMED ISOMETRIC',11)
  fv={'visible':[flat['outline']]+flat['holes'],'hidden':[]};view(c,fv,(25,64,238,177),'FLAT PATTERN - '+('APPROVED K' if spec.get('k_factor_approved') else 'PROVISIONAL K'))
  view(c,vs['iso'],(268,113,134,120),'FORMED ISOMETRIC',dims=False)
  lo,hi=vb(fv);scale=min((238-32)/max((hi-lo)[0],1),(177-26)/max((hi-lo)[1],1));o=np.array([25+238/2,64+177/2])-(hi+lo)/2*scale
  for b in flat['bends']:
   a=np.array(b['a'])*scale+o;z=np.array(b['b'])*scale+o;c.setDash(2*mm,1*mm);c.setStrokeColorRGB(.75,.3,.05);ln(c,*a,*z);c.setDash();c.setStrokeColorRGB(.1,.14,.14)
   mid=(a+z)/2;d=(z-a);ang=math.degrees(math.atan2(d[1],d[0]))
   if ang>90 or ang<-90:ang+=180
   label=f"{b['id']}  {b['angle']:.1f} deg  {b.get('direction','').upper()}";c.saveState();c.translate(mid[0]*mm,mid[1]*mm);c.rotate(ang);c.setFont('Helvetica',6.5);tw=stringWidth(label,'Helvetica',6.5);c.setFillColorRGB(1,1,1);c.rect(-tw/2-1.5,-2.2,tw+3,7,stroke=0,fill=1);c.setFillColorRGB(.75,.3,.05);c.drawString(-tw/2,0,label);c.restoreState();c.setFillColorRGB(0,0,0)
  # Bend table: everything the brake operator needs, next to the formed isometric.
  x0=268;y=99;txt(c,x0,y+7,'BEND TABLE',9)
  cols=[(x0,'ID'),(x0+13,'ANGLE'),(x0+31,'INSIDE R'),(x0+50,'DIR'),(x0+63,'BA'),(x0+80,'LINE L'),(x0+100,'FLANGE / NOTE')]
  for cx,ct in cols:txt(c,cx,y,ct,6.5)
  ln(c,x0,y-1.2,x0+135,y-1.2);y-=5
  for b in flat['bends'][:12]:
   for cx,val in [(x0,b['id']),(x0+13,f"{b['angle']:.1f}"),(x0+31,f"{b['radius']:.2f}"),(x0+50,b.get('direction','?').upper()),(x0+63,f"{b['allowance']:.2f}"),(x0+80,f"{b.get('length',0):.1f}"),(x0+100,'Bend to inside R; check springback')]:txt(c,cx,y,val,6.5)
   y-=4.2
  if len(flat['bends'])>12:txt(c,x0,y,f"+{len(flat['bends'])-12} more bends listed on the specification sheet",6.5);y-=4.2
  y-=3;txt(c,x0,y,f"Thickness {g['thickness']:.3f} mm  |  K factor {spec.get('k_factor',.4)} ({'approved' if spec.get('k_factor_approved') else 'PROVISIONAL'})  |  BA = bend allowance along the neutral axis",6.5);y-=4
  txt(c,x0,y,'UP = flange folds toward the viewer of this flat (root skin outward); DOWN = away. Angles are included bend angles.',6.5);y-=4
  txt(c,x0,y,'Bend sequence and tooling (V-die, punch radius) to be confirmed by the press shop before cutting blanks.',6.5)
  c.showPage()

def make_part(p,rev,folder,rules,combined=None):
 """Write drawing.pdf, drawing.dxf, part.step and projections.json for one part; optionally also append
 the same sheets to a combined category canvas."""
 folder=Path(folder);folder.mkdir(exist_ok=True,parents=True);g=p['geometry'];holes=g.get('holes',[]);axes=AXES;normals=NORMALS;vs=projections(read_brep(folder/'shape.brep'));(folder/'projections.json').write_text(json.dumps(vs))
 from OCP.STEPControl import STEPControl_Writer,STEPControl_AsIs
 writer=STEPControl_Writer();writer.Transfer(read_brep(folder/'shape.brep'),STEPControl_AsIs);writer.Write(str(folder/'part.step'))
 c=canvas.Canvas(str(folder/'drawing.pdf'),pagesize=(420*mm,297*mm));c.setTitle(p['name']);part_sheets(c,p,rev,folder,rules,vs);c.save()
 if combined is not None:part_sheets(combined,p,rev,folder,rules,vs)
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
   for p1,p2,base,angle in [(lo, np.array([hi[0],lo[1]]),lo-np.array([0,h*4]),0),(lo,np.array([lo[0],hi[1]]),lo-np.array([h*4,0]),90)]:
    dim=m.add_linear_dim(base=(base+o).tolist(),p1=(p1+o).tolist(),p2=(p2+o).tolist(),angle=angle,dimstyle='EZDXF',override={'dimtxt':h,'dimasz':h*.7,'dimdec':3,'dimpost':'<> REF'});dim.render()
 m.add_text('DRAFT / mm / curves sampled 0.025 mm / NOT CAM / see paired PDF',dxfattribs={'height':max(2,span/90),'insert':(0,-gap),'layer':'NOTES'})
 d.saveas(folder/'drawing.dxf')

CATEGORY_COLORS={'machining':'#aeb4bc','sheet_metal':'#9db0bd','purchased':'#7c838c','other':'#b3ada2'}
def thumb_color(p):
 hexcol=str(p.get('spec',{}).get('coating_hex') or '')
 return hexcol if len(hexcol)==7 and hexcol.startswith('#') else CATEGORY_COLORS.get(p.get('category',''),'#aeb4bc')
def combined_canvas(path,title,rev,parts):
 """Start a combined drawing set: cover/index page listing every part that follows."""
 c=canvas.Canvas(str(path),pagesize=(420*mm,297*mm));c.setTitle(title)
 c.setStrokeColorRGB(.1,.14,.14);c.setLineWidth(.25*mm);c.rect(20*mm,10*mm,390*mm,277*mm)
 txt(c,25,276,'FORGE  /  '+title.upper(),14);txt(c,25,268,f"Revision {rev['number']} | {rev['filename']} | {rev['status'].upper()} | {len(parts)} parts | Sheets follow in the order below; each part restarts at sheet 1",8)
 ln(c,20,262,410,262);y=252
 cols=[(25,'#'),(33,'PART'),(150,'QTY'),(163,'CATEGORY'),(190,'MATERIAL'),(262,'FINISH / COATING'),(340,'COLOUR'),(372,'BORES'),(386,'BENDS'),(398,'REV')]
 for x,t in cols:txt(c,x,y,t,7)
 ln(c,25,y-1.5,405,y-1.5);y-=6
 for i,p in enumerate(parts,1):
  if y<22:c.showPage();c.rect(20*mm,10*mm,390*mm,277*mm);y=270
  s=p['spec'];g=p['geometry']
  for x,t in [(25,str(i)),(33,p['name'][:60]),(150,str(p['quantity'])),(163,p['category'].replace('_',' ')),(190,(s.get('material') or 'UNSPECIFIED')[:38]),(262,((s.get('finish') or '')+(' / '+s['paint'] if s.get('paint') else ''))[:42] or 'UNSPECIFIED'),(340,(s.get('coating_color') or '-')[:18]),(372,str(len(g.get('holes',[])))),(386,str(len(g.get('bends',[])))),(398,str(rev['number']))]:txt(c,x,y,t,7)
  y-=5
 txt(c,25,16,'RELEASED' if rev.get('status')=='released' else 'DRAFT - ENGINEERING REVIEW - NOT FOR MANUFACTURE',9);c.showPage();return c

def render_meshes(meshes,path,size=(1600,1050),colors=None):
 """Raster isometric of actual mesh triangles, used for assembly documentation and part thumbnails."""
 from PIL import Image,ImageDraw
 R=np.array([[.707,.707,0],[-.408,.408,.816],[.577,-.577,.577]])
 W,H=size;margin=int(min(W,H)*.04)
 polygons=[];depths=[];indices=[];colors=colors or ['#98aaa4','#c8d3bc','#d7c8b5','#a8b8c8','#b5c6ac'];allp=[];normals=[]
 for i,(mesh,T) in enumerate(meshes):
  v=np.c_[mesh.vertices,np.ones(len(mesh.vertices))]@T.T;v=(v[:,:3]@R.T).astype(np.float32);allp.append(v)
  tri=v[mesh.faces];polygons.append(tri[:,:,:2]);depths.append(tri[:,:,2].mean(axis=1));indices.append(np.full(len(tri),i%len(colors),dtype=np.uint8))
  n=np.cross(tri[:,1]-tri[:,0],tri[:,2]-tri[:,0]);n/=np.maximum(np.linalg.norm(n,axis=1,keepdims=True),1e-9);normals.append(np.abs(n@np.array([-.35,.45,.82])))
 allp=np.vstack(allp);lo=allp[:,:2].min(0);hi=allp[:,:2].max(0);scale=min((W-2*margin)/max(hi[0]-lo[0],1),(H-2*margin)/max(hi[1]-lo[1],1));im=Image.new('RGB',(W,H),'white');draw=ImageDraw.Draw(im)
 polygons=np.concatenate(polygons);span=(hi-lo)*scale;offset=np.array([(W-span[0])/2,(H-span[1])/2]);polygons=(polygons-lo)*scale+offset;polygons[:,:,1]=H-polygons[:,:,1];depths=np.concatenate(depths);indices=np.concatenate(indices);normals=np.concatenate(normals)
 def shade(hexcol,k):
  r,g,b=int(hexcol[1:3],16),int(hexcol[3:5],16),int(hexcol[5:7],16);f=.5+.6*min(1,k);return (min(255,int(r*f)),min(255,int(g*f)),min(255,int(b*f)))
 for i in np.argsort(depths):draw.polygon([tuple(v) for v in polygons[i]],fill=shade(colors[indices[i]],normals[i]))
 im.save(path)

def assembly_pdf(rev,parts,fits,folder,detailed=True):
 from . import db
 class AssemblyCanvas(canvas.Canvas):
  def showPage(self):
   txt(self,20,12,'RELEASED' if rev.get('status')=='released' else 'DRAFT - ENGINEERING REVIEW - NOT FOR MANUFACTURE',9);super().showPage()
 folder=Path(folder);c=AssemblyCanvas(str(folder/'assembly.pdf'),pagesize=(420*mm,297*mm));txt(c,20,276,'FORGE / ASSEMBLY & MATING RECORD',17);txt(c,20,266,f"Revision {rev['number']} | {rev['filename']} | {rev['status'].upper()}",9)
 if (folder/'assembly.png').exists():c.drawImage(str(folder/'assembly.png'),20*mm,57*mm,260*mm,195*mm,preserveAspectRatio=True,anchor='c')
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
