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
 * ## Claim acceptance is not retirement authorization
 *
 * `validate.ts` decides whether a CLAIM may be recorded. This module decides
 * whether the claim's relation operations may be applied. A target that exists
 * but outranks the declaring claim keeps its state; the claim is still
 * declared. A target that cannot be resolved withholds the revision entirely,
 * because applying it alone would create a second active value while the value
 * it claimed to replace stayed live.
 *
 * @module dsh-epistemic-fold/semantic/plan
 */

import type { Anchor, AnchorScope, EfAnchorEventData, FoldCurrentState, StateKey } from '../state/state.ts'
import { stateKeyText } from '../state/state.ts'
import { reduceEvent } from '../state/state.ts'
import { canonicalHash } from '../checkpoint/hash.ts'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { anchorIdOf, rejectedApproachValue } from './validate.ts'
import { mayRetire } from './retirement.ts'
import type { RetirementRefusalReason } from './retirement.ts'
import type { AcceptedDelta } from './types.ts'

/** How one target named by `supersedes` was resolved. */
export interface ResolvedSupersede {
  readonly target: string
  /** The anchor id to retire, when the target named a known coordinate. */
  readonly anchorId?: string
  /** `same-coordinate` needs no retire op: the declare displaces it in place. */
  readonly via: 'same-coordinate' | 'other-coordinate' | 'unknown' | 'already-retired' | 'cross-scope' | 'ambiguous'
  /** Set when the target resolved but the declaring claim may not retire it. */
  readonly refusal?: RetirementRefusalReason
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
  /** Set when this proposal repeated an already-planned claim in the same fold. */
  readonly duplicateClaim?: boolean
  /** Set when the delta was accepted by validation but NOT applied. */
  readonly withheld?: WithheldDelta['reason']
}

/** A delta whose revision could not be resolved or authorized, so it was not applied. */
export interface WithheldDelta {
  readonly deltaId: string
  readonly reason: 'unresolved-target' | 'ambiguous-target' | 'unauthorized-replacement'
  readonly targets: readonly string[]
}

/** A target that resolved, but whose retirement the declaring claim may not perform. */
export interface RefusedRetirement {
  readonly deltaId: string
  readonly target: string
  readonly anchorId?: string
  readonly reason: RetirementRefusalReason
}

/** The complete commit plan for one packet. */
export interface CommitPlan {
  readonly ops: readonly EfAnchorEventData[]
  readonly planned: readonly PlannedDelta[]
  /** Targets no state coordinate matched; recorded, never guessed at. */
  readonly unresolvedTargets: readonly string[]
  /** Deltas validation accepted but the plan did not apply. */
  readonly withheld: readonly WithheldDelta[]
  /** Retirements dropped because the declaring authority lacked standing. */
  readonly refusedRetirements: readonly RefusedRetirement[]
  /** Repeated claims whose rendered value differs from the declared anchor's. */
  readonly valueConflicts: readonly { readonly deltaId: string; readonly anchorId: string }[]
}

/** Every anchor currently visible in any hot face. */
export function visibleAnchors(state: FoldCurrentState): readonly Anchor[] {
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

/**
 * Every visible anchor, ONCE.
 *
 * `visibleAnchors` concatenates faces and `stateHeads`, and a constraint or
 * decision is indexed in both. Matching on the raw list made one anchor look
 * like two candidates and turned a precise target into an "ambiguous" one, so
 * every resolution path below uses this de-duplicated view.
 */
function uniqueAnchors(state: FoldCurrentState): readonly Anchor[] {
  const byId = new Map<string, Anchor>()
  for (const anchor of visibleAnchors(state)) {
    if (!byId.has(anchor.id)) byId.set(anchor.id, anchor)
  }
  return [...byId.values()]
}

/** Whether two claims belong to the same task scope (both absent = yes). */
export function sameScope(left: AnchorScope | undefined, right: AnchorScope | undefined): boolean {
  if (left === undefined && right === undefined) return true
  if (left === undefined || right === undefined) return false
  return canonicalHash(left) === canonicalHash(right)
}

/** The anchor that currently occupies one coordinate, if any. */
function headAt(state: FoldCurrentState, key: StateKey): Anchor | undefined {
  return state.stateHeads[stateKeyText(key)]
}

/** The value a delta would write, before it becomes an anchor. */
function renderedValue(delta: AcceptedDelta): unknown {
  return delta.kind === 'rejected-approach'
    ? rejectedApproachValue(delta.statement, delta.rulesOut)
    : delta.statement
}

/** The newest event behind an anchor, or `undefined` when it cites none. */
function latestSeqOf(anchor: Anchor): number | undefined {
  let latest: number | undefined
  for (const ref of anchor.sourceRefs) {
    const seq = Number(ref.seq)
    if (latest === undefined || seq > latest) latest = seq
  }
  return latest
}

/** An optional field, spread-safe under `exactOptionalPropertyTypes`. */
function targetSeqField(latest: number | undefined): { targetLatestSeq?: number } {
  return latest === undefined ? {} : { targetLatestSeq: latest }
}

/** One target's resolution, before authorization is decided. */
type TargetResolution =
  | { readonly kind: 'previous-absent' }
  | { readonly kind: 'already-retired' }
  | { readonly kind: 'resolved'; readonly anchor: Anchor; readonly sameCoordinate: boolean }
  | {
    readonly kind: 'sibling'
    readonly anchorId: string
    readonly authority: Anchor['authority']
    readonly sourceAuthority: Anchor['sourceAuthority']
    readonly latestDecisionSeq?: number
    /** The value the sibling claim would write. */
    readonly value: unknown
  }
  | { readonly kind: 'cross-scope'; readonly anchor: Anchor }
  | { readonly kind: 'ambiguous'; readonly anchorIds: readonly string[] }
  | { readonly kind: 'unknown' }

/**
 * Resolve one `supersedes` entry.
 *
 * Resolution is deliberately WIDER than matching: it must be able to say why a
 * target did not resolve. "Nothing matched" (a typo or a lost anchor), "only
 * another scope matched" (a scope error) and "several same-scope coordinates
 * matched" (an ambiguous bare subject) are different failures with different
 * safe responses, and collapsing them into one `undefined` is how an
 * unauthorized or impossible revision gets applied as if it were complete.
 */
function resolveTarget(
  state: FoldCurrentState,
  target: string,
  delta: AcceptedDelta,
  accepted: readonly AcceptedDelta[],
): TargetResolution {
  const stateKey = delta.stateKey!
  if (target === 'previous') {
    const head = headAt(state, stateKey)
    return head === undefined
      ? { kind: 'previous-absent' }
      : { kind: 'resolved', anchor: head, sameCoordinate: true }
  }

  // A sibling proposal in the SAME packet may declare the target coordinate
  // later. Its anchor does not exist in `state` yet, but its authority does.
  const sibling = accepted.find(candidate =>
    candidate.deltaId !== delta.deltaId
    && candidate.stateKey !== undefined && candidate.subjectKey === target
    && candidate.stateKey.namespace === stateKey.namespace
    && sameScope(candidate.scope, delta.scope))
  if (sibling !== undefined) {
    return {
      kind: 'sibling',
      anchorId: anchorIdOf(sibling.deltaId),
      authority: sibling.authority,
      sourceAuthority: sibling.sourceAuthority,
      ...(sibling.latestDecisionSeq === undefined ? {} : { latestDecisionSeq: sibling.latestDecisionSeq }),
      value: renderedValue(sibling),
    }
  }

  const anchors = uniqueAnchors(state)
  // Explicit references: the anchor id itself, or the exact state-key text.
  const exact = anchors.filter(anchor =>
    anchor.id === target || (anchor.stateKey !== undefined && stateKeyText(anchor.stateKey) === target))
  if (exact.length > 1) {
    return { kind: 'ambiguous', anchorIds: exact.map(anchor => anchor.id) }
  }
  if (exact.length === 1) {
    const anchor = exact[0]!
    const sameCoordinate = anchor.stateKey !== undefined
      && stateKeyText(anchor.stateKey) === stateKeyText(stateKey)
    return { kind: 'resolved', anchor, sameCoordinate }
  }

  // A bare subject is matched only among SEMANTIC coordinates, and only inside
  // the proposal's scope — the pre-R32 rule that keeps one task's `timeout`
  // from retiring another task's contract by coincidence.
  const semantic = anchors.filter(anchor =>
    anchor.stateKey?.namespace === 'semantic' && anchor.stateKey.property === target)
  const inScope = semantic.filter(anchor => sameScope(anchor.scope, delta.scope))
  if (inScope.length > 1) {
    return { kind: 'ambiguous', anchorIds: inScope.map(anchor => anchor.id) }
  }
  if (inScope.length === 1) {
    const anchor = inScope[0]!
    const sameCoordinate = anchor.stateKey !== undefined
      && stateKeyText(anchor.stateKey) === stateKeyText(stateKey)
    return { kind: 'resolved', anchor, sameCoordinate }
  }
  if (semantic.length > 0) {
    return { kind: 'cross-scope', anchor: semantic[0]! }
  }

  // A target that names a coordinate already displaced by a newer value is not
  // a failure: there is nothing left to retire.
  const superseded = Object.values(state.superseded)
  if (superseded.some(anchor => anchor.id === target) || state.superseded[target] !== undefined) {
    return { kind: 'already-retired' }
  }
  return { kind: 'unknown' }
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
  const anchorById = new Map(uniqueAnchors(options.state).map(anchor => [anchor.id, anchor]))
  const declared = new Set<string>(options.knownAnchorIds ?? anchorById.keys())
  // The state each declare will ACTUALLY meet, including declares earlier in
  // this packet. `options.state` alone cannot answer that: a second delta at the
  // same coordinate meets the first delta's head, not the pre-fold head.
  const projectedHeads = new Map<string, Anchor>(Object.entries(options.state.stateHeads))
  const declares: EfAnchorEventData[] = []
  const transitions: EfAnchorEventData[] = []
  const retires: EfAnchorEventData[] = []
  const planned: PlannedDelta[] = []
  const unresolvedTargets = new Set<string>()
  const withheld: WithheldDelta[] = []
  const refusedRetirements: RefusedRetirement[] = []
  const valueConflicts: { deltaId: string; anchorId: string }[] = []

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
    const blocking: string[] = []
    const ambiguous: string[] = []
    const refusedReplacements: string[] = []
    const value = renderedValue(delta)

    for (const target of delta.supersedes) {
      const resolution = resolveTarget(options.state, target, delta, accepted)
      switch (resolution.kind) {
        case 'previous-absent':
          resolved.push({ target, via: 'same-coordinate' })
          continue
        case 'already-retired':
          resolved.push({ target, via: 'already-retired' })
          continue
        case 'unknown':
          unresolvedTargets.add(target)
          blocking.push(target)
          resolved.push({ target, via: 'unknown' })
          continue
        case 'ambiguous':
          unresolvedTargets.add(target)
          ambiguous.push(target)
          resolved.push({ target, via: 'ambiguous' })
          continue
        case 'cross-scope':
          unresolvedTargets.add(target)
          refusedRetirements.push({
            deltaId: delta.deltaId,
            target,
            anchorId: resolution.anchor.id,
            reason: 'cross-scope',
          })
          resolved.push({ target, via: 'cross-scope', anchorId: resolution.anchor.id, refusal: 'cross-scope' })
          continue
        case 'sibling': {
          const authorization = mayRetire({
            declaring: delta.authority,
            target: resolution.authority,
            sameScope: true,
            declaringSource: delta.sourceAuthority,
            targetSource: resolution.sourceAuthority ?? 'unknown',
            ...(delta.latestDecisionSeq === undefined ? {} : { declaringLatestSeq: delta.latestDecisionSeq }),
            ...(resolution.latestDecisionSeq === undefined ? {} : { targetLatestSeq: resolution.latestDecisionSeq }),
            declaringValue: value,
            targetValue: resolution.value,
          })
          if (!authorization.allowed) {
            refusedRetirements.push({
              deltaId: delta.deltaId,
              target,
              anchorId: resolution.anchorId,
              reason: authorization.reason,
            })
            resolved.push({
              target,
              anchorId: resolution.anchorId,
              via: 'other-coordinate',
              refusal: authorization.reason,
            })
            continue
          }
          resolved.push({ target, anchorId: resolution.anchorId, via: 'other-coordinate' })
          supersededHere.add(resolution.anchorId)
          continue
        }
        case 'resolved': {
          if (resolution.sameCoordinate) {
            // A same-coordinate replacement used to skip authorization
            // entirely: the coordinate itself was treated as the permission.
            // It is not. Replacing a user's decision with an assistant's at
            // the same coordinate retires the user's value just as surely as
            // naming it explicitly, so the same source check runs here. A
            // refusal WITHHOLDS the delta: declaring it anyway would overwrite
            // the anchor through the reducer's same-key path.
            const authorization = mayRetire({
              declaring: delta.authority,
              target: resolution.anchor.authority,
              sameScope: true,
              declaringSource: delta.sourceAuthority,
              targetSource: resolution.anchor.sourceAuthority ?? 'unknown',
              ...(delta.latestDecisionSeq === undefined ? {} : { declaringLatestSeq: delta.latestDecisionSeq }),
              ...(targetSeqField(latestSeqOf(resolution.anchor))),
              declaringValue: value,
              targetValue: resolution.anchor.value,
            })
            if (!authorization.allowed) {
              refusedRetirements.push({
                deltaId: delta.deltaId,
                target,
                anchorId: resolution.anchor.id,
                reason: authorization.reason,
              })
              refusedReplacements.push(target)
              resolved.push({
                target,
                anchorId: resolution.anchor.id,
                via: 'same-coordinate',
                refusal: authorization.reason,
              })
              continue
            }
            resolved.push({ target, anchorId: resolution.anchor.id, via: 'same-coordinate' })
            continue
          }
          const authorization = mayRetire({
            declaring: delta.authority,
            target: resolution.anchor.authority,
            sameScope: sameScope(resolution.anchor.scope, delta.scope),
            declaringSource: delta.sourceAuthority,
            targetSource: resolution.anchor.sourceAuthority ?? 'unknown',
            ...(delta.latestDecisionSeq === undefined ? {} : { declaringLatestSeq: delta.latestDecisionSeq }),
            ...(targetSeqField(latestSeqOf(resolution.anchor))),
            declaringValue: value,
            targetValue: resolution.anchor.value,
          })
          if (!authorization.allowed) {
            refusedRetirements.push({
              deltaId: delta.deltaId,
              target,
              anchorId: resolution.anchor.id,
              reason: authorization.reason,
            })
            resolved.push({
              target,
              anchorId: resolution.anchor.id,
              via: 'other-coordinate',
              refusal: authorization.reason,
            })
            continue
          }
          resolved.push({ target, anchorId: resolution.anchor.id, via: 'other-coordinate' })
          continue
        }
      }
    }

    // A revision whose target cannot be resolved is NOT applied. Declaring it
    // anyway would leave the value it claimed to replace live next to the new
    // claim — the N5 stale-anchor failure — while looking like a clean commit.
    if (blocking.length > 0 || ambiguous.length > 0 || refusedReplacements.length > 0) {
      const reason = ambiguous.length > 0
        ? 'ambiguous-target'
        : refusedReplacements.length > 0 ? 'unauthorized-replacement' : 'unresolved-target'
      withheld.push({
        deltaId: delta.deltaId,
        reason,
        targets: [...blocking, ...ambiguous, ...refusedReplacements],
      })
      planned.push({ deltaId: delta.deltaId, anchorId, kind: delta.kind, supersedes: resolved, withheld: reason })
      continue
    }

    if (declared.has(anchorId)) {
      // The claim is already state (or already planned in this packet). The
      // DECLARE is skipped; its authorized retirements are still applied below.
      const existing = anchorById.get(anchorId)
      if (existing !== undefined && existing.value !== value) {
        valueConflicts.push({ deltaId: delta.deltaId, anchorId })
      }
      planned.push({
        deltaId: delta.deltaId,
        anchorId,
        kind: delta.kind,
        supersedes: resolved,
        duplicate: true,
        ...(delta.duplicateClaim === true ? { duplicateClaim: true } : {}),
      })
      continue
    }
    const anchor: Anchor = {
      id: anchorId,
      kind: delta.anchorKind,
      stateKey,
      value,
      authority: delta.authority,
      sourceAuthority: delta.sourceAuthority,
      lifecycle: 'active',
      ...(delta.failureState === undefined ? {} : { failureState: delta.failureState }),
      sourceRefs: delta.evidence.map(entry => ({ seq: SessionSeq(entry.seq) })),
      ...(delta.scope === undefined ? {} : { scope: delta.scope }),
    }

    // OPERATION EFFECT, not declared relation.
    //
    // A declare at a coordinate that already has a head REPLACES that head in
    // the reducer. That is a retirement: the old anchor leaves every hot face
    // and enters `superseded`. Checking only the names in `supersedes` missed
    // it entirely, so an assistant decision with `supersedes: []` — or with an
    // unrelated target — silently overwrote a user decision while the plan
    // reported no refusal. The effect is resolved here, before the op exists.
    //
    // `resolved` may already contain an authorized same-coordinate target from
    // an explicit `supersedes`; that verdict is the same check, so it is reused
    // rather than run twice.
    const displaced = projectedHeads.get(stateKeyText(stateKey))
    if (displaced !== undefined && displaced.id !== anchorId) {
      const alreadyAuthorized = resolved.some(entry =>
        entry.anchorId === displaced.id && entry.refusal === undefined)
      if (!alreadyAuthorized) {
        const authorization = mayRetire({
          declaring: delta.authority,
          target: displaced.authority,
          // The coordinate itself IS the scope: two anchors at one state key
          // cannot be in different task scopes.
          sameScope: true,
          declaringSource: delta.sourceAuthority,
          targetSource: displaced.sourceAuthority ?? 'unknown',
          ...(delta.latestDecisionSeq === undefined ? {} : { declaringLatestSeq: delta.latestDecisionSeq }),
          ...(targetSeqField(latestSeqOf(displaced))),
          declaringValue: value,
          targetValue: displaced.value,
        })
        if (!authorization.allowed) {
          refusedRetirements.push({
            deltaId: delta.deltaId,
            target: displaced.id,
            anchorId: displaced.id,
            reason: authorization.reason,
          })
          withheld.push({
            deltaId: delta.deltaId,
            reason: 'unauthorized-replacement',
            targets: [displaced.id],
          })
          planned.push({
            deltaId: delta.deltaId,
            anchorId,
            kind: delta.kind,
            supersedes: resolved,
            withheld: 'unauthorized-replacement',
          })
          continue
        }
      }
    }

    declared.add(anchorId)
    projectedHeads.set(stateKeyText(stateKey), anchor)
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
    // A withheld delta contributes NO operations, including retirements.
    if (entry.withheld !== undefined) continue
    for (const target of entry.supersedes) {
      if (target.via === 'other-coordinate' && target.anchorId !== undefined && target.refusal === undefined) {
        retires.push({ op: 'retire', anchorId: target.anchorId })
      }
    }
  }

  return {
    ops: [...declares, ...transitions, ...dedupeRetires(retires)],
    planned,
    unresolvedTargets: [...unresolvedTargets],
    withheld,
    refusedRetirements,
    valueConflicts,
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
