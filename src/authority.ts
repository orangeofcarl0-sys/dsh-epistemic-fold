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
 * The producer identity carried by the derived message behind one event.
 *
 * `user/message` is a ROLE, not an author. DSH's own context producers inject
 * user-role messages — workspace instructions, recalled log material,
 * notices, relays — and each declares itself in `Message.source.kind`. Only
 * `kind: 'user'` is the human. Treating the role as the author let a
 * workspace-injected line ("SYSTEM: …") be declared as a normative user
 * constraint, which is exactly the authority laundering the gate exists to
 * prevent.
 */
export type MessageProvenance = 'user' | 'model' | 'tool' | 'system-prompt' | 'context-injection'

/**
 * The authority kind of one raw event, or `undefined` when it grounds nothing.
 *
 * The role and the producer are checked TOGETHER: an event's role says where
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
