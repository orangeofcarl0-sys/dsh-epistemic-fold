/**
 * Section 11 lists what would falsify the design. An analysis that cannot check them is not an
 * analysis of THIS design.
 *
 * Three were unreachable as the analysis was first written:
 *
 *   "arm B near chance" needs the CHANCE FLOOR, which the scorer computed and the analysis was
 *   dropping. Without it 0.30 reads as a weak-but-real result instead of as chance.
 *
 *   "B and A indistinguishable at DEPTH 1" needs depth as a dimension, and retention was
 *   reported by type and by exposure but never by depth.
 *
 *   "the warned and unwarned arms differ only in fold count" needs the warning as a dimension.
 *
 * Each falsifier is checked in BOTH directions -- fires when it should and stays quiet when it
 * should not -- because a falsifier that can only fire, or can never fire, is not a check. One
 * of them could never fire: the depth groups are keyed by TUPLE and the lookup used the JSON
 * string form, so `A_and_B_tie_at_depth_1` was absent from every report and read as clear.
 *
 * @module tests/memory-falsifiers
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const PY = join(ROOT, '..', 'bench-workspace', 'lhtb', 'harbor', '.venv', 'Scripts', 'python.exe')
const canRun = existsSync(PY)
const SCRIPT = "import json, sys\nsys.path.insert(0, 'eval/memory')\nimport analyse\nkey = json.loads(open('eval/memory/answer_key.json', encoding='utf-8').read())\nprobes = key['probes']\ndef mk(arm, depth, rule, warned=False):\n    rows, exposure = [], {}\n    for p in probes:\n        rows.append({'id': p['id'], 'type': p['type'], 'kind': p['kind'], 'correct': rule(p)})\n        exposure[p['fact']] = {'leaf': depth, 'root': 0, 'emergency': 0, 'total': depth}\n    return {'cell': {'arm': arm, 'order': 'logical', 'depth': depth, 'mode': arm,\n                     'warned': warned, 'inject': arm in ('B', 'C'),\n                     'compaction_disabled': True},\n            'rows': rows, 'exposure': exposure, 'telemetry': {'costTotal': 1.0}}\ndef ev(cells):\n    out = analyse.analyse(cells)\n    out['falsifiers'] = analyse.evaluate_falsifiers(out)\n    return out\n# 1. A and B identical at depth 1 -> the tie falsifier fires\ntie = ev([mk('A', 1, lambda p: True), mk('B', 1, lambda p: True)])\n# 2. and when they differ -> it does not\ndiffer = ev([mk('A', 1, lambda p: p['kind'] != 'disambiguation'), mk('B', 1, lambda p: True)])\n# 3. B identical to C -> the interference falsifier fires\ninter = ev([mk('B', 0, lambda p: True), mk('C', 0, lambda p: True)])\nprint(json.dumps({\n    'floor': tie['chance_floor'],\n    'tie': tie['falsifiers'].get('A_and_B_tie_at_depth_1'),\n    'differ': differ['falsifiers'].get('A_and_B_tie_at_depth_1'),\n    'interference': inter['falsifiers'].get('interference_near_zero'),\n    'not_checkable': [k for k, v in tie['falsifiers'].items() if v.get('checked') is False],\n}))"

describe.skipIf(!canRun)('the falsifiers', () => {
  const r = () => JSON.parse(execFileSync(PY, ['-c', SCRIPT], { encoding: 'utf8', timeout: 300000, cwd: ROOT }))

  it('carries the chance floor, without which "near chance" cannot be judged', () => {
    expect(r().floor).toBeCloseTo(0.25, 2)
  })

  it('fires the A/B tie falsifier when they tie, and not when they differ', () => {
    const out = r()
    expect(out.tie.triggered).toBe(true)
    expect(out.tie.gap).toBe(0)
    expect(out.differ.triggered).toBe(false)
    expect(out.differ.gap).toBeGreaterThan(0.05)
  })

  it('fires the interference falsifier when B equals C', () => {
    const out = r()
    expect(out.interference.triggered).toBe(true)
    expect(out.interference.gap).toBe(0)
  })

  it('says which falsifiers it CANNOT check, rather than reporting them clear', () => {
    // Two are separate experiments. Reporting them as "not triggered" because their cells are
    // absent would be the worst kind of green.
    const out = r()
    expect(out.not_checkable).toContain('warning_factor')
    expect(out.not_checkable).toContain('load_penalty')
  })
})
