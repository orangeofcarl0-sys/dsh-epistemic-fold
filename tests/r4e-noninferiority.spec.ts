/**
 * R4-E: the scenario-family harness, and the non-inferiority rule.
 *
 * The live tier (opt-in) runs the actual model; this suite verifies the
 * machinery around it, because a scoring bug is indistinguishable from a
 * quality regression once the numbers are in a table.
 *
 * Two things matter most here:
 *
 * 1. **The supersession check must FAIL on the old value.** Of the four
 *    families it is the one that catches a real state bug — a policy that
 *    remembers "a timeout was set" without remembering which value superseded
 *    which would pass the other three and fail this one. A check that accepted
 *    either number would silently convert that bug into a pass.
 * 2. **Non-inferiority is not superiority.** The bar is a bounded shortfall
 *    against a reference, and R4 §32 is explicit that proving EF better is not
 *    a precondition for shipping.
 */

import { describe, expect, it } from 'vitest'
import {
  SCENARIO_ARMS,
  SCENARIO_FACTS,
  nonInferiority,
  scenariosToMarkdown,
  tallyScenarios,
} from '../eval/live/scenarios.ts'
import type { ScenarioReplicate } from '../eval/live/scenarios.ts'

/** A replicate with the fields the tallies care about. */
function replicate(
  arm: string,
  family: string,
  passed: boolean,
): ScenarioReplicate {
  return { arm, family, passed, answer: '', folds: 4, roots: 1 }
}

describe('R4-E: the four scenario families are distinct and machine-checked', () => {
  it('covers exactly the families R4 §30 requires', () => {
    expect(SCENARIO_FACTS.map(fact => fact.family).sort())
      .toEqual(['constraint', 'delayed-exact', 'obligation', 'supersession'])
  })

  it('every family scores with a check function, not a judgement', () => {
    for (const fact of SCENARIO_FACTS) {
      expect(typeof fact.check).toBe('function')
      expect(fact.probe.length).toBeGreaterThan(0)
      expect(fact.plant.length).toBeGreaterThan(0)
    }
  })

  it('the SUPERSESSION check rejects the superseded value', () => {
    // The load-bearing check. A policy that carries "a timeout was set" but
    // loses WHICH value is current must fail here, and only here.
    const supersession = SCENARIO_FACTS.find(fact => fact.family === 'supersession')!
    expect(supersession.check('60')).toBe(true)
    expect(supersession.check('The worker timeout is 60 seconds.')).toBe(true)
    // Both of these recall the STALE value and must fail.
    expect(supersession.check('30')).toBe(false)
    expect(supersession.check('The timeout was 30 seconds, now 60.')).toBe(false)
  })

  it('the delayed-exact check requires the verbatim token, not a paraphrase', () => {
    const exact = SCENARIO_FACTS.find(fact => fact.family === 'delayed-exact')!
    expect(exact.check('PARSE-7741')).toBe(true)
    expect(exact.check('The code is PARSE-7741.')).toBe(true)
    // A plausible-sounding but wrong code fails: this is what makes the family
    // a test of exact recovery rather than of topic recall.
    expect(exact.check('PARSE-7742')).toBe(false)
    expect(exact.check('a parse error code')).toBe(false)
  })

  it('the constraint and obligation checks are direction-specific', () => {
    const constraint = SCENARIO_FACTS.find(fact => fact.family === 'constraint')!
    expect(constraint.check('No. The constraint forbids it.')).toBe(true)
    expect(constraint.check('Yes, that is fine.')).toBe(false)

    const obligation = SCENARIO_FACTS.find(fact => fact.family === 'obligation')!
    expect(obligation.check('Yes')).toBe(true)
    expect(obligation.check('No known failures.')).toBe(false)
    // The obligation must be grounded empirically, so it needs a tool result.
    expect(obligation.needsToolResult).toBe(true)
  })

  it('declares the three arms R4 §31 requires', () => {
    expect(SCENARIO_ARMS.map(arm => arm.id)).toEqual(['B1-basic', 'E0-legacy', 'E4-economy'])
    // Only the candidate performs idle maintenance, so a regression can be
    // attributed to the rebase policy rather than to folding in general.
    expect(SCENARIO_ARMS.filter(arm => arm.idleMaintenance).map(arm => arm.id)).toEqual(['E4-economy'])
  })

  it('the economy arm IS the R4-F preset, so the tested thing is the shipped thing', async () => {
    const { resolvePreset } = await import('../src/preset.ts')
    const economy = SCENARIO_ARMS.find(arm => arm.id === 'E4-economy')!
    const preset = resolvePreset('economy')
    // Every key the preset owns must match the arm's config; the arm may add
    // operational knobs (the frozen budget) the preset deliberately does not own.
    for (const key of ['leafAdmission', 'rootPolicy', 'semanticMode', 'framingMode'] as const) {
      expect(economy.config[key]).toBe(preset[key])
    }
  })
})

describe('R4-E: tallies and non-inferiority', () => {
  it('tallies per arm and family, not just a grand total', () => {
    const tallies = tallyScenarios([
      replicate('E4', 'constraint', true), replicate('E4', 'constraint', true),
      replicate('E4', 'supersession', false), replicate('E4', 'supersession', true),
      replicate('B1', 'constraint', true),
    ])
    const econConstraint = tallies.find(t => t.arm === 'E4' && t.family === 'constraint')!
    expect(econConstraint.passed).toBe(2)
    expect(econConstraint.total).toBe(2)
    const econSuper = tallies.find(t => t.arm === 'E4' && t.family === 'supersession')!
    expect(econSuper.passed).toBe(1)
    expect(econSuper.total).toBe(2)
  })

  it('a per-family regression is visible even when the total is fine', () => {
    // The reason the tallies are per-family: an aggregate could hide a family
    // going to zero while others compensate.
    const tallies = tallyScenarios([
      ...Array.from({ length: 4 }, () => replicate('E4', 'constraint', true)),
      ...Array.from({ length: 4 }, () => replicate('E4', 'supersession', false)),
      ...Array.from({ length: 4 }, () => replicate('B1', 'constraint', true)),
      ...Array.from({ length: 4 }, () => replicate('B1', 'supersession', true)),
    ])
    const markdown = scenariosToMarkdown(tallies, ['B1', 'E4'])
    expect(markdown).toContain('| supersession | 4/4 | 0/4 |')
    expect(markdown).toContain('| constraint | 4/4 | 4/4 |')
  })

  it('non-inferiority allows a bounded shortfall and does not demand superiority', () => {
    const candidate = [
      ...Array.from({ length: 19 }, () => replicate('E4', 'constraint', true)),
      replicate('E4', 'constraint', false),
    ]
    const reference = Array.from({ length: 20 }, () => replicate('B1', 'constraint', true))
    const verdict = nonInferiority({
      candidate, reference, candidateId: 'E4', referenceId: 'B1',
    })
    // 19/20 against 20/20 is a shortfall of 1, inside epsilon 2.
    expect(verdict.nonInferior).toBe(true)
    expect(verdict.candidatePassed).toBe(19)
    expect(verdict.epsilon).toBe(2)
  })

  it('non-inferiority FAILS a shortfall beyond epsilon', () => {
    const candidate = Array.from({ length: 20 }, (_, index) =>
      replicate('E4', 'constraint', index >= 5))
    const reference = Array.from({ length: 20 }, () => replicate('B1', 'constraint', true))
    const verdict = nonInferiority({ candidate, reference, candidateId: 'E4', referenceId: 'B1' })
    expect(verdict.nonInferior).toBe(false)
    expect(verdict.reason).toContain('shortfall 5 > epsilon 2')
  })

  it('epsilon scales with the replicate count, so it means the same thing at any n', () => {
    const small = nonInferiority({
      candidate: [replicate('E4', 'c', false)],
      reference: [replicate('B1', 'c', true)],
      candidateId: 'E4', referenceId: 'B1',
    })
    const large = nonInferiority({
      candidate: [replicate('E4', 'c', false), ...Array.from({ length: 9 }, () => replicate('E4', 'c', true))],
      reference: Array.from({ length: 10 }, () => replicate('B1', 'c', true)),
      candidateId: 'E4', referenceId: 'B1',
    })
    // At n=1 an epsilon of 10% would round to 1 and accept a total failure, so
    // it is ceil'd — and at n=10 one miss is still inside epsilon 1.
    expect(small.epsilon).toBe(1)
    expect(small.nonInferior).toBe(true)
    expect(large.epsilon).toBe(1)
    expect(large.nonInferior).toBe(true)
  })
})
