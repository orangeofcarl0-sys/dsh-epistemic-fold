/**
 * R3-0a: pricing and measurement correctness.
 *
 * R2's dominance matrix produced a number (BCR 1.149) that looked like a
 * finding but rested on four unstated assumptions. Each one is a way for a
 * measurement bug to be read as a product result, so each gets a test that
 * fails if the hole reopens:
 *
 * 1. recall tokens were billed on top of the prompt that already contained them
 * 2. cache writes were hardcoded to zero, which is false for explicit-cache
 *    providers and silently converts "unmeasured" into "free"
 * 3. one global realization rate `h = 0.91` — measured for DeepSeek, invented
 *    for every other model — was applied to all profiles
 * 4. `BQR = 1` stood in for quality the keyless tier never measured
 *
 * The invariant that ties 1 together is `Price(Σ buckets) == Price(prompt)`:
 * attribution is a reporting view and must never change the bill.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MEASURED_DEEPSEEK_REALIZATION,
  SCENARIO_REALIZATION_RATES,
  bcrCurve,
  dominanceMatrix,
  dominanceToMarkdown,
  measuredQuality,
  priceArm,
  priceAttribution,
  realizationRates,
} from '../eval/src/dominance.ts'
import type { ArmCostInput, DominanceRow } from '../eval/src/dominance.ts'
import { TOKEN_BUCKETS } from '../eval/src/token-attribution.ts'
import type { TokenBucket } from '../eval/src/token-attribution.ts'
import { parseEconomicsProfile } from '../src/economics-profile.ts'
import type { ContextEconomicsProfile } from '../src/economics-profile.ts'

function profile(id: string): ContextEconomicsProfile {
  return parseEconomicsProfile(JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'profiles', 'economics', `${id}.json`), 'utf8'),
  ))
}

const FLASH = profile('deepseek-flash-2026-09')
const OPENAI = profile('openai-gpt-5.6-2026-09')

const ARM: ArmCostInput = {
  promptTokens: 1_000_000,
  warmTokens: 800_000,
  peakTokens: 40_000,
}

/** A bucket vector summing to `total`, with `recall` set to `recallTokens`. */
function buckets(total: number, recallTokens: number): Record<TokenBucket, number> {
  const vector = Object.fromEntries(TOKEN_BUCKETS.map(bucket => [bucket, 0])) as Record<TokenBucket, number>
  vector.recall = recallTokens
  vector['raw-user'] = total - recallTokens
  return vector
}

describe('R3-0a: recall is attributed, never billed twice', () => {
  it('adding recall tokens does not change the bill', () => {
    const without = priceArm(ARM, FLASH, 0.91)
    const withRecall = priceArm({ ...ARM, recallTokens: 250_000 }, FLASH, 0.91)
    expect(withRecall.totalCost).toBe(without.totalCost)
  })

  it('Price(Σ buckets) equals Price(prompt) for every bucket layout', () => {
    // The invariant, checked across layouts that stress the recall bucket —
    // the one R2 double-charged — and across profiles with and without a
    // billable cache write.
    for (const economics of [FLASH, OPENAI]) {
      for (const recallTokens of [0, 1, 50_000, 400_000]) {
        for (const rate of [0, 0.5, 0.91, 1]) {
          const attributed = { ...ARM, buckets: buckets(ARM.promptTokens, recallTokens) }
          const fromBuckets = priceAttribution(attributed, economics, rate)
          const fromPrompt = priceArm(ARM, economics, rate)
          expect(fromBuckets.totalCost).toBeCloseTo(fromPrompt.totalCost, 12)
          expect(fromBuckets.pricedTokens).toBe(fromPrompt.pricedTokens)
        }
      }
    }
  })

  it('refuses to price an attribution that does not sum to the prompt', () => {
    const attributed = { ...ARM, buckets: buckets(ARM.promptTokens - 1, 0) }
    expect(() => priceAttribution(attributed, FLASH, 0.91)).toThrow(/different requests/u)
  })
})

describe('R3-0a: cache writes are three-state, never an invented zero', () => {
  it('a profile with no write price bills known-zero', () => {
    expect(priceArm(ARM, FLASH, 0.91).cacheWrite).toEqual({ status: 'known-zero' })
    expect(priceArm(ARM, FLASH, 0.91).incomplete).toBe(false)
  })

  it('an explicit-write profile with no measured writes is UNKNOWN, not zero', () => {
    const priced = priceArm(ARM, OPENAI, 0.91)
    expect(priced.cacheWrite).toEqual({ status: 'unknown' })
    // The distinction that matters: the bill is reported as incomplete rather
    // than silently omitting a component the provider charges for.
    expect(priced.incomplete).toBe(true)
  })

  it('a measured write count is priced and marks the bill complete', () => {
    const priced = priceArm({ ...ARM, cacheWriteTokens: 100_000 }, OPENAI, 0.91)
    expect(priced.cacheWrite.status).toBe('measured')
    if (priced.cacheWrite.status !== 'measured') throw new Error('unreachable')
    expect(priced.cacheWrite.tokens).toBe(100_000)
    expect(priced.cacheWrite.cost).toBeGreaterThan(0)
    expect(priced.incomplete).toBe(false)
    // The write is charged ON TOP of the prompt components, unlike recall.
    expect(priced.totalCost).toBeGreaterThan(priceArm(ARM, FLASH, 0.91).totalCost)
  })

  it('the same run is complete under one profile and incomplete under another', () => {
    // The bug was treating "0" as a property of the RUN. It is a property of
    // the (run, profile) pair.
    expect(priceArm(ARM, FLASH, 0.91).incomplete).toBe(false)
    expect(priceArm(ARM, OPENAI, 0.91).incomplete).toBe(true)
  })
})

describe('R3-0a: realization is per-profile evidence, not a global constant', () => {
  it('a measured assumption yields exactly one BCR point', () => {
    expect(realizationRates(MEASURED_DEEPSEEK_REALIZATION)).toEqual([0.91])
    const curve = bcrCurve(ARM, ARM, FLASH, MEASURED_DEEPSEEK_REALIZATION)
    expect(curve).toHaveLength(1)
    expect(curve[0]!.bcr).toBeCloseTo(1, 12)
  })

  it('an unmeasured model yields a BCR(h) curve, not one pseudo-precise number', () => {
    const candidate: ArmCostInput = { promptTokens: 1_200_000, warmTokens: 1_000_000, peakTokens: 50_000 }
    const basic: ArmCostInput = { promptTokens: 1_000_000, warmTokens: 700_000, peakTokens: 50_000 }
    const curve = bcrCurve(candidate, basic, OPENAI, { source: 'unknown' })
    expect(curve.map(point => point.realizationRate)).toEqual([...SCENARIO_REALIZATION_RATES])
    // Sensitivity, reported as a range: the ratio must move with h.
    const ratios = curve.map(point => point.bcr)
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeGreaterThan(0)
  })

  it('a scenario assumption is priced as a scenario', () => {
    const curve = bcrCurve(ARM, ARM, FLASH, { source: 'scenario', rate: 0.8 })
    expect(curve).toEqual([{ realizationRate: 0.8, bcr: 1 }])
  })

  it('realization moves cost monotonically: worse cache is never cheaper', () => {
    const warmHeavy: ArmCostInput = { promptTokens: 1_000_000, warmTokens: 900_000, peakTokens: 50_000 }
    const coldHeavy: ArmCostInput = { promptTokens: 500_000, warmTokens: 100_000, peakTokens: 50_000 }
    const curve = bcrCurve(warmHeavy, coldHeavy, FLASH, { source: 'unknown' })
    for (let index = 1; index < curve.length; index += 1) {
      expect(curve[index]!.bcr).toBeLessThan(curve[index - 1]!.bcr)
    }
  })
})

describe('R3-0a: UNKNOWN quality is OPEN, never a pass', () => {
  const row = (overrides: Partial<DominanceRow>): DominanceRow => ({
    workload: 'W1',
    policy: 'E3',
    profile: 'deepseek-flash-2026-09',
    basicCost: 1,
    policyCost: 0.9,
    bcr: 0.9,
    billIncomplete: false,
    quality: { status: 'unknown' },
    basicPeakTokens: 10,
    policyPeakTokens: 10,
    cheaper: true,
    dominates: false,
    ...overrides,
  })

  it('an all-cheaper matrix with no quality evidence passes cost and OPENS quality', () => {
    const matrix = dominanceMatrix([row({}), row({ workload: 'W2' })])
    expect(matrix.costGate).toBe('PASS')
    expect(matrix.qualityGate).toBe('OPEN')
    expect(matrix.qualityMeasuredCount).toBe(0)
    // The R2 report read `BQR = 1` on 40/40 as "no worse in quality". Under
    // this model that claim is unavailable, and the row says so.
    expect(matrix.notWorseCount).toBe(0)
  })

  it('a mixed matrix is OPEN, not PASS: unmeasured rows could still fail', () => {
    const matrix = dominanceMatrix([
      row({ quality: measuredQuality(15, 15) }),
      row({ workload: 'W2' }),
    ])
    expect(matrix.qualityGate).toBe('OPEN')
  })

  it('fully measured quality decides the gate', () => {
    const pass = dominanceMatrix([row({ quality: measuredQuality(15, 15) })])
    expect(pass.qualityGate).toBe('PASS')
    const fail = dominanceMatrix([row({ quality: measuredQuality(15, 13) })])
    expect(fail.qualityGate).toBe('FAIL')
  })

  it('cost gate fails when any workload is not cheaper, independent of quality', () => {
    const matrix = dominanceMatrix([
      row({}),
      row({ workload: 'W2', bcr: 1.149, cheaper: false }),
    ])
    expect(matrix.costGate).toBe('FAIL')
    expect(matrix.cheaperCount).toBe(1)
    expect(matrix.totalCount).toBe(2)
  })

  it('incomplete billing is counted and surfaced in the report', () => {
    const matrix = dominanceMatrix([row({ billIncomplete: true }), row({ workload: 'W2' })])
    expect(matrix.incompleteBillingCount).toBe(1)
    const markdown = dominanceToMarkdown(matrix)
    expect(markdown).toContain('excl. write')
    expect(markdown).toContain('Quality gate (no worse everywhere): **OPEN**')
  })
})
