/**
 * The ONE admission gate for semantic commits.
 *
 * A journal row is four separate facts — a prepared packet, an immutable
 * receipt, the operations inside the packet, and the historical fold that
 * actually landed. Each can be individually well-formed while the four
 * disagree. This module turns them into one `ValidatedSemanticCommit`, and
 * every path that lets operations reach state (journal replay, reconciliation,
 * fork inheritance, legacy migration) consumes only that value.
 *
 * ## The checks, in order
 *
 *  1. packet runtime schema, including every resolved operation;
 *  2. native v4 identity: recomputed `packetId`, span digest, authority, mode;
 *  3. receipt schema and binding: session/checkpoint/packet ids agree, and
 *     `receipt.opsDigest` is the hash of THIS packet's operations;
 *  4. receipt proof fields agree with the packet (body/span/source/citations);
 *  5. the historical fold is re-proven against the session log, and the fresh
 *     proof equals the recorded one on every commit-identity field.
 *
 * ## The missing-receipt case is still admitted
 *
 * A packet with no receipt but a provable commit is the cross-store crash R31
 * established: the session committed and the receipt write did not. It is
 * `valid` with `missingReceipt: true`; the caller writes the receipt. A receipt
 * with no packet, a packet changed after its receipt, or a receipt whose proof
 * no longer matches the log is a CONFLICT and never becomes state.
 *
 * @module dsh-epistemic-fold/semantic/integrity
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { CheckpointBundleV1 } from '../types.ts'
import type { EfAnchorEventData } from '../state/state.ts'
import { canonicalHash } from '../checkpoint/hash.ts'
import { isSemanticPacket, isSemanticReceipt } from './journal.ts'
import { opsDigestOf, packetIdOf, validateOps } from './ops.ts'
import { proveFoldCommit } from './proof.ts'
import type { FoldAbortReason, FoldProofResult, HistoricalFoldProof } from './proof.ts'
import type { SemanticPacket, SemanticReceipt } from './types.ts'
import { SEMANTIC_SCHEMA_VERSION } from './types.ts'

/** Every way the four records can fail to describe one commit. */
export type SemanticIntegrityFailure =
  | 'packet-schema'
  | 'packet-id'
  | 'packet-span'
  | 'ops-invalid'
  | 'authority'
  | 'receipt-schema'
  | 'receipt-binding'
  | 'ops-digest'
  /** Operations do not reproduce the state digest their bundle rendered. */
  | 'ops-state-mismatch'
  /**
   * A missing receipt with no readable bundle state digest.
   *
   * The repair of the cross-store crash window is allowed only when an
   * INDEPENDENT witness says what state the committed checkpoint rendered.
   * Without it, the packet's own operations are the only description of the
   * state, and trusting them is exactly the hole `ops-state-mismatch` closes.
   */
  | 'missing-state-witness'
  | 'proof-mismatch'
  | 'orphan-receipt'
  | 'duplicate-packet'
  | 'legacy-unverified'
  | 'journal-unreadable'

/** The only shape a state-application path may consume. */
export interface ValidatedSemanticCommit {
  readonly packetId: string
  readonly sessionId: string
  readonly checkpointId: string
  /** The replacement event's seq: the logical commit position. */
  readonly commitOrder: number
  readonly proof: HistoricalFoldProof
  readonly operations: readonly EfAnchorEventData[]
}

/** The verdict of {@link validateSemanticCommit}. */
export type SemanticCommitValidation =
  | {
    readonly status: 'valid'
    readonly commit: ValidatedSemanticCommit
    /** True for the legitimate crash window: committed log, receipt not written. */
    readonly missingReceipt: boolean
  }
  | {
    readonly status: 'aborted'
    readonly reason: FoldAbortReason
    readonly detail: string
    /** The consistent non-activating receipt already on disk, when there is one. */
    readonly receipt?: SemanticReceipt
  }
  | { readonly status: 'pending'; readonly detail: string }
  | {
    readonly status: 'conflict'
    readonly code: SemanticIntegrityFailure
    readonly detail: string
  }
  | {
    readonly status: 'invalid'
    readonly code: SemanticIntegrityFailure
    readonly detail: string
  }

/** Options for {@link validateSemanticCommit}. */
export interface ValidateSemanticCommitOptions {
  readonly session: Session
  readonly packet: SemanticPacket
  readonly receipt?: SemanticReceipt
  readonly bundle?: CheckpointBundleV1
  /** The fold is executing in THIS process; a summary may be mid-block. */
  readonly inFlight?: boolean
}

/** Options for {@link validatePacketIdentity}. */
export interface PacketIdentityOptions {
  /** A v3 id was produced by another algorithm; only migration may re-derive it. */
  readonly allowLegacyId?: boolean
}

/**
 * Validate a native v4 packet's own identity and operations.
 *
 * @param packet - the candidate packet.
 * @param options - `allowLegacyId` for a verified migration candidate.
 * @returns the failure, or `undefined` when the packet is applicable.
 */
export function packetIdentityProblem(
  packet: SemanticPacket,
  options: PacketIdentityOptions = {},
): { readonly code: SemanticIntegrityFailure; readonly detail: string } | undefined {
  if (!isSemanticPacket(packet)) {
    return { code: 'packet-schema', detail: 'the packet is not a complete schema-4 packet' }
  }
  if (options.allowLegacyId !== true) {
    const expected = packetIdOf({
      sessionId: packet.sessionId,
      checkpointId: packet.checkpointId,
      foldedSeqs: packet.foldedSeqs,
      bodyDigest: packet.bodyDigest,
    })
    if (expected !== packet.packetId) {
      return {
        code: 'packet-id',
        detail: `the packet id ${packet.packetId} is not the v4 identity of its body (${expected})`,
      }
    }
  }
  if (canonicalHash([...packet.foldedSeqs]) !== packet.spanDigest) {
    return { code: 'packet-span', detail: 'spanDigest does not hash foldedSeqs' }
  }
  const ops = validateOps(packet.ops)
  if (!ops.ok) {
    return {
      code: 'ops-invalid',
      detail: `operations[${ops.failure.index}]: ${ops.failure.detail}`,
    }
  }
  if (packet.authority !== 'journal') {
    return {
      code: 'authority',
      detail: `this journal row claims authority "${packet.authority}", not "journal"`,
    }
  }
  return undefined
}

/** Whether two proofs agree on every field that identifies the commit. */
export function sameFoldProof(
  recorded: HistoricalFoldProof | undefined,
  fresh: HistoricalFoldProof,
): boolean {
  if (recorded === undefined) return false
  return recorded.proofVersion === fresh.proofVersion
    && recorded.sessionId === fresh.sessionId
    && recorded.checkpointId === fresh.checkpointId
    && recorded.compactionId === fresh.compactionId
    && recorded.startSeq === fresh.startSeq
    && recorded.summarySeq === fresh.summarySeq
    && recorded.replacementSeq === fresh.replacementSeq
    && recorded.bodyDigest === fresh.bodyDigest
    && recorded.summaryDigest === fresh.summaryDigest
    && recorded.sourceDigest === fresh.sourceDigest
    && recorded.spanDigest === fresh.spanDigest
    && recorded.commitOrder === fresh.commitOrder
    && sameSeqList(recorded.shadowedSeqs, fresh.shadowedSeqs)
  // `endSeq` / `endError` / `unclosed` are CLOSURE observations. A receipt
  // written before `compaction/end` landed and re-proven afterwards must not
  // become a conflict merely because the transaction closed later.
}

function sameSeqList(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Check the receipt's binding to the packet and its operations, WITHOUT a
 * session log.
 *
 * Fork inheritance uses this on the PARENT's rows: the parent log is not
 * mounted here, but the receipt must still commit exactly the parent packet's
 * operations before those operations are copied into the child.
 *
 * @param packet - the prepared packet.
 * @param receipt - the receipt that claims to decide it.
 * @returns the failure, or `undefined` when the binding is internally sound.
 */
export function receiptBindingProblem(
  packet: SemanticPacket,
  receipt: SemanticReceipt,
): { readonly code: SemanticIntegrityFailure; readonly detail: string } | undefined {
  if (!isSemanticReceipt(receipt)) {
    return { code: 'receipt-schema', detail: 'the receipt is not a complete schema-4 receipt' }
  }
  if (receipt.packetId !== packet.packetId) {
    return {
      code: 'receipt-binding',
      detail: `the receipt commits packet ${receipt.packetId}, not ${packet.packetId}`,
    }
  }
  if (String(receipt.sessionId) !== String(packet.sessionId)) {
    return { code: 'receipt-binding', detail: 'the receipt names another session' }
  }
  if (receipt.checkpointId !== packet.checkpointId) {
    return { code: 'receipt-binding', detail: 'the receipt names another checkpoint' }
  }
  if (receipt.schemaVersion !== SEMANTIC_SCHEMA_VERSION) {
    return { code: 'receipt-schema', detail: `receipt schema ${receipt.schemaVersion} is not current` }
  }
  if (receipt.opsDigest !== opsDigestOf(packet)) {
    return {
      code: 'ops-digest',
      detail: 'the receipt commits different operations than the packet now holds',
    }
  }
  if (receipt.outcome === 'committed') {
    const proof = receipt.proof
    if (proof === undefined) {
      return { code: 'receipt-schema', detail: 'a committed receipt carries no proof' }
    }
    const problem = proofAgainstPacket(packet, proof)
    if (problem !== undefined) return problem
  } else if (receipt.proof !== undefined) {
    return {
      code: 'receipt-schema',
      detail: `a ${receipt.outcome} receipt must not carry a commit proof`,
    }
  }
  return undefined
}

/** The recorded proof must describe THIS packet, before the log is consulted. */
function proofAgainstPacket(
  packet: SemanticPacket,
  proof: HistoricalFoldProof,
): { readonly code: SemanticIntegrityFailure; readonly detail: string } | undefined {
  if (proof.sessionId !== String(packet.sessionId)) {
    return { code: 'proof-mismatch', detail: 'the proof names another session' }
  }
  if (proof.checkpointId !== packet.checkpointId) {
    return { code: 'proof-mismatch', detail: 'the proof names another checkpoint' }
  }
  if (proof.bodyDigest !== packet.bodyDigest) {
    return { code: 'proof-mismatch', detail: 'the proof committed a different body' }
  }
  if (proof.spanDigest !== packet.spanDigest
    || !sameSeqList(proof.shadowedSeqs, packet.foldedSeqs)) {
    return { code: 'proof-mismatch', detail: 'the proof covers a different span' }
  }
  if (packet.sourceDigest !== undefined && proof.sourceDigest !== packet.sourceDigest) {
    return { code: 'proof-mismatch', detail: 'the proof archived different source content' }
  }
  if (proof.commitOrder !== proof.replacementSeq) {
    return { code: 'proof-mismatch', detail: 'commitOrder is not the replacement seq' }
  }
  return undefined
}

/**
 * Validate one packet (and, when present, its receipt) into a commit.
 *
 * @param options - the packet, optional receipt/bundle, and the session log.
 * @returns the only value any state-application path may consume.
 */
export function validateSemanticCommit(
  options: ValidateSemanticCommitOptions,
): SemanticCommitValidation {
  const { packet, receipt, session } = options
  const packetProblem = packetIdentityProblem(packet)
  if (packetProblem !== undefined) {
    return { status: 'invalid', code: packetProblem.code, detail: packetProblem.detail }
  }
  if (receipt !== undefined) {
    const problem = receiptBindingProblem(packet, receipt)
    if (problem !== undefined) {
      return { status: 'conflict', code: problem.code, detail: problem.detail }
    }
  }

  const verdict: FoldProofResult = proveFoldCommit(packet, session, {
    ...(options.inFlight === true ? { inFlight: true } : {}),
    ...(options.bundle === undefined ? {} : { bundle: options.bundle }),
  })

  switch (verdict.status) {
    case 'committed': {
      if (receipt?.outcome === 'committed' && !sameFoldProof(receipt.proof, verdict.proof)) {
        return {
          status: 'conflict',
          code: 'proof-mismatch',
          detail: 'the committed receipt no longer matches the fold proven by this log',
        }
      }
      if (receipt !== undefined && receipt.outcome !== 'committed') {
        return {
          status: 'conflict',
          code: 'proof-mismatch',
          detail: `the receipt says "${receipt.outcome}" but the log proves this fold committed`,
        }
      }
      const ops = validateOps(packet.ops)
      if (!ops.ok) {
        /* v8 ignore next 4 -- packetIdentityProblem already refused this. */
        return {
          status: 'invalid',
          code: 'ops-invalid',
          detail: `operations[${ops.failure.index}]: ${ops.failure.detail}`,
        }
      }
      return {
        status: 'valid',
        commit: {
          packetId: packet.packetId,
          sessionId: String(packet.sessionId),
          checkpointId: packet.checkpointId,
          commitOrder: verdict.proof.commitOrder,
          proof: verdict.proof,
          operations: ops.ops,
        },
        missingReceipt: receipt === undefined,
      }
    }
    case 'aborted': {
      if (receipt?.outcome === 'committed') {
        return {
          status: 'conflict',
          code: 'proof-mismatch',
          detail: `the receipt says committed but the log proves the fold did not: ${verdict.detail}`,
        }
      }
      return {
        status: 'aborted',
        reason: verdict.reason,
        detail: verdict.detail,
        ...(receipt === undefined ? {} : { receipt }),
      }
    }
    case 'unresolved': {
      if (receipt?.outcome === 'committed') {
        return {
          status: 'conflict',
          code: 'proof-mismatch',
          detail: `the receipt says committed but this log cannot prove it: ${verdict.detail}`,
        }
      }
      if (receipt !== undefined) {
        return {
          status: 'aborted',
          reason: 'compaction-ended-without-summary',
          detail: `the receipt is a final non-activation; ${verdict.detail}`,
          receipt,
        }
      }
      return { status: 'pending', detail: verdict.detail }
    }
    case 'conflict':
      return { status: 'conflict', code: 'proof-mismatch', detail: verdict.detail }
  }
}
