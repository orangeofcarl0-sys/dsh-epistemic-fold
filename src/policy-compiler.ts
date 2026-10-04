/**
 * R1-D policy compiler: turn measured economics into a context policy
 * decision, deterministically.
 *
 * The R0 policy decided a rebase from a raw token threshold
 * (`frozenCheckpointTokenBudget`). That heuristic cannot express the thing
 * that actually matters: a rebase is only worth its cost if the frozen prefix
 * it removes will be carried for enough FURTHER requests to pay it back. On a
 * cache-dominant model warm tokens are nearly free, so removing them saves
 * very little per request and the payback horizon is long; on an
 * explicit-cache model a rebase also invalidates and rewrites cache, so it is
 * dearer still.
 *
 * This module replaces the threshold with amortized cost:
 *
 *   ΔF = frozenBefore − frozenAfter        tokens removed per request
 *   S  = ΔF · C_warm                       saving per request
 *   H* = C_root / S                        break-even requests
 *
 * and recommends a rebase when `H* <= paybackHorizonRequests`.
 *
 * Three properties are deliberate:
 *
 * 1. **Deterministic and pure.** Same input, same decision — no learned
 *    planner, no hidden state (docs/11 §19).
 * 2. **No provider branch.** The decision reads a profile's numbers; it never
 *    asks whether the provider is DeepSeek or OpenAI (docs/11 §4).
 * 3. **Hard overrides win.** Context pressure and overflow risk remain
 *    unconditional: economics never buys correctness, and it never overrides
 *    an imminent overflow (docs/11 §17, §28).
 *
 * @module dsh-epistemic-fold/policy-compiler
 */

import {
  classifyRegime,
  effectiveRho,
  rhoOf,
  rootBreakEvenRequests,
  tierFor,
} from './economics-profile.ts'
import type { ContextEconomicsProfile, PolicyRegime } from './economics-profile.ts'

/** What the compiler is allowed to decide. */
export type PolicyAction = 'none' | 'leaf' | 'root'

/** The observed inputs a decision may depend on (docs/11 §19). */
export interface ContextPolicyInput {
  readonly economics: ContextEconomicsProfile

  readonly telemetry: {
    /** Provider-reported cache reads, when a live run supplied them. */
    readonly observedCacheReadTokens?: number
    readonly observedCacheWriteTokens?: number
    readonly observedCacheMissTokens?: number
    /** Frozen-prefix tokens currently on the surface. */
    readonly frozenTokens: number
    /**
     * How many frozen checkpoints the prefix is made of. After a rebase
     * exactly ONE remains, so this is what turns a total into a removable
     * amount — without it the removal is unknowable.
     */
    readonly frozenCheckpointCount: number
    /** Verbatim tail tokens currently on the surface. */
    readonly rawTailTokens: number
    /** Total prompt tokens for the current request. */
    readonly promptTokens: number
    /** Pressure folds since the last rebase — the anti-oscillation cadence. */
    readonly recentFoldCadence: number
  }

  readonly pressure: {
    readonly contextWindow: number
    readonly currentTokens: number
  }

  /** Policy parameters (never algorithm constants). */
  readonly policy: {
    /**
     * Rebase when the break-even horizon is at most this many requests.
     * A policy parameter rather than a prediction of remaining turns
     * (docs/11 §17 explicitly forbids the latter in v1).
     */
    readonly paybackHorizonRequests: number
    /** Realized cache hit rate; defaults to 1 (fully realized) when unmeasured. */
    readonly realizationRate?: number
    /** Fold when the prompt exceeds this fraction of the window. */
    readonly pressureRatio: number
    /** One-time cost of a compaction call, in profile currency. */
    readonly compactionCost?: number
    /** Consecutive folds required before a rebase may fire again. */
    readonly rebaseCooldownFolds?: number
    /**
     * Whether a leaf fold is available as an option. Defaults to true.
     *
     * When false — the caller has already established that no leaf can
     * restore headroom, e.g. because the frozen prefix alone exceeds the
     * threshold — a hard override must NOT demand a leaf. Demanding an
     * impossible action is worse than useless: it is exactly the
     * fold-every-step loop, restated as policy. In that state the only
     * reduction that can work is a rebase, so the overrides return `root`.
     */
    readonly leafAvailable?: boolean
  }
}

/** The compiler's decision, fully explained (docs/11 §19). */
export interface ContextPolicyDecision {
  readonly regime: PolicyRegime
  readonly action: PolicyAction
  /**
   * Whether a leaf checkpoint should carry a full snapshot or a delta.
   * Always `snapshot` in R1: Delta Leaf was measured and rejected by the
   * R1-B gate, so no policy may select it yet.
   */
  readonly leafRepresentation: 'snapshot' | 'delta'
  readonly semanticMode: 'none' | 'rationale'
  /** Estimated cost of the chosen action under this profile. */
  readonly estimatedCost: number
  /** Break-even request count for a rebase, when one is computable. */
  readonly breakEvenRequests?: number
  /** Whether the decision came from a hard override rather than economics. */
  readonly overridden: boolean
  readonly reason: string
}

const DEFAULT_COMPACTION_COST = 0

/**
 * Decide the context policy for one request.
 *
 * @param input - economics, telemetry, pressure, and policy parameters.
 * @returns a fully explained, deterministic decision.
 * @throws when the profile cannot price the request (no usable tier), since
 *   a silent default here would be an unpriced policy.
 */
export function compileContextPolicy(input: ContextPolicyInput): ContextPolicyDecision {
  const { economics, telemetry, pressure, policy } = input
  const tier = tierFor(economics, telemetry.promptTokens)
  if (!Number.isFinite(tier.inputMissPerM) || tier.inputMissPerM < 0) {
    throw new Error('policy-compiler: economics profile has no usable input pricing')
  }

  const realizationRate = policy.realizationRate ?? 1
  // ρ is tier-dependent, so the classification must use THIS request's prompt
  // size: a small prompt can be cache-dominant while a large one under the
  // same profile is not.
  const rho = rhoOf(economics, telemetry.promptTokens)
  const regime = classifyRegime({ rho, realizationRate })
  const compactionCost = policy.compactionCost ?? DEFAULT_COMPACTION_COST

  // --- Hard overrides: economics never buys correctness or ignores overflow.
  // When no leaf is available (the caller established that a leaf cannot
  // restore headroom), the only reduction that can work is a rebase, so the
  // override demands `root`. Demanding an impossible leaf here would restate
  // the fold-every-step loop as policy.
  const leafAvailable = policy.leafAvailable ?? true
  const forcedAction: PolicyAction = leafAvailable ? 'leaf' : 'root'
  const pressureRatio = pressure.currentTokens / pressure.contextWindow
  if (pressureRatio >= 1) {
    return {
      regime,
      action: forcedAction,
      leafRepresentation: 'snapshot',
      semanticMode: 'none',
      estimatedCost: 0,
      overridden: true,
      reason: leafAvailable
        ? `context overflow (${pressure.currentTokens}/${pressure.contextWindow}); emergency reduction overrides economics`
        : `context overflow (${pressure.currentTokens}/${pressure.contextWindow}); no leaf can restore headroom, so a rebase is required`,
    }
  }
  if (pressureRatio >= policy.pressureRatio) {
    return {
      regime,
      action: forcedAction,
      leafRepresentation: 'snapshot',
      semanticMode: 'none',
      estimatedCost: 0,
      overridden: true,
      reason: leafAvailable
        ? `context pressure ${(pressureRatio * 100).toFixed(1)}% >= ${(policy.pressureRatio * 100).toFixed(1)}%; pressure overrides economics`
        : `context pressure ${(pressureRatio * 100).toFixed(1)}% >= ${(policy.pressureRatio * 100).toFixed(1)}% and no leaf can restore headroom; a rebase is required`,
    }
  }

  // --- Anti-oscillation: a rebase needs enough intervening folds.
  const cooldown = policy.rebaseCooldownFolds ?? 0
  if (telemetry.recentFoldCadence < cooldown) {
    return {
      regime,
      action: 'none',
      leafRepresentation: 'snapshot',
      semanticMode: 'none',
      estimatedCost: 0,
      overridden: true,
      reason: `only ${telemetry.recentFoldCadence} folds since the last rebase (cooldown ${cooldown}); suppressing rebase`,
    }
  }

  // --- Economics: is a rebase's cost repaid within the policy horizon?
  // After a rebase exactly ONE root checkpoint stays frozen, so the removable
  // amount is the prefix minus a single checkpoint's share of it. With one
  // checkpoint there is nothing to remove and no rebase can pay back.
  //
  // The share is the AVERAGE (`frozenTokens / count`), deliberately, not the
  // price of a specific surviving node: which checkpoint survives is not known
  // before the rebase, and break-even only needs an expected reclaim. A precise
  // post-rebase price exists (`frontier.frozen[last]`), but using it here would
  // report the outcome of one particular rebase as if it were the estimate.
  const count = Math.max(0, Math.floor(telemetry.frozenCheckpointCount))
  const expectedFrozenAfter = count <= 1 ? telemetry.frozenTokens : telemetry.frozenTokens / count
  const breakEven = rootBreakEvenRequests({
    profile: economics,
    frozenBefore: telemetry.frozenTokens,
    frozenAfter: Math.min(expectedFrozenAfter, telemetry.frozenTokens),
    realizationRate,
    promptTokens: telemetry.promptTokens,
    compactionCost,
    ...(telemetry.observedCacheMissTokens === undefined
      ? {}
      : { invalidatedTokens: telemetry.observedCacheMissTokens }),
    ...(telemetry.observedCacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: telemetry.observedCacheWriteTokens }),
  })

  if (breakEven !== undefined && breakEven <= policy.paybackHorizonRequests) {
    return {
      regime,
      action: 'root',
      leafRepresentation: 'snapshot',
      semanticMode: 'none',
      estimatedCost: compactionCost,
      breakEvenRequests: breakEven,
      overridden: false,
      reason: `rebase break-even ${breakEven.toFixed(1)} requests <= horizon ${policy.paybackHorizonRequests}`
        + ` (regime ${regime}, rho_eff ${effectiveRho(rho, realizationRate).toFixed(3)})`,
    }
  }

  return {
    regime,
    action: 'none',
    leafRepresentation: 'snapshot',
    semanticMode: 'none',
    estimatedCost: 0,
    ...(breakEven === undefined ? {} : { breakEvenRequests: breakEven }),
    overridden: false,
    reason: breakEven === undefined
      ? 'no frozen prefix to rebase; nothing to amortize'
      : `rebase break-even ${breakEven.toFixed(1)} requests > horizon ${policy.paybackHorizonRequests}; keeping the warm prefix is cheaper`,
  }
}
