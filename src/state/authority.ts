/**
 * The authority model: which raw-event kinds may ground which authority
 * domains, and the hard rule that narrative can never verify state
 * (RFC-001 §5.4, I3, plan §20).
 *
 * @module dsh-epistemic-fold/authority
 */


/** Epistemic authority domains (RFC §5.4); there is no cross-domain score. */
export type AuthorityDomain =
  | 'normative'
  | 'empirical'
  | 'procedural'
  | 'decision'
  | 'narrative'
  | 'hypothesis'

/** Raw session-event kinds that may carry authoritative weight. */
export type AuthoritativeEventKind =
  | 'user/message'
  | 'system/message'
  | 'tool/result'
  | 'assistant/message'

/**
 * WHO produced a claim, as distinct from what KIND of claim it is.
 *
 * The domain says a `decision` was taken. It does not say whether the user took
 * it or the assistant proposed it, and those are not the same standing: an
 * assistant suggestion must not retire a decision the user made. Historical
 * anchors written before this field existed carry `unknown`, which is treated
 * conservatively on NEW retirements.
 */
export type SourceAuthority = 'user' | 'system' | 'tool' | 'assistant' | 'unknown'

/** Every admitted source authority, for runtime validation. */
export const SOURCE_AUTHORITIES: readonly SourceAuthority[] = [
  'user', 'system', 'tool', 'assistant', 'unknown',
]

const SOURCE_RANK: Record<SourceAuthority, number> = {
  user: 4,
  system: 3,
  tool: 2,
  assistant: 1,
  unknown: 0,
}

/**
 * The strongest producer behind a set of cited raw events.
 *
 * A claim that cites both a user message and an assistant message is
 * user-sourced: the normative statement is the user's, and the assistant's
 * restatement does not weaken it.
 */
export function sourceAuthorityOf(kinds: readonly AuthoritativeEventKind[]): SourceAuthority {
  let best: SourceAuthority = 'unknown'
  for (const kind of kinds) {
    const source: SourceAuthority = kind === 'user/message'
      ? 'user'
      : kind === 'system/message'
        ? 'system'
        : kind === 'tool/result'
          ? 'tool'
          : 'assistant'
    if (SOURCE_RANK[source] > SOURCE_RANK[best]) best = source
  }
  return best
}

/**
 * WHO took a DECISION, as distinct from who supplied supporting evidence.
 *
 * A decision claim may cite a tool result as well as the message where the
 * decision was taken. `sourceAuthorityOf` would report `tool` there, because
 * the tool result outranks assistant prose, and a tool producer has no standing
 * to revise a user's decision — yet the elevated label let exactly that
 * through. Only a decision-capable producer (the user or the assistant) can be
 * the ORIGIN of a decision; tool and system evidence is support, never origin.
 *
 * The result is deliberately the strongest decision-capable producer, not the
 * lowest: a claim that quotes both the user's instruction and the assistant's
 * restatement is user-sourced.
 *
 * @param kinds - raw kinds of the cited evidence.
 * @returns the decision origin, or `unknown` when no cited message could take a decision.
 */
export function decisionSourceOf(kinds: readonly AuthoritativeEventKind[]): SourceAuthority {
  let best: SourceAuthority = 'unknown'
  for (const kind of kinds) {
    if (kind === 'user/message') return 'user'
    if (kind === 'assistant/message') best = 'assistant'
  }
  return best
}

/**
 * The producer of a derived message, as far as authority is concerned.
 *
 * A `user/message` is not automatically the human user: DSH injects context,
 * checkpoints, relayed notices and recall results through that role. Only the
 * `user` producer is a normative root.
 */
export type MessageProvenance = 'user' | 'model' | 'tool' | 'system-prompt' | 'context-injection'

/**
 * The authority kind of one raw event, or `undefined` when it grounds nothing.
 *
 * The ROLE and the PRODUCER are checked together: an event's type says where
 * the content appears, its `source.kind` says who produced it, and only the
 * matching pair is an authority root. Everything else — a plugin-written
 * user-role message, a compaction checkpoint, an unknown future producer — is
 * refused rather than trusted by default, because authority is the one thing
 * that must fail closed.
 *
 * @param eventType - the committed session event's type.
 * @param sourceKind - `Message.source.kind` of the derived message, when it has one.
 * @returns the citable authority kind, or `undefined`.
 */
export function authoritativeKindOf(
  eventType: string,
  sourceKind: string | undefined,
): AuthoritativeEventKind | undefined {
  switch (eventType) {
    case 'user/message':
      return sourceKind === 'user' ? 'user/message' : undefined
    case 'system/message':
      return 'system/message'
    case 'assistant/message':
      return 'assistant/message'
    case 'tool/result':
      return 'tool/result'
    default:
      return undefined
  }
}

/**
 * Classify one producer kind for diagnostics.
 * @param eventType - the raw event type.
 * @param sourceKind - the derived message's producer kind.
 * @returns the provenance label, for error messages only.
 */
export function provenanceOf(eventType: string, sourceKind: string | undefined): MessageProvenance {
  if (eventType === 'user/message') {
    if (sourceKind === 'user') return 'user'
    return 'context-injection'
  }
  if (eventType === 'system/message') return 'system-prompt'
  if (eventType === 'tool/result') return 'tool'
  return 'model'
}

/**
 * The domains one raw event kind can ground. `ef/anchor` events are
 * deliberately ABSENT: they are derived records, never raw authority roots —
 * otherwise a derived anchor could cite another derived anchor and launder
 * authority (derived authority must terminate at raw roots, R0-A).
 */
const EVENT_DOMAINS: Record<AuthoritativeEventKind, readonly AuthorityDomain[]> = {
  'user/message': ['normative', 'decision'],
  'system/message': ['normative'],
  'tool/result': ['empirical', 'procedural'],
  'assistant/message': ['hypothesis', 'decision'],
}

/**
 * Domains the event kinds cited by `sourceRefs` may ground. An empty ref set
 * grounds nothing — provenance is mandatory (I2).
 * @param kinds - raw event kinds behind an anchor, in citation order.
 * @returns the union of groundable domains.
 */
export function groundableDomains(kinds: readonly AuthoritativeEventKind[]): readonly AuthorityDomain[] {
  const domains = new Set<AuthorityDomain>()
  for (const kind of kinds) {
    for (const domain of EVENT_DOMAINS[kind] ?? []) {
      domains.add(domain)
    }
  }
  return [...domains]
}

/**
 * Whether an anchor claiming `claimed` authority is backed by its cited
 * sources. `narrative` is never self-grounding: it exists only inside
 * semantic digests, which are structurally outside the reducer.
 */
export function isAuthorityGrounded(claimed: AuthorityDomain, kinds: readonly AuthoritativeEventKind[]): boolean {
  if (claimed === 'narrative') return false
  return groundableDomains(kinds).includes(claimed)
}

/**
 * Evidence Overrides Narrative: a transition into `verified` is legal only
 * when every cited evidence ref is empirical/procedural ground. A semantic
 * summary (or any narrative source) can never drive verification.
 * @param evidenceKinds - raw kinds of the cited evidence events.
 * @returns whether the transition may proceed.
 */
export function canVerify(evidenceKinds: readonly AuthoritativeEventKind[]): boolean {
  if (evidenceKinds.length === 0) return false
  return evidenceKinds.every(kind => {
    const domains = EVENT_DOMAINS[kind] ?? []
    return domains.includes('empirical') || domains.includes('procedural')
  })
}
