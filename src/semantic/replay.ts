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
import { canonicalHash } from '../checkpoint/hash.ts'
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
  /**
   * Observe the state immediately after each commit's operations land.
   *
   * Used by {@link verifyCommitStateDigests} to compare the state a commit
   * actually produces with the digest the checkpoint bundle recorded. The
   * callback must not mutate `state`; it is the same object later commits build
   * on.
   */
  readonly onCommit?: (commit: SemanticCommit, state: FoldCurrentState) => void
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
      options.onCommit?.(commit, state)
    }
  }
  return { state, applied, unplaced }
}

/** One commit's expected post-operations state digest, from its bundle. */
export interface CommitStateExpectation {
  readonly packetId: string
  /** `bundle.state.digest`: `canonicalHash` of the state the body rendered. */
  readonly digest: string
}

/** A commit whose operations do not reproduce the state it was rendered from. */
export interface CommitStateMismatch {
  readonly packetId: string
  readonly expected: string
  readonly actual: string
}

/** Result of {@link verifyCommitStateDigests}. */
export interface CommitStateVerification {
  readonly mismatches: readonly CommitStateMismatch[]
  /** How many commits had a bundle state digest to compare against. */
  readonly checked: number
  /** Commits that could not be placed on this log and were not verified. */
  readonly unplaced: readonly SemanticCommit[]
}

/**
 * Verify that each commit's operations still produce the state its checkpoint
 * bundle recorded.
 *
 * ## The window this closes
 *
 * A packet carries `bodyDigest` and `sourceDigest`, and a receipt carries
 * `opsDigest`. All three bind the packet's IDENTITY. None binds its OPERATIONS
 * to the state that was actually rendered: a packet whose `ops` are replaced
 * after the fold but before its receipt (the missing-receipt crash window)
 * passes every identity check, and reconciliation would write a receipt for
 * operations the model never saw. The bundle's `state.digest` is the missing
 * binding, and it already exists for every structured fold.
 *
 * The comparison is exact and replay-ordered: events through the commit's
 * `commitOrder`, prior commits already applied, then this commit's operations.
 * A legitimate missing-receipt recovery reproduces the bundle state and stays
 * admissible; a replaced operation set does not.
 *
 * @param session - the log the commits were proven against.
 * @param commits - validated commits, in any order.
 * @param expectations - bundle state digests keyed by packet id.
 * @returns the mismatches plus coverage counts.
 */
export function verifyCommitStateDigests(
  session: Session,
  commits: readonly SemanticCommit[],
  expectations: readonly CommitStateExpectation[],
): CommitStateVerification {
  const expected = new Map(expectations.map(entry => [entry.packetId, entry.digest]))
  const mismatches: CommitStateMismatch[] = []
  let checked = 0
  const replay = replayWithSemanticCommits(session, commits, {
    onCommit: (commit, state) => {
      const digest = expected.get(commit.packetId)
      if (digest === undefined) return
      checked += 1
      const actual = canonicalHash(state)
      if (actual !== digest) {
        mismatches.push({ packetId: commit.packetId, expected: digest, actual })
      }
    },
  })
  return { mismatches, checked, unplaced: replay.unplaced }
}
