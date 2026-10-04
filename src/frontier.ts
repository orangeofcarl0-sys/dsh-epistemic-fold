/**
 * The Fold Frontier: the logical boundary between the frozen prefix (system
 * head + frozen checkpoints) and the open trajectory.
 *
 * The frontier is an identity, never a bare position index: every plan
 * re-derives it from the CURRENT surface by locating the last Epistemic Fold
 * checkpoint node, so replacements that reshuffle seqs cannot corrupt it
 * (plan §12, P04).
 *
 * @module dsh-epistemic-fold/frontier
 */

import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import type { FoldMode } from './types.ts'
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import { parseCheckpointMarker } from './checkpoint-marker.ts'

/** Persistent identity of the frontier (plan §10); re-locatable, not a position. */
export interface FrontierRef {
  latestFrozenCheckpointId?: string
  latestFrozenSurfaceSeq?: SessionSeq
}

/** One EF checkpoint node found on the current surface. */
export interface FrozenCheckpoint {
  readonly checkpointId: string
  readonly mode: FoldMode
  /** Surface position (index into `surface.nodes`). */
  readonly position: number
  /** Surface-node seq at that position. */
  readonly seq: SessionSeq
}

/** The frontier located against one concrete surface snapshot. */
export interface FoldFrontier {
  /** Count of EF checkpoints currently visible on the surface. */
  readonly frozenCount: number
  /** The located frontier identity; `latestFrozen*` absent before any fold. */
  readonly ref: FrontierRef
  /**
   * First surface position eligible for a leaf fold: one past the frontier,
   * but never the system-head node and never before position 0.
   */
  readonly firstOpenPosition: number
  /**
   * Hard-invariant input (R0-A): EF checkpoints must form a CONTIGUOUS
   * frozen prefix — no raw node between two checkpoints, none before the
   * first one (system head excepted). `false` means the surface shape is
   * FRONTIER_INCONSISTENT and leaf folds must refuse to proceed.
   */
  readonly frozenPrefixContiguous: boolean
  /** Every EF checkpoint on the surface, in surface order. */
  readonly frozen: readonly FrozenCheckpoint[]
}

/**
 * Whether the message at one surface node is an EF-authored checkpoint, and
 * which fold produced it. Identity is parsed exclusively through the
 * checkpoint marker protocol. Legacy Basic checkpoints (same message source
 * kind, no EF marker) are NOT EF checkpoints: they belong to history EF
 * inherits and never to the frozen EF frontier.
 */
export function readEfCheckpoint(session: Session, rawSeq: number): { checkpointId: string; mode: FoldMode } | undefined {
  const seq = SessionSeq(rawSeq)
  const message = session.deriveEventMessage(session.eventAt(seq)!)
  if (message === null || message.role !== 'user') return undefined
  if (!isCompactCheckpointSource(message.source)) return undefined
  const text = message.content
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n')
  return parseCheckpointMarker(text)
}

/**
 * Re-locate the fold frontier against the CURRENT surface. The frontier is
 * the LAST EF checkpoint by surface POSITION (not by seq magnitude, not by
 * creation time): everything at or before it is frozen; everything after it
 * is the open trajectory leaf folds may compact.
 */
export function locateFoldFrontier(session: Session): FoldFrontier {
  const nodes = session.surface.nodes
  const frozen: FrozenCheckpoint[] = []
  for (const [position, seq] of nodes.entries()) {
    const checkpoint = readEfCheckpoint(session, seq)
    if (checkpoint !== undefined) {
      frozen.push({ ...checkpoint, position, seq })
    }
  }
  const last = frozen[frozen.length - 1]
  // The system head (surface node 0) is never inside a leaf span.
  const systemHeadAtZero = nodes.length > 0 && readEfCheckpoint(session, nodes[0]!) === undefined
    && session.deriveEventMessage(session.eventAt(nodes[0]!)!)?.role === 'system'
  const firstOpenPosition = last === undefined
    ? (systemHeadAtZero ? 1 : 0)
    : Math.max(last.position + 1, systemHeadAtZero ? 1 : 0)
  let frozenPrefixContiguous = true
  for (const [index, checkpoint] of frozen.entries()) {
    if (checkpoint.position !== firstOpenPosition - frozen.length + index) {
      frozenPrefixContiguous = false
      break
    }
  }
  return {
    frozenCount: frozen.length,
    ref: last === undefined
      ? {}
      : { latestFrozenCheckpointId: last.checkpointId, latestFrozenSurfaceSeq: last.seq },
    firstOpenPosition,
    frozenPrefixContiguous,
    frozen,
  }
}

/** Whether a compaction transaction is durably open on this session. */
export function hasActiveCompaction(session: Session): boolean {
  for (let raw = session.seq - 1; raw >= 0; raw -= 1) {
    const seq = SessionSeq(raw)
    const event = session.eventAt(seq)!
    if (event.type === 'compaction/start') return true
    if (event.type === 'compaction/end') return false
  }
  return false
}

