/**
 * Commit planning: turn validated deltas into the exact, ordered anchor
 * operations that a committed fold applies.
 *
 * ## Why the plan is resolved BEFORE the commit and stored in the packet
 *
 * Supersession needs an oracle: "what is the current value at this coordinate?"
 * The bounded `FoldCurrentState` cannot answer that, because it keeps only one
 * superseded entry per coordinate and the anchors it drops are gone from hot
 * state. Using it as the oracle is what let a twice-superseded value revive
 * after a restart: the middle revision was no longer visible, so the third
 * packet resolved `previous` to the first revision.
 *
 * The oracle here is the PROJECTED state: the session-derived state plus every
 * committed semantic packet, folded in source order. That is complete history
 * expressed as current values. The resolution is then recorded in the packet,
 * so replay never needs an oracle at all.
 *
 * ## The two-phase rule
 *
 * Every declare is emitted before every retirement. A retirement executed
 * immediately after its own declare is a no-op when its target is declared
 * later in the same packet, which leaves the replaced value active and visible.
 * Two phases make the outcome independent of proposal order.
 *
 * @module dsh-epistemic-fold/semantic/plan
 */

import type { Anchor, AnchorScope, EfAnchorEventData, FoldCurrentState, StateKey } from '../state/state.ts'
import { stateKeyText } from '../state/state.ts'
import { reduceEvent } from '../state/state.ts'
import { canonicalHash } from '../checkpoint/hash.ts'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { anchorIdOf, rejectedApproachValue } from './validate.ts'
import type { AcceptedDelta } from './types.ts'

/** How one target named by `supersedes` was resolved. */
export interface ResolvedSupersede {
  readonly target: string
  /** The anchor id to retire, when the target named a known coordinate. */
  readonly anchorId?: string
  /** `same-coordinate` needs no retire op: the declare displaces it in place. */
  readonly via: 'same-coordinate' | 'other-coordinate' | 'unknown'
}

/** One accepted delta with its resolved operations. */
export interface PlannedDelta {
  readonly deltaId: string
  /** Absent for `experience-candidate`, which is journaled but never anchored. */
  readonly anchorId?: string
  readonly kind: AcceptedDelta['kind']
  readonly supersedes: readonly ResolvedSupersede[]
  /** Set when the anchor was already present, so the declare was skipped. */
  readonly duplicate?: boolean
}

/** The complete commit plan for one packet. */
export interface CommitPlan {
  readonly ops: readonly EfAnchorEventData[]
  readonly planned: readonly PlannedDelta[]
  /** Targets no state coordinate matched; recorded, never guessed at. */
  readonly unresolvedTargets: readonly string[]
}

/** Every anchor currently visible in any hot face. */
function visibleAnchors(state: FoldCurrentState): readonly Anchor[] {
  return [
    ...(state.objective === undefined ? [] : [state.objective]),
    ...Object.values(state.constraints),
    ...Object.values(state.stateHeads),
    ...Object.values(state.openFailures),
    ...Object.values(state.openObligations),
    ...Object.values(state.decisions),
    ...Object.values(state.evidence),
  ]
}

/** Whether two claims belong to the same task scope (both absent = yes). */
export function sameScope(left: AnchorScope | undefined, right: AnchorScope | undefined): boolean {
  if (left === undefined && right === undefined) return true
  if (left === undefined || right === undefined) return false
  return canonicalHash(left) === canonicalHash(right)
}

/**
 * Find the anchor a target names.
 *
 * Three spellings are accepted because all three are natural in a proposal:
 * the anchor id itself, the exact `stateKeyText`, and the bare `subjectKey`
 * (which is the `property` of a semantic coordinate). The bare subject is
 * matched ONLY among semantic coordinates, so a proposal cannot retire an
 * unrelated user anchor by naming its value.
 *
 * A bare subject is additionally matched only within the PROPOSAL'S scope. Two
 * tasks can name the same `timeout`; letting a repo-A proposal resolve the bare
 * word to repo-B's anchor would retire another task's contract by coincidence.
 * An explicit anchor id or exact stateKeyText is still an explicit reference and
 * is honored regardless of scope.
 */
function findTarget(
  state: FoldCurrentState,
  target: string,
  scope: AnchorScope | undefined,
): Anchor | undefined {
  for (const anchor of visibleAnchors(state)) {
    if (anchor.id === target) return anchor
    if (anchor.stateKey !== undefined && stateKeyText(anchor.stateKey) === target) return anchor
    if (anchor.stateKey?.namespace === 'semantic'
      && anchor.stateKey.property === target
      && sameScope(anchor.scope, scope)) return anchor
  }
  return undefined
}

/** The anchor that currently occupies one coordinate, if any. */
function headAt(state: FoldCurrentState, key: StateKey): Anchor | undefined {
  return state.stateHeads[stateKeyText(key)]
}

/** Options for {@link planCommit}. */
export interface PlanCommitOptions {
  /** State AFTER every previously committed packet, BEFORE this one. */
  readonly state: FoldCurrentState
  /** Anchor ids already present in the projected state. */
  readonly knownAnchorIds?: ReadonlySet<string>
}

/**
 * Resolve one packet's accepted deltas into ordered operations.
 *
 * @param accepted - deltas that passed validation.
 * @param options - the projected state the plan resolves against.
 * @returns the operations plus a per-delta audit of how supersession resolved.
 */
export function planCommit(
  accepted: readonly AcceptedDelta[],
  options: PlanCommitOptions,
): CommitPlan {
  const known = options.knownAnchorIds ?? new Set(visibleAnchors(options.state).map(anchor => anchor.id))
  const declares: EfAnchorEventData[] = []
  const transitions: EfAnchorEventData[] = []
  const retires: EfAnchorEventData[] = []
  const planned: PlannedDelta[] = []
  const unresolvedTargets = new Set<string>()

  // Declares and their same-packet supersession targets are resolved in one
  // pass so a forward reference (`this replaces the delta below`) is known.
  for (const delta of accepted) {
    if (delta.anchorKind === undefined || delta.stateKey === undefined) {
      // `experience-candidate`: journaled, never anchored. It has no plan entry
      // by design; its absence from `ops` is the enforcement of that rule.
      planned.push({
        deltaId: delta.deltaId,
        kind: delta.kind,
        supersedes: [],
      })
      continue
    }
    const stateKey = delta.stateKey
    const anchorId = anchorIdOf(delta.deltaId)
    const resolved: ResolvedSupersede[] = []
    const supersededHere = new Set<string>()

    for (const target of delta.supersedes) {
      if (target === 'previous') {
        const head = headAt(options.state, stateKey)
        resolved.push({
          target,
          ...(head === undefined ? {} : { anchorId: head.id }),
          via: 'same-coordinate',
        })
        continue
      }
      const sibling = accepted.find(candidate =>
        // A bare target may equal the declaring delta's own subject. That is a
        // reference to the EXISTING value at this coordinate, not a request to
        // retire the claim being made: including the delta itself made
        // `supersedes: ['timeout']` retire its own freshly declared anchor.
        candidate.deltaId !== delta.deltaId
        && candidate.stateKey !== undefined && candidate.subjectKey === target
        && candidate.stateKey.namespace === stateKey.namespace
        && sameScope(candidate.scope, delta.scope))
      if (sibling !== undefined) {
        const siblingId = anchorIdOf(sibling.deltaId)
        resolved.push({ target, anchorId: siblingId, via: 'other-coordinate' })
        supersededHere.add(siblingId)
        continue
      }
      const found = findTarget(options.state, target, delta.scope)
      if (found === undefined) {
        unresolvedTargets.add(target)
        resolved.push({ target, via: 'unknown' })
        continue
      }
      if (found.stateKey !== undefined && stateKeyText(found.stateKey) === stateKeyText(stateKey)) {
        resolved.push({ target, anchorId: found.id, via: 'same-coordinate' })
      } else {
        resolved.push({ target, anchorId: found.id, via: 'other-coordinate' })
      }
    }

    if (known.has(anchorId)) {
      planned.push({ deltaId: delta.deltaId, anchorId, kind: delta.kind, supersedes: resolved, duplicate: true })
      continue
    }

    const value = delta.kind === 'rejected-approach'
      ? rejectedApproachValue(delta.statement, delta.rulesOut)
      : delta.statement
    const anchor: Anchor = {
      id: anchorId,
      kind: delta.anchorKind,
      stateKey,
      value,
      authority: delta.authority,
      lifecycle: 'active',
      ...(delta.failureState === undefined ? {} : { failureState: delta.failureState }),
      sourceRefs: delta.evidence.map(entry => ({ seq: SessionSeq(entry.seq) })),
      ...(delta.scope === undefined ? {} : { scope: delta.scope }),
    }
    declares.push({ op: 'declare', anchor })
    if (delta.kind === 'failure' && delta.grantedStatus === 'verified' && delta.evidence.length > 0) {
      transitions.push({
        op: 'transition',
        anchorId,
        failureState: 'verified',
        evidenceRefs: delta.evidence.map(entry => ({ seq: SessionSeq(entry.seq) })),
      })
    }
    for (const id of supersededHere) {
      // The declare for the sibling may come later; a retire op is still
      // correct because retires run after every declare.
      retires.push({ op: 'retire', anchorId: id })
    }
    planned.push({ deltaId: delta.deltaId, anchorId, kind: delta.kind, supersedes: resolved })
  }

  // Explicit cross-coordinate retirements. A `same-coordinate` target needs no
  // retire: the declare replaced it in place and the reducer recorded the
  // supersession link. Retiring it again would double-count `retiredCount` and
  // remove the link from hot state twice.
  for (const entry of planned) {
    for (const target of entry.supersedes) {
      if (target.via === 'other-coordinate' && target.anchorId !== undefined) {
        retires.push({ op: 'retire', anchorId: target.anchorId })
      }
    }
  }

  return {
    ops: [...declares, ...transitions, ...dedupeRetires(retires)],
    planned,
    unresolvedTargets: [...unresolvedTargets],
  }
}

/** One retire per target: a forward reference and an explicit one may agree. */
function dedupeRetires(retires: readonly EfAnchorEventData[]): readonly EfAnchorEventData[] {
  const seen = new Set<string>()
  const out: EfAnchorEventData[] = []
  for (const op of retires) {
    const id = op.anchorId
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    out.push(op)
  }
  return out
}

/**
 * Apply a plan to a state with the SAME reducer the projection uses.
 *
 * This is the candidate view: a pure projection used to render the checkpoint
 * before the fold commits. If the fold fails, nothing was written; if it
 * commits, replaying the recorded ops from the same base yields this state.
 *
 * @param state - the projected state before the packet.
 * @param ops - the packet's resolved operations.
 * @returns the state the checkpoint will describe.
 */
export function applyOps(state: FoldCurrentState, ops: readonly EfAnchorEventData[]): FoldCurrentState {
  return ops.reduce(
    (next, op, index) => reduceEvent(next, { type: 'ef/anchor', seq: index, data: op }),
    state,
  )
}
