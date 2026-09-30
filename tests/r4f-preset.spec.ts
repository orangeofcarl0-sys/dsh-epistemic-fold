/**
 * R4-F: named presets, and the aggregate gate that authorizes a default flip.
 *
 * R4 §36 defines the release decision as a conjunction, and the point of
 * writing it as one is that no single green number can carry it:
 *
 *   EconomyDefaultEligible = R ∧ C ∧ Q ∧ W ∧ I
 *
 *   R  Runtime        the framing seam is a supported dependency, idle rebase
 *                     runs on the production path, no benchmark-only behavior
 *   C  Cost           RBCR < 1 on real provider bills, with the aggregate CI
 *                     upper bound below 1
 *   Q  Quality        live paired non-inferiority
 *   W  Window         no context overflow, adequate main-request headroom
 *   I  Invariants     every epistemic correctness gate at zero regression
 *
 * This suite pins the preset MECHANISM and the gate AGGREGATION. The live
 * evidence feeding C and Q comes from R4-D and R4-E; what matters here is that
 * an absent or OPEN component cannot be read as a satisfied one.
 */

import { describe, expect, it } from 'vitest'
import {
  FOLD_MODE_NAMES,
  economyPresetValues,
  isFoldModeName,
  presetOverrides,
  resolvePreset,
} from '../src/preset.ts'
import { resolveEfConfig } from '../src/policy.ts'
import {
  economyDefaultEligible,
  summarizeEligibility,
} from '../eval/src/eligibility.ts'
import type { EligibilityComponent } from '../eval/src/eligibility.ts'

const satisfied = (id: string, detail = 'measured'): EligibilityComponent => ({
  id, state: 'satisfied', detail,
})
const open = (id: string, detail = 'not measured'): EligibilityComponent => ({
  id, state: 'open', detail,
})
const violated = (id: string, detail = 'regressed'): EligibilityComponent => ({
  id, state: 'violated', detail,
})

describe('R4-F: a preset is a named set of values, not a branch', () => {
  it('economy fills exactly the policy keys the preset owns', () => {
    const values = economyPresetValues()
    expect(Object.keys(values).sort()).toEqual(
      ['framingMode', 'leafAdmission', 'rootPolicy', 'semanticMode'],
    )
    // It must NOT set operational fields: a mode name cannot redirect where a
    // deployment writes bundles.
    expect(values).not.toHaveProperty('bundleRoot')
    expect(values).not.toHaveProperty('thresholdRatio')
  })

  it('an explicit setting ALWAYS beats the preset', () => {
    // The rule that makes a preset safe to adopt: a user who names a mode and
    // also sets a field gets their field.
    const resolved = resolvePreset('economy', { semanticMode: 'rationale', leafAdmission: 'legacy' })
    expect(resolved.semanticMode).toBe('rationale')
    expect(resolved.leafAdmission).toBe('legacy')
    // ...while the keys they did NOT set are still filled in.
    expect(resolved.rootPolicy).toBe('economics')
    expect(resolved.framingMode).toBe('system-dedup')
  })

  it('legacy is the engine default and changes nothing', () => {
    const explicit = { thresholdRatio: 0.5 }
    expect(resolvePreset('legacy', explicit)).toEqual(explicit)
    expect(presetOverrides('legacy', explicit)).toEqual([])
  })

  it('overrides are REPORTED, never enforced', () => {
    const overrides = presetOverrides('economy', { semanticMode: 'rationale' })
    expect(overrides).toEqual([{ key: 'semanticMode', preset: 'none', explicit: 'rationale' }])
    // A setting that MATCHES the preset is not an override.
    expect(presetOverrides('economy', { semanticMode: 'none' })).toEqual([])
  })

  it('economy resolves to the configuration R3 actually measured', () => {
    // The preset must be exactly the tested policy, not a plausible-looking
    // approximation of it. These four values ARE the R3-B/C economy arm.
    const resolved = resolveEfConfig({ mode: 'economy' })
    expect(resolved.leafAdmission).toBe('economic')
    expect(resolved.rootPolicy.mode).toBe('economics')
    expect(resolved.semanticMode).toBe('none')
    expect(resolved.framingMode).toBe('system-dedup')
  })

  it('the mode name never reaches the engine as a behavior switch', () => {
    // A preset that the engine branched on would be a second source of truth
    // for the same policy. It is resolved BEFORE the engine sees anything, so
    // the resolved face is identical to writing the keys by hand.
    const viaPreset = resolveEfConfig({ mode: 'economy' })
    const byHand = resolveEfConfig({
      leafAdmission: 'economic', rootPolicy: 'economics',
      semanticMode: 'none', framingMode: 'system-dedup',
    })
    expect(viaPreset).toEqual(byHand)
  })

  it('REJECTS an unknown mode name — it never falls through to legacy', () => {
    // RC0-A corrected this test. Its previous version was named "rejects an
    // unknown mode name" while actually ASSERTING the opposite — that an
    // unrecognized mode is silently ignored and the engine runs legacy. That
    // is the worst failure a named mode can have: a typo like `econnomy` would
    // run the legacy policy while the deployment believed it had asked for
    // economy, with no indication anything was wrong.
    expect(isFoldModeName('economy')).toBe(true)
    // `reliability` is still NOT a mode name. RC2 added the tier ladder, and the
    // rung that buys steadiness is named `balanced`/`quality` — not the R4-era
    // `reliability` placeholder, which would have asserted a configuration the
    // project never measured. The rungs that DO make a steadiness claim carry
    // `evidence: 'hypothesis'` rather than borrowing an unearned name.
    expect(isFoldModeName('reliability')).toBe(false)
    // RC7 added `basic`, the install-time opt-out that makes EF stand aside.
    // The set is asserted EXACTLY so a mode cannot be added without this test
    // noticing — which is what makes it a guard rather than a restatement.
    expect(FOLD_MODE_NAMES).toEqual(['legacy', 'basic', 'economy', 'balanced', 'quality'])
    // ...and `basic` is not a TIER: it fills in no policy values at all.
    expect(resolvePreset('basic')).toEqual({})

    expect(() => resolveEfConfig({ mode: 'nonsense' as never })).toThrow(/unknown mode/u)
    expect(() => resolveEfConfig({ mode: 'nonsense' as never })).toThrow(/economy/u)
    // The realistic typo, which is the case this guard exists for.
    expect(() => resolveEfConfig({ mode: 'econnomy' as never })).toThrow(/unknown mode/u)
    // An explicit `legacy` still resolves, so the guard rejects only typos.
    expect(resolveEfConfig({ mode: 'legacy' }).leafAdmission).toBe('legacy')
  })
})

describe('R4-F: the default-flip gate is a conjunction, and OPEN is not PASS', () => {
  it('is eligible only when EVERY component is satisfied', () => {
    const all = [
      satisfied('R'), satisfied('C'), satisfied('Q'), satisfied('W'), satisfied('I'),
    ]
    expect(economyDefaultEligible(all).eligible).toBe(true)
  })

  it('an OPEN component blocks the flip', () => {
    // The whole reason the gate is written as a conjunction: an unmeasured
    // quality result must not be read as a passing one.
    const components = [
      satisfied('R'), satisfied('C'), open('Q', 'live non-inferiority not run'),
      satisfied('W'), satisfied('I'),
    ]
    const verdict = economyDefaultEligible(components)
    expect(verdict.eligible).toBe(false)
    expect(verdict.blocking.map(component => component.id)).toEqual(['Q'])
    console.log(`gate with Q open: ${verdict.reason}`)
  })

  it('a VIOLATED component blocks the flip and says which invariant regressed', () => {
    const components = [
      satisfied('R'), satisfied('C'), satisfied('Q'), satisfied('W'),
      violated('I', 'ALR = 1'),
    ]
    const verdict = economyDefaultEligible(components)
    expect(verdict.eligible).toBe(false)
    expect(verdict.reason).toContain('ALR')
  })

  it('a MISSING component is not a satisfied one', () => {
    // Omitting a check must never be a way to pass it.
    const verdict = economyDefaultEligible([satisfied('R'), satisfied('C')])
    expect(verdict.eligible).toBe(false)
    // Absent components are reported as MISSING — a distinct list from
    // `blocking`, which holds the ones that were evaluated and failed. Keeping
    // them separate is what lets a report say "not measured" rather than
    // implying a measurement came back negative.
    expect(verdict.missing).toEqual(['Q', 'W', 'I'])
    expect(verdict.blocking).toEqual([])
    expect(verdict.reason).toContain('not evaluated')
  })

  it('cost alone never authorizes the flip, however good it is', () => {
    // R4 §46's warning: "the direction is good, so more mechanism must be
    // better" is the dangerous error. Even a spectacular RBCR cannot carry a
    // production default without the other four components.
    const verdict = economyDefaultEligible([
      satisfied('C', 'RBCR 0.62, CI upper 0.70'),
      open('Q'), open('W'), open('I'),
    ])
    expect(verdict.eligible).toBe(false)
    expect(verdict.blocking).toHaveLength(3)
  })

  it('summarizes the gate for a report without softening any state', () => {
    const markdown = summarizeEligibility([
      satisfied('R', 'seam is a compile-time dependency'),
      satisfied('C', 'RBCR 0.906'),
      open('Q', 'R4-E pending'),
      satisfied('W', 'no overflow'),
      satisfied('I', 'all gates zero'),
    ])
    expect(markdown).toContain('EconomyDefaultEligible')
    expect(markdown).toContain('open')
    expect(markdown).toContain('R4-E pending')
    expect(markdown).toContain('NOT eligible')
  })
})
