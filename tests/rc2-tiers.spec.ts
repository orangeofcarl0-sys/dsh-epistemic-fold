/**
 * RC2: the three-tier mode ladder.
 *
 * The product surface offers three modes — `economy`, `balanced`, `quality` —
 * and this suite pins the properties that make the ladder honest:
 *
 *  1. **Each rung is a named SET of values, not a branch.** The engine cannot
 *     tell a tier from the same keys written by hand, so a tier can only choose
 *     among settings the engine already supports.
 *  2. **The rungs differ only in the levers that buy steadiness.** Everything
 *     else is held identical, so a measured difference between two rungs is
 *     attributable to the one lever that changed.
 *  3. **A rung's evidence status is declared, not implied.** `economy` is
 *     measured; the two steadiness rungs are hypotheses, and every surface that
 *     describes them says so.
 *  4. **Every rung actually RESOLVES.** A tier that names a retention ratio its
 *     own fold threshold rejects would fail at startup for whoever selected it,
 *     which is the worst place to discover a policy error.
 *
 * @module tests/rc2-tiers
 */

import { describe, expect, it } from 'vitest'
import {
  FOLD_MODE_NAMES,
  TIERS,
  TIER_MODE_NAMES,
  economyPresetValues,
  isTierModeName,
  presetOverrides,
  resolvePreset,
  tierLadder,
  tierLadderToText,
  tierValuesFor,
} from '../src/preset.ts'
import { resolveEfConfig, resolveEfCompactSpec } from '../src/policy.ts'
import { describeEffectiveConfig, effectiveConfigToText } from '../src/effective-config.ts'
import { BUILTIN_ECONOMICS_PROFILES } from '../src/economics-profile.ts'

describe('RC2: the ladder is three tiers, and only three', () => {
  it('exposes exactly economy, balanced, quality, in cost order', () => {
    expect(TIER_MODE_NAMES).toEqual(['economy', 'balanced', 'quality'])
    // `legacy` is the engine's own default and the frozen research baseline. It
    // is a MODE but not a TIER: the product surface offers the ladder, and a
    // deployment that configured nothing is reported as `legacy`.
    expect(FOLD_MODE_NAMES).toEqual(['legacy', 'economy', 'balanced', 'quality'])
    expect(isTierModeName('legacy')).toBe(false)
    expect(isTierModeName('economy')).toBe(true)
    expect(isTierModeName('quality')).toBe(true)
  })

  it('every tier is described for a user, not for an engineer', () => {
    for (const name of TIER_MODE_NAMES) {
      const tier = TIERS[name]
      expect(tier.name).toBe(name)
      expect(tier.summary.length).toBeGreaterThan(0)
      expect(tier.intent.length).toBeGreaterThan(0)
      expect(tier.steadinessMechanism.length).toBeGreaterThan(0)
      expect(['measured', 'hypothesis']).toContain(tier.evidence)
    }
  })

  it('renders the ladder with each rung\'s evidence status on the rung', () => {
    const text = tierLadderToText()
    for (const name of TIER_MODE_NAMES) expect(text).toContain(name)
    // The status must be attached to each rung, not only to the unmeasured ones,
    // so its absence cannot be read as a claim.
    expect(text.match(/evidence: (MEASURED|HYPOTHESIS)/gu)).toHaveLength(3)
  })
})

describe('RC2: a tier is a named set of values, not a branch', () => {
  it('resolves identically to writing the keys by hand', () => {
    for (const name of TIER_MODE_NAMES) {
      const viaTier = resolveEfConfig({ mode: name })
      const byHand = resolveEfConfig(tierValuesFor(name) as never)
      expect(viaTier, `${name} must not be a behavior switch`).toEqual(byHand)
    }
  })

  it('never sets an operational field', () => {
    // A mode name must not redirect where a deployment writes its bundles, or
    // what window it thinks it has.
    for (const name of TIER_MODE_NAMES) {
      const values = tierValuesFor(name)
      for (const forbidden of ['bundleRoot', 'thresholdRatio', 'headroomTokens', 'mode', 'auto']) {
        expect(values, `${name} must not set ${forbidden}`).not.toHaveProperty(forbidden)
      }
    }
  })

  it('an explicit setting ALWAYS beats the tier', () => {
    // The rule that makes a tier safe to adopt.
    const resolved = resolvePreset('quality', { semanticMode: 'none', retainRatio: 0.5 })
    expect(resolved.semanticMode).toBe('none')
    expect(resolved.retainRatio).toBe(0.5)
    // ...while keys the user did NOT set are still filled in.
    expect(resolved.leafAdmission).toBe('economic')
    expect(resolved.framingMode).toBe('system-dedup')
  })

  it('legacy is not a tier and changes nothing', () => {
    expect(tierValuesFor('legacy')).toEqual({})
    expect(economyPresetValues()).toEqual(tierValuesFor('economy'))
    const explicit = { thresholdRatio: 0.5 }
    expect(resolvePreset('legacy', explicit)).toEqual(explicit)
    expect(presetOverrides('legacy', explicit)).toEqual([])
  })

  it('economy still resolves to EXACTLY the configuration R3/RC1 measured', () => {
    // The ladder's first rung must not drift from the tested policy, or every
    // cost figure attributed to it becomes wrong.
    const resolved = resolveEfConfig({ mode: 'economy' })
    expect(resolved.leafAdmission).toBe('economic')
    expect(resolved.rootPolicy.mode).toBe('economics')
    expect(resolved.semanticMode).toBe('none')
    expect(resolved.framingMode).toBe('system-dedup')
    // Economy does NOT touch retention: it leaves the engine default in place.
    expect(economyPresetValues()).not.toHaveProperty('retainRatio')
  })
})

describe('RC2: the rungs differ only in the steadiness levers', () => {
  const resolved = (name: 'economy' | 'balanced' | 'quality') => resolveEfConfig({ mode: name })

  it('economy and balanced differ ONLY in retention (the RC2.1 reorder)', () => {
    // This is what makes a measured difference between them attributable to the
    // RETENTION rather than to some other setting that also moved. RC2 ordered
    // the ladder the other way (balanced bought the semantic face); RC2.1 moved
    // retention first because it is the stronger and cheaper mechanism.
    const economy = resolved('economy')
    const balanced = resolved('balanced')
    expect(economy.leafAdmission).toBe(balanced.leafAdmission)
    expect(economy.rootPolicy.mode).toBe(balanced.rootPolicy.mode)
    expect(economy.framingMode).toBe(balanced.framingMode)
    // The semantic face does NOT move on this rung.
    expect(balanced.semanticMode).toBe(economy.semanticMode)
    expect(balanced.semanticMode).toBe('none')
    // The one lever, and it moves UP.
    expect(balanced.retainRatio).toBeGreaterThan(economy.retainRatio)
  })

  it('balanced and quality differ ONLY in the semantic face', () => {
    // The top rung adds the rationale call on top of balanced's retention, so a
    // difference between them is attributable to the semantic face.
    const balanced = resolved('balanced')
    const quality = resolved('quality')
    expect(balanced.retainRatio).toBe(quality.retainRatio)
    expect(balanced.leafAdmission).toBe(quality.leafAdmission)
    expect(balanced.rootPolicy.mode).toBe(quality.rootPolicy.mode)
    expect(balanced.framingMode).toBe(quality.framingMode)
    // The one lever.
    expect(balanced.semanticMode).toBe('none')
    expect(quality.semanticMode).toBe('rationale')
  })

  it('RETENTION comes before RATIONALE in the ladder', () => {
    // The design decision itself, pinned so a later edit cannot silently revert
    // it: the cheaper rung buys the stronger mechanism.
    expect(TIERS.balanced.values.retainRatio).toBeGreaterThan(0.16)
    expect(TIERS.balanced.values.semanticMode).toBe('none')
    expect(TIERS.quality.values.semanticMode).toBe('rationale')
    // And the top rung does NOT raise retention further, or its difference from
    // balanced would be two levers rather than one.
    expect(TIERS.quality.values.retainRatio).toBe(TIERS.balanced.values.retainRatio)
  })

  it('the levers are monotone up the ladder, never contradictory', () => {
    const economy = resolved('economy')
    const balanced = resolved('balanced')
    const quality = resolved('quality')
    // A higher rung may add steadiness, never remove it: `none` < `rationale`
    // for the semantic face, and retention never decreases.
    const semanticRank = { none: 0, rationale: 1 } as const
    expect(semanticRank[balanced.semanticMode]).toBeGreaterThanOrEqual(semanticRank[economy.semanticMode])
    expect(semanticRank[quality.semanticMode]).toBeGreaterThanOrEqual(semanticRank[balanced.semanticMode])
    expect(quality.retainRatio).toBeGreaterThanOrEqual(balanced.retainRatio)
    expect(balanced.retainRatio).toBeGreaterThanOrEqual(economy.retainRatio)
  })

  it('no tier relaxes a safety lever to buy steadiness', () => {
    // A steadiness rung must not, for example, disable economic admission or
    // switch rebasing back to the legacy heuristic. Those are the R2 gates, and
    // trading a measured gate for an unmeasured benefit is the wrong direction.
    for (const name of TIER_MODE_NAMES) {
      const config = resolved(name)
      expect(config.leafAdmission, `${name} must keep economic admission`).toBe('economic')
      expect(config.rootPolicy.mode, `${name} must keep economic rebasing`).toBe('economics')
      expect(config.framingMode, `${name} must keep deduplicated framing`).toBe('system-dedup')
    }
  })
})

describe('RC2: every rung actually RESOLVES against a real window', () => {
  /**
   * The windows this project ships economics profiles for.
   *
   * A retention rung that exceeds its own fold threshold makes
   * `resolveEfCompactSpec` THROW, so a user selecting that tier would hit a
   * startup failure. Resolving each rung against every real window is what
   * turns "0.24 looked reasonable" into a checked claim.
   */
  const WINDOWS = [...new Set(BUILTIN_ECONOMICS_PROFILES.map(profile => profile.context.windowTokens))]
    .filter(window => window > 0)
    .sort((left, right) => left - right)

  it('has at least one real window to resolve against', () => {
    expect(WINDOWS.length).toBeGreaterThan(0)
    // Sanity: the shipped profiles describe real, useful windows.
    expect(Math.max(...WINDOWS)).toBeGreaterThanOrEqual(100_000)
  })

  it('resolves every tier at every shipped window, with headroom reserved', () => {
    for (const window of WINDOWS) {
      for (const reserved of [1_500, 8_192]) {
        for (const name of TIER_MODE_NAMES) {
          // The default headroom reserve is 65,536 tokens, which is larger than
          // some windows. That is a PRE-EXISTING property of the reserve and not
          // something a tier chooses, so the rung is resolved with the headroom
          // it would actually inherit — a window too small for the default
          // reserve fails for every mode equally, including `legacy`.
          const config = resolveEfConfig({ mode: name })
          const headroom = Math.min(config.headroomTokens, Math.floor(window / 4))
          expect(
            () => resolveEfCompactSpec({ ...config, headroomTokens: headroom }, window, reserved),
            `${name} must resolve at window ${window} with ${reserved} reserved`,
          ).not.toThrow()
        }
      }
    }
  })

  it('keeps retention strictly below the fold threshold on every rung', () => {
    // The invariant the previous test exercises indirectly, asserted directly so
    // a future retention rung fails with a clear message instead of a throw.
    for (const window of WINDOWS) {
      for (const name of TIER_MODE_NAMES) {
        const config = resolveEfConfig({ mode: name })
        const headroom = Math.min(config.headroomTokens, Math.floor(window / 4))
        const spec = resolveEfCompactSpec({ ...config, headroomTokens: headroom }, window, 1_500)
        expect(
          spec.retainTokens,
          `${name} at window ${window}: retention must stay under the threshold`,
        ).toBeLessThan(spec.thresholdTokens)
      }
    }
  })

  it('the quality rung really does retain more than the engine default', () => {
    // The rung's whole claim. If it resolved to the same retention as the
    // default, it would be `balanced` with a higher price and no mechanism.
    const window = Math.max(...WINDOWS)
    const headroom = 8_192
    const economy = resolveEfCompactSpec(
      { ...resolveEfConfig({ mode: 'economy' }), headroomTokens: headroom }, window, 1_500)
    const quality = resolveEfCompactSpec(
      { ...resolveEfConfig({ mode: 'quality' }), headroomTokens: headroom }, window, 1_500)
    expect(quality.retainTokens).toBeGreaterThan(economy.retainTokens)
  })
})

describe('RC2: a tier declares how well backed its claim is', () => {
  it('economy is measured, and names the measurement', () => {
    const tier = TIERS.economy
    expect(tier.evidence).toBe('measured')
    expect(tier.evidenceDetail).toContain('RC1.3')
    // It makes no steadiness claim, which is what "parity" means: it is not
    // trying to be steadier than Basic, only cheaper.
    expect(tier.steadinessMechanism).toContain('no steadiness claim')
  })

  it('the steadiness rungs are hypotheses, and say what is missing', () => {
    for (const name of ['balanced', 'quality'] as const) {
      const tier = TIERS[name]
      expect(tier.evidence, `${name} has no live end-to-end measurement`).toBe('hypothesis')
      expect(tier.evidenceDetail).toContain('No live measurement')
    }
  })

  it('the effective-config report carries the status, not just the settings', () => {
    // A deployment reading the report must not see a hypothesis presented as a
    // measured configuration.
    for (const name of ['balanced', 'quality'] as const) {
      const effective = describeEffectiveConfig({ mode: name })
      expect(effective.tier?.evidence).toBe('hypothesis')
      const text = effectiveConfigToText(effective)
      expect(text).toContain('HYPOTHESIS')
      expect(text).toContain('No live measurement')
    }
    const economy = effectiveConfigToText(describeEffectiveConfig({ mode: 'economy' }))
    expect(economy).toContain('MEASURED')
  })

  it('legacy reports no tier at all', () => {
    // It is the engine default, not a rung; claiming a tier summary for it would
    // invent a product claim the engine never made.
    expect(describeEffectiveConfig({ mode: 'legacy' }).tier).toBeUndefined()
    expect(describeEffectiveConfig({}).tier).toBeUndefined()
  })
})

describe('RC2: the report tells the truth about origins', () => {
  it('marks a key the tier owns as `preset` and one it does not as `engine-default`', () => {
    // After the RC2.1 reorder, `balanced` owns RETENTION. It also sets the
    // semantic face EXPLICITLY to `none` — necessarily, because the engine's own
    // default for that key is `rationale`, so omitting it would silently buy the
    // auxiliary call the rung is defined not to make.
    const effective = describeEffectiveConfig({ mode: 'balanced' })
    const origin = (key: string) => effective.settings.find(s => s.key === key)?.origin
    expect(origin('retainRatio')).toBe('preset')
    expect(origin('semanticMode')).toBe('preset')
    // A key the tier does NOT own reports as the engine default. Reporting
    // `preset` for it would claim the tier chose a value it never mentioned.
    expect(origin('thresholdRatio')).toBeUndefined()
  })

  it('economy owns neither retention nor a raised tail', () => {
    const effective = describeEffectiveConfig({ mode: 'economy' })
    const origin = (key: string) => effective.settings.find(s => s.key === key)?.origin
    // Economy leaves retention to the engine — it makes no tail claim at all.
    expect(origin('retainRatio')).toBe('engine-default')
    // Economy DOES own the semantic face, explicitly setting it to `none`.
    expect(origin('semanticMode')).toBe('preset')
  })

  it('quality owns retention AND the semantic face', () => {
    const effective = describeEffectiveConfig({ mode: 'quality' })
    const origin = (key: string) => effective.settings.find(s => s.key === key)?.origin
    expect(origin('retainRatio')).toBe('preset')
    expect(origin('semanticMode')).toBe('preset')
  })

  it('an explicit value is reported as `explicit` on every tier', () => {
    const effective = describeEffectiveConfig({ mode: 'economy', semanticMode: 'rationale' })
    expect(effective.settings.find(s => s.key === 'semanticMode')?.origin).toBe('explicit')
    expect(effective.overrides).toEqual([
      { key: 'semanticMode', preset: 'none', explicit: 'rationale' },
    ])
  })

  it('an unknown mode is a blocker on every path that reports it', () => {
    const effective = describeEffectiveConfig({ mode: 'reliability' as never })
    expect(effective.blockers.join(' ')).toContain('unknown mode')
    // And it must NOT invent a tier summary for a name it does not know.
    expect(effective.tier).toBeUndefined()
  })
})

describe('RC2: the ladder is stable and complete', () => {
  it('tierLadder returns every rung in cost order', () => {
    expect(tierLadder().map(tier => tier.name)).toEqual([...TIER_MODE_NAMES])
  })

  it('the ladder text names all three rungs and their evidence', () => {
    const text = tierLadderToText()
    expect(text).toContain('economy')
    expect(text).toContain('balanced')
    expect(text).toContain('quality')
    expect(text).toContain('ascending cost')
  })
})
