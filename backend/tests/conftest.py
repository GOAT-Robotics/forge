import os,tempfile,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
os.environ['DATA_DIR']=tempfile.mkdtemp(prefix='forge-tests-')
os.environ.setdefault('ALLOWED_EMAIL_DOMAINS','example.com,example.test')
os.environ.setdefault('FORGE_DRAWING_WORKERS','2')
