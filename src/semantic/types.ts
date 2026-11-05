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

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AuthorityDomain } from '../authority.ts'
import type { AnchorKind, FailureState, StateKey } from '../state.ts'

/**
 * Protocol version stamped on every journal record.
 *
 * Bumped 1 → 2 when the packet gained `mode`. That field is not cosmetic: it
 * decides whether a packet is a COMMIT INTENT. A version-1 packet has no mode,
 * so a reader cannot tell an `active` packet that lost its commit from a
 * `shadow` packet that deliberately never had one — and guessing "intent" made
 * a shadow deployment write state on its second fold. Version 1 packets are
 * therefore ignored rather than repaired.
 */
export const SEMANTIC_SCHEMA_VERSION = 2

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
  /** `canonicalHash` of the folded surface seqs — the packet's span identity. */
  readonly spanDigest: string
  readonly foldedSeqs: readonly number[]
  readonly createdAt: number
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
   */
  readonly proposed: readonly ProposedDelta[]
  readonly accepted: readonly AcceptedDelta[]
  readonly refused: readonly SemanticRefusal[]
  /** The real call envelope, when a model call happened. */
  readonly writer?: {
    readonly provider: string
    readonly model: string
    readonly maxTokens: number
    readonly usage?: unknown
  }
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
 * One journal record. `kind` discriminates the durable outcomes we must be
 * able to reconcile after a restart.
 *
 * A packet is written BEFORE any anchor is appended, so a crash between the two
 * leaves evidence of an intent that was never committed — recoverable, and
 * distinguishable from a fold that never ran.
 */
export type JournalRecord =
  | {
    readonly kind: 'packet'
    readonly schemaVersion: number
    readonly packet: SemanticPacket
  }
  | {
    readonly kind: 'commit'
    readonly schemaVersion: number
    readonly packetId: string
    readonly deltaId: string
    readonly anchorId: string
    readonly at: number
  }
  | {
    readonly kind: 'health'
    readonly schemaVersion: number
    readonly packetId: string
    readonly health: SemanticHealth
    readonly detail?: string
    readonly at: number
  }

/** Result of reconciling the journal against a live session log. */
export interface ReconciliationReport {
  readonly packets: number
  /** Deltas that were accepted and journaled but have no anchor in the log. */
  readonly missing: readonly { readonly packetId: string; readonly delta: AcceptedDelta }[]
  /** Deltas whose anchor already exists and must not be re-appended. */
  readonly present: number
  readonly health: SemanticHealth
  readonly detail?: string
}
