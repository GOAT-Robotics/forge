"""One CAD job in an isolated Droplet.

The worker receives no DigitalOcean or Spaces credential.  It can download one
short-lived input bundle and upload one result bundle through pre-signed URLs.
"""
import base64,json,os,shutil,sys,tempfile,zipfile
from pathlib import Path
import httpx

def _safe_extract(archive,destination):
 root=destination.resolve()
 with zipfile.ZipFile(archive) as z:
  for member in z.infolist():
   target=(root/member.filename).resolve()
   if target!=root and root not in target.parents:raise ValueError('Unsafe job bundle')
  z.extractall(root)

def _post(post,path):
 with open(path,'rb') as body:
  response=httpx.post(post['url'],data=post['fields'],files={'file':('result.zip',body,'application/zip')},timeout=180)
  response.raise_for_status()

def main():
 config=json.loads(base64.b64decode(os.environ['FORGE_EPHEMERAL_CONFIG']).decode())
 work=Path(tempfile.mkdtemp(prefix='forge-ephemeral-'))
 try:
  input_zip=work/'input.zip'
  with httpx.stream('GET',config['input_url'],timeout=180) as response:
   response.raise_for_status()
   with input_zip.open('wb') as output:
    for chunk in response.iter_bytes():output.write(chunk)
  data=work/'data';data.mkdir();_safe_extract(input_zip,data)
  os.environ['DATA_DIR']=str(data)
  # Import only after DATA_DIR is set: db.py resolves its root at import time.
  from .worker import run_once
  if not run_once():raise RuntimeError('The dispatched job was not queued in its isolated database')
  result=work/'result.zip'
  with zipfile.ZipFile(result,'w',zipfile.ZIP_DEFLATED) as z:
   z.write(data/'forge.sqlite','forge.sqlite')
   revision=data/'revisions'/config['revision_id']
   for path in revision.rglob('*'):
    if path.is_file():z.write(path,path.relative_to(data))
  _post(config['result_post'],result)
 finally:
  shutil.rmtree(work,ignore_errors=True)

if __name__=='__main__':
 try:main()
 finally:pass
