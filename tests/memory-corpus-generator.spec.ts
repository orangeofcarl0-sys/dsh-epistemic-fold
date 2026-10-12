/**
 * The memory-pressure corpus must be CHECKED, not assumed.
 *
 * ## Why the generator asserts its own constraints
 *
 * `docs/62_MEMORY_PRESSURE_TASK_DESIGN.md` section 3.2.16 lists four load-bearing constraints,
 * each found by asking what would break the probe. Three of them were violated by the first
 * draft of the generator, and each violation would have been invisible in the output:
 *
 *   - a field with fewer options than projects makes uniqueness impossible, and the corpus
 *     would have carried duplicate values, giving a disambiguation probe two correct answers
 *   - an errata needs a REPLACEMENT value that is also unique, so a vocabulary with exactly as
 *     many values as projects has nothing to change to
 *   - `temporal` and `logical` were byte-identical, which would have made two thirds of the
 *     position pairing the same observation counted twice
 *
 * None of those is visible by reading a generated document. They are visible only as an
 * assertion, which is why the generator fails rather than emitting.
 *
 * ## What this test does
 *
 * It runs the generator and checks the report it writes. The generator itself is Python, so the
 * assertions live there and this test is what keeps them running with the rest of the suite --
 * a check nobody runs is not a check.
 *
 * @module tests/memory-corpus-generator
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const MEM = join(ROOT, 'eval', 'memory')
const PY = join(ROOT, '..', 'bench-workspace', 'lhtb', 'harbor', '.venv', 'Scripts', 'python.exe')

const canRun = existsSync(PY) && existsSync(join(MEM, 'build_corpus.py'))

describe.skipIf(!canRun)('the memory corpus generator', () => {
  it('runs and passes every constraint it declares', () => {
    // Exit 0 IS the assertion: the generator raises SystemExit on any violation.
    const out = execFileSync(PY, [join(MEM, 'build_corpus.py')], { encoding: 'utf8', timeout: 240000 })
    expect(out).toContain('constraints ok')
    const report = JSON.parse(readFileSync(join(MEM, 'generation_report.json'), 'utf8'))
    const failed = Object.entries(report).filter(([, v]) => !(v as { ok: boolean }).ok)
    expect(failed.map(([k]) => k), 'every declared constraint must hold').toEqual([])
  }, 300000)

  it('declares the constraints the design depends on', () => {
    const report = JSON.parse(readFileSync(join(MEM, 'generation_report.json'), 'utf8'))
    for (const key of ['unique_within_type', 'full_vocabulary', 'ring_closed', 'orderings_distinct']) {
      expect(report[key], key + ' must be reported, not assumed').toBeDefined()
    }
  })

  it('strips every expected value from the public probes', () => {
    const pub = JSON.parse(readFileSync(join(MEM, 'public_probes.json'), 'utf8'))
    const leaked = pub.probes.filter((p: Record<string, unknown>) => 'answer' in p || 'stale' in p)
    expect(leaked.length, 'a public probe carrying an answer would void the run').toBe(0)
    expect(pub.probes.length).toBeGreaterThan(100)
  })

  it('builds probes of every kind, and every probed fact gets BOTH paired forms', () => {
    const key = JSON.parse(readFileSync(join(MEM, 'answer_key.json'), 'utf8'))
    const kinds = new Set(key.probes.map((p: { kind: string }) => p.kind))
    for (const k of ['extraction', 'disambiguation', 'composition', 'update', 'abstention']) {
      expect(kinds.has(k), k + ' probes must exist').toBe(true)
    }
    // 8.1: binding loss is only paired if the same fact is asked both ways.
    const byFact = new Map<string, Set<string>>()
    for (const p of key.probes) {
      if (p.kind !== 'extraction' && p.kind !== 'disambiguation') continue
      const set = byFact.get(p.fact) ?? new Set<string>()
      set.add(p.kind)
      byFact.set(p.fact, set)
    }
    const unpaired = [...byFact.entries()].filter(([, s]) => s.size !== 2)
    expect(unpaired.length, 'every probed fact needs both forms, or binding loss is unpaired').toBe(0)
  })

  it('places the errata late, so there is a stale value to update from', () => {
    const orders = JSON.parse(readFileSync(join(MEM, 'orderings.json'), 'utf8'))
    for (const [name, seq] of Object.entries(orders) as [string, string[]][]) {
      const at = seq.findIndex(d => d.endsWith('/ERRATA.md'))
      expect(at, name + ': the errata must not open the corpus').toBeGreaterThan(seq.length * 0.5)
    }
  })
})
