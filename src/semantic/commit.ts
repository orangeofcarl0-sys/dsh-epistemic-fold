/**
 * Commit evidence: deciding whether a staged semantic packet's fold actually
 * committed, and what its absence means.
 *
 * The proof itself lives in `proof.ts`. This module is the adapter between that
 * verdict and the packet lifecycle the engine journals. It deliberately keeps
 * the historical distinction the old classifier lost:
 *
 *   activated     replacement landed; historical commit is proven
 *   archived-only summary landed but the replacement never did
 *   abandoned     the fold wrote another body, or ended without this one
 *   pending       not enough evidence yet (in flight, or no owning compaction)
 *   conflict      evidence exists but contradicts the packet; never activate
 *
 * @module dsh-epistemic-fold/semantic/commit
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { CheckpointBundleV1 } from '../types.ts'
import { proveFoldCommit } from './proof.ts'
import type { HistoricalFoldProof } from './proof.ts'
import type { SemanticHealth, SemanticPacket } from './types.ts'

export { summaryTextOf } from './proof.ts'

/** One packet's relationship to the session log. */
export type PacketCommitState =
  | {
    readonly status: 'activated'
    /** Seq of the `compaction/summary` that carried this body. */
    readonly summarySeq: number
    /** Seq of the replacement `user/message`, historically. Residency is irrelevant. */
    readonly messageSeq: number
    readonly proof: HistoricalFoldProof
    readonly detail?: string
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
  | {
    readonly status: 'conflict'
    readonly detail: string
  }

/** Options for {@link classifyPacket}. */
export interface ClassifyPacketOptions {
  /** The fold is still executing in this process (summary may be mid-block). */
  readonly inFlight?: boolean
  /** A verified bundle, used for source identity and legacy migration. */
  readonly bundle?: CheckpointBundleV1
}

/**
 * Classify one staged packet against the committed log.
 *
 * @param packet - the packet as it was staged.
 * @param session - the live (or reopened) session.
 * @param options - in-process liveness and an optional verified bundle.
 * @returns the commit verdict.
 */
export function classifyPacket(
  packet: SemanticPacket,
  session: Session,
  options: ClassifyPacketOptions = {},
): PacketCommitState {
  const verdict = proveFoldCommit(packet, session, options)
  switch (verdict.status) {
    case 'committed':
      return {
        status: 'activated',
        summarySeq: verdict.proof.summarySeq,
        messageSeq: verdict.proof.replacementSeq,
        proof: verdict.proof,
        ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
      }
    case 'aborted':
      return verdict.reason === 'summary-without-replacement'
        ? { status: 'archived-only', summarySeq: verdict.summarySeq ?? 0, detail: verdict.detail }
        : { status: 'abandoned', detail: verdict.detail }
    case 'unresolved':
      return { status: 'pending', detail: verdict.detail }
    case 'conflict':
      return { status: 'conflict', detail: verdict.detail }
  }
}

/**
 * Whether a committed semantic record exists for this packet.
 *
 * Only used by the legacy session-record reader. A record's presence does NOT
 * prove activation by itself: it is accepted only after the historical proof
 * agrees, and `proveFoldCommit` is the authority for that.
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
 * cannot be repaired by waiting), a contradiction outranks a pending packet
 * (waiting cannot remove it), and any activation gap makes the layer `partial`
 * rather than `ready` even when everything else is fine.
 */
export function healthOf(input: {
  readonly staged: number
  readonly abandoned: number
  readonly archivedOnly: number
  readonly invalid: number
  readonly unrepairable: number
  readonly activated: number
  readonly conflicts?: number
}): { readonly health: SemanticHealth; readonly detail?: string } {
  if (input.invalid > 0 || input.unrepairable > 0) {
    return {
      health: 'partial',
      detail: `${input.invalid + input.unrepairable} semantic packet(s) could not be read or applied`,
    }
  }
  if ((input.conflicts ?? 0) > 0) {
    return {
      health: 'partial',
      detail: `${input.conflicts} committed packet(s) have no valid proof in the session log`,
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
