/**
 * Ordered state replay: session events and semantic commits on ONE timeline.
 *
 * ## Why layering a journal on top of the session state is wrong
 *
 * A fold's semantic operations become state at the fold's commit point — the
 * replacement message that the model saw. Applying every journal packet AFTER
 * the whole session would let a fold at seq 100 overwrite a raw event at seq
 * 150: the replay order would be "history, then all remembered conclusions",
 * not the order the facts entered the log.
 *
 * This module re-folds the log and applies each VERIFIED commit's operations
 * immediately after the replacement event at its recorded `commitOrder`. It
 * accepts only `ValidatedSemanticCommit` values, produced by the one integrity
 * gate in `integrity.ts`; a caller cannot hand it arbitrary operations.
 *
 * @module dsh-epistemic-fold/semantic/replay
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { emptyCurrentState } from '../state/state.ts'
import type { FoldCurrentState } from '../state/state.ts'
import { reduceSessionEvent } from '../state/projection.ts'
import type { ValidatedSemanticCommit } from './integrity.ts'
import { applyOps } from './plan.ts'

/**
 * One verified commit, placed at its historical replacement seq.
 *
 * Kept as an alias of the integrity value rather than a separate shape: a
 * second struct with the same fields would invite a call site to construct one
 * without validation.
 */
export type SemanticCommit = ValidatedSemanticCommit

/** The replayed state plus the commits that could not be placed on the log. */
export interface SemanticReplay {
  readonly state: FoldCurrentState
  readonly applied: readonly SemanticCommit[]
  /** Commits whose `commitOrder` does not exist in this log. Never applied. */
  readonly unplaced: readonly SemanticCommit[]
}

/** Options for {@link replayWithSemanticCommits}. */
export interface SemanticReplayOptions {
  /**
   * Fold and apply only through this inclusive seq.
   *
   * A fork needs the state at its inherited cut, not at the child's current
   * tail. `undefined` means the whole log.
   */
  readonly uptoSeq?: number
}

/**
 * Replay one session with semantic commits interleaved at their commit seqs.
 *
 * At one seq, events are folded first and commits second: a replacement message
 * is the checkpoint the operations describe, so the operations describe state
 * as of AFTER that node exists. Multiple commits at one seq (a duplicate
 * attempt that also proved committed) are ordered by packet id, the only
 * deterministic tie-breaker that survives a restart.
 *
 * @param session - the log to replay.
 * @param commits - verified commits, already proven against this log.
 * @param options - an optional inclusive upper bound.
 * @returns the state and a report of commits that could not be placed.
 */
export function replayWithSemanticCommits(
  session: Session,
  commits: readonly SemanticCommit[],
  options: SemanticReplayOptions = {},
): SemanticReplay {
  const upto = options.uptoSeq
  const events = session.snapshotEvents()
    .filter(event => upto === undefined || Number(event.seq) <= upto)
  const seqs = new Set(events.map(event => Number(event.seq)))
  const bySeq = new Map<number, SemanticCommit[]>()
  const applied: SemanticCommit[] = []
  const unplaced: SemanticCommit[] = []
  for (const commit of commits) {
    if (upto !== undefined && commit.commitOrder > upto) continue
    if (!seqs.has(commit.commitOrder)) {
      unplaced.push(commit)
      continue
    }
    const bucket = bySeq.get(commit.commitOrder) ?? []
    bucket.push(commit)
    bySeq.set(commit.commitOrder, bucket)
  }
  for (const bucket of bySeq.values()) {
    bucket.sort((left, right) => left.packetId.localeCompare(right.packetId))
  }

  let state = emptyCurrentState()
  for (const event of events) {
    state = reduceSessionEvent(state, event)
    const bucket = bySeq.get(Number(event.seq))
    if (bucket === undefined) continue
    for (const commit of bucket) {
      state = applyOps(state, commit.operations)
      applied.push(commit)
    }
  }
  return { state, applied, unplaced }
}
