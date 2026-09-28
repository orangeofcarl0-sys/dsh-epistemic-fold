/**
 * The authority runtime gate (R0-A): the SANCTIONED producer of `ef/anchor`
 * events. Every anchor declared through this service has its claimed
 * authority validated against the raw events it cites BEFORE the event is
 * appended — derived authority must terminate at raw authority roots
 * (user/system messages, tool results, procedural execution), never at
 * another derived anchor.
 *
 * @module dsh-epistemic-fold/anchor-service
 */

import { randomUUID } from 'node:crypto'
import type { Session } from '@deepseek-ai/dsh-session'
import { canVerify, isAuthorityGrounded } from './authority.ts'
import type { AuthoritativeEventKind } from './authority.ts'
import type { Anchor, EventRef, FailureState } from './state.ts'

const AUTHORITATIVE_KINDS: ReadonlySet<string> = new Set([
  'user/message',
  'system/message',
  'tool/result',
  'assistant/message',
])

/** An anchor under construction: everything except identity and lifecycle. */
export type AnchorDraft = Omit<Anchor, 'id' | 'lifecycle'>

export interface AnchorService {
  /** Validate the draft's authority grounding, then append `ef/anchor`. */
  declare(session: Session, draft: AnchorDraft): Anchor
  /**
   * Advance a failure to VERIFIED. The evidence refs are resolved against
   * the session log and must ALL be empirical/procedural raw events —
   * assistant prose can never verify (Evidence Overrides Narrative).
   */
  verifyFailure(session: Session, failureAnchorId: string, evidenceRefs: readonly EventRef[]): void
  /** Advance a failure through investigating/resolved. */
  transitionFailure(session: Session, failureAnchorId: string, failureState: Exclude<FailureState, 'verified'>): void
  /** Retire an anchor by id. */
  retire(session: Session, anchorId: string): void
}

/** Resolve the raw event kinds behind one anchor's source refs. */
function citedKinds(session: Session, refs: readonly EventRef[]): AuthoritativeEventKind[] {
  const kinds: AuthoritativeEventKind[] = []
  for (const ref of refs) {
    const kind = session.eventAt(ref.seq)?.type
    if (kind !== undefined && AUTHORITATIVE_KINDS.has(kind)) {
      kinds.push(kind as AuthoritativeEventKind)
    }
  }
  return kinds
}

/** Create the anchor service; one instance may serve many sessions. */
export function createAnchorService(): AnchorService {
  function declare(session: Session, draft: AnchorDraft): Anchor {
    const kinds = citedKinds(session, draft.sourceRefs)
    if (kinds.length === 0) {
      throw new Error(
        `epistemic-fold: ungrounded anchor — cite at least one raw authoritative event (kind=${draft.kind})`,
      )
    }
    if (!isAuthorityGrounded(draft.authority, kinds)) {
      throw new Error(
        `epistemic-fold: anchor authority "${draft.authority}" is not grounded by its cited sources `
        + `[${kinds.join(', ')}] (kind=${draft.kind})`,
      )
    }
    const anchor: Anchor = {
      ...draft,
      id: `anchor-${randomUUID()}`,
      lifecycle: 'active',
    }
    session.append('ef/anchor', { op: 'declare', anchor })
    return anchor
  }

  function verifyFailure(session: Session, failureAnchorId: string, evidenceRefs: readonly EventRef[]): void {
    if (evidenceRefs.length === 0) {
      throw new Error('epistemic-fold: VERIFIED requires at least one evidence ref')
    }
    const kinds = citedKinds(session, evidenceRefs)
    if (!canVerify(kinds)) {
      throw new Error(
        `epistemic-fold: VERIFIED refused — evidence kinds [${kinds.join(', ') || 'none'}] `
        + 'are not all empirical/procedural (Evidence Overrides Narrative)',
      )
    }
    session.append('ef/anchor', {
      op: 'transition',
      anchorId: failureAnchorId,
      failureState: 'verified',
      evidenceRefs: [...evidenceRefs],
    })
  }

  function transitionFailure(session: Session, failureAnchorId: string, failureState: Exclude<FailureState, 'verified'>): void {
    session.append('ef/anchor', {
      op: 'transition',
      anchorId: failureAnchorId,
      failureState,
    })
  }

  function retire(session: Session, anchorId: string): void {
    session.append('ef/anchor', { op: 'retire', anchorId })
  }

  return { declare, verifyFailure, transitionFailure, retire }
}
