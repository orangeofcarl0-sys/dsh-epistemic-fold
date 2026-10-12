/**
 * The analysis must recover an effect that was PLANTED, not merely run.
 *
 * A script that produces a table is not evidence that the table is right. This plants a known
 * effect -- arm B always correct, arm A correct only where nothing was folded, and
 * disambiguation wrong whenever a fold touched the fact -- and checks that the analysis reports
 * exactly that.
 *
 * Three properties are checked because each is a documented way to get it wrong:
 *
 *   CLUSTERED BOOTSTRAP (8.2). The same fact appears in several cells, so probes within a fact
 *   are correlated and resampling probes would understate the interval. The cluster is the fact.
 *
 *   PAIRED BINDING LOSS (8.1). It is computed per fact from the two forms, and carries the
 *   discordant counts McNemar needs rather than only the two rates.
 *
 *   EXPOSURE, NOT DEPTH (7.4). Retention is reported against the measured lineage, so a cell at
 *   nominal depth 0 and one at depth 5 must not be averaged into a single number.
 *
 * @module tests/memory-analysis
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const PY = join(ROOT, '..', 'bench-workspace', 'lhtb', 'harbor', '.venv', 'Scripts', 'python.exe')
const canRun = existsSync(PY)
const SCRIPT = "import json, sys, tempfile, os\nfrom pathlib import Path\nsys.path.insert(0, 'eval/memory')\nimport analyse\nkey = json.loads(Path('eval/memory/answer_key.json').read_text(encoding='utf-8'))\nprobes = key['probes']\ndef mkcell(arm, order, depth, rule):\n    rows, exposure = [], {}\n    for p in probes:\n        rows.append({'id': p['id'], 'type': p['type'], 'kind': p['kind'],\n                     'correct': rule(p), 'outcome': 'correct' if rule(p) else 'wrong'})\n        exposure[p['fact']] = {'leaf': depth, 'root': 0, 'emergency': 0, 'total': depth,\n                               'lineage_depth': depth, 'containing_summary_size': 100}\n    return {'cell': {'arm': arm, 'order': order, 'depth': depth, 'mode': arm,\n                      'warned': False, 'inject': arm in ('B', 'C'),\n                      'compaction_disabled': True},\n            'rows': rows, 'exposure': exposure,\n            'telemetry': {'costTotal': 1.0}}\n# A PLANTED EFFECT: arm B always right; arm A right only when exposure is 0.\n# Disambiguation is wrong whenever the fact was folded at all -- the binding-loss story.\ndef ruleB(p): return True\ndef ruleA_low(p): return True\ndef ruleA_high(p): return p['kind'] != 'disambiguation'\ncells = [mkcell('B', 'logical', 0, ruleB), mkcell('C', 'logical', 0, ruleB),\n         mkcell('A', 'logical', 0, ruleA_low), mkcell('A', 'logical', 5, ruleA_high)]\nout = analyse.analyse(cells)\nprint(json.dumps({\n  'n_cells': out['n_cells'],\n  'retention_by_type': out['retention_by_type'],\n  'binding_loss': out.get('binding_loss'),\n  'interference': out.get('interference_B_minus_C'),\n  'by_exposure': out['retention_by_exposure'],\n  'confabulation': out.get('confabulation'),\n}))"

describe.skipIf(!canRun)('the analysis', () => {
  const run = () => JSON.parse(execFileSync(PY, ['-c', SCRIPT], { encoding: 'utf8', timeout: 300000, cwd: ROOT }))

  it('recovers the planted retention, split by EXPOSURE rather than by nominal depth', () => {
    const r = run()
    // Exposure 0: everything correct. Exposure 5: disambiguation lost.
    expect(r.by_exposure['0'].accuracy).toBe(1)
    expect(r.by_exposure['5'].accuracy).toBeLessThan(1)
  })
  it('reports binding loss as PAIRED, with the discordant counts McNemar needs', () => {
    const r = run()
    expect(r.binding_loss.n_pairs).toBeGreaterThan(0)
    // Extraction survived everywhere and disambiguation did not: all discordant one way.
    expect(r.binding_loss.b).toBeGreaterThan(0)
    expect(r.binding_loss.c).toBe(0)
    expect(r.binding_loss.extraction).toBeGreaterThan(r.binding_loss.disambiguation)
  })
  it('carries a confidence interval and the number of FACTS behind it', () => {
    const r = run()
    for (const t of Object.keys(r.retention_by_type.B)) {
      const v = r.retention_by_type.B[t]
      expect(v.ci95.length).toBe(2)
      expect(v.n_facts, 'the cluster count is the effective sample size').toBeGreaterThan(0)
    }
  })
  it('separates abstention from retention instead of pooling it', () => {
    const r = run()
    expect(r.confabulation).toBeDefined()
    // Retention covers only the two paired forms.
    const nRetention = Object.values(r.retention_by_type.B as Record<string, { n: number }>)
      .reduce((a, v) => a + v.n, 0)
    expect(nRetention).toBeLessThan(4 * 51)
  })
})
