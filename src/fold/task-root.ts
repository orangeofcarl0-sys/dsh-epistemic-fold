/**
 * Active task root: the ONE user contract a trusted host has declared current.
 *
 * ## The problem this exists for
 *
 * Measured on a real LHTB cell: the task instruction was a user message at surface seq 2, the
 * FIRST leaf fold shadowed it (`shadowedSeqs` head `[2, 6, 10, 11, 17, ...]`), and from then on
 * the only copy of the objective was inside a checkpoint bundle. The model could recover it,
 * but only by deciding to call a tool -- and it did not: two attempts, zero characters.
 *
 * Recoverable is not recovered. The one node whose loss cannot be repaired by reasoning about
 * the rest of the conversation has to stay where the model can see it.
 *
 * ## What this is NOT
 *
 * It is not automatic. Nothing here inspects the conversation for an objective: a root exists
 * only because a host called `register`. A general DSH session has no trustworthy source of task
 * identity, so it gets no pin, and this module is inert.
 *
 * It is not a summary. The registered root names a SESSION EVENT; the content the model sees is
 * that event's own bytes, digest-checked. Nothing in this module writes prose.
 *
 * @module dsh-epistemic-fold/task-root
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { canonicalHash } from '../checkpoint/hash.ts'

/**
 * A host's declaration of which session event carries the current task contract.
 *
 * `sourceSeq` is the ORIGINAL user event, never a copy of it: the resident node is that event's
 * own surface node, so its authority is the user's and nothing is synthesised to represent it.
 *
 * `sourceDigest` is `canonicalHash` of that event's message content. It is checked on every
 * resolution, so a log that no longer produces the registered bytes fails loudly instead of
 * leaving a stale objective resident.
 *
 * `generation` increments when a host declares a DIFFERENT root for the same session. It exists so
 * a reader can tell a replacement from a re-registration, and so an idempotent re-register is
 * distinguishable from a new task.
 */
export interface ActiveTaskRootRef {
  readonly sessionId: SessionId
  readonly sourceSeq: SessionSeq
  readonly sourceDigest: string
  readonly generation: number
}

/** Why a registered root could not be resolved to a model-visible node. */
export type TaskRootFailure =
  /** The declared event is not on the current surface: it was folded, or never existed. */
  | 'source-not-on-surface'
  /** The event's current message content does not hash to the registered digest. */
  | 'digest-mismatch'
  /** The declared event is not a user message, so it cannot carry user authority. */
  | 'not-a-user-message'
  /** The event has no derivable message at all. */
  | 'no-message'

/** Where a registered root currently sits on the surface, or why it does not. */
export type TaskRootResolution =
  | { readonly status: 'resident'; readonly position: number; readonly seq: SessionSeq }
  | { readonly status: 'absent'; readonly reason: TaskRootFailure }

/**
 * The digest a host registers: `canonicalHash` over the message's content blocks.
 *
 * Content only, and deliberately: the digest must not change because a session was replayed,
 * re-serialised, or had its provenance metadata rewritten. It answers one question -- are these
 * the bytes the host declared -- and nothing else.
 */
export function taskRootDigest(message: Message): string {
  return canonicalHash(message.content)
}

/** One session's registered root, keyed by session so two sessions cannot share one. */
export type TaskRootRegistration = { readonly status: 'registered' | 'unchanged' | 'replaced'; readonly ref: ActiveTaskRootRef }

/**
 * The explicit registry: at most one active root per session, replaced only on request.
 *
 * ## Why re-registering the SAME root is idempotent and why that is not a detail
 *
 * A host that re-announces its objective on every turn is the normal case (the LHTB lane knows
 * its instruction at episode setup and has no reason to track whether it already said so). If a
 * repeat incremented `generation`, every turn would look like a new task to any reader of the
 * provenance, and the generation number would carry no information at all.
 *
 * Registering a DIFFERENT `sourceSeq` for the same session is a replacement: the old root stops
 * being current, and the generation advances. Nothing here infers a replacement from prose.
 */
export class ActiveTaskRootRegistry {
  private readonly bySession = new Map<string, ActiveTaskRootRef>()

  /**
   * Declare the active root for a session.
   *
   * @param ref - the declaration. `generation` is ignored on a new or unchanged registration and
   *   its successor value is returned, so a host does not have to track generations itself.
   * @returns what happened, and the ref now in effect.
   */
  register(ref: ActiveTaskRootRef): TaskRootRegistration {
    const key = String(ref.sessionId)
    const current = this.bySession.get(key)
    if (current === undefined) {
      const next = { ...ref, generation: Math.max(1, ref.generation) }
      this.bySession.set(key, next)
      return { status: 'registered', ref: next }
    }
    if (current.sourceSeq === ref.sourceSeq && current.sourceDigest === ref.sourceDigest) {
      return { status: 'unchanged', ref: current }
    }
    const next = { ...ref, generation: current.generation + 1 }
    this.bySession.set(key, next)
    return { status: 'replaced', ref: next }
  }

  /** The active root for a session, or `undefined` when the host never declared one. */
  get(sessionId: SessionId): ActiveTaskRootRef | undefined {
    return this.bySession.get(String(sessionId))
  }

  /**
   * Forget a session's root. Called at session teardown, and by a host that has no current task.
   *
   * @returns whether a root was actually removed.
   */
  clear(sessionId: SessionId): boolean {
    return this.bySession.delete(String(sessionId))
  }
}

/**
 * Locate a registered root on the CURRENT surface, verifying its bytes.
 *
 * Resolution is re-derived every time rather than cached: the surface is what a fold rewrites, and
 * a cached position would be exactly the stale answer this module exists to prevent. It is cheap
 * -- one map lookup and one scan of the surface seqs.
 *
 * @param session - session whose surface is inspected.
 * @param ref - the registered declaration, or `undefined` for a session with no root.
 * @returns the resident position, or the reason there is none. Never throws: a root that cannot
 *   be resolved is a fact the engine reports, not an error that stops a fold.
 */
export function resolveActiveTaskRoot(
  session: Session,
  ref: ActiveTaskRootRef | undefined,
): TaskRootResolution | undefined {
  if (ref === undefined) return undefined
  if (String(ref.sessionId) !== String(session.id)) return undefined
  const seqs = session.surface.nodes
  const position = seqs.indexOf(ref.sourceSeq)
  if (position < 0) return { status: 'absent', reason: 'source-not-on-surface' }
  const event = session.eventAt(ref.sourceSeq)
  if (event === undefined) return { status: 'absent', reason: 'source-not-on-surface' }
  const message = session.deriveEventMessage(event)
  if (message === null) return { status: 'absent', reason: 'no-message' }
  if (message.role !== 'user') return { status: 'absent', reason: 'not-a-user-message' }
  if (taskRootDigest(message) !== ref.sourceDigest) return { status: 'absent', reason: 'digest-mismatch' }
  return { status: 'resident', position, seq: SessionSeq(ref.sourceSeq) }
}

/**
 * The surface position a fold must never include: a resident active task root.
 *
 * Returns `undefined` for the ordinary case -- no registered root, or one that is not currently
 * resident -- so every caller's default is the behaviour that existed before this module.
 */
export function protectedTaskRootPosition(
  session: Session,
  ref: ActiveTaskRootRef | undefined,
): number | undefined {
  const resolution = resolveActiveTaskRoot(session, ref)
  return resolution?.status === 'resident' ? resolution.position : undefined
}