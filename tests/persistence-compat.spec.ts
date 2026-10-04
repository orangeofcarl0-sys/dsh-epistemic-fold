/**
 * The persistence-compatibility gate.
 *
 * EF's state projection folds the session log, so a log that reopens
 * differently is a SILENTLY different state rather than an error. The suite
 * never covered that seam: `tests/harness.ts` builds a bare `SessionStore` and
 * stubs `flush`, so no spec exercised a real write → close → reopen.
 *
 * Two tiers, because the backend's POSIX write lease needs a native lock addon
 * that the vendored checkout does not build (each
 * `native/system/packages/<platform>` ships only a prebuild manifest, and the
 * binary itself is fetched rather than compiled), so the full round-trip is
 * unavailable in CI:
 *
 *   - the PORTABLE tier calls `validateStoredEvents`, which is the exact gate
 *     the JSONL read path invokes at its three restore sites. It always runs,
 *     and it is where the defect actually lives: the refusal happens on READ.
 *   - the BACKEND tier drives a real write → flush → close → reopen and skips
 *     LOUDLY where the write lease cannot load, mirroring the live tier's
 *     "skips rather than silently passes" discipline.
 *
 * The `ef/anchor` cases are written as capability probes, not as permanent
 * expectations: a host that gains a safe plugin-event seam flips the assertion
 * instead of failing it.
 *
 * @module tests/persistence-compat
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError, validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAnchorService, hostAdmitsPluginEvents } from '../src/anchor-service.ts'
import { emptyCurrentState, reduceEvent } from '../src/state.ts'
import { conversation, toolConversation } from './harness.ts'

const header = (id: string): SessionHeader => ({
  version: SESSION_FORMAT_VERSION,
  id: SessionId(id),
  createdAt: 1000,
  isSeeded: false,
  cwd: '/work',
})

/** One raw log record, built the way a writer would emit it. */
const record = (
  type: string,
  seq: number,
  data: unknown,
  extra: Record<string, unknown> = {},
): SessionEvent => ({ type, seq: SessionSeq(seq), time: 1000 + seq, data, ...extra }) as unknown as SessionEvent

/** Run one case against a scratch root that is always reclaimed. */
async function withRoot<T>(name: string, body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), `ef-pc-${name}-`))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/**
 * Write one log through a real JSONL handle, close it, then reopen it from a
 * fresh context — the two-process shape a restart produces.
 */
async function roundTrip(
  root: string,
  id: string,
  events: readonly SessionEvent[],
): Promise<readonly SessionEvent[]> {
  const write = new Context()
  try {
    await write.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const handle = await write.sessionPersistence.create(header(id))
    await handle.append(events)
    await handle.flush()
    await handle.close()
  } finally {
    await write.fiber.dispose()
  }

  const read = new Context()
  try {
    await read.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const handle = await read.sessionPersistence.open(SessionId(id), 'read')
    try {
      return (await handle.read()).events
    } finally {
      await handle.close()
    }
  } finally {
    await read.fiber.dispose()
  }
}

/**
 * Whether the full write → reopen path works here. The probe runs the same
 * round-trip the tier below needs rather than only `create()`, so its answer
 * cannot disagree with what the tier is about to attempt; probing beats
 * guessing because the native lock binding's path depends on libc, and win32
 * takes a different branch entirely.
 */
const backendCanWrite = await withRoot('probe', async (root) => {
  try {
    await roundTrip(root, 'probe', [record('turn/start', 0, { turn: 1 })])
    return true
  } catch {
    return false
  }
})

describe('persistence read-path contract (portable)', () => {
  it('accepts a known event type', () => {
    const events = [record('turn/start', 0, { turn: 1 })]
    expect(() => validateStoredEvents(header('portable-native'), events)).not.toThrow()
  })

  it('refuses ef/anchor exactly when the host cannot mark it ignorable', () => {
    // `ef/anchor` is outside DSH's known vocabulary. Without the envelope's
    // `ignorable` marker the read path fails closed, which is the whole reason
    // the anchor service now refuses to write one.
    const events = [record('ef/anchor', 0, { op: 'retire', anchorId: 'probe' })]
    if (hostAdmitsPluginEvents()) {
      expect(() => validateStoredEvents(header('portable-anchor'), events)).not.toThrow()
    } else {
      expect(() => validateStoredEvents(header('portable-anchor'), events))
        .toThrow(SessionFormatUnsupportedError)
    }
  })

  it('accepts the same unknown event once it carries the ignorable marker', () => {
    // The marker is the entire difference from the previous case: the format
    // admits an unknown event, and only the missing marker makes the read fail.
    const events = [record('ef/anchor', 0, { op: 'retire', anchorId: 'probe' }, { ignorable: true })]
    expect(() => validateStoredEvents(header('portable-ignorable'), events)).not.toThrow()
  })
})

describe.skipIf(!backendCanWrite)('persistence round-trip (real backend)', () => {
  it('round-trips a native event type', async () => {
    await withRoot('native', async (root) => {
      const reopened = await roundTrip(root, 'pc-native', [record('turn/start', 0, { turn: 1 })])
      expect(reopened).toHaveLength(1)
      expect(reopened[0]!.type).toBe('turn/start')
    })
  })

  it('treats ef/anchor according to the host capability', async () => {
    await withRoot('anchor', async (root) => {
      const events = [record('ef/anchor', 0, { op: 'retire', anchorId: 'probe' })]
      const attempt = roundTrip(root, 'pc-anchor', events)
      if (hostAdmitsPluginEvents()) {
        await expect(attempt).resolves.toHaveLength(1)
      } else {
        await expect(attempt).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
      }
    })
  })

  it('reopens an unknown event that carries the ignorable marker', async () => {
    await withRoot('ignorable', async (root) => {
      const reopened = await roundTrip(root, 'pc-ignorable', [
        record('ef/anchor', 0, { op: 'retire', anchorId: 'probe' }, { ignorable: true }),
      ])
      expect(reopened).toHaveLength(1)
    })
  })

  it('reconstructs an identical projection after a reopen', async () => {
    // The invariant EF's state producer depends on: the fold is a pure replay
    // of the log, so reopening must yield the same state or the difference is
    // silent. The fixture's one failed tool result is EF's only automatic
    // production producer, so the comparison is not two empty states.
    await withRoot('projection', async (root) => {
      const session = toolConversation(3, { failTurns: [2] })
      const events: SessionEvent[] = []
      for (let seq = 0; seq < session.seq; seq += 1) {
        const stored = session.eventAt(SessionSeq(seq))
        if (stored !== undefined) events.push(stored)
      }

      const before = events.reduce((state, event) => reduceEvent(state, event), emptyCurrentState())
      expect(Object.keys(before.openFailures), 'the failure producer must have fired').toHaveLength(1)

      const reopened = await roundTrip(root, 'pc-projection', events)
      const after = reopened.reduce((state, event) => reduceEvent(state, event), emptyCurrentState())
      expect(after).toEqual(before)
    })
  })
})

describe('anchor service durability guard', () => {
  /** A session with one citable raw authoritative event. */
  const citable = () => {
    const session = conversation(1)
    for (let seq = 0; seq < session.seq; seq += 1) {
      if (session.eventAt(SessionSeq(seq))?.type === 'user/message') return { session, seq }
    }
    throw new Error('fixture has no user/message')
  }

  const draft = (seq: number) => ({
    kind: 'constraint' as const,
    value: 'Do not change the public API.',
    authority: 'normative' as const,
    sourceRefs: [{ seq: seq as never }],
  })

  it('refuses BEFORE appending when the host cannot persist the event', () => {
    // The whole point of failing loud: the harm is a log that writes cleanly
    // and cannot be reopened, so a guard that fired after the append would
    // already be too late. `session.seq` is the observable that proves it.
    const service = createAnchorService({ durableWritesAllowed: () => false })
    const { session, seq } = citable()
    const before = session.seq
    expect(() => service.declare(session, draft(seq))).toThrow(/refusing to append `ef\/anchor`/u)
    expect(session.seq, 'the refused write must not have reached the log').toBe(before)
  })

  it('still writes on the in-memory face, where nothing persists the log', () => {
    // The default is the library/test face: a caller that never persists must
    // not lose the capability, or the reducer's own tests could not run.
    const service = createAnchorService()
    const { session, seq } = citable()
    const anchor = service.declare(session, draft(seq))
    expect(anchor.lifecycle).toBe('active')
    expect(session.eventAt(SessionSeq(session.seq - 1))?.type).toBe('ef/anchor')
  })

  it('gates on the same host capability the plugin wires', () => {
    // The plugin passes `hostAdmitsPluginEvents`; this pins that the two halves
    // agree, so the guard cannot be wired to the wrong predicate.
    const service = createAnchorService({ durableWritesAllowed: hostAdmitsPluginEvents })
    const { session, seq } = citable()
    if (hostAdmitsPluginEvents()) {
      expect(() => service.declare(session, draft(seq))).not.toThrow()
    } else {
      expect(() => service.declare(session, draft(seq))).toThrow(/refusing to append/u)
    }
  })
})
