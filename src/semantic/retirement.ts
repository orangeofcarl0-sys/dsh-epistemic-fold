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

import { canonicalHash } from '../checkpoint/hash.ts'
import type { AuthorityDomain, SourceAuthority } from '../state/authority.ts'

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
  | 'insufficient-source-authority'
  | 'stale-source'
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
  /** Who produced the declaring claim; absent means historical/unknown. */
  readonly declaringSource?: SourceAuthority
  /** Who produced the target anchor; absent means historical/unknown. */
  readonly targetSource?: SourceAuthority
  /**
   * The newest decision-capable message the declaring claim cites.
   *
   * A revision must rest on evidence NEWER than the decision it replaces.
   * Without this, an assistant could quote the user's ORIGINAL instruction and
   * use that quote as standing to write the opposite decision: the quote is
   * genuinely the user's, so the source check passes, while the user never
   * said the new thing. Absent on callers that do not track span positions
   * (audits over already-committed packets); the planner always supplies it.
   */
  readonly declaringLatestSeq?: number
  /** The newest event behind the target anchor. */
  readonly targetLatestSeq?: number
  /**
   * The value the declaring claim would write, and the target's current value.
   *
   * Equal values are the one exception to the newer-evidence rule: restating
   * the SAME decision at another coordinate is a consolidation, not a
   * revision, and cannot change what the user decided. An opposite claim never
   * qualifies.
   */
  readonly declaringValue?: unknown
  readonly targetValue?: unknown
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
  // SOURCE, not rank. `decision` is grounded by both a user message and an
  // assistant message, so the domain alone cannot tell a user's decision from
  // the assistant's own. Without this check an assistant could retire the
  // user's decision at the same coordinate (where no rank check used to run)
  // or by naming it explicitly (where the ranks are equal).
  //
  // `unknown` is a HISTORICAL anchor: it was written before the producer was
  // recorded. New writes are conservative and refuse the retirement; a user
  // decision may still revise it. Historical replay never re-runs this check,
  // so an old journal keeps its recorded outcome.
  const declaringSource = input.declaringSource ?? 'unknown'
  const targetSource = input.targetSource ?? 'unknown'
  if (input.declaring === 'decision' && input.target === 'decision'
    && declaringSource === 'assistant' && targetSource !== 'assistant') {
    return {
      allowed: false,
      reason: 'insufficient-source-authority',
      detail: `an assistant-origin decision may not retire a decision whose source is ${targetSource}; `
        + 'the user must revise it, or the assistant must propose it as a new claim in another coordinate',
    }
  }
  // NEWER evidence, not merely relevant evidence. A quote from the message that
  // established the current decision cannot also authorize its replacement: if
  // it could, quoting the user's original instruction would be enough for the
  // assistant to write the opposite decision and label it user-sourced.
  //
  // Both seqs are supplied by the planner from the fold span and the target
  // anchor's provenance. Historical replay never reaches this function, and an
  // audit that lacks the positions passes `undefined` rather than inventing
  // one.
  const restatesSameValue = input.declaringValue !== undefined
    && input.targetValue !== undefined
    && canonicalHash(input.declaringValue) === canonicalHash(input.targetValue)
  if (input.declaring === 'decision' && input.target === 'decision'
    && input.declaringLatestSeq !== undefined && input.targetLatestSeq !== undefined
    && input.declaringLatestSeq <= input.targetLatestSeq && !restatesSameValue) {
    return {
      allowed: false,
      reason: 'stale-source',
      detail: `the newest decision evidence (seq ${input.declaringLatestSeq}) is not newer than `
        + `the decision it would revise (seq ${input.targetLatestSeq}); a revision needs a newer statement`,
    }
  }
  return { allowed: true }
}
