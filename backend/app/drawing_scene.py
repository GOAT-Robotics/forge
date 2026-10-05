"""Editable drawing presentation. Source geometry is immutable; only layout/text are saved.

The same vector scene renders in SVG and in PDF. Edits never rewrite the STEP,
feature geometry, inspection limits or engineering specifications.
"""
import contextlib,hashlib,io,json,math,re
from reportlab.pdfgen import canvas
from reportlab.pdfbase.pdfmetrics import stringWidth
from . import fonts as _fonts  # noqa: F401  registers ForgeDim so saved scenes replay in any process


def color(value):
 if hasattr(value,'red'):return [value.red,value.green,value.blue]
 return list(value or (0,0,0))[:3]

class SceneCanvas(canvas.Canvas):
 def __init__(self,*args,**kwargs):
  super().__init__(*args,**kwargs);self.pages=[];self.groups=[];self.stack=[];self.serial=0
 def begin_group(self,id,kind,**meta):
  group={'id':id,'kind':kind,'nodes':[],**meta}
  if self.stack:group['parent']=self.stack[-1]['id']
  self.groups.append(group);self.stack.append(group)
 def end_group(self):self.stack.pop()
 def setDash(self,array=[],phase=0):
  # reportlab writes the dash operator but does not keep it; the scene needs it to replay hidden/centre lines
  self._forge_dash=[float(x) for x in (array if isinstance(array,(list,tuple)) else [array])] if array else []
  super().setDash(array,phase)
 def saveState(self):
  self._dash_stack=getattr(self,'_dash_stack',[])+[getattr(self,'_forge_dash',[])];super().saveState()
 def restoreState(self):
  st=getattr(self,'_dash_stack',[])
  if st:self._forge_dash=st.pop()
  super().restoreState()
 def record(self,node):
  node.update(matrix=list(self._currentMatrix),stroke=color(self._strokeColorObj),fill=color(self._fillColorObj),width=self._lineWidth,dash=list(getattr(self,'_forge_dash',[])))
  if self.stack:self.stack[-1]['nodes'].append(node)
  else:
   self.serial+=1;self.groups.append({'id':f'fixed:{len(self.pages)}:{self.serial}','kind':'fixed','nodes':[node]})
 def line(self,x1,y1,x2,y2):
  self.record({'type':'path','commands':[['M',x1,y1],['L',x2,y2]],'doStroke':True,'doFill':False});super().line(x1,y1,x2,y2)
 def rect(self,x,y,width,height,stroke=1,fill=0):
  self.record({'type':'path','commands':[['M',x,y],['L',x+width,y],['L',x+width,y+height],['L',x,y+height],['Z']],'doStroke':bool(stroke),'doFill':bool(fill)})
  super().rect(x,y,width,height,stroke,fill)
 def circle(self,x,y,r,stroke=1,fill=0):self.ellipse(x-r,y-r,x+r,y+r,stroke,fill)
 def ellipse(self,x1,y1,x2,y2,stroke=1,fill=0):
  rx=(x2-x1)/2;ry=(y2-y1)/2;cx=(x1+x2)/2;cy=(y1+y2)/2;k=.5522847498
  p=self.beginPath();p.moveTo(cx+rx,cy)
  p.curveTo(cx+rx,cy+k*ry,cx+k*rx,cy+ry,cx,cy+ry)
  p.curveTo(cx-k*rx,cy+ry,cx-rx,cy+k*ry,cx-rx,cy)
  p.curveTo(cx-rx,cy-k*ry,cx-k*rx,cy-ry,cx,cy-ry)
  p.curveTo(cx+k*rx,cy-ry,cx+rx,cy-k*ry,cx+rx,cy);p.close();self.drawPath(p,stroke,fill)
 def drawImage(self,image,x,y,width=None,height=None,*args,**kwargs):
  # rendered pictorials: kept in the scene (base64 JPEG) so the editor and every PDF replay show them
  data=getattr(image,'_forge_bytes',None)
  if data is None and hasattr(image,'fp'):
   try:image.fp.seek(0);data=image.fp.read()
   except Exception:data=None
  if data:
   import base64
   self.record({'type':'image','commands':[['M',x,y],['L',x+width,y],['L',x+width,y+height],['L',x,y+height],['Z']],'doStroke':False,'doFill':False,'x':x,'y':y,'w':width,'h':height,'data':base64.b64encode(data).decode(),'mime':'image/jpeg' if data[:2]==b'\xff\xd8' else 'image/png'})
  return super().drawImage(image,x,y,width,height,*args,**kwargs)
 def drawPath(self,path,stroke=1,fill=0,fillMode=None):
  tokens=path.getCode().split();values=[];commands=[]
  for token in tokens:
   if token in ('m','l','c'):commands.append([{'m':'M','l':'L','c':'C'}[token],*values]);values=[]
   elif token=='h':commands.append(['Z'])
   elif token=='n':pass
   else:values.append(float(token))
  self.record({'type':'path','commands':commands,'doStroke':bool(stroke),'doFill':bool(fill)})
  super().drawPath(path,stroke,fill,fillMode)
 def drawString(self,x,y,text,*args,**kwargs):
  self.record({'type':'text','x':x,'y':y,'text':str(text),'size':self._fontsize,'font':self._fontname});super().drawString(x,y,text,*args,**kwargs)
 def drawRightString(self,x,y,text,*args,**kwargs):self.drawString(x-stringWidth(str(text),self._fontname,self._fontsize),y,text,*args,**kwargs)
 def drawCentredString(self,x,y,text,*args,**kwargs):self.drawString(x-stringWidth(str(text),self._fontname,self._fontsize)/2,y,text,*args,**kwargs)
 def showPage(self):
  self.pages.append({'width':self._pagesize[0],'height':self._pagesize[1],'groups':self.groups});self.groups=[];self.serial=0
  super().showPage()
 def scene(self,source_hash):
  data={'version':1,'source_hash':source_hash,'pages':self.pages}
  unique_group_ids(data)
  data['scene_hash']=hashlib.sha256(json.dumps(data,sort_keys=True).encode()).hexdigest()
  return data

def unique_group_ids(scene):
 """Every sheet is drawn with the same view ids ('view:main' on the part sheet and on the flat-pattern sheet):
 later duplicates get a 'p<sheet>:' prefix (parents follow), so an id names exactly one group in the drawing."""
 seen=set()
 for i,page in enumerate(scene.get('pages',[])):
  ids={g['id'] for g in page['groups']};ren={x:f'p{i}:{x}' for x in ids if x in seen}
  if ren:
   page['groups']=[{**g,'id':ren.get(g['id'],g['id']),**({'parent':ren.get(g['parent'],g['parent'])} if g.get('parent') else {})} for g in page['groups']]
  seen|={g['id'] for g in page['groups']}
 return scene


@contextlib.contextmanager
def group(c,id,kind,**metadata):
 if hasattr(c,'begin_group'):c.begin_group(id,kind,**metadata)
 try:yield
 finally:
  if hasattr(c,'end_group'):c.end_group()


def group_offset(g,groups,edits):
 dx=dy=0;seen=set()
 while g and g['id'] not in seen:
  seen.add(g['id']);e=edits.get(g['id'],{});dx+=e.get('dx',0);dy+=e.get('dy',0);g=groups.get(g.get('parent'))
 return dx,dy


def annotation(g,edit):
 lines=edit.get('text', '\n'.join(g['lines'])).splitlines() or ['']
 size=g.get('size',7.5);x,y,_,top=g['bounds'];width=max(stringWidth(line,'Helvetica',size) for line in lines)+6
 return lines,[x,top-len(lines)*10-3,x+width,top],size


def replay_node(c,n):
 c.saveState();c.transform(*n['matrix']);c.setStrokeColorRGB(*n['stroke']);c.setFillColorRGB(*n['fill']);c.setLineWidth(n['width']);c.setDash(n.get('dash',[]))
 if n['type']=='image':
  import base64
  from reportlab.lib.utils import ImageReader
  c.drawImage(ImageReader(io.BytesIO(base64.b64decode(n['data']))),n['x'],n['y'],n['w'],n['h'])
 elif n['type']=='text':
  from reportlab.pdfbase.pdfmetrics import getRegisteredFontNames,standardFonts
  font=n['font'] if n['font'] in getRegisteredFontNames() or n['font'] in standardFonts else 'Helvetica'
  c.setFont(font,n['size']);c.drawString(n['x'],n['y'],n['text'])
 else:
  p=c.beginPath()
  for op,*v in n['commands']:
   if op=='M':p.moveTo(*v)
   elif op=='L':p.lineTo(*v)
   elif op=='C':p.curveTo(*v)
   elif op=='Z':p.close()
  c.drawPath(p,stroke=int(n['doStroke']),fill=int(n['doFill']))
 c.restoreState()


def is_hidden_line(n):
 """A hidden-detail edge: the two-element dash of the HIDDEN layer (centre/bend lines use a 4-element chain)."""
 return n.get('type')=='path' and len(n.get('dash') or [])==2


def is_hidden(g,groups,objects):
 seen=set()
 while g and g['id'] not in seen:
  seen.add(g['id'])
  if objects.get(g['id'],{}).get('hidden'):return True
  g=groups.get(g.get('parent'))
 return False


MM=72/25.4
def view_transform(v):
 """Placed pictorial view: model-mm polylines -> sheet points about the view centre (scale, in-plane rotation)."""
 lo,hi=v['lo'],v['hi'];mx,my=(lo[0]+hi[0])/2,(lo[1]+hi[1])/2;k=v['scale']*MM
 t=math.radians(v.get('roll',0) or 0);ct,st=math.cos(t),math.sin(t)
 def f(x,y):
  x,y=(x-mx)*k,(y-my)*k
  return v['cx']+x*ct-y*st,v['cy']+x*st+y*ct
 return f


def paint_view(c,v):
 f=view_transform(v)
 c.saveState();c.setStrokeColorRGB(0,0,0);c.setLineWidth(.25*MM);c.setDash([]);c.setLineJoin(1)
 for line in v.get('lines',[]):
  if len(line)<2:continue
  p=c.beginPath();p.moveTo(*f(*line[0]))
  for q in line[1:]:p.lineTo(*f(*q))
  c.drawPath(p,stroke=1,fill=0)
 if v.get('caption') and v.get('label'):
  pts=[f(*q) for line in v.get('lines',[]) for q in (line[0],line[-1])] or [(v['cx'],v['cy'])]
  y=min(q[1] for q in pts)-5*MM;c.setFont('Helvetica',8);c.setFillColorRGB(0,0,0)
  text=f"{v['label'].upper()}  ({scale_text(v['scale'])})";c.drawString(v['cx']-stringWidth(text,'Helvetica',8)/2,y,text)
 c.restoreState()


def scale_text(s):
 return f'{s:g}:1' if s>=1 else f'1:{round(1/s,2):g}'


def render_scene(scene,edits=None,target=None,c=None,balloons=None):
 edits=edits or {};own=c is None
 order=page_order(scene,edits.get('page_order'))
 if own:c=canvas.Canvas(target or io.BytesIO(),pagesize=(scene['pages'][order[0]]['width'],scene['pages'][order[0]]['height']))
 objects=edits.get('objects',{});placement=placements(scene,objects)
 for position,page_index in enumerate(order):
  page=scene['pages'][page_index]
  c.setPageSize((page['width'],page['height']))  # sheets may mix A4/A3
  for g,groups in placement.get(page_index,[]):
   e=objects.get(g['id'],{});dx,dy=group_offset(g,groups,objects)
   if g['kind']=='fixed':
    c.saveState()
    for n in g['nodes']:replay_node(c,renumber(n,position+1,len(order)))
    c.restoreState();continue
   if is_hidden(g,groups,edits.get('objects',{})):continue
   if g['kind']=='callout' and g.get('style')=='goat':
    # Template leader note: arrow stays on the feature (moves with its view), text/shoulder move with the note.
    from .sheet import paint_callout
    parent=groups.get(g.get('parent'));px,py=group_offset(parent,groups,edits.get('objects',{})) if parent else (0,0)
    paint_callout(c,g,e.get('text','\n'.join(g['lines'])).splitlines(),dx,dy,px,py,flip=bool(e.get('flip')))
   elif g['kind']=='dim':
    from .sheet import paint_dim
    parent=groups.get(g.get('parent'));px,py=group_offset(parent,groups,objects) if parent else (0,0)
    c.saveState();c.translate(px,py);paint_dim(c,g,e.get('text'),e.get('dx',0),e.get('dy',0),e.get('size',1.0));c.restoreState()
   elif g['kind']=='callout':
    lines,bounds,size=annotation(g,e);x0,y0,x1,y1=bounds
    # Moving a view moves its features; moving a callout moves only the text.
    parent=groups.get(g.get('parent'));px,py=group_offset(parent,groups,edits.get('objects',{})) if parent else (0,0)
    ax,ay=g['anchor'];ax+=px;ay+=py;ex=max(x0+dx,min(ax,x1+dx));ey=max(y0+dy,min(ay,y1+dy))
    c.setStrokeColorRGB(0,0,0);c.setFillColorRGB(0,0,0);c.setLineWidth(.4);c.line(ax,ay,ex,ey)
    length=math.hypot(ex-ax,ey-ay)
    if length>1:
     ux,uy=(ex-ax)/length,(ey-ay)/length
     if e.get('flip'):
      ext=4.5*72/25.4;c.line(ax,ay,ax-ux*ext,ay-uy*ext);ux,uy=-ux,-uy
     # 3 mm long, 1.8 mm wide; match the editable canvas marker.
     head,half_width=3*72/25.4,.9*72/25.4
     p=c.beginPath();p.moveTo(ax,ay);p.lineTo(ax+ux*head-uy*half_width,ay+uy*head+ux*half_width);p.lineTo(ax+ux*head+uy*half_width,ay+uy*head-ux*half_width);p.close();c.drawPath(p,stroke=0,fill=1)
    c.setFont('Helvetica',size)
    for i,line in enumerate(lines):c.drawString(x0+dx+3,y1+dy-8.5-i*10,line)
   else:
    c.saveState();c.translate(dx,dy)
    # hidden (dashed) edges behind the visible faces can be switched off per view; centre lines stay
    no_hidden=g['kind']=='view' and e.get('hidden_lines') is False
    for n in g['nodes']:
     if no_hidden and is_hidden_line(n):continue
     replay_node(c,n)
    c.restoreState()
  for v in edits.get('views',[]):
   if v['page']==page_index:paint_view(c,v)
  for d in edits.get('details',[]):
   if view_page(scene,d,objects)==page_index:paint_detail_marker(c,d,scene,edits)
   if d['target_page']==page_index:paint_detail(c,d,scene,edits)
  if balloons:
   from .inspection import paint_balloons
   paint_balloons(c,[b for b in balloons if balloon_page(scene,b,objects)==page_index],{g['id']:g for pg in scene['pages'] for g in pg['groups']},objects)
  for note in edits.get('notes',[]):
   if note['page']!=page_index:continue
   c.setFont('Helvetica',note.get('size',9));c.setFillColorRGB(0,0,0)
   for i,line in enumerate(note['text'].splitlines()):c.drawString(note['x'],note['y']-i*12,line)
  c.showPage()
 if own:c.save()


VIEW_KEYS={'id','page','cx','cy','scale','azimuth','elevation','roll','label','caption'}
def validate_views(scene,views):
 """Pictorial views dropped on the sheet in the editor (their projected lines are attached by the server)."""
 if not isinstance(views,list) or len(views)>24:raise ValueError('At most 24 placed pictorial views')
 out=[];ids=set()
 for v in views:
  if not isinstance(v,dict) or set(v)-VIEW_KEYS-{'lines','lo','hi'}:raise ValueError('Unsupported pictorial view field')
  if not isinstance(v.get('id'),str) or not 0<len(v['id'])<=80 or v['id'] in ids:raise ValueError('Invalid pictorial view id')
  ids.add(v['id'])
  if not isinstance(v.get('page'),int) or not 0<=v['page']<len(scene['pages']):raise ValueError('Invalid sheet')
  for k,lo,hi in (('cx',-2000,4000),('cy',-2000,4000),('scale',.01,20),('azimuth',-360,360),('elevation',-89.5,89.5),('roll',-360,360)):
   x=v.get(k,0 if k=='roll' else None)
   if not isinstance(x,(int,float)) or isinstance(x,bool) or not math.isfinite(x) or not lo<=x<=hi:raise ValueError(f'Invalid pictorial view {k}')
  label=v.get('label','')
  if not isinstance(label,str) or len(label)>80:raise ValueError('Invalid pictorial view name')
  out.append({k:v[k] for k in VIEW_KEYS if k in v}|{'roll':v.get('roll',0),'label':label,'caption':bool(v.get('caption'))})
 return out


SHEET_RE=re.compile(r'^(SHEET\s*:\s*)\d+(\s+OF\s+)\d+')
def renumber(n,no,total):
 """Title block 'SHEET : n OF m' follows the sheet's position in the (reordered, extended) set."""
 if n['type']=='text' and SHEET_RE.match(n['text']):return {**n,'text':SHEET_RE.sub(lambda m:f'{m.group(1)}{no}{m.group(2)}{total}',n['text'])}
 return n


def root_of(g,groups):
 seen=set()
 while g.get('parent') in groups and g['id'] not in seen:seen.add(g['id']);g=groups[g['parent']]
 return g


def placements(scene,objects):
 """{sheet index: [(group, groups of its source sheet)]}: a view moved to another sheet takes its dimensions
 and callouts with it."""
 out={}
 for i,page in enumerate(scene['pages']):
  groups={g['id']:g for g in page['groups']}
  for g in page['groups']:
   r=root_of(g,groups);target=objects.get(r['id'],{}).get('page') if r['kind']=='view' else None
   target=target if isinstance(target,int) and 0<=target<len(scene['pages']) else i
   out.setdefault(target,[]).append((g,groups))
 return out


def balloon_page(scene,b,objects):
 """Sheet a balloon is shown on: the sheet its view was moved to, else where it was generated."""
 if b.get('sg') and b['page']<len(scene['pages']):
  groups={g['id']:g for g in scene['pages'][b['page']]['groups']}
  g=groups.get(f"p{b['page']}:{b['sg']}") or groups.get(b['sg'])
  if g:
   t=objects.get(root_of(g,groups)['id'],{}).get('page')
   if isinstance(t,int) and 0<=t<len(scene['pages']):return t
 return b['page']


def view_page(scene,d,objects):
 t=objects.get(d.get('view'),{}).get('page')
 return t if isinstance(t,int) and 0<=t<len(scene['pages']) else d['page']


def page_order(scene,order):
 n=len(scene['pages'])
 if isinstance(order,list) and sorted(order)==list(range(n)):return list(order)
 return list(range(n))


# ---------------------------------------------------------------- detail views (ISO 128-3 / ASME Y14.3)
# A circle on the parent view names the detail ("A"); the enlarged view shows only the part geometry in that
# circle, at a standard enlargement scale, labelled "DETAIL A (2:1)" relative to the sheet scale.
DETAIL_SCALES=(1.5,2,2.5,3,4,5,8,10)
DETAIL_KEYS={'id','label','page','view','x','y','r','scale','target_page','cx','cy'}
def geometry_nodes(g):
 # visible (thick) and hidden/centre (dashed) outlines; dimension and note lines are thin and solid
 return [n for n in g['nodes'] if n['type']=='path' and (n['width']>=.6 or n.get('dash'))]


def paint_detail_marker(c,d,scene=None,edits=None):
 if scene is not None:
  groups={g['id']:g for g in scene['pages'][d['page']]['groups']}
  ox,oy=group_offset(groups.get(d['view']),groups,(edits or {}).get('objects',{}))
  d={**d,'x':d['x']+ox,'y':d['y']+oy}
 c.saveState();c.setStrokeColorRGB(0,0,0);c.setFillColorRGB(0,0,0);c.setLineWidth(.35*MM*.5);c.setDash([])
 c.circle(d['x'],d['y'],d['r'],stroke=1,fill=0)
 lx,ly=d['x']+d['r']*.72+1.5*MM,d['y']+d['r']*.72+1.5*MM
 c.setFont('Helvetica-Bold',3.5*MM);c.drawString(lx,ly,d['label'])
 c.restoreState()


def apply_matrix(m,x,y):return m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]


def node_anchor(n):
 if n['type']=='text':return apply_matrix(n['matrix'],n['x'],n['y'])
 pts=[apply_matrix(n['matrix'],v[i],v[i+1]) for op,*v in n['commands'] if op!='Z' for i in range(0,len(v)-1,2)]
 return (sum(p[0] for p in pts)/len(pts),sum(p[1] for p in pts)/len(pts)) if pts else (0,0)


def is_ground(n):return n['type']=='path' and n.get('doFill') and not n.get('doStroke') and list(n.get('fill',[0,0,0]))[:3]==[1,1,1]


def detail_plan(d,view,children,objects):
 """What an ISO detail view shows: the view's lines enlarged and clipped to the circle; dimension values,
 tags, arrowheads and hole callouts whose feature lies in the circle, moved with the enlargement but kept at
 drawing text size. Returns (scaled nodes, [(node, dx, dy)], [(callout group, dx, dy, px, py)])."""
 k=d['scale'];R=d['r']*k
 T=lambda x,y:(d['cx']+k*(x-d['x']),d['cy']+k*(y-d['y']))
 inside=lambda x,y:(x-d['x'])**2+(y-d['y'])**2<=(d['r']*1.02)**2
 scaled=[];moved=[];shift=None
 nodes=view['nodes']+[n for g in children if g.get('kind')=='dim' and not objects.get(g['id'],{}).get('hidden') for n in g['nodes']]
 for i,n in enumerate(nodes):
  if n['type']=='path' and not n.get('doFill'):
   scaled.append(n);shift=None;continue
  if is_ground(n):
   nxt=next((m for m in nodes[i+1:i+3] if m['type']=='text'),None)
   ax,ay=node_anchor(nxt) if nxt else node_anchor(n)
   shift=(T(ax,ay)[0]-ax,T(ax,ay)[1]-ay) if inside(ax,ay) else None
   if shift:moved.append((n,)+shift)
   continue
  if n['type']=='text' and shift is not None:
   moved.append((n,)+shift);continue
  ax,ay=node_anchor(n);shift=None
  if inside(ax,ay):
   tx,ty=T(ax,ay);moved.append((n,tx-ax,ty-ay))
 calls=[]
 for g in children:
  if g.get('style')!='goat':continue
  cx,cy=g['center']
  if not inside(cx,cy):continue
  e=objects.get(g['id'],{});qx=(g['bounds'][0]+e.get('dx',0));qy=g['shoulder_y']+e.get('dy',0)
  px,py=T(cx,cy)[0]-cx,T(cx,cy)[1]-cy;dx,dy=T(qx,qy)[0]-qx+e.get('dx',0),T(qx,qy)[1]-qy+e.get('dy',0)
  calls.append((g,dx,dy,px,py))
 return scaled,moved,calls


def paint_detail(c,d,scene,edits):
 page=scene['pages'][d['page']] if d['page']<len(scene['pages']) else None
 if page is None:return
 groups={g['id']:g for g in page['groups']}
 view=groups.get(d['view'])
 if not view:return
 objects=edits.get('objects',{})
 k=d['scale'];R=d['r']*k
 children=[g for g in page['groups'] if g.get('parent')==view['id'] and not objects.get(g['id'],{}).get('hidden')]
 scaled,moved,calls=detail_plan(d,view,children,objects)
 c.saveState();c.setFillColorRGB(1,1,1);c.circle(d['cx'],d['cy'],R,stroke=0,fill=1);c.restoreState()
 c.saveState()
 p=c.beginPath();p.circle(d['cx'],d['cy'],R);c.clipPath(p,stroke=0,fill=0)
 c.translate(d['cx'],d['cy']);c.scale(k,k);c.translate(-d['x'],-d['y'])  # (x, y): circle centre in the view's own coordinates
 for n in scaled:
  m=dict(n);m['width']=n['width']/k;m['dash']=[x/k for x in n.get('dash') or []]  # ISO line weights and dashes stay
  replay_node(c,m)
 c.restoreState()
 for n,dx,dy in moved:
  c.saveState();c.translate(dx,dy);replay_node(c,n);c.restoreState()
 from .sheet import paint_callout
 for g,dx,dy,px,py in calls:
  text=objects.get(g['id'],{}).get('text')
  paint_callout(c,{**g,'radius':g.get('radius',0)*k},(text if text is not None else '\n'.join(g['lines'])).splitlines(),dx,dy,px,py,flip=bool(objects.get(g['id'],{}).get('flip')))
 c.saveState();c.setStrokeColorRGB(0,0,0);c.setLineWidth(.35*MM*.5);c.setDash([]);c.circle(d['cx'],d['cy'],R,stroke=1,fill=0)
 base=(view.get('scale_used') or (scene.get('frame') or {}).get('scale') or 1)*k
 text=f"DETAIL {d['label']} ({scale_text(base)})";c.setFont('Helvetica',3.5*MM*.72);c.setFillColorRGB(0,0,0)
 c.drawString(d['cx']-stringWidth(text,'Helvetica',3.5*MM*.72)/2,d['cy']-R-5*MM,text)
 c.restoreState()


def validate_details(scene,details):
 if not isinstance(details,list) or len(details)>12:raise ValueError('At most 12 detail views')
 out=[];labels=set()
 for d in details:
  if not isinstance(d,dict) or set(d)-DETAIL_KEYS:raise ValueError('Unsupported detail view field')
  for k in ('page','target_page'):
   if not isinstance(d.get(k),int) or not 0<=d[k]<len(scene['pages']):raise ValueError('Invalid sheet for detail view')
  groups={g['id']:g for g in scene['pages'][d['page']]['groups']}
  if groups.get(d.get('view'),{}).get('kind')!='view':raise ValueError('A detail view must enlarge a drawing view')
  label=d.get('label')
  if not isinstance(label,str) or not re_label(label) or label in labels:raise ValueError('Detail labels must be unique capital letters')
  labels.add(label)
  sc=d.get('scale')
  if not isinstance(sc,(int,float)) or isinstance(sc,bool) or not math.isfinite(sc) or not 1.05<=sc<=20:raise ValueError('Detail enlargement must be between 105 % and 2000 %')
  for k,lo,hi in (('x',0,4000),('y',0,4000),('r',3,400),('cx',0,4000),('cy',0,4000)):
   v=d.get(k)
   if not isinstance(v,(int,float)) or isinstance(v,bool) or not math.isfinite(v) or not lo<=v<=hi:raise ValueError(f'Invalid detail view {k}')
  out.append({k:d[k] for k in DETAIL_KEYS if k in d}|{'id':str(d.get('id') or label)[:40]})
 return out


def re_label(s):
 import re
 return bool(re.fullmatch(r'[A-HJ-NP-Z]{1,2}',s))  # I and O are not used (ISO 128-3)


def validate_edits(scene,objects,notes):
 groups={g['id']:g for page in scene['pages'] for g in page['groups']};out={}
 for id,edit in objects.items():
  g=groups.get(id)
  if not g or g['kind'] not in ('view','callout','dim'):raise ValueError('Only drawing views, dimensions and callouts can be edited')
  if set(edit)-{'dx','dy','text','hidden','page','hidden_lines','flip','size'}:raise ValueError('Unsupported drawing edit')
  if 'size' in edit and (g['kind']!='dim' or not isinstance(edit['size'],(int,float)) or isinstance(edit['size'],bool) or not .5<=edit['size']<=3):raise ValueError('Dimension text size must be 50-300 %')
  if g['kind']=='dim' and 'text' in edit and (not isinstance(edit['text'],str) or len(edit['text'])>80 or '\n' in edit['text']):raise ValueError('Dimension text must be one line of at most 80 characters')
  if 'flip' in edit and (g['kind']!='callout' or not isinstance(edit['flip'],bool)):raise ValueError('Only callout arrows can be flipped')
  if 'hidden_lines' in edit and (g['kind']!='view' or not isinstance(edit['hidden_lines'],bool)):raise ValueError('Hidden lines can only be switched on views')
  if 'page' in edit and (g['kind']!='view' or g.get('parent') or not isinstance(edit['page'],int) or isinstance(edit['page'],bool) or not 0<=edit['page']<len(scene['pages'])):raise ValueError('Only drawing views can move to another sheet')
  if 'hidden' in edit and not isinstance(edit['hidden'],bool):raise ValueError('Invalid hidden flag')
  if 'text' in edit and g['kind'] not in ('callout','dim'):raise ValueError('STEP geometry is read-only')
  for k in ('dx','dy'):
   v=edit.get(k,0)
   if not isinstance(v,(int,float)) or not math.isfinite(v) or abs(v)>1200:raise ValueError('Invalid position')
  if 'text' in edit:
   text=edit['text']
   if not isinstance(text,str) or len(text)>1200 or len(text.splitlines())>12 or any(len(line)>120 for line in text.splitlines()):raise ValueError('Callout text must fit in 12 lines of 120 characters')
  out[id]=edit
 if len(notes)>100:raise ValueError('Maximum 100 drawing notes')
 for n in notes:
  if set(n)-{'id','page','x','y','size','text'}:raise ValueError('Unsupported note field')
  if not isinstance(n.get('id'),str) or len(n['id'])>80:raise ValueError('Invalid note ID')
  if not isinstance(n.get('page'),int) or not 0<=n['page']<len(scene['pages']):raise ValueError('Invalid sheet')
  if not isinstance(n.get('text'),str) or len(n['text'])>1200 or len(n['text'].splitlines())>12:raise ValueError('Invalid note text')
  if any(not isinstance(n.get(k),(int,float)) or not math.isfinite(n[k]) for k in ('x','y','size')):raise ValueError('Invalid note position')
  if not 5<=n['size']<=24:raise ValueError('Note font size must be 5-24 pt')
  page=scene['pages'][n['page']]
  if not 0<=n['x']<=page['width'] or not 0<=n['y']<=page['height']:raise ValueError('Note must remain on its sheet')
 return {'objects':out,'notes':notes}
