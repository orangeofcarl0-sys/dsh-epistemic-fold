"""A supervised trial that blocks SYNCHRONOUSLY, so asyncio cannot cancel it."""
import json, os, sys, time
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'eval' / 'bridge'))
os.environ.setdefault('EF_LIVE_BASE_URL', 'http://127.0.0.1:1')
os.environ.setdefault('EF_LIVE_API_KEY', 'keyless')
os.environ.setdefault('EF_LIVE_MODEL', 'fake-model')
os.environ.setdefault('EF_TAU2_BUNDLE_ROOT', str(ROOT / 'ef-phase7-logs' / '.watchdog-bundles'))
from ef_bridge_client import EpistemicFoldBridge
bridge = EpistemicFoldBridge(arm='economy', bundle_root=str(ROOT / 'ef-phase7-logs' / '.watchdog'),
                             domain='lhtb', task_id='watchdog')
# The identity the supervisor must own, published BEFORE the block.
print(json.dumps({'bridgePid': bridge._proc.pid}), flush=True)
# A synchronous read on the bridge's stdout. Nothing was sent, so nothing arrives: this is the
# blocking IPC the in-process watchdog could not interrupt, and `time.sleep` would be the same
# shape -- the point is that no coroutine can run while it waits.
bridge._proc.stdout.readline()
time.sleep(600)