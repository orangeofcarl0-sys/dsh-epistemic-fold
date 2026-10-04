/**
 * The cross-session recall experiment: resolving a checkpoint that belongs to
 * a session which is not loaded.
 *
 * ## Why this is gated separately, and default-off
 *
 * Recall is session-scoped by construction (`FoldBundleStore.read` refuses a
 * foreign session, R0-A). Serving a foreign checkpoint means opening a stored
 * log that may be concurrently written, archived, or migrated — a failure
 * surface the in-memory path does not have. Measured on a real 1.9 MB log,
 * resolving a checkpoint's refs took 2.6 ms via a ranged read against 132 ms
 * for a full replay, so the cost is fine; the RISK is what the gate is for.
 *
 * These tests check the gate itself: off means "not found" with no persistence
 * access at all, on means a foreign ref resolves, and a caller's own checkpoint
 * is never re-served through the foreign path.
 *
 * @module tests/cross-session-recall
 */

import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { FileBundleStore } from '../src/bundle-store.ts'
import { canonicalHash } from '../src/hash.ts'
import { recallForeign } from '../src/recall.ts'
import type { FoldBundleStore } from '../src/types.ts'
import { conversation, createHarness, foldAgent, SIGNAL } from './harness.ts'

/** A log reader backed by an in-memory event list, recording what was asked. */
function readerOver(events: readonly SessionEvent[]): {
  reader: { open: (id: SessionId, access: 'read') => Promise<{
    read: (offset?: number, length?: number) => Promise<{ events: readonly SessionEvent[] }>
    close: () => Promise<void>
  }> }
  calls: Array<{ offset: number | undefined; length: number | undefined }>
} {
  const calls: Array<{ offset: number | undefined; length: number | undefined }> = []
  return {
    calls,
    reader: {
      open: async () => ({
        read: async (offset, length) => {
          calls.push({ offset, length })
          return { events: events.slice(offset ?? 0, (offset ?? 0) + (length ?? events.length)) }
        },
        close: async () => {},
      }),
    },
  }
}

/** Fold once with the referential archive on, returning the pieces needed. */
async function foldReferential(): Promise<{
  store: FoldBundleStore
  session: ReturnType<typeof conversation>
  checkpointId: string
}> {
  const harness = await createHarness({ text: 'digest' }, {
    efConfig: { referentialArchive: true },
  })
  const session = conversation(6)
  const nodes = [...session.surface.nodes]
  await harness.engine.compactRegion(nodes[0]!, nodes[3]!, foldAgent(session), SIGNAL)
  const listed = await harness.store.list(session.id)
  return { store: harness.store, session, checkpointId: listed[0]!.checkpointId }
}

describe('cross-session recall is gated', () => {
  it('with no log reader, a foreign checkpoint is not served', async () => {
    const { store, session, checkpointId } = await foldReferential()
    const result = await recallForeign({
      store,
      requesting: SessionId('session-someone-else'),
      logReader: undefined,
      checkpointId,
      depth: 'exact',
    })
    // The ref resolves to the OWNER, but there is no log to read it from, so the
    // honest answer is unavailable rather than a fabricated page.
    expect(result?.unavailable).toMatch(/no session log is available/u)
    expect(result?.page).toBeUndefined()
    void session
  })

  it('with a log reader, a foreign checkpoint resolves from the stored log', async () => {
    const { store, session, checkpointId } = await foldReferential()
    const events: SessionEvent[] = []
    for (let seq = 0; seq < session.seq; seq += 1) {
      const event = session.eventAt(seq as never)
      if (event !== undefined) events.push(event)
    }
    const { reader, calls } = readerOver(events)

    const result = await recallForeign({
      store,
      requesting: SessionId('session-someone-else'),
      logReader: reader,
      checkpointId,
      depth: 'exact',
      limit: 100,
    })
    expect(result?.unavailable).toBeUndefined()
    expect(result?.page?.messages.length).toBeGreaterThan(0)

    // A RANGED read, not a replay: the experiment must not turn every recall
    // into a full log scan.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.length).toBeLessThan(events.length)
  })

  it('the caller\'s OWN checkpoint is never re-served through the foreign path', async () => {
    // Otherwise a store that answered inconsistently could produce two different
    // answers for one ref, depending on which path ran first.
    const { store, session, checkpointId } = await foldReferential()
    const { reader, calls } = readerOver([])
    const result = await recallForeign({
      store,
      requesting: session.id,
      logReader: reader,
      checkpointId,
      depth: 'exact',
    })
    expect(result).toBeNull()
    // And it did not even reach for the log.
    expect(calls).toHaveLength(0)
  })

  it('an unknown checkpoint is not found, without touching the log', async () => {
    const { store } = await foldReferential()
    const { reader, calls } = readerOver([])
    const result = await recallForeign({
      store,
      requesting: SessionId('session-someone-else'),
      logReader: reader,
      checkpointId: 'cp:00000000-0000-4000-8000-000000000000',
      depth: 'exact',
    })
    expect(result).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('summary depth needs no log at all, because the text is in the bundle', async () => {
    const { store, checkpointId } = await foldReferential()
    const { reader, calls } = readerOver([])
    const result = await recallForeign({
      store,
      requesting: SessionId('session-someone-else'),
      logReader: reader,
      checkpointId,
      depth: 'summary',
    })
    expect(result?.text).toBeDefined()
    expect(calls).toHaveLength(0)
  })

  it('a ref that no longer derives its message is refused, not served', async () => {
    // The digest is what makes a foreign ref safe to follow. Drift — a rewritten
    // surface, a changed projection rule — must surface as unavailable.
    const { store, session, checkpointId } = await foldReferential()
    const bundle = (await store.read(session.id, checkpointId))!
    const events: SessionEvent[] = []
    for (let seq = 0; seq < session.seq; seq += 1) {
      const event = session.eventAt(seq as never)
      if (event !== undefined) events.push(event)
    }
    // Rewrite the log so the first ref's seq derives something else.
    const drifted = events.map((event, index) =>
      index === bundle.archive.refs[0]!.seq
        ? { ...event, data: { ...event.data, content: [{ type: 'text', text: 'tampered' }] } } as SessionEvent
        : event)
    const { reader } = readerOver(drifted)

    const result = await recallForeign({
      store,
      requesting: SessionId('session-someone-else'),
      logReader: reader,
      checkpointId,
      depth: 'exact',
    })
    expect(result?.unavailable).toMatch(/no longer derives|does not derive|absent/u)
    expect(result?.page).toBeUndefined()
    // The recorded hash is what the owner's bundle claims; confirm the fixture
    // really did change the derived message.
    expect(canonicalHash(drifted[bundle.archive.refs[0]!.seq]!)).not.toBe(bundle.archive.refs[0]!.digest)
  })

  it('a store without findSessionOf simply cannot serve foreign refs', async () => {
    // The capability is optional, so an implementation that omits it stays
    // valid and degrades to "not found" rather than throwing.
    const root = await mkdtemp(join(tmpdir(), 'ef-foreign-'))
    const bare = new FileBundleStore(root)
    const result = await recallForeign({
      store: Object.assign(Object.create(Object.getPrototypeOf(bare)) as FileBundleStore, {
        findSessionOf: undefined,
      }),
      requesting: SessionId('session-someone-else'),
      logReader: undefined,
      checkpointId: 'cp:anything',
      depth: 'exact',
    })
    expect(result).toBeNull()
  })
})
