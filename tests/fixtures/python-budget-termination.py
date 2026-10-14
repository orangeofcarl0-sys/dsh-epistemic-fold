"""
Gate B: the PRODUCTION Python agent terminating on a spent budget.

Drives `EFLhtbAgent.run()` against a real Node bridge, a real budget gate and a local fake
provider. The budget is armed with `REQUIRED=1`, so the run cannot silently proceed unprotected.

Prints one JSON object on the last line. No API key; nothing leaves 127.0.0.1.
"""

import asyncio
import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

STATE = {'calls': 0, 'bodies': []}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        return

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('content-length', 0)))
        STATE['calls'] += 1
        STATE['bodies'].append(json.loads(raw or b'{}'))
        # Exactly one legal tool call, so the agent has work to do and then asks again.
        payload = {'id': 'fake', 'object': 'chat.completion', 'model': 'fake',
                   'choices': [{'index': 0, 'finish_reason': 'tool_calls', 'message': {
                       'role': 'assistant', 'content': '',
                       'tool_calls': [{'id': 'call-1', 'type': 'function',
                                       'function': {'name': 'run_shell',
                                                    'arguments': json.dumps({'command': 'ls'})}}]}}],
                   'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}}
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class StubEnvironment:
    async def exec(self, command, timeout_sec=0):
        class R:
            stdout = 'ok'
            stderr = ''
            return_code = 0
        return R()


class StubContext:
    def __init__(self):
        # An INSTANCE attribute: the agent assigns `context.metadata = {...}`, and a class-level
        # dict would leave the assignment invisible to a reader of the class.
        self.metadata = {}


async def main() -> None:
    server = HTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    tmp = Path(tempfile.mkdtemp(prefix='ef-budget-term-'))
    os.environ.update({
        'EF_LIVE_BASE_URL': f'http://127.0.0.1:{server.server_address[1]}',
        'EF_LIVE_API_KEY': 'keyless',
        'EF_LIVE_MODEL': 'fake-model',
        'EF_TAU2_BUNDLE_ROOT': str(tmp / 'bundles'),
        'EF_TAU2_WINDOW': '8192',
        'EF_LHTB_BUNDLE_ROOT': str(tmp / 'bundles'),
        'EF_LHTB_ARM': 'economy',
        'EF_LHTB_TASK_ROOT_MODE': 'exact',
        # ONE request of budget, and REQUIRED so a misconfiguration cannot disable it.
        'EF_LHTB_BUDGET_REQUIRED': '1',
        'EF_LHTB_BUDGET_REQUESTS': '1',
        'EF_LHTB_BUDGET_PROMPT_TOKENS': '5000000',
        'EF_LHTB_BUDGET_OUTPUT_TOKENS': '1000000',
        'EF_LHTB_BUDGET_WALL_MS': '600000',
    })
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'eval' / 'lhtb'))
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'eval' / 'bridge'))
    from ef_lhtb_agent import EFLhtbAgent

    agent = EFLhtbAgent(logs_dir=tmp / 'logs', model_name='openai/fake-model', arm='economy')
    env = StubEnvironment()
    await agent.setup(env)
    # An internal watchdog so a hang is DIAGNOSED rather than blocking the caller.
    timed_out = False
    try:
        ctx = StubContext()
        await asyncio.wait_for(agent.run('TASK: list the directory.', env, ctx), timeout=25)
    except asyncio.TimeoutError:
        timed_out = True
    server.shutdown()

    telemetry = agent._bridge.last_telemetry if agent._bridge is not None else {}
    transcript = agent._transcript
    closing = transcript[-1] if transcript else {}
    print(json.dumps({
        'timedOut': timed_out,
        'providerCalls': STATE['calls'],
        'termination': (ctx.metadata or {}).get('ef_termination'),
        'providerFailures': (ctx.metadata or {}).get('ef_provider_failures'),
        'budgetRequests': (telemetry.get('budget') or {}).get('requests'),
        'budgetRefusals': (telemetry.get('budget') or {}).get('refusals'),
        'lastFinishReason': telemetry.get('lastFinishReason'),
        'taskRoot': (ctx.metadata or {}).get('ef_telemetry', {}).get('taskRoot'),
        'turns': len(transcript),
        'lastTurn': closing,
        'bridgeClosed': agent._bridge._closed if agent._bridge is not None else None,
        'bridgeReaped': agent._bridge._proc.poll() is not None if agent._bridge is not None else None,
    }))


asyncio.run(main())