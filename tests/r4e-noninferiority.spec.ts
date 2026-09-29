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
  availabilityNonInferior,
  nonInferiority,
  scenariosToMarkdown,
  summarizeAvailability,
  tallyScenarios,
} from '../eval/live/scenarios.ts'
import type { ScenarioReplicate } from '../eval/live/scenarios.ts'

/** A replicate with the fields the tallies care about. */
function replicate(
  arm: string,
  family: string,
  passed: boolean,
  index = 0,
): ScenarioReplicate {
  return { arm, family, replicate: index, passed, answer: '', folds: 4, roots: 1 }
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

describe('RC0-D: tallies and PAIRWISE non-inferiority', () => {
  it('tallies per arm and family, not just a grand total', () => {
    const tallies = tallyScenarios([
      replicate('E4', 'constraint', true, 0), replicate('E4', 'constraint', true, 1),
      replicate('E4', 'supersession', false, 0), replicate('E4', 'supersession', true, 1),
      replicate('B1', 'constraint', true, 0),
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
      ...Array.from({ length: 4 }, (_, i) => replicate('E4', 'constraint', true, i)),
      ...Array.from({ length: 4 }, (_, i) => replicate('E4', 'supersession', false, i)),
      ...Array.from({ length: 4 }, (_, i) => replicate('B1', 'constraint', true, i)),
      ...Array.from({ length: 4 }, (_, i) => replicate('B1', 'supersession', true, i)),
    ])
    const markdown = scenariosToMarkdown(tallies, ['B1', 'E4'])
    expect(markdown).toContain('| supersession | 4/4 | 0/4 |')
    expect(markdown).toContain('| constraint | 4/4 | 4/4 |')
  })

  it('pairs by (family, replicate), counting the four outcomes', () => {
    // The pairing is the point: the arms must be judged on the SAME probe, so
    // an aggregate pass count cannot hide a swap (candidate wins one, loses
    // another, total unchanged).
    const candidate = [
      replicate('E4', 'constraint', true, 0),   // both pass
      replicate('E4', 'constraint', false, 1),  // REFERENCE-ONLY PASS
      replicate('E4', 'constraint', true, 2),   // candidate-only win
      replicate('E4', 'constraint', false, 3),  // both fail
    ]
    const reference = [
      replicate('B1', 'constraint', true, 0),
      replicate('B1', 'constraint', true, 1),
      replicate('B1', 'constraint', false, 2),
      replicate('B1', 'constraint', false, 3),
    ]
    const verdict = nonInferiority({
      candidate, reference, candidateId: 'E4', referenceId: 'B1',
    })
    expect(verdict.pairs).toBe(4)
    expect(verdict.outcomes).toEqual({
      bothPass: 1, referenceOnlyPass: 1, candidateOnlyPass: 1, bothFail: 1, unpaired: 0,
    })
    // Aggregate counts are EQUAL (2 passes each) yet the gate still fails,
    // because the candidate regressed on a probe the reference got right.
    expect(verdict.nonInferior).toBe(false)
    expect(verdict.reason).toContain('candidate-only regression')
  })

  it('the n=1 case that the OLD rule passed is now correctly FAILED', () => {
    // RC0-D's motivating bug: with `epsilon = ceil(total * 0.1)`, n=1 gave
    // epsilon=1, so "Basic 1/1, candidate 0/1" was declared NON-INFERIOR. A
    // gate that passes a candidate which failed everything is not a gate.
    const verdict = nonInferiority({
      candidate: [replicate('E4', 'constraint', false, 0)],
      reference: [replicate('B1', 'constraint', true, 0)],
      candidateId: 'E4', referenceId: 'B1',
    })
    expect(verdict.epsilon).toBe(0)
    expect(verdict.nonInferior).toBe(false)
    expect(verdict.outcomes.referenceOnlyPass).toBe(1)
  })

  it('a candidate-only WIN does not fail the gate', () => {
    const verdict = nonInferiority({
      candidate: [replicate('E4', 'c', true, 0)],
      reference: [replicate('B1', 'c', false, 0)],
      candidateId: 'E4', referenceId: 'B1',
    })
    expect(verdict.nonInferior).toBe(true)
    expect(verdict.outcomes.candidateOnlyPass).toBe(1)
    expect(verdict.netWins).toBe(1)
  })

  it('identical arms are non-inferior with zero regressions', () => {
    const observations = Array.from({ length: 5 }, (_, i) => replicate('E4', 'c', i !== 3, i))
    const reference = Array.from({ length: 5 }, (_, i) => replicate('B1', 'c', i !== 3, i))
    const verdict = nonInferiority({
      candidate: observations, reference, candidateId: 'E4', referenceId: 'B1',
    })
    expect(verdict.nonInferior).toBe(true)
    expect(verdict.outcomes.bothPass).toBe(4)
    expect(verdict.outcomes.bothFail).toBe(1)
    expect(verdict.netWins).toBe(0)
  })

  it('an UNPAIRED observation is reported, not silently dropped', () => {
    // A systematically missing reference would otherwise look like a clean run.
    const verdict = nonInferiority({
      candidate: [replicate('E4', 'c', true, 0), replicate('E4', 'c', true, 1)],
      reference: [replicate('B1', 'c', true, 0)],
      candidateId: 'E4', referenceId: 'B1',
    })
    expect(verdict.pairs).toBe(1)
    expect(verdict.outcomes.unpaired).toBe(1)
    expect(verdict.reason).toContain('UNPAIRED')
  })

  it('epsilon is an explicit allowance, not a fraction that rounds to one', () => {
    const candidate = [replicate('E4', 'c', false, 0), replicate('E4', 'c', true, 1)]
    const reference = [replicate('B1', 'c', true, 0), replicate('B1', 'c', true, 1)]
    expect(nonInferiority({ candidate, reference, candidateId: 'E4', referenceId: 'B1' }).nonInferior)
      .toBe(false)
    // Allowing exactly one regression admits it; allowing zero does not.
    expect(nonInferiority({ candidate, reference, candidateId: 'E4', referenceId: 'B1', epsilon: 1 })
      .nonInferior).toBe(true)
  })
})

describe('RC0-D: availability is measured separately from quality', () => {
  it('a transport failure is not a wrong answer, and not nothing either', () => {
    // The distinction R4-E's fix established, made quantitative. Semantic
    // quality excludes transport failures; availability and retry load report
    // them. Both must be visible, because an arm needing retries to reach the
    // same answers is not the same product.
    const withFailures = summarizeAvailability({ arm: 'E4', answered: 18, transportFailures: 2 })
    const clean = summarizeAvailability({ arm: 'B1', answered: 20, transportFailures: 0 })
    expect(withFailures.availability).toBeCloseTo(0.9, 6)
    expect(clean.availability).toBe(1)
    expect(withFailures.retryRate).toBeCloseTo(0.1, 6)
    expect(clean.retryRate).toBe(0)
  })

  it('the availability gate is separate and states both rates', () => {
    const candidate = summarizeAvailability({ arm: 'E4', answered: 19, transportFailures: 1 })
    const reference = summarizeAvailability({ arm: 'B1', answered: 20, transportFailures: 0 })
    const verdict = availabilityNonInferior({ candidate, reference })
    expect(verdict.nonInferior).toBe(true)
    expect(verdict.reason).toContain('retry rates')

    // A large availability shortfall fails on its own axis.
    const degraded = summarizeAvailability({ arm: 'E4', answered: 10, transportFailures: 10 })
    expect(availabilityNonInferior({ candidate: degraded, reference }).nonInferior).toBe(false)
  })

  it('an arm with nothing attempted reports full availability, not NaN', () => {
    const empty = summarizeAvailability({ arm: 'E4', answered: 0, transportFailures: 0 })
    expect(empty.availability).toBe(1)
    expect(empty.retryRate).toBe(0)
  })
})
