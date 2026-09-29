/**
 * R2-E / R3 price dominance: is Epistemic Fold cheaper than Basic, on the
 * model actually routed?
 *
 * The load-bearing definition is COST. Raw prompt tokens are not cost: on a
 * cache-dominant model, 100K mostly-warm tokens can be cheaper than 50K that
 * keeps going cold. So cost is computed from the run's own MEASURED warm/cold
 * split, priced under the routed model's profile.
 *
 * R3-0a closed four correctness holes this module had accumulated:
 *
 * 1. **Recall was billed twice.** `recall` is a token-source ATTRIBUTION
 *    bucket, and those tokens are already inside the prompt. Charging
 *    `promptTokens` and then `recallTokens` again over-billed recall-heavy
 *    workloads. Attribution is reporting, never billing: the invariant
 *    `Price(Σ buckets) == Price(prompt)` is enforced by
 *    {@link priceAttribution}, which prices the bucket vector and must agree
 *    with {@link priceArm} to the last unit.
 * 2. **Cache writes were hardcoded to zero.** True for an automatic-cache
 *    provider, false for an explicit-write one. {@link CacheWriteBilling} is
 *    now three-state, and `unknown` is never silently read as `0` — a bill
 *    missing a component is reported as incomplete.
 * 3. **Cache realization was a single global constant.** `h = 0.910` is
 *    MEASURED on the DeepSeek live route and a mere scenario assumption for
 *    every other model. {@link CacheRealizationAssumption} says which it is,
 *    and an unmeasured model yields a `BCR(h)` curve rather than one
 *    pseudo-precise number.
 * 4. **`BQR = 1` stood in for UNKNOWN quality.** The keyless tier cannot
 *    measure quality, so it must report `OPEN`, not "no worse in quality".
 *
 * @module eval/dominance
 */

import type { ContextEconomicsProfile } from '../../src/economics-profile.ts'
import type { TokenBucket } from './token-attribution.ts'

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
  /** Recall-returned tokens injected back into context (reporting only). */
  readonly recallTokens?: number
  /**
   * Tokens the provider reported writing into its cache. Absent means the run
   * did not observe a write, which is NOT the same as a write of zero.
   */
  readonly cacheWriteTokens?: number
}

/**
 * How a provider bills cache writes for one arm.
 *
 * `unknown` is the honest state for an explicit-write profile with no
 * measured write tokens: the bill is missing a term, and the caller must say
 * so rather than substituting zero.
 */
export type CacheWriteBilling =
  | { readonly status: 'measured'; readonly tokens: number; readonly cost: number }
  | { readonly status: 'known-zero' }
  | { readonly status: 'unknown' }

/** The cost components, kept separate so a claim can be attributed. */
export interface CostComponents {
  /** Cold prompt tokens at the miss price (includes unrealized warm tokens). */
  readonly missCost: number
  /** Realized warm tokens at the hit price. */
  readonly hitCost: number
  /** Cache-write billing, three-state; never a fabricated zero. */
  readonly cacheWrite: CacheWriteBilling
  /** Auxiliary compaction calls, charged to the same budget. */
  readonly auxiliaryCost: number
  /** Prompt tokens this bill accounts for; equals the prompt by construction. */
  readonly pricedTokens: number
  /** Sum of the KNOWN components. When `incomplete`, this excludes the write. */
  readonly totalCost: number
  /** True when a billable component could not be measured. */
  readonly incomplete: boolean
}

/** Per-million-token price application. */
function perM(tokens: number, pricePerM: number): number {
  return (tokens / 1_000_000) * pricePerM
}

/**
 * Resolve how one arm's cache writes are billed under one profile.
 *
 * The profile decides whether a write is billable AT ALL (`cacheWritePerM`),
 * and the run decides whether one was observed. Only when the provider bills
 * writes and the run observed none is the answer `unknown` — a provider that
 * does not bill writes has a known-zero cost, and a measured count is priced.
 */
function billCacheWrite(
  input: ArmCostInput,
  profile: ContextEconomicsProfile,
): CacheWriteBilling {
  const writePerM = profile.pricing.cacheWritePerM ?? 0
  if (input.cacheWriteTokens !== undefined) {
    return {
      status: 'measured',
      tokens: input.cacheWriteTokens,
      cost: perM(input.cacheWriteTokens, writePerM),
    }
  }
  return writePerM === 0 ? { status: 'known-zero' } : { status: 'unknown' }
}

/**
 * Price one arm's run under a profile.
 *
 * The warm/cold split comes from the RUN, not from an assumption: the
 * architectural claim "these tokens survived the previous request" is what
 * `warmTokens` measures, and the realization rate is the share of those the
 * provider actually served from cache.
 *
 * @param input - the arm's measured tokens.
 * @param profile - the routed model's economics.
 * @param realizationRate - cache hit rate in [0, 1].
 * @returns the cost decomposition; `totalCost` is what BCR compares.
 */
export function priceArm(
  input: ArmCostInput,
  profile: ContextEconomicsProfile,
  realizationRate: number,
): CostComponents {
  const h = Math.min(1, Math.max(0, realizationRate))
  const warm = Math.min(Math.max(0, input.warmTokens), Math.max(0, input.promptTokens))
  const hitTokens = warm * h
  const coldTokens = Math.max(0, input.promptTokens) - hitTokens

  const tier = profile.pricing
  const missCost = perM(coldTokens, tier.inputMissPerM)
  const hitCost = perM(hitTokens, tier.inputHitPerM)
  const auxiliaryCost = perM(input.auxiliaryInputTokens ?? 0, tier.inputMissPerM)
    + perM(input.auxiliaryOutputTokens ?? 0, tier.outputPerM)
  const cacheWrite = billCacheWrite(input, profile)
  const writeCost = cacheWrite.status === 'measured' ? cacheWrite.cost : 0
  return {
    missCost,
    hitCost,
    cacheWrite,
    auxiliaryCost,
    pricedTokens: coldTokens + hitTokens,
    totalCost: missCost + hitCost + writeCost + auxiliaryCost,
    incomplete: cacheWrite.status === 'unknown',
  }
}

/** One arm's attributed bucket vector plus the warm split it was priced with. */
export interface AttributedArmCost extends ArmCostInput {
  readonly buckets: Readonly<Record<TokenBucket, number>>
}

/**
 * Price an arm from its TOKEN-SOURCE ATTRIBUTION rather than its totals.
 *
 * This exists to make one invariant executable: **attribution must not change
 * the bill.** The bucket vector sums to the prompt, so pricing it must
 * reproduce {@link priceArm} exactly. Recall tokens live in the prompt like any
 * other bucket; they are never added on top.
 *
 * @returns the same components `priceArm` produces for the same inputs.
 * @throws when the buckets do not sum to `promptTokens`, which would mean the
 *   attribution and the measurement describe different requests.
 */
export function priceAttribution(
  input: AttributedArmCost,
  profile: ContextEconomicsProfile,
  realizationRate: number,
): CostComponents {
  const attributed = Object.values(input.buckets).reduce((sum, tokens) => sum + tokens, 0)
  if (attributed !== input.promptTokens) {
    throw new Error(
      `dominance: attribution sums to ${attributed} tokens but the prompt is ${input.promptTokens}; `
      + 'the bucket vector and the measurement describe different requests',
    )
  }
  return priceArm(input, profile, realizationRate)
}

/**
 * What is known about cache realization for one model.
 *
 * A rate measured from provider telemetry is evidence; a rate picked to see
 * what happens is a scenario. Reporting them identically is how an assumption
 * becomes a finding.
 */
export type CacheRealizationAssumption =
  | { readonly source: 'measured'; readonly rate: number; readonly samples?: number }
  | { readonly source: 'scenario'; readonly rate: number }
  | { readonly source: 'unknown' }

/** Scenario rates swept when realization is not measured (R3 §5). */
export const SCENARIO_REALIZATION_RATES: readonly number[] = [0.5, 0.7, 0.8, 0.9, 0.95, 1]

/** The DeepSeek live route's measured realization (R1: 2176 hit / 253 miss). */
export const MEASURED_DEEPSEEK_REALIZATION: CacheRealizationAssumption = {
  source: 'measured',
  rate: 0.91,
  samples: 2429,
}

/** The rates an assumption implies for pricing: one, or the scenario sweep. */
export function realizationRates(assumption: CacheRealizationAssumption): readonly number[] {
  if (assumption.source === 'unknown') return SCENARIO_REALIZATION_RATES
  return [assumption.rate]
}

/** One point of a BCR curve: the realization rate and the ratio it produces. */
export interface BcrPoint {
  readonly realizationRate: number
  readonly bcr: number
}

/**
 * The BCR(h) curve for one arm against Basic.
 *
 * When realization is measured this is a single point — the honest answer.
 * When it is not, it is the sweep, because a number computed at an assumed `h`
 * is a sensitivity, not a measurement.
 */
export function bcrCurve(
  arm: ArmCostInput,
  basic: ArmCostInput,
  profile: ContextEconomicsProfile,
  assumption: CacheRealizationAssumption,
): readonly BcrPoint[] {
  return realizationRates(assumption).map(rate => {
    const basicCost = priceArm(basic, profile, rate).totalCost
    const armCost = priceArm(arm, profile, rate).totalCost
    return { realizationRate: rate, bcr: basicCost === 0 ? Number.NaN : armCost / basicCost }
  })
}

/** What is known about quality. The keyless tier cannot measure it. */
export type QualityEvidence =
  | {
    readonly status: 'measured'
    readonly basic: number
    readonly candidate: number
    /** `candidate / basic`; at or above 1 means no worse. */
    readonly ratio: number
  }
  | { readonly status: 'unknown' }

/** Quality evidence from two measured success counts. */
export function measuredQuality(basic: number, candidate: number): QualityEvidence {
  return {
    status: 'measured',
    basic,
    candidate,
    ratio: basic === 0 ? Number.NaN : candidate / basic,
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
  /** True when `bcr` excludes an unmeasured cache-write term. */
  readonly billIncomplete: boolean
  /** What is known about quality; `unknown` on the keyless tier. */
  readonly quality: QualityEvidence
  readonly basicPeakTokens: number
  readonly policyPeakTokens: number
  /** Cost-only verdict: the policy is strictly cheaper. */
  readonly cheaper: boolean
  /**
   * Full dominance: cheaper AND no worse in quality. Requires quality
   * evidence, so it is `false` — not `true` — when quality is unknown.
   */
  readonly dominates: boolean
}

/** A gate outcome. `OPEN` is a first-class state, not a synonym for PASS. */
export type GateVerdict = 'PASS' | 'FAIL' | 'OPEN'

/** A full matrix plus its verdicts. */
export interface DominanceMatrix {
  readonly rows: readonly DominanceRow[]
  /** Mean BCR across workloads, weighting each workload equally. */
  readonly meanBcr: number
  /** Workloads where the policy is cheaper than Basic. */
  readonly cheaperCount: number
  /** Workloads with MEASURED quality that is not worse. */
  readonly notWorseCount: number
  /** Workloads carrying measured quality evidence at all. */
  readonly qualityMeasuredCount: number
  /** Rows whose bill is missing the cache-write term. */
  readonly incompleteBillingCount: number
  readonly totalCount: number
  /** Cost gate: cheaper everywhere. Needs no quality evidence. */
  readonly costGate: GateVerdict
  /**
   * Quality gate: no worse in quality everywhere. `OPEN` when any row lacks
   * measured quality — an unmeasured quality is not a passed one.
   */
  readonly qualityGate: GateVerdict
}

/**
 * Build the dominance matrix.
 *
 * @param rows - one row per (workload, policy, profile) cell.
 * @returns the matrix with both gates evaluated independently.
 */
export function dominanceMatrix(rows: readonly DominanceRow[]): DominanceMatrix {
  const totalCount = rows.length
  const meanBcr = totalCount === 0
    ? Number.NaN
    : rows.reduce((sum, row) => sum + row.bcr, 0) / totalCount
  const cheaperCount = rows.filter(row => row.cheaper).length
  const measured = rows.filter(row => row.quality.status === 'measured')
  const notWorseCount = measured.filter(
    row => row.quality.status === 'measured' && row.quality.ratio >= 1,
  ).length
  const incompleteBillingCount = rows.filter(row => row.billIncomplete).length

  const costGate: GateVerdict = totalCount === 0
    ? 'OPEN'
    : cheaperCount === totalCount ? 'PASS' : 'FAIL'
  // Quality can only be judged where it was measured. Some measured and some
  // unknown is OPEN: the unmeasured rows could still fail.
  let qualityGate: GateVerdict
  if (measured.length < totalCount) qualityGate = 'OPEN'
  else qualityGate = notWorseCount === totalCount ? 'PASS' : 'FAIL'

  return {
    rows: [...rows],
    meanBcr,
    cheaperCount,
    notWorseCount,
    qualityMeasuredCount: measured.length,
    incompleteBillingCount,
    totalCount,
    costGate,
    qualityGate,
  }
}

/** Render a dominance matrix as Markdown, for a generated report. */
export function dominanceToMarkdown(matrix: DominanceMatrix): string {
  const quality = (evidence: QualityEvidence): string =>
    evidence.status === 'measured' ? evidence.ratio.toFixed(3) : 'OPEN'
  const lines = [
    '| Workload | Policy | Profile | BCR | Bill | BQR | Basic cost | Policy cost | Peak (B→P) | Cheaper | Dominates |',
    '|---|---|---|---:|---|---:|---:|---:|---|---|---|',
    ...matrix.rows.map(row =>
      `| ${row.workload} | ${row.policy} | ${row.profile} | ${row.bcr.toFixed(3)} | `
      + `${row.billIncomplete ? 'excl. write' : 'complete'} | ${quality(row.quality)} | `
      + `${row.basicCost.toFixed(4)} | ${row.policyCost.toFixed(4)} | `
      + `${row.basicPeakTokens}→${row.policyPeakTokens} | ${row.cheaper ? 'yes' : 'no'} | `
      + `${row.dominates ? 'yes' : 'no'} |`),
    '',
    `- Mean BCR: **${Number.isNaN(matrix.meanBcr) ? 'n/a' : matrix.meanBcr.toFixed(3)}**`,
    `- Cheaper than Basic: **${matrix.cheaperCount}/${matrix.totalCount}**`,
    `- Quality MEASURED: **${matrix.qualityMeasuredCount}/${matrix.totalCount}**`
    + (matrix.qualityMeasuredCount === 0 ? ' — the keyless tier cannot measure quality' : ''),
    `- No worse in quality (of those measured): **${matrix.notWorseCount}/${matrix.qualityMeasuredCount}**`,
    `- Bills missing the cache-write term: **${matrix.incompleteBillingCount}/${matrix.totalCount}**`,
    `- Cost gate (cheaper everywhere): **${matrix.costGate}**`,
    `- Quality gate (no worse everywhere): **${matrix.qualityGate}**`,
  ]
  return lines.join('\n')
}
