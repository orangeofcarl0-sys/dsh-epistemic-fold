/**
 * R3: a tier's evidence is bound to the CONFIG it measured, not to its name.
 *
 * RC1.3 measured the explicit zero-LLM economy profile (`semanticMode: none`).
 * The shipped economy tier adds a rationale call and system-dedup framing. If
 * the tier kept `evidence: 'measured'`, a user reading `/context mode` would be
 * told that the running configuration had been measured at parity when it had
 * not. These tests pin the correction.
 */

import { describe, expect, it } from 'vitest'
import {
  TIERS,
  TIER_MODE_NAMES,
} from '../src/config/preset.ts'
import {
  describeEffectiveConfig,
  effectiveConfigToText,
} from '../src/config/effective-config.ts'
import { resolveEfConfig } from '../src/config/policy.ts'

describe('R3: preset evidence names the measured profile', () => {
  it('economy is a hypothesis for its current rationale-bearing config', () => {
    const tier = TIERS.economy
    expect(tier.evidence).toBe('hypothesis')
    expect(tier.evidenceProfile).toBe('rc1.3-zero-llm-economy (semanticMode: none)')
    expect(tier.evidenceDetail).toContain('semanticMode: none')
    expect(tier.evidenceDetail).toMatch(/does not transfer/u)
    // The shipped value is still rationale; the evidence profile is not.
    expect(resolveEfConfig({ mode: 'economy' }).semanticMode).toBe('rationale')
  })

  it('every measured claim names a profile, and no current tier claims measured', () => {
    for (const name of TIER_MODE_NAMES) {
      const tier = TIERS[name]
      if (tier.evidence === 'measured') {
        expect(tier.evidenceProfile, `${name} must name the measured config`).toBeDefined()
      }
    }
    for (const name of TIER_MODE_NAMES) {
      expect(TIERS[name].evidence, `${name} has no measurement of its current config`).toBe('hypothesis')
    }
  })

  it('the effective-config report carries the hypothesis and the measured profile', () => {
    const effective = describeEffectiveConfig({ mode: 'economy' })
    expect(effective.tier?.evidence).toBe('hypothesis')
    expect(effective.tier?.evidenceProfile).toBe('rc1.3-zero-llm-economy (semanticMode: none)')
    const text = effectiveConfigToText(effective)
    expect(text).toContain('evidence: HYPOTHESIS')
    expect(text).toContain('measured profile: rc1.3-zero-llm-economy')
    expect(text).toContain('does not transfer')
  })
})
