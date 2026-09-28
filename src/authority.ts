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

/** Human-readable authority rule for diagnostics and checkpoint rendering. */
export const AUTHORITY_RULES: ReadonlyArray<{ readonly domain: AuthorityDomain; readonly source: string }> = [
  { domain: 'normative', source: 'user/system explicit constraint' },
  { domain: 'empirical', source: 'tool/test/filesystem evidence' },
  { domain: 'procedural', source: 'execution lifecycle' },
  { domain: 'decision', source: 'adopted solution' },
  { domain: 'narrative', source: 'semantic digest (never authoritative)' },
  { domain: 'hypothesis', source: 'tentative model reasoning' },
]
