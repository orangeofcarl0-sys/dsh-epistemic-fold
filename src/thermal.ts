/**
 * The Thermal Working-Set Observer's residency half: a conservative, provable
 * statement about whether a piece of state is still being WORKED WITH.
 *
 * ## What this is not
 *
 * Residency is not lifecycle, and it is not a deletion authority. Three
 * confusions this module is built to avoid:
 *
 *  1. **Age is not idleness.** "Long unused" does not mean "invalid", and it
 *     certainly does not mean "safe to delete". A constraint stated in turn 2
 *     and never mentioned again is *the normal case* for a constraint, not
 *     evidence against it. So no amount of elapsed work can on its own produce
 *     `cold`: time can raise a classification to `warm` and no further.
 *  2. **Residency is not lifecycle.** Lifecycle (`active` / `superseded` /
 *     `retired`) is a record of explicit operations. Residency is a derived
 *     observation about demand. They are reported SIDE BY SIDE and neither
 *     determines the other — a `superseded` anchor is still carried with its own
 *     residency, and an `active` anchor is not thereby `hot`.
 *  3. **State is not complete.** The deterministic reducer only produces anchors
 *     from explicit `ef/anchor` operations and failed tool results. Ordinary
 *     long-task conversation does NOT arrive as anchors, so most of what a model
 *     knows is not represented here at all. This module therefore says nothing
 *     about content it cannot see, and `unknown` is its answer for anything it
 *     cannot establish — never a guess, and never a default of "cold".
 *
 * ## What it is allowed to use
 *
 * Only signals that are provable from committed events:
 *
 *   signal                        read from
 *   ------                        ---------
 *   anchor identity/lifecycle     the deterministic projection state
 *   continuing authority          the anchor's own kind and authority domain
 *   membership in the fold span   the current legal leaf span (surface positions)
 *   explicit retrieval demand     `tool/call` names for the recall/search tools
 *   content already archived      `compaction/summary`.shadowedSeqs
 *
 * Notably ABSENT: any embedding, any semantic similarity, any LLM call, and any
 * decay curve. A residency that needed a model call to compute could not be
 * deterministic, and one that used a decay curve would be exactly the
 * age-equals-idleness inference rule (1) forbids.
 *
 * @module dsh-epistemic-fold/thermal
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { FoldCurrentState } from './state.ts'
import type { Anchor } from './state.ts'
import type { AuthorityDomain } from './authority.ts'
import { toolCallName } from './event-data.ts'

/**
 * How much the current working set still needs a piece of state.
 *
 * `pinned`   — holds continuing authority; never demoted by this module.
 * `hot`      — positive evidence of demand (in the fold span, or just retrieved).
 * `warm`     — active, no demand evidence. Where age lands, and its floor.
 * `cold`     — positive evidence it has LEFT the working set: an explicit
 *              supersession/retirement operation, with no demand since.
 * `unknown`  — no basis. Not a synonym for cold.
 */
export type Residency = 'pinned' | 'hot' | 'warm' | 'cold' | 'unknown'

/** One anchor's residency, with the evidence that produced it. */
export interface ResidencyVerdict {
  readonly anchorId: string
  readonly residency: Residency
  /** The anchor's lifecycle, reported independently of `residency`. */
  readonly lifecycle: Anchor['lifecycle']
  readonly authority: AuthorityDomain
  /** Every signal that bore on the verdict, so it can be checked. */
  readonly evidence: readonly string[]
}

/** Why a state carries no verdict at all. */
export type ThermalUnavailable = 'no-state-mounted'

/** The observer's full thermal reading. */
export interface ThermalReport {
  readonly verdicts: readonly ResidencyVerdict[]
  /** `unknown` for every anchor this reading could not classify. */
  readonly unknownCount: number
  /**
   * Set when no deterministic state was available, so a reader can tell "no
   * anchors exist" from "the state could not be read". Both would otherwise
   * present as an empty verdict list.
   */
  readonly unavailable?: ThermalUnavailable
  /** The window, in events, over which retrieval demand was counted. */
  readonly demandWindowEvents: number
}

/** Options for {@link assessThermalResidency}. */
export interface AssessThermalOptions {
  readonly session: Session
  /** The deterministic state; absent means the projection is not mounted. */
  readonly state?: FoldCurrentState
  /**
   * Surface positions the next leaf fold would cover. An anchor whose source
   * event lies inside this range is being actively worked with.
   */
  readonly leafSpan?: { readonly startIdx: number; readonly endIdx: number }
  /**
   * How far back to look for retrieval demand. Bounded deliberately: an
   * unbounded scan would make the reading's cost grow with the session, and a
   * "recently" that means "ever" is not a recency signal.
   */
  readonly demandWindowEvents?: number
}

/**
 * Default retrieval-demand window, in events.
 *
 * 200 is a compromise with no measurement behind it, and it is stated as such:
 * it is large enough to span a working episode and small enough that the scan is
 * bounded. It is a PARAMETER, not a finding — a deployment that wants a
 * different notion of "recently" sets it, and nothing in the policy depends on
 * this value.
 */
export const DEFAULT_DEMAND_WINDOW_EVENTS = 200

/** The tool names that constitute explicit retrieval demand. */
const RETRIEVAL_TOOLS: ReadonlySet<string> = new Set(['context_recall', 'context_search'])

/**
 * Kinds whose anchors carry continuing authority over future action.
 *
 * An objective, a constraint and an open obligation all constrain what may
 * happen NEXT, which is why they are pinned rather than aged. A `value` or an
 * `artifact` describes something that exists; a decision records something that
 * was settled. Those can cool. These three cannot, and the distinction is the
 * whole reason `pinned` exists as a separate class.
 */
const PINNED_KINDS: ReadonlySet<Anchor['kind']> = new Set(['objective', 'constraint', 'obligation'])

/** Authority domains that constrain future action regardless of recency. */
const PINNED_AUTHORITIES: ReadonlySet<AuthorityDomain> = new Set(['normative', 'procedural'])

/**
 * Whether an anchor holds continuing authority, and therefore can never be
 * demoted by this module.
 *
 * Three tests, and none subsumes another:
 *
 *  - an obligation declared from a tool result is `empirical` authority but
 *    still binds future action;
 *  - a procedural value is not an obligation but still governs how work is done;
 *  - an **open failure** is neither of those by kind alone, and it is the
 *    clearest case of all: an unresolved defect is outstanding work, so it is
 *    pinned while it is open. Only once it has been `resolved` or `verified` does
 *    it stop constraining what happens next — and `verified` already leaves hot
 *    state through the reducer, so the two agree.
 */
function isPinned(anchor: Anchor): boolean {
  if (anchor.lifecycle !== 'active') return false
  if (PINNED_KINDS.has(anchor.kind) || PINNED_AUTHORITIES.has(anchor.authority)) return true
  return anchor.kind === 'failure' && anchor.failureState === 'open'
}

/**
 * How advanced a failure's lifecycle is, so the most-advanced copy wins.
 *
 * ## Why this is needed at all
 *
 * The reducer's `transitionFailure` updates `openFailures` but does NOT update
 * the `stateHeads` entry for the same anchor, so after a transition the SAME
 * anchor is present twice with different `failureState` values — verified: a
 * resolved failure reads `failure:c1:resolved` from `openFailures` and
 * `failure:c1:open` from `stateHeads`.
 *
 * A reader that deduplicates by id therefore has to decide WHICH copy to keep,
 * and taking the first is a real defect: it reported a resolved failure as
 * `pinned`, i.e. as outstanding work. Since residency must reflect the anchor's
 * actual lifecycle, the most advanced state wins.
 */
const FAILURE_STATE_RANK: Readonly<Record<string, number>> = {
  open: 0,
  investigating: 1,
  resolved: 2,
  verified: 3,
}

/**
 * Every anchor the state holds, deduplicated by id, keeping the MOST ADVANCED
 * copy of any anchor that appears in more than one face.
 */
function anchorsOf(state: FoldCurrentState): readonly Anchor[] {
  const byId = new Map<string, Anchor>()
  const take = (anchor: Anchor | undefined): void => {
    if (anchor === undefined) return
    const existing = byId.get(anchor.id)
    if (existing === undefined) {
      byId.set(anchor.id, anchor)
      return
    }
    // Same anchor, two faces: keep the one further along its lifecycle.
    const existingRank = FAILURE_STATE_RANK[existing.failureState ?? ''] ?? -1
    const incomingRank = FAILURE_STATE_RANK[anchor.failureState ?? ''] ?? -1
    if (incomingRank > existingRank) byId.set(anchor.id, anchor)
  }
  // The objective is taken LAST among equals so a face entry — which is where a
  // transition writes — is never displaced by an equal-ranked head.
  take(state.objective)
  for (const face of [
    state.constraints,
    state.stateHeads,
    state.openFailures,
    state.openObligations,
    state.decisions,
    state.evidence,
  ]) {
    for (const anchor of Object.values(face)) take(anchor)
  }
  // Sorted so the report is byte-stable across runs and across a Map's
  // insertion order, which is what makes it comparable between two readings.
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * Surface positions of the retrieval tool calls within the demand window, and
 * whether any retrieval happened at all.
 *
 * Only the CALLS are read, never their results: a recall that returned nothing
 * is still an expression of demand — the model asked — and reading results would
 * require parsing tool output, which is exactly the raw-content access this
 * observer must not do.
 */
function recentRetrievalCount(session: Session, window: number): number {
  let count = 0
  const floor = Math.max(0, session.seq - window)
  for (let seq = floor; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq as never)
    if (event === undefined || event.type !== 'tool/call') continue
    const name = toolCallName(event)
    if (name !== undefined && RETRIEVAL_TOOLS.has(name)) count += 1
  }
  return count
}

/**
 * The surface positions covered by anchors' source events, so membership in the
 * fold span can be decided without re-deriving each anchor's provenance.
 */
function anchorPositions(
  session: Session,
  anchor: Anchor,
): readonly number[] {
  const positions: number[] = []
  for (const ref of anchor.sourceRefs) {
    // A cross-session ref cannot be a position on THIS surface.
    if (ref.sessionId !== undefined && ref.sessionId !== session.id) continue
    const position = session.surface.nodes.indexOf(ref.seq)
    if (position !== -1) positions.push(position)
  }
  return positions
}

/**
 * Classify the residency of every anchor the deterministic state holds.
 *
 * The classification is deliberately coarse and one-directional: demand evidence
 * can raise a verdict, an explicit lifecycle operation can lower it, and elapsed
 * work can do neither beyond `warm`. See the module note for why.
 *
 * @param options - session, the deterministic state, and the current fold span.
 * @returns one verdict per anchor, each carrying the evidence behind it.
 */
export function assessThermalResidency(options: AssessThermalOptions): ThermalReport {
  const { session, state, leafSpan } = options
  const demandWindowEvents = options.demandWindowEvents ?? DEFAULT_DEMAND_WINDOW_EVENTS
  if (state === undefined) {
    return { verdicts: [], unknownCount: 0, unavailable: 'no-state-mounted', demandWindowEvents }
  }
  const retrievals = recentRetrievalCount(session, demandWindowEvents)
  const verdicts: ResidencyVerdict[] = []
  let unknownCount = 0

  for (const anchor of anchorsOf(state)) {
    const evidence: string[] = []
    const positions = anchorPositions(session, anchor)

    // (1) Continuing authority wins over everything, including age.
    if (isPinned(anchor)) {
      evidence.push(
        `active ${anchor.kind} with ${anchor.authority} authority: constrains future action, `
        + 'so it is never demoted by elapsed work',
      )
      verdicts.push({
        anchorId: anchor.id,
        residency: 'pinned',
        lifecycle: anchor.lifecycle,
        authority: anchor.authority,
        evidence,
      })
      continue
    }

    // (2) Positive demand: the anchor's content is inside the span the next fold
    // would take. That is the working region, provably, from the surface itself.
    const inSpan = leafSpan !== undefined
      && positions.some(position => position >= leafSpan.startIdx && position <= leafSpan.endIdx)
    if (inSpan) {
      evidence.push('source event lies inside the current legal fold span (the working region)')
      verdicts.push({
        anchorId: anchor.id,
        residency: 'hot',
        lifecycle: anchor.lifecycle,
        authority: anchor.authority,
        evidence,
      })
      continue
    }

    // (3) Explicit lifecycle: an operation took this out of hot state. This is
    // the ONLY route to `cold`, and it is a recorded act rather than an
    // inference from silence.
    if (anchor.lifecycle !== 'active') {
      if (retrievals > 0) {
        // A non-active anchor beside live retrieval is worth naming: either the
        // retrieval concerned something else, or something is being consulted
        // after it was retired. The verdict stays conservative.
        evidence.push(
          `lifecycle is "${anchor.lifecycle}" (an explicit operation removed it from hot state)`,
          `${retrievals} retrieval call(s) in the last ${demandWindowEvents} events, `
          + 'but none is attributable to this anchor from the log alone',
        )
      } else {
        evidence.push(
          `lifecycle is "${anchor.lifecycle}": an explicit supersession/retirement removed it, `
          + 'and no retrieval was recorded in the window',
        )
      }
      verdicts.push({
        anchorId: anchor.id,
        residency: 'cold',
        lifecycle: anchor.lifecycle,
        authority: anchor.authority,
        evidence,
      })
      continue
    }

    // (4) Active with no source event on the surface. The anchor's provenance
    // does not resolve to a current position, so there is nothing to reason
    // about — and guessing would be the exact failure this module exists to
    // prevent.
    if (positions.length === 0) {
      unknownCount += 1
      evidence.push(
        anchor.sourceRefs.length === 0
          ? 'the anchor cites no source events, so no surface position can be derived'
          : 'none of the anchor\'s cited source events is present on the current surface',
      )
      verdicts.push({
        anchorId: anchor.id,
        residency: 'unknown',
        lifecycle: anchor.lifecycle,
        authority: anchor.authority,
        evidence,
      })
      continue
    }

    // (5) Active, on the surface, outside the fold span, with no demand evidence.
    // This is where age lands, and it stops here.
    evidence.push(
      'active and present on the surface but outside the current fold span',
      'no retrieval demand recorded in the window; elapsed work alone cannot lower this '
      + 'below "warm"',
    )
    verdicts.push({
      anchorId: anchor.id,
      residency: 'warm',
      lifecycle: anchor.lifecycle,
      authority: anchor.authority,
      evidence,
    })
  }

  return { verdicts, unknownCount, demandWindowEvents }
}

/** Count the verdicts in one residency class. */
export function residencyCounts(report: ThermalReport): Readonly<Record<Residency, number>> {
  const counts: Record<Residency, number> = { pinned: 0, hot: 0, warm: 0, cold: 0, unknown: 0 }
  for (const verdict of report.verdicts) counts[verdict.residency] += 1
  return counts
}

/**
 * Render one thermal reading as a line, so a report can carry the counts without
 * a reader having to recompute them from the verdict list.
 */
export function describeThermal(report: ThermalReport): string {
  if (report.unavailable !== undefined) {
    return `thermal residency unavailable (${report.unavailable}): no deterministic state was mounted`
  }
  const counts = residencyCounts(report)
  return [
    `${report.verdicts.length} anchor(s)`,
    `pinned ${counts.pinned}`,
    `hot ${counts.hot}`,
    `warm ${counts.warm}`,
    `cold ${counts.cold}`,
    `unknown ${counts.unknown}`,
    `demand window ${report.demandWindowEvents} events`,
  ].join('; ')
}
