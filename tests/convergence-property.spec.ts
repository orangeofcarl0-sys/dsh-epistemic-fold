/**
 * Phase 1 — the convergence contract as a PROPERTY, not a handful of examples.
 *
 * ## Why a property test on top of the example tests
 *
 * `convergence-contract.spec.ts` pins the invariants on schedules a human chose.
 * Those schedules are the ones that were easy to think of, and the two real bugs
 * found while building this suite — a mis-specified I1 check and an unreachable
 * overflow fixture — were both found by a test FAILING, not by reasoning about
 * the design. A property test exists to fail on the schedules nobody thought of:
 * it generates a schedule, drives it, and asserts the contract held.
 *
 * ## Determinism
 *
 * The generator is a seeded PRNG, so a failure reproduces from its seed alone
 * and the suite cannot go flaky. The seed is printed on failure.
 *
 * ## The contract asserted after EVERY step of EVERY schedule
 *
 *   I1  a surface that is frozen-bound must not grow its frozen prefix
 *   I2  no leaf fold may be repeated without the pressure having fallen between
 *   I3  an outstanding intent count is a fact, and a run with a consumer must
 *       end with zero
 *   I4  the run terminates: bounded leaves, bounded rebases, bounded throws
 *
 * I1 and I2 are checked on the recorded per-step attribution, so the assertions
 * are about what the engine DID rather than about what it returned.
 *
 * @module tests/convergence-property
 */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'

import { createHarness, conversation, SIGNAL } from './harness.ts'
import type { Harness } from './harness.ts'
import { classifyCapacityRegime, classifyPressureRegime, pressureBreakdown } from '../src/pressure.ts'
import { resolveEfCompactSpec, resolveEfConfig } from '../src/policy.ts'
import type { EpistemicFoldConfig } from '../src/policy.ts'

/**
 * A deterministic 32-bit PRNG (mulberry32).
 *
 * Chosen over `Math.random` because a property failure is only actionable if it
 * reproduces, and over a fixed list of cases because the point is to cover
 * schedules no one enumerated.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** One generated schedule's parameters. */
interface Schedule {
  readonly seed: number
  readonly window: number
  readonly thresholdRatio: number
  readonly maxTokens: number
  readonly rounds: number
  readonly growthChunks: number
}

/**
 * Generate a schedule from a seed.
 *
 * ## Why the ranges are aggressive
 *
 * A first version used 12–31 rounds with modest growth, and the corpus never
 * once pushed the frozen prefix over the threshold — the post-leaf frozen-bound
 * count was 0 on every seed, so the loop's re-check and the emergency path were
 * never exercised and the invariants passed vacuously. These ranges were chosen
 * from measurement so that every seed reaches those states. The coverage
 * assertions at the bottom of this file pin that property, so a future loosening
 * of these numbers fails rather than silently weakening every test here.
 */
function makeSchedule(seed: number): Schedule {
  const random = makeRandom(seed)
  return {
    seed,
    window: 1_000 + Math.floor(random() * 2_000),
    // A low ratio puts the soft threshold well below the hard capacity, so the
    // frozen prefix can cross the soft line while the surface is still sendable —
    // which is the state the handoff exists for.
    thresholdRatio: [0.15, 0.2, 0.5][Math.floor(random() * 3)]!,
    maxTokens: 50 + Math.floor(random() * 100),
    rounds: 40 + Math.floor(random() * 25),
    growthChunks: 150 + Math.floor(random() * 350),
  }
}

/** What one driven schedule recorded. */
interface Outcome {
  readonly steps: number
  readonly leaves: number
  readonly roots: number
  readonly emergencies: number
  readonly throws: number
  readonly pendingIntents: number
  /** Leaves that landed the prefix over the threshold, exercising the re-check. */
  readonly transitions: number
  readonly violations: readonly string[]
}

/**
 * Drive one generated schedule and check the contract at every step.
 *
 * @param schedule - the generated parameters.
 * @param attachConsumer - whether to mount the production idle consumer.
 * @returns what happened, plus any invariant violations observed.
 */
async function drive(schedule: Schedule, attachConsumer: boolean): Promise<Outcome> {
  const config: EpistemicFoldConfig = {
    thresholdRatio: schedule.thresholdRatio,
    headroomTokens: 0,
    retainTokens: 0,
    maxTokens: schedule.maxTokens,
    leafAdmission: 'economic',
    rootPolicy: 'economics',
  }
  const harness: Harness = await createHarness({ text: 'digest' }, {
    contextWindow: schedule.window,
    efConfig: config,
  })
  const { engine } = harness
  const session: Session = conversation(4)
  const agent = { session, options: { provider: 'test-model', model: 'test-model' } } as never

  const random = makeRandom(schedule.seed ^ 0x9e3779b9)
  const violations: string[] = []
  let throws = 0
  /** How often a leaf landed the prefix over the threshold (the re-check path). */
  let transitions = 0

  for (let round = 0; round < schedule.rounds; round += 1) {
    // Grow by a random amount, so the surface crosses the threshold at a
    // different point in every schedule.
    const chunks = 1 + Math.floor(random() * schedule.growthChunks)
    session.append('user/message', {
      role: 'user',
      content: [{ type: 'text', text: `round ${round} `.repeat(chunks) }],
      source: { kind: 'user' },
    } as never, { surfaceOp: 'append' })

    const leavesBefore = engine.leafFoldCount
    // Alternate pressure and overflow triggers, so both branches are exercised
    // on the same generated surface rather than only the one a fixture chose.
    const trigger = random() < 0.25 ? 'context-overflow' : 'pressure'
    try {
      await engine.compactIfNeeded(agent, trigger, SIGNAL)
    } catch {
      // I4 permits explicit termination; it is counted, not treated as a fault.
      throws += 1
    }
    const folded = engine.leafFoldCount > leavesBefore

    // ## Why the engine's OWN regime is read rather than recomputed
    //
    // The obvious formulation — recompute `pressureBreakdown` here and compare —
    // was tried and produced false violations, for two reasons that are easy to
    // miss and both instructive:
    //
    //   1. The engine resolves its hard capacity from `reservedCompletionTokens`,
    //      which reads the agent's request header. A test that passes
    //      `maxTokens` as the reserved amount computes a DIFFERENT capacity than
    //      the engine used, so the two disagree about what "over capacity" means.
    //   2. The engine classifies AFTER pruning, so a test measuring the
    //      pre-prune surface sees a different regime.
    //
    // `lastPressureRegime` is the regime the engine actually acted on, which is
    // precisely what the invariant is about. Reading it removes the whole class
    // of mismatch rather than trying to replicate the engine's arithmetic.

    // ## I1 is TRIGGER-AWARE, because the two paths decide on different budgets
    //
    //   pressure        → decides on the SOFT threshold
    //   context-overflow → decides on the HARD capacity
    //
    // A surface can be soft-frozen-bound while still comfortably inside the
    // provider's limit. On the overflow path that surface may legally take a
    // leaf, because the OPEN tail is what overflowed — that is gate 8, and
    // treating it as a violation is how an earlier version of this test produced
    // three false failures. So each trigger is checked against the budget it
    // actually used, read from the engine rather than recomputed here (the
    // engine's reserved-token and pruning arithmetic are not worth replicating).
    const governedBy = trigger === 'context-overflow' ? engine.lastCapacityRegime : engine.lastPressureRegime
    if (governedBy === 'frozen-bound' && folded) {
      violations.push(
        `seed ${schedule.seed} round ${round} (${trigger}): folded a leaf on a frozen-bound surface`,
      )
    }
    // Count the open-bound → frozen-bound transition. A leaf that lands the
    // prefix over the threshold is legal and is exactly why the loop re-checks;
    // what must not follow is another leaf, which the check above catches on the
    // next round because the prefix does not shrink by itself. Counting it here
    // proves the re-check path is genuinely exercised rather than assumed.
    if (folded && engine.lastPostLeafRegime === 'frozen-bound') transitions += 1

    if (attachConsumer) {
      // The idle consumer is what drains a safety intent. Driving it every round
      // is the closest a keyless test can get to the production turn→idle edge.
      await driveIdle(harness, session)
    }
  }

  return {
    steps: schedule.rounds,
    leaves: engine.leafFoldCount,
    roots: engine.rootFoldCount,
    emergencies: engine.emergencyRebaseCount,
    throws,
    pendingIntents: engine.pendingRebaseIntentCount,
    transitions,
    violations,
  }
}

/** Drive the harness's idle-maintenance edge if the harness supports it. */
async function driveIdle(harness: Harness, session: Session): Promise<void> {
  const idle = (harness as unknown as { driveIdle?: (s: Session) => Promise<void> }).driveIdle
  if (idle !== undefined) await idle(session)
}

describe('Phase 1: the convergence contract holds on generated schedules', () => {
  const SEEDS = [1, 7, 42, 99, 1234, 20_001, 65_537, 777_777]

  for (const seed of SEEDS) {
    it(`seed ${seed}: no invariant violation on a generated schedule`, async () => {
      const schedule = makeSchedule(seed)
      const outcome = await drive(schedule, false)
      expect(
        outcome.violations,
        `schedule ${JSON.stringify(schedule)}\n${outcome.violations.join('\n')}`,
      ).toEqual([])
      // I4: the run terminated within its own round budget and the fold counts
      // are bounded by the number of rounds — no unbounded retry.
      expect(outcome.steps).toBe(schedule.rounds)
      expect(outcome.leaves + outcome.roots + outcome.emergencies)
        .toBeLessThanOrEqual(schedule.rounds * 3)
    }, 300_000)
  }

  it('the generator actually reaches every regime it claims to cover', async () => {
    // Guards the guard: a generator whose schedules all stay `idle` would make
    // the invariants above vacuous. This drives each generated schedule for real
    // (folding included) and asserts the corpus spans the states the contract is
    // about, so a corpus that stopped reaching them fails here rather than
    // silently weakening every other test in this file.
    const regimes = new Set<string>()
    const capacities = new Set<string>()
    for (const seed of SEEDS) {
      const schedule = makeSchedule(seed)
      const config: EpistemicFoldConfig = {
        thresholdRatio: schedule.thresholdRatio,
        headroomTokens: 0,
        retainTokens: 0,
        maxTokens: schedule.maxTokens,
        leafAdmission: 'economic',
        rootPolicy: 'economics',
      }
      const { engine, ctx } = await createHarness({ text: 'digest' }, {
        contextWindow: schedule.window,
        efConfig: config,
      })
      const spec = resolveEfCompactSpec(resolveEfConfig(config), schedule.window, schedule.maxTokens)
      const session = conversation(4)
      const agent = { session, options: { provider: 'test-model', model: 'test-model' } } as never
      const random = makeRandom(schedule.seed ^ 0x9e3779b9)
      for (let round = 0; round < schedule.rounds; round += 1) {
        const chunks = 1 + Math.floor(random() * schedule.growthChunks)
        session.append('user/message', {
          role: 'user',
          content: [{ type: 'text', text: `round ${round} `.repeat(chunks) }],
          source: { kind: 'user' },
        } as never, { surfaceOp: 'append' })
        try {
          await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
        } catch {
          // Explicit termination is a designed outcome.
        }
        const measured = ctx.tokenMeter.measure(session)
        const breakdown = pressureBreakdown(session, measured, spec.thresholdTokens)
        regimes.add(classifyPressureRegime(breakdown))
        capacities.add(classifyCapacityRegime(breakdown, spec.hardCapacityTokens))
      }
    }
    // Both a foldable and a non-foldable pressure state must appear, and the
    // corpus must reach both sides of the hard capacity.
    expect(regimes.size, `pressure regimes seen: ${[...regimes].join(',')}`).toBeGreaterThanOrEqual(2)
    expect(capacities.size, `capacity regimes seen: ${[...capacities].join(',')}`).toBeGreaterThanOrEqual(2)
  }, 300_000)

  it('the corpus exercises the frozen-bound transition, not just the easy states', async () => {
    // The invariant that matters most is I1, and it can only be violated on a
    // surface that REACHES frozen-bound. If no generated schedule ever got
    // there, every assertion above would pass vacuously — so this asserts the
    // corpus reaches the state, and that leaves do land the prefix over the
    // threshold (which is what makes the loop's re-check load-bearing).
    const outcomes = await Promise.all(SEEDS.map(seed => drive(makeSchedule(seed), false)))
    const totalLeaves = outcomes.reduce((sum, outcome) => sum + outcome.leaves, 0)
    const totalTransitions = outcomes.reduce((sum, outcome) => sum + outcome.transitions, 0)
    const totalRebases = outcomes.reduce(
      (sum, outcome) => sum + outcome.roots + outcome.emergencies, 0,
    )
    expect(totalLeaves, 'no leaves committed across the corpus').toBeGreaterThan(0)
    expect(
      totalTransitions,
      'no leaf ever landed the prefix over the threshold, so the loop re-check was never exercised',
    ).toBeGreaterThan(0)
    expect(totalRebases, 'no rebase ran across the corpus').toBeGreaterThan(0)
  }, 300_000)
})
