import json,io
from fastapi.testclient import TestClient
from app.main import app
from app import db
from app.worker import run_once
from app.cad import BRepTools
from test_geometry import plate

def test_end_to_end_revision_vendor_release_and_qc(tmp_path):
 with TestClient(app) as client:
  h={'X-Forge-Request':'1'}
  assert client.get('/api/projects').status_code==401
  assert client.post('/api/auth/setup',json={'email':'test@example.com','name':'Test Engineer','password':'fixture-password-123'}).status_code==200
  assert client.post('/api/auth/setup',json={'email':'two@example.com','name':'Two','password':'fixture-password-123'}).status_code==409
  assert client.post('/api/auth/login',json={'email':'test@example.com','password':'fixture-password-123'}).status_code==200
  assert client.post('/api/projects',json={'name':'Unauthorized CSRF'}).status_code==403
  p=client.post('/api/projects',headers=h,json={'name':'Integration fixture','description':'Synthetic test model'}).json();pid=p['id'];source=tmp_path/'fixture.brep';BRepTools.Write_s(plate(),str(source))
  def upload():return client.post(f'/api/projects/{pid}/revisions',headers=h,files={'file':('fixture.brep',source.read_bytes())}).json()
  r=upload();assert r['number']==1;assert run_once();rev=client.get('/api/revisions/'+r['id']).json();assert rev['status']=='ready',rev;assert len(rev['parts'])==1;part=rev['parts'][0]
  assert client.post(f'/api/revisions/{r["id"]}/release',headers=h).status_code==409
  assert client.post(f'/api/revisions/{r["id"]}/documents',headers=h,json={'release':True}).status_code==422
  share=client.post(f'/api/revisions/{r["id"]}/shares',headers=h,json={'label':'Fixture vendor','days':1}).json();token=share['path'].split('token=')[1]
  vendor=TestClient(app);vh={'Authorization':'Bearer '+token,'X-Forge-Request':'1'}
  assert vendor.get('/api/revisions/'+r['id'],headers=vh).status_code==200
  assert vendor.get('/api/projects',headers=vh).status_code==401
  assert vendor.post('/api/revisions/'+r['id']+'/comments',headers=vh,json={'body':'Check H001 diameter','part_id':part['id'],'feature':'H001'}).status_code==200
  assert vendor.patch('/api/parts/'+part['id'],headers=vh,json={'spec':part['spec'],'category':'machining'}).status_code==403
  spec=part['spec'];spec.update({'material':'Test material','process':'Laser','finish':'Deburred','datums':'A = bottom; B = left; C = front','general_tolerance':'Fixture tolerance','manual_checks':{k:'Verified against synthetic test fixture' for k in ['load_strength','functional_gdt','threads','process_tooling','assembly','coating']},'feature_specs':{'H001':{'designation':'6 mm through bore','lower':5.9,'upper':6.1}}})
  assert client.patch('/api/parts/'+part['id'],headers=h,json={'spec':spec,'category':'sheet_metal','reviewed':True}).status_code==200
  check=client.get('/api/revisions/'+r['id']+'/release-check').json();assert check['can_release'],check
  assert client.post('/api/revisions/'+r['id']+'/release',headers=h).status_code==200;assert client.get('/api/parts/'+part['id']+'/assets/drawing.pdf').status_code==409;assert run_once();rev=client.get('/api/revisions/'+r['id']).json();assert rev['status']=='released',rev
  assert client.get('/api/parts/'+part['id']+'/assets/drawing.pdf').status_code==200
  assert client.post('/api/revisions/'+r['id']+'/documents',headers=h,json={}).status_code==409
  assert client.get('/api/parts/'+part['id']+'/assets/../../forge.sqlite').status_code!=200
  assert client.patch('/api/parts/'+part['id'],headers=h,json={'spec':spec,'category':'machining','reviewed':True}).status_code==409
  q={'part_id':part['id'],'feature':'H001','serial':'TEST-001','nominal':6,'lower_limit':5.9,'upper_limit':6.1,'measured':6.05,'instrument':'CALIPER-001','unit':'mm','notes':'Fixture'}
  assert client.post('/api/revisions/'+r['id']+'/qc',headers=h,json=q).json()['result']=='PASS'
  q['measured']=6.2;assert client.post('/api/revisions/'+r['id']+'/qc',headers=h,json=q).json()['result']=='FAIL'
  exported=client.get('/api/revisions/'+r['id']+'/qc.csv');assert exported.status_code==200;assert 'PASS' in exported.text and 'FAIL' in exported.text
  q['upper_limit']=6.5;assert client.post('/api/revisions/'+r['id']+'/qc',headers=h,json=q).status_code==422
  bad=client.post(f'/api/projects/{pid}/revisions',headers=h,files={'file':('bad.step',b'not a step file '*10)}).json();assert run_once();assert client.get('/api/revisions/'+bad['id']).json()['status']=='failed';assert client.get('/api/revisions/'+r['id']).json()['state']=='active'
  r2=upload();assert run_once();assert client.get('/api/revisions/'+r['id']).json()['state']=='archived';assert client.get('/api/revisions/'+r2['id']).json()['state']=='active'
  assert vendor.get('/api/revisions/'+r2['id'],headers=vh).status_code==403
  assert client.delete('/api/shares/'+share['id'],headers=h).status_code==200;assert vendor.get('/api/revisions/'+r['id'],headers=vh).status_code==403
