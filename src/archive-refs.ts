/**
 * Resolving a bundle's archive refs back into the exact messages they name.
 *
 * ## Why a bundle may not carry its own archive
 *
 * The archived messages are the DERIVED form of session events that the log
 * already holds. Measured on a real session: 200 of 211 archived messages were
 * byte-identical to the event payloads at the seqs the bundle already recorded,
 * and a root fold's archive was 946 KB of a 949 KB bundle — 76% of the file
 * was a second copy of content the session log owns.
 *
 * So a bundle can instead record `(seq, digest)` refs and resolve them on
 * demand. What makes that safe is the digest: a bare seq proves "fetch from
 * here", while `(seq, digest)` proves "this position still holds what I
 * referenced". Without it, a change in `deriveEventMessage`, a rewritten
 * surface, or a migrated log would silently resolve to different content.
 *
 * ## Where the events come from
 *
 * Two sources, in order:
 *
 *  1. the LIVE session, when the caller has one. This is the common case for
 *     the session that is doing the folding: `context_recall` runs inside
 *     `agent.session`, so `eventAt(seq)` is an in-memory index and resolution
 *     costs no I/O.
 *  2. a READ HANDLE onto the stored log, for a checkpoint belonging to a
 *     session that is not loaded. This is the experimental cross-session path,
 *     off by default: it needs the persistence service, and the log it reads
 *     may be concurrently written, archived, or migrated.
 *
 * A ref that cannot be resolved is a REPORTED failure, never a silent
 * substitution. Serving different bytes under a checkpoint id would be worse
 * than serving none.
 *
 * @module dsh-epistemic-fold/archive-refs
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { canonicalHash } from './hash.ts'
import type { ArchiveRef } from './types.ts'

/** Why one ref could not be resolved to the message it named. */
export type RefFailure =
  | { readonly reason: 'session-unavailable' }
  | { readonly reason: 'seq-absent'; readonly seq: number }
  | { readonly reason: 'not-a-message'; readonly seq: number }
  | { readonly reason: 'digest-mismatch'; readonly seq: number }

/** The outcome of resolving a whole ref list. */
export type ResolveResult =
  | { readonly status: 'resolved'; readonly messages: readonly Message[] }
  | { readonly status: 'unresolved'; readonly failures: readonly RefFailure[] }

/**
 * A source of events by seq. The live session and a persistence read handle
 * both satisfy this, which is what keeps the resolver agnostic about where the
 * history came from.
 */
export interface EventSource {
  /** The derived message at `seq`, or `undefined` when it is not a message. */
  readonly messageAt: (seq: number) => Message | null | undefined
}

/** Adapt a live session to the resolver's source face. */
export function sessionEventSource(session: Session): EventSource {
  return {
    messageAt: (seq) => {
      const event = session.eventAt(seq as never)
      if (event === undefined) return undefined
      return session.deriveEventMessage(event)
    },
  }
}

/**
 * The slice of `SessionPersistence` this module needs.
 *
 * Declared structurally rather than imported, for the same reason the engine
 * mirrors Basic's summarizer input: EF must not depend on a sibling package's
 * type face just to read a log. `SessionPersistence.open(id, 'read')` satisfies
 * it.
 */
export interface LogReader {
  readonly open: (
    id: SessionId,
    access: 'read',
    options?: { readonly signal?: AbortSignal },
  ) => Promise<{
    readonly read: (
      offset?: number,
      length?: number,
      options?: { readonly signal?: AbortSignal },
    ) => Promise<{ readonly events: readonly SessionEvent[] }>
    readonly close: () => Promise<void>
  }>
}

/**
 * Resolve archive refs from a STORED session log, for a session that is not
 * loaded in memory.
 *
 * ## Why this is gated
 *
 * The live-session path cannot fail for a reason the caller does not already
 * know about: if the session is running, its log is readable. A stored log is
 * different — it may be concurrently written, archived, or migrated, and a ref
 * resolved against a log in any of those states is a claim EF cannot make.
 *
 * The read is RANGED (`read(offset, length)`) rather than a full replay:
 * measured on a real 1.9 MB log, decoding the ~10 frames a checkpoint needs
 * took 2.6 ms against 132 ms to decode all 1914. Refs are contiguous by
 * construction, so one range covers them.
 *
 * @param reader - the persistence service, when the host mounts one.
 * @param sessionId - the session the checkpoint belongs to.
 * @param refs - the archive identity to resolve.
 * @param signal - cancellation.
 * @returns the resolved messages, or a failure list; never a partial archive.
 */
export async function resolveArchiveRefsFromLog(
  reader: LogReader | undefined,
  sessionId: SessionId,
  refs: readonly ArchiveRef[],
  signal?: AbortSignal,
): Promise<ResolveResult> {
  if (reader === undefined) {
    return { status: 'unresolved', failures: [{ reason: 'session-unavailable' }] }
  }
  if (refs.length === 0) return { status: 'resolved', messages: [] }
  let handle: Awaited<ReturnType<LogReader['open']>>
  try {
    handle = await reader.open(sessionId, 'read', ...(signal === undefined ? [] : [{ signal }]))
  } catch {
    // Absent, archived, or owned elsewhere: all the same answer to a caller —
    // this checkpoint cannot be resolved here, and saying so is the only honest
    // response.
    return { status: 'unresolved', failures: [{ reason: 'session-unavailable' }] }
  }
  try {
    // Refs are contiguous (they come from one folded span), so the first and
    // last bracket the whole range. A sparse set would need per-ref reads; the
    // span invariant is asserted at build time by `buildArchiveRefs`.
    const first = refs[0]!.seq
    const last = refs[refs.length - 1]!.seq
    const length = last - first + 1
    const slice = await handle.read(
      first,
      length,
      ...(signal === undefined ? [] : [{ signal }]),
    )
    const bySeq = new Map<number, SessionEvent>()
    for (const event of slice.events) bySeq.set(event.seq, event)
    const source: EventSource = {
      messageAt: (seq) => {
        const event = bySeq.get(seq)
        if (event === undefined) return undefined
        // Standalone projection: the same pure function the live session uses,
        // so a ref resolves identically whether the session is loaded or read
        // back from disk. That equivalence is what makes the ref portable.
        return deriveEventMessage(event)
      },
    }
    return resolveArchiveRefs(refs, source)
  } catch {
    return { status: 'unresolved', failures: [{ reason: 'session-unavailable' }] }
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Resolve `refs` against `source`, verifying every digest.
 *
 * Returns `unresolved` with the complete failure list rather than a partial
 * archive: a page assembled from "most of the messages" would look complete to
 * the model, and a silently short archive is the failure mode this whole
 * mechanism is meant to prevent.
 *
 * @param refs - the archive identity, in order.
 * @param source - where to read events from.
 * @returns the messages, or every reason resolution failed.
 */
export function resolveArchiveRefs(
  refs: readonly ArchiveRef[],
  source: EventSource | undefined,
): ResolveResult {
  if (source === undefined) return { status: 'unresolved', failures: [{ reason: 'session-unavailable' }] }
  const messages: Message[] = []
  const failures: RefFailure[] = []
  for (const ref of refs) {
    const message = source.messageAt(ref.seq)
    if (message === undefined) {
      failures.push({ reason: 'seq-absent', seq: ref.seq })
      continue
    }
    if (message === null) {
      failures.push({ reason: 'not-a-message', seq: ref.seq })
      continue
    }
    if (canonicalHash(message) !== ref.digest) {
      failures.push({ reason: 'digest-mismatch', seq: ref.seq })
      continue
    }
    messages.push(message)
  }
  if (failures.length > 0) return { status: 'unresolved', failures }
  return { status: 'resolved', messages }
}

/** Human-readable reason, for a `context_recall` unavailable field. */
export function describeRefFailure(failures: readonly RefFailure[]): string {
  const first = failures[0]
  if (first === undefined) return 'archive unresolved'
  switch (first.reason) {
    case 'session-unavailable':
      return 'archive is referential and no session log is available to resolve it'
    case 'seq-absent':
      return `archive ref seq ${first.seq} is absent from the log`
    case 'not-a-message':
      return `archive ref seq ${first.seq} does not derive a message`
    case 'digest-mismatch':
      return `archive ref seq ${first.seq} no longer derives the archived message`
  }
}
