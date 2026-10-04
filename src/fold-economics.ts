/**
 * The economic leaf-admission and rebase decisions (R2-B, R2-C, R3-0b).
 *
 * These lived inside `engine.ts`, which made the engine the place to read for
 * both "how does a compaction transaction work" and "is this fold worth doing".
 * They are separate concerns: the transaction is the engine's reason to exist,
 * while these are pure policy evaluations over a measurement. Nothing here
 * touches the session, the surface, or a bundle — each function reads a
 * measurement and returns a verdict, which is what makes them testable without
 * a mounted engine and what keeps the engine's own flow readable.
 *
 * The state these decisions need (the anti-oscillation cooldown, the last
 * verdict, the outstanding rebase intents) stays in the engine: it is the
 * engine that observes folds, so it is the engine that knows how long it has
 * been since the last root.
 *
 * @module dsh-epistemic-fold/fold-economics
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { resolveProfile } from './economics-profile.ts'
import { selectLeafSpan } from './leaf-policy.ts'
import { leafMarginalReclaim, pressureBreakdown } from './pressure.ts'
import type { LeafMarginalReclaim } from './pressure.ts'
import { compileContextPolicy } from './policy-compiler.ts'
import type { ContextPolicyDecision } from './policy-compiler.ts'
import type { EfCompactSpec, ResolvedEpistemicFoldConfig } from './policy.ts'
import { routedTarget } from './policy.ts'
import { evaluateRootRebase } from './root-policy.ts'
import type { RootRebaseAdvice } from './root-policy.ts'

/** Why an economic leaf fold was admitted or refused (R2-B telemetry). */
export interface LeafAdmissionVerdict {
  readonly admitted: boolean
  readonly reason:
    | 'admitted'
    | 'frozen_prefix_over_threshold'
    | 'reclaim_below_floor'
    | 'ratio_below_floor'
    | 'no_span'
  readonly detail: string
  readonly reclaim?: LeafMarginalReclaim
}

/**
 * Fallback estimate of a first checkpoint's size when none exists yet. A leaf
 * checkpoint's cost is dominated by the fixed framing preamble, so this is a
 * measured constant (~530 tokens observed) rather than a guess.
 */
export const FRAMING_FALLBACK_TOKENS = 530

/** Pressure folds required between two root rebases (R0-C anti-oscillation). */
export const ROOT_REBASE_COOLDOWN = 5

/**
 * Decide whether a leaf fold is economically admissible (R2-B).
 *
 * Two independent refusals:
 *
 * 1. **The frozen prefix alone is over threshold.** A leaf fold replaces part
 *    of the open tail with a checkpoint that JOINS the frozen prefix, so the
 *    next request is still over threshold and folds again. No leaf can end
 *    this; only a rebase can.
 * 2. **The marginal reclaim is too small.** The fold must reclaim more than the
 *    checkpoint overhead it creates (`minReclaimTokens`) and must reclaim a
 *    meaningful fraction of its span (`minReclaimRatio`).
 *
 * @param options.session - session whose surface is measured.
 * @param options.measurement - token-meter measurement matching the surface.
 * @param options.thresholdTokens - the pressure threshold in force.
 * @param options.minReclaimTokens - the configured net-reclaim floor.
 * @param options.minReclaimRatio - the configured marginal-reclaim-ratio floor.
 * @returns the verdict, with the reason and the measured reclaim.
 */
export function admitLeafEconomically(options: {
  readonly session: Session
  readonly measurement: TokenMeasurement
  readonly thresholdTokens: number
  readonly minReclaimTokens: number
  readonly minReclaimRatio: number
}): LeafAdmissionVerdict {
  const { session, measurement, thresholdTokens, minReclaimTokens, minReclaimRatio } = options
  const breakdown = pressureBreakdown(session, measurement, thresholdTokens)
  if (breakdown.leafCannotSuffice) {
    return {
      admitted: false,
      reason: 'frozen_prefix_over_threshold',
      detail:
        `frozen prefix ${breakdown.frozenTokens} >= threshold ${thresholdTokens}; `
        + 'a leaf fold cannot restore headroom and only adds a checkpoint',
      reclaim: leafMarginalReclaim({
        spanTokens: breakdown.openTokens,
        frozenTokens: breakdown.frozenTokens,
        frozenCount: breakdown.frozenCount,
        fallbackCheckpointTokens: FRAMING_FALLBACK_TOKENS,
      }),
    }
  }

  const span = selectLeafSpan(session, measurement, 0)
  if (span === null) {
    return {
      admitted: false,
      reason: 'no_span',
      detail: 'no structurally legal span past the frontier',
    }
  }
  const spanTokens = measurement.nodes
    .slice(span.startIdx, span.endIdx + 1)
    .reduce((total, node) => total + node.tokens, 0)
  const reclaim = leafMarginalReclaim({
    spanTokens,
    frozenTokens: breakdown.frozenTokens,
    frozenCount: breakdown.frozenCount,
    fallbackCheckpointTokens: FRAMING_FALLBACK_TOKENS,
  })
  if (reclaim.reclaimTokens < minReclaimTokens) {
    return {
      admitted: false,
      reason: 'reclaim_below_floor',
      detail: `net reclaim ${reclaim.reclaimTokens.toFixed(0)} tokens < floor ${minReclaimTokens}`,
      reclaim,
    }
  }
  if (reclaim.reclaimRatio < minReclaimRatio) {
    return {
      admitted: false,
      reason: 'ratio_below_floor',
      detail:
        `MRR ${(reclaim.reclaimRatio * 100).toFixed(1)}% < floor `
        + `${(minReclaimRatio * 100).toFixed(1)}%`,
      reclaim,
    }
  }
  return {
    admitted: true,
    reason: 'admitted',
    detail:
      `reclaim ${reclaim.reclaimTokens.toFixed(0)} tokens, MRR ${(reclaim.reclaimRatio * 100).toFixed(1)}%`,
    reclaim,
  }
}

/**
 * Decide whether an amortized rebase is justified for this request (R2-C).
 *
 * Uses the routed model's own economics profile — never a provider branch — and
 * the measured cache realization. The payback horizon answers the only question
 * that matters: will the frozen prefix be carried for enough further requests
 * to repay the rebase?
 *
 * @param options.agent - agent whose routed target supplies the profile.
 * @param options.measurement - token-meter measurement matching the surface.
 * @param options.spec - the resolved compact spec in force.
 * @param options.config - the resolved EF policy face.
 * @param options.stepsSinceRootRebase - folds since the last root, for the
 *   anti-oscillation cooldown.
 * @param options.atIdle - whether this decision is being made at the idle seam
 *   (R3-0b) rather than inside a pressure turn. It changes nothing about the
 *   economics; it only relaxes the anti-oscillation cooldown, because the
 *   cooldown exists to stop leaf/root thrashing WITHIN a turn, and an idle
 *   re-decision is by construction not part of that churn.
 * @returns the compiled policy decision.
 */
export function evaluateEconomicRebase(options: {
  readonly agent: Agent
  readonly measurement: TokenMeasurement
  readonly spec: EfCompactSpec
  readonly config: ResolvedEpistemicFoldConfig
  readonly stepsSinceRootRebase: number
  readonly atIdle?: boolean
}): ContextPolicyDecision {
  const { agent, measurement, spec, config, stepsSinceRootRebase, atIdle = false } = options
  const target = routedTarget(agent.session)
  const profile = resolveProfile(
    config.rootPolicy.profiles,
    target?.provider ?? '',
    target?.model ?? '',
  )
  const breakdown = pressureBreakdown(agent.session, measurement, spec.thresholdTokens)
  return compileContextPolicy({
    economics: profile,
    telemetry: {
      frozenTokens: breakdown.frozenTokens,
      frozenCheckpointCount: breakdown.frozenCount,
      rawTailTokens: breakdown.openTokens,
      promptTokens: breakdown.totalTokens,
      recentFoldCadence: atIdle ? Number.POSITIVE_INFINITY : stepsSinceRootRebase,
    },
    pressure: {
      contextWindow: spec.contextWindow,
      currentTokens: breakdown.totalTokens,
    },
    policy: {
      paybackHorizonRequests: config.rootPolicy.paybackHorizonRequests,
      realizationRate: config.rootPolicy.realizationRate,
      pressureRatio: config.thresholdRatio,
      compactionCost: config.rootPolicy.compactionCost,
      rebaseCooldownFolds: atIdle ? 0 : ROOT_REBASE_COOLDOWN,
      // Inside a pressure turn this path is reached only AFTER a leaf was
      // refused, so a leaf is not an available action — without this the
      // pressure override would demand the very fold just rejected. At idle the
      // question is purely whether a root is worth it, so a leaf is likewise
      // not the alternative being weighed.
      leafAvailable: false,
    },
  })
}

/**
 * The frozen-budget advice with the anti-oscillation cooldown applied (R0-C).
 *
 * A root fold resets the frozen prefix, and the very next leaf fold would
 * immediately re-exceed a tight budget — without the cooldown the arm
 * degenerates into leaf/root thrashing. The cooldown is applied here so the
 * advice a caller reads is the one that was actually acted on.
 *
 * @param options.session - session whose frozen checkpoints are priced.
 * @param options.measurement - token-meter measurement matching the surface.
 * @param options.budget - configured `frozenCheckpointTokenBudget`.
 * @param options.stepsSinceRootRebase - folds since the last root.
 * @returns the advice, with `recommended` already cooled down.
 */
export function rootRebaseAdvice(options: {
  readonly session: Session
  readonly measurement: TokenMeasurement
  readonly budget: number
  readonly stepsSinceRootRebase: number
}): RootRebaseAdvice {
  const advice = evaluateRootRebase(options.session, options.measurement, options.budget)
  return {
    ...advice,
    recommended: advice.recommended && options.stepsSinceRootRebase >= ROOT_REBASE_COOLDOWN,
  }
}
