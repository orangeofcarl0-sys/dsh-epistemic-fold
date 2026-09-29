/**
 * RC1-A: the trigger is normalized, and the safety reserve is measured.
 *
 * Two claims are pinned here, and both are the kind that can quietly be false:
 *
 * 1. The breakdown AGREES with the engine's own threshold. If it ever drifts,
 *    the diagnostic becomes a confident wrong answer — worse than none.
 * 2. On the shipped defaults the reserve binds, so `thresholdRatio` does not
 *    describe the behavior. That is the RC0 finding restated as an assertion so
 *    a future change to `headroomTokens` cannot silently un-state it.
 */

import { describe, expect, it } from 'vitest'
import { resolveEfCompactSpec, resolveEfConfig } from '../src/policy.ts'
import { headroomDominates, triggerBreakdown, triggerBreakdownToText } from '../src/trigger.ts'
import { describeEffectiveConfig } from '../src/effective-config.ts'
import {
  distributionOf,
  judgeReserve,
  meterErrors,
  recommendSafetyReserve,
  stepGrowths,
} from '../eval/src/safety-reserve.ts'

const DEEPSEEK_WINDOW = 131_072
const RESERVED = 512

describe('RC1-A: trigger breakdown names the binding constraint', () => {
  it('agrees with the engine spec on every configuration it is asked about', () => {
    const configs = [
      {},
      { mode: 'economy' as const },
      { thresholdRatio: 0.5 },
      { headroomTokens: 0 },
      { headroomTokens: 8_192 },
      { thresholdRatio: 0.95, headroomTokens: 1_024 },
    ]
    const windows = [8_192, 65_536, DEEPSEEK_WINDOW, 400_000]
    let compared = 0
    for (const config of configs) {
      const resolved = resolveEfConfig(config)
      for (const window of windows) {
        // A window too small for the reservation plus reserve is a legitimate
        // configuration ERROR, and both paths must reject it — so the pairing
        // claim only applies where a spec exists at all.
        let spec: ReturnType<typeof resolveEfCompactSpec>
        try {
          spec = resolveEfCompactSpec(resolved, window, RESERVED)
        } catch {
          expect(() => triggerBreakdown(resolved, window, RESERVED)).toThrow(/no pressure budget/u)
          continue
        }
        const breakdown = triggerBreakdown(resolved, window, RESERVED)
        // The whole point of delegating: one arithmetic, two views.
        expect(breakdown.effectiveThreshold).toBe(spec.thresholdTokens)
        expect(breakdown.retainTokens).toBe(spec.retainTokens)
        expect(breakdown.effectiveThreshold)
          .toBe(Math.min(breakdown.ratioThreshold, breakdown.capacityThreshold))
        compared += 1
      }
    }
    // Guard against the loop silently comparing nothing.
    expect(compared).toBeGreaterThan(10)
  })

  it('reports the shipped defaults as HEADROOM-BOUND, not ratio-bound', () => {
    // The RC0 finding, as an assertion. On the routed 131072-token window the
    // shipped 65536-token reserve limits folding long before the 0.8 ratio does.
    const breakdown = triggerBreakdown(resolveEfConfig({}), DEEPSEEK_WINDOW, RESERVED)
    expect(breakdown.binding).toBe('headroom')
    expect(headroomDominates(breakdown)).toBe(true)
    expect(breakdown.ratioThreshold).toBe(104_857)
    expect(breakdown.capacityThreshold).toBe(65_024)
    expect(breakdown.effectiveThreshold).toBe(65_024)
    // And the number a reader would have believed: 80% configured, 49.6% real.
    expect(breakdown.thresholdRatio).toBe(0.8)
    expect(breakdown.effectiveRatio).toBeLessThan(0.5)
  })

  it('reports ratio as binding once the reserve stops limiting', () => {
    // With the reserve reduced, the configured ratio is what governs — which is
    // the condition under which `thresholdRatio` finally means what it says.
    const breakdown = triggerBreakdown(
      resolveEfConfig({ headroomTokens: 4_096 }),
      DEEPSEEK_WINDOW,
      RESERVED,
    )
    expect(breakdown.binding).toBe('ratio')
    expect(breakdown.effectiveThreshold).toBe(104_857)
    expect(breakdown.effectiveRatio).toBeCloseTo(0.8, 3)
  })

  it('treats an exact tie as ratio-bound, because the reserve is not the limiter', () => {
    // window 100000, ratio 0.5 → 50000; headroom 49000, reserved 1000 → 50000.
    const breakdown = triggerBreakdown(
      resolveEfConfig({ thresholdRatio: 0.5, headroomTokens: 49_000 }),
      100_000,
      1_000,
    )
    expect(breakdown.ratioThreshold).toBe(50_000)
    expect(breakdown.capacityThreshold).toBe(50_000)
    expect(breakdown.binding).toBe('ratio')
  })

  it('prints the ratio-bound, headroom-bound, and effective lines', () => {
    const text = triggerBreakdownToText(triggerBreakdown(resolveEfConfig({}), DEEPSEEK_WINDOW, RESERVED))
    expect(text).toContain('Configured thresholdRatio: 0.80')
    expect(text).toContain('Ratio-bound threshold:     104,857')
    expect(text).toContain('Headroom-bound threshold:  65,024')
    expect(text).toContain('Effective threshold:       65,024')
    expect(text).toContain('Binding constraint:        headroom')
    expect(text).toContain('Effective window fraction: 49.6%')
  })

  it('surfaces the breakdown through the effective-config preflight', () => {
    const effective = describeEffectiveConfig({}, undefined, {
      contextWindow: DEEPSEEK_WINDOW,
      reservedCompletionTokens: RESERVED,
    })
    expect(effective.trigger?.binding).toBe('headroom')
    expect(effective.trigger?.effectiveThreshold).toBe(65_024)
    // Without a capacity there is no breakdown at all — never an assumed one.
    const blind = describeEffectiveConfig({})
    expect(blind.trigger).toBeUndefined()
  })
})

describe('RC1-A: the safety reserve is measured, not guessed', () => {
  it('keeps meter error SIGNED and reserves only its positive tail', () => {
    // A meter that over-estimates is conservative and needs no reserve; a meter
    // that under-estimates does. Averaging the two would hide both.
    const observations = [
      { meteredTokens: 1_000, providerPromptTokens: 1_050 },
      { meteredTokens: 1_000, providerPromptTokens: 900 },
      { meteredTokens: 1_000, providerPromptTokens: 1_000 },
    ]
    const errors = meterErrors(observations).map(entry => entry.value)
    expect(errors).toEqual([50, -100, 0])
    const distribution = distributionOf(errors)
    expect(distribution.p50).toBe(0)
    expect(distribution.max).toBe(50)
    expect(distribution.min).toBe(-100)
    // The reserve term is the positive tail, and it is positive.
    expect(distribution.p99Positive).toBeGreaterThan(0)
  })

  it('counts one-step growth as POSITIVE only, so a fold cannot cancel a burst', () => {
    // A negative step (a fold) must not offset a positive burst, or the reserve
    // would be derived from the average rather than from the worst case.
    expect(stepGrowths([1_000, 4_000, 500, 6_000])).toEqual([3_000, 0, 5_500])
  })

  it('refuses to recommend a reserve it has no evidence for', () => {
    const empty = distributionOf([])
    const recommended = recommendSafetyReserve(empty, empty)
    // The number is the margin alone, and the verdict says so rather than
    // declaring the shipped reserve excessive on no evidence.
    expect(recommended.evidenced).toBe(false)
    expect(recommended.recommendedTokens).toBe(1_024)
    const verdict = judgeReserve(recommended, 65_536)
    expect(verdict.verdict).toBe('insufficient')
    expect(verdict.evidenced).toBe(false)
    expect(verdict.reason).toContain('do not change it on this basis')
  })

  it('bands the shipped reserve when the measurement IS evidenced', () => {
    const meterError = distributionOf([10, 20, 30, 40, 50])
    const growth = distributionOf([100, 200, 300, 400, 500])
    const recommended = recommendSafetyReserve(meterError, growth, 1_024)
    expect(recommended.evidenced).toBe(true)
    // P99 interpolates within 5 samples rather than taking the max: growth
    // 496 + meter error 49.6 + margin 1024 = 1569.6, rounded up.
    expect(recommended.recommendedTokens).toBe(1_570)

    // 65K against a ~1.6K measurement is far past `generous`.
    expect(judgeReserve(recommended, 65_536).verdict).toBe('excessive')
    // A reserve near the measurement is justified.
    expect(judgeReserve(recommended, 1_600).verdict).toBe('justified')
    // And one below it is insufficient, not merely "small".
    expect(judgeReserve(recommended, 900).verdict).toBe('insufficient')
  })

  it('states the recommendation in terms of its three terms', () => {
    const meterError = distributionOf([100, 100, 100])
    const growth = distributionOf([2_000, 2_000, 2_000])
    const recommended = recommendSafetyReserve(meterError, growth, 1_024)
    expect(recommended.note).toContain('P99 meter underestimation 100')
    expect(recommended.note).toContain('P99 one-step growth 2000')
    expect(recommended.note).toContain('margin 1024')
  })
})
