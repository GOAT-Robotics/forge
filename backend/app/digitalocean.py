"""Minimal DigitalOcean Droplet client for short-lived CAD runners."""
import os
import httpx

API='https://api.digitalocean.com/v2'

def configured():
 return bool(os.getenv('DO_TOKEN') and os.getenv('DO_WORKER_IMAGE') and os.getenv('DO_WORKER_REGION'))

def _headers():
 token=os.getenv('DO_TOKEN')
 if not token:raise RuntimeError('DO_TOKEN is required for ephemeral CAD workers')
 return {'Authorization':f'Bearer {token}','Content-Type':'application/json'}

def create(name,user_data,tags):
 """Create an Ubuntu runner. user_data has only expiring object capabilities."""
 body={'name':name,'region':os.environ['DO_WORKER_REGION'],'size':os.getenv('DO_WORKER_SIZE','s-4vcpu-8gb'),'image':os.getenv('DO_WORKER_BASE_IMAGE','ubuntu-24-04-x64'),'monitoring':True,'tags':tags,'user_data':user_data}
 with httpx.Client(timeout=30) as client:
  response=client.post(API+'/droplets',headers=_headers(),json=body);response.raise_for_status()
 return str(response.json()['droplet']['id'])

def delete(droplet_id):
 if not droplet_id:return
 with httpx.Client(timeout=30) as client:
  response=client.delete(API+'/droplets/'+str(droplet_id),headers=_headers())
  if response.status_code not in (204,404):response.raise_for_status()
