"""Bound document jobs, including CAD subprocesses and artifact uploads."""
import os
import signal
import subprocess
import tempfile


class JobCancelled(Exception):
    """The user stopped the job; its subprocess group has been killed."""


def run_bounded(command, timeout, env=None, should_stop=None, poll=1.0):
    """Run a job subprocess; stop it on timeout or as soon as `should_stop()` says the user cancelled it."""
    import time
    deadline = time.monotonic() + timeout
    # A file avoids pipe deadlocks and unbounded memory use from CAD diagnostic output.
    with tempfile.TemporaryFile() as output:
        proc = subprocess.Popen(command, start_new_session=True, stdout=output, stderr=output, env=env)
        try:
            while True:
                try:
                    code = proc.wait(timeout=max(.05, min(poll, deadline - time.monotonic())))
                    break
                except subprocess.TimeoutExpired:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(f'Document generation exceeded {timeout:g} seconds and was stopped. Retry with fewer parts or increase FORGE_DOCUMENT_TIMEOUT_SECONDS.') from None
                    if should_stop and should_stop():
                        raise JobCancelled('Cancelled') from None
        finally:
            # Stop the entire group, including forked drawing workers. No writer survives a retry.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
        if code:
            output.seek(0, 2)
            output.seek(max(0, output.tell() - 1000))
            raise RuntimeError(output.read().decode('utf-8', errors='replace').strip() or f'Document worker exited with code {code}')
