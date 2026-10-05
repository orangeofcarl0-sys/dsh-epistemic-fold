/**
 * The benchmark harness drives the PRODUCTION maintenance lifecycle.
 *
 * ## The two defects this pins
 *
 * **1. No consumer.** `bridge-host.ts` constructed `EpistemicFoldEngine` directly,
 * so the plugin's idle-rebase consumer was never registered. Phase 1 made that
 * fatal rather than merely incomplete: a frozen-bound surface hands off to a
 * rebase instead of folding, and with nothing to drain the handoff the surface
 * stops folding and never converges. That is the I3 violation — a required
 * stronger action with no live consumer — and it is what the old `roots = 0`
 * column was really reporting across every LHTB trial.
 *
 * **2. The turn was still open.** Even with a consumer mounted, an idle root is a
 * MANUAL compaction (`owner: null`), and `compactSurfaceRegion` refuses one while
 * a turn is open ("manual compaction: the session already has an open turn").
 * The host keeps a turn open across model calls, so emitting idle without closing
 * it first made every rebase attempt FAIL.
 *
 * The second defect is the dangerous one, because it is INVISIBLE in the
 * counters: the intent is recorded and consumed, so `pendingRebaseIntentCount`
 * returns to 0 and the run looks exactly like a rebase that was never justified.
 * Measured before the fix: 50 consecutive frozen-bound rounds, every one
 * reporting `outcome: "failed"` for this reason, `roots` 0 throughout.
 *
 * ## What is asserted
 *
 * The lifecycle is exercised the way the host drives it — close the turn, emit
 * `agent/status = idle`, await the consumer's own settle handle — and the
 * assertions are on OUTCOMES (a rebase landed, the surface converged), not on
 * the fact that an event was emitted. A test that only checked "the consumer was
 * called" would have passed with the turn open and the rebase failing.
 *
 * @module tests/harness-maintenance-lifecycle
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import { allWorkloads, WORKLOAD_MODEL } from '../eval/workloads/index.ts'
import { createHarness, SIGNAL } from './harness.ts'
import type { Harness } from './harness.ts'
import { classifyPressureRegime, pressureBreakdown } from '../src/pressure.ts'
import { resolveEfCompactSpec, resolveEfConfig } from '../src/policy.ts'

const ROOT = join(import.meta.dirname, '..')
const BRIDGE = join(ROOT, 'eval', 'tau2', 'bridge-host.ts')

/** Config that reaches frozen-bound: a low ratio and a small completion reserve. */
const CONVERGENCE_CONFIG = {
  thresholdRatio: 0.15,
  headroomTokens: 0,
  retainTokens: 0,
  maxTokens: 100,
  leafAdmission: 'economic' as const,
  rootPolicy: 'economics' as const,
}

/**
 * Reproduce the host's maintenance ordering: CLOSE the open turn, emit idle,
 * await the consumer, then REOPEN a turn for the automatic fold path.
 *
 * @param harness - a harness mounted with the real plugin.
 * @param session - the live session.
 * @param turn - a turn number for the synthetic close/open pair.
 */
async function driveHostMaintenance(harness: Harness, session: Session, turn: number): Promise<void> {
  const mounted = harness.plugin
  if (mounted === undefined || harness.engine.basicMode) return
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  let busy = false
  const agent = {
    session,
    options: { provider: WORKLOAD_MODEL, model: WORKLOAD_MODEL },
    get status(): string {
      return busy ? 'running' : 'idle'
    },
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (busy) throw new Error('already has active work')
      busy = true
      return (async () => {
        try {
          return await task(SIGNAL)
        } finally {
          busy = false
        }
      })()
    },
  } as never
  harness.ctx.emit('agent/status', { agent, status: 'idle' })
  await mounted.idleRebase?.settled()
  session.append('turn/start', { turn: turn + 1 })
}

/** Grow a session and run the pressure path + the host maintenance edge. */
async function runConvergence(rounds: number): Promise<{
  harness: Harness
  session: Session
  handoffs: number
  finalRegime: string
  finalFrozen: number
}> {
  const harness = await createHarness({ text: 'digest' }, {
    contextWindow: 2_000,
    plugin: true,
    workloadModel: WORKLOAD_MODEL,
    efConfig: CONVERGENCE_CONFIG,
  })
  const spec = resolveEfCompactSpec(
    resolveEfConfig(CONVERGENCE_CONFIG),
    2_000,
    CONVERGENCE_CONFIG.maxTokens,
  )
  const workload = allWorkloads()[0]!
  const session = workload.createSession()
  const agent = { session, options: { provider: WORKLOAD_MODEL, model: WORKLOAD_MODEL } } as never
  // A HANDOFF is the coverage signal, not a sampled regime.
  //
  // Measuring the regime at a round boundary undercounts badly once the drain
  // works: the rebase collapses the prefix before the next measurement, so a run
  // with five successful rebases can report zero frozen-bound samples. Counting
  // an outstanding intent right after the fold observes the decision itself —
  // "a frozen-bound surface handed off" — which is the path this file is about.
  let handoffs = 0
  let finalRegime = 'idle'
  let finalFrozen = 0
  for (let round = 0; round < rounds; round += 1) {
    session.append('user/message', {
      role: 'user',
      content: [{ type: 'text', text: `round ${round} `.repeat(80) }],
      source: { kind: 'user' },
    } as never, { surfaceOp: 'append' })
    try {
      await harness.engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    } catch {
      // Explicit non-convergence is a designed outcome.
    }
    if (harness.engine.pendingRebaseIntentCount > 0) handoffs += 1

    await driveHostMaintenance(harness, session, 500_000 + round)

    const after = harness.ctx.tokenMeter.measure(session)
    const afterBreakdown = pressureBreakdown(session, after, spec.thresholdTokens)
    finalRegime = classifyPressureRegime(afterBreakdown)
    finalFrozen = afterBreakdown.frozenTokens
  }
  return { harness, session, handoffs, finalRegime, finalFrozen }
}

describe('the benchmark harness drives the production maintenance lifecycle', () => {
  it('bridge-host mounts the plugin rather than constructing the engine', () => {
    // Source-level because the host is a script: importing it starts the stdin
    // protocol loop, so its engine cannot be constructed in a unit test.
    const source = readFileSync(BRIDGE, 'utf8')
    expect(
      source,
      'the harness must mount the plugin; a directly-constructed engine has no idle '
      + 'consumer, so a frozen-bound handoff is never drained and the run cannot converge',
    ).toContain('new EpistemicFoldPlugin(ctx')
    expect(source).toContain('plugin.engine')
  })

  it('bridge-host closes the turn before emitting idle', () => {
    // The ordering that is silent when wrong: an idle root is a manual
    // compaction and is refused while a turn is open. The assertion is that
    // `closeTurn` is reachable in the drain path, before the emit.
    const source = readFileSync(BRIDGE, 'utf8')
    const drain = source.slice(source.indexOf('async function drainIdleRebase'))
    const closeAt = drain.indexOf('closeTurn()')
    const emitAt = drain.indexOf("emit('agent/status'")
    expect(closeAt, 'the drain must close the open turn').toBeGreaterThan(-1)
    expect(emitAt, 'the drain must emit the idle transition').toBeGreaterThan(-1)
    expect(
      closeAt,
      'closeTurn must precede the idle emit, or every rebase fails with "already has an open turn"',
    ).toBeLessThan(emitAt)
  })

  it('a frozen-bound surface CONVERGES: rebases land and the prefix shrinks', async () => {
    // The outcome assertion. Before the turn-close fix this measured leaf=3,
    // root=0, frozen=357 and a surface stuck at frozen-bound; the fix produces
    // leaf=6, root=5, frozen≈119 and an open-bound surface.
    const { harness, handoffs, finalRegime, finalFrozen } = await runConvergence(60)
    expect(handoffs, 'no handoff was ever recorded; the gate is vacuous').toBeGreaterThan(0)
    expect(
      harness.engine.rootFoldCount,
      'no rebase landed: the handoff was recorded but never drained into a fold',
    ).toBeGreaterThan(0)
    expect(
      harness.engine.pendingRebaseIntentCount,
      'an intent outlived the run, which means no consumer drained it',
    ).toBe(0)
    // Convergence, not merely activity: the run must END below the threshold
    // rather than oscillating at frozen-bound forever.
    expect(finalRegime, 'the run ended frozen-bound: the handoff did not converge').not.toBe('frozen-bound')
    expect(finalFrozen).toBeLessThan(357)
  }, 300_000)

  it('every committed fold published a bundle', async () => {
    const { harness } = await runConvergence(40)
    // `>=`, not `===`: a publish can be followed by a REFUSED commit, because
    // `BundleDurable ≺ SurfaceLoss` requires the archive to be durable before
    // Basic decides whether to replace the surface. The reverse gap (a commit
    // with no publish) would be data loss and is asserted absent.
    const committed =
      harness.engine.leafFoldCount + harness.engine.rootFoldCount + harness.engine.emergencyRebaseCount
    expect(harness.engine.bundleWriteCount).toBeGreaterThanOrEqual(committed)
    expect(committed, 'the fixture committed no folds, so the assertion is vacuous').toBeGreaterThan(0)
  }, 300_000)

  it('the Basic arm has no consumer to drive, and drives none', async () => {
    // `mode: 'basic'` returns early from the plugin, so there is no idle consumer
    // and nothing to drain. The harness must skip the lifecycle rather than emit
    // an idle event at a plugin that never registered a listener.
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 2_000,
      efConfig: { ...CONVERGENCE_CONFIG, mode: 'basic' },
    })
    const session = allWorkloads()[0]!.createSession()
    await driveHostMaintenance(harness, session, 1)
    expect(harness.engine.basicMode).toBe(true)
    expect(harness.engine.rootFoldCount).toBe(0)
    expect(harness.engine.bundleWriteCount).toBe(0)
  }, 300_000)
})
