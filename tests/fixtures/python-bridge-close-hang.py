"""
Case B: the child is ALIVE and keeps stdout open, but does not answer `op:"close"`.

`closeIgnored` in the lifecycle fixture monkeypatches `_send` to a no-op, which proves only case A --
that `close()` proceeds when `_send` returns or raises. It cannot show what happens when `_send`
actually WAITS on a live child, because the wait never happens in it.

Here the real `_send` runs, against a real child process that reads stdin and answers nothing. The
production read timeout (1200s) is left in force, so if `close()` waits on the handshake the elapsed
time says so. The caller is expected to run this under a watchdog: the point is that the fixture
reports the elapsed time rather than the harness hanging.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'eval' / 'bridge'))

os.environ.setdefault('EF_LIVE_BASE_URL', 'http://127.0.0.1:1')
os.environ.setdefault('EF_LIVE_API_KEY', 'keyless')
os.environ.setdefault('EF_LIVE_MODEL', 'fake-model')
os.environ.setdefault('EF_TAU2_BUNDLE_ROOT', str(ROOT / 'ef-phase7-logs' / '.close-hang-bundles'))

import ef_bridge_client as client  # noqa: E402

STUB = ROOT / 'tests' / 'fixtures' / 'silent-bridge-child.py'
real_popen = client.subprocess.Popen


def fake_popen(*args, **kwargs):
    """Spawn the SILENT child wherever the client wanted the real bridge."""
    return real_popen([sys.executable, str(STUB)], stdin=subprocess.PIPE,
                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)


client.subprocess.Popen = fake_popen
bridge = client.EpistemicFoldBridge(arm='economy', bundle_root=str(ROOT / 'ef-phase7-logs' / '.close-hang'),
                                   domain='lhtb', task_id='close-hang')
pid = bridge._proc.pid
# The production default stays in force; nothing is shortened to make the point.
read_timeout = bridge._read_timeout_sec
started = time.monotonic()
bridge.close()
elapsed = time.monotonic() - started
print(json.dumps({
    'childPid': pid,
    'readTimeoutSec': read_timeout,
    'closeElapsedSec': round(elapsed, 2),
    'reaped': bridge._proc.poll() is not None,
    'boundedUnder15s': elapsed < 15,
}))