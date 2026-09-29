/**
 * Pending rebase intent (R3-0b): the durable-ish handoff between a pressure
 * turn that could not fix itself and the idle moment when a root fold is
 * actually admissible.
 *
 * R2-C proved the rebase is what makes economic leaf admission pay, but it
 * expressed the handoff as a *benchmark* hook: `createRootRebaseHook()` read
 * the engine's advice and called `compactNow`. The installed plugin had no
 * such consumer, so every E3 number in the R2 report was really
 * "EF engine + benchmark maintenance policy" rather than the product.
 *
 * This module closes that gap. The intent is deliberately TINY: it records
 * only identity and cause. Every quantity that justified the rebase (frozen
 * tokens, span, cost) is omitted because all of them go stale between the
 * pressure turn and idle, and a stale measurement is worse than none — it
 * would launder a decision made about a surface that no longer exists.
 *
 *   Recommendation is not authority.
 *
 * At idle the consumer re-measures the CURRENT surface and re-runs the policy
 * compiler from scratch. The intent's only job is to say "something happened
 * that may deserve a rebase; go look again".
 *
 * @module dsh-epistemic-fold/rebase-intent
 */

import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'

/** Why a rebase was requested. Kept narrow so the consumer can log the cause. */
export type RebaseCause =
  /** The frozen prefix alone exceeded the threshold; no leaf can help. */
  | 'frozen_prefix_over_threshold'
  /** A leaf was refused as uneconomic and the history stayed raw. */
  | 'economic_leaf_refusal'
  /** The configured frozen-checkpoint token budget was exceeded. */
  | 'frozen_budget'

/**
 * One outstanding rebase request for one session.
 *
 * Note what is NOT here: no measurement, no cost, no span. Those are all
 * re-derived at idle, because the surface they described is gone by then.
 */
export interface PendingRebaseIntent {
  readonly sessionId: SessionId
  /** Surface `replaceGeneration` when the intent was recorded (audit only). */
  readonly preparedGeneration: number
  readonly cause: RebaseCause
  readonly createdAtSeq: SessionSeq
}

/**
 * Per-session one-shot intent storage.
 *
 * Keyed by SESSION, not by agent object. A rebase is a property of one
 * conversation's surface, and the session outlives any particular agent
 * wrapper — the pressure turn and the later idle event are not guaranteed to
 * hold the same object reference, so keying on the agent would silently lose
 * intents. The session id is the identity both ends actually share.
 */
export interface RebaseIntentRegistry {
  /**
   * Record an intent. A second request for the same session REPLACES the
   * first rather than queueing: two reasons to rebase once are still one
   * rebase.
   * @returns true when this replaced an existing intent.
   */
  set(session: SessionKey, intent: PendingRebaseIntent): boolean
  /** Read the outstanding intent without consuming it. */
  peek(session: SessionKey): PendingRebaseIntent | undefined
  /**
   * Read AND clear the outstanding intent. The one-shot primitive: a rebase
   * may be attempted at most once per intent, so two idle events cannot
   * produce two roots.
   */
  consume(session: SessionKey): PendingRebaseIntent | undefined
  /** Drop any outstanding intent (session change, disposal, failed rebase). */
  clear(session: SessionKey): void
  /** Number of sessions with an outstanding intent (telemetry/tests). */
  readonly size: number
}

/** Anything carrying a session identity; the registry keys on `id`. */
export interface SessionKey {
  readonly id: SessionId
}

/** Create an empty registry. Intents are weakly held, so a dropped session's
 * intent never keeps it alive and never fires for a later one. */
export function createRebaseIntentRegistry(): RebaseIntentRegistry {
  const intents = new WeakMap<object, PendingRebaseIntent>()
  let count = 0
  return {
    set(session, intent) {
      const replaced = intents.has(session)
      if (!replaced) count += 1
      intents.set(session, intent)
      return replaced
    },
    peek(session) {
      return intents.get(session)
    },
    consume(session) {
      const intent = intents.get(session)
      if (intent !== undefined) {
        intents.delete(session)
        count -= 1
      }
      return intent
    },
    clear(session) {
      if (intents.delete(session)) count -= 1
    },
    get size() {
      return count
    },
  }
}

/**
 * Whether an intent still describes the session it is being applied to.
 *
 * A session swap between the pressure turn and idle means the intent was
 * formed about a different conversation, so it must be dropped rather than
 * applied. The registry key already enforces this; this check makes the rule
 * explicit and testable rather than implicit in weak-map identity.
 */
export function intentMatchesSession(intent: PendingRebaseIntent, sessionId: SessionId): boolean {
  return intent.sessionId === sessionId
}
