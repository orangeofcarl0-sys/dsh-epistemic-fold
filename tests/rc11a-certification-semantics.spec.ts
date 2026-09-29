/**
 * RC1.1 §1: "mechanics verified" and "economy recommended" are different claims.
 *
 * The defect this suite pins, and it was load-bearing: RC1's profile reported
 * `certified: true` and `recommendedMode() === 'economy'` while the real cost
 * gate was **OPEN**. The mechanism was a conflated field — `reuseRatio: 1.0` is
 * a cache-contract measurement (the two request shapes reuse cache equally) and
 * it was being fed into `priceEffect.realizedRatio`, a price claim.
 *
 * So the tests below are written in both directions: the state must be
 * REPRESENTABLE (certified mechanics, open cost), and the specific confusion
 * that made it unrepresentable must be impossible to reintroduce.
 */

import { describe, expect, it } from 'vitest'
import {
  CERTIFICATION_COMPONENTS,
  certifiedProfileFor,
  certifyRoute,
  profileToMarkdown,
  recommendedMode,
  statusLine,
} from '../eval/src/certified-profile.ts'
import type { CertificationEvidence, CertifiedEconomyProfile } from '../eval/src/certified-profile.ts'

/** Everything measured, cost gate OPEN — the project's actual state. */
function openCostEvidence(): CertificationEvidence {
  return {
    provider: 'deepseek',
    modelPattern: 'deepseek-*flash*',
    asOf: '2026-09-29',
    thresholdRatio: 0.8,
    cacheMode: 'automatic',
    runtime: {
      passed: true,
      source: 'rc1f-fold-smoke: idle rebase consumer on the production seam',
      detail: 'the production seam carries the mechanism',
    },
    prefixDeterministic: {
      value: true,
      source: 'rc1d-cache-contract: two assemblies of the same state are byte-identical',
    },
    reuseRatio: {
      value: 1.0,
      source: 'rc1e-live-cache: ABBA counterbalanced, comparable prompt sizes',
    },
    qualitySource: 'r4e-live-noninferiority + rc1f-fold-smoke: 20/20 and 3/3 facts across folds',
    qualityPassed: true,
    qualityScope: 'Declared state is hot on the surface; undeclared history is recoverable through '
      + 'bounded recall (rc12b-recall-mechanism: the fact is off-surface and recall returns it, under '
      + 'both semantic modes)',
    window: {
      passed: true,
      source: 'rc1f-fold-smoke: peak 67379 of 131072, zero overflows',
      detail: 'worst-case request fits with headroom',
    },
    // The real measurement: point estimate below 1, interval upper above 1.
    priceEffect: {
      realizedRatio: 0.95,
      intervalUpper: 1.104,
      source: 'rc0c-full-wire-billing: 8 paired runs, deterministic bootstrap',
    },
  }
}

describe('RC1.1: certification is component-wise, and the two claims are separate', () => {
  it('reports mechanics CERTIFIED while economy is NOT recommended', () => {
    // The state RC1 could not represent, and the one the project is actually in.
    const profile = certifyRoute(openCostEvidence())
    expect(profile.mechanicsCertified).toBe(true)
    expect(profile.economyRecommended).toBe(false)
    expect(statusLine(profile)).toBe(
      'Economy mechanics certified; route-level cost recommendation still open.',
    )
    // The blocker is named, never implicit.
    expect(profile.blocking.map(entry => entry.component)).toEqual(['cost'])
    expect(profile.blocking[0]!.state).toBe('OPEN')
  })

  it('does NOT let a cache-reuse ratio stand in for a price measurement', () => {
    // The exact defect. A route with a perfect reuse ratio and NO paired cost
    // measurement must have an OPEN cost component — RC1's profile filled
    // `priceEffect.realizedRatio` from the reuse ratio and certified on it.
    const { priceEffect: _dropped, ...withoutPrice } = openCostEvidence()
    const profile = certifyRoute(withoutPrice)
    const cost = profile.components.find(entry => entry.component === 'cost')!
    expect(cost.state).toBe('OPEN')
    expect(cost.evidence).toBe('unevidenced')
    expect(profile.economyRecommended).toBe(false)
    // And the reuse ratio is still recorded — as a CACHE claim.
    expect(profile.cache.reuseRatioAtComparableShape.value).toBe(1.0)
    expect(profile.cache.reuseRatioAtComparableShape.evidence).toBe('measured')
  })

  it('distinguishes OPEN from FAIL on the cost component', () => {
    // Dispersion (point below 1, interval straddling it) is OPEN — "undecided".
    const straddling = certifyRoute(openCostEvidence())
    expect(straddling.components.find(e => e.component === 'cost')!.state).toBe('OPEN')

    // A point estimate ABOVE 1 is a genuine FAIL — "the policy costs more".
    const failing = certifyRoute({
      ...openCostEvidence(),
      priceEffect: { realizedRatio: 1.2, intervalUpper: 1.4, source: 'measured' },
    })
    expect(failing.components.find(e => e.component === 'cost')!.state).toBe('FAIL')
    expect(failing.economyRecommended).toBe(false)
    // A failure is NOT a mechanical failure: the mechanism still works.
    expect(failing.mechanicsCertified).toBe(true)
  })

  it('recommends economy only when the cost gate actually PASSES', () => {
    const passing = certifyRoute({
      ...openCostEvidence(),
      priceEffect: { realizedRatio: 0.95, intervalUpper: 0.98, source: 'measured' },
    })
    expect(passing.economyRecommended).toBe(true)
    expect(statusLine(passing)).toBe('Economy mechanics certified; route-level cost confirmed.')
    expect(recommendedMode([passing], 'deepseek', 'deepseek-v4.1-flash')).toBe('economy')
  })

  it('does NOT recommend economy for the OPEN-cost route', () => {
    // The regression that mattered: RC1's `recommendedMode` answered `economy`
    // for exactly this profile.
    const profile = certifyRoute(openCostEvidence())
    expect(recommendedMode([profile], 'deepseek', 'deepseek-v4.1-flash')).toBe('legacy')
    expect(certifiedProfileFor([profile], 'deepseek', 'deepseek-v4.1-flash')).toBeUndefined()
  })

  it('treats an absent component as OPEN, never as PASS', () => {
    // Certification by omission is the other half of the same failure.
    const bare = certifyRoute({
      provider: 'unknown',
      modelPattern: '*',
      asOf: '2026-09-29',
      thresholdRatio: 0.8,
      cacheMode: 'none',
    })
    expect(bare.components).toHaveLength(CERTIFICATION_COMPONENTS.length)
    expect(bare.components.every(entry => entry.state === 'OPEN')).toBe(true)
    expect(bare.mechanicsCertified).toBe(false)
    expect(bare.economyRecommended).toBe(false)
    expect(statusLine(bare)).toBe('Economy mechanics NOT certified.')
  })

  it('fails mechanics when a mechanic component fails, even if cost passes', () => {
    // The converse guard: a cheap policy that regressed quality must not be
    // recommended either.
    const profile = certifyRoute({
      ...openCostEvidence(),
      qualityPassed: false,
      priceEffect: { realizedRatio: 0.8, intervalUpper: 0.9, source: 'measured' },
    })
    expect(profile.mechanicsCertified).toBe(false)
    expect(profile.economyRecommended).toBe(false)
    expect(profile.blocking.map(entry => entry.component)).toContain('quality')
  })
})

describe('RC1.1: the safety reserve is an estimate at a stated scale, not a headroom', () => {
  it('records the sampling scale alongside the estimate', () => {
    // RC1.1 §2: the meter's error is strongly RELATIVE (CJK +92%, JSON +52%),
    // so a fixed absolute reserve from a ~30K sample has not been shown to
    // extrapolate to a 65K prompt. The profile must say so.
    const profile = certifyRoute({
      ...openCostEvidence(),
      safetyReserveEstimate: {
        tokens: 9_733,
        sampledAtPromptTokens: 30_000,
        caveat: 'relative meter error is shape-dependent (CJK +92%, JSON +52%); '
          + 'extrapolation to a 65K prompt is unproven',
      },
    })
    expect(profile.trigger.safetyReserveEstimate?.tokens).toBe(9_733)
    expect(profile.trigger.safetyReserveEstimate?.sampledAtPromptTokens).toBe(30_000)
    const markdown = profileToMarkdown(profile)
    expect(markdown).toContain('safety estimate 9733 tokens')
    expect(markdown).toContain('NOT a production headroom')
  })

  it('does NOT install the estimate as the effective reserve', () => {
    // The rule that keeps the estimate out of the operating configuration: the
    // effective-threshold function takes the reserve as an ARGUMENT, so the
    // profile cannot silently substitute the estimate.
    const profile = certifyRoute({
      ...openCostEvidence(),
      safetyReserveEstimate: {
        tokens: 9_733,
        sampledAtPromptTokens: 30_000,
        caveat: 'unproven extrapolation',
      },
    })
    // With the SHIPPED reserve the trigger is headroom-bound at 65024...
    expect(profile.trigger.effectiveThresholdFor(131_072, 512, 65_536)).toBe(65_024)
    // ...and with the estimate it would be ratio-bound at 104857. The profile
    // reports both without preferring either, because choosing is a release
    // decision (RC1-H).
    expect(profile.trigger.effectiveThresholdFor(131_072, 512, 9_733)).toBe(104_857)
  })
})

describe('RC1.1: the report renders the component table', () => {
  it('shows every component with its state and evidence kind', () => {
    const markdown = profileToMarkdown(certifyRoute(openCostEvidence()))
    expect(markdown).toContain('| Component | State | Evidence |')
    for (const component of CERTIFICATION_COMPONENTS) {
      expect(markdown).toContain(`| ${component} |`)
    }
    expect(markdown).toContain('Mechanics certified: **yes**')
    expect(markdown).toContain('Economy recommended: **NO**')
    expect(markdown).toContain('Components not passing:')
    expect(markdown).toContain('`cost` (OPEN)')
  })

  it('omits the blocking section when everything passes', () => {
    const profile: CertifiedEconomyProfile = certifyRoute({
      ...openCostEvidence(),
      priceEffect: { realizedRatio: 0.9, intervalUpper: 0.95, source: 'measured' },
    })
    const markdown = profileToMarkdown(profile)
    expect(markdown).not.toContain('Components not passing:')
    expect(markdown).toContain('Economy recommended: **yes**')
  })
})

describe('RC1.1 §5: the quality claim carries its scope', () => {
  it('records what inputs the claim covers, and defaults to UNSCOPED', () => {
    // The live smoke measured a real boundary: the economy preset preserves
    // DECLARED state across folds and does NOT preserve unanchored narrative
    // (reproducibly 0/3, where Basic scored 1/3 and a rationale checkpoint
    // 1.67/3). An unscoped quality claim would read as unconditional, which is
    // the same error as a price claim without its measurement.
    const scoped = certifyRoute({
      ...openCostEvidence(),
      qualityScope: 'DECLARED state only; undeclared prose is not carried',
    })
    expect(scoped.qualityScope).toContain('DECLARED state only')
    expect(profileToMarkdown(scoped)).toContain('Quality scope: DECLARED state only')

    // Absent a scope, the profile says so rather than implying universality.
    const { qualityScope: _dropped, ...unscoped } = openCostEvidence()
    const bare = certifyRoute(unscoped)
    expect(bare.qualityScope).toContain('UNSCOPED')
  })
})
