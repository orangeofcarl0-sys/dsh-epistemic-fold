#!/usr/bin/env python3
"""Diagnostic: does a phase's coordinate set survive into a LATER phase's checkpoint?

docs/143 hypothesised that the phased protocol breaks its own cross-phase chain at 252K because a
phase ingests more than the retained tail keeps. This checks the part the score cannot show: is
the previous phase's content still IN the checkpoint when the next phase probes it?
"""
import sys, json
sys.path.insert(0, 'eval/memory')
import phased, run_cell as rc

docs = rc.load('documents.json'); key = rc.load('answer_key.json')
public = rc.load('public_probes.json'); orders = rc.load('orderings.json')
by_key = rc.corpus_with_errata(docs, key['errata'])
seq = [k for k in orders['logical'] if k in by_key]
phases = phased.build_phases(seq, public['probes'], key['errata'], 4)

bridge = rc.EpistemicFoldBridge(arm='quality', bundle_root='eval/memory/_bundles',
                                domain='memory', task_id='chain-verify')
bridge.init(rc.SYSTEM_PUSH, [])
bridge.set_compaction(False)

def checkpoint_text():
    rep = bridge._send({'op': 'checkpoints'})['report']
    ids = [s['checkpointId'] for s in rep['sites'] if s['onSurface']]
    if not ids:
        return '(no resident checkpoint)'
    out = bridge._send({'op': 'tool', 'name': 'context_recall',
                        'arguments': {'ref': 'cp:' + ids[-1], 'depth': 'summary'},
                        'callId': 'verify'})
    body = out.get('content') or ''
    try:
        body = json.loads(body).get('text') or body
    except Exception:
        pass
    return body

def report(phase_index):
    body = checkpoint_text()
    coords = (bridge._send({'op': 'state'}) or {}).get('coordinates') or {}
    print('after phase ' + str(phase_index) + ': checkpoint ' + str(len(body)) + ' chars, state total ' + str(coords.get('total')))
    for probe_entity in ('execution-1', 'reasoning-1', 'coding-1'):
        print('    ' + probe_entity + ' in checkpoint: ' + str(probe_entity in body))

for phase in phases:
    weights = [max(1, len(by_key[k]['text']) // 4) for k in phase['docs']]
    for part in rc.split_into_parts(phase['docs'], weights, 2):
        for k in part:
            reply = bridge.append({'role': 'user', 'content': by_key[k]['text']})
            src = (reply.get('seqs') or [None])[0]
            if src is not None:
                for entity, prop, value in phased.extract_facts(by_key[k]['text'], k):
                    bridge._send({'op': 'anchor', 'entity': entity, 'property': prop,
                                  'value': value, 'sourceSeq': src})
        bridge.set_compaction(True); bridge.compact(); bridge.set_compaction(False)
    report(phase['index'])
    if phase['index'] == 3:
        body = checkpoint_text()
        for token in ('escalate_after_minutes', 'retry_budget', 'effect_size'):
            print('    field ' + token + ' in checkpoint: ' + str(token in body))
bridge.close()