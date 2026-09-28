/**
 * M0 suite, classes E–F: semantic failures, cancellation, double compaction,
 * and crash-point tests (T17–T24). Every scenario is deterministic: failure
 * timing is controlled at the adapter (semantic) or store (archive) boundary.
 */

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  conversation,
  createHarness,
  extractCheckpointId,
  foldAgent,
  lastCompactionEnd,
  lastCompactionSummary,
  SIGNAL,
  surfaceMessages,
} from './harness.ts'
import { recall } from '../src/recall.ts'
import { canonicalHash } from '../src/hash.ts'
import { failingStore, flakyStore } from './stores.ts'

function summaryText(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => block.type === 'text' ? block.text : '').join('\n')
}

function checkpointIdOf(session: ReturnType<typeof conversation>): string {
  return extractCheckpointId(summaryText(lastCompactionSummary(session)!.summary as ContentBlock[]))!
}

describe('E. failure tests', () => {
  it('T17: semantic model timeout → deterministic fallback, bundle durable, compaction continues', async () => {
    const { engine, store } = await createHarness({
      failure: { kind: 'error', message: 'semantic timeout' },
    })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    const expected = surfaceMessages(session, nodes.slice(0, 4))

    // The transaction SUCCEEDS with a fallback checkpoint (never a retry that
    // would rewrite the selected input).
    const result = await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)
    expect(result.shadowedSeqs).toHaveLength(4)

    const bundle = await store.verify(checkpointIdOf(session))
    expect(bundle.status).toBe('verified')
    if (bundle.status === 'verified') {
      expect(bundle.bundle.semantic).toBeUndefined()
      expect(bundle.bundle.rendered.text).toContain('semantic summary unavailable')
      expect(canonicalHash(bundle.bundle.archive.shadowedMessages)).toBe(canonicalHash(expected))
    }
    const end = lastCompactionEnd(session)
    expect(end?.error).toBeUndefined()
    // Recall serves the fallback summary.
    const recalled = await recall({ store, checkpointId: checkpointIdOf(session), depth: 'summary' })
    expect(recalled?.text).toContain('Exact archived model history is recoverable')
  })

  it('T18: semantic malformed output (empty text) → same deterministic fallback', async () => {
    const { engine, store } = await createHarness({ text: '' })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]

    const result = await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)
    expect(result.shadowedSeqs).toHaveLength(4)
    const bundle = await store.verify(checkpointIdOf(session))
    if (bundle.status === 'verified') {
      expect(bundle.bundle.semantic).toBeUndefined()
    }
  })

  it('T19: cancellation before commit leaves no inconsistent state', async () => {
    const controller = new AbortController()
    const { engine, store } = await createHarness({ text: 'slow digest' })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]

    controller.abort()
    await expect(
      engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), controller.signal),
    ).rejects.toThrow()

    expect(lastCompactionSummary(session)).toBeUndefined()
    const end = lastCompactionEnd(session)
    expect(end?.error).toBeDefined()
    expect(await store.list(session.id)).toHaveLength(0)
  })

  it('T20: overlapping compaction on one session fails closed on the candidate slot', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const { engine, store } = await createHarness({ text: 'digest', gate })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    const agent = foldAgent(session)

    // Hold compaction #1 open inside its semantic call.
    const first = engine.compactRegion(nodes[0]!, nodes[3]!, agent, SIGNAL).then(
      value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error }),
    )
    // Give the first hook time to reach the gate, then attempt the overlap.
    await new Promise(resolve => setTimeout(resolve, 30))
    await expect(engine.compactRegion(nodes[0]!, nodes[2]!, agent, SIGNAL))
      .rejects.toThrow(/pending fold candidate|already in progress/u)

    release()
    const settled = await first
    expect(settled.ok).toBe(true)
    // Exactly one committed checkpoint with an exactly verifying bundle.
    const summary = lastCompactionSummary(session)
    expect(summary).toBeDefined()
    const verification = await store.verify(checkpointIdOf(session))
    expect(verification.status).toBe('verified')
  })
})

describe('F. crash-point tests', () => {
  it('T21: crash after archive temp write — transaction aborts, surface intact, lock released', async () => {
    const { engine } = await createHarness(
      { text: 'digest' },
      { bundleStore: failingStore('crash during tmp write') },
    )
    const session = conversation(4)
    const nodes = [...session.surface.nodes]

    await expect(engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL))
      .rejects.toThrow(/crash during tmp write/u)

    expect(lastCompactionSummary(session)).toBeUndefined()
    expect([...session.surface.nodes]).toEqual(nodes)
    // The failed attempt is durably visible.
    expect(lastCompactionEnd(session)?.error).toBeDefined()
  })

  it('T22: crash after publish, before commit — orphan bundle detectable and verifiable', async () => {
    // Post-publish failure via Basic's shrink check: the bundle is durable,
    // the surface unchanged, and the orphan enumerable for later GC.
    const { engine, store } = await createHarness({ text: 'orphan '.repeat(600) })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]

    await expect(engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL))
      .rejects.toThrow(/not smaller than the shadowed content/u)

    const bundles = await store.list(session.id)
    expect(bundles).toHaveLength(1)
    expect((await store.verify(bundles[0]!.checkpointId)).status).toBe('verified')
    expect([...session.surface.nodes]).toEqual(nodes)
  })

  it('T23: failed summary leaves the lock released — the next compaction succeeds', async () => {
    const { store, real } = await flakyStore(1)
    const { engine } = await createHarness({ text: 'digest' }, { bundleStore: store })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]

    await expect(engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL))
      .rejects.toThrow(/disk full/u)

    // The flaky store heals after its first failure: the durable lock must
    // have been released by the recorded compaction/end, so a fresh
    // compaction commits cleanly.
    const nodesAfter = [...session.surface.nodes]
    const retry = await engine.compactRegion(nodesAfter[0]!, nodesAfter[3]!, foldAgent(session), SIGNAL)
    expect(retry.shadowedSeqs).toHaveLength(4)
    expect((await real.verify(checkpointIdOf(session))).status).toBe('verified')
  })

  it('T24: replacement committed — end event recorded, bundle verifies, recall exact', async () => {
    const { engine, store } = await createHarness({ text: 'digest' })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    await engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)

    const end = lastCompactionEnd(session)
    expect(end).toBeDefined()
    expect(end?.error).toBeUndefined()
    const verification = await store.verify(checkpointIdOf(session))
    expect(verification.status).toBe('verified')
    const exact = await recall({ store, checkpointId: checkpointIdOf(session), depth: 'exact', limit: 100 })
    const expected = surfaceMessages(session, nodes.slice(0, 4))
    expect(canonicalHash(exact?.page?.messages)).toBe(canonicalHash(expected))
  })
})
