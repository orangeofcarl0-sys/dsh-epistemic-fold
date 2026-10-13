"""
Drive the PRODUCTION EFLhtbAgent recall dispatch against a real Node bridge.

Weighted toward the Python half of the chain, which nothing had executed: a fake provider
supplies the model's tool calls, the Harbor environment is a stub, and everything else -- the
agent's dispatch loop, the bridge client, the Node bridge process, the plugin, the SessionStore,
the fold transaction and the ToolRuntime -- is the real implementation.

Prints one JSON object on the last line. No network beyond 127.0.0.1; no API key.
"""

import asyncio
import json
import os
import re
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

NONCE = 'zqxnonce77'
STATE = {'calls': 0, 'bodies': [], 'shell_issued': 0, 'badref_issued': False}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep the harness output clean
        return

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('content-length', 0)))
        body = json.loads(raw or b'{}')
        STATE['calls'] += 1
        STATE['bodies'].append(json.dumps(body))
        msgs = body.get('messages', [])
        # A SUMMARIZATION request is the fold's own model call. It must get prose, not one of the
        # scripted tool calls, or the fold cannot complete -- which is what silently kept the
        # archive empty and made `context_search` answer with nothing to cite.
        head = json.dumps(msgs)[:4000].lower()
        if 'summar' in head and not any(m.get('role') == 'tool' for m in msgs):
            _send(self, {'role': 'assistant', 'content': 'Summary of the archived span: evidence notes.'})
            return
        tool_msgs = [m for m in msgs if m.get('role') == 'tool']
        tool_text = ' '.join(str(m.get('content', '')) for m in tool_msgs)
        shell_done = any('evidence' in str(m.get('content', '')) for m in tool_msgs if m.get('role') == 'tool')
        search_done = 'cp:' in tool_text
        recall_done = NONCE in tool_text and 'recovered evidence' in tool_text

        # The ToolResult pruner caps ONE result at ~8192 chars, so a single huge command cannot
        # build pressure. Many ordinary ones can, which is how a real episode reaches a fold.
        # A SERVER-SIDE phase counter, not `len(tool_msgs)`: a fold REMOVES the tool messages from
        # the surface, so counting them resets to zero after every fold and the driver loops.
        if STATE.get('shell_issued', 0) < 6:
            STATE['shell_issued'] = STATE.get('shell_issued', 0) + 1
            reply = call(f"call-shell-{STATE['shell_issued']}", 'run_shell', {'command': 'cat /tmp/evidence'})
        elif not search_done:
            # 2. TWO calls in ONE reply, so the append-before-next-step rule is exercised.
            reply = [
                call('call-search', 'context_search', {'query': 'recovered evidence ' + NONCE}),
                call('call-shell', 'run_shell', {'command': 'echo second'}),
            ]
        elif not recall_done:
            ref = re.search(r'cp:[A-Za-z0-9_-]+', tool_text).group(0)
            reply = call('call-recall', 'context_recall',
                         {'ref': ref, 'depth': 'exact', 'offset': 0, 'limit': 20})
        elif not STATE.get('badref_issued'):
            STATE['badref_issued'] = True
            reply = call('call-badref', 'context_recall',
                         {'ref': 'cp:00000000-0000-0000-0000-000000000000',
                          'depth': 'exact', 'offset': 0, 'limit': 20})
        else:
            reply = {'role': 'assistant', 'content': 'recovered, done'}
        _send(self, reply)


def call(call_id, name, arguments):
    return {'role': 'assistant', 'content': '',
            'tool_calls': [{'id': call_id, 'type': 'function',
                            'function': {'name': name, 'arguments': json.dumps(arguments)}}]}


def _send(handler, reply):
    if isinstance(reply, list):
        message = {'role': 'assistant', 'content': '',
                   'tool_calls': [c['tool_calls'][0] for c in reply]}
        finish = 'tool_calls'
    elif 'tool_calls' in reply:
        message, finish = reply, 'tool_calls'
    else:
        message, finish = reply, 'stop'
    payload = {'id': 'fake', 'object': 'chat.completion', 'model': 'fake',
               'choices': [{'index': 0, 'finish_reason': finish, 'message': message}],
               'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}}
    data = json.dumps(payload).encode()
    handler.send_response(200)
    handler.send_header('content-type', 'application/json')
    handler.send_header('content-length', str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


class StubEnvironment:
    async def exec(self, command, timeout_sec=0):
        class R:
            stdout = ('evidence block: ' + NONCE + ' the format family is evt-v3. ') + ('padding ' * 900)
            stderr = ''
            return_code = 0
        return R()


class StubContext:
    metadata = {}


async def main() -> None:
    server = HTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    tmp = Path(tempfile.mkdtemp(prefix='ef-py-recall-'))
    os.environ.update({
        'EF_LIVE_BASE_URL': f'http://127.0.0.1:{port}',
        'EF_LIVE_API_KEY': 'keyless',
        'EF_LIVE_MODEL': 'fake-model',
        'EF_TAU2_BUNDLE_ROOT': str(tmp / 'bundles'),
        'EF_TAU2_WINDOW': '8192',
        'EF_LHTB_BUNDLE_ROOT': str(tmp / 'bundles'),
        'EF_LHTB_ARM': 'economy',
        'EF_LHTB_TASK_ROOT_MODE': 'exact',
    })
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'eval' / 'lhtb'))
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'eval' / 'bridge'))
    from ef_lhtb_agent import EFLhtbAgent

    agent = EFLhtbAgent(logs_dir=tmp / 'logs', model_name='openai/fake-model', arm='economy')
    env = StubEnvironment()
    await agent.setup(env)
    await agent.run('TASK: recover the evt event-log format family.', env, StubContext())
    server.shutdown()

    transcript = agent._transcript
    by_tool = [t for t in transcript if 'tool' in t]
    search = [t for t in by_tool if t.get('tool') == 'context_search']
    recall = [t for t in by_tool if t.get('tool') == 'context_recall']
    folded_bodies = ' '.join(STATE['bodies'])
    print(json.dumps({
        'providerCalls': STATE['calls'],
        'transcriptTurns': len(transcript),
        'toolsDispatched': sorted({t.get('tool') for t in by_tool}),
        'searchCount': len(search),
        'recallCount': len(recall),
        'searchOutput': str(search[0]['output'])[:400] if search else '',
        'searchOutputHasRef': 'cp:' in str(search[0]['output']) if search else False,
        'recallOutputHasNonce': NONCE in str(recall[0]['output']) if recall else False,
        'recallOutputHasOriginalWording': 'format family is evt-v3' in str(recall[0]['output']) if recall else False,
        'providerSawSearchResult': 'matchedMessageIndex' in folded_bodies or 'cp:' in folded_bodies,
        'providerSawRecallResult': NONCE in folded_bodies,
        'taskRoot': agent.task_root_telemetry,
        'termination': (StubContext.metadata or {}).get('ef_termination'),
        'folds': ((StubContext.metadata or {}).get('ef_telemetry') or {}).get('folds'),
        'foldLineage': [e.get('mechanism') for e in (((StubContext.metadata or {}).get('ef_telemetry') or {}).get('foldLineage') or [])],
        'badRefOutput': next((str(t['output']) for t in recall
                              if str((t.get('arguments') or {}).get('ref', '')).startswith('cp:0000')), ''),
        'recallRefs': [str((t.get('arguments') or {}).get('ref', '')) for t in recall],
    }))


asyncio.run(main())