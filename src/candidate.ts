/**
 * Pending fold-candidate identity: one single slot per session, prepared
 * before the compaction transaction opens and cleared in its `finally`.
 *
 * @module dsh-epistemic-fold/candidate
 */

import { randomUUID } from 'node:crypto'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { FoldCandidate, FoldMode } from './types.ts'

/**
 * Registry of pending fold candidates keyed by session identity. A session
 * holds at most one candidate; preparing over a live one fails closed so two
 * overlapping transactions can never share or clobber an identity.
 */
export class FoldCandidateRegistry {
  private readonly pending = new WeakMap<Session, FoldCandidate>()

  /**
   * Bind one candidate to its session.
   * @throws when the session already carries a pending candidate.
   */
  prepare(session: Session, candidate: FoldCandidate): void {
    if (this.pending.get(session) !== undefined) {
      throw new Error(`epistemic-fold: session ${session.id} already has a pending fold candidate`)
    }
    this.pending.set(session, candidate)
  }

  get(session: Session): FoldCandidate | undefined {
    return this.pending.get(session)
  }

  clear(session: Session): void {
    this.pending.delete(session)
  }
}

/** One opaque checkpoint identity; uniqueness comes from the UUID. */
export type CheckpointId = string & { readonly __checkpointId: unique symbol }

/** Brand a UUID as a checkpoint identity. */
export function CheckpointId(id: string): CheckpointId {
  return id as CheckpointId
}

/**
 * Create the immutable candidate for one upcoming fold.
 * @param options - mode, owning session, and the explicitly selected
 * surface-position span when the caller chose one (leaf/automatic paths);
 * absent for implicit whole-history folds (root/manual paths).
 * @returns the frozen candidate plus its registry key identity.
 */
export function createFoldCandidate(options: {
  mode: FoldMode
  session: Session
  start?: SessionSeq
  end?: SessionSeq
}): FoldCandidate {
  const checkpointId = CheckpointId(randomUUID())
  const seed = `${options.session.id}:${options.mode}:${checkpointId}`
  const candidate: FoldCandidate = {
    checkpointId,
    mode: options.mode,
    sessionId: options.session.id,
    ...(options.start === undefined ? {} : { start: options.start }),
    ...(options.end === undefined ? {} : { end: options.end }),
    preparedSurfaceGeneration: options.session.surface.replaceGeneration,
    sourceDigestSeed: seed,
  }
  return Object.freeze(candidate)
}
