/**
 * Continuity admission: the three independent questions a fold must answer
 * before it may write authoritative semantic state.
 *
 *  1. Is the current semantic state safely readable?
 *  2. May this fold commit NEW semantic operations?
 *  3. May the fold still archive history and emit a deterministic checkpoint?
 *
 * They are not one boolean. A benign historical failure (a fold rejected by the
 * shrink check, its packet aborted, the original history intact) leaves the
 * current state valid, so (1) and (2) are both yes. A lost/unreadable journal or
 * a packet/receipt contradiction leaves the state incomplete, so (2) is no
 * while (3) must stay yes — blocking context-overflow recovery would trade a
 * memory defect for a lost run.
 *
 * `archive-only` is the mode where semantic continuity is not enabled at all.
 * It is distinct from `blocked`: nothing is wrong, there is simply no semantic
 * layer to read or write.
 *
 * @module dsh-epistemic-fold/semantic/admission
 */

import type { FoldCurrentState } from '../state/state.ts'

/** The fold's admission decision for one session. */
export type ContinuityAdmission =
  | {
    readonly mode: 'active'
    /** The state rebuilt from verified commits only. */
    readonly state: FoldCurrentState
  }
  | {
    readonly mode: 'archive-only'
    readonly reason: string
  }
  | {
    readonly mode: 'blocked'
    /**
     * Why the semantic state is incomplete. This string is shown to the model
     * in the checkpoint; it must name the condition, never pretend the state is
     * complete.
     */
    readonly reason: string
  }

/** Whether a fold may stage a new authoritative semantic packet. */
export function mayCommitSemantics(admission: ContinuityAdmission): boolean {
  return admission.mode === 'active'
}

/** The visible notice a blocked fold must carry in its checkpoint body. */
export function blockedNotice(admission: ContinuityAdmission): string | undefined {
  return admission.mode === 'blocked'
    ? `SEMANTIC STATE INCOMPLETE — ${admission.reason}. No new semantic operations were committed; `
      + 'the deterministic history below is intact and recall still works.'
    : undefined
}
