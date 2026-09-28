/**
 * R1-E: Pareto reporting and the correctness filter.
 *
 * The two claims this suite must hold:
 *
 * 1. Economics never buys correctness — a policy that violates a hard gate is
 *    EXCLUDED from comparison, not scored badly on it.
 * 2. There is no global winner — only a frontier. A policy that is cheaper but
 *    carries much more context is not dominated and not "better"; it is a
 *    different point on the frontier.
 */

import { describe, expect, it } from 'vitest'
import { paretoFrontier, paretoToMarkdown, passesHardGates } from '../eval/src/pareto.ts'
import type { PolicyPoint } from '../eval/src/pareto.ts'

/** Every gate at its passing value; tests vary one at a time. */
type Gates = PolicyPoint['gates']

const CLEAN_GATES: Gates = {
  authorityLossRate: 0,
  stateStalenessRate: 0,
  criticalConstraintViolations: 0,
  exactRecallMismatch: 0,
  crossSessionLeak: 0,
}

function point(id: string, cost: number, peak: number, success: number, gates: Gates = CLEAN_GATES): PolicyPoint {
  return { id, label: id, effectiveCost: cost, peakContext: peak, taskSuccess: success, gates: { ...gates } }
}

describe('R1-E: correctness is a filter, never a trade', () => {
  it('a cheap policy that loses authority is excluded, not ranked', () => {
    const result = paretoFrontier([
      point('clean', 1.0, 10_000, 0.9),
      point('cheap-but-lossy', 0.1, 1_000, 0.95, { ...CLEAN_GATES, authorityLossRate: 0.2 }),
    ])
    expect(result.frontier.map(p => p.id)).toEqual(['clean'])
    expect(result.excluded.map(p => p.id)).toEqual(['cheap-but-lossy'])
    expect(result.excluded[0]!.failedGates).toContain('authorityLossRate')
    // It never appears among the dominated either: it was never comparable.
    expect(result.dominated).toHaveLength(0)
  })

  it('every hard gate excludes on its own', () => {
    const gateNames = [
      'authorityLossRate',
      'stateStalenessRate',
      'criticalConstraintViolations',
      'exactRecallMismatch',
      'crossSessionLeak',
    ] as const
    for (const gate of gateNames) {
      const bad = point('bad', 0.1, 100, 0.99, { ...CLEAN_GATES, [gate]: 1 })
      expect(passesHardGates(bad)).toBe(false)
      const result = paretoFrontier([point('clean', 5, 50_000, 0.5), bad])
      expect(result.excluded.map(p => p.id)).toEqual(['bad'])
      expect(result.excluded[0]!.failedGates).toEqual([gate])
    }
  })

  it('a non-zero cross-session leak is fatal regardless of how cheap it is', () => {
    const result = paretoFrontier([
      point('leaky', 0.0001, 10, 1.0, { ...CLEAN_GATES, crossSessionLeak: 1 }),
    ])
    expect(result.frontier).toHaveLength(0)
    expect(result.excluded).toHaveLength(1)
  })
})

describe('R1-E: a frontier, not a winner', () => {
  it('keeps both a cheaper-but-larger and a pricier-but-smaller policy', () => {
    // Neither dominates: one wins on cost, the other on footprint.
    const result = paretoFrontier([
      point('cache-first', 1.0, 100_000, 0.9),
      point('token-first', 1.2, 20_000, 0.9),
    ])
    expect(result.frontier.map(p => p.id).sort()).toEqual(['cache-first', 'token-first'])
    expect(result.dominated).toHaveLength(0)
  })

  it('drops a policy that is worse on every axis', () => {
    const result = paretoFrontier([
      point('good', 1.0, 10_000, 0.9),
      point('strictly-worse', 2.0, 20_000, 0.5),
    ])
    expect(result.frontier.map(p => p.id)).toEqual(['good'])
    expect(result.dominated.map(p => p.id)).toEqual(['strictly-worse'])
  })

  it('a cheaper policy with much higher peak context is not declared better', () => {
    // The docs/11 §23 case: 1% cheaper but 70% more context must not be
    // reported as an improvement.
    const result = paretoFrontier([
      point('baseline', 1.00, 10_000, 0.9),
      point('cheaper-bigger', 0.99, 17_000, 0.9),
    ])
    expect(result.frontier).toHaveLength(2)
    expect(result.dominated).toHaveLength(0)
  })

  it('a higher-success policy stays on the frontier even when dearer', () => {
    // Cost-to-success, not cost: paying more for more success is not a loss.
    const result = paretoFrontier([
      point('basic', 1.0, 10_000, 0.80),
      point('ef', 1.1, 10_000, 0.95),
    ])
    expect(result.frontier).toHaveLength(2)
  })

  it('identical points collapse: one survives, the other is dominated by identity', () => {
    const result = paretoFrontier([
      point('a', 1, 100, 0.9),
      point('b', 1, 100, 0.9),
    ])
    // Neither strictly dominates the other (no axis is strictly better), so
    // both remain — a tie is not a loss.
    expect(result.frontier).toHaveLength(2)
    expect(result.dominated).toHaveLength(0)
  })

  it('renders the frontier with excluded points listed separately', () => {
    const result = paretoFrontier([
      point('keep', 1.0, 10_000, 0.9),
      point('drop', 2.0, 20_000, 0.5),
      point('bad', 0.01, 10, 1.0, { ...CLEAN_GATES, stateStalenessRate: 1 }),
    ])
    const markdown = paretoToMarkdown(result)
    expect(markdown).toContain('| keep |')
    expect(markdown).toContain('Dominated')
    expect(markdown).toContain('| drop |')
    expect(markdown).toContain('Excluded by correctness hard gates')
    expect(markdown).toContain('stateStalenessRate')
  })
})
