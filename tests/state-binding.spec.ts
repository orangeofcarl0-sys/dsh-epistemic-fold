/**
 * The checkpoint's state binding: a rendered body must be provably the
 * projection of a state the session log supports.
 *
 * ## The failure this exists to make detectable
 *
 * A checkpoint body presents a MODEL-FACING view of the deterministic state
 * ("Current" / "Evidence" / "Open"). That view is a projection, and before this
 * binding nothing recorded WHICH state it projected — so a rendering or reducer
 * defect would show the model a state snapshot that had silently diverged from
 * what the log derives, with nothing able to notice. The memory literature
 * calls this ghost memory / governance decay: stale state that still looks
 * current.
 *
 * The bundle now records `state.digest = canonicalHash(state)`. These tests
 * check the two halves that make that useful: it is recorded when (and only
 * when) state was actually rendered, and re-deriving the state reproduces it.
 *
 * @file fixtures note: `toolConversation(..., { failTurns })` is used wherever
 * the state must be non-empty, because a failed tool result is the ONE
 * automatic production state producer — a plain `conversation()` derives
 * nothing, and an "anchors > 0" assertion against it would be vacuous.
 *
 * @module tests/state-binding
 */

import { describe, expect, it } from 'vitest'
import { canonicalHash } from '../src/hash.ts'
import { currentFoldState } from '../src/projection.ts'
import { describeRenderedState } from '../src/renderer.ts'
import { createHarness, foldAgent, SIGNAL, toolConversation } from './harness.ts'
import type { Harness } from './harness.ts'
import type { CheckpointBundleV1 } from '../src/types.ts'

/** Fold the leading span once and return the stored bundle plus its context. */
async function foldOnce(options: { projection: boolean }): Promise<{
  bundle: CheckpointBundleV1 | null
  harness: Harness
  session: ReturnType<typeof toolConversation>
}> {
  const harness = await createHarness({ text: 'digest' }, { projection: options.projection })
  // Turn 2 fails, so the reducer derives an open failure anchor and the
  // rendered body is non-empty.
  const session = toolConversation(3, { failTurns: [2] })
  const nodes = [...session.surface.nodes]
  await harness.engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)
  const listed = await harness.store.list(session.id)
  const bundle = await harness.store.read(session.id, listed[0]!.checkpointId)
  return { bundle, harness, session }
}

describe('the checkpoint body is bound to the state it projected', () => {
  it('records the digest when a projection is mounted', async () => {
    const { bundle, harness, session } = await foldOnce({ projection: true })
    expect(bundle?.state).toBeDefined()
    // The recorded digest must be the hash of the state the log derives NOW.
    const derived = currentFoldState(harness.ctx, session)
    expect(bundle!.state!.digest).toBe(canonicalHash(derived))
  })

  it('the digest is reproducible from the log, which is the whole point', async () => {
    // A verifier does not have the writer's memory of the state; it re-derives.
    // Two independent derivations of the same session must agree.
    const { bundle, harness, session } = await foldOnce({ projection: true })
    const first = describeRenderedState(currentFoldState(harness.ctx, session))
    const second = describeRenderedState(currentFoldState(harness.ctx, session))
    expect(first.digest).toBe(second.digest)
    expect(bundle!.state!.digest).toBe(first.digest)
    expect(bundle!.state!.anchors).toBe(first.anchors)
  })

  it('counts the anchors the body presents', async () => {
    const { bundle } = await foldOnce({ projection: true })
    expect(bundle!.state!.anchors).toBeGreaterThan(0)
  })

  it('omits the binding when no projection is mounted', async () => {
    // Absence is informative: with no projection the body carries no state, so
    // there is nothing to bind. A recorded digest there would be a lie.
    const { bundle } = await foldOnce({ projection: false })
    expect(bundle?.state).toBeUndefined()
  })

  it('DETECTS divergence: a recorded digest stops matching once the state moves', async () => {
    // This is the property the binding exists for, and it is NOT implied by
    // "the digest is recorded" or "it is reproducible" — both of those hold
    // even if the digest were computed over something constant. Here the
    // recorded digest is held fixed while the state legitimately advances, and
    // the mismatch is what a verifier would report.
    const { bundle, harness, session } = await foldOnce({ projection: true })
    const recorded = bundle!.state!.digest

    // The fold's own state must match at this instant: no false positive.
    expect(describeRenderedState(currentFoldState(harness.ctx, session)).digest).toBe(recorded)

    // Now the session gains an open failure — a real state change after the
    // checkpoint was written.
    session.append('tool/result', {
      turn: 99,
      step: 1,
      message: {
        role: 'tool',
        isError: true,
        toolCallId: 'call-divergence',
        content: [{ type: 'text', text: 'later failure' }],
      },
    } as never, { surfaceOp: 'append' })

    const now = describeRenderedState(currentFoldState(harness.ctx, session)).digest
    expect(now, 'a stale checkpoint must be distinguishable from a current one').not.toBe(recorded)
  })

  it('a changed state produces a different digest', async () => {
    // The detector must actually detect. Appending prose changes the log
    // without changing the derived state, and appending a FAILED tool result
    // changes the state — so the pair separates "log grew" from "state moved".
    const { harness, session } = await foldOnce({ projection: true })
    const before = describeRenderedState(currentFoldState(harness.ctx, session))

    // The reducer derives nothing from prose: the digest must MATCH.
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'ordinary prose the reducer ignores' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(describeRenderedState(currentFoldState(harness.ctx, session)).digest).toBe(before.digest)

    // A failed tool result DOES produce an anchor: the digest must CHANGE.
    session.append('tool/result', {
      turn: 99,
      step: 1,
      message: {
        role: 'tool',
        isError: true,
        toolCallId: 'call-binding-check',
        content: [{ type: 'text', text: 'boom' }],
      },
    } as never, { surfaceOp: 'append' })
    const after = describeRenderedState(currentFoldState(harness.ctx, session))
    expect(after.digest).not.toBe(before.digest)
    expect(after.anchors).toBeGreaterThan(before.anchors)
  })
})
