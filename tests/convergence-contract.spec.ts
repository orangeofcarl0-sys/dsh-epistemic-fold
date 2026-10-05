/**
 * Phase 1 — the compaction convergence contract.
 *
 * ## The invariants under test
 *
 *   I1  FrozenBound ⇒ ¬Leaf
 *   I2  an automatic compaction is SUCCESSFUL iff it reduced pressure; a
 *       non-reducing action must never repeat
 *   I3  a required stronger action must have a live consumer
 *   I4  when no legal action can reduce pressure, terminate explicitly
 *
 * ## Why these tests drive a CONSUMER
 *
 * I1 alone can be satisfied by simply refusing to fold, which is not
 * convergence — it is a surface that grows until the provider rejects it. The
 * pairing matters: a frozen-bound surface must stop folding AND hand off to a
 * rebase that actually runs. So every convergence test here mounts the real
 * plugin and drives its idle consumer, and asserts on the engine's own
 * counters rather than on a store listing.
 *
 * The benches that drive no consumer are the configuration I3 forbids; they are
 * covered separately by the tests that pin the LEAK (a pending intent with
 * nobody to drain it), not by these.
 *
 * @module tests/convergence-contract
 */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { allWorkloads, WORKLOAD_MODEL } from '../eval/workloads/index.ts'
import { createIdleMaintenanceHook, runPairedBaseline } from '../bench/paired-baseline.ts'
import { createHarness, SIGNAL } from './harness.ts'
import type { Harness } from './harness.ts'
import { classifyCapacityRegime, classifyPressureRegime, pressureBreakdown } from '../src/pressure.ts'
import { resolveEfCompactSpec } from '../src/policy.ts'
import { isRebaseMode } from '../src/types.ts'

const WINDOW = 16_000
const THRESHOLD_RATIO = 0.15

/** The aggressive regime: a low threshold is what pushes the frozen prefix over it. */
async function harness(options: {
  readonly plugin: boolean
  readonly config?: Record<string, unknown>
}): Promise<Harness> {
  return createHarness({ text: 'ef digest' }, {
    contextWindow: WINDOW,
    ...(options.plugin ? { plugin: true } : {}),
    workloadModel: WORKLOAD_MODEL,
    efConfig: {
      thresholdRatio: THRESHOLD_RATIO,
      headroomTokens: 0,
      retainTokens: 0,
      maxTokens: 3_000,
      ...options.config,
    },
  })
}

async function run(input: {
  readonly harness: Harness
  readonly steps: number
  readonly rebase: boolean
  readonly workloadIndex?: number
}): Promise<ReturnType<typeof runPairedBaseline> extends Promise<infer R> ? R : never> {
  const workload = allWorkloads()[input.workloadIndex ?? 0]!
  return runPairedBaseline({
    arm: 'convergence',
    harness: input.harness,
    createSession: workload.createSession,
    steps: input.steps,
    grow: (session: Session, step: number) => workload.grow(session, step),
    ...(input.rebase ? { rebase: createIdleMaintenanceHook(input.harness) } : {}),
    signal: SIGNAL,
  })
}

describe('Phase 1: I1 — a frozen-bound surface never folds a leaf', () => {
  it('a frozen-bound surface folds nothing, and hands off instead', async () => {
    // I1 is a claim about the DECISION, so it is tested at the decision.
    //
    // A step's recorded sample is the POST-step state, so comparing a sample's
    // regime against that step's fold count cannot test the invariant: a step
    // that starts open-bound may legally fold, and the fold itself is what
    // pushes the frozen prefix over the threshold. The surface is then
    // frozen-bound and the sample says so — correctly, and without any
    // violation. What I1 forbids is a fold taken while the surface is ALREADY
    // frozen-bound, so the engine is driven directly with such a surface.
    const h = await harness({ plugin: true, config: { leafAdmission: 'economic', rootPolicy: 'economics' } })
    const workload = allWorkloads()[0]!
    const session = workload.createSession()

    // Grow until the engine reports a frozen-bound decision, which is the state
    // under test. The loop stops as soon as it is reached.
    const agent = { session, options: { provider: WORKLOAD_MODEL, model: WORKLOAD_MODEL } } as never
    let reachedFrozenBound = false
    for (let step = 1; step <= 64 && !reachedFrozenBound; step += 1) {
      if (step > 1) session.append('turn/end', { turn: 1_000_000 + step - 1, reason: { kind: 'completed' } })
      session.append('turn/start', { turn: 1_000_000 + step })
      workload.grow(session, step)
      try {
        await (h.engine as unknown as {
          compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
        }).compactIfNeeded(agent, 'pressure', SIGNAL)
      } catch {
        // Explicit non-convergence is a designed outcome.
      }
      reachedFrozenBound = h.engine.lastPressureRegime === 'frozen-bound'
    }
    expect(reachedFrozenBound, 'the workload never reached frozen-bound; the gate is untested').toBe(true)

    // NOW the invariant: with the surface frozen-bound, another pressure request
    // must add ZERO leaves and must record a safety intent instead.
    const leavesBefore = h.engine.leafFoldCount
    const intentsBefore = h.engine.pendingRebaseIntentCount
    try {
      await (h.engine as unknown as {
        compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
      }).compactIfNeeded(agent, 'pressure', SIGNAL)
    } catch {
      // A throw is acceptable; a leaf is not.
    }
    expect(h.engine.lastPressureRegime).toBe('frozen-bound')
    expect(
      h.engine.leafFoldCount,
      'a frozen-bound surface folded a leaf; I1 requires zero',
    ).toBe(leavesBefore)
    expect(h.engine.pendingRebaseIntentCount).toBeGreaterThanOrEqual(intentsBefore)
  }, 300_000)

  it('the invariant holds on every sample of a long aggressive run', async () => {
    // The run-level counterpart: across a full aggressive trajectory, a
    // frozen-bound surface must not be followed by a fold that GROWS the
    // prefix. The check is that no step adds a leaf while the PREVIOUS state
    // was already frozen-bound — the decision the engine actually faced.
    const h = await harness({ plugin: true, config: { leafAdmission: 'economic', rootPolicy: 'economics' } })
    const result = await run({ harness: h, steps: 48, rebase: true })

    const violations: number[] = []
    for (let index = 1; index < result.pressure.samples.length; index += 1) {
      const previous = result.pressure.samples[index - 1]!
      if (previous.regime !== 'frozen-bound') continue
      const surface = result.attribution.steps[index]?.checkpoints.leaf ?? 0
      const before = result.attribution.steps[index - 1]?.checkpoints.leaf ?? 0
      // A leaf fold grows the surface's leaf-checkpoint count; a rebase resets
      // it. So growth from an already-frozen-bound state is the violation.
      if (surface > before) violations.push(index)
    }
    expect(violations, `steps ${violations.join(',')} grew the prefix while frozen-bound`).toEqual([])
  }, 300_000)

  it('a run that reaches frozen-bound still converges when a consumer drains the intent', async () => {
    // The point of I1+I3 together: stopping the leaf is only half the contract.
    // With the production consumer attached, the handoff must actually land a
    // rebase — otherwise the surface only grows until the provider refuses it.
    //
    // Convergence is asserted through the ENGINE's own counters, not through
    // the sampled regime: `frozenBoundCount` counts samples taken at step
    // boundaries, and the handoff is decided mid-step on a re-measurement, so
    // the two need not agree on a number. What must hold is that a rebase
    // landed and nothing was left pending.
    const h = await harness({ plugin: true, config: { leafAdmission: 'economic', rootPolicy: 'economics' } })
    const result = await run({ harness: h, steps: 48, rebase: true })
    expect(result.rootFoldCount).toBeGreaterThan(0)
    expect(h.engine.pendingRebaseIntentCount).toBe(0)
    // The decision that produced the handoff names the structural reason.
    expect(h.engine.lastRebaseDecision?.action).toBe('root')
    expect(h.engine.lastRebaseDecision?.reason).toMatch(/no leaf can restore headroom|rebase is required/u)
  }, 300_000)

  it('legacy also stops folding at frozen-bound rather than thrashing to a throw', async () => {
    // `legacy` freezes the fold DECISIONS, not the license to run a known-futile
    // action. Before Phase 1 it folded every step and then threw when retries
    // ran out; now a frozen-bound surface folds nothing and hands off.
    const h = await harness({ plugin: true })
    const workload = allWorkloads()[0]!
    const session = workload.createSession()
    const agent = { session, options: { provider: WORKLOAD_MODEL, model: WORKLOAD_MODEL } } as never
    let reachedFrozenBound = false
    for (let step = 1; step <= 64 && !reachedFrozenBound; step += 1) {
      if (step > 1) session.append('turn/end', { turn: 1_000_000 + step - 1, reason: { kind: 'completed' } })
      session.append('turn/start', { turn: 1_000_000 + step })
      workload.grow(session, step)
      try {
        await (h.engine as unknown as {
          compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
        }).compactIfNeeded(agent, 'pressure', SIGNAL)
      } catch {
        // Designed outcome; the assertion below is what matters.
      }
      reachedFrozenBound = h.engine.lastPressureRegime === 'frozen-bound'
    }
    expect(reachedFrozenBound, 'the workload never reached frozen-bound; the gate is untested').toBe(true)
    const leavesBefore = h.engine.leafFoldCount
    try {
      await (h.engine as unknown as {
        compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
      }).compactIfNeeded(agent, 'pressure', SIGNAL)
    } catch {
      // Acceptable: I4 permits explicit termination.
    }
    expect(h.engine.leafFoldCount).toBe(leavesBefore)
  }, 300_000)
})

describe('Phase 1: I4 — a surface with no consumer leaks rather than converges', () => {
  it('an undrained intent is visible as a pending count, not silently lost', async () => {
    // I3's failure mode made observable. This engine HAS the producer and NO
    // consumer, which is exactly the harness configuration that produced the
    // LHTB `roots=0`. The count must be non-zero so the leak is a fact a reader
    // can see, rather than a zero that reads as "no rebase was needed".
    const h = await harness({ plugin: false, config: { leafAdmission: 'economic', rootPolicy: 'economics' } })
    await run({ harness: h, steps: 48, rebase: false })
    expect(h.engine.pendingRebaseIntentCount).toBeGreaterThan(0)
  }, 300_000)

  it('the same run with a consumer drains every intent', async () => {
    // The contrast that makes the previous test meaningful: attach the
    // production consumer and the same workload leaves nothing pending.
    const h = await harness({ plugin: true, config: { leafAdmission: 'economic', rootPolicy: 'economics' } })
    await run({ harness: h, steps: 48, rebase: true })
    expect(h.engine.pendingRebaseIntentCount).toBe(0)
  }, 300_000)
})

describe('Phase 1: I2 — pressure accounting and the rebase identity', () => {
  it('the soft threshold never exceeds the hard capacity', async () => {
    // The invariant the hard-bound work rests on. It is `<=`, not `<`: with
    // `headroomTokens` 0 and a high ratio the two coincide, which is exactly
    // when a soft-only reaction is already too late.
    const spec = resolveEfCompactSpec(
      (await harness({ plugin: false })).engine['efConfig'] as never,
      WINDOW,
      512,
    )
    expect(spec.thresholdTokens).toBeLessThanOrEqual(spec.hardCapacityTokens)
  })

  it('classifyCapacityRegime separates "over capacity" from "frozen over capacity"', () => {
    const breakdown = (frozen: number, open: number, threshold: number) => ({
      frozenTokens: frozen,
      openTokens: open,
      totalTokens: frozen + open,
      frozenRatio: frozen / Math.max(1, frozen + open),
      openRatio: open / Math.max(1, frozen + open),
      frozenCount: frozen > 0 ? 1 : 0,
      thresholdTokens: threshold,
      leafCannotSuffice: frozen >= threshold,
    })
    // Under the hard capacity: fits, whatever the soft threshold says.
    expect(classifyCapacityRegime(breakdown(1_000, 1_000, 500), 10_000)).toBe('fits')
    // Over it, but the open tail is the cause: a leaf can still help.
    expect(classifyCapacityRegime(breakdown(1_000, 12_000, 500), 10_000)).toBe('open-bound')
    // Over it and the FROZEN PREFIX alone is the cause: no leaf can help.
    expect(classifyCapacityRegime(breakdown(12_000, 1_000, 500), 10_000)).toBe('frozen-bound')
  })

  it('an emergency rebase is rebase-like: it collapses the prefix like a root', () => {
    // The structural rule, so a surface that counts checkpoints cannot treat an
    // emergency as a leaf that appends one.
    expect(isRebaseMode('emergency')).toBe(true)
    expect(isRebaseMode('root')).toBe(true)
    expect(isRebaseMode('leaf')).toBe(false)
  })
})

describe('Phase 1: the classifier agrees with the invariant it enforces', () => {
  it('frozen-bound implies leafCannotSuffice, by construction', () => {
    // A guard against the two notions drifting: `classifyPressureRegime` calls a
    // surface frozen-bound exactly when the breakdown says a leaf cannot help.
    const breakdown = {
      frozenTokens: 5_000,
      openTokens: 100,
      totalTokens: 5_100,
      frozenRatio: 5_000 / 5_100,
      openRatio: 100 / 5_100,
      frozenCount: 1,
      thresholdTokens: 2_400,
      leafCannotSuffice: true,
    }
    expect(classifyPressureRegime(breakdown)).toBe('frozen-bound')
    expect(pressureBreakdown).toBeTypeOf('function')
  })
})
