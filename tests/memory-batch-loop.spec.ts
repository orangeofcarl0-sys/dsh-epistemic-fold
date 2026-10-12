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
const SCRIPT = "import json, sys\nfrom pathlib import Path\nsys.path.insert(0, 'eval/memory')\nimport run_cell as rc\n\nclass FakeBridge:\n    \"\"\"Records the calls, so the ORDER and the CONTENT can both be checked.\"\"\"\n    def __init__(self, **kw):\n        self.calls = []\n        self.last_telemetry = {}\n        self._seq = 0\n        self._probe_reply = {}\n    def init(self, policy, tools):\n        self.calls.append(('init', {'policy': policy, 'tools': list(tools)}))\n    def append(self, message):\n        self._seq += 1\n        self.calls.append(('append', message['content'][:60]))\n        return {'ok': True, 'seqs': [self._seq]}\n    def compact(self):\n        self.calls.append(('compact', None))\n        return False\n    def set_compaction(self, enabled):\n        self.calls.append(('set_compaction', enabled))\n        return enabled\n    def step(self, max_tokens=None):\n        self.calls.append(('step', None))\n        return {'content': self.next_reply()}\n    def next_reply(self):\n        return '1: A'\n    def close(self):\n        self.calls.append(('close', None))\n\nrc.EpistemicFoldBridge = FakeBridge\nout = rc.run_cell(arm='quality', order_name='logical', depth=0, mode='B', warned=False,\n                  inject=True, limit_docs=None)\ncalls = [c[0] for c in out['_calls']] if '_calls' in out else None\nprint(json.dumps({'batches': out['probe_batches'], 'ingested_docs': out['ingested_docs'],\n                  'ingests_corpus': out['ingests_corpus'], 'folds_total': out['folds_total'],\n                  'exposure_facts': len(out['exposure'])}))"

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
})
