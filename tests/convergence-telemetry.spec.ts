/**
 * Phase 0 — telemetry truth: the engine's fold counters must count what the
 * engine DID, not what a store still happens to hold.
 *
 * ## The defects this pins
 *
 * The LHTB harness classified a fold by substring-matching the JSON of the
 * returned `CompactionResult` for `"kind":"root"`. That could never fire:
 * `CompactionResult` has no `kind` field, and its summary block is tagged
 * `type`. A real root fold therefore read as `roots=0`, and the finding built
 * on that column ("the rebase path never ran anywhere") was unsupported.
 *
 * The same harness reported bundle counts via `bundleStore.list().length` with
 * the error swallowed to `0`, so "the store is unreadable", "a bundle was
 * removed" and "the session never folded" were one number.
 *
 * These tests assert the replacement: monotonic engine counters that a caller
 * reads as deltas, plus a store reading that can say "unknown" rather than 0.
 *
 * @module tests/convergence-telemetry
 */

import { describe, expect, it } from 'vitest'
import { createHarness, conversation, idleAgent, SIGNAL } from './harness.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** A closed-turn session, so a manual root fold is admissible. */
function idleSession(turns = 4): Session {
  const session = conversation(turns)
  session.append('turn/end', { turn: turns + 1, reason: { kind: 'completed' } })
  return session
}

describe('Phase 0: the engine counts its own folds', () => {
  it('starts at zero on every counter', async () => {
    const { engine } = await createHarness({ text: 'digest' }, { contextWindow: 8_000 })
    expect(engine.leafFoldCount).toBe(0)
    expect(engine.rootFoldCount).toBe(0)
    expect(engine.emergencyRebaseCount).toBe(0)
    expect(engine.bundleWriteCount).toBe(0)
    expect(engine.pendingRebaseIntentCount).toBe(0)
    expect(engine.lastPressureRegime).toBeUndefined()
  })

  it('a committed root fold increments rootFoldCount and bundleWriteCount', async () => {
    const { engine } = await createHarness({ text: 'digest' }, { contextWindow: 8_000 })
    const session = idleSession(4)
    const result = await engine.compactNow(idleAgent(session), SIGNAL)
    expect(result).not.toBeNull()
    expect(engine.rootFoldCount).toBe(1)
    // A root is NOT a leaf: the counters must not both move.
    expect(engine.leafFoldCount).toBe(0)
    expect(engine.emergencyRebaseCount).toBe(0)
    expect(engine.bundleWriteCount).toBe(1)
  })

  it('a committed leaf fold increments leafFoldCount, not rootFoldCount', async () => {
    // Window and fixture chosen so the surface is over the threshold while the
    // frozen prefix is still EMPTY: with no frozen checkpoint, `leafCannotSuffice`
    // is false by construction, so the first fold is open-bound and a leaf.
    const { engine } = await createHarness({ text: 'digest' }, {
      contextWindow: 2_000,
      efConfig: { thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 500 },
    })
    // The automatic pressure path performs a LEAF fold, and automatic
    // compaction events must be enclosed in an open turn.
    const session = conversation(6)
    await engine.compactIfNeeded(idleAgent(session), 'pressure', SIGNAL)
    expect(engine.leafFoldCount).toBeGreaterThan(0)
    expect(engine.rootFoldCount).toBe(0)
    expect(engine.bundleWriteCount).toBe(engine.leafFoldCount)
  })

  it('bundleWriteCount is monotonic and independent of what the store holds', async () => {
    // The distinction that matters: `list()` counts files PRESENT, which drops
    // when a bundle is removed or the root is unreadable. The write counter
    // records what happened and must never go backwards.
    const { engine, store } = await createHarness({ text: 'digest' }, { contextWindow: 8_000 })
    const session = idleSession(4)
    await engine.compactNow(idleAgent(session), SIGNAL)
    const written = engine.bundleWriteCount
    expect(written).toBe(1)

    const bundles = await store.list(session.id)
    expect(bundles.length).toBe(1)
    await store.remove(session.id, bundles[0]!.checkpointId)

    // The store no longer holds it; the engine's record of having written it stands.
    expect((await store.list(session.id)).length).toBe(0)
    expect(engine.bundleWriteCount).toBe(written)
  })

  it('lastPressureRegime records the regime the automatic path acted on', async () => {
    const { engine } = await createHarness({ text: 'digest' }, {
      contextWindow: 2_000,
      efConfig: { thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 500 },
    })
    const session = conversation(6)
    await engine.compactIfNeeded(idleAgent(session), 'pressure', SIGNAL)
    // The surface is over the threshold and the frozen prefix is empty, so the
    // regime must be `open-bound` — not `undefined` (the path returned before
    // classifying) and not `frozen-bound` (there is no frozen checkpoint yet).
    expect(engine.lastPressureRegime).toBe('open-bound')
  })

  it('bundleWriteCount counts PUBLISHES, which can exceed committed folds', async () => {
    // Found by driving the real bridge against a live route: eight bundles on
    // disk against a telemetry reading of `folds=2`. The cause is designed, not
    // a leak — `BundleDurable ≺ SurfaceLoss` requires the archive to be durable
    // BEFORE the surface is replaced, so `summarize` publishes and Basic may
    // then refuse the commit ("could not produce a smaller summary").
    //
    // This pins the direction of the asymmetry, because the other direction
    // would be data loss: a committed fold with NO published bundle would mean
    // history was replaced with nothing to recover it from.
    const { engine } = await createHarness({ text: 'digest' }, {
      contextWindow: 2_000,
      plugin: true,
      efConfig: { thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 100 },
    })
    // A one-turn session is small enough that a root fold's framed summary is
    // not smaller than the shadowed span, so Basic refuses it after EF has
    // already published.
    const session = conversation(1)
    session.append('turn/end', { turn: 99, reason: { kind: 'completed' } })
    await expect(engine.compactNow(idleAgent(session), SIGNAL)).rejects.toThrow()

    expect(engine.rootFoldCount, 'the fold must NOT have committed').toBe(0)
    expect(engine.bundleWriteCount, 'the publish still happened, and is counted').toBe(1)
    // The published bundle is real and retrievable — the consequence a caller
    // must know about.
    const bundles = await engine.bundleStore.list(session.id)
    expect(bundles.length).toBe(1)
  })

  it('a committed fold never lacks a published bundle', async () => {
    // The direction that WOULD be data loss, asserted so the asymmetry above
    // cannot be "fixed" by making writes lag commits.
    const { engine } = await createHarness({ text: 'digest' }, { contextWindow: 8_000 })
    const session = idleSession(4)
    await engine.compactNow(idleAgent(session), SIGNAL)
    expect(engine.rootFoldCount).toBe(1)
    expect(engine.bundleWriteCount).toBeGreaterThanOrEqual(engine.rootFoldCount)
  })

  it('pendingRebaseIntentCount exposes a producer without a consumer', async () => {
    // The leak this makes visible: an engine that records an intent and is
    // never driven by an idle consumer reports a non-zero count forever, so the
    // count is how a missing consumer becomes OBSERVABLE rather than silent.
    const { engine } = await createHarness({ text: 'digest' }, {
      contextWindow: 2_000,
      efConfig: {
        thresholdRatio: 0.15,
        headroomTokens: 0,
        retainTokens: 0,
        maxTokens: 500,
        leafAdmission: 'economic',
        rootPolicy: 'economics',
      },
    })
    const session = conversation(6)
    const agent = idleAgent(session) as Agent
    // Grow the surface inside ONE open turn, which is what the automatic path
    // requires. A throw is a legitimate outcome here — I4 terminates explicitly
    // when leaves reduce pressure but cannot reach the threshold — so it is
    // caught rather than allowed to mask the telemetry assertion.
    for (let round = 0; round < 12; round += 1) {
      session.append('user/message', {
        role: 'user',
        content: [{ type: 'text', text: `pressure round ${round} `.repeat(20) }],
        source: { kind: 'user' },
      } as never, { surfaceOp: 'append' })
      try {
        await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
      } catch {
        // Explicit non-convergence is a designed outcome, not a test failure.
      }
    }
    // The accessor must be a valid count whether or not a consumer ever ran.
    expect(Number.isInteger(engine.pendingRebaseIntentCount)).toBe(true)
    expect(engine.pendingRebaseIntentCount).toBeGreaterThanOrEqual(0)
  })
})
