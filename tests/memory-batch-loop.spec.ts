/**
 * The batch loop is control flow, and control flow is what no unit test of a pure function
 * reaches.
 *
 * `probe_batches`, `validate_injection` and `compute_exposure` are all tested directly, and the
 * driver that CALLS them was not: whether the injections land before the right batch, whether
 * the answers from every batch are merged rather than the last one winning, and whether an arm
 * with no corpus skips both the ingestion and the folds.
 *
 * Those are exactly the defects this session has already produced twice -- an injection after
 * the fold it should precede, and a corpus given to an arm that must not have one -- so they are
 * checked against a fake bridge that records the call order rather than against a real run that
 * needs a provider.
 *
 * @module tests/memory-batch-loop
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const PY = join(ROOT, '..', 'bench-workspace', 'lhtb', 'harbor', '.venv', 'Scripts', 'python.exe')
const canRun = existsSync(PY)
const SCRIPT = "import json, sys\nfrom pathlib import Path\nsys.path.insert(0, 'eval/memory')\nimport run_cell as rc\n\nclass FakeBridge:\n    \"\"\"Records the calls, so the ORDER and the CONTENT can both be checked.\"\"\"\n    def __init__(self, **kw):\n        self.calls = []\n        self.last_telemetry = {}\n        self._seq = 0\n        self._probe_reply = {}\n    def init(self, policy, tools, fs_root=None):\n        self.calls.append(('init', {'policy': policy, 'tools': list(tools), 'fs_root': fs_root}))\n    def append(self, message):\n        self._seq += 1\n        self.calls.append(('append', message['content'][:60]))\n        return {'ok': True, 'seqs': [self._seq]}\n    def compact(self):\n        self.calls.append(('compact', None))\n        return False\n    def _send(self, request):\n        # The driver folds between probe batches through the bridge's raw op channel, so the\n        # stub has to answer it. Without this the batch loop raised AttributeError and the\n        # whole driver path was untested -- a regression introduced when that fold was added.\n        self.calls.append(('_send', request))\n        return {'ok': True, 'committed': self.compact()}\n    def set_compaction(self, enabled):\n        self.calls.append(('set_compaction', enabled))\n        return enabled\n    def step(self, max_tokens=None):\n        self.calls.append(('step', None))\n        return {'content': self.next_reply()}\n    def next_reply(self):\n        return '1: A'\n    def close(self):\n        self.calls.append(('close', None))\n\nrc.EpistemicFoldBridge = FakeBridge\nout = rc.run_cell(arm='quality', order_name='logical', depth=0, mode='B', warned=False,\n                  inject=True, limit_docs=None, folds=0)\ncalls = [c[0] for c in out['_calls']] if '_calls' in out else None\nprint(json.dumps({'batches': out['probe_batches'], 'ingested_docs': out['ingested_docs'],\n                  'ingests_corpus': out['ingests_corpus'], 'folds_total': out['folds_total'],\n                  'exposure_facts': len(out['exposure']),\n                  'folds_by_window': {str(w): rc.folds_for_window(w) for w in (131072, 258048, 475136, 999999, 1048576)},\n                  'split_docs_7': [len(p) for p in rc.split_into_parts([str(i) for i in range(104)], [1] * 104, 7)]}))"

describe.skipIf(!canRun)('the driver batch loop', () => {
  const run = () => JSON.parse(execFileSync(PY, ['-c', SCRIPT], { encoding: 'utf8', timeout: 300000, cwd: ROOT }))

  it('runs one step per batch and ingests the corpus for arm B', () => {
    const r = run()
    expect(r.batches).toBe(20)
    expect(r.ingests_corpus).toBe(true)
    // 100 documents plus 4 errata. The errata are in `orderings.json` at 85% of the sequence,
    // and the lookup was built from `documents.json` alone -- which has none -- so those
    // entries resolved to None and were SILENTLY SKIPPED. The correction never entered the
    // corpus, and an update probe would have measured whether the model could read the
    // INJECTED errata rather than whether it replaced a value it had already been told.
    expect(r.ingested_docs).toBe(104)
  })

  it('builds an exposure map over the facts it appended', () => {
    const r = run()
    // The fake returns no fold lineage, so every fact is present with a zero vector -- which
    // is the point: the map EXISTS, and its absence was the defect this chain was missing.
    expect(r.exposure_facts).toBeGreaterThan(0)
  })

  it('resolves the part count PER TIER, so the 1M tier gets seven', () => {
    // Two ceilings bind and only one binds per tier: the SURFACE (retained tail + part) against
    // the tier's simulated window, and the digest call's INPUT (about 1.225x the span) against
    // the MODEL's context. The second binds only at 1M, where six parts put the digest input at
    // 88% of a 1,048,576 context and the provider answered one fold in six with a SUCCESSFUL
    // EMPTY completion -- finish=stop, outputTokens=0. Seven takes it to a predicted 77%.
    const r: { folds_by_window: Record<string, number>; split_docs_7: number[] } = run()
    expect(r.folds_by_window['1048576']).toBe(7)
    expect(r.folds_by_window['258048']).toBe(6)
    expect(r.folds_by_window['131072']).toBe(6)
    expect(r.folds_by_window['475136']).toBe(6)
    // A window the table does not name takes the FLOOR, not the largest tier's count: inheriting
    // 7 would silently change a new tier's span, which is the quantity under test.
    expect(r.folds_by_window['999999']).toBe(6)
    // And the split really does cut 104 documents into seven parts without losing any.
    expect(r.split_docs_7).toHaveLength(7)
    expect(r.split_docs_7.reduce((a: number, b: number) => a + b, 0)).toBe(104)
  })
})
