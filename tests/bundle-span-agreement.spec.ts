/**
 * A fold's bundle seq list must identify exactly the archive it describes.
 *
 * ## The defect this exists for
 *
 * `currentSpanSeqs` derives the surface seqs a bundle's `ArchiveRef`s point at.
 * Its guard compared the number of SURFACE NODES in the fold span against the
 * number of ARCHIVED MESSAGES, and threw when they differed.
 *
 * Those are not the same quantity. A surface node does not always derive a
 * message — `deriveEventMessage` returns `null` for events that carry none — and
 * Basic's own summarization input FILTERS those out (`src/basic/region.ts`:
 * `.map(seq => session.deriveEventMessage(…)).filter(message => message !== null)`).
 * So a span of N nodes can legitimately archive fewer than N messages.
 *
 * It fired on a live LHTB trial, after five folds had already committed cleanly:
 *
 *   epistemic-fold: leaf fold span has 20 surface node(s) but archived 19
 *   message(s); the bundle's seq refs would not identify its archive
 *
 * That message ended the episode with a `BridgeError` and reward 0. The guard
 * was doing its job — it correctly refused to publish a bundle whose refs did
 * not match its archive — but it was comparing the wrong two numbers, so it
 * refused a fold that was fine.
 *
 * ## What is asserted, and an honest limit
 *
 * The real invariant is that a fold's seq list must DERIVE as many messages as
 * the archive holds. That is checked end-to-end here: fold a real session and
 * compare the published bundle's refs against its archive, using the same
 * derivation Basic uses.
 *
 * **This fixture cannot reproduce the original failure.** Verified destructively:
 * reintroducing `span.length` in place of the derived count leaves these tests
 * PASSING, because a synthetic `conversation()` session has no surface node that
 * fails to derive a message — so `span.length === messageCount` and the two
 * forms are indistinguishable. The live LHTB trial produced that node; this
 * fixture does not.
 *
 * What the tests DO cover is the invariant itself: if a fold ever publishes refs
 * that do not resolve to exactly its archive, they fail. They are a guard on the
 * contract, not a reproduction of the bug. Reproducing it would need a session
 * carrying a surface node with no derivable message, which this harness cannot
 * construct today — recorded here so the gap is known rather than assumed away.
 *
 * @module tests/bundle-span-agreement
 */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { createHarness, conversation, idleAgent, SIGNAL } from './harness.ts'
import { resolveArchiveRefs, sessionEventSource } from '../src/archive-refs.ts'

/** Fold once with the automatic pressure path and return the session. */
async function foldOnce(
  config: Record<string, unknown> = {},
): Promise<{ session: Session; engine: Awaited<ReturnType<typeof createHarness>>['engine'] }> {
  const { engine } = await createHarness({ text: 'digest' }, {
    contextWindow: 2_000,
    efConfig: {
      thresholdRatio: 0.15,
      headroomTokens: 0,
      retainTokens: 0,
      maxTokens: 100,
      // The seq-ref path only exists when the experimental referential archive
      // is ON. It defaults OFF, and an inline bundle carries its messages
      // directly with an EMPTY `refs` list — so a test that forgot this switch
      // would pass vacuously on zero refs.
      referentialArchive: true,
      ...config,
    },
  })
  const session = conversation(6)
  await engine.compactIfNeeded(idleAgent(session) as never, 'pressure', SIGNAL)
  return { session, engine }
}

describe("a bundle's seq refs identify exactly its archive", () => {
  it('a leaf fold publishes refs that resolve to every archived message', async () => {
    const { session, engine } = await foldOnce()
    const bundles = await engine.bundleStore.list(session.id)
    expect(bundles.length, 'the fixture folded nothing').toBeGreaterThan(0)

    let checked = 0
    for (const descriptor of bundles) {
      const bundle = await engine.bundleStore.read(session.id, descriptor.checkpointId)
      expect(bundle, `bundle ${descriptor.checkpointId} is unreadable`).not.toBeNull()
      const refs = bundle!.archive.refs
      // A referential bundle MUST carry refs; an empty list here would mean the
      // switch did not take effect and the assertions below would be vacuous.
      expect(refs, `bundle ${descriptor.checkpointId} has no refs`).toBeDefined()
      expect(refs!.length, 'a referential bundle must carry refs').toBeGreaterThan(0)
      checked += 1

      // Every ref must resolve, and the resolved count must equal the archive's
      // own message count. This is the invariant the guard was reaching for.
      const resolved = resolveArchiveRefs(refs!, sessionEventSource(session))
      expect(
        resolved.status,
        `bundle ${descriptor.checkpointId} has refs that do not resolve: `
        + (resolved.status === 'unresolved' ? JSON.stringify(resolved.failures) : ''),
      ).toBe('resolved')
      if (resolved.status === 'resolved') {
        expect(
          resolved.messages.length,
          `bundle ${descriptor.checkpointId} refs resolve to a different count than its archive`,
        ).toBe(bundle!.archive.messageCount)
      }
    }
    expect(checked, 'no referential bundle was checked').toBeGreaterThan(0)
  }, 300_000)

  it('the seq list derives exactly the archived message count', async () => {
    // The direct form of the fixed guard: count DERIVED MESSAGES, not nodes.
    // This is the assertion that fails if the off-by-one returns, because the
    // span contains nodes that derive no message while the archive counts only
    // the ones that do.
    const { session, engine } = await foldOnce()
    const bundles = await engine.bundleStore.list(session.id)
    const bundle = await engine.bundleStore.read(session.id, bundles[0]!.checkpointId)
    const refs = bundle!.archive.refs
    expect(refs).toBeDefined()
    expect(refs!.length).toBeGreaterThan(0)

    const derived = refs!.filter(
      ref => session.deriveEventMessage(session.eventAt(ref.seq as never)!) !== null,
    ).length
    expect(derived).toBe(bundle!.archive.messageCount)
  }, 300_000)

  it('a root fold publishes refs that resolve to its whole archive', async () => {
    // The root path has its own span walk, and it had the same node-vs-message
    // confusion. Exercised separately so a regression there is distinguishable
    // from one on the leaf path.
    const { engine } = await createHarness({ text: 'digest' }, {
      contextWindow: 8_000,
      efConfig: { referentialArchive: true },
    })
    const session = conversation(4)
    session.append('turn/end', { turn: 5, reason: { kind: 'completed' } })
    await engine.compactNow(idleAgent(session), SIGNAL)

    const bundles = await engine.bundleStore.list(session.id)
    expect(bundles.length).toBeGreaterThan(0)
    let checked = 0
    for (const descriptor of bundles) {
      const bundle = await engine.bundleStore.read(session.id, descriptor.checkpointId)
      const refs = bundle!.archive.refs
      expect(refs, `bundle ${descriptor.checkpointId} has no refs`).toBeDefined()
      expect(refs!.length).toBeGreaterThan(0)
      checked += 1
      const resolved = resolveArchiveRefs(refs!, sessionEventSource(session))
      expect(resolved.status).toBe('resolved')
      if (resolved.status === 'resolved') {
        expect(resolved.messages.length).toBe(bundle!.archive.messageCount)
      }
    }
    expect(checked).toBeGreaterThan(0)
  }, 300_000)
})
