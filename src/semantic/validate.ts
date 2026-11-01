/**
 * Semantic validation: the runtime half of "the model proposes, the runtime
 * decides".
 *
 * ## The one question this answers
 *
 * Given a proposal that a model wrote, and the committed messages it may cite,
 * is there enough ground to let this claim change durable state?
 *
 * Four independent checks, and all four must pass:
 *
 *  1. **Shape** — known kind, known status, bounded subject and statement.
 *     A model that invents an eighth kind or a 4000-character "constraint" is
 *     not writing a state change, it is writing prose.
 *  2. **Evidence** — every quote resolves to exactly one COMMITTED message in
 *     the folded span, and that message is not itself derived narrative.
 *  3. **Authority** — the claim's kind demands a domain, and the cited messages
 *     can ground that domain. A constraint needs the human; a finding needs a
 *     tool result; assistant prose can ground a hypothesis or a decision, never
 *     a normative requirement.
 *  4. **Status** — `verified` requires empirical or procedural evidence. The
 *     model may ASK for it; an unsupported request is DOWNGRADED and the
 *     downgrade is recorded, never silently accepted.
 *
 * Passing all four is not a claim that the conclusion is CORRECT. It means the
 * conclusion is attributable, within its authority domain, and not more
 * strongly asserted than its evidence allows. Causal conclusions stay
 * `observed` or `claimed`; nothing here can promote them.
 *
 * @module dsh-epistemic-fold/semantic/validate
 */

import { canVerify, isAuthorityGrounded } from '../state/authority.ts'
import type { AuthorityDomain, AuthoritativeEventKind } from '../state/authority.ts'
import { canonicalHash } from '../checkpoint/hash.ts'
import type { AnchorKind, StateKey } from '../state/state.ts'
import { MAX_QUOTE_CHARS, MIN_QUOTE_CHARS, citableMessages, resolveEvidence, resolveQuote } from './evidence.ts'
import type { CitableMessage } from './evidence.ts'
import {
  EPISTEMIC_STATUSES,
  SEMANTIC_KINDS,
} from './types.ts'
import type {
  AcceptedDelta,
  EpistemicStatus,
  EvidenceRef,
  ProposedDelta,
  SemanticKind,
  SemanticRefusal,
  SemanticScope,
} from './types.ts'
import type { Message } from '@deepseek-ai/dsh-llm'

/** Bounds that keep a proposal a state change rather than an essay. */
export const MAX_SUBJECT_CHARS = 80
export const MAX_STATEMENT_CHARS = 600
export const DEFAULT_MAX_DELTAS = 12

/**
 * What each semantic kind requires, and what it becomes in durable state.
 *
 * `domains` is the set of authority domains ANY ONE of which is enough. The
 * table is deliberately narrow: a constraint can only ever be normative, and a
 * finding can only ever be empirical. Letting a kind pick a convenient domain
 * is how an assistant's guess becomes a user requirement.
 */
interface KindRule {
  readonly domains: readonly AuthorityDomain[]
  readonly anchorKind?: AnchorKind
  /**
   * `failure` anchors are declared OPEN; only an evidence-backed transition can
   * advance them, and `verified` additionally needs all-empirical refs.
   */
  readonly failureState?: 'open'
  /** Force the epistemic status irrespective of what the writer asked for. */
  readonly forcedStatus?: EpistemicStatus
}

const KIND_RULES: Record<SemanticKind, KindRule> = {
  objective: { domains: ['normative'], anchorKind: 'objective' },
  constraint: { domains: ['normative'], anchorKind: 'constraint' },
  obligation: { domains: ['normative'], anchorKind: 'obligation' },
  decision: { domains: ['decision'], anchorKind: 'decision' },
  'rejected-approach': { domains: ['decision'], anchorKind: 'decision' },
  finding: { domains: ['empirical', 'procedural'], anchorKind: 'evidence' },
  failure: { domains: ['empirical'], anchorKind: 'failure', failureState: 'open' },
  // A candidate lesson is never authority; it is journaled for later review.
  'experience-candidate': { domains: ['hypothesis'], forcedStatus: 'hypothesis' },
}

/**
 * The durable anchor id for one accepted delta.
 *
 * DERIVED, not assigned. An id chosen at commit time would have to be recorded
 * somewhere else and compared on restart, and a lost record would look like a
 * missing anchor and cause a duplicate. Deriving it from the delta identity
 * makes "does this delta have an anchor?" answerable from the session log
 * ALONE — which is the only evidence that survives a crash.
 *
 * 128 bits of the digest; a collision would need two accepted deltas whose
 * identities agree in 32 hex characters, which is the same bound the rest of
 * this project already accepts for content addressing.
 *
 * @param deltaId - the delta's content identity.
 * @returns the anchor id its commit will use.
 */
export function anchorIdOf(deltaId: string): string {
  return `semantic-${deltaId.slice(0, 32)}`
}

/** Every state coordinate this layer writes lives under one namespace. */
export const SEMANTIC_NAMESPACE = 'semantic'

/**
 * The state coordinate for one semantic claim.
 *
 * `entity` is the SEMANTIC kind, not the anchor kind, so a `decision` and a
 * `rejected-approach` about the same subject stay distinct coordinates even
 * though both become `decision` anchors. Two claims about the same thing of the
 * same kind supersede each other; different kinds do not.
 *
 * ## Scope is part of the coordinate
 *
 * Two tasks can both name `timeout` and mean different limits. Without a scope
 * discriminator, the second declare lands on the same coordinate as the first
 * and silently displaces it — a cross-task memory overwrite that no proposal
 * author intended. When the writer supplies a scope, a stable digest of it joins
 * the entity, so the two claims occupy different coordinates and cannot
 * supersede each other. An UNSCOPED claim keeps the unscoped coordinate, which
 * is what every pre-R32 anchor uses; without a trustworthy task identity the
 * runtime cannot invent a distinction, and the limitation is documented rather
 * than guessed at.
 *
 * This is the only place a semantic coordinate is constructed, so the journal's
 * `(kind, subjectKey)` and the reducer's `stateKeyText` cannot drift.
 *
 * @param kind - the semantic kind.
 * @param subjectKey - the claimed coordinate.
 * @param scope - the task identity, when the claim is narrower than the task.
 * @returns the durable state key.
 */
export function semanticStateKey(
  kind: SemanticKind,
  subjectKey: string,
  scope?: SemanticScope,
): StateKey {
  return {
    namespace: SEMANTIC_NAMESPACE,
    entity: scope === undefined ? kind : `${kind}#${canonicalHash(scope)}`,
    property: subjectKey,
  }
}

/** Whether one cited kind is empirical or procedural ground. */
function isEmpirical(kind: AuthoritativeEventKind): boolean {
  return kind === 'tool/result'
}

/**
 * Quantifiers that turn a narrow observation into a broad conclusion.
 *
 * This is a SCOPE guard, not a truth check. The runtime cannot tell whether a
 * passing lint run proves "all concurrency bugs are fixed"; it can tell that
 * the claim generalized while the quoted success line did not. The refusal
 * points the writer at the narrower option (`observed`), which is the honest
 * status for an inference the tool result does not literally state.
 *
 * A false refusal (a quoted line that really did say "all") is avoided by
 * checking the verification text for the same token before refusing.
 */
const GENERALIZATION_EN = /\b(all|every|always|never|entire|entirely|completely|fully|universally)\b/iu
const GENERALIZATION_CJK = /(所有|全部|任何|彻底|完全|始终|从未)/u

/** The first generalization token in a statement, if any. */
function generalizationToken(statement: string): string | undefined {
  return GENERALIZATION_EN.exec(statement)?.[0] ?? GENERALIZATION_CJK.exec(statement)?.[0]
}

/**
 * Decide whether a `verified` grant has a verification quote that supports it.
 *
 * The quote must:
 *  - exist and be a verbatim substring of a TOOL RESULT that the delta ALSO
 *    cites as evidence — a verification cannot rest on an uncited success line;
 *  - not be narrower than a generalizing statement.
 *
 * @returns the tool-result evidence ref, or a refusal.
 */
function verifyClaim(input: {
  readonly claimed: EpistemicStatus
  readonly granted: EpistemicStatus
  readonly statement: string
  readonly verificationQuote: unknown
  readonly evidence: readonly EvidenceRef[]
  readonly citable: readonly CitableMessage[]
}): { readonly verifiedBy?: EvidenceRef } | { readonly detail: string } {
  // Only a granted VERIFIED needs a scope; a downgraded request is already
  // recorded as such, and a non-verified claim may carry the field harmlessly.
  if (input.claimed !== 'verified' || input.granted !== 'verified') return {}
  const quote = typeof input.verificationQuote === 'string' ? input.verificationQuote.trim() : ''
  if (quote.length < MIN_QUOTE_CHARS || quote.length > MAX_QUOTE_CHARS) {
    return {
      detail: `status "verified" requires verificationQuote: ${MIN_QUOTE_CHARS}-${MAX_QUOTE_CHARS} characters `
        + 'copied exactly from the tool result it rests on',
    }
  }
  const evidenceSeqs = new Set(input.evidence.map(entry => entry.seq))
  const cited = input.citable.filter(entry => evidenceSeqs.has(entry.seq))
  const resolved = resolveQuote(quote, cited)
  if (resolved.status === 'not-found') {
    return { detail: 'verificationQuote is not a verbatim substring of the cited evidence' }
  }
  if (resolved.status === 'ambiguous') {
    return { detail: `verificationQuote occurs in ${resolved.seqs.length} cited messages; quote the exact line` }
  }
  if (resolved.status === 'derived') {
    return { detail: 'verificationQuote matched derived narrative, which cannot verify anything' }
  }
  if (resolved.kind !== 'tool/result') {
    return { detail: `verificationQuote is grounded in ${resolved.kind}, not a tool result` }
  }
  const token = generalizationToken(input.statement)
  if (token !== undefined && !quote.toLowerCase().includes(token.toLowerCase())) {
    return {
      detail: `the statement generalizes ("${token}") beyond the verification text; `
        + 'cite a tool result that states that scope, or lower the status to "observed"',
    }
  }
  return { verifiedBy: resolved.evidence }
}

/**
 * Decide the status the evidence can actually support.
 *
 * The downgrade path is the point. A writer that says `verified` with only
 * assistant prose in evidence gets `claimed`; with a tool result but no
 * reproducibility evidence it gets `observed`. The caller records
 * `downgradedFrom` so an audit can see that the model asked for more than it
 * had.
 */
function grantStatus(
  claimed: EpistemicStatus,
  kinds: readonly AuthoritativeEventKind[],
): { readonly granted: EpistemicStatus; readonly downgraded: boolean } {
  const empirical = kinds.some(isEmpirical)
  const allEmpirical = canVerify(kinds)
  switch (claimed) {
    case 'verified':
      if (allEmpirical) return { granted: 'verified', downgraded: false }
      return { granted: empirical ? 'observed' : 'claimed', downgraded: true }
    case 'observed':
      return empirical
        ? { granted: 'observed', downgraded: false }
        : { granted: 'claimed', downgraded: true }
    default:
      return { granted: claimed, downgraded: false }
  }
}

/**
 * Trim, and normalize a subject key to a single-line identifier.
 *
 * Printable ASCII only, deliberately. A coordinate becomes part of a state key,
 * and state keys are canonicalized and hashed (`canonicalJson` sorts with
 * `localeCompare`, whose collation is locale-dependent for non-ASCII text). A
 * non-ASCII subject key could therefore make two hosts compute different
 * digests for identical state. A coordinate is a machine identifier; requiring
 * the identifier alphabet is both honest and cheaper than changing the digest
 * rule for the whole project.
 */
function normalizeSubject(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const subject = value.trim().replace(/\s+/gu, ' ')
  if (subject.length === 0 || subject.length > MAX_SUBJECT_CHARS) return undefined
  if (!/^[\x20-\x7e]+$/u.test(subject)) return undefined
  return subject
}

/**
 * Normalize a statement to ONE line, or reject it.
 *
 * Whitespace collapsing is a correctness measure, not tidiness. The value is
 * interpolated into a rendered state line, so a statement containing a newline
 * could emit additional lines that look exactly like runtime-authored anchor
 * lines — including the trailing ` (authority)` marker. A model-written claim
 * must not be able to forge the shape of a runtime fact.
 *
 * An oversized statement is REFUSED rather than truncated: truncating would
 * store (and hash) a claim the model did not make, and would make two distinct
 * long claims collide on their first 600 characters.
 */
function normalizeStatement(value: unknown): { readonly statement: string } | { readonly tooLong: true } | undefined {
  if (typeof value !== 'string') return undefined
  const statement = value.trim().replace(/\s+/gu, ' ')
  if (statement.length === 0) return undefined
  if (statement.length > MAX_STATEMENT_CHARS) return { tooLong: true }
  return { statement }
}

/** Keep only the declared scope fields, as strings. */
function normalizeScope(value: unknown): SemanticScope | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const scope: Record<string, string> = {}
  for (const key of ['workspace', 'branch', 'file', 'symbol', 'revision'] as const) {
    const entry = raw[key]
    if (typeof entry === 'string' && entry.trim().length > 0) scope[key] = entry.trim().slice(0, 240)
  }
  return Object.keys(scope).length === 0 ? undefined : scope as SemanticScope
}

/** Normalize a string list (supersedes / dependsOn / rulesOut) to single lines. */
function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    // Collapsed for the same reason as a statement: these reach the rendered
    // anchor value (`rules out: …`) and must not be able to add lines.
    const trimmed = entry.trim().replace(/\s+/gu, ' ').slice(0, MAX_SUBJECT_CHARS)
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/**
 * Stable identity of one accepted delta, used for idempotent replay.
 *
 * Two folds that cover the same span produce the same deltas, so the identity
 * must be derived from the CONTENT and its provenance — not from the fold, the
 * packet, or the anchor id. A retried fold therefore finds its own deltas
 * already present and writes nothing.
 */
function deltaIdentity(input: {
  kind: SemanticKind
  subjectKey: string
  statement: string
  status: EpistemicStatus
  evidenceSeqs: readonly number[]
  scope?: SemanticScope
}): string {
  return canonicalHash({
    kind: input.kind,
    subjectKey: input.subjectKey,
    statement: input.statement,
    status: input.status,
    evidenceSeqs: [...input.evidenceSeqs].sort((left, right) => left - right),
    // Omitted for an unscoped delta, so pre-R32 identities stay byte-identical.
    ...(input.scope === undefined ? {} : { scope: input.scope }),
  })
}

/** Options for {@link validateDeltas}. */
export interface ValidateDeltasOptions {
  /** Surface seqs of the folded span. */
  readonly foldedSeqs: readonly number[]
  /** The derived messages of that span, positionally paired with `foldedSeqs`. */
  readonly messages: readonly Message[]
  /** Raw proposals, exactly as the writer emitted them. */
  readonly proposed: readonly unknown[]
  /**
   * Delta identities already committed for this session. A proposal whose
   * identity is already known is refused as `duplicate` — the idempotency
   * guard that makes a retried fold a no-op instead of a second anchor.
   */
  readonly knownDeltaIds?: ReadonlySet<string>
  readonly maxDeltas?: number
}

/** The validation outcome. */
export interface ValidationResult {
  readonly accepted: readonly AcceptedDelta[]
  readonly refused: readonly SemanticRefusal[]
  /** Citable messages, exposed so a caller can price the transcript. */
  readonly citable: readonly CitableMessage[]
}

/**
 * Validate one fold's proposals against the span they claim to describe.
 *
 * @param options - the span, its messages, and the raw proposals.
 * @returns accepted deltas with runtime-derived identity, plus one refusal per
 *   rejected proposal. Never throws for bad model output: a malformed proposal
 *   is a refusal, not a fold failure.
 */
export function validateDeltas(options: ValidateDeltasOptions): ValidationResult {
  const citable = citableMessages(options.foldedSeqs, options.messages)
  const known = options.knownDeltaIds ?? new Set<string>()
  const limit = options.maxDeltas ?? DEFAULT_MAX_DELTAS
  const accepted: AcceptedDelta[] = []
  const refused: SemanticRefusal[] = []
  const seen = new Set<string>(known)

  for (const [index, raw] of options.proposed.entries()) {
    if (accepted.length >= limit) {
      refused.push({
        index,
        reason: 'limit-exceeded',
        detail: `more than ${limit} proposals in one fold; the remainder was not considered`,
      })
      continue
    }
    const refusal = validateOne(index, raw, citable)
    if ('reason' in refusal) {
      refused.push(refusal)
      continue
    }
    if (seen.has(refusal.deltaId)) {
      refused.push({ index, reason: 'duplicate', detail: `delta ${refusal.deltaId.slice(0, 12)} is already committed` })
      continue
    }
    seen.add(refusal.deltaId)
    accepted.push(refusal)
  }
  return { accepted, refused, citable }
}

/**
 * Validate one proposal.
 *
 * @returns an accepted delta, or a refusal carrying the machine-readable reason.
 */
function validateOne(
  index: number,
  raw: unknown,
  citable: readonly CitableMessage[],
): AcceptedDelta | SemanticRefusal {
  const refuse = (reason: SemanticRefusal['reason'], detail: string): SemanticRefusal =>
    ({ index, reason, detail })

  if (raw === null || typeof raw !== 'object') {
    return refuse('unknown-kind', 'proposal is not an object')
  }
  const proposal = raw as Partial<ProposedDelta>
  if (typeof proposal.kind !== 'string' || !(SEMANTIC_KINDS as readonly string[]).includes(proposal.kind)) {
    return refuse('unknown-kind', `kind ${JSON.stringify(proposal.kind)} is not a semantic kind`)
  }
  const kind = proposal.kind as SemanticKind
  if (typeof proposal.status !== 'string' || !(EPISTEMIC_STATUSES as readonly string[]).includes(proposal.status)) {
    return refuse('unknown-status', `status ${JSON.stringify(proposal.status)} is not an epistemic status`)
  }
  const claimed = proposal.status as EpistemicStatus
  const subjectKey = normalizeSubject(proposal.subjectKey)
  if (subjectKey === undefined) {
    return refuse(
      typeof proposal.subjectKey === 'string' && proposal.subjectKey.trim().length > MAX_SUBJECT_CHARS
        ? 'subject-too-long'
        : 'empty-subject',
      `subjectKey must be 1-${MAX_SUBJECT_CHARS} characters on one line`,
    )
  }
  const normalized = normalizeStatement(proposal.statement)
  if (normalized === undefined) return refuse('empty-statement', 'statement is empty')
  if ('tooLong' in normalized) {
    return refuse(
      'statement-too-long',
      `statement exceeds ${MAX_STATEMENT_CHARS} characters; a state claim is a sentence, not an essay`,
    )
  }
  const statement = normalized.statement

  const proposedEvidence: unknown[] = Array.isArray(proposal.evidence) ? proposal.evidence : []
  const quotes = proposedEvidence.flatMap(entry => {
    if (entry === null || typeof entry !== 'object') return []
    const quote = (entry as { quote?: unknown }).quote
    return typeof quote === 'string' ? [{ quote }] : []
  })
  const resolved = resolveEvidence(quotes, citable)
  if (!resolved.ok) return refuse(resolved.reason, resolved.detail)

  const rule = KIND_RULES[kind]
  // The strongest domain the evidence grounds decides whether the claim may be
  // made at all. `isAuthorityGrounded` refuses `narrative` outright, so a
  // proposal can never bootstrap itself.
  const grounded = rule.domains.some(domain =>
    isAuthorityGrounded(domain, resolved.kinds) && resolved.kinds.length > 0)
  if (!grounded) {
    return refuse(
      'authority-ungrounded',
      `a ${kind} requires ${rule.domains.join(' or ')} authority, but the cited evidence is `
      + `[${resolved.kinds.join(', ')}]${describeProducers(citable, resolved.evidence)}`,
    )
  }
  const authority = rule.domains.find(domain => isAuthorityGrounded(domain, resolved.kinds))!

  const granted = rule.forcedStatus === undefined
    ? grantStatus(claimed, resolved.kinds)
    : { granted: rule.forcedStatus, downgraded: claimed !== rule.forcedStatus }
  // A status the evidence cannot support is refused only when it would also
  // contradict the domain: `verified` on a normative claim has no meaning, and
  // silently downgrading it to `claimed` would hide the attempt.
  if (authority === 'normative' && (claimed === 'observed' || claimed === 'verified')) {
    return refuse(
      'status-unsupported',
      `a normative ${kind} is asserted, not observed; ${claimed} is not a status a user message can carry`,
    )
  }

  const verification = verifyClaim({
    claimed,
    granted: granted.granted,
    statement,
    verificationQuote: proposal.verificationQuote,
    evidence: resolved.evidence,
    citable,
  })
  if ('detail' in verification) return refuse('verification-unscoped', verification.detail)

  const scope = normalizeScope(proposal.scope)
  const deltaId = deltaIdentity({
    kind,
    subjectKey,
    statement,
    status: granted.granted,
    evidenceSeqs: resolved.evidence.map(entry => entry.seq),
    ...(scope === undefined ? {} : { scope }),
  })
  return {
    index,
    deltaId,
    kind,
    subjectKey,
    statement,
    status: claimed,
    grantedStatus: granted.granted,
    evidence: resolved.evidence,
    authority,
    anchorKind: rule.anchorKind,
    stateKey: rule.anchorKind === undefined ? undefined : semanticStateKey(kind, subjectKey, scope),
    ...(rule.failureState === undefined ? {} : { failureState: rule.failureState }),
    supersedes: stringList(proposal.supersedes),
    dependsOn: stringList(proposal.dependsOn),
    rulesOut: stringList(proposal.rulesOut),
    ...(verification.verifiedBy === undefined ? {} : { verifiedBy: verification.verifiedBy }),
    ...(scope === undefined ? {} : { scope }),
    ...(granted.downgraded ? { downgradedFrom: claimed } : {}),
  }
}

/** Describe the producers behind resolved evidence, for a refusal message. */
function describeProducers(
  citable: readonly CitableMessage[],
  evidence: readonly { seq: number }[],
): string {
  const bySeq = new Map(citable.map(entry => [entry.seq, entry]))
  const producers = evidence.map(entry => {
    const message = bySeq.get(entry.seq)?.message
    return message === undefined ? `seq ${entry.seq}` : `${message.role}/${message.source.kind}`
  })
  return producers.length === 0 ? '' : ` (sources: ${producers.join(', ')})`
}

/**
 * Render a rejected approach so the negative knowledge is readable in the
 * checkpoint: the approach AND what it was ruled out for. A statement that only
 * says "we rejected Redis" invites re-adoption; the reason is the retrieval cue.
 *
 * @param statement - the writer's claim.
 * @param rulesOut - the coordinates the rejection rules out.
 * @returns the anchor value.
 */
export function rejectedApproachValue(statement: string, rulesOut: readonly string[]): string {
  return rulesOut.length === 0
    ? `rejected: ${statement}`
    : `rejected: ${statement} (rules out: ${rulesOut.join(', ')})`
}
