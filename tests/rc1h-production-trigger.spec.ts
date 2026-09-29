/**
 * RC1 §12/§16, applied to the PRODUCTION window: the trigger's effect on cost.
 *
 * The RC1-B scan ran on traces observed at a small window, and it found a broad
 * plateau with `alpha = 0.8` recommended. That answer is correct for the traces
 * it was taken on — and it is NOT the whole story at the window the product
 * actually runs, which is what this suite measures.
 *
 * The finding, and it inverts a plausible reading of RC1-A:
 *
 *   At a 131072-token window, cost falls MONOTONICALLY as the effective
 *   threshold falls. The shipped 65536-token reserve — which RC1-A measured as
 *   6.73x larger than the route needs — does not hurt; it HELPS, because it
 *   lowers the effective trigger from 80% of the window to 49.6%.
 *
 * So "the reserve is excessive" and "the reserve should be reduced" are
 * different claims, and the second does not follow from the first. Reducing the
 * reserve to its measured value RAISES the effective threshold to the ratio
 * bound and makes the policy *more* expensive at this window.
 *
 * The reserve's job is safety. The trigger's job is economy. They are being
 * served by one number today, and this suite measures what that costs — which is
 * a configuration finding for the release decision, not a mechanism change.
 *
 * @module tests/rc1h-production-trigger
 */

import { describe, expect, it } from 'vitest'
import { BUILTIN_ECONOMICS_PROFILES, resolveProfile } from '../src/economics-profile.ts'
import { triggerBreakdown } from '../src/trigger.ts'
import { resolveEfConfig } from '../src/policy.ts'
import { replayPaired } from '../eval/policy-replay/simulator.ts'
import { syntheticTrace } from '../eval/policy-replay/trace.ts'

const PROFILE = resolveProfile(BUILTIN_ECONOMICS_PROFILES, 'deepseek', 'deepseek-v4.1-flash')
const WINDOW = 131_072
const RESERVED = 512
/** The measured checkpoint size: marker-only, as RC1-B observed. */
const CHECKPOINT_TOKENS = 20
/** Per-turn growth of the production-shaped trajectory. */
const GROWTH_PER_TURN = 3_800

/**
 * A production-shaped trace: the real window, the real growth, marker-only
 * checkpoints.
 *
 * Synthetic because no live run reaches this shape within a sane budget, and
 * declared so on the trace — RC1 §20's rule for the state-rich regime, applied
 * here to the production one.
 */
function productionTrace() {
  return syntheticTrace('production-shape', {
    steps: 60,
    growthTokens: GROWTH_PER_TURN,
    contextWindow: WINDOW,
    reservedCompletionTokens: RESERVED,
    declaredCheckpointTokens: CHECKPOINT_TOKENS,
  })
}

/** Replay one effective threshold and return the paired ratio. */
function ratioAt(effectiveThreshold: number): number {
  const policy = {
    config: {
      leafAdmission: 'economic' as const,
      rootPolicy: 'economics' as const,
      semanticMode: 'none' as const,
      thresholdRatio: effectiveThreshold / WINDOW,
      headroomTokens: 0,
      // Scaled with the threshold, because the product REFUSES a retention
      // budget that is not below it — a correct guard that a sweep must respect
      // rather than work around.
      retainTokens: Math.floor(effectiveThreshold * 0.16),
    },
    contextWindow: WINDOW,
    reservedCompletionTokens: RESERVED,
    realizationRate: 0.9,
    fallbackCheckpointTokens: CHECKPOINT_TOKENS,
    basicCheckpointTokens: 400,
    outputTokensPerRequest: 200,
    idleMaintenance: true,
  }
  return replayPaired(productionTrace(), policy, PROFILE).costRatio
}

describe('RC1: the shipped reserve is lowering the trigger, and that is a BENEFIT', () => {
  it('cost falls monotonically as the effective threshold falls', () => {
    // The measured relationship. Each point is a full paired replay against
    // Basic on the same trajectory, so the ratio is comparable across points.
    const points = [104_857, 65_024, 50_000, 39_321, 26_000, 20_000, 16_000, 12_000, 8_000]
    const ratios = points.map(effective => ({ effective, ratio: ratioAt(effective) }))
    for (const point of ratios) {
      console.log(
        `TRIGGER effective=${point.effective} (${((point.effective / WINDOW) * 100).toFixed(1)}%) `
        + `-> ratio ${point.ratio.toFixed(4)}`,
      )
    }
    // Strict monotonicity: every lower threshold is cheaper than the one above.
    for (let index = 1; index < ratios.length; index += 1) {
      expect(
        ratios[index]!.ratio,
        `a lower effective threshold (${ratios[index]!.effective}) must not cost more than `
        + `${ratios[index - 1]!.effective}`,
      ).toBeLessThan(ratios[index - 1]!.ratio)
    }
    // And the endpoints are far apart, so the effect is large rather than
    // marginal — this is not a fourth-decimal parameter question.
    expect(ratios[0]!.ratio).toBeGreaterThan(0.9)
    expect(ratios[ratios.length - 1]!.ratio).toBeLessThan(0.6)
  })

  it('the SHIPPED reserve beats the MEASURED reserve at this window', () => {
    // The inversion, stated as a comparison. RC1-A measured the route as needing
    // a 9,733-token reserve; installing it would raise the effective threshold
    // from 65024 to 104857 and make the policy more expensive.
    const shipped = triggerBreakdown(resolveEfConfig({ mode: 'economy' }), WINDOW, RESERVED)
    const measured = triggerBreakdown(
      resolveEfConfig({ mode: 'economy', headroomTokens: 9_733 }), WINDOW, RESERVED,
    )
    expect(shipped.binding).toBe('headroom')
    expect(shipped.effectiveThreshold).toBe(65_024)
    expect(measured.binding).toBe('ratio')
    expect(measured.effectiveThreshold).toBe(104_857)

    const shippedRatio = ratioAt(shipped.effectiveThreshold)
    const measuredRatio = ratioAt(measured.effectiveThreshold)
    console.log(
      `RESERVE shipped(${shipped.effectiveThreshold}) ratio ${shippedRatio.toFixed(4)} vs `
      + `measured(${measured.effectiveThreshold}) ratio ${measuredRatio.toFixed(4)}`,
    )
    expect(
      shippedRatio,
      'the shipped reserve lowers the trigger, and a lower trigger is cheaper here',
    ).toBeLessThan(measuredRatio)
  })

  it('both configurations remain window-safe and overflow-free', () => {
    // The reason the lower threshold is affordable at all: the peak stays inside
    // the window. A cheaper policy that overflowed would not be cheaper.
    for (const effective of [104_857, 65_024, 39_321, 20_000]) {
      const policy = {
        config: {
          leafAdmission: 'economic' as const,
          rootPolicy: 'economics' as const,
          semanticMode: 'none' as const,
          thresholdRatio: effective / WINDOW,
          headroomTokens: 0,
          retainTokens: Math.floor(effective * 0.16),
        },
        contextWindow: WINDOW,
        reservedCompletionTokens: RESERVED,
        realizationRate: 0.9,
        fallbackCheckpointTokens: CHECKPOINT_TOKENS,
        basicCheckpointTokens: 400,
        outputTokensPerRequest: 200,
        idleMaintenance: true,
      }
      const paired = replayPaired(productionTrace(), policy, PROFILE)
      expect(paired.candidate.overflowEvents, `threshold ${effective} must not overflow`).toBe(0)
      expect(paired.candidate.peakPromptTokens).toBeLessThanOrEqual(WINDOW)
      // And the cadence stays sane: no fold-every-step loop at any of these.
      expect(paired.candidate.longestFoldRun).toBeLessThan(5)
    }
  })
})
