from .db import DEFAULT_RULES
STANDARDS=[{'code':'ISO 128-1:2020','topic':'Technical drawing representation','url':'https://www.iso.org/standard/65296.html'}, {'code':'ISO 5457:1999 + Amd 1:2010','topic':'Drawing sheet layout','url':'https://www.iso.org/standard/29017.html'}, {'code':'ISO 7200:2004','topic':'Title block fields','url':'https://www.iso.org/standard/35446.html'}, {'code':'ISO 129-1:2018','topic':'Dimension presentation','url':'https://www.iso.org/standard/64007.html'}]
MANUAL_CHECKS={'load_strength':'Strength, load cases, fatigue and stability','functional_gdt':'Functional dimensions, datums, fits and GD&T','threads':'Thread type, pitch, engagement and depths','process_tooling':'Tool access, stock, fixtures, deburring and process capability','assembly':'Fasteners, torque, sequence and mating verification','coating':'Coating thickness, masking and final-fit effects'}
def evaluate(g,s,rules=None):
 r={**DEFAULT_RULES,**(rules or {})};out=[]
 def add(code,severity,title,detail,feature=None):
  waiver=s.get('rule_waivers',{}).get(code+(':'+feature if feature else ''))
  out.append({'code':code,'severity':severity,'title':title,'detail':detail,'feature':feature,'waiver':waiver or None,'source':'Configured workshop rule' if code.startswith('DFM') else 'Geometry / workflow check'})
 if not g.get('valid'):add('GEO001','blocker','Invalid CAD solid','Repair the source solid before downstream manufacturing.')
 if g.get('category')=='sheet_metal' and g.get('flat_status')!='supported':add('FLAT001','blocker','Flat pattern needs engineering','Unfolding is not supported or failed validation for this topology; do not use a projected outline as a blank.')
 for field in ['material','process','general_tolerance','finish','datums']:
  if not str(s.get(field,'')).strip():add('SPEC_'+field,'blocker',field.replace('_',' ').title()+' unspecified','Enter the approved value, or explicitly document not applicable.')
 if g.get('bends') and not s.get('k_factor_approved'):add('BEND_K','blocker','Bend allowance is provisional','Approve the K factor against the material, thickness and actual press tooling.')
 for h in g.get('holes',[]):
  d=h['diameter'];th=g.get('thickness',0)
  if d<r['min_hole_diameter']:add('DFM001','warning','Small bore',f"Diameter {d:.3f} mm below configured {r['min_hole_diameter']} mm.",h['id'])
  if g.get('category')=='sheet_metal' and th and d<th*r['min_sheet_hole_ratio']:add('DFM002','warning','Hole smaller than sheet rule',f'Diameter / thickness = {d/th:.2f}.',h['id'])
  if h.get('edge_web') is not None and th and h['edge_web']<th*r['min_edge_web_ratio']:add('DFM003','warning','Hole close to outside edge',f"Measured projected edge web {h['edge_web']:.3f} mm.",h['id'])
  if h['depth']/max(d,.001)>r['max_drill_aspect']:add('DFM004','warning','Deep bore / tooling review',f"Depth-to-diameter ratio {h['depth']/d:.1f}.",h['id'])
 for b in g.get('bends',[]):
  if b['radius']/max(g.get('thickness',1),.001)<r['min_bend_radius_ratio']:add('DFM005','warning','Tight bend radius',f"Inside radius {b['radius']:.3f} mm; confirm forming capability.",b['id'])
 for code,title in MANUAL_CHECKS.items():
  if not s.get('manual_checks',{}).get(code):add('REVIEW_'+code,'blocker',title,'Requires an engineer verification record; not established by STEP geometry.')
 return out
