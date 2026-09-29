/**
 * The production idle-rebase consumer (R3-0b).
 *
 * R2-C's economic rebase was real but its only consumer was a benchmark hook.
 * The installed plugin recommended a rebase and nobody performed it, so every
 * E3 number in the R2 report described "EF engine + benchmark maintenance
 * policy", not the shipped product. This module is the missing half.
 *
 * The seam is `agent/status` reaching `idle`, which is exactly when a root
 * fold is admissible: the manual path needs no open turn and an idle agent
 * whose `runMaintenance` bracket is free. The flow is:
 *
 *   pressure turn → leaf refused → PendingRebaseIntent recorded
 *   turn ends → agent/status = idle → consumer fires
 *   re-measure the CURRENT surface → re-run the policy compiler
 *     ├── no longer worth a rebase → drop the intent
 *     └── still justified          → agent.runMaintenance → compactNow
 *
 * Three disciplines are load-bearing:
 *
 * 1. **Recommendation is not authority.** The intent carries no measurement,
 *    cost, or span — all of those go stale. The consumer re-measures and
 *    re-decides; the intent only says "go look again".
 * 2. **One-shot.** The intent is CONSUMED, so one recommendation yields at
 *    most one root. Two idle events cannot produce two roots, and a failed
 *    attempt is not silently retried forever.
 * 3. **Fail closed.** If the agent is already busy, `runMaintenance` throws
 *    synchronously; the consumer swallows that and drops the intent rather
 *    than re-arming, because re-arming is how an idle→root→idle→root loop
 *    starts.
 *
 * @module dsh-epistemic-fold/idle-rebase
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { EpistemicFoldEngine } from './engine.ts'
import { intentMatchesSession } from './rebase-intent.ts'
import type { PendingRebaseIntent, RebaseIntentRegistry } from './rebase-intent.ts'

/** Why an idle rebase attempt ended the way it did. */
export type IdleRebaseOutcome =
  /** No intent was outstanding — the common case. */
  | 'no_intent'
  /** The intent described a different session; dropped without acting. */
  | 'session_changed'
  /** The surface was re-measured and a rebase is no longer justified. */
  | 'not_justified'
  /** The agent was busy; the intent was dropped rather than re-armed. */
  | 'busy'
  /** A root fold ran. */
  | 'rebased'
  /** The fold was attempted and failed; the intent is dropped. */
  | 'failed'

/** One attempt's record, for telemetry and tests. */
export interface IdleRebaseAttempt {
  readonly outcome: IdleRebaseOutcome
  readonly intent?: PendingRebaseIntent
  readonly reason?: string
}

/** Dependencies the consumer needs. */
export interface IdleRebaseDeps {
  readonly ctx: Context
  readonly engine: EpistemicFoldEngine
  readonly intents: RebaseIntentRegistry
  /** Observation hook; the plugin logs through it and tests assert on it. */
  readonly onAttempt?: (attempt: IdleRebaseAttempt) => void
}

/**
 * Run one idle rebase attempt for an agent.
 *
 * Exported separately from the listener so a test can drive it directly
 * without emitting `agent/status` — but the tests that matter go through the
 * real event, because the point of this module is that the production path
 * and the tested path are the same one.
 *
 * @param deps - engine, intent registry, and observation hook.
 * @param agent - the agent that just became idle.
 * @returns what happened, for telemetry.
 */
export async function runIdleRebase(
  deps: IdleRebaseDeps,
  agent: Agent,
): Promise<IdleRebaseAttempt> {
  const { engine, intents } = deps
  const record = (attempt: IdleRebaseAttempt): IdleRebaseAttempt => {
    deps.onAttempt?.(attempt)
    return attempt
  }

  // One-shot: consume before any await, so a concurrent second idle event
  // finds nothing. This is the whole reason the intent is consumed rather
  // than peeked. Keyed by session, since the idle event's agent wrapper need
  // not be the object the pressure turn used.
  const intent = intents.consume(agent.session)
  if (intent === undefined) return record({ outcome: 'no_intent' })

  if (!intentMatchesSession(intent, agent.session.id)) {
    return record({ outcome: 'session_changed', intent })
  }

  let decision
  try {
    decision = await engine.rebaseDecisionAtIdle(agent)
  } catch (error: unknown) {
    // A re-decision failure is not a reason to fold blindly.
    return record({
      outcome: 'failed',
      intent,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  if (decision === null || decision.action !== 'root') {
    return record({
      outcome: 'not_justified',
      intent,
      reason: decision?.reason ?? 'no routed target for the current session',
    })
  }

  // compactNow establishes its OWN maintenance bracket. Wrapping it in a
  // second one would throw, since the agent can only be in one phase.
  try {
    const result = await engine.compactNow(agent, new AbortController().signal)
    if (result === null) {
      return record({ outcome: 'not_justified', intent, reason: 'no compactable range at idle' })
    }
    return record({ outcome: 'rebased', intent, reason: decision.reason })
  } catch (error: unknown) {
    // `runMaintenance` throws synchronously when turn-driving or another
    // maintenance task already owns the agent. Failing closed is the point:
    // the intent is already consumed, so this cannot become a retry loop.
    const message = error instanceof Error ? error.message : String(error)
    const busy = /already has active work|busy/u.test(message)
    return record({ outcome: busy ? 'busy' : 'failed', intent, reason: message })
  }
}

/**
 * The registration handle for the idle consumer.
 *
 * `settled()` exists because the listener must NOT block the emitting turn —
 * in production the rebase runs while the user's next message queues — but a
 * benchmark has to be able to observe the finished maintenance rather than
 * race it. Exposing the in-flight promise is what lets the test drive the
 * PRODUCTION consumer and still await it, instead of reimplementing the
 * policy to get something awaitable.
 */
export interface IdleRebaseRegistration {
  /** Remove the listener. */
  dispose(): void
  /**
   * Resolve once no idle-triggered maintenance is in flight.
   *
   * @throws when the drain does not converge within
   *   {@link SETTLE_ROUND_LIMIT} rounds. See that constant for why this must
   *   be loud rather than capped.
   */
  settled(): Promise<void>
}

/**
 * How many drain rounds `settled()` tolerates before declaring non-convergence.
 *
 * The cap exists so a bug cannot hang a caller forever, but hitting it is a
 * FAILURE, not a quiet exit. A rebase that keeps producing idle events that
 * keep producing rebases is the `idle → maintenance → idle → maintenance`
 * loop — an architecture bug — and swallowing it would hide exactly the defect
 * the consumer's one-shot discipline exists to prevent. A first version
 * returned silently here, which reported "settled" for a consumer that was
 * still churning.
 *
 * 100 is far above any legitimate chain: a single idle event settles in one
 * round, and a rebase that triggers a further idle event is still only a
 * handful. Reaching 100 means the loop is self-sustaining.
 */
export const SETTLE_ROUND_LIMIT = 100

/**
 * Register the idle consumer against a context.
 *
 * @returns the registration handle; callers wrap `dispose` in `ctx.effect` so
 *   unloading the plugin stops maintenance from firing at all.
 */
export function registerIdleRebaseConsumer(deps: IdleRebaseDeps): IdleRebaseRegistration {
  let inFlight: Promise<unknown> = Promise.resolve()
  const handler = ({ agent, status }: { agent: Agent; status: string }): void => {
    if (status !== 'idle') return
    // The listener is synchronous because the idle phase is claimed
    // synchronously; the work itself is async and contained. The chain keeps
    // `settled()` honest across several idle events.
    inFlight = runIdleRebase(deps, agent).catch((error: unknown) => {
      deps.ctx.logger.warn(
        `[epistemic-fold] idle rebase consumer failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }
  const dispose = deps.ctx.on('agent/status', handler)
  return {
    dispose: () => {
      dispose()
    },
    settled: async () => {
      // A run may itself trigger another idle event; drain until quiet.
      let rounds = 0
      for (;;) {
        const current = inFlight
        await current
        if (current === inFlight) return
        rounds += 1
        if (rounds >= SETTLE_ROUND_LIMIT) {
          throw new Error(
            `epistemic-fold: idle rebase did not settle after ${SETTLE_ROUND_LIMIT} drain rounds; `
            + 'maintenance is still producing idle events that produce more maintenance. '
            + 'This is the idle→rebase→idle loop the one-shot intent is meant to prevent, '
            + 'not a slow consumer — the cap is not a substitute for convergence.',
          )
        }
      }
    },
  }
}
