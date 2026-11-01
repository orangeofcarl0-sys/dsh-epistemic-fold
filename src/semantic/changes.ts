/**
 * The temporal split: which anchors belong to THIS fold, and which are carried
 * state from earlier folds.
 *
 * ## Provenance, not recency
 *
 * An anchor is "changed in this fold" only when one of its source events lies
 * INSIDE the span this checkpoint replaces. Recency heuristics ("declared in
 * the last N events") would put an anchor into two different checkpoints when
 * folds overlap in time, and the frozen chain would then carry the same fact
 * twice — the duplication the temporal body exists to remove.
 *
 * ## The cap is explicit, never silent
 *
 * A root fold can shadow hundreds of messages and therefore produce more
 * changed anchors than a checkpoint should carry. The cap protects the model's
 * context, but it must not hide the fact that it truncated: the caller renders
 * an overflow line, and the omitted anchors remain effective and retrievable.
 * Pinned contracts sort first so the cap cannot drop a still-binding user
 * constraint in favor of a stale finding.
 *
 * @module dsh-epistemic-fold/semantic/changes
 */

import type { Anchor, FoldCurrentState } from '../state/state.ts'
import { residencyOf } from './working-set-compiler.ts'

/** Default ceiling on the per-fold delta section. */
export const MAX_CHANGED_ANCHORS = 24

/** Every distinct anchor any hot face holds. */
function anchorsOf(state: FoldCurrentState): readonly Anchor[] {
  const byId = new Map<string, Anchor>()
  if (state.objective !== undefined) byId.set(state.objective.id, state.objective)
  for (const face of [
    state.constraints,
    state.openObligations,
    state.openFailures,
    state.decisions,
    state.evidence,
    state.stateHeads,
  ]) {
    for (const anchor of Object.values(face)) {
      if (anchor.lifecycle !== 'active') continue
      if (!byId.has(anchor.id)) byId.set(anchor.id, anchor)
    }
  }
  return [...byId.values()]
}

/** The latest source position of one anchor, for a stable within-fold order. */
function provenancePosition(anchor: Anchor): number {
  let latest = -1
  for (const ref of anchor.sourceRefs) {
    const seq = Number(ref.seq)
    if (seq > latest) latest = seq
  }
  return latest
}

/** The changed set, split at the cap. */
export interface ChangedSelection {
  /** The anchors the section renders: every changed pinned anchor, then the working cap. */
  readonly shown: readonly Anchor[]
  /** Changed anchors that are still in force. Never capped; the cap cannot drop a contract. */
  readonly pinned: readonly Anchor[]
  /** The changed working anchors the election shows. */
  readonly working: readonly Anchor[]
  /** Effective WORKING anchors the cap left out; the caller renders an overflow line. */
  readonly omitted: readonly Anchor[]
  /** Every changed anchor, including the omitted ones. Used to exclude them from carried state. */
  readonly all: readonly Anchor[]
}

/**
 * Select the anchors whose provenance lies inside one folded span.
 *
 * ## Pinned and working do not share one quota
 *
 * A single global cap is the defect this signature exists to prevent: with 30
 * still-binding pinned constraints changed in a root fold, a cap of 24 showed
 * 24 of them, omitted 6, and the caller excluded ALL 30 from the carried
 * working set — so the 6 omitted contracts were neither in the delta section
 * nor in the carried state, only behind a generic retrieval pointer. A hard
 * constraint that is still in force is not a candidate for a token quota.
 *
 * The cap therefore limits only the WORKING (droppable) anchors. Pinned state
 * is always rendered; if it is expensive, the working-set compiler reports the
 * overflow instead of the selector hiding it. The omitted working anchors are
 * counted explicitly, so "not shown" never means "silently deleted".
 *
 * @param state - the candidate state AFTER this packet's operations.
 * @param foldedSeqs - surface seqs of the span being replaced.
 * @param cap - maximum WORKING anchors rendered; `MAX_CHANGED_ANCHORS` by default.
 * @returns the rendered set, the pinned set, and the working anchors left out by the cap.
 */
export function changedAnchors(
  state: FoldCurrentState,
  foldedSeqs: readonly number[],
  cap: number = MAX_CHANGED_ANCHORS,
): ChangedSelection {
  const inside = new Set(foldedSeqs)
  const changed = anchorsOf(state).filter(anchor =>
    anchor.sourceRefs.some(ref => inside.has(Number(ref.seq))))
  const pinned: Anchor[] = []
  const droppable: Anchor[] = []
  for (const anchor of changed) {
    if (residencyOf(anchor) === 'pinned') pinned.push(anchor)
    else droppable.push(anchor)
  }
  const order = (left: Anchor, right: Anchor): number =>
    provenancePosition(right) - provenancePosition(left) || left.id.localeCompare(right.id)
  pinned.sort(order)
  droppable.sort(order)
  const shownWorking = droppable.slice(0, Math.max(0, cap))
  return {
    shown: [...pinned, ...shownWorking],
    pinned,
    working: shownWorking,
    omitted: droppable.slice(Math.max(0, cap)),
    all: changed,
  }
}

/**
 * The explicit truncation notice for a changed section that hit the cap.
 *
 * @param omitted - how many effective changed anchors the cap left out.
 * @returns the line to render, or `undefined` when nothing was omitted.
 */
export function changedOverflowLine(omitted: number): string | undefined {
  return omitted === 0
    ? undefined
    : `- (+${omitted} more changed item(s) not shown; `
      + 'use context_search with a keyword to retrieve them)'
}
