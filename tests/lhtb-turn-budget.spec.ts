/**
 * The turn budget must count MODEL TURNS, not provider luck.
 *
 * ## The defect this pins
 *
 * The loop was `for turn in range(1, MAX_TURNS + 1)`, so a provider failure
 * consumed an iteration from the budget -- even though the branch handling it
 * already said, in its own comment, "a provider failure is not a model turn".
 * The code and its stated intent disagreed, and the budget was allocated by the
 * network instead of by the arm.
 *
 * Measured on a live wave with the 429 burst this pins against: one cell met a
 * 36% failure rate and another 63%. That spread is wider than the differences the
 * arms are being compared on, so the confound was larger than the effect -- an arm
 * could appear better or worse purely by drawing a quieter hour.
 *
 * ## What the fix must not break
 *
 * Fairness must not cost termination. An outage that never lets up still ends the
 * episode after PROVIDER_OUTAGE_MAX_SEC, and a route that fails often but never
 * CONSECUTIVELY for that long is bounded by MAX_WASTED_ATTEMPTS -- without which
 * the loop would run until harbor killed the container, which reports no reason
 * and no reward.
 *
 * ## Why the test is at the SOURCE level
 *
 * The loop needs a live bridge to execute, so what is pinned here is the
 * STRUCTURE that makes the budget fair, like `lhtb-agent-truncation.spec.ts`
 * pins the order of two tests. The behavioural evidence is a run whose cells
 * report comparable `modelCalls` despite different `providerFailures`.
 *
 * @module tests/lhtb-turn-budget
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const AGENT = readFileSync(join(ROOT, 'eval', 'lhtb', 'ef_lhtb_agent.py'), 'utf8')

describe('the turn budget counts model turns', () => {
  it('is a while loop whose counter advances only on a turn that happened', () => {
    // Anchored to the start of a line, because the comment explaining this defect
    // QUOTES the old expression. An unanchored match hits the prose describing the
    // bug and reports the fix as the bug -- a trap this repository has fallen into
    // before, which is why the pattern is written to match code and not text.
    expect(AGENT, 'range() charges the budget for iterations, not model turns')
      .not.toMatch(/^\s*for turn in range\(1, MAX_TURNS/mu)
    expect(AGENT).toMatch(/while turn < MAX_TURNS:/u)
    // The increment sits at the top, so the decrement in the failure branch
    // returns exactly the turn that call did not spend.
    expect(AGENT).toMatch(/while turn < MAX_TURNS:\n            turn \+= 1/u)
  })

  it('gives the turn back when the request never reached the model', () => {
    expect(AGENT).toContain('turn -= 1')
    // It must sit in the provider branch, after the outage check: the outage
    // break is a termination, not a retry, and must not be reached with the
    // counter already rewound.
    const errorAt = AGENT.indexOf('if error:')
    const decrementAt = AGENT.indexOf('turn -= 1')
    expect(errorAt, 'the provider-error branch must exist').toBeGreaterThan(-1)
    expect(decrementAt, 'the decrement must exist').toBeGreaterThan(-1)
    expect(decrementAt).toBeGreaterThan(errorAt)
  })

  it('bounds the waste, so fairness cannot cost termination', () => {
    expect(AGENT).toContain('MAX_WASTED_ATTEMPTS')
    expect(AGENT).toContain('wasted_attempts += 1')
    expect(AGENT).toMatch(/wasted_attempts > MAX_WASTED_ATTEMPTS/u)
    expect(AGENT).toContain('provider-waste-exceeded')
    // And the outage ceiling is untouched: a sustained outage still terminates.
    expect(AGENT).toMatch(/outage_sec > PROVIDER_OUTAGE_MAX_SEC/u)
    expect(AGENT).toContain('provider-outage-exceeded')
  })

  it('keeps the truncation retry charged, because that call did reach the model', () => {
    // A truncated reply is a real model turn; only the provider branch rewinds.
    const decrements = AGENT.split('turn -= 1').length - 1
    expect(decrements, 'exactly one rewind site, in the provider branch').toBe(1)
  })
})
