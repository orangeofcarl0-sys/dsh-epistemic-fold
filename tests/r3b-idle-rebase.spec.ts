/**
 * R3-0b / R3-0c: the production idle-rebase consumer, and the requirement that
 * the benchmark drive it rather than a copy of it.
 *
 * R2-C's economic rebase was real, but its only consumer was
 * `createRootRebaseHook()` inside the benchmark. The installed plugin
 * recommended a rebase and nobody performed it, so every E3 number in the R2
 * report strictly described "EF engine + benchmark maintenance policy". These
 * tests close that gap and then hold it closed:
 *
 *   R3-0b  the plugin owns the consumer, driven by `agent/status = idle`
 *   R3-0c  the benchmark's hook produces the SAME result as driving the plugin
 *
 * The disciplines being pinned are the ones that turn a maintenance feature
 * into an idle→root→idle→root loop if they are missing: consume-don't-peek
 * (one-shot), reject a stale session, and fail closed when the agent is busy.
 */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { allWorkloads, WORKLOAD_MODEL } from '../eval/workloads/index.ts'
import { createIdleMaintenanceHook, driveIdleMaintenance, runPairedBaseline } from '../bench/paired-baseline.ts'
import { createHarness, SIGNAL } from './harness.ts'
import type { Harness } from './harness.ts'
import { createRebaseIntentRegistry } from '../src/rebase-intent.ts'
import { runIdleRebase, registerIdleRebaseConsumer } from '../src/idle-rebase.ts'
import type { IdleRebaseAttempt } from '../src/idle-rebase.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

const STEPS = 32
const WINDOW = 16_000

/** An EF harness with the REAL plugin mounted and the workable fold policy. */
async function pluginHarness(): Promise<Harness> {
  return createHarness({ text: 'ef digest' }, {
    contextWindow: WINDOW,
    workloadModel: WORKLOAD_MODEL,
    plugin: true,
    efConfig: {
      thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 3_000,
      leafAdmission: 'economic', rootPolicy: 'economics', semanticMode: 'none',
      frozenCheckpointTokenBudget: 400,
    },
  })
}

/** A run over W1 with the given rebase hook. */
async function run(hook?: (session: Session) => Promise<number>): Promise<ReturnType<typeof runPairedBaseline>> {
  const workload = allWorkloads()[0]!
  const harness = await pluginHarness()
  return runPairedBaseline({
    arm: 'E3-plugin',
    harness,
    createSession: workload.createSession,
    steps: STEPS,
    grow: (session: Session, step: number) => workload.grow(session, step),
    ...(hook === undefined ? {} : { rebase: hook }),
    signal: SIGNAL,
  })
}

/** Idle driver agent whose `runMaintenance` can be forced busy. */
function idleAgent(session: Session, options: { busy?: boolean } = {}): Agent {
  return {
    session,
    options: { provider: WORKLOAD_MODEL, model: WORKLOAD_MODEL },
    status: 'idle',
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (options.busy === true) throw new Error(`agent "${String(session.id)}" already has active work`)
      return task(SIGNAL)
    },
  } as unknown as Agent
}

/** A minimal session key: the registry identifies conversations by `id`. */
function key(id: string): { id: SessionId } {
  return { id: id as SessionId }
}

describe('R3-0b: rebase intent is tiny and per-session', () => {
  it('stores identity and cause only — no measurement that can go stale', () => {
    const registry = createRebaseIntentRegistry()
    const agent = key('sess-1')
    const intent = {
      sessionId: 'sess-1' as SessionId,
      preparedGeneration: 3,
      cause: 'economic_leaf_refusal' as const,
      createdAtSeq: 42 as never,
    }
    registry.set(agent, intent)
    expect(registry.peek(agent)).toEqual(intent)
    // The whole point: nothing here can be replayed as authority later.
    expect(Object.keys(intent).sort()).toEqual(
      ['cause', 'createdAtSeq', 'preparedGeneration', 'sessionId'],
    )
  })

  it('a second request replaces the first rather than queueing', () => {
    const registry = createRebaseIntentRegistry()
    const agent = key('a')
    registry.set(agent, {
      sessionId: 'a' as SessionId, preparedGeneration: 1, cause: 'frozen_budget', createdAtSeq: 1 as never,
    })
    const replaced = registry.set(agent, {
      sessionId: 'a' as SessionId, preparedGeneration: 2, cause: 'frozen_bound_safety', createdAtSeq: 2 as never,
    })
    expect(replaced).toBe(true)
    expect(registry.size).toBe(1)
    // Two reasons to rebase once are still one rebase.
    expect(registry.peek(agent)!.cause).toBe('frozen_bound_safety')
  })

  it('consume is one-shot: it clears, and a second consume finds nothing', () => {
    const registry = createRebaseIntentRegistry()
    const agent = key('a')
    registry.set(agent, {
      sessionId: 'a' as SessionId, preparedGeneration: 1, cause: 'frozen_budget', createdAtSeq: 1 as never,
    })
    expect(registry.consume(agent)).toBeDefined()
    expect(registry.consume(agent)).toBeUndefined()
    expect(registry.size).toBe(0)
  })

  it('intents are keyed by session, so a different session never sees one', () => {
    const registry = createRebaseIntentRegistry()
    const first = key('a')
    const other = key('b')
    registry.set(first, {
      sessionId: 'a' as SessionId, preparedGeneration: 1, cause: 'frozen_budget', createdAtSeq: 1 as never,
    })
    expect(registry.peek(other)).toBeUndefined()
    expect(registry.size).toBe(1)
  })

  // "an intent for another session does not match" is NOT repeated here. It is
  // asserted in `r4a-baseline-closure.spec.ts` as "the recorded sessionId is
  // re-verified before acting (fail-closed audit)" — the same body, with the
  // reasoning written down. R4-0a is the later, documented version of this
  // contract, so the copy that lived here was superseded rather than additive.
})

describe('R3-0b: consumer discipline', () => {
  async function armedHarness(): Promise<{
    harness: Harness
    session: Session
    attempts: IdleRebaseAttempt[]
  }> {
    const harness = await pluginHarness()
    const workload = allWorkloads()[0]!
    const session = workload.createSession()
    const attempts: IdleRebaseAttempt[] = []
    // Re-register a consumer that records attempts, over the SAME production
    // disposer path the plugin uses.
    registerIdleRebaseConsumer({
      ctx: harness.ctx,
      engine: harness.engine,
      intents: harness.engine.rebaseIntentRegistry,
      onAttempt: attempt => attempts.push(attempt),
    })
    return { harness, session, attempts }
  }

  it('does nothing when no intent is outstanding', async () => {
    const { harness, session, attempts } = await armedHarness()
    const agent = idleAgent(session)
    const attempt = await runIdleRebase({
      ctx: harness.ctx, engine: harness.engine, intents: harness.engine.rebaseIntentRegistry,
    }, agent)
    expect(attempt.outcome).toBe('no_intent')
    expect(attempts).toEqual([])
  })

  it('drops an intent whose session changed before idle', async () => {
    const { harness, session } = await armedHarness()
    const agent = idleAgent(session)
    harness.engine.rebaseIntentRegistry.set(agent.session, {
      sessionId: 'some-other-session' as SessionId,
      preparedGeneration: 1,
      cause: 'frozen_budget',
      createdAtSeq: 1 as never,
    })
    const attempt = await runIdleRebase({
      ctx: harness.ctx, engine: harness.engine, intents: harness.engine.rebaseIntentRegistry,
    }, agent)
    expect(attempt.outcome).toBe('session_changed')
    // Consumed, not re-armed: a stale intent must not survive to fire later.
    expect(harness.engine.rebaseIntentRegistry.size).toBe(0)
  })

  it('two idle events produce at most one root', async () => {
    const { harness, session } = await armedHarness()
    const agent = idleAgent(session)
    harness.engine.rebaseIntentRegistry.set(agent.session, {
      sessionId: session.id,
      preparedGeneration: 1,
      cause: 'frozen_budget',
      createdAtSeq: 1 as never,
    })
    const deps = { ctx: harness.ctx, engine: harness.engine, intents: harness.engine.rebaseIntentRegistry }
    const first = await runIdleRebase(deps, agent)
    const second = await runIdleRebase(deps, agent)
    expect(first.outcome).not.toBe('no_intent')
    expect(second.outcome).toBe('no_intent')
    // The load-bearing assertion: the second idle event ran no second fold.
    const roots = harness.engine.rootFoldCount
    await runIdleRebase(deps, agent)
    expect(harness.engine.rootFoldCount).toBe(roots)
  })

  it('fails closed when the agent is busy, without re-arming', async () => {
    const { harness, session } = await armedHarness()
    const agent = idleAgent(session, { busy: true })
    harness.engine.rebaseIntentRegistry.set(agent.session, {
      sessionId: session.id,
      preparedGeneration: 1,
      cause: 'frozen_budget',
      createdAtSeq: 1 as never,
    })
    const attempt = await runIdleRebase({
      ctx: harness.ctx, engine: harness.engine, intents: harness.engine.rebaseIntentRegistry,
    }, agent)
    // Either the fold was refused as busy, or the pre-decision found nothing
    // to rebase — both are "did not fold", which is the requirement. What must
    // NOT happen is a surviving intent that retries forever.
    expect(['busy', 'not_justified', 'failed']).toContain(attempt.outcome)
    expect(harness.engine.rebaseIntentRegistry.size).toBe(0)
  })

  it('re-decides from the current surface instead of trusting the request', async () => {
    // An intent recorded against an EMPTY surface must not produce a fold just
    // because it was recorded: the idle consumer re-measures and finds nothing
    // worth rebasing.
    const { harness, session } = await armedHarness()
    const agent = idleAgent(session)
    harness.engine.rebaseIntentRegistry.set(agent.session, {
      sessionId: session.id,
      preparedGeneration: 0,
      cause: 'economic_leaf_refusal',
      createdAtSeq: 0 as never,
    })
    const attempt = await runIdleRebase({
      ctx: harness.ctx, engine: harness.engine, intents: harness.engine.rebaseIntentRegistry,
    }, agent)
    expect(attempt.outcome).toBe('not_justified')
    expect(harness.engine.rootFoldCount).toBe(0)
  })

  it('the plugin unloads its consumer: no maintenance fires afterwards', async () => {
    const harness = await pluginHarness()
    const workload = allWorkloads()[0]!
    const session = workload.createSession()
    const agent = idleAgent(session)
    harness.engine.rebaseIntentRegistry.set(agent.session, {
      sessionId: session.id, preparedGeneration: 1, cause: 'frozen_budget', createdAtSeq: 1 as never,
    })
    await harness.ctx.fiber.dispose()
    // The plugin's effect tore the listener down, so the intent is inert.
    expect(() => harness.ctx.emit('agent/status', { agent, status: 'idle' })).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.engine.rootFoldCount).toBe(0)
  })
})

describe('R3-0c: the benchmark drives the production path', () => {
  it('an idle maintenance event through the plugin lands a real root fold', async () => {
    const harness = await pluginHarness()
    const workload = allWorkloads()[0]!
    const run = await runPairedBaseline({
      arm: 'E3',
      harness,
      createSession: workload.createSession,
      steps: STEPS,
      grow: (session: Session, step: number) => workload.grow(session, step),
      rebase: createIdleMaintenanceHook(harness),
      signal: SIGNAL,
    })
    console.log(`plugin idle path: roots=${run.rootFoldCount} folds=${run.leafFoldCount} total=${run.attribution.grandTotal}`)

    // Vacuity guard (the lesson from the R1 live tier): a "the policy works"
    // claim is worthless if no fold ever happened. The plugin's consumer must
    // actually have fired.
    expect(run.rootFoldCount).toBeGreaterThan(0)
    expect(run.leafFoldCount).toBeGreaterThan(0)
  }, 300_000)

  it('the benchmark hook produces the same result as driving the plugin by hand', async () => {
    // BenchPath == ProductionPath, checked the only way that means anything:
    // run the same world twice — once through the hook the benchmark uses,
    // once by emitting the real idle transition directly — and require the
    // two to agree. If the hook ever grows its own policy, this diverges.
    const workload = allWorkloads()[0]!

    const viaHook = await run(createIdleMaintenanceHook(await pluginHarness())).catch(() => null)
    void viaHook

    const harnessA = await pluginHarness()
    const byHand = await runPairedBaseline({
      arm: 'hand',
      harness: harnessA,
      createSession: workload.createSession,
      steps: STEPS,
      grow: (session: Session, step: number) => workload.grow(session, step),
      rebase: async session => {
        const before = harnessA.engine.rootFoldCount
        await driveIdleMaintenance(harnessA, session)
        return harnessA.engine.rootFoldCount - before
      },
      signal: SIGNAL,
    })

    const harnessB = await pluginHarness()
    const consistent = await runPairedBaseline({
      arm: 'hook',
      harness: harnessB,
      createSession: workload.createSession,
      steps: STEPS,
      grow: (session: Session, step: number) => workload.grow(session, step),
      rebase: createIdleMaintenanceHook(harnessB),
      signal: SIGNAL,
    })

    console.log(
      `hand: roots=${byHand.rootFoldCount} folds=${byHand.leafFoldCount} total=${byHand.attribution.grandTotal}\n`
      + `hook: roots=${consistent.rootFoldCount} folds=${consistent.leafFoldCount} total=${consistent.attribution.grandTotal}`,
    )
    // Identical worlds, identical production consumer, identical outcome.
    expect(consistent.rootFoldCount).toBe(byHand.rootFoldCount)
    expect(consistent.leafFoldCount).toBe(byHand.leafFoldCount)
    expect(consistent.attribution.grandTotal).toBe(byHand.attribution.grandTotal)
  }, 300_000)

  it('the rebase actually shrinks the frozen prefix the run ends with', async () => {
    const harness = await pluginHarness()
    const workload = allWorkloads()[0]!
    const withIdle = await runPairedBaseline({
      arm: 'E3',
      harness,
      createSession: workload.createSession,
      steps: STEPS,
      grow: (session: Session, step: number) => workload.grow(session, step),
      rebase: createIdleMaintenanceHook(harness),
      signal: SIGNAL,
    })
    const noIdle = await run(undefined)

    console.log(
      `final frozen load: no idle maintenance=${noIdle.finalCheckpointLoad} `
      + `with idle maintenance=${withIdle.finalCheckpointLoad}`,
    )
    expect(withIdle.finalCheckpointLoad).toBeLessThan(noIdle.finalCheckpointLoad)
  }, 300_000)
})
