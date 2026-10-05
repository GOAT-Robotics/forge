import sys
import time
import pytest
from app.job_timeout import run_bounded


def test_timeout_stops_job_and_allows_next_job():
    started = time.monotonic()
    # A descendant inherits the process group; it must not hold up the next job.
    command = [sys.executable, '-c', 'import subprocess,time,sys; subprocess.Popen([sys.executable,"-c","import time; time.sleep(30)"]); time.sleep(30)']
    with pytest.raises(TimeoutError, match='was stopped'):
        run_bounded(command, .2)
    assert time.monotonic() - started < 3
    run_bounded([sys.executable, '-c', 'print("next job completed")'], 3)


def test_worker_failure_preserves_error():
    with pytest.raises(RuntimeError, match='drawing failed'):
        run_bounded([sys.executable, '-c', 'raise ValueError("drawing failed")'], 3)


def test_timed_out_job_fails_and_queue_continues(tmp_path, monkeypatch):
    from app import db, worker, job_timeout
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    db.init()
    with db.connect() as c:
        c.execute('INSERT INTO projects(id,name,description,created,rules) VALUES(?,?,?,?,?)', ('p','Test','',db.now(),'{}'))
        c.execute('INSERT INTO revisions(id,project_id,number,filename,sha256,state,status,created,created_by,progress,message) VALUES(?,?,?,?,?,?,?,?,?,?,?)', ('r','p',1,'t.step','s','active','ready',db.now(),'test',100,'Documents generated'))
        for ident in ('first','second'):
            c.execute('INSERT INTO jobs(id,revision_id,kind,status,created,payload) VALUES(?,?,?,?,?,?)',(ident,'r','documents','queued',ident,'{}'))
    attempts = []
    def execute(command, timeout, env=None):
        assert db.row('SELECT progress FROM revisions WHERE id="r"')['progress'] == 0
        assert env['DATA_DIR'] == str(tmp_path)
        attempts.append(command[-1])
        if len(attempts) == 1:
            raise TimeoutError('Document generation timed out')
    monkeypatch.setattr(job_timeout, 'run_bounded', execute)
    assert worker.run_once()
    assert db.row('SELECT status,error FROM jobs WHERE id="first"') == {'status':'failed','error':'Document generation timed out'}
    assert worker.run_once()
    assert db.row('SELECT status FROM jobs WHERE id="second"')['status'] == 'complete'
    assert db.row('SELECT progress FROM revisions WHERE id="r"')['progress'] == 100
