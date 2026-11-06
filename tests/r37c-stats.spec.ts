/**
 * R37-C0-D: paired statistics with the case as the sampling unit.
 *
 * @module tests/r37c-stats
 */

import { describe, expect, it } from 'vitest'
import {
  exactMcNemar,
  leaveOneCaseOut,
  perCase,
  signTest,
  summarize,
} from '../eval/r37c/src/stats.mjs'

function pair(caseId: string, replicate: string, treatment: boolean, baseline: boolean) {
  return { caseId, replicate, treatment: { contract: treatment }, baseline: { contract: baseline } }
}

const pairs = [
  ...Array.from({ length: 6 }, (_, index) => pair('A', `r${index}`, index < 4, true)),
  ...Array.from({ length: 6 }, (_, index) => pair('B', `r${index}`, index < 3, index < 5)),
  ...Array.from({ length: 6 }, (_, index) => pair('C', `r${index}`, index < 2, index < 2)),
]

describe('R37-C0-D: paired statistics', () => {
  it('computes exact McNemar on discordant pairs', () => {
    expect(exactMcNemar(1, 9).p).toBeCloseTo(0.021484375, 12)
    expect(exactMcNemar(0, 8).p).toBeCloseTo(0.0078125, 12)
    expect(exactMcNemar(0, 0).p).toBeNull()
  })

  it('computes the case-level sign test with ties excluded', () => {
    expect(signTest(5, 0).p).toBeCloseTo(0.0625, 12)
    expect(signTest(5, 1).p).toBeCloseTo(0.21875, 12)
  })

  it('reports per-case rescue, damage, both, and neither', () => {
    const cases = perCase(pairs, value => value.contract === true)
    const a = cases.find(entry => entry.caseId === 'A')
    expect(a).toMatchObject({ pairs: 6, sSuccesses: 4, b1Successes: 6, damage: 2, rescue: 0, both: 4, neither: 0 })
  })

  it('recomputes the result after excluding one case', () => {
    const selected = pairs.map(entry => ({ ...entry, treatment: entry.treatment.contract, baseline: entry.baseline.contract }))
    const loo = leaveOneCaseOut(selected, value => value === true)
    const withoutA = loo.find(entry => entry.excluded === 'A')
    expect(withoutA.pairs).toBe(12)
    expect(withoutA.rescue).toBe(0)
    expect(withoutA.damage).toBe(2)
  })

  it('summarizes direction and keeps the bootstrap descriptive', () => {
    const summary = summarize(
      pairs.map(entry => ({ ...entry, treatment: entry.treatment.contract, baseline: entry.baseline.contract })),
      value => value === true,
    )
    expect(summary.caseDirection).toEqual({ negative: 2, positive: 0, flat: 1 })
    expect(summary.bootstrap.cases).toBe(3)
    expect(summary.bootstrap.note).toMatch(/descriptive/u)
  })
})
