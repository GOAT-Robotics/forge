"""Bound document jobs, including CAD subprocesses and artifact uploads."""
import os
import signal
import subprocess
import tempfile


def run_bounded(command, timeout, env=None):
    # A file avoids pipe deadlocks and unbounded memory use from CAD diagnostic output.
    with tempfile.TemporaryFile() as output:
        proc = subprocess.Popen(command, start_new_session=True, stdout=output, stderr=output, env=env)
        try:
            code = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            raise TimeoutError(f'Document generation exceeded {timeout:g} seconds and was stopped. Retry with fewer parts or increase FORGE_DOCUMENT_TIMEOUT_SECONDS.') from None
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
