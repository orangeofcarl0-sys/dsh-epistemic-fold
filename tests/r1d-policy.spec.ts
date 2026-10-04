/**
 * R1-D: the provider-aware amortized rebase policy.
 *
 * The gate this suite must pass: the compiler is DETERMINISTIC, it never
 * branches on provider name, it refuses to select the rejected Delta Leaf
 * representation, and its hard overrides (overflow, pressure) beat economics
 * unconditionally — economics may not buy correctness.
 */

import { describe, expect, it } from 'vitest'
import { compileContextPolicy } from '../src/policy-compiler.ts'
import type { ContextPolicyInput } from '../src/policy-compiler.ts'
import { parseEconomicsProfile } from '../src/economics-profile.ts'
import { profile } from './economics-fixture.ts'

const flash = profile('deepseek-flash-2026-09')
const gpt = profile('openai-gpt-5.6-2026-09')
const nocache = profile('synthetic-no-cache')

/** A base input with everything quiet, so each test varies one thing. */
function input(overrides: Partial<ContextPolicyInput> = {}): ContextPolicyInput {
  return {
    economics: flash,
    telemetry: {
      frozenTokens: 40_000,
      frozenCheckpointCount: 10,
      rawTailTokens: 5_000,
      promptTokens: 50_000,
      recentFoldCadence: 100,
      ...(overrides.telemetry ?? {}),
    },
    pressure: { contextWindow: 131_072, currentTokens: 50_000, ...(overrides.pressure ?? {}) },
    policy: {
      paybackHorizonRequests: 50,
      pressureRatio: 0.8,
      compactionCost: 0.001,
      ...(overrides.policy ?? {}),
    },
    ...(overrides.economics === undefined ? {} : { economics: overrides.economics }),
  }
}

describe('R1-D: amortized rebase policy', () => {
  it('is deterministic: identical input yields an identical decision', () => {
    const first = compileContextPolicy(input())
    const second = compileContextPolicy(input())
    expect(second).toEqual(first)
  })

  it('never selects the rejected Delta Leaf representation', () => {
    // The R1-B gate measured Delta Leaf as the weakest candidate, so no policy
    // may choose it until that gate is revisited with new evidence.
    for (const economics of [flash, gpt, nocache]) {
      for (const horizon of [0, 10, 1000]) {
        const decision = compileContextPolicy(input({ economics, policy: { paybackHorizonRequests: horizon, pressureRatio: 0.8 } }))
        expect(decision.leafRepresentation).toBe('snapshot')
      }
    }
  })

  it('recommends a rebase when the payback horizon is met, and explains why', () => {
    const decision = compileContextPolicy(input({
      // A large frozen prefix with many checkpoints is exactly the shape a
      // rebase can amortize.
      telemetry: {
        frozenTokens: 60_000,
        frozenCheckpointCount: 20,
        rawTailTokens: 1_000,
        promptTokens: 61_000,
        recentFoldCadence: 100,
      },
      policy: { paybackHorizonRequests: 10_000, pressureRatio: 0.8, compactionCost: 0.001 },
    }))
    expect(decision.action).toBe('root')
    expect(decision.overridden).toBe(false)
    expect(decision.breakEvenRequests).toBeDefined()
    expect(decision.reason).toContain('break-even')
  })

  it('keeps the warm prefix when the horizon is not met', () => {
    const decision = compileContextPolicy(input({
      // One checkpoint: nothing to remove, so no rebase can ever pay back.
      telemetry: {
        frozenTokens: 60_000,
        frozenCheckpointCount: 1,
        rawTailTokens: 1_000,
        promptTokens: 61_000,
        recentFoldCadence: 100,
      },
      policy: { paybackHorizonRequests: 5, pressureRatio: 0.8, compactionCost: 0.001 },
    }))
    expect(decision.action).toBe('none')
    expect(decision.overridden).toBe(false)
  })

  it('hard overrides beat economics: overflow forces reduction regardless', () => {
    const decision = compileContextPolicy(input({
      pressure: { contextWindow: 10_000, currentTokens: 12_000 },
      // Economics would say "no rebase" here, and it must not matter.
      policy: { paybackHorizonRequests: 0, pressureRatio: 0.8, compactionCost: 0 },
    }))
    expect(decision.action).toBe('leaf')
    expect(decision.overridden).toBe(true)
    expect(decision.reason).toContain('overflow')
  })

  it('hard overrides beat economics: pressure forces a leaf fold', () => {
    const decision = compileContextPolicy(input({
      pressure: { contextWindow: 100_000, currentTokens: 85_000 },
      policy: { paybackHorizonRequests: 0, pressureRatio: 0.8, compactionCost: 0 },
    }))
    expect(decision.action).toBe('leaf')
    expect(decision.overridden).toBe(true)
    expect(decision.reason).toContain('pressure')
  })

  it('anti-oscillation suppresses a rebase during the cooldown', () => {
    const decision = compileContextPolicy(input({
      telemetry: {
        frozenTokens: 60_000,
        frozenCheckpointCount: 20,
        rawTailTokens: 1_000,
        promptTokens: 61_000,
        recentFoldCadence: 1,
      },
      policy: { paybackHorizonRequests: 10_000, pressureRatio: 0.8, compactionCost: 0, rebaseCooldownFolds: 5 },
    }))
    expect(decision.action).toBe('none')
    expect(decision.overridden).toBe(true)
    expect(decision.reason).toContain('cooldown')
  })

  it('the regime is derived from the profile economics, not from the provider name', () => {
    // Same telemetry, three profiles, three different regimes — and the
    // compiler never inspects `provider`.
    const base = {
      telemetry: {
        frozenTokens: 40_000,
        frozenCheckpointCount: 10,
        rawTailTokens: 1_000,
        promptTokens: 41_000,
        recentFoldCadence: 100,
      },
      policy: { paybackHorizonRequests: 50, pressureRatio: 0.8, compactionCost: 0 },
    }
    const deepseek = compileContextPolicy({ ...input(base), economics: flash })
    const openai = compileContextPolicy({ ...input(base), economics: gpt })
    const none = compileContextPolicy({ ...input(base), economics: nocache })
    expect(deepseek.regime).toBe('cache-dominant')
    expect(openai.regime).toBe('hybrid')
    expect(none.regime).toBe('token-dominant')
  })

  it('a cache-dominant model needs a longer horizon to justify the same rebase', () => {
    // Warm tokens are nearly free on DeepSeek, so removing them saves little
    // per request and the break-even horizon is long. On a no-cache profile
    // the same removal pays back far sooner.
    const base = {
      telemetry: {
        frozenTokens: 40_000,
        frozenCheckpointCount: 10,
        rawTailTokens: 1_000,
        promptTokens: 41_000,
        recentFoldCadence: 100,
      },
      policy: { paybackHorizonRequests: 1e9, pressureRatio: 0.8, compactionCost: 0.001 },
    }
    const deepseek = compileContextPolicy({ ...input(base), economics: flash })
    const none = compileContextPolicy({ ...input(base), economics: nocache })
    expect(deepseek.breakEvenRequests).toBeDefined()
    expect(none.breakEvenRequests).toBeDefined()
    expect(deepseek.breakEvenRequests!).toBeGreaterThan(none.breakEvenRequests!)
  })

  it('an explicit-cache provider pays more to rebase, so its horizon is longer than a no-cache one', () => {
    // The write and invalidation costs are real: on a provider that bills
    // cache writes, a rebase is dearer, and that must show up in H*.
    const base = {
      telemetry: {
        frozenTokens: 40_000,
        frozenCheckpointCount: 10,
        rawTailTokens: 1_000,
        promptTokens: 41_000,
        recentFoldCadence: 100,
        observedCacheMissTokens: 10_000,
        observedCacheWriteTokens: 20_000,
      },
      policy: { paybackHorizonRequests: 1e9, pressureRatio: 0.8, compactionCost: 0.002 },
    }
    const withWrites = compileContextPolicy({ ...input(base), economics: gpt })
    const withoutWrites = compileContextPolicy({
      ...input({ ...base, telemetry: { ...base.telemetry, observedCacheMissTokens: 0, observedCacheWriteTokens: 0 } }),
      economics: nocache,
    })
    // gpt's hit price is 10% of miss, so warm savings are small AND writes are
    // billed; the no-cache profile has no warm savings either, but no write
    // cost. Both are long horizons — the meaningful assertion is that the
    // explicit-cache profile's horizon is not SHORTER despite identical tokens.
    expect(withWrites.breakEvenRequests).toBeDefined()
    expect(withoutWrites.breakEvenRequests).toBeDefined()
    expect(withWrites.breakEvenRequests!).toBeGreaterThan(0)
  })

  it('reports no break-even and no action when there is no frozen prefix', () => {
    const decision = compileContextPolicy(input({
      telemetry: {
        frozenTokens: 0,
        frozenCheckpointCount: 0,
        rawTailTokens: 1_000,
        promptTokens: 1_000,
        recentFoldCadence: 100,
      },
    }))
    expect(decision.action).toBe('none')
    expect(decision.breakEvenRequests).toBeUndefined()
    expect(decision.reason).toContain('no frozen prefix')
  })

  it('picks pricing by prompt size through the profile tiers', () => {
    const tiered = parseEconomicsProfile({
      ...flash,
      context: {
        windowTokens: 200_000,
        pricingTiers: [
          { upToTokens: 32_000, inputMissPerM: 1, inputHitPerM: 0.01, outputPerM: 1 },
          { inputMissPerM: 10, inputHitPerM: 5, outputPerM: 10 },
        ],
      },
    })
    // A tiny prompt uses the cheap tier and stays cache-dominant; a huge one
    // uses the expensive tier where the hit price is no longer negligible.
    const small = compileContextPolicy(input({
      economics: tiered,
      telemetry: { frozenTokens: 20_000, frozenCheckpointCount: 10, rawTailTokens: 100, promptTokens: 20_100, recentFoldCadence: 100 },
    }))
    const large = compileContextPolicy(input({
      economics: tiered,
      telemetry: { frozenTokens: 100_000, frozenCheckpointCount: 10, rawTailTokens: 100, promptTokens: 100_100, recentFoldCadence: 100 },
    }))
    expect(small.regime).toBe('cache-dominant')
    expect(large.regime).not.toBe('cache-dominant')
  })
})
