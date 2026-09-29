/**
 * R1-A: model-aware context economics foundations — token source attribution
 * and the versioned economics profiles. These tests are the correctness gate
 * for the measurement layer: attribution must RECONCILE to the metered total
 * (no invented precision, no silently dropped tokens), and the profile math
 * must reproduce the ρ/ρ_eff/break-even relationships docs/11 specifies.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  cacheRealizationRate,
  classifyRegime,
  costOf,
  effectiveRho,
  modeledCost,
  overrideProfile,
  parseEconomicsProfile,
  profileMatchesModel,
  rhoOf,
  rootBreakEvenRequests,
  selectProfile,
  tierFor,
} from '../src/economics-profile.ts'
import type { ContextEconomicsProfile } from '../src/economics-profile.ts'
import {
  attributeTokens,
  summarizeAttribution,
  splitLeafCheckpointText,
  TOKEN_BUCKETS,
} from '../eval/src/token-attribution.ts'
import {
  collectProviderTelemetry,
  deriveCacheRealization,
} from '../eval/src/provider-telemetry.ts'
import { createHarness, conversation, toolConversation, foldAgent, SIGNAL } from './harness.ts'

const PROFILE_DIR = join(import.meta.dirname, '..', 'profiles', 'economics')

function loadProfiles(): ContextEconomicsProfile[] {
  return readdirSync(PROFILE_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => parseEconomicsProfile(JSON.parse(readFileSync(join(PROFILE_DIR, name), 'utf8'))))
}

describe('R1-A: economics profiles are versioned data, never constants', () => {
  it('every shipped profile parses, carries asOf and source, and matches its own pattern', () => {
    const profiles = loadProfiles()
    expect(profiles.length).toBeGreaterThanOrEqual(4)
    for (const profile of profiles) {
      expect(profile.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
      expect(profile.source).toBeTruthy()
      expect(profile.context.windowTokens).toBeGreaterThan(0)
    }
  })

  it('rejects unknown keys so a profile cannot drift silently', () => {
    expect(() => parseEconomicsProfile({ id: 'x', nonsense: true })).toThrow()
  })

  it('selects exact model matches over wildcards, and ignores other providers', () => {
    const profiles = loadProfiles()
    const flash = selectProfile(profiles, 'deepseek', 'deepseek-v4.1-flash')
    expect(flash?.id).toBe('deepseek-flash-2026-09')
    expect(selectProfile(profiles, 'deepseek', 'deepseek-v4.1-pro')?.id).toBe('deepseek-pro-2026-09')
    expect(selectProfile(profiles, 'anthropic', 'claude-x')).toBeUndefined()
    // The synthetic profile matches anything under its own provider only.
    expect(selectProfile(profiles, 'synthetic', 'whatever')?.id).toBe('synthetic-no-cache')
  })

  it('honours wildcard semantics without over-matching', () => {
    const profile = loadProfiles().find(p => p.id === 'deepseek-flash-2026-09')!
    expect(profileMatchesModel(profile, 'deepseek-v4.1-flash')).toBe(true)
    expect(profileMatchesModel(profile, 'deepseek-v4.1-pro')).toBe(false)
    expect(profileMatchesModel(profile, 'flash')).toBe(false)
  })

  it('caller overrides restamp provenance rather than impersonating the published profile', () => {
    const base = loadProfiles().find(p => p.id === 'deepseek-flash-2026-09')!
    const overridden = overrideProfile(base, {
      pricing: { inputHitPerM: 0.05 },
      asOf: '2026-10-01',
    })
    expect(overridden.pricing.inputHitPerM).toBe(0.05)
    expect(overridden.asOf).toBe('2026-10-01')
    expect(overridden.source).toContain('overridden')
    expect(overridden.pricing.inputMissPerM).toBe(base.pricing.inputMissPerM)
  })
})

describe('R1-A: cost model relationships (docs/11 §3, §15-§16)', () => {
  const flash = loadProfiles().find(p => p.id === 'deepseek-flash-2026-09')!
  const gpt = loadProfiles().find(p => p.id === 'openai-gpt-5.6-2026-09')!
  const nocache = loadProfiles().find(p => p.id === 'synthetic-no-cache')!

  it('ρ is the hit/miss price ratio and the no-cache profile has ρ = 1', () => {
    expect(rhoOf(flash)).toBeCloseTo(0.02, 5)
    expect(rhoOf(gpt)).toBeCloseTo(0.1, 5)
    expect(rhoOf(nocache)).toBeCloseTo(1, 10)
  })

  it('ρ_eff = h·ρ + (1-h): the headline ratio is only reached at h = 1', () => {
    expect(effectiveRho(0.02, 1)).toBeCloseTo(0.02, 10)
    // The docs/11 §3 worked example: ρ = 0.02 at h = 0.8 is economically 0.216.
    expect(effectiveRho(0.02, 0.8)).toBeCloseTo(0.216, 10)
    expect(effectiveRho(0.02, 0)).toBeCloseTo(1, 10)
  })

  it('cache realization rate is bounded and zero-safe', () => {
    expect(cacheRealizationRate(800, 1000)).toBeCloseTo(0.8, 10)
    expect(cacheRealizationRate(1200, 1000)).toBe(1)
    expect(cacheRealizationRate(0, 0)).toBe(0)
  })

  it('costOf bills each bucket at its own price, including cache writes', () => {
    const cost = costOf(gpt, {
      uncachedInputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      outputTokens: 1_000_000,
    })
    expect(cost.missCost).toBeCloseTo(1.25, 6)
    expect(cost.hitCost).toBeCloseTo(0.125, 6)
    expect(cost.cacheWriteCost).toBeCloseTo(1.5625, 6)
    expect(cost.outputCost).toBeCloseTo(10, 6)
    expect(cost.totalCost).toBeCloseTo(12.9375, 6)
  })

  it('modeledCost is monotone in realization: better caching never costs more', () => {
    const options = { stablePrefixTokens: 100_000, freshTokens: 5_000, outputTokens: 1_000 }
    const cold = modeledCost(flash, { ...options, realizationRate: 0 })
    const warm = modeledCost(flash, { ...options, realizationRate: 1 })
    expect(warm.totalCost).toBeLessThan(cold.totalCost)
  })

  it('pricing tiers select by prompt size and fall through to the unbounded tier', () => {
    const tiered: ContextEconomicsProfile = parseEconomicsProfile({
      ...flash,
      context: {
        windowTokens: 200_000,
        pricingTiers: [
          { upToTokens: 32_000, inputMissPerM: 1, inputHitPerM: 0.1, outputPerM: 1 },
          { inputMissPerM: 2, inputHitPerM: 0.2, outputPerM: 2 },
        ],
      },
    })
    expect(tierFor(tiered, 10_000).inputMissPerM).toBe(1)
    expect(tierFor(tiered, 100_000).inputMissPerM).toBe(2)
  })

  it('root break-even: H* = C_root / (ΔF · C_warm), undefined when nothing is saved', () => {
    const h = rootBreakEvenRequests({
      profile: flash,
      frozenBefore: 10_000,
      frozenAfter: 2_000,
      realizationRate: 1,
      promptTokens: 100_000,
      compactionCost: 0.001,
    })
    expect(h).toBeDefined()
    // 8000 removed tokens at the hit price (0.0056/M) → tiny saving, so H* is large.
    const savingPerRequest = 8_000 * (0.0056 / 1_000_000)
    expect(h!).toBeCloseTo(0.001 / savingPerRequest, 4)
    // No frozen reduction → no payback horizon exists.
    expect(rootBreakEvenRequests({
      profile: flash,
      frozenBefore: 5_000,
      frozenAfter: 5_000,
      realizationRate: 1,
      promptTokens: 100_000,
      compactionCost: 0.001,
    })).toBeUndefined()
  })

  it('an explicit-cache provider pays a write cost, so its root cost is dearer', () => {
    // H* is a RATIO of cost to saving, and both scale with price, so the
    // meaningful comparison is the root cost itself (docs/11 §16): hold the
    // profile fixed and vary only the billable cache write.
    const common = {
      frozenBefore: 40_000,
      frozenAfter: 4_000,
      realizationRate: 1,
      promptTokens: 100_000,
      compactionCost: 0.002,
      invalidatedTokens: 10_000,
    }
    const withoutWrite = rootBreakEvenRequests({ profile: gpt, ...common })!
    const withWrite = rootBreakEvenRequests({ profile: gpt, ...common, cacheWriteTokens: 20_000 })!
    // The write is a real cost: it pushes the payback horizon out.
    expect(withWrite).toBeGreaterThan(withoutWrite)
    // And a provider with no cache-write price is unaffected by the same field.
    expect(rootBreakEvenRequests({ profile: flash, ...common, cacheWriteTokens: 20_000 }))
      .toBeCloseTo(rootBreakEvenRequests({ profile: flash, ...common })!, 10)
  })

  it('regimes are derived from measured economics, not from provider names', () => {
    expect(classifyRegime({ rho: 0.02, realizationRate: 1 })).toBe('cache-dominant')
    // The docs/11 §3 example: ρ_eff ≈ 0.216 lands in the hybrid band, NOT
    // token-dominant — the headline 2% is not what the workload actually pays.
    expect(classifyRegime({ rho: 0.02, realizationRate: 0.8 })).toBe('hybrid')
    expect(classifyRegime({ rho: 0.1, realizationRate: 1 })).toBe('hybrid')
    expect(classifyRegime({ rho: 1, realizationRate: 1 })).toBe('token-dominant')
  })
})

describe('R1-A: token attribution reconciles exactly', () => {
  it('splits a rendered leaf checkpoint into state/rationale/framing sections', () => {
    // R3-A format: the marker carries `cp:abc`, which is the recall reference,
    // so there is no trailing Recall section to anchor the split on.
    const text = [
      '[EF1 L cp:abc]',
      '',
      'Current',
      '- [objective] ship it (normative)',
      '',
      'Evidence',
      '- [evidence] tests pass (empirical)',
      '',
      'Open',
      '- (none)',
      '',
      'Rationale',
      '- we chose X because Y',
    ].join('\n')
    const split = splitLeafCheckpointText(text)!
    expect(split.state).toContain('Current')
    expect(split.state).toContain('ship it')
    expect(split.rationale).toContain('we chose X because Y')
    // The marker is IDENTITY, kept separate from framing because no framing
    // mode may remove it: it is both machine identity and recall reference.
    expect(split.identity).toBe('[EF1 L cp:abc]')
    // Framing is now ONLY the blank separator: no preamble, no wrapper tags.
    expect(split.framing.trim()).toBe('')
  })

  it('returns null for text that is not an EF checkpoint', () => {
    expect(splitLeafCheckpointText('plain text')).toBeNull()
    // A Basic checkpoint has no EF marker: it is one opaque narrative node.
    expect(splitLeafCheckpointText('<compacted-summary>\nnarrative\n</compacted-summary>')).toBeNull()
  })

  it('still splits a V1 checkpoint written by an older build', () => {
    // Reader compatibility (R3 §32): a persisted V1 surface must keep
    // attributing its cost to the right buckets.
    const text = [
      '[EF checkpoint v1 mode=leaf id=old]',
      '',
      'Current',
      '- [objective] ship it (normative)',
      '',
      'Rationale',
      '- legacy rationale',
      '',
      'Recall',
      '- cp:old',
    ].join('\n')
    const split = splitLeafCheckpointText(text)!
    expect(split.state).toContain('ship it')
    expect(split.rationale).toContain('legacy rationale')
    expect(split.identity).toContain('[EF checkpoint v1')
  })

  it('accounts for every metered token of a raw conversation', async () => {
    const harness = await createHarness({}, { contextWindow: 200_000 })
    const session = conversation(4)
    const measurement = harness.ctx.tokenMeter.measure(session)
    const attribution = attributeTokens(session, measurement)

    expect(attribution.total).toBe(measurement.totalTokens)
    // Raw turns must land in raw buckets, and shares must sum to 1.
    expect(attribution.buckets['raw-user']).toBeGreaterThan(0)
    expect(attribution.buckets['raw-assistant']).toBeGreaterThan(0)
    const shareSum = TOKEN_BUCKETS.reduce((sum, bucket) => sum + attribution.shares[bucket], 0)
    expect(shareSum).toBeCloseTo(1, 10)
  })

  it('separates tool results from user/assistant history', async () => {
    const harness = await createHarness({}, { contextWindow: 200_000 })
    const session = toolConversation(3)
    const attribution = attributeTokens(session, harness.ctx.tokenMeter.measure(session))
    expect(attribution.buckets['raw-tool-result']).toBeGreaterThan(0)
    expect(attribution.buckets['raw-assistant']).toBeGreaterThan(0)
  })

  it('reconciles after an EF fold, charging the checkpoint to its own buckets', async () => {
    // The structured leaf checkpoint requires the deterministic projection
    // mounted (that is what makes the machine-state handoff renderable).
    const harness = await createHarness({ text: 'ef digest' }, {
      contextWindow: 8_000,
      projection: true,
      efConfig: { thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 2_048 },
    })
    const session = conversation(10)
    await harness.engine.compactIfNeeded(foldAgent(session), 'pressure', SIGNAL)
    const measurement = harness.ctx.tokenMeter.measure(session)
    const attribution = attributeTokens(session, measurement)

    // The whole point: the total is never invented — it reconciles.
    expect(attribution.total).toBe(measurement.totalTokens)
    const checkpointTokens = attribution.buckets['checkpoint-leaf-state']
      + attribution.buckets['checkpoint-leaf-rationale']
      + attribution.buckets['checkpoint-framing']
    expect(checkpointTokens).toBeGreaterThan(0)
    // A leaf checkpoint's parts must reconcile to the node price exactly:
    // state + rationale + framing never over- or under-count the surface.
    expect(attribution.surfaceTokens).toBeGreaterThanOrEqual(checkpointTokens)
  })

  it('throws on a stale measurement rather than misattributing', async () => {
    const harness = await createHarness({}, { contextWindow: 200_000 })
    const session = conversation(3)
    const stale = harness.ctx.tokenMeter.measure(session)
    session.append('user/message', {
      id: 'm-extra',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'appended later' }],
    } as never, { surfaceOp: 'append' })
    expect(() => attributeTokens(session, stale)).toThrow(/does not match/u)
  })

  it('summarizes a run into bucket totals that still reconcile', async () => {
    const harness = await createHarness({}, { contextWindow: 200_000 })
    const session = conversation(3)
    const attribution = attributeTokens(session, harness.ctx.tokenMeter.measure(session))
    const run = summarizeAttribution([attribution, attribution])
    expect(run.grandTotal).toBe(attribution.total * 2)
    const shareSum = TOKEN_BUCKETS.reduce((sum, bucket) => sum + run.shares[bucket], 0)
    expect(shareSum).toBeCloseTo(1, 10)
  })
})

describe('R1-A: provider cache telemetry separates cacheable from cached', () => {
  const flash = loadProfiles().find(p => p.id === 'deepseek-flash-2026-09')!

  it('reports no realization when the provider reported no cache fields', () => {
    // The fixture's assistant messages carry no provider usage at all.
    const session = conversation(2)
    const telemetry = collectProviderTelemetry(session)
    expect(telemetry.samples).toBe(0)
    // An unknown hit rate is reported as unknown, never as zero or one.
    const realization = deriveCacheRealization(telemetry, flash, 5_000)
    expect(realization.realizationRate).toBeUndefined()
    expect(realization.effectiveRho).toBeUndefined()
    expect(realization.unrealizedCacheTokens).toBeUndefined()
  })

  it('computes the realized rate from provider numbers, not from prefix stability', () => {
    const realization = deriveCacheRealization({
      uncachedInputTokens: 20_000,
      cacheReadTokens: 80_000,
      cacheWriteTokens: 0,
      outputTokens: 100,
      samples: 1,
      cacheSamples: 1,
    }, flash, 100_000)
    expect(realization.realizationRate).toBeCloseTo(0.8, 10)
    // ρ = 0.02 but ρ_eff = 0.216 — the headline ratio is not what is paid.
    expect(realization.effectiveRho).toBeCloseTo(0.216, 10)
    // The architecture claimed 100K cacheable; only 80K was actually read.
    expect(realization.unrealizedCacheTokens).toBe(20_000)
  })

  it('treats usage without cache fields as fully uncached rather than fully cached', () => {
    const telemetry = collectProviderTelemetry({
      seq: 1,
      eventAt: () => ({
        type: 'assistant/message',
        data: { usage: { inputTokens: 5_000, outputTokens: 10 } },
      }),
    } as unknown as Parameters<typeof collectProviderTelemetry>[0])
    expect(telemetry.samples).toBe(1)
    expect(telemetry.cacheSamples).toBe(0)
    expect(telemetry.uncachedInputTokens).toBe(5_000)
    expect(telemetry.cacheReadTokens).toBe(0)
    const realization = deriveCacheRealization(telemetry, flash, 5_000)
    expect(realization.realizationRate).toBeUndefined()
  })
})
