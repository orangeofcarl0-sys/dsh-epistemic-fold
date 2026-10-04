/**
 * Epistemic Fold M0 durable vocabulary: fold modes, candidates, and the
 * immutable CheckpointBundleV1.
 *
 * @module dsh-epistemic-fold/types
 */

import type { CompactionId } from '@deepseek-ai/dsh-compaction'
import type { ContentBlock, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'

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

/**
 * One archived message's identity: where it came from, and what it must be.
 *
 * `digest` is `canonicalHash` over the DERIVED message at `seq`, not over the
 * raw event. The archive stores derived messages (that is what the model saw),
 * so a ref that hashed the raw event would not detect a change in the
 * derivation rule — the exact drift this field exists to catch.
 */
export interface ArchiveRef {
  readonly seq: SessionSeq
  /** `canonicalHash` of the derived message this position must still produce. */
  readonly digest: string
}

/** Canonical checkpoint bundle: written once, never mutated, hash-verified. */
export interface CheckpointBundleV1 {  readonly format: 'ef-checkpoint'
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
    /**
     * Model-visible messages of the shadowed span (system head excluded).
     *
     * ABSENT when the bundle was written in referential form
     * (`referentialArchive`), where the exact history is identified by `refs`
     * and recovered from the session log on demand. Absence is meaningful and
     * never means "the fold covered nothing": `messageCount` and `logicalHash`
     * are present either way.
     */
    readonly shadowedMessages?: readonly Message[]
    /**
     * How many messages the fold archived, whether or not their bytes are here.
     * A referential bundle still knows its span's length, which is what a
     * reader needs before deciding whether to resolve it.
     */
    readonly messageCount: number
    /**
     * SHA-256 over the canonical JSON of the archived messages. Present in both
     * forms, and it is the authority in both: a resolved reference is accepted
     * only when re-hashing the messages it produced reproduces this value.
     */
    readonly logicalHash: string
    /**
     * Per-message identity refs: which log position, and what that position
     * must hash to.
     *
     * The `digest` is the whole reason a ref can be trusted. A bare seq says
     * "fetch from here"; `(seq, digest)` says "this position still holds what I
     * referenced". Without it a later `deriveEventMessage` change, a rewritten
     * surface, or a migrated log would silently resolve to different content —
     * which is precisely the corruption a reference scheme must not introduce.
     */
    readonly refs: readonly ArchiveRef[]
  }

  /** Semantic digest when the summarizer call succeeded; absent on fallback. */
  readonly semantic?: {
    readonly text: string
  }

  /**
   * The cognitive state this checkpoint was rendered from, bound by digest.
   *
   * ## Why this exists
   *
   * The checkpoint body shows a MODEL-FACING view of the deterministic state
   * ("Current" / "Evidence" / "Open"). That view is a projection, and until this
   * field existed nothing recorded WHICH state it projected — so a rendering or
   * reducer defect would put a state snapshot in front of the model that no
   * longer matched what the log derives, with nothing able to notice. That is
   * the shape the memory literature calls ghost memory / governance decay: the
   * displayed state silently diverges from the truth.
   *
   * `digest` is `canonicalHash(state)`. A reader can re-derive the state from
   * the session log, hash it, and compare: equal means the checkpoint shows the
   * state the log supports, unequal is detectable corruption rather than a
   * plausible-looking lie.
   *
   * Absent when no projection was mounted, which is exactly when no state was
   * rendered into the body — so absence is informative, not missing data.
   */
  readonly state?: {
    /** `canonicalHash` over the `FoldCurrentState` that produced the body. */
    readonly digest: string
    /** Anchors visible in the rendered body, for a cheap sanity comparison. */
    readonly anchors: number
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
  /**
   * Session-scoped read (R0-A): bundles are only ever served to the session
   * that owns them — a cross-session lookup reads as absent, never as data.
   */
  read(sessionId: SessionId, checkpointId: string): Promise<CheckpointBundleV1 | null>
  verify(sessionId: SessionId, checkpointId: string): Promise<BundleVerification>
  list(sessionId: SessionId): Promise<BundleDescriptor[]>
  remove(sessionId: SessionId, checkpointId: string): Promise<void>
  /** Persist the post-commit provenance record (R0-A). */
  recordCommit(record: FoldCommitRecordV1): Promise<void>
  readCommitRecord(sessionId: SessionId, checkpointId: string): Promise<FoldCommitRecordV1 | null>
  /**
   * EXPERIMENTAL: which session owns this checkpoint, or `undefined`.
   *
   * Exists only for the cross-session recall experiment, which is off by
   * default. A checkpoint ref (`cp:<id>`) carries no session, and every other
   * method here is session-scoped by design (R0-A isolation), so a foreign
   * lookup needs one explicit way to resolve ownership rather than a relaxed
   * `read`.
   *
   * OPTIONAL so a store implementation that does not support the experiment —
   * including every test double — remains valid.
   */
  findSessionOf?(checkpointId: string): Promise<SessionId | undefined>
}

/**
 * Post-commit provenance record (R0-A): the DSH mutation facts a compile hook
 * cannot know before the transaction commits. The Bundle (pre-commit) is the
 * knowledge/archive object; the CommitRecord (post-commit) is the mutation
 * provenance object — the two identities never mix.
 */
export interface FoldCommitRecordV1 {
  readonly checkpointId: string
  readonly sessionId: SessionId
  readonly mode: FoldMode
  readonly compactionId: string
  /** Exact shadowed surface nodes, straight from the durable CompactionResult. */
  readonly shadowedSeqs: readonly SessionSeq[]
  readonly startSeq: SessionSeq
  readonly summarySeq: SessionSeq
  readonly endSeq: SessionSeq
  readonly committedAt: number
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
