/**
 * Commit evidence: deciding whether a staged semantic packet's fold actually
 * committed, and what its absence means.
 *
 * ## The commit point is the SURFACE, not the summary
 *
 * Basic appends `compaction/summary` and then the replacement `user/message`
 * in one synchronous block. A summary that exists while its checkpoint message
 * is not on the surface means the replacement failed: the bundle is durable
 * but the model never saw that body, so its semantic state must not become
 * state either. A summary alone is therefore `archived-only`, not `activated`.
 *
 * ## Digest, not similarity
 *
 * The packet records the `canonicalHash` of the exact body it rendered. A fold
 * retried by the truncation path may produce a different body under the same
 * checkpoint id; only the body that actually landed may activate. Matching the
 * marker alone would activate prose the model never saw.
 *
 * ## Absence is a verdict, but only with evidence
 *
 * A packet staged at `stagedAtSeq` whose fold left the log longer with no
 * matching summary is `abandoned`. A packet at the log's current end is
 * `pending`: the fold may still be in flight, or the process died between the
 * write and the commit. Guessing "abandoned" there would discard a state the
 * next commit might prove.
 *
 * @module dsh-epistemic-fold/semantic/commit
 */

import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { canonicalHash } from '../checkpoint/hash.ts'
import type { SemanticHealth, SemanticPacket } from './types.ts'

/** One packet's relationship to the session log. */
export type PacketCommitState =
  | {
    readonly status: 'activated'
    /** Seq of the `compaction/summary` that carried this body. */
    readonly summarySeq: number
    /** Seq of the replacement `user/message` on the surface. */
    readonly messageSeq: number
  }
  | {
    readonly status: 'archived-only'
    readonly summarySeq: number
    readonly detail: string
  }
  | {
    readonly status: 'abandoned'
    readonly detail: string
  }
  | {
    readonly status: 'pending'
    readonly detail: string
  }

/** The model-visible text of a `compaction/summary` event, or undefined. */
export function summaryTextOf(event: { readonly type: string; readonly data: unknown }): string | undefined {
  if (event.type !== 'compaction/summary') return undefined
  const data = event.data as { summary?: unknown }
  if (!Array.isArray(data.summary)) return undefined
  return data.summary.map(block => {
    if (block === null || typeof block !== 'object') return ''
    const typed = block as { type?: unknown; text?: unknown }
    return typed.type === 'text' && typeof typed.text === 'string' ? typed.text : ''
  }).join('\n')
}

/** Whether one event seq is on the model-visible surface. */
function onSurface(session: Session, seq: number): boolean {
  return session.surface.nodes.some(node => Number(node) === seq)
}

/**
 * The checkpoint message immediately after a summary, when it is a real
 * compaction checkpoint AND the surface holds it.
 *
 * `immediately after` is exact, not heuristic: Basic appends the two events in
 * one synchronous block with nothing between them.
 */
function committedCheckpointAfter(session: Session, summarySeq: number): number | undefined {
  const next = session.eventAt(SessionSeq(summarySeq + 1))
  if (next === undefined || next.type !== 'user/message') return undefined
  const message = session.deriveEventMessage(next)
  if (message === null || message.source.kind !== 'compact-checkpoint') return undefined
  return onSurface(session, Number(next.seq)) ? Number(next.seq) : undefined
}

/**
 * Classify one staged packet against the committed log.
 *
 * @param packet - the packet as it was staged.
 * @param session - the live (or reopened) session.
 * @returns the commit verdict.
 */
export function classifyPacket(packet: SemanticPacket, session: Session): PacketCommitState {
  const events: readonly SessionEvent[] = session.snapshotEvents()
  let markerSeen = false
  for (const event of events) {
    const text = summaryTextOf(event)
    if (text === undefined) continue
    if (text.includes(`cp:${packet.checkpointId}`)) markerSeen = true
    if (canonicalHash(text) !== packet.bodyDigest) continue
    const messageSeq = committedCheckpointAfter(session, Number(event.seq))
    if (messageSeq === undefined) {
      return {
        status: 'archived-only',
        summarySeq: Number(event.seq),
        detail: 'the summary landed but its checkpoint message is not on the surface; '
          + 'the bundle is durable and the fold did not commit',
      }
    }
    return { status: 'activated', summarySeq: Number(event.seq), messageSeq }
  }
  if (markerSeen) {
    return {
      status: 'abandoned',
      detail: 'a summary for this checkpoint carries a DIFFERENT body; a retry won and this '
        + 'body was never visible',
    }
  }
  if (session.seq > packet.stagedAtSeq) {
    return {
      status: 'abandoned',
      detail: `the log advanced from seq ${packet.stagedAtSeq} to ${session.seq} without a `
        + 'summary for this body',
    }
  }
  return {
    status: 'pending',
    detail: `waiting for commit evidence after seq ${packet.stagedAtSeq}`,
  }
}

/**
 * Whether a committed semantic record exists for this packet.
 *
 * Only used on the `session-record` authority, where the record IS the commit
 * record. A record's presence proves activation because it is appended only
 * after `classifyPacket` returned `activated`.
 */
export function hasCommittedRecord(
  packetId: string,
  records: readonly { readonly payload: { readonly packetId: string } }[],
): boolean {
  return records.some(record => record.payload.packetId === packetId)
}

/**
 * Fold per-packet verdicts into one health value.
 *
 * Precedence is deliberate: an unreadable packet outranks a pending one (it
 * cannot be repaired by waiting), and any activation gap makes the layer
 * `partial` rather than `ready` even when everything else is fine.
 */
export function healthOf(input: {
  readonly staged: number
  readonly abandoned: number
  readonly archivedOnly: number
  readonly invalid: number
  readonly unrepairable: number
  readonly activated: number
}): { readonly health: SemanticHealth; readonly detail?: string } {
  if (input.invalid > 0 || input.unrepairable > 0) {
    return {
      health: 'partial',
      detail: `${input.invalid + input.unrepairable} semantic packet(s) could not be read or applied`,
    }
  }
  if (input.staged > 0) {
    return { health: 'partial', detail: `${input.staged} semantic packet(s) still awaiting commit evidence` }
  }
  if (input.activated === 0 && input.archivedOnly > 0) {
    return { health: 'archive-only', detail: 'semantic packets exist, but none is visible on the surface' }
  }
  if (input.abandoned > 0) {
    return { health: 'partial', detail: `${input.abandoned} staged packet(s) never committed` }
  }
  return { health: 'ready' }
}
