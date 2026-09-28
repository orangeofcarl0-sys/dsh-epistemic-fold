/**
 * Evaluation metrics (R0-C1): exact implementations of
 * docs/09_EVALUATION_METRICS_SPEC.md. Every function is pure so the same
 * input fixture reproduces an identical JSON result (work-order gate §4).
 *
 * @module eval/metrics
 */

/** Shared Prefix Nodes: first index where previous and current diverge. */
export function sharedPrefixNodes(
  previous: readonly unknown[],
  current: readonly unknown[],
): number {
  const shared = Math.min(previous.length, current.length)
  for (let index = 0; index < shared; index += 1) {
    if (previous[index] !== current[index]) return index
  }
  return shared
}

/**
 * Shared Prefix Tokens — priced by the PREVIOUS request's tokens
 * (spec §3: SPT = Σ Tokens(P_i) for i < m).
 */
export function sharedPrefixTokens(
  previousTokens: readonly number[],
  position: number,
): number {
  let total = 0
  for (let index = 0; index < position && index < previousTokens.length; index += 1) {
    total += previousTokens[index]!
  }
  return total
}

/** Invalidated Suffix Tokens — Σ Tokens(P_i) for i ≥ m, previous pricing. */
export function invalidatedSuffixTokens(
  previousTokens: readonly number[],
  position: number,
): number {
  let total = 0
  for (let index = position; index < previousTokens.length; index += 1) {
    total += previousTokens[index]!
  }
  return total
}

/** One realized fold's reclaimed tokens; only positive reductions count. */
export function reclaimedTokens(tokensBefore: number, tokensAfter: number): number {
  return Math.max(0, tokensBefore - tokensAfter)
}

/** PMA = Σ IST / Σ R; undefined when no tokens were reclaimed. */
export function prefixMutationRatio(invalidatedTotal: number, reclaimedTotal: number): number | undefined {
  if (reclaimedTotal === 0) return undefined
  return invalidatedTotal / reclaimedTotal
}

/** Prompt exposure summary (spec §6): total/mean/median/peak/p95. */
export interface PromptExposure {
  readonly totalPromptTokens: number
  readonly meanPromptTokens: number
  readonly medianPromptTokens: number
  readonly peakPromptTokens: number
  readonly p95PromptTokens: number
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (p / 100) * (sorted.length - 1)
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  if (lower === upper) return sorted[lower]!
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (rank - lower)
}

export function promptExposure(promptTokens: readonly number[]): PromptExposure {
  const total = promptTokens.reduce((sum, value) => sum + value, 0)
  return {
    totalPromptTokens: total,
    meanPromptTokens: promptTokens.length === 0 ? 0 : total / promptTokens.length,
    medianPromptTokens: percentile(promptTokens, 50),
    peakPromptTokens: promptTokens.length === 0 ? 0 : Math.max(...promptTokens),
    p95PromptTokens: percentile(promptTokens, 95),
  }
}

/** Frozen checkpoint load summary (spec §7). */
export interface FrozenSummary {
  readonly meanFrozenTokens: number
  readonly peakFrozenTokens: number
  readonly frozenShareOfPrompt: number
}

export function frozenSummary(
  frozenTokens: readonly number[],
  promptTokens: readonly number[],
): FrozenSummary {
  const mean = frozenTokens.length === 0 ? 0 : frozenTokens.reduce((sum, value) => sum + value, 0) / frozenTokens.length
  const peak = frozenTokens.length === 0 ? 0 : Math.max(...frozenTokens)
  const promptTotal = promptTokens.reduce((sum, value) => sum + value, 0)
  const frozenTotal = frozenTokens.reduce((sum, value) => sum + value, 0)
  return {
    meanFrozenTokens: mean,
    peakFrozenTokens: peak,
    frozenShareOfPrompt: promptTotal === 0 ? 0 : frozenTotal / promptTotal,
  }
}

/** Context Regret@k (spec §10): recalled tokens / reclaimed tokens. */
export function contextRegret(recalledTokens: readonly number[], reclaimedTotal: number): number {
  const sum = recalledTokens.reduce((sum, value) => sum + value, 0)
  if (reclaimedTotal === 0) return sum === 0 ? 0 : Number.POSITIVE_INFINITY
  return sum / reclaimedTotal
}

/** Cache-adjusted cost (spec §16): EstimatedMiss + ρ·SharedPrefix. */
export function cacheAdjustedCost(options: {
  promptTokens: number
  sharedPrefixTokens: number
  rho: number
  auxiliaryInputTokens?: number
  auxiliaryOutputTokens?: number
  auxiliaryOutputWeight?: number
  recallReturnedTokens?: number
}): number {
  const estimatedMiss = options.promptTokens - options.sharedPrefixTokens
  const lambdaO = options.auxiliaryOutputWeight ?? 1
  return estimatedMiss
    + options.rho * options.sharedPrefixTokens
    + (options.auxiliaryInputTokens ?? 0)
    + lambdaO * (options.auxiliaryOutputTokens ?? 0)
    + (options.recallReturnedTokens ?? 0)
}

/** Break-even ρ where Cost_ρ(EF) = Cost_ρ(Basic); undefined when parallel. */
export function breakEvenRho(basic: { missTokens: number; hitTokens: number }, ef: { missTokens: number; hitTokens: number }): number | undefined {
  const hitDelta = basic.hitTokens - ef.hitTokens
  const missDelta = ef.missTokens - basic.missTokens
  if (hitDelta === 0) return undefined
  return missDelta / hitDelta
}

/** Duplicate Work Rate (spec §11): avoidable repeats / post-boundary actions. */
export function duplicateWorkRate(
  avoidableRepeatedActions: number,
  postBoundaryActions: number,
): number {
  if (postBoundaryActions === 0) return 0
  return avoidableRepeatedActions / postBoundaryActions
}
