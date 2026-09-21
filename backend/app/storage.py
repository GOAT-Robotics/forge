"""Artifact storage abstraction.

The application always has a local working directory while a CAD job runs.  If
Spaces is configured, the source and every completed artifact are mirrored to
the bucket under a revision-specific prefix.  Keeping the working directory is
intentional: OpenCascade and the drawing tools require seekable files and must
never process directly from an object-store stream.
"""
import os
from pathlib import Path


def enabled():
 return bool(os.getenv('S3_BUCKET'))


def _client():
 if not enabled():
  return None
 import boto3
 endpoint=os.getenv('S3_ENDPOINT','https://sfo3.digitaloceanspaces.com')
 return boto3.client('s3',endpoint_url=endpoint,region_name=os.getenv('S3_REGION','sfo3'),aws_access_key_id=os.getenv('S3_ACCESS_KEY'),aws_secret_access_key=os.getenv('S3_SECRET_KEY'))


def key_for(revision_id,relative):
 relative=Path(relative).as_posix().lstrip('/')
 if '..' in Path(relative).parts:raise ValueError('Invalid object key')
 return f"revisions/{revision_id}/{relative}"


def upload(revision_id,path,relative=None):
 """Copy one finished local artifact to the configured Space."""
 if not enabled():return
 path=Path(path);relative=relative or path.name
 # Spaces encrypts objects at rest; unlike AWS S3 it does not accept the
 # x-amz-server-side-encryption header on every compatible endpoint.
 _client().upload_file(str(path),os.environ['S3_BUCKET'],key_for(revision_id,relative))


def sync_revision(revision_id,folder):
 """Mirror source plus generated revision files; excludes SQLite and scratch files."""
 if not enabled():return
 folder=Path(folder)
 for path in folder.rglob('*'):
  if path.is_file() and path.name not in ('forge.sqlite','forge.sqlite-shm','forge.sqlite-wal'):
   upload(revision_id,path,path.relative_to(folder))


def restore(revision_id,relative,destination):
 """Restore an artifact on demand, returning False when it is not in Spaces."""
 if not enabled():return False
 try:
  destination=Path(destination);destination.parent.mkdir(parents=True,exist_ok=True)
  _client().download_file(os.environ['S3_BUCKET'],key_for(revision_id,relative),str(destination))
  return True
 except Exception:
  Path(destination).unlink(missing_ok=True)
  return False


def upload_path(revision_id,path,relative):
 """Upload a private dispatcher/worker artifact below one revision prefix."""
 if not enabled():raise RuntimeError('S3_BUCKET is required for ephemeral CAD workers')
 _client().upload_file(str(path),os.environ['S3_BUCKET'],key_for(revision_id,relative))


def download_path(revision_id,relative,destination):
 if not enabled():return False
 try:
  destination=Path(destination);destination.parent.mkdir(parents=True,exist_ok=True)
  _client().download_file(os.environ['S3_BUCKET'],key_for(revision_id,relative),str(destination))
  return True
 except Exception:
  Path(destination).unlink(missing_ok=True)
  return False


def exists(revision_id,relative):
 if not enabled():return False
 try:
  _client().head_object(Bucket=os.environ['S3_BUCKET'],Key=key_for(revision_id,relative))
  return True
 except Exception:return False


def presigned_get(revision_id,relative,expires=3600):
 if not enabled():raise RuntimeError('S3_BUCKET is required for ephemeral CAD workers')
 return _client().generate_presigned_url('get_object',Params={'Bucket':os.environ['S3_BUCKET'],'Key':key_for(revision_id,relative)},ExpiresIn=expires)


def presigned_post(revision_id,relative,expires=3600):
 """A one-object write capability for a temporary worker, never bucket credentials."""
 if not enabled():raise RuntimeError('S3_BUCKET is required for ephemeral CAD workers')
 return _client().generate_presigned_post(os.environ['S3_BUCKET'],key_for(revision_id,relative),ExpiresIn=expires)


def delete_path(revision_id,relative):
 if enabled():_client().delete_object(Bucket=os.environ['S3_BUCKET'],Key=key_for(revision_id,relative))
