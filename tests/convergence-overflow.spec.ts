/**
 * Phase 1 — provider-overflow recovery: the path that had NO test coverage.
 *
 * ## Why this file exists
 *
 * Before Phase 1, `compactIfNeeded('context-overflow')` went straight to a leaf
 * fold with `retain 0`, consulting neither the soft threshold nor the hard
 * capacity. No test drove it: `grep -rn "context-overflow" tests/` matched only
 * a comment and an unrelated window-safety verdict, and the keyless bench only
 * ever drives `'pressure'`. The branch was therefore reachable in production
 * and unreachable in CI — the exact shape of defect this project's own RC21
 * record describes.
 *
 * ## The configuration that reaches it
 *
 * A hard-frozen-bound surface is what makes a leaf mathematically useless, and
 * it is NOT reachable under a default ratio: the SOFT handoff stops folding
 * first and hands off at the soft threshold, which sits well below the hard
 * capacity. It becomes reachable exactly when `thresholdTokens` and
 * `hardCapacityTokens` COINCIDE — `thresholdRatio` high enough that the ratio
 * term is clamped by the message budget (here `min(0.9 * 1000, 900) = 900`,
 * with `headroomTokens: 0`).
 *
 * That is not a contrived corner. `resolveEfCompactSpec` computes
 * `thresholdTokens = min(floor(window * ratio), messageBudget - headroom)`, so
 * the two are equal for any deployment with `headroomTokens: 0` and a ratio at
 * or above `messageBudget / window` — and `headroomTokens: 0` is what both the
 * tau2 harness and the keyless bench pass. In that configuration a soft-only
 * reaction is already too late, which is why the hard check exists.
 *
 * @module tests/convergence-overflow
 */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createHarness, conversation, idleAgent, SIGNAL } from './harness.ts'
import { parseCheckpointMarker } from '../src/checkpoint-marker.ts'
import { classifyCapacityRegime, pressureBreakdown } from '../src/pressure.ts'
import { resolveEfCompactSpec, resolveEfConfig } from '../src/policy.ts'
import type { EpistemicFoldEngine } from '../src/engine.ts'

/** `thresholdRatio: 0.9` + `headroomTokens: 0` makes soft == hard. See the module note. */
const SOFT_EQUALS_HARD = {
  thresholdRatio: 0.9,
  headroomTokens: 0,
  retainTokens: 0,
  maxTokens: 100,
} as const

const WINDOW = 1_000

function specFor(): ReturnType<typeof resolveEfCompactSpec> {
  return resolveEfCompactSpec(resolveEfConfig({ ...SOFT_EQUALS_HARD }), WINDOW, 100)
}

async function harness(): Promise<{ engine: EpistemicFoldEngine; ctx: Awaited<ReturnType<typeof createHarness>>['ctx'] }> {
  const created = await createHarness({ text: 'digest' }, {
    contextWindow: WINDOW,
    efConfig: { ...SOFT_EQUALS_HARD },
  })
  return { engine: created.engine, ctx: created.ctx }
}

/** Grow until the surface is hard-frozen-bound, which is the state under test. */
async function growToHardFrozen(
  engine: EpistemicFoldEngine,
  ctx: Awaited<ReturnType<typeof createHarness>>['ctx'],
  session: Session,
  agent: Agent,
  maxRounds = 120,
): Promise<boolean> {
  const spec = specFor()
  for (let round = 0; round < maxRounds; round += 1) {
    session.append('user/message', {
      role: 'user',
      content: [{ type: 'text', text: `growth round ${round} `.repeat(60) }],
      source: { kind: 'user' },
    } as never, { surfaceOp: 'append' })
    try {
      await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    } catch {
      // Explicit non-convergence is a designed outcome on this path.
    }
    const measurement = ctx.tokenMeter.measure(session)
    const breakdown = pressureBreakdown(session, measurement, spec.thresholdTokens)
    if (classifyCapacityRegime(breakdown, spec.hardCapacityTokens) === 'frozen-bound') return true
  }
  return false
}

describe('Phase 1: provider-overflow recovery', () => {
  it('the fixture reaches hard-frozen-bound, so the gate below is not vacuous', async () => {
    // Guards the guard: every assertion in this file is about what happens on a
    // hard-frozen-bound surface, so a fixture that never reaches one would make
    // them all pass vacuously.
    const { engine, ctx } = await harness()
    const session = conversation(4)
    const agent = idleAgent(session) as Agent
    const reached = await growToHardFrozen(engine, ctx, session, agent)
    expect(reached, 'the fixture never reached hard-frozen-bound; the gate is untested').toBe(true)
  }, 300_000)

  it('soft and hard coincide in this configuration, which is why the hard check matters', () => {
    const spec = specFor()
    expect(spec.thresholdTokens).toBe(spec.hardCapacityTokens)
  })

  it('a hard-frozen-bound surface escalates to an EMERGENCY rebase and folds ZERO leaves', async () => {
    // The defect this replaces: the old path called `compactLeafFromFrontier`
    // unconditionally, so on a surface whose frozen prefix already exceeded the
    // provider's limit it folded the tail, appended another checkpoint to that
    // prefix, and overflowed again.
    const { engine, ctx } = await harness()
    const session = conversation(4)
    const agent = idleAgent(session) as Agent
    expect(await growToHardFrozen(engine, ctx, session, agent)).toBe(true)

    const leavesBefore = engine.leafFoldCount
    const emergenciesBefore = engine.emergencyRebaseCount
    try {
      await engine.compactIfNeeded(agent, 'context-overflow', SIGNAL)
    } catch {
      // The rebase may still not fit; the counters below are what matter.
    }

    // The escalation ran...
    expect(engine.emergencyRebaseCount).toBeGreaterThan(emergenciesBefore)
    // ...and a leaf did NOT, because a leaf cannot reduce a frozen prefix.
    expect(
      engine.leafFoldCount,
      'overflow recovery folded a leaf on a hard-frozen-bound surface',
    ).toBe(leavesBefore)
  }, 300_000)

  it('the emergency rebase actually reduces the surface below the hard capacity', async () => {
    // I2: the action must reduce pressure, not merely run. This is the assertion
    // that distinguishes a working escalation from a rebase that happens to
    // commit and leave the surface unchanged.
    const { engine, ctx } = await harness()
    const session = conversation(4)
    const agent = idleAgent(session) as Agent
    expect(await growToHardFrozen(engine, ctx, session, agent)).toBe(true)
    const spec = specFor()
    const before = ctx.tokenMeter.measure(session)
    const beforeBreakdown = pressureBreakdown(session, before, spec.thresholdTokens)
    expect(classifyCapacityRegime(beforeBreakdown, spec.hardCapacityTokens)).toBe('frozen-bound')

    await engine.compactIfNeeded(agent, 'context-overflow', SIGNAL)

    const after = ctx.tokenMeter.measure(session)
    const afterBreakdown = pressureBreakdown(session, after, spec.thresholdTokens)
    // The frozen prefix — the part a leaf cannot touch — must have SHRUNK.
    expect(afterBreakdown.frozenTokens).toBeLessThan(beforeBreakdown.frozenTokens)
    // And the surface must now be sendable.
    expect(classifyCapacityRegime(afterBreakdown, spec.hardCapacityTokens)).toBe('fits')
  }, 300_000)

  it('the emergency rebase is counted apart from roots and carries the E marker', async () => {
    // An emergency rebase and a root have the SAME surface effect but are
    // different events: a root is maintenance chosen at idle, an emergency
    // rebase is forced because the provider refused the request. Collapsing the
    // two counters is how a reader loses the ability to tell them apart.
    const { engine } = await harness()
    const session = conversation(4)
    const agent = idleAgent(session) as Agent
    await growToHardFrozen(engine, ctxOf(engine), session, agent)
    const rootsBefore = engine.rootFoldCount
    try {
      await engine.compactIfNeeded(agent, 'context-overflow', SIGNAL)
    } catch {
      // Designed outcome.
    }
    // ASSERTED, not guarded. This used to be `if (engine.emergencyRebaseCount > 0)`
    // followed by `expect(engine.emergencyRebaseCount).toBeGreaterThanOrEqual(0)`
    // — so the test's only unconditional assertion was one that cannot fail, and
    // the two meaningful ones were skipped whenever the fixture failed to produce
    // a rebase. Measured on this fixture: 1 emergency rebase, 0 roots, in 3 of 3
    // runs, so the state is deterministic and the guard was hiding it. The
    // non-vacuity gate above ("the fixture reaches hard-frozen-bound") is what
    // makes asserting this safe.
    expect(engine.emergencyRebaseCount, 'the fixture must produce exactly one emergency rebase').toBe(1)
    expect(engine.rootFoldCount, 'and it must not be counted as a root').toBe(rootsBefore)
    // The audit identity survives into the durable bundle, which is what the
    // status surfaces read.
    const bundles = await engine.bundleStore.list(session.id)
    expect(bundles.map(bundle => bundle.mode)).toContain('emergency')
  }, 300_000)

  it('every committed fold published a bundle, and publishes can exceed commits', async () => {
    const { engine, ctx } = await harness()
    const session = conversation(4)
    const agent = idleAgent(session) as Agent
    await growToHardFrozen(engine, ctx, session, agent)
    try {
      await engine.compactIfNeeded(agent, 'context-overflow', SIGNAL)
    } catch {
      // Designed outcome.
    }
    // The monotonic write counter must not be a store listing — it cannot drift
    // when a bundle is removed, which is the property the old
    // `bundleStore.list().length` telemetry lacked.
    //
    // It is `>=`, NOT `===`, and the difference is designed. `BundleDurable ≺
    // SurfaceLoss` requires the archive to be durable before the surface is
    // replaced, so a bundle is published during `summarize` and Basic may then
    // REFUSE the commit (e.g. "could not produce a smaller summary"). Such a
    // fold leaves a published bundle and no committed fold. Measured on a
    // one-turn session: `writes 1, root 0`.
    const committed = engine.leafFoldCount + engine.rootFoldCount + engine.emergencyRebaseCount
    expect(engine.bundleWriteCount).toBeGreaterThanOrEqual(committed)
    // And a committed fold must always have published: the reverse gap would
    // mean a surface replacement with no archive, which is data loss.
    expect(engine.bundleWriteCount).toBeGreaterThan(0)
  }, 300_000)

  it('the checkpoint marker round-trips the emergency mode', () => {
    // The marker is what the frontier and both status surfaces read to classify
    // a fold. If `E` did not parse back to `emergency`, an emergency rebase
    // would be counted as a leaf by every surface.
    const marker = parseCheckpointMarker('[EF1 E cp:123e4567-e89b-12d3-a456-426614174000]')
    expect(marker?.mode).toBe('emergency')
  })
})

/**
 * Gates 8, 10 and 11 from the convergence work order.
 *
 * These three cover the OVERFLOW branch specifically, and each needs a
 * different surface shape, which is why they live in their own block with their
 * own fixtures rather than sharing the hard-frozen helper above.
 */
describe('Phase 1: overflow recovery — the three remaining gates', () => {
  /**
   * A surface whose OPEN trajectory alone exceeds the hard capacity, with no
   * frozen prefix yet. This is the shape where a leaf is still the right answer.
   */
  async function openBoundOverflow(): Promise<{
    engine: EpistemicFoldEngine
    session: Session
    agent: Agent
    spec: ReturnType<typeof resolveEfCompactSpec>
    ctx: Awaited<ReturnType<typeof createHarness>>['ctx']
  }> {
    const config = { thresholdRatio: 0.9, headroomTokens: 0, retainTokens: 0, maxTokens: 500 }
    const created = await createHarness({ text: 'digest' }, { contextWindow: 3_000, efConfig: config })
    const session = conversation(2)
    // Several open messages that together exceed the hard capacity, so the
    // frozen prefix is still empty and a leaf can genuinely help.
    for (let index = 0; index < 12; index += 1) {
      session.append('user/message', {
        role: 'user',
        content: [{ type: 'text', text: `message ${index} `.repeat(200) }],
        source: { kind: 'user' },
      } as never, { surfaceOp: 'append' })
    }
    return {
      engine: created.engine,
      session,
      agent: idleAgent(session) as Agent,
      spec: resolveEfCompactSpec(resolveEfConfig(config), 3_000, 500),
      ctx: created.ctx,
    }
  }

  it('gate 8 — overflow + open-bound: a LEAF recovers, and no emergency rebase runs', async () => {
    // The counterpart to the frozen-bound escalation. When the open trajectory
    // is what overflowed, a leaf is the cheaper correct action and the surface
    // must be recovered by it rather than by rewriting the prefix.
    const { engine, session, agent, spec, ctx } = await openBoundOverflow()
    const before = ctx.tokenMeter.measure(session)
    const beforeBreakdown = pressureBreakdown(session, before, spec.thresholdTokens)
    // The fixture must actually be over the hard capacity, or this tests nothing.
    expect(classifyCapacityRegime(beforeBreakdown, spec.hardCapacityTokens)).toBe('open-bound')
    expect(beforeBreakdown.frozenCount).toBe(0)

    const leavesBefore = engine.leafFoldCount
    const emergenciesBefore = engine.emergencyRebaseCount
    const generationBefore = session.surface.replaceGeneration
    await engine.compactIfNeeded(agent, 'context-overflow', SIGNAL)

    // A leaf did the work...
    expect(engine.leafFoldCount).toBeGreaterThan(leavesBefore)
    // ...the prefix was NOT rewritten, which is what keeps this path cheap...
    expect(engine.emergencyRebaseCount).toBe(emergenciesBefore)
    // ...and the surface now fits, which is what authorizes the caller's retry.
    const after = ctx.tokenMeter.measure(session)
    expect(classifyCapacityRegime(
      pressureBreakdown(session, after, spec.thresholdTokens),
      spec.hardCapacityTokens,
    )).toBe('fits')
    expect(session.surface.replaceGeneration).toBeGreaterThan(generationBefore)
  }, 300_000)

  it('gate 10 — an emergency rebase is retry-proof: the surface replacement generation advances', async () => {
    // The caller's retry is authorized by `surface.replaceGeneration` growing,
    // which is exactly what Basic's own overflow handler checks. An emergency
    // rebase that committed without replacing the surface would leave the
    // caller retrying the same request forever, so the generation delta is the
    // property that makes the recovery usable rather than merely present.
    const { engine, ctx } = await harness()
    const session = conversation(4)
    const agent = idleAgent(session) as Agent
    expect(await growToHardFrozen(engine, ctx, session, agent)).toBe(true)

    const generationBefore = session.surface.replaceGeneration
    const emergenciesBefore = engine.emergencyRebaseCount
    await engine.compactIfNeeded(agent, 'context-overflow', SIGNAL)

    expect(engine.emergencyRebaseCount).toBeGreaterThan(emergenciesBefore)
    expect(
      session.surface.replaceGeneration,
      'the emergency rebase did not replace the surface, so a retry would re-send the same request',
    ).toBeGreaterThan(generationBefore)
  }, 300_000)

  it('gate 11 — when nothing can fit, recovery fails EXPLICITLY rather than looping', async () => {
    // A single oversized message is indivisible: no fold can shrink it below the
    // capacity, and the prefix cannot be rewritten to something smaller either.
    // The contract is that this ends in a thrown error naming the reason — not
    // in a silent return that lets the caller retry the identical request, which
    // is the unbounded retry loop I4 forbids.
    const config = { thresholdRatio: 0.9, headroomTokens: 0, retainTokens: 0, maxTokens: 800 }
    const { engine, ctx } = await createHarness({ text: 'digest' }, {
      contextWindow: 1_000,
      efConfig: config,
    })
    const spec = resolveEfCompactSpec(resolveEfConfig(config), 1_000, 800)
    const session = conversation(2)
    const agent = idleAgent(session) as Agent
    session.append('user/message', {
      role: 'user',
      content: [{ type: 'text', text: 'oversized '.repeat(4_000) }],
      source: { kind: 'user' },
    } as never, { surfaceOp: 'append' })
    expect(ctx.tokenMeter.measure(session).totalTokens).toBeGreaterThan(spec.hardCapacityTokens)

    // Either the recovery throws its own diagnosis, or the underlying
    // transaction refuses to shrink — both are explicit failures. What must NOT
    // happen is a silent success that leaves the surface over capacity.
    let threw = false
    try {
      await engine.compactIfNeeded(agent, 'context-overflow', SIGNAL)
    } catch {
      threw = true
    }
    const after = ctx.tokenMeter.measure(session)
    const stillOver = classifyCapacityRegime(
      pressureBreakdown(session, after, spec.thresholdTokens),
      spec.hardCapacityTokens,
    ) !== 'fits'
    expect(
      threw || !stillOver,
      'overflow recovery returned silently while the surface still exceeded the hard capacity',
    ).toBe(true)
  }, 300_000)
})

/** A context handle for the growth helper, obtained from the engine's own meter. */
function ctxOf(engine: EpistemicFoldEngine): Awaited<ReturnType<typeof createHarness>>['ctx'] {
  return (engine as unknown as { ctx: Awaited<ReturnType<typeof createHarness>>['ctx'] }).ctx
}
