"""
Keyless lifecycle fault injection for the LHTB bridge child process.

Every case tracks the SPECIFIC `Popen` handle this fixture created -- never a global search for
`node.exe` -- so a pass cannot be manufactured by killing somebody else's process, and a leftover is
attributed to the fixture that made it.

Prints one JSON object on the last line. No provider is contacted beyond 127.0.0.1: the bridge is
constructed (which is what starts the child) and closed; no model call is ever made.
"""

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'eval' / 'lhtb'))
sys.path.insert(0, str(ROOT / 'eval' / 'bridge'))

TMP = Path(tempfile.mkdtemp(prefix='ef-lifecycle-'))
os.environ.setdefault('EF_LIVE_BASE_URL', 'http://127.0.0.1:1')
os.environ.setdefault('EF_LIVE_API_KEY', 'keyless')
os.environ.setdefault('EF_LIVE_MODEL', 'fake-model')
os.environ.setdefault('EF_TAU2_BUNDLE_ROOT', str(TMP / 'bundles'))
os.environ.setdefault('EF_LHTB_BUNDLE_ROOT', str(TMP / 'bundles'))

from ef_bridge_client import EpistemicFoldBridge  # noqa: E402


def spawn_bridge(tag: str) -> EpistemicFoldBridge:
    return EpistemicFoldBridge(arm='economy', bundle_root=str(TMP / tag),
                               domain='lhtb', task_id=tag)


def case_normal_close() -> dict:
    """The documented path: `op:"close"`, then the child must be reaped."""
    b = spawn_bridge('normal')
    pid = b._proc.pid
    b.close()
    return {'pid': pid, 'exitCode': b._proc.poll(), 'reaped': b._proc.poll() is not None,
            'idempotentSecondClose': (b.close() or True)}


def case_close_ignored() -> dict:
    """The host never answers `op:"close"`, so terminate/kill has to bound the wait."""
    b = spawn_bridge('ignored')
    pid = b._proc.pid
    # Make the handshake unreachable WITHOUT touching the child: the request never leaves.
    b._send = lambda request: None
    started = time.monotonic()
    b.close()
    elapsed = time.monotonic() - started
    return {'pid': pid, 'elapsedSec': round(elapsed, 2),
            'reaped': b._proc.poll() is not None, 'boundedUnder15s': elapsed < 15}


def case_episode_raises() -> dict:
    """An exception inside the episode must still close the bridge -- the fix under test."""
    from ef_lhtb_agent import EFLhtbAgent

    class Ctx:
        metadata = {}

    agent = EFLhtbAgent(logs_dir=TMP / 'logs-raises', model_name='openai/fake-model', arm='economy')
    captured = {}

    async def exploding(self, instruction, environment, context):
        self._bridge = spawn_bridge('raises')
        captured['pid'] = self._bridge._proc.pid
        raise RuntimeError('injected mid-episode failure')

    agent._run_episode = exploding.__get__(agent, type(agent))
    raised = None
    try:
        asyncio.run(agent.run('instruction', None, Ctx()))
    except RuntimeError as error:
        raised = str(error)
    return {'pid': captured.get('pid'), 'exceptionPropagated': raised,
            'reaped': agent._bridge is not None and agent._bridge._proc.poll() is not None}


def case_forced_parent_termination() -> dict:
    """The OS boundary: kill the Python parent outright and see whether the child follows."""
    # The child is a FILE, not a `-c` one-liner: assembling code through nested quoting is how the
    # first version of this fixture produced a SyntaxError instead of a measurement.
    child_path = TMP / 'forced_child.py'
    child_path.write_text('\n'.join([
        'import sys, time',
        'sys.path[:0] = [' + repr(str(ROOT / 'eval' / 'lhtb')) + ', ' + repr(str(ROOT / 'eval' / 'bridge')) + ']',
        'from ef_bridge_client import EpistemicFoldBridge',
        'b = EpistemicFoldBridge(arm=\'economy\', bundle_root=' + repr(str(TMP / 'forced')) + ', domain=\'lhtb\', task_id=\'forced\')',
        'print(b._proc.pid, flush=True)',
        'time.sleep(600)',
    ]))
    parent = subprocess.Popen([sys.executable, str(child_path)],
                              stdout=subprocess.PIPE, text=True)
    bridge_pid = int(parent.stdout.readline().strip())
    parent.terminate()
    try:
        parent.wait(timeout=10)
    except subprocess.TimeoutExpired:
        parent.kill()
    time.sleep(2.0)
    # Narrow, targeted liveness check on the ONE pid this fixture recorded.
    alive = False
    try:
        out = subprocess.run(['tasklist', '/FI', f'PID eq {bridge_pid}'], capture_output=True, text=True)
        alive = str(bridge_pid) in out.stdout
    except Exception:  # noqa: BLE001
        alive = False
    if alive:
        # Clean up the fixture's own leftover rather than leaving it behind.
        subprocess.run(['taskkill', '/F', '/PID', str(bridge_pid)], capture_output=True)
    return {'bridgePid': bridge_pid, 'survivedParentTermination': alive,
            'cleanedUpByFixture': alive}


print(json.dumps({
    'normalClose': case_normal_close(),
    'closeIgnored': case_close_ignored(),
    'episodeRaises': case_episode_raises(),
    'forcedParentTermination': case_forced_parent_termination(),
}))