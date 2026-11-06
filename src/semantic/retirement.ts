/**
 * Retirement authorization: who may take an anchor out of hot state.
 *
 * ## The distinction this module exists to enforce
 *
 * `validate.ts` answers "may this CLAIM be recorded?". That is not the same
 * question as "may this claim RETIRE that anchor?". A tool result can ground a
 * perfectly good `finding` while having no standing whatsoever to revoke a
 * user's constraint. Collapsing the two — "the delta was accepted, therefore
 * every target it names may be retired" — is the hole this module closes.
 *
 * ## Why a rank, and not a status comparison
 *
 * `EpistemicStatus` (`verified` > `observed` > …) measures how well a claim is
 * EVIDENCED. It says nothing about normative standing: a `verified` tool
 * observation is still an observation, and cannot revoke a `claimed` user
 * constraint. The rank below is over `AuthorityDomain`, which is derived from
 * the PRODUCER of the cited events, and it is deliberately coarse:
 *
 *   normative  the user or the system stated a requirement
 *   decision   a decision was taken (user or assistant)
 *   procedural a tool documented a procedure
 *   empirical  a tool observed a fact
 *   hypothesis an assistant speculated
 *   narrative  derived summary text; never an authority root
 *
 * `procedural` and `empirical` share a rank: both are tool-produced, and one
 * does not outrank the other. `decision` outranks both because a decision may
 * legitimately set aside an observation ("ignore the stale probe"). `normative`
 * outranks `decision` because only a normative source may revoke a requirement.
 *
 * ## Scope is a second, independent gate
 *
 * Even a normative claim may not reach across task scopes by naming another
 * scope's anchor id. Scope equality is required for any cross-coordinate
 * retirement; a same-coordinate replacement is already scope-bound by the
 * coordinate itself.
 *
 * @module dsh-epistemic-fold/semantic/retirement
 */

import type { AuthorityDomain } from '../state/authority.ts'

/**
 * How much retirement standing each authority domain carries.
 *
 * The numbers are ordinal, not weights: only their order is meaningful.
 */
export const RETIREMENT_POWER: Record<AuthorityDomain, number> = {
  normative: 5,
  decision: 4,
  procedural: 3,
  empirical: 3,
  hypothesis: 1,
  narrative: 0,
}

/** Why a retirement was refused. Machine-readable, recorded in the packet. */
export type RetirementRefusalReason =
  | 'declaring-narrative'
  | 'target-narrative'
  | 'insufficient-authority'
  | 'cross-scope'

/** The verdict for one (declaring claim, target anchor) pair. */
export type RetirementAuthorization =
  | { readonly allowed: true }
  | {
    readonly allowed: false
    readonly reason: RetirementRefusalReason
    readonly detail: string
  }

/**
 * Decide whether one accepted claim may retire one existing anchor.
 *
 * @param input.declaring - authority domain the declaring claim was granted.
 * @param input.target - authority domain recorded on the target anchor.
 * @param input.sameScope - whether the two anchors occupy the same task scope.
 * @returns whether the retirement is authorized, and why not when it is not.
 */
export function mayRetire(input: {
  readonly declaring: AuthorityDomain
  readonly target: AuthorityDomain
  readonly sameScope: boolean
}): RetirementAuthorization {
  if (input.declaring === 'narrative') {
    return {
      allowed: false,
      reason: 'declaring-narrative',
      detail: 'derived narrative cannot retire state',
    }
  }
  if (input.target === 'narrative') {
    return {
      allowed: false,
      reason: 'target-narrative',
      detail: 'a narrative anchor is not a state value that can be retired',
    }
  }
  if (!input.sameScope) {
    return {
      allowed: false,
      reason: 'cross-scope',
      detail: 'a retirement may not cross task scopes; restate the claim in the target scope',
    }
  }
  const declaringPower = RETIREMENT_POWER[input.declaring]
  const targetPower = RETIREMENT_POWER[input.target]
  if (declaringPower < targetPower) {
    return {
      allowed: false,
      reason: 'insufficient-authority',
      detail: `a ${input.declaring} claim may not retire a ${input.target} anchor`,
    }
  }
  return { allowed: true }
}
