/**
 * Exposure is the covariate section 7 exists for, and it needed a join that had no source.
 *
 * `docs/62_MEMORY_PRESSURE_TASK_DESIGN.md` 7.2 defines `exposure(f)` as how many folds had fact f
 * inside their shadowed range, and the fold lineage records the shadowed SEQS. Computing it
 * therefore needs a **fact -> seq** map -- and nothing produced one: `appendIncoming` returned
 * nothing and the `append` op reported only telemetry. **The first link of the chain was missing
 * while both ends of it existed.**
 *
 * 7.3 makes it a VECTOR rather than an integer: a leaf fold is local, a root fold is global, and
 * an emergency rebase happens under overflow pressure inside a live turn and is likeliest to be
 * hasty. "Folded three times by leaves" and "folded once by a root" are not the same event, so
 * the three are counted separately and the total is derived rather than stored.
 *
 * `containing_summary_size` is the SMALLEST fold that swallowed the fact: a fact inside a
 * 50-token summary is likelier intact than one inside a 5-token summary, so the tightest
 * constraint is the one that describes it.
 *
 * @module tests/memory-exposure
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const HOST = readFileSync(join(ROOT, 'eval', 'tau2', 'bridge-host.ts'), 'utf8')
const CLIENT = readFileSync(join(ROOT, 'eval', 'bridge', 'ef_bridge_client.py'), 'utf8')
const DRIVER = readFileSync(join(ROOT, 'eval', 'memory', 'run_cell.py'), 'utf8')
const PY = join(ROOT, '..', 'bench-workspace', 'lhtb', 'harbor', '.venv', 'Scripts', 'python.exe')
const canRun = existsSync(PY)

const SCRIPT = "import sys, json\nsys.path.insert(0, 'eval/memory')\nimport run_cell as rc\nlineage = [\n    {'mechanism': 'leaf', 'shadowedSeqs': [1, 2, 3], 'shadowedTokenCount': 900},\n    {'mechanism': 'root', 'shadowedSeqs': [1, 2, 3, 4, 5], 'shadowedTokenCount': 300},\n    {'mechanism': 'leaf', 'shadowedSeqs': [9, 10], 'shadowedTokenCount': 800},\n]\nprint(json.dumps(rc.compute_exposure({'a': [2], 'b': [9], 'c': [77]}, lineage)))"

describe('the exposure chain', () => {
  it('has a SOURCE for the fact -> seq map, which it did not before', () => {
    expect(HOST).toContain('const before = new Set(active.surface.nodes)')
    expect(HOST).toContain('return active.surface.nodes.filter((s: number) => !before.has(s))')
    expect(HOST).toContain('seqs: appendedSeqs')
    expect(CLIENT).toContain('def append(self, message: dict[str, Any]) -> dict[str, Any]:')
  })

  it('is a VECTOR over mechanisms, with the total derived', () => {
    expect(DRIVER).toContain('def compute_exposure(')
    expect(DRIVER).toContain('"total": sum(counts.values())')
  })

  it.skipIf(!canRun)('joins correctly, keeps the SMALLEST summary, handles untouched facts', () => {
    const out = execFileSync(PY, ['-c', SCRIPT], { encoding: 'utf8', timeout: 120000, cwd: ROOT })
    const ex = JSON.parse(out)
    expect(ex.a).toMatchObject({ leaf: 1, root: 1, emergency: 0, total: 2 })
    expect(ex.a.containing_summary_size, 'the SMALLEST fold that swallowed it').toBe(300)
    expect(ex.b).toMatchObject({ leaf: 1, total: 1 })
    expect(ex.c).toMatchObject({ total: 0, containing_summary_size: null })
  })
})
