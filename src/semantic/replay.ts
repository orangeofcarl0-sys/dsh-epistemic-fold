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
 * This module re-folds the log and applies each verified commit's operations
 * immediately after the replacement event at its recorded `commitOrder`. The
 * reducer is the projection's own (`reduceSessionEvent`), so this is a
 * different ORDER, not a second state model.
 *
 * @module dsh-epistemic-fold/semantic/replay
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { emptyCurrentState } from '../state/state.ts'
import type { EfAnchorEventData, FoldCurrentState } from '../state/state.ts'
import { reduceSessionEvent } from '../state/projection.ts'
import { applyOps } from './plan.ts'

/** One verified commit, placed at its historical replacement seq. */
export interface SemanticCommit {
  readonly packetId: string
  readonly atSeq: number
  readonly ops: readonly EfAnchorEventData[]
}

/** The replayed state plus the commits that could not be placed on the log. */
export interface SemanticReplay {
  readonly state: FoldCurrentState
  readonly applied: readonly SemanticCommit[]
  /** Commits whose `atSeq` does not exist in this log. Never applied. */
  readonly unplaced: readonly SemanticCommit[]
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
 * @returns the state and a report of commits that could not be placed.
 */
export function replayWithSemanticCommits(
  session: Session,
  commits: readonly SemanticCommit[],
): SemanticReplay {
  const events = session.snapshotEvents()
  const seqs = new Set(events.map(event => Number(event.seq)))
  const bySeq = new Map<number, SemanticCommit[]>()
  const applied: SemanticCommit[] = []
  const unplaced: SemanticCommit[] = []
  for (const commit of commits) {
    if (!seqs.has(commit.atSeq)) {
      unplaced.push(commit)
      continue
    }
    const bucket = bySeq.get(commit.atSeq) ?? []
    bucket.push(commit)
    bySeq.set(commit.atSeq, bucket)
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
      state = applyOps(state, commit.ops)
      applied.push(commit)
    }
  }
  return { state, applied, unplaced }
}
