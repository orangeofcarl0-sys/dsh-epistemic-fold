/**
 * Session-log queries used by the evaluation runner (R0-C): locating the raw
 * authoritative events an anchor may cite, the EF checkpoints visible on the
 * surface, and the balanced fold boundary. All are pure reads of a Session.
 *
 * @module eval/session-queries
 */

import {
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { parseCheckpointMarker } from '../../src/checkpoint-marker.ts'

/** Seq of the LAST event matching `type` (and optional predicate), else 0. */
export function findLastEventSeq(
  session: Session,
  type: string,
  predicate?: (data: unknown) => boolean,
): number {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq as never)!
    if (event.type !== type) continue
    if (predicate !== undefined && !predicate(event.data)) continue
    return seq
  }
  return 0
}

/** Whether a seq holds a user message (the gate needs a RAW authoritative kind). */
export function isUserMessageSeq(session: Session, seq: number): boolean {
  return session.eventAt(seq as never)?.type === 'user/message'
}

/** The last user message — the raw normative source anchors cite. */
export function lastUserMessageSeq(session: Session): number {
  return findLastEventSeq(session, 'user/message')
}

/** The last assistant message — the hypothesis/decision source. */
export function lastAssistantMessageSeq(session: Session): number {
  return findLastEventSeq(session, 'assistant/message')
}

/** The last non-error tool result — the empirical evidence source. */
export function lastSuccessfulToolResultSeq(session: Session): number {
  return findLastEventSeq(session, 'tool/result', data => {
    const message = (data as { message?: { isError?: boolean } }).message
    return message?.isError !== true
  })
}

/** Failure anchor ids that reached VERIFIED (retired from hot state). */
export function verifiedFailureIds(session: Session): Set<string> {
  const ids = new Set<string>()
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq as never)!
    if (event.type !== 'ef/anchor') continue
    const data = event.data as { failureState?: string; anchorId?: string }
    if (data.failureState === 'verified' && data.anchorId !== undefined) {
      ids.add(data.anchorId)
    }
  }
  return ids
}

/** EF checkpoint ids currently visible on the surface, in surface order. */
export function checkpointIdsOf(session: Session): string[] {
  const ids: string[] = []
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message === null || message.role !== 'user') continue
    const source = (message as unknown as { source?: { kind?: string } }).source
    if (source?.kind !== 'compact-checkpoint') continue
    const text = message.content
      .map(block => block.type === 'text' ? block.text : '')
      .join(String.fromCharCode(10))
    const marker = parseCheckpointMarker(text)
    if (marker !== undefined) ids.push(marker.checkpointId)
  }
  return ids
}

/**
 * The last surface node that is a BALANCED fold boundary: walk left from the
 * tail (excluding the fixture's open turn) until the transaction's own
 * tool-pairing rule accepts.
 */
export function balancedLeafEnd(session: Session, nodes: readonly SessionSeq[]): SessionSeq {
  for (let index = nodes.length - 2; index >= 1; index -= 1) {
    const seq = nodes[index]!
    if (toolPairingBalancedBefore(session, seq) && toolPairingBalancedAfter(session, seq)) {
      return seq
    }
  }
  return nodes[0]!
}

/** Close the fixture's trailing open turn so idle (root) folds are admissible. */
export function closeOpenTurn(session: Session): void {
  let openTurn: number | null = null
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq as never)!
    if (event.type === 'turn/end') return
    if (event.type === 'turn/start') {
      openTurn = event.data.turn
      break
    }
  }
  if (openTurn !== null) {
    session.append('turn/end', { turn: openTurn, reason: { kind: 'completed' } })
  }
}
