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
 * Whether any fold could bring the surface under the threshold, and the
 * arithmetic behind that answer.
 *
 * `retainedTokens` is the point of the structure: it is what would be LEFT after
 * the most generous fold available, so a reader can check the conclusion instead
 * of trusting it.
 */
export interface FoldReachability {
  /** False when no legal fold can reach the threshold — stop rather than retry. */
  readonly canReachThreshold: boolean
  readonly totalTokens: number
  readonly thresholdTokens: number
  /** Tokens in the widest legal span (an upper bound on what any fold could take). */
  readonly spanTokens: number
  /** The checkpoint that span would leave behind, which is why reclaim < span. */
  readonly checkpointTokens: number
  /** What the surface would hold after that fold — the number that decides it. */
  readonly retainedTokens: number
  readonly frozenTokens: number
  readonly frozenCount: number
  /** The retention the caller's selector will apply, recorded for the diagnosis. */
  readonly retainTokens: number
  readonly reason: 'reachable' | 'retained_tail_over_threshold' | 'no_legal_span'
}

/** One line naming every term, so a report can carry the reasoning. */
export function describeFoldReachability(assessment: FoldReachability): string {
  const base = `${assessment.totalTokens} estimated tokens >= threshold ${assessment.thresholdTokens}; `
    + `widest legal span ${assessment.spanTokens} tokens (retain ${assessment.retainTokens}), `
    + `checkpoint ${assessment.checkpointTokens.toFixed(0)}, `
    + `retained after folding it ${assessment.retainedTokens.toFixed(0)}; `
    + `frozen prefix ${assessment.frozenTokens} across ${assessment.frozenCount} checkpoint(s)`
  switch (assessment.reason) {
    case 'no_legal_span':
      return `no structurally legal span past the frontier (${base})`
    case 'retained_tail_over_threshold':
      return `folding the widest legal span cannot reach the threshold (${base})`
    case 'reachable':
      return `a fold can reach the threshold (${base})`
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default:
      return base
  }
}

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
 * Whether a fold can reach the threshold AT ALL, computed before attempting one.
 *
 * ## The defect this exists for
 *
 * The leaf retry loop measured its progress only AFTER a fold had committed, and
 * when it ran out of attempts it threw. Two failures followed from that:
 *
 *   1. A surface where no legal span can reach the threshold retried anyway. The
 *      Phase 7 two-pass run hit this twice, reproducibly, at 53K and 68K against
 *      a 16K threshold, and reported it as `pressure-unresolved`.
 *   2. The error's "after N leaf fold attempts" was `compactionRetries + 1` — a
 *      CONSTANT, not a count. The loop can also `break` on a null span, so the
 *      message could claim two attempts after one committed fold. It also printed
 *      only `frozenTokens`, never `frozenCount` or the span, so a reader could not
 *      tell "nothing was foldable" from "the fold did not help".
 *
 * ## Why a rebase is not the answer either
 *
 * The obvious escalation — hand a non-converging surface to the root/emergency
 * rebase — does not work, and this is the part that is easy to get wrong. Both
 * `selectCompactableRange` and `selectLeafSpan` walk the surface from the tail and
 * `break` as soon as `retainTokens` is met. At `retainTokens = 0` that break fires
 * on the FIRST iteration, so the last node is retained at every setting, and a
 * single node larger than the threshold is un-foldable by construction. Measured
 * on a 66K surface whose last node was a 60K tool result:
 *
 *     leaf    (retain 5120)  foldable 6096   retained 60020
 *     rebase  (retain 0)     foldable 6096   retained 60020
 *     emergency rebase committed            -> 60136, still over threshold
 *
 * So escalating converts a loud throw into a SILENT non-convergence. The honest
 * response is to say so before spending a summarization call.
 *
 * ## What this computes
 *
 * The best case, not a prediction: fold the ENTIRE legal span (the most generous
 * range either selector would take), and ask whether the retained remainder could
 * reach the threshold. If it cannot, no sequence of folds can, and the caller
 * should stop with the arithmetic rather than retry.
 *
 * The checkpoint the fold leaves behind is charged, because a leaf replaces its
 * span with a checkpoint that stays on the surface — so the reclaim is
 * `span - checkpoint`, not `span`.
 *
 * @param options.session - session whose surface is measured.
 * @param options.measurement - token-meter measurement matching the surface.
 * @param options.thresholdTokens - the pressure threshold in force.
 * @param options.retainTokens - the retention the caller's selector will use.
 * @returns the arithmetic, and whether any fold could reach the threshold.
 */
export function assessFoldReachability(options: {
  readonly session: Session
  readonly measurement: TokenMeasurement
  readonly thresholdTokens: number
  readonly retainTokens: number
}): FoldReachability {
  const { session, measurement, thresholdTokens, retainTokens } = options
  const breakdown = pressureBreakdown(session, measurement, thresholdTokens)

  // The widest legal span, taken with retain 0 so it is an UPPER bound on what
  // any selector could fold. `selectLeafSpan` with the caller's own retention
  // can only be narrower, which is why the bound is computed this way.
  const widest = selectLeafSpan(session, measurement, 0)
  if (widest === null) {
    return {
      canReachThreshold: false,
      totalTokens: breakdown.totalTokens,
      thresholdTokens,
      spanTokens: 0,
      checkpointTokens: 0,
      retainedTokens: breakdown.totalTokens,
      frozenTokens: breakdown.frozenTokens,
      frozenCount: breakdown.frozenCount,
      retainTokens,
      reason: 'no_legal_span',
    }
  }

  const spanTokens = measurement.nodes
    .slice(widest.startIdx, widest.endIdx + 1)
    .reduce((total, node) => total + node.tokens, 0)
  // A fold replaces the span with a checkpoint that JOINS the frozen prefix, so
  // the reclaim is the difference. A first fold has no prefix to average, so the
  // measured framing constant is used.
  const checkpointTokens = breakdown.frozenCount > 0
    ? breakdown.frozenTokens / breakdown.frozenCount
    : FRAMING_FALLBACK_TOKENS
  const retainedTokens = breakdown.totalTokens - Math.max(0, spanTokens - checkpointTokens)

  return {
    canReachThreshold: retainedTokens < thresholdTokens,
    totalTokens: breakdown.totalTokens,
    thresholdTokens,
    spanTokens,
    checkpointTokens,
    retainedTokens,
    frozenTokens: breakdown.frozenTokens,
    frozenCount: breakdown.frozenCount,
    retainTokens,
    reason: retainedTokens < thresholdTokens ? 'reachable' : 'retained_tail_over_threshold',
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
