/**
 * Reconciliation: turn validated deltas into a commit plan over the existing
 * deterministic state, and decide which earlier anchors a delta replaces.
 *
 * ## Why this is a planner and not a second state store
 *
 * The durable truth is the `ef/anchor` event log and the reducer that folds it.
 * A semantic layer that maintained its own parallel map of "current values"
 * would be a second source of truth, and the two would disagree the first time
 * one write failed. So the output of this module is a PLAN: an ordered list of
 * anchor declares and retires that the engine executes through the one
 * sanctioned producer (`anchor-service.ts`). After that, the semantic values are
 * indistinguishable from any other anchor — same reducer, same faces, same
 * renderer, same recall.
 *
 * ## Supersession
 *
 * A delta replaces an earlier one in three ways, and they are deliberately not
 * conflated:
 *
 *  - **Same coordinate.** Declaring at an existing `stateKey` replaces the head
 *    in place. The reducer already records the displacement in `superseded`
 *    (bounded, one entry per coordinate), so "what did this used to say" stays
 *    answerable without keeping history in hot state.
 *  - **`supersedes: ["previous"]`.** Explicit intent to replace whatever is at
 *    this coordinate NOW. Resolved against the live state at plan time — the
 *    writer never learns an anchor id, so it cannot name one.
 *  - **`supersedes: [subjectKey]`.** Replaces a DIFFERENT coordinate, resolved
 *    only to another delta in the same packet. An unresolved name is recorded
 *    as a note and ignored: guessing which coordinate the model meant is how a
 *    wrong fact gets retired.
 *
 * @module dsh-epistemic-fold/semantic/reconcile
 */

import type { AnchorDraft } from '../anchor-service.ts'
import type { Anchor, EfAnchorEventData, FoldCurrentState } from '../state.ts'
import { stateKeyText } from '../state.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import type { AcceptedDelta, SemanticRefusal } from './types.ts'
import { rejectedApproachValue, anchorIdOf } from './validate.ts'

/** One delta's planned effect on durable state. */
export interface CommitPlan {
  readonly delta: AcceptedDelta
  /** The id the declared anchor will carry; derived, so reconciliation is restart-safe. */
  readonly anchorId: string
  /** The draft to hand the anchor service, absent for journal-only kinds. */
  readonly draft?: AnchorDraft
  /** Anchors at OTHER coordinates that this delta replaces. */
  readonly retire: readonly string[]
  /** Why nothing will be written. */
  readonly skipped?: string
}

/** Options for {@link planCommits}. */
export interface PlanCommitsOptions {
  readonly deltas: readonly AcceptedDelta[]
  /** The state as it stands BEFORE this packet is applied. */
  readonly state: FoldCurrentState
  /** Delta identities already present in the log, for idempotency. */
  readonly knownDeltaIds?: ReadonlySet<string>
  /** Anchor ids already present in the log. */
  readonly knownAnchorIds?: ReadonlySet<string>
}

/**
 * Build the commit plan for one validated packet.
 *
 * Order is the writer's order, which is also the order of dependency: a delta
 * that supersedes another in the same packet is planned after it, so the
 * replacement is applied to a state where its target already exists.
 *
 * @param options - accepted deltas and the current state.
 * @returns one plan entry per delta, in order.
 */
export function planCommits(options: PlanCommitsOptions): readonly CommitPlan[] {
  const knownDeltas = options.knownDeltaIds ?? new Set<string>()
  const knownAnchors = options.knownAnchorIds ?? new Set<string>()
  // Keyed to a LIST, not last-wins: two kinds may legitimately share a subject
  // key, and collapsing them meant a `supersedes: ["cache"]` on a decision could
  // resolve to an unrelated finding. Resolution prefers the same kind, and
  // refuses to guess when several different kinds match.
  const bySubject = new Map<string, AcceptedDelta[]>()
  for (const delta of options.deltas) {
    const existing = bySubject.get(delta.subjectKey)
    if (existing === undefined) bySubject.set(delta.subjectKey, [delta])
    else existing.push(delta)
  }

  const plans: CommitPlan[] = []
  for (const delta of options.deltas) {
    const anchorId = anchorIdOf(delta.deltaId)
    if (knownDeltas.has(delta.deltaId) || knownAnchors.has(anchorId)) {
      plans.push({ delta, anchorId, retire: [], skipped: 'already committed' })
      continue
    }
    if (delta.anchorKind === undefined || delta.stateKey === undefined) {
      plans.push({
        delta,
        anchorId,
        retire: [],
        skipped: `${delta.kind} is journaled only and never enters hot state`,
      })
      continue
    }
    const retire: string[] = []
    for (const target of delta.supersedes) {
      if (target === 'previous') {
        // Resolved against live state: the head at THIS coordinate. Declaring
        // at the same key replaces it anyway, so this only matters when the key
        // has no head yet — in which case there is nothing to retire.
        const head = options.state.stateHeads[stateKeyText(delta.stateKey)]
        if (head !== undefined && head.id !== anchorId) retire.push(head.id)
        continue
      }
      const candidates = bySubject.get(target) ?? []
      const named = candidates.find(candidate => candidate.kind === delta.kind)
        ?? (candidates.length === 1 ? candidates[0] : undefined)
      if (named === undefined) continue
      const namedId = anchorIdOf(named.deltaId)
      if (namedId !== anchorId && !retire.includes(namedId)) retire.push(namedId)
    }
    plans.push({
      delta,
      anchorId,
      retire,
      draft: draftOf(delta, anchorId),
    })
  }
  return plans
}

/**
 * The anchor draft for one delta.
 *
 * The value is the sentence(s) a model should read, not a JSON blob: the
 * renderer's non-string branch `JSON.stringify`s the value, and a state line
 * that reads `{"statement":…}` is worse than one that reads as prose. Scope,
 * dependencies and rules-out stay in the journal, where they are structural.
 *
 * `sourceRefs` are the runtime-resolved seqs. The anchor service re-checks the
 * authority they ground, so a plan that reached here through a bug still cannot
 * write an ungrounded anchor.
 */
function draftOf(delta: AcceptedDelta, anchorId: string): AnchorDraft {
  const value = delta.kind === 'rejected-approach'
    ? rejectedApproachValue(delta.statement, delta.rulesOut)
    : delta.statement
  return {
    id: anchorId,
    kind: delta.anchorKind!,
    stateKey: delta.stateKey!,
    value,
    authority: delta.authority,
    sourceRefs: delta.evidence.map(entry => ({ seq: entry.seq as never })),
    ...(delta.failureState === undefined ? {} : { failureState: delta.failureState }),
  }
}

/**
 * Every anchor id this session has EVER declared, read from the session log.
 *
 * ## Why the log and not the state snapshot
 *
 * The bounded current state keeps only the head per coordinate plus ONE
 * displaced anchor (`superseded`, one entry per coordinate) — that is the whole
 * point of the boundedness model. Using it as the "was this committed?" oracle
 * therefore reported every anchor displaced MORE than once as missing, and
 * reconciliation re-declared it: the current value then cycled through old
 * revisions on every fold. A retired anchor, or a verified failure, was
 * likewise absent and came back.
 *
 * The log is the only record that answers this question completely. The scan is
 * O(events) and runs once per fold, which is the same order as the projection's
 * own replay and is the price of a correct answer.
 *
 * @param session - the session whose log to scan.
 * @returns every declared anchor id.
 */
export function anchorIdsInLog(session: Session): Set<string> {
  const ids = new Set<string>()
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq as never)
    if (event?.type !== 'ef/anchor') continue
    const data = event.data as EfAnchorEventData
    if (data.op === 'declare' && data.anchor !== undefined) ids.add(data.anchor.id)
  }
  return ids
}

/**
 * Describe which anchors changed in one fold, for the checkpoint's delta
 * section.
 *
 * An anchor is "changed in this fold" when at least one of its source events
 * lies inside the folded span. That is a PROPERTY OF PROVENANCE, not a
 * recording made at fold time, so it survives a restart and cannot drift from
 * the log — and it is why no per-fold side table is needed.
 *
 * @param state - the state after the fold's commits.
 * @param foldedSeqs - the folded span's surface seqs.
 * @returns the anchors introduced or revised by this fold, deduplicated by id.
 */
export function changedAnchors(
  state: FoldCurrentState,
  foldedSeqs: ReadonlySet<number>,
): readonly Anchor[] {
  const byId = new Map<string, Anchor>()
  const take = (anchor: Anchor | undefined): void => {
    if (anchor === undefined || byId.has(anchor.id)) return
    if (!anchor.sourceRefs.some(ref => foldedSeqs.has(ref.seq as unknown as number))) return
    byId.set(anchor.id, anchor)
  }
  take(state.objective)
  for (const face of [
    state.openFailures,
    state.constraints,
    state.decisions,
    state.evidence,
    state.openObligations,
    state.stateHeads,
  ]) {
    for (const anchor of Object.values(face)) take(anchor)
  }
  return [...byId.values()]
}

/**
 * Turn a commit failure into a refusal.
 *
 * `commit-failed`, not `authority-ungrounded`: the delta passed validation and
 * the WRITE failed (an unwritable host, a refused durable append). Labelling an
 * I/O refusal as an authority verdict sends an operator to inspect the writer's
 * evidence when the problem is the host, and it was the only place the
 * capability error text survived.
 *
 * @param delta - the delta whose commit failed.
 * @param error - what the anchor service threw.
 * @returns a refusal carrying the real message.
 */
export function commitRefusal(delta: AcceptedDelta, error: unknown): SemanticRefusal {
  return {
    index: delta.index,
    reason: 'commit-failed',
    detail: `commit refused for "${delta.subjectKey}": `
      + (error instanceof Error ? error.message : String(error)),
  }
}
