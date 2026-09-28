/**
 * R2-E price dominance: is Epistemic Fold cheaper than Basic, on the model
 * actually routed?
 *
 * R2's objective is deliberately narrow:
 *
 *   Q_EF >= Q_Basic - ε   AND   C_EF < C_Basic
 *
 * i.e. no worse in quality, strictly cheaper. That replaces the earlier goal
 * of proving EF *more reliable* — the R1 live tier found no behavioral
 * difference to prove at small scale, so the honest engineering question is
 * whether EF can at least pay for itself.
 *
 * The load-bearing definition is COST. Raw prompt tokens are not cost: on a
 * cache-dominant model, 100K mostly-warm tokens can be cheaper than 50K that
 * keeps going cold. So cost is computed from the run's own MEASURED warm/cold
 * split, priced under the routed model's profile with the MEASURED realization
 * rate (R1 measured h = 0.910 on the live route, not the assumed 1.0).
 *
 * Two ratios come out, and only their combination is a decision:
 *
 *   BCR = C_policy / C_Basic     < 1 means cheaper
 *   BQR = Q_policy / Q_Basic     >= 1 means no worse
 *
 * @module eval/dominance
 */

import type { ContextEconomicsProfile } from '../../src/economics-profile.ts'

/** One arm's measured cost inputs for one workload. */
export interface ArmCostInput {
  /** Total prompt tokens summed across the run. */
  readonly promptTokens: number
  /** Of those, the tokens that survived from the previous request (warm). */
  readonly warmTokens: number
  /** Peak prompt tokens observed. */
  readonly peakTokens: number
  /** Auxiliary compaction input tokens charged to the same budget. */
  readonly auxiliaryInputTokens?: number
  /** Auxiliary compaction output tokens. */
  readonly auxiliaryOutputTokens?: number
  /** Recall-returned tokens injected back into context. */
  readonly recallTokens?: number
}

/** The three cost components, kept separate so a claim can be attributed. */
export interface CostComponents {
  readonly missCost: number
  readonly hitCost: number
  readonly cacheWriteCost: number
  readonly auxiliaryCost: number
  readonly totalCost: number
}

/**
 * Price one arm's run under a profile.
 *
 * The warm/cold split comes from the RUN, not from an assumption: the
 * architectural claim "these tokens survived the previous request" is what
 * `warmTokens` measures, and the realization rate is the measured share of
 * those that the provider actually served from cache.
 *
 * @param input - the arm's measured tokens.
 * @param profile - the routed model's economics.
 * @param realizationRate - measured cache hit rate in [0, 1].
 * @returns the cost decomposition; `totalCost` is what BCR compares.
 */
export function priceArm(
  input: ArmCostInput,
  profile: ContextEconomicsProfile,
  realizationRate: number,
): CostComponents {
  const h = Math.min(1, Math.max(0, realizationRate))
  const hitTokens = input.warmTokens * h
  const coldTokens = Math.max(0, input.promptTokens - input.warmTokens) + (input.warmTokens - hitTokens)

  const tier = profile.pricing
  const perM = (tokens: number, price: number): number => (tokens / 1_000_000) * price
  const missCost = perM(coldTokens, tier.inputMissPerM)
  const hitCost = perM(hitTokens, tier.inputHitPerM)
  // Recall-returned tokens are fresh input by definition: they were just
  // injected into the request and cannot have been in the previous prefix.
  const recallCost = perM(input.recallTokens ?? 0, tier.inputMissPerM)
  const auxiliaryCost = perM(input.auxiliaryInputTokens ?? 0, tier.inputMissPerM)
    + perM(input.auxiliaryOutputTokens ?? 0, tier.outputPerM)
  return {
    missCost: missCost + recallCost,
    hitCost,
    cacheWriteCost: 0,
    auxiliaryCost,
    totalCost: missCost + recallCost + hitCost + auxiliaryCost,
  }
}

/** One workload's comparison of a policy against Basic. */
export interface DominanceRow {
  readonly workload: string
  readonly policy: string
  readonly profile: string
  readonly basicCost: number
  readonly policyCost: number
  /** BCR = C_policy / C_Basic. Below 1 is the objective. */
  readonly bcr: number
  /** BQR = Q_policy / Q_Basic. At or above 1 is the objective. */
  readonly bqr: number
  readonly basicPeakTokens: number
  readonly policyPeakTokens: number
  /** Whether this row meets the full dominance condition. */
  readonly dominates: boolean
}

/** A full matrix plus its verdict. */
export interface DominanceMatrix {
  readonly rows: readonly DominanceRow[]
  /** Mean BCR across workloads, weighting each workload equally. */
  readonly meanBcr: number
  /** Workloads where the policy is cheaper than Basic. */
  readonly cheaperCount: number
  /** Workloads where the policy is not worse in quality. */
  readonly notWorseCount: number
  readonly totalCount: number
  /**
   * Gate P (parity): no worse in quality and not more expensive, everywhere.
   */
  readonly parityGate: boolean
  /**
   * Gate D (dominance): no worse in quality and at least `delta` cheaper,
   * everywhere.
   */
  readonly dominanceGate: boolean
}

/**
 * Build the dominance matrix.
 *
 * @param rows - one row per (workload, policy, profile) cell.
 * @param options - the dominance margin δ (default 0.05, i.e. 5% cheaper).
 * @returns the matrix with both gates evaluated.
 */
export function dominanceMatrix(
  rows: readonly DominanceRow[],
  options: { readonly delta?: number } = {},
): DominanceMatrix {
  const delta = options.delta ?? 0.05
  const totalCount = rows.length
  const meanBcr = totalCount === 0
    ? Number.NaN
    : rows.reduce((sum, row) => sum + row.bcr, 0) / totalCount
  const cheaperCount = rows.filter(row => row.bcr < 1).length
  const notWorseCount = rows.filter(row => row.bqr >= 1).length
  return {
    rows: [...rows],
    meanBcr,
    cheaperCount,
    notWorseCount,
    totalCount,
    parityGate: totalCount > 0 && cheaperCount === totalCount && notWorseCount === totalCount,
    dominanceGate: totalCount > 0
      && rows.every(row => row.bqr >= 1 && row.bcr < 1 - delta),
  }
}

/** Render a dominance matrix as Markdown, for a generated report. */
export function dominanceToMarkdown(matrix: DominanceMatrix, delta = 0.05): string {
  const lines = [
    `| Workload | Policy | Profile | BCR | BQR | Basic cost | Policy cost | Peak (B→P) | Dominates |`,
    `|---|---|---|---:|---:|---:|---:|---|---|`,
    ...matrix.rows.map(row =>
      `| ${row.workload} | ${row.policy} | ${row.profile} | ${row.bcr.toFixed(3)} | `
      + `${row.bqr.toFixed(3)} | ${row.basicCost.toFixed(4)} | ${row.policyCost.toFixed(4)} | `
      + `${row.basicPeakTokens}→${row.policyPeakTokens} | ${row.dominates ? 'yes' : 'no'} |`),
    '',
    `- Mean BCR: **${Number.isNaN(matrix.meanBcr) ? 'n/a' : matrix.meanBcr.toFixed(3)}**`,
    `- Cheaper than Basic: **${matrix.cheaperCount}/${matrix.totalCount}**`,
    `- No worse in quality: **${matrix.notWorseCount}/${matrix.totalCount}**`,
    `- Gate P (parity: BQR >= 1 and BCR < 1 everywhere): **${matrix.parityGate ? 'PASS' : 'FAIL'}**`,
    `- Gate D (dominance: BQR >= 1 and BCR < ${(1 - delta).toFixed(2)} everywhere): **${matrix.dominanceGate ? 'PASS' : 'FAIL'}**`,
  ]
  return lines.join('\n')
}
