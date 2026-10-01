"""GOAT-template drawing sheets (sheet.py): views, ordinate dimensions, hole callouts, sheet-metal rules, editable DXF."""
import ezdxf
import numpy as np
from reportlab.pdfgen import canvas
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox,BRepPrimAPI_MakeCylinder
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.gp import gp_Pnt,gp_Ax2,gp_Dir
from app.cad import analyze
from app.unfold import unfold
from app import sheet
from test_geometry import plate,bent

REV={'number':3,'status':'ready'}
SETTINGS={'drawing':{'drawn_by':'SANJAY','checked_by':'LOKESH','approved_by':'DHARMARAJ'}}

def block():
 s=BRepPrimAPI_MakeBox(60,45,30).Shape()
 for x,y in [(10,10),(50,10),(10,35),(50,35)]:s=BRepAlgoAPI_Cut(s,BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(x,y,-1),gp_Dir(0,0,1)),3.3/2,11).Shape()).Shape()  # blind from z=-1..10
 s=BRepAlgoAPI_Cut(s,BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(30,22.5,-1),gp_Dir(0,0,1)),4,40).Shape()).Shape()
 return s

def texts(sh):return [it['s'] for it in sh.items if it['k']=='text']

def render(sheets,tmp_path,name):
 c=canvas.Canvas(str(tmp_path/(name+'.pdf')))
 for sh in sheets:sheet.render_pdf(sh,c)
 c.save();sheet.write_dxf(sheets,str(tmp_path/(name+'.dxf')))
 return ezdxf.readfile(tmp_path/(name+'.dxf'))

def test_machined_block_callouts_and_true_scale_dxf(tmp_path):
 s=block();g=analyze(s,'ES-MC-009-TEST BLOCK 1');p={'id':'t1','name':'ES-MC-009-TEST BLOCK 1','category':'machining','quantity':2,'geometry':g,'spec':{'material':'EN8','finish':'ENP'}}
 sheets=sheet.build_sheets(s,p,REV,SETTINGS);assert len(sheets)==1;sh=sheets[0];t=texts(sh)
 assert 'TITLE : ES-MC-009-TEST BLOCK' in t and 'DWG NO : ES-MC-009' in t and 'DRN: SANJAY' in t and 'QTY : 2-NO' in t
 assert any('4 x Ø 3.30 ↧ 10.00' in x for x in t), t
 assert any('Ø 8.00 THRU' in x for x in t)
 assert not any('M4' in x or '6H' in x for x in t)  # threads are never inferred from a bore diameter
 assert sh.overlaps==0
 d=render(sheets,tmp_path,'block');dims=list(d.modelspace().query('DIMENSION'));assert len(dims)>=8
 shown=set()
 for x in dims:
  shown|={t.dxf.text for t in d.blocks.get(x.dxf.geometry) if t.dxftype()=='TEXT'}|{t.text for t in d.blocks.get(x.dxf.geometry) if t.dxftype()=='MTEXT'}
 assert {'60.00','10.00','50.00','45.00','35.00'}<=shown, shown  # DIMLFAC makes scaled paper geometry read true size
 assert d.modelspace().query('MTEXT')

def test_sheet_metal_has_no_hole_details(tmp_path):
 s=plate();g=analyze(s,'SM-01 PLATE');p={'id':'t2','name':'SM-01 PLATE','category':'sheet_metal','quantity':1,'geometry':g,'spec':{'material':'CRCA'}}
 sheets=sheet.build_sheets(s,p,REV,SETTINGS);t=texts(sheets[0])
 assert not any('Ø' in x for x in t if not x.startswith('THREAD')), t
 assert 'MATERIAL: CRCA 2.00 THK' in t and any('LASER CUT' in x for x in t)
 vals={round(d['value'],2) for d in sheets[0].dims if d['axis'] in ('x','y')}
 assert 100.0 in vals and 60.0 in vals and 20.0 not in vals  # hole position (20,20) is not dimensioned
 render(sheets,tmp_path,'plate')

def test_formed_sheet_metal_gets_flat_sheet_with_bend_table(tmp_path):
 s=bent();g=analyze(s,'SM-02 L BRACKET');g['category']='sheet_metal';poly,b=unfold(s,g,.4);g['flat_status']='supported'
 flat={'outline':list(poly.exterior.coords),'holes':[list(r.coords) for r in poly.interiors],'bends':b}
 p={'id':'t3','name':'SM-02 L BRACKET','category':'sheet_metal','quantity':1,'geometry':g,'spec':{'material':'SS304','k_factor':.4}}
 sheets=sheet.build_sheets(s,p,REV,SETTINGS,flat);assert len(sheets)==2;t=texts(sheets[1])
 assert 'TAG' in t and 'INNER R' in t and any(x.startswith('SHEET :') and '2  OF  2' in x for x in t)
 d=render(sheets,tmp_path,'bracket');assert d.modelspace().query('DIMENSION')


def test_pictorial_views_presets_custom_and_overflow_sheet():
 import pytest
 from app import pictorials
 s=block();g=analyze(s,'ES-MC-009-TEST BLOCK');p={'id':'t4','name':'ES-MC-009-TEST BLOCK','category':'machining','quantity':1,'geometry':g,'spec':{}}
 pics=[{'id':'iso','preset':'iso-front-right'},{'id':'back','preset':'iso-back-left'},{'id':'under','preset':'custom','azimuth':200,'elevation':-30,'roll':90,'label':'Underside'},
       {'id':'d1','preset':'dimetric-front-left','scale':2},{'id':'d2','preset':'trimetric-front-right'},{'id':'d3','preset':'iso-below-back-left'}]
 sheets=sheet.build_sheets(s,p,REV,SETTINGS,None,pics)
 groups=set().union(*[set(sh.view_meta) for sh in sheets])
 assert {'view:'+x['id'] for x in pics}<=groups
 assert sheets[0].view_meta['view:iso']['pictorial']=='iso'
 if len(sheets)>1:  # overflow views land on a labelled pictorial sheet, and the sheet count is right on every sheet
  assert any(t.startswith('SHEET :') and f'OF  {len(sheets)}' in t for t in texts(sheets[0]))
 # true isometric direction for the default preset
 d,r=pictorials.frame([0,0,1],[0,1,0],45,pictorials.ISO_EL,0)
 assert np.allclose(np.abs(d),1/np.sqrt(3)) and abs(r@d)<1e-9
 with pytest.raises(ValueError):pictorials.normalize([{'id':'a','preset':'nope'}])
 with pytest.raises(ValueError):pictorials.normalize([{'id':'a','preset':'custom','elevation':120}])
 with pytest.raises(ValueError):pictorials.normalize([{'id':'a'},{'id':'a'}])


def test_angled_bore_is_located_called_out_and_its_angle_dimensioned():
    import math
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakeHalfSpace
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
    from OCP.gp import gp_Pnt, gp_Ax2, gp_Dir, gp_Pln
    s = BRepPrimAPI_MakeBox(30, 13.14, 24.12).Shape()
    a = math.radians(13)
    f = BRepBuilderAPI_MakeFace(gp_Pln(gp_Pnt(0, 0, .8), gp_Dir(0, math.sin(a), -math.cos(a)))).Face()
    s = BRepAlgoAPI_Cut(s, BRepPrimAPI_MakeHalfSpace(f, gp_Pnt(0, 5, -20)).Solid()).Shape()
    b = math.radians(17)
    s = BRepAlgoAPI_Cut(s, BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(15, 11.5, -2), gp_Dir(0, -math.sin(b), math.cos(b))), 1.65, 40).Shape()).Shape()
    g = analyze(s, 'MOUNT'); p = {'id': 'rs', 'name': 'MOUNT', 'category': 'machining', 'quantity': 2, 'geometry': g, 'spec': {}}
    sh = sheet.build_sheets(s, p, REV, SETTINGS)[0]; t = texts(sh)
    assert any('3.30' in x and 'THRU' in x for x in t + [l for c in sh.callouts.values() for l in c['lines']])
    assert '17°' in t and '13°' in t           # drilling angle and the sloped base
    assert '15.00' in t                       # the bore's entry point is located
    assert any(it['k'] == 'poly' and it['layer'] == 'CENTER' for it in sh.items)
    assert sheet.drawing_collisions(sh)['text_text'] == 0


def test_flat_blank_shows_sheet_thickness():
    s = bent(); g = analyze(s, 'BRACKET'); poly, b = unfold(s, g, .4)
    flat = {'outline': list(poly.exterior.coords), 'holes': [list(r.coords) for r in poly.interiors], 'bends': b}
    p = {'id': 'b', 'name': 'BRACKET', 'category': 'sheet_metal', 'quantity': 1, 'geometry': g, 'spec': {'k_factor': .4}}
    sheets = sheet.build_sheets(s, p, REV, SETTINGS, flat)
    assert f"THK {g['thickness']:.2f}" in texts(sheets[1])
