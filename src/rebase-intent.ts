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

/**
 * Why a rebase was requested, in two classes that carry DIFFERENT authority.
 *
 * The split is the whole point, and it is expressed in the type rather than in
 * a comment so that "economics cannot veto safety" is enforced by the compiler
 * instead of remembered by a reader.
 *
 * - A **safety** cause is structural: a leaf fold has been shown incapable of
 *   restoring headroom, so a rebase is the only remaining mechanism. Economic
 *   policy has no vote — refusing here would mean choosing non-convergence.
 * - An **economic** cause is an optimization: the rebase is repayable over its
 *   payback horizon, which the policy compiler is entitled to judge.
 */
export type RebaseCause =
  /** The frozen prefix alone exceeded the SOFT threshold; no leaf can help. */
  | 'frozen_bound_safety'
  /** The frozen prefix alone exceeded the HARD capacity, or the provider refused. */
  | 'hard_overflow_safety'
  /** A leaf was refused as uneconomic and the history stayed raw. */
  | 'economic_leaf_refusal'
  /** The configured frozen-checkpoint token budget was exceeded. */
  | 'frozen_budget'

/** The safety causes: economics may not veto a rebase requested for these. */
export const SAFETY_REBASE_CAUSES = [
  'frozen_bound_safety',
  'hard_overflow_safety',
] as const

/** One safety cause. */
export type SafetyRebaseCause = (typeof SAFETY_REBASE_CAUSES)[number]

/** The economic causes: the policy compiler decides whether they are worth it. */
export type EconomicRebaseCause = Exclude<RebaseCause, SafetyRebaseCause>

/**
 * Whether a cause is structural rather than economic.
 *
 * The consumer branches on this: a safety intent skips the economics compiler
 * (but never the re-measurement — see {@link PendingRebaseIntent}).
 *
 * @param cause - the recorded cause.
 * @returns true when economics may not veto the rebase.
 */
export function isSafetyRebaseCause(cause: RebaseCause): cause is SafetyRebaseCause {
  return (SAFETY_REBASE_CAUSES as readonly string[]).includes(cause)
}

/**
 * One outstanding rebase request for one session.
 *
 * Note what is NOT here: no measurement, no cost, no span. Those are all
 * re-derived at idle, because the surface they described is gone by then.
 *
 * That rule applies to safety causes too. A safety intent says "a leaf could
 * not fix this when the intent was written", which is a claim about a surface
 * that no longer exists — the tail may have grown, or a later fold may have
 * changed the prefix. So the consumer RE-MEASURES and RE-CLASSIFIES before
 * acting, and drops the intent if the condition has passed. Safety bypasses the
 * economics, never the revalidation.
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
 * **Keyed by the LIVE SESSION OBJECT's identity**, not by session id. Two
 * properties follow, and both are deliberate:
 *
 * 1. **The pressure turn and the idle event must observe the same object.**
 *    They do: both reach the engine through `agent.session`, and an agent's
 *    session is not swapped mid-life. (R3-0b's first cut keyed on the AGENT
 *    object instead, which was wrong — the wrapper is not guaranteed stable
 *    across the turn→idle boundary — and intents were silently lost.)
 * 2. **A dropped session's intent cannot keep it alive.** A `WeakMap` releases
 *    the entry with the session, so a disposed conversation's intent can never
 *    fire for a later one. This is why the registry is NOT a
 *    `Map<SessionId, …>`: id keys would retain every intent for the process
 *    lifetime, which is a lifecycle leak, not a fix.
 *
 * `PendingRebaseIntent.sessionId` is therefore a **fail-closed audit check**,
 * not the lookup key: the consumer re-verifies it against `agent.session.id`
 * before acting, so even a mis-keyed intent cannot rebase the wrong
 * conversation.
 */
export interface RebaseIntentRegistry {
  /**
   * Record an intent for one live session. A second request REPLACES the
   * first rather than queueing: two reasons to rebase once are still one
   * rebase.
   * @returns true when this replaced an existing intent.
   */
  set(session: object, intent: PendingRebaseIntent): boolean
  /** Read the outstanding intent without consuming it. */
  peek(session: object): PendingRebaseIntent | undefined
  /**
   * Read AND clear the outstanding intent. The one-shot primitive: a rebase
   * may be attempted at most once per intent, so two idle events cannot
   * produce two roots.
   */
  consume(session: object): PendingRebaseIntent | undefined
  /** Drop any outstanding intent (session change, disposal, failed rebase). */
  clear(session: object): void
  /** Number of sessions with an outstanding intent (telemetry/tests). */
  readonly size: number
}

/**
 * Create an empty registry. Intents are weakly held, so a dropped session's
 * intent never keeps it alive and never fires for a later one.
 */
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
