"""Saved scenes must replay in a process that never imported the drafting engine (the API's save/export)."""
import json,subprocess,sys
from pathlib import Path
import numpy as np
from test_goat_sheet import block
from app.cad import analyze,BRepTools
from app.drawings import make_part
from app.db import DEFAULT_SPEC


def test_scene_replays_without_drafting_import(tmp_path):
 s=block();g=analyze(s,'ES-MC-009-TEST BLOCK');BRepTools.Write_s(s,str(tmp_path/'shape.brep'))
 p={'id':'t','name':'ES-MC-009-TEST BLOCK','category':'machining','quantity':1,'geometry':g,'spec':dict(DEFAULT_SPEC)}
 make_part(p,{'number':1,'status':'ready','sha256':'x'},tmp_path,{})
 scene=json.loads((tmp_path/'drawing-scene.json').read_text())
 assert any(n.get('font')=='ForgeDim' for pg in scene['pages'] for gr in pg['groups'] for n in gr['nodes'] if n['type']=='text')
 callout=next(gr for pg in scene['pages'] for gr in pg['groups'] if gr['kind']=='callout')
 edits={'objects':{callout['id']:{'dx':15,'dy':-10,'text':'M4 - 6H ↧ 8.00'},'view:main':{'dx':5,'dy':5}},'notes':[]}
 code=("import json,sys;from app.drawing_scene import render_scene,validate_edits;"
       f"s=json.load(open({str(tmp_path/'drawing-scene.json')!r}));e=json.loads(sys.argv[1]);"
       f"render_scene(s,validate_edits(s,e['objects'],e['notes']),target={str(tmp_path/'out.pdf')!r})")
 r=subprocess.run([sys.executable,'-c',code,json.dumps(edits)],cwd=Path(__file__).resolve().parents[1],capture_output=True,text=True)
 assert r.returncode==0,r.stderr[-2000:]
 assert (tmp_path/'out.pdf').stat().st_size>5000
