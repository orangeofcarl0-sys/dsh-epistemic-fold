/**
 * Epistemic Fold M0 durable vocabulary: fold modes, candidates, and the
 * immutable CheckpointBundleV1.
 *
 * @module dsh-epistemic-fold/types
 */

import type { CompactionId } from '@deepseek-ai/dsh-compaction'
import type { ContentBlock, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'

/** Why this fold exists: automatic pressure, manual rebase, or overflow recovery. */
export type FoldMode = 'leaf' | 'root' | 'emergency'

/**
 * The EF intent prepared BEFORE a compaction transaction starts. Candidates
 * are immutable; the registry holds at most one pending candidate per session
 * so concurrent transactions fail closed instead of mixing identities.
 */
export interface FoldCandidate {
  readonly checkpointId: string
  readonly mode: FoldMode
  readonly sessionId: SessionId

  /** Inclusive surface-position span, when the caller selected one explicitly. */
  readonly start?: SessionSeq
  readonly end?: SessionSeq

  /** `surface.replaceGeneration` observed when the candidate was prepared. */
  readonly preparedSurfaceGeneration: number
  /** Seed for the bundle source digest; pairs the archive with its intent. */
  readonly sourceDigestSeed: string
  /** DSH compaction identity, recorded once the transaction created one. */
  readonly compactionId?: CompactionId
}

/** Canonical checkpoint bundle: written once, never mutated, hash-verified. */
export interface CheckpointBundleV1 {
  readonly format: 'ef-checkpoint'
  readonly formatVersion: 1

  readonly checkpointId: string
  readonly sessionId: SessionId
  readonly createdAt: number
  readonly mode: FoldMode
  readonly compactionId?: CompactionId

  readonly source: {
    /** Surface-node seqs shadowed by the replacement, in surface order. */
    readonly orderedSurfaceSeqs: readonly SessionSeq[]
    /** SHA-256 over the canonical JSON of `orderedSurfaceSeqs` + seed. */
    readonly sourceDigest: string
  }

  readonly archive: {
    /** Model-visible messages of the shadowed span (system head excluded). */
    readonly shadowedMessages: readonly Message[]
    /** SHA-256 over the canonical JSON of `shadowedMessages`. */
    readonly logicalHash: string
  }

  /** Semantic digest when the summarizer call succeeded; absent on fallback. */
  readonly semantic?: {
    readonly text: string
  }

  readonly rendered: {
    /** The checkpoint text as it appears (framed) on the surface. */
    readonly text: string
    /** SHA-256 over the canonical JSON of `rendered.text`. */
    readonly digest: string
  }
}

/** Result of one durable bundle write. */
export interface BundleWriteResult {
  readonly checkpointId: string
  readonly fileHash: string
  readonly bytes: number
}

/** Integrity verification of a stored bundle. */
export type BundleVerification =
  | { readonly status: 'verified'; readonly bundle: CheckpointBundleV1 }
  | { readonly status: 'corrupt'; readonly reason: string }
  | { readonly status: 'missing' }

/** Lightweight listing entry for one stored bundle. */
export interface BundleDescriptor {
  readonly checkpointId: string
  readonly sessionId: SessionId
  readonly mode: FoldMode
  readonly createdAt: number
  readonly bytes: number
}

/** Durable storage for immutable checkpoint bundles. */
export interface FoldBundleStore {
  write(bundle: CheckpointBundleV1): Promise<BundleWriteResult>
  read(checkpointId: string): Promise<CheckpointBundleV1 | null>
  verify(checkpointId: string): Promise<BundleVerification>
  list(sessionId: SessionId): Promise<BundleDescriptor[]>
  remove(checkpointId: string): Promise<void>
}

/** Reconstructs the exact model-visible history a checkpoint replaced. */
export interface RecallPage {
  readonly checkpointId: string
  readonly totalMessages: number
  readonly offset: number
  readonly nextOffset?: number
  readonly messages: readonly Message[]
}

/**
 * Structural mirror of `@deepseek-ai/dsh-compaction-basic/src/summarizer`'s
 * SummarizationInput: the replayed conversation (system head, tools, shadowed
 * region) Basic hands the summarize hook. Kept local so the engine never
 * depends on the sibling's `/src` face at type level.
 */
export interface SummarizationInput {
  readonly tools?: readonly ToolSchema[]
  readonly messages: readonly Message[]
}

/**
 * Structural mirror of the sibling's SummaryResult: safe text blocks plus the
 * exact auxiliary-call envelope recorded with `compaction/summary`.
 */
export type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  usage?: TokenUsage
} & (
  | {
    rawOutput: ContentBlock[]
    llmStreamCall: true
  }
  | {
    rawOutput?: ContentBlock[]
    llmStreamCall?: never
  }
)

/** The session a pending candidate belongs to; typing helper for tests. */
export type FoldSession = Session
