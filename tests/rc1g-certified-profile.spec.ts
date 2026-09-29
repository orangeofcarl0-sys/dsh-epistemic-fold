/**
 * RC1-G: certification is a claim with provenance, and its absence is explicit.
 *
 * The failure this guards against is the quiet one: a profile that applies
 * everywhere because nothing said it shouldn't. RC1 §35 is explicit that an
 * uncertified route keeps its current behavior, so `certifiedProfileFor`
 * returns `undefined` and `recommendedMode` answers `legacy` — never `economy`
 * — for anything unmeasured.
 *
 * Every claim is also labeled by how it was established. A safety reserve
 * inherited from a shipped default and one measured for the route are different
 * strengths of claim, and a type that conflated them would let the first be
 * reported as the second.
 */

import { describe, expect, it } from 'vitest'
import {
  certifiedProfileFor,
  certifyRoute,
  profileToMarkdown,
  recommendedMode,
} from '../eval/src/certified-profile.ts'
import type { CertifiedEconomyProfile } from '../eval/src/certified-profile.ts'

/** The DeepSeek route RC1 actually measured. */
function measuredProfile(): CertifiedEconomyProfile {
  return certifyRoute({
    provider: 'deepseek',
    modelPattern: 'deepseek-*flash*',
    asOf: '2026-09-29',
    thresholdRatio: 0.8,
    headroomTokens: 9_733,
    headroomSource: 'rc1a-live-reserve: P99 meter underestimation 8017 + P99 one-step growth 691 + margin 1024',
    cacheMode: 'automatic',
    prefixDeterministic: {
      value: true,
      source: 'rc1d-cache-contract: two assemblies of the same state are byte-identical',
    },
    reuseRatio: {
      value: 1.0,
      source: 'rc1e-live-cache: ABBA counterbalanced, comparable prompt sizes',
    },
    priceEffect: {
      realizedRatio: 1.0,
      source: 'rc1e-live-cache: structural baseline at comparable shape',
    },
    qualitySource: 'r4e-live-noninferiority + rc1f-fold-smoke: 20/20 and 3/3 facts across folds',
  })
}

describe('RC1-G: a route is certified only from evidence, never by default', () => {
  it('certifies the measured route and names every claim source', () => {
    const profile = measuredProfile()
    expect(profile.certified).toBe(true)
    expect(profile.gaps).toEqual([])
    // Every load-bearing claim carries provenance.
    expect(profile.cache.prefixDeterministic.evidence).toBe('measured')
    expect(profile.cache.reuseRatioAtComparableShape.evidence).toBe('measured')
    expect(profile.trigger.headroomTokens).toBe(9_733)
    // Quality is INHERITED and labeled as such: RC1 changes when a fold
    // happens, not what a checkpoint contains, so re-proving it would re-run a
    // measurement the change cannot affect.
    expect(profile.quality.evidence).toBe('inherited')
  })

  it('REFUSES to certify a route with no paired price measurement', () => {
    // The quiet-failure guard. No neighboring evidence substitutes for the
    // price measurement, which is the whole claim.
    const profile = certifyRoute({
      provider: 'openai',
      modelPattern: 'gpt-5.6*',
      asOf: '2026-09-29',
      thresholdRatio: 0.8,
      headroomTokens: 65_536,
      headroomSource: 'inherited from DSH Basic, not measured for this route',
      cacheMode: 'explicit',
      prefixDeterministic: { value: true, source: 'rc1d-cache-contract' },
      reuseRatio: { value: 1.0, source: 'assumed' },
      // No priceEffect.
    })
    expect(profile.certified).toBe(false)
    expect(profile.gaps.join(' ')).toContain('no paired realized cost measurement')
  })

  it('reports an unmeasured reserve as a GAP, not as a value', () => {
    const profile = certifyRoute({
      provider: 'unknown',
      modelPattern: '*',
      asOf: '2026-09-29',
      thresholdRatio: 0.8,
      cacheMode: 'none',
    })
    expect(profile.certified).toBe(false)
    expect(profile.trigger.headroomTokens).toBeUndefined()
    expect(profile.gaps.join(' ')).toContain('safety reserve has not been measured')
    expect(profile.gaps.join(' ')).toContain('prefix determinism')
    expect(profile.gaps.join(' ')).toContain('cache reuse baseline')
  })

  it('computes the effective threshold from the certified reserve', () => {
    const profile = measuredProfile()
    // 131072 window, 512 reserved, 9733 reserve: the ratio bound (104857) still
    // wins at 0.8, so the certified reserve no longer binds.
    const threshold = profile.trigger.effectiveThresholdFor(131_072, 512)
    expect(threshold).toBe(104_857)
    // On a small window the reserve does bind, and the arithmetic says so.
    expect(profile.trigger.effectiveThresholdFor(16_000, 512)).toBe(5_755)
  })
})

describe('RC1-G: an uncertified route falls back to legacy, never to economy', () => {
  it('answers legacy for a route with no certified profile', () => {
    const profiles = [measuredProfile()]
    expect(recommendedMode(profiles, 'deepseek', 'deepseek-v4.1-flash')).toBe('economy')
    // An unmeasured route is the case that matters: guessing in the cheap
    // direction is how a cost saving ships as a regression.
    expect(recommendedMode(profiles, 'openai', 'gpt-5.6')).toBe('legacy')
    expect(recommendedMode(profiles, 'anthropic', 'claude-opus-5')).toBe('legacy')
    expect(recommendedMode(profiles, 'deepseek', 'deepseek-v4.1-pro')).toBe('legacy')
  })

  it('does NOT let an uncertified profile match', () => {
    // A profile that exists but is not certified must not be returned by the
    // lookup, or the `certified` flag would be decorative.
    const uncertified = certifyRoute({
      provider: 'deepseek',
      modelPattern: 'deepseek-*flash*',
      asOf: '2026-09-29',
      thresholdRatio: 0.8,
      cacheMode: 'automatic',
    })
    expect(uncertified.certified).toBe(false)
    expect(certifiedProfileFor([uncertified], 'deepseek', 'deepseek-v4.1-flash')).toBeUndefined()
    expect(recommendedMode([uncertified], 'deepseek', 'deepseek-v4.1-flash')).toBe('legacy')
  })

  it('matches a wildcard model pattern the way the economics profiles do', () => {
    const profiles = [measuredProfile()]
    expect(certifiedProfileFor(profiles, 'deepseek', 'deepseek-v4.1-flash')).toBeDefined()
    expect(certifiedProfileFor(profiles, 'deepseek', 'deepseek-flash')).toBeDefined()
    // A different family must not match.
    expect(certifiedProfileFor(profiles, 'deepseek', 'deepseek-pro')).toBeUndefined()
  })
})

describe('RC1-G: the profile renders its gaps rather than hiding them', () => {
  it('prints every gap for an uncertified route', () => {
    const profile = certifyRoute({
      provider: 'openai',
      modelPattern: 'gpt-5.6*',
      asOf: '2026-09-29',
      thresholdRatio: 0.8,
      cacheMode: 'explicit',
    })
    const markdown = profileToMarkdown(profile)
    expect(markdown).toContain('Certified: **NO**')
    expect(markdown).toContain('Gaps preventing certification')
    expect(markdown).toContain('safety reserve NOT measured')
    expect(markdown).toContain('NOT MEASURED')
  })

  it('prints the certified numbers for the measured route', () => {
    const markdown = profileToMarkdown(measuredProfile())
    expect(markdown).toContain('Certified: **yes**')
    expect(markdown).toContain('safety reserve 9733 tokens')
    expect(markdown).toContain('reuse ratio 1.000')
    expect(markdown).not.toContain('Gaps preventing')
  })
})
