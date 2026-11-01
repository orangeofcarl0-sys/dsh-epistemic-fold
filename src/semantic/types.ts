/**
 * The Semantic Continuity protocol: what a semantic proposal looks like, what
 * the runtime accepts, and what the durable journal records.
 *
 * ## Three axes that must not be collapsed
 *
 * The pre-existing state model already conflated nothing, and this layer keeps
 * that separation explicit because it is the source of most memory-system bugs:
 *
 *   EpistemicStatus  how well the claim is EVIDENCED
 *                    (claimed / hypothesis / observed / verified)
 *   SemanticLifecycle whether it is still the effective value
 *                    (active / superseded / retired)
 *   Residency        whether it must stay directly visible
 *                    (pinned / working / archived)
 *
 * A `verified` claim can still be superseded; a `pinned` constraint can be
 * merely `claimed`. Collapsing these into one `status` string is how a system
 * ends up revoking a user's constraint because it has not been mentioned
 * recently, or promoting an assistant's guess because it was written down.
 *
 * ## Who may write what
 *
 * The writer (a model) produces {@link ProposedDelta} values. They carry NO
 * authority: no anchor id, no digest, no seq, no `verified` bit that the model
 * can grant itself. The runtime resolves every quote against the folded span,
 * derives the evidence identity itself, and decides whether the claimed status
 * is supportable. Only then does a proposal become an {@link AcceptedDelta} and
 * travel to the anchor service, which is the one sanctioned producer of durable
 * state.
 *
 * ## Versioning
 *
 * `SEMANTIC_SCHEMA_VERSION` is stamped on every journal record. A reader that
 * does not know a version ignores the record rather than guessing at its
 * fields; a writer that changes the protocol must raise the number, because a
 * journal is append-only and old packets are never rewritten.
 *
 * @module dsh-epistemic-fold/semantic/types
 */

import type { WriterObservation } from './observation.ts'

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AuthorityDomain } from '../state/authority.ts'
import type { AnchorKind, EfAnchorEventData, FailureState, StateKey } from '../state/state.ts'

/**
 * Protocol version stamped on every packet and every durable record.
 *
 * Bumped 1 → 2 when the packet gained `mode`. That field is not cosmetic: it
 * decides whether a packet is a COMMIT INTENT. A version-1 packet has no mode,
 * so a reader cannot tell an `active` packet that lost its commit from a
 * `shadow` packet that deliberately never had one — and guessing "intent" made
 * a shadow deployment write state on its second fold. Version 1 packets are
 * therefore ignored rather than repaired.
 *
 * Bumped 2 → 3 when the packet gained `status`, `authority`, `bodyDigest`, and
 * `ops` (the RESOLVED declare/retire plan). Versions 1 and 2 store proposals
 * only; replaying them would have to re-resolve supersession against the
 * bounded current state, which is exactly the oracle that let a
 * twice-superseded value revive. Version 3 stores the resolution, so replay is
 * mechanical and independent of the bounded state. Older versions are ignored.
 */
export const SEMANTIC_SCHEMA_VERSION = 4

/**
 * The previous packet schema.
 *
 * v3 packets carry resolved ops and a body digest but NO source-content digest
 * and no commit proof. They are read only by the migration path, and conversion
 * requires a verified bundle (see PERSISTENCE.md). They are never applied
 * directly: a v3 packet cannot prove that the bytes it describes are still the
 * bytes the fold archived.
 */
export const LEGACY_SEMANTIC_SCHEMA_VERSION = 3

/** The previous semantic RECORD schema (the `plugin:epistemic-fold/semantic` payload). */
export const LEGACY_SEMANTIC_RECORD_VERSION = 3

/**
 * What kind of semantic state a delta proposes.
 *
 * The first seven map onto durable anchors; `experience-candidate` deliberately
 * does not. A candidate lesson is a weak signal — "this might generalize" — and
 * promoting one into hot state would be exactly the unvalidated authority
 * upgrade this layer exists to prevent. It is journaled, never anchored.
 */
export type SemanticKind =
  | 'objective'
  | 'constraint'
  | 'decision'
  | 'finding'
  | 'failure'
  | 'obligation'
  | 'rejected-approach'
  | 'experience-candidate'

/** Every kind, in the order the prompt lists them. */
export const SEMANTIC_KINDS: readonly SemanticKind[] = [
  'objective',
  'constraint',
  'decision',
  'finding',
  'failure',
  'obligation',
  'rejected-approach',
  'experience-candidate',
]

/**
 * How well the claim is evidenced. This is NOT lifecycle and NOT residency.
 *
 * `verified` is never granted from model text: it requires evidence the
 * authority model classifies as empirical or procedural (a real tool result).
 * The writer may ASK for it; the runtime downgrades an unsupported request to
 * `observed` and records the downgrade.
 */
export type EpistemicStatus = 'claimed' | 'hypothesis' | 'observed' | 'verified'

export const EPISTEMIC_STATUSES: readonly EpistemicStatus[] = [
  'claimed',
  'hypothesis',
  'observed',
  'verified',
]

/**
 * Whether the value at a coordinate is still the effective one.
 *
 * Separate from {@link EpistemicStatus}: a `verified` finding can be
 * `superseded` by a later measurement, and a `claimed` constraint is `active`
 * until the user revokes it. Only explicit operations move lifecycle.
 */
export type SemanticLifecycle = 'active' | 'superseded' | 'retired'

/**
 * How directly the state must remain visible in the model's context.
 *
 * This is a COMPILATION decision, not a validity decision. An anchor moving to
 * `archived` stays effective and recoverable; it stops being rendered inline
 * only because the budget is finite. Nothing here may be driven by age alone —
 * see `src/thermal.ts` for the same rule stated over the deterministic state.
 */
export type SemanticResidency = 'pinned' | 'working' | 'archived'

/** A bounded coordinate an object is about, when it is narrower than the task. */
export interface SemanticScope {
  readonly workspace?: string
  readonly branch?: string
  readonly file?: string
  readonly symbol?: string
  readonly revision?: string
}

/**
 * One piece of evidence, as the MODEL supplies it.
 *
 * The model gives a quote and nothing else. `seq` and `messageDigest` are
 * runtime-derived, so a proposal cannot name an event it did not read — the
 * failure mode where a model invents a plausible `eventSeq` to make a claim
 * look grounded.
 */
export interface ProposedEvidence {
  /** Exact substring of one message in the folded span. 8-240 characters. */
  readonly quote: string
}

/** One piece of evidence after the runtime located it. */
export interface EvidenceRef {
  /** Surface seq of the message the quote was found in. */
  readonly seq: number
  /** `canonicalHash` of the derived message, so a later reader can re-check it. */
  readonly messageDigest: string
  /** The exact quote, clamped to the stored bound. */
  readonly quote: string
}

/**
 * A semantic proposal as the WRITER emits it. Untrusted by construction.
 *
 * There is no `id`: identity is runtime-derived (`deltaIdentity`), because an
 * id chosen by the model could collide with an existing anchor or be reused to
 * impersonate one. There is no `authority`: the runtime derives it from the
 * evidence's provenance and the claimed status.
 */
export interface ProposedDelta {
  readonly kind: SemanticKind
  /**
   * Stable coordinate within the task, e.g. `branch`, `file:src/engine.ts`,
   * `failure:flaky-suite`. Supersession is per `(kind, subjectKey)`.
   */
  readonly subjectKey: string
  /** The claim, one or two sentences, in the language of the conversation. */
  readonly statement: string
  readonly status: EpistemicStatus
  readonly evidence: readonly ProposedEvidence[]
  /**
   * The exact success line a `verified` claim rests on.
   *
   * Required when the writer asks for `verified`, and it must be a verbatim
   * substring of a TOOL RESULT that is also cited in `evidence`. Without it a
   * tool result that proves one narrow thing (`npm run lint` passes) would
   * promote a much broader conclusion ("all concurrency bugs are fixed"); the
   * runtime cannot judge the inference, so it refuses to grant a status the
   * cited text does not literally contain.
   */
  readonly verificationQuote?: string
  /** Prior coordinates this replaces, or the literal `"previous"` at this key. */
  readonly supersedes?: readonly string[]
  /** Coordinates this claim depends on; recorded, never auto-resolved. */
  readonly dependsOn?: readonly string[]
  /** Coordinates this claim rules out (a rejected approach's targets). */
  readonly rulesOut?: readonly string[]
  readonly scope?: SemanticScope
}

/** Why a proposal was refused. Every value is a machine-readable verdict. */
export type SemanticRefusalReason =
  | 'unknown-kind'
  | 'unknown-status'
  | 'empty-subject'
  | 'subject-too-long'
  | 'empty-statement'
  | 'statement-too-long'
  | 'no-evidence'
  | 'evidence-not-found'
  | 'evidence-ambiguous'
  | 'evidence-derived'
  | 'status-unsupported'
  | 'verification-unscoped'
  | 'authority-ungrounded'
  | 'commit-failed'
  | 'duplicate'
  | 'limit-exceeded'

/** One refusal, carrying enough detail to reproduce the decision. */
export interface SemanticRefusal {
  readonly index: number
  readonly reason: SemanticRefusalReason
  readonly detail: string
}

/** A proposal that passed validation, with runtime-derived identity. */
export interface AcceptedDelta {
  readonly index: number
  /** `canonicalHash` over (kind, subjectKey, statement, status, evidence seqs). */
  readonly deltaId: string
  readonly kind: SemanticKind
  readonly subjectKey: string
  readonly statement: string
  readonly status: EpistemicStatus
  /**
   * The status actually granted. Differs from the claimed one only by the
   * explicit `verified -> observed` downgrade, which is recorded, not silent.
   */
  readonly grantedStatus: EpistemicStatus
  readonly evidence: readonly EvidenceRef[]
  /** Authority domain the runtime derived; the writer never names one. */
  readonly authority: AuthorityDomain
  /**
   * The tool-result evidence a `verified` grant rests on, when one was
   * required. Absent for every other status.
   */
  readonly verifiedBy?: EvidenceRef
  /** The anchor this delta will be declared as, when it maps to one. */
  readonly anchorKind: AnchorKind | undefined
  /** The state coordinate, when the delta maps to an anchor. */
  readonly stateKey: StateKey | undefined
  readonly failureState?: FailureState
  readonly supersedes: readonly string[]
  readonly dependsOn: readonly string[]
  readonly rulesOut: readonly string[]
  readonly scope?: SemanticScope
  /** Set when the runtime downgraded the claimed status. */
  readonly downgradedFrom?: EpistemicStatus
}

/** The writer's complete output for one fold. */
export interface SemanticPacket {
  readonly schemaVersion: number
  readonly packetId: string
  readonly sessionId: SessionId
  readonly checkpointId: string
  /**
   * The mode in force when the packet was written.
   *
   * `shadow` means the deltas were measured and deliberately NOT committed;
   * `active` means they are commit intents that reconciliation may repair. This
   * is the field that keeps shadow mode from writing state after a restart.
   */
  readonly mode: SemanticMode
  /**
   * Which durable record is the authority for this packet's state.
   *
   * `session-record` — the session log carries a `plugin:epistemic-fold/semantic`
   * record written after the fold committed; the projection folds it.
   * `journal` — the journal file itself is the commit record; the projection
   * layers its activated packets over the session-derived state.
   *
   * Exactly one is authoritative for a deployment. The field is recorded so a
   * packet written by one authority can never be applied by the other.
   */
  readonly authority: SemanticAuthority
  /** Where this packet is in the commit lifecycle. Only `activated` changes state. */
  readonly status: PacketStatus
  /** `canonicalHash` of the folded surface seqs — the packet's span identity. */
  readonly spanDigest: string
  readonly foldedSeqs: readonly number[]
  readonly createdAt: number
  /**
   * The session's `seq` when the packet was staged.
   *
   * The commit classifier compares it with the log's current length: the same
   * length means the fold may still be in flight (`pending`), while a longer
   * log with no matching summary means this body never committed
   * (`abandoned`). Without it a crashed fold would stay `staged` forever.
   */
  readonly stagedAtSeq: number
  /**
   * `canonicalHash` of the exact checkpoint body this packet was rendered into.
   *
   * The commit predicate matches the committed `compaction/summary` text to
   * this digest. A retried fold that produced different prose therefore leaves
   * a staged packet that cannot activate: only the body the model actually saw
   * becomes state.
   */
  readonly bodyDigest: string
  /**
   * `canonicalHash` of the archived SOURCE messages (after the fold's
   * deterministic derived-answer retirement).
   *
   * This is the archive's own `logicalHash`, not a second serialization rule.
   * It binds the packet to the content the fold actually archived, so a log
   * restored with different events at the same seqs is a CONFLICT rather than a
   * silent re-activation of state that belongs to another history.
   *
   * Absent only on a v3 packet. Such a packet is never applied directly; the
   * migration computes the value from the bundle and the log.
   */
  readonly sourceDigest?: string
  /**
   * The schema-3 packet id this v4 row was migrated from, when it was.
   *
   * v3 ids were produced by a different identity algorithm, so they cannot be
   * recomputed as v4 ids. Recording the origin is what lets the reconciler say
   * "this legacy packet has already been converted" without treating the
   * `.v3.json` audit archive as an outstanding migration forever.
   */
  readonly legacyPacketId?: string
  /**
   * The RESOLVED commit plan, in application order.
   *
   * Declares and retires are resolved at staging time against the projected
   * state, not re-resolved at replay time. That is what makes replay a
   * mechanical fold over recorded operations instead of a second resolution
   * pass whose oracle (the bounded current state) may have moved on.
   */
  readonly ops: readonly EfAnchorEventData[]
  /**
   * What WOULD have been committed, when nothing was.
   *
   * Used by shadow mode: `ops` stays empty so a shadow packet can never change
   * state even if a reader applies it by mistake, while this field keeps the
   * measurement available for diagnostics.
   */
  readonly plannedOps?: readonly EfAnchorEventData[]
  /** The advisory handoff text (the Rationale slot). */
  readonly handoff: string
  /** Whether the model's response was actually parsed for deltas. */
  readonly deltaParse: 'parsed' | 'absent' | 'malformed'
  /**
   * The proposals EXACTLY as the writer emitted them, before any validation.
   *
   * Typed as `ProposedDelta[]` for ergonomics, but a malformed entry survives
   * here untouched: this is the audit record of what the model said, and
   * `accepted`/`refused` are the record of what the runtime made of it. A
   * reader that needs a trustworthy value reads `accepted`, never this field.
   * The element type is `unknown` on purpose: a malformed proposal must be
   * storable for audit, and typing it as `ProposedDelta` would be a claim the
   * runtime has not checked.
   */
  readonly proposed: readonly unknown[]
  readonly accepted: readonly AcceptedDelta[]
  readonly refused: readonly SemanticRefusal[]
  /** What the working-set compiler carried, when an active fold compiled one. */
  readonly workingSet?: SemanticWorkingSetReport
  /** When the fold committed and this packet's ops became state. */
  readonly activatedAt?: number
  /** Why a staged packet will never activate. Absent for an activated packet. */
  readonly abandonReason?: string
  /** The real call envelope, when a model call happened. */
  readonly writer?: {
    readonly provider: string
    readonly model: string
    readonly maxTokens: number
    readonly usage?: unknown
  }
}

/** The durable authority a deployment uses for semantic state. */
export type SemanticAuthority = 'session-record' | 'journal'

/**
 * A committed decision about one prepared packet.
 *
 * The receipt is IMMUTABLE and separate from the prepared packet. A packet can
 * be read and re-evaluated many times (in flight, after a restart, after a log
 * restore); the decision that made its operations state is written once, with
 * the historical fold proof that justified it. There is no `staged` receipt:
 * "no receipt yet" is the staged state, and rewriting a receipt to say
 * something else is exactly the mutation this separation prevents.
 */
export interface SemanticReceipt {
  readonly kind: 'receipt'
  readonly schemaVersion: number
  readonly packetId: string
  readonly sessionId: SessionId
  readonly checkpointId: string
  /** `committed` applies ops; the other two are final non-activations. */
  readonly outcome: 'committed' | 'aborted' | 'archived-only'
  /** Present exactly for `committed`. */
  readonly proof?: import('./proof.ts').HistoricalFoldProof
  /** `canonicalHash(ops)`, so a packet/receipt pairing is checkable. */
  readonly opsDigest: string
  /** Wall-clock decision time, for diagnostics only; replay never sorts on it. */
  readonly decidedAt: number
  /** Why an abort happened. */
  readonly reason?: string
}

/**
 * A packet's commit lifecycle.
 *
 *   staged        written before the fold could commit; NOT state
 *   activated     the fold committed; its ops are state
 *   abandoned     the fold did not commit, or a retry chose another body
 *   archived-only the bundle is durable but the surface never committed
 */
export type PacketStatus = 'staged' | 'activated' | 'abandoned' | 'archived-only'

/**
 * One compiled working set's accounting, plus the COMPLETE checkpoint's cost.
 *
 * `tokens`/`overflow` describe the carried-state budget only. A checkpoint can
 * satisfy that and still be far over the whole-body budget through changed
 * deltas, rationale, or framing, so the full component breakdown travels with
 * the packet instead of being inferred later.
 */
export interface SemanticWorkingSetReport {
  readonly tokens: number
  readonly overflow: boolean
  readonly pinned: number
  readonly working: number
  readonly archived: number
  readonly changedTokens: number
  readonly carriedTokens: number
  readonly rationaleTokens: number
  readonly framingTokens: number
  readonly noticeTokens: number
  readonly totalCheckpointTokens: number
  readonly pinnedTokens: number
  readonly budgetTokens: number
  readonly totalBudgetTokens: number
  readonly pinnedOverflow: boolean
  readonly totalOverflow: boolean
  /** `token-meter` when measured with the mounted meter; `chars-per-4` otherwise. */
  readonly estimateBasis: 'token-meter' | 'chars-per-4'
}

/**
 * The semantic layer's operational state (§6.5).
 *
 * These are DIAGNOSTIC states, not fold outcomes. The distinction that matters:
 * a fold can succeed while semantics are `unavailable` — history is archived
 * and the checkpoint is deterministic — but a reader must never be told the
 * current state is complete when it is not.
 */
export type SemanticHealth =
  | 'ready'
  | 'partial'
  | 'unavailable'
  | 'stale'
  | 'archive-only'

/** What the engine knows about the semantic layer right now. */
export interface SemanticDiagnostics {
  readonly health: SemanticHealth
  /**
   * The last fold's writer observation, when a writer path ran (or was
   * withheld). The four axes are independent; in particular `integrity: ready`
   * does NOT mean the writer extracted every action-critical fact.
   */
  readonly writer?: WriterObservation
  /** Why the health is not `ready`; absent when it is. */
  readonly detail?: string
  readonly mode: SemanticMode
  readonly packets: number
  readonly accepted: number
  readonly refused: number
  readonly committed: number
  /** Deltas whose anchor was missing from the log and was re-committed. */
  readonly reconciled: number
  /** Tokens in the most recent compiled working set; 0 before any active fold. */
  readonly workingSetTokens: number
  /** The most recent fold's packet, for inspection and tests. */
  readonly lastPacket?: SemanticPacket
}

/** The feature switch, in its three-valued form. */
export type SemanticMode = 'off' | 'shadow' | 'active'

/**
 * One journal record.
 *
 * The v3 journal stores ONE file per packet and mutates only that packet's
 * `status` when the fold commits. There is no separate `commit` record: a
 * `commit` record written before the fold could only ever describe an intent,
 * and one written after it would be a second source of truth for the same
 * fact. The packet's status is the fact.
 */
export interface StoredPacket {
  readonly kind: 'packet'
  readonly schemaVersion: number
  readonly packet: SemanticPacket
}

/** Result of reconciling staged packets against a live session log. */
export interface ReconciliationReport {
  /** Packets read from the journal (or projected from session records). */
  readonly scanned: number
  /** Packets that were still waiting for commit evidence. */
  readonly staged: number
  /** Staged packets that were activated by this pass. */
  readonly activated: number
  /** Staged packets whose fold demonstrably did not commit. */
  readonly abandoned: number
  /** Packets that cannot be repaired (bad payload, wrong schema). */
  readonly unrepairable: number
  readonly health: SemanticHealth
  readonly detail?: string
}
