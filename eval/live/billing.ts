/**
 * R4-D: realized billing — RBCR from the provider's OWN bill.
 *
 * Every cost number the project has reported so far is MODELED: it takes an
 * architectural warm/cold split and multiplies by a profile's prices under an
 * assumed or measured realization rate `h`. That was correct while the gaps
 * were large (BCR 1.15), because the model error could not change the verdict.
 *
 * At 0.986 the situation is different. The margins being claimed are now
 * smaller than the assumptions feeding them, so a modeled number can no longer
 * decide a production default. R4 §23 requires the real thing:
 *
 *   RBCR = Σ RealProviderBill(EF) / Σ RealProviderBill(Basic)
 *
 * where the bill is taken from the provider's returned counters — uncached
 * input, cache read, cache write, output — with NO architectural warm × h
 * reconstruction anywhere in the path.
 *
 * The module also computes `h` PER REQUEST rather than reusing the global
 * constant 0.910, because R4 §24's question is whether EF's prefix strategy
 * actually realizes cache on a real provider, and a single averaged constant
 * cannot answer it. Distribution statistics are reported per request CLASS
 * (normal / after leaf / after root / after recall), because an average across
 * those hides exactly the effect being looked for.
 *
 * @module eval/live/billing
 */

import type { ContextEconomicsProfile } from '../../src/economics-profile.ts'
import { costOf, tierFor } from '../../src/economics-profile.ts'

/**
 * What preceded one main-model request, so `h` can be compared across classes.
 *
 * The distinction is the point: a request following a fold arrives with a
 * surface the provider has never seen, so its cache realization SHOULD be
 * worse than a steady-state one. Averaging them together is how that fact gets
 * hidden.
 */
export type RequestClass =
  /** Steady state: nothing structural changed since the previous request. */
  | 'normal'
  /** The first request after a leaf fold appended a checkpoint. */
  | 'after-leaf'
  /** The first request after a root rebase rewrote the frozen prefix. */
  | 'after-root'
  /** The first request after recall materialized folded history. */
  | 'after-recall'

/**
 * One provider call's bill, exactly as the provider reported it.
 *
 * Every field is a provider counter. Nothing here is reconstructed from the
 * architecture, which is what makes the resulting cost a realized one.
 *
 * RC0-B widened this from "one main request" to "one provider call of ANY
 * purpose", because Basic's fold issues a real `compaction` call that costs
 * money and was previously omitted — understating Basic's bill and therefore
 * OVERSTATING how much cheaper EF is.
 */
export interface RequestBill {
  /** Which provider call this was: the user's request, or an auxiliary one. */
  readonly purpose?: 'main' | 'compaction' | 'rationale' | 'other'
  /** Provider-reported uncached input (`cache_miss` / prompt − cached). */
  readonly uncachedInputTokens: number
  /** Provider-reported cache reads. */
  readonly cacheReadTokens: number
  /** Provider-reported cache writes, when the provider bills them. */
  readonly cacheWriteTokens?: number
  readonly outputTokens: number
  /**
   * Total prompt tokens the provider charged for, i.e. uncached + cache read.
   * This is the surface size the model actually saw, and the denominator of
   * the realization rate.
   */
  readonly promptTokens: number
  readonly requestClass: RequestClass
}

/** A run's bills, in request order. */
export type BillLog = readonly RequestBill[]

/**
 * Realized cost of a bill under a profile.
 *
 * Uses `costOf`, the observed-usage path — NOT `modeledCost`. The distinction
 * is the entire point of this module: `modeledCost` derives hit/miss from an
 * architectural prefix, whereas this prices the counters the provider returned.
 */
export function realizedCost(bills: BillLog, profile: ContextEconomicsProfile): number {
  let total = 0
  for (const bill of bills) {
    const tier = tierFor(profile, bill.promptTokens)
    total += costOf(profile, {
      uncachedInputTokens: bill.uncachedInputTokens,
      cacheReadTokens: bill.cacheReadTokens,
      ...(bill.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: bill.cacheWriteTokens }),
      outputTokens: bill.outputTokens,
    }, bill.promptTokens).totalCost
    void tier
  }
  return total
}

/** The bill components for one run, kept separate so the ratio is attributable. */
export interface RealizedBillSummary {
  readonly requestCount: number
  readonly uncachedInputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
  readonly promptTokens: number
  readonly cost: number
  /** `cacheRead / prompt` over the whole run — the run's realized h. */
  readonly realizedHitRate: number
}

/** Sum a run's bills and price them under one profile. */
export function summarizeBill(bills: BillLog, profile: ContextEconomicsProfile): RealizedBillSummary {
  let uncachedInputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let outputTokens = 0
  let promptTokens = 0
  for (const bill of bills) {
    uncachedInputTokens += bill.uncachedInputTokens
    cacheReadTokens += bill.cacheReadTokens
    cacheWriteTokens += bill.cacheWriteTokens ?? 0
    outputTokens += bill.outputTokens
    promptTokens += bill.promptTokens
  }
  return {
    requestCount: bills.length,
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    promptTokens,
    cost: realizedCost(bills, profile),
    realizedHitRate: promptTokens === 0 ? 0 : cacheReadTokens / promptTokens,
  }
}

/**
 * RBCR — the realized baseline cost ratio.
 *
 * Below 1 means EF cost the provider's actual bill less than Basic across the
 * same trajectory. `undefined` when Basic's bill is zero, because a ratio
 * against nothing is not a measurement.
 */
export function realizedBcr(
  candidate: BillLog,
  basic: BillLog,
  profile: ContextEconomicsProfile,
): number | undefined {
  const basicCost = realizedCost(basic, profile)
  if (basicCost <= 0) return undefined
  return realizedCost(candidate, profile) / basicCost
}

/** Descriptive statistics for one distribution. */
export interface Distribution {
  readonly count: number
  readonly mean: number
  readonly median: number
  readonly p10: number
  readonly p90: number
  readonly min: number
  readonly max: number
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = (p / 100) * (sorted.length - 1)
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  if (lower === upper) return sorted[lower]!
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (rank - lower)
}

/** Summarize one distribution; an empty input yields an all-zero summary. */
export function describe(values: readonly number[]): Distribution {
  if (values.length === 0) {
    return { count: 0, mean: 0, median: 0, p10: 0, p90: 0, min: 0, max: 0 }
  }
  const sorted = [...values].sort((left, right) => left - right)
  return {
    count: sorted.length,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    median: percentile(sorted, 50),
    p10: percentile(sorted, 10),
    p90: percentile(sorted, 90),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  }
}

/**
 * Per-request realization rates `h_t = cacheRead / (cacheRead + cacheMiss)`.
 *
 * A request with no prompt tokens has no meaningful rate and is excluded
 * rather than reported as 0, which would drag every average toward a value no
 * request actually realized.
 */
export function perRequestRealization(bills: BillLog): readonly number[] {
  const rates: number[] = []
  for (const bill of bills) {
    const total = bill.cacheReadTokens + bill.uncachedInputTokens
    if (total <= 0) continue
    rates.push(bill.cacheReadTokens / total)
  }
  return rates
}

/** The `h` distribution overall and per request class. */
export interface RealizationReport {
  readonly overall: Distribution
  readonly byClass: Readonly<Record<RequestClass, Distribution>>
  /** Requests excluded from the rates because they carried no prompt tokens. */
  readonly emptyRequestCount: number
}

/** Build the per-class realization report (R4 §24). */
export function realizationReport(bills: BillLog): RealizationReport {
  const grouped: Record<RequestClass, number[]> = {
    'normal': [], 'after-leaf': [], 'after-root': [], 'after-recall': [],
  }
  let emptyRequestCount = 0
  for (const bill of bills) {
    const total = bill.cacheReadTokens + bill.uncachedInputTokens
    if (total <= 0) {
      emptyRequestCount += 1
      continue
    }
    grouped[bill.requestClass].push(bill.cacheReadTokens / total)
  }
  return {
    overall: describe(perRequestRealization(bills)),
    byClass: {
      'normal': describe(grouped.normal),
      'after-leaf': describe(grouped['after-leaf']),
      'after-root': describe(grouped['after-root']),
      'after-recall': describe(grouped['after-recall']),
    },
    emptyRequestCount,
  }
}

/**
 * Paired bootstrap CI for the mean of `deltas` (R4 §26/§27).
 *
 * The release gate is stated on an INTERVAL, not a point estimate: with
 * margins this small, "cheaper on average across my runs" is not the same
 * claim as "cheaper within experimental noise". The bootstrap resamples the
 * paired differences, so it inherits the pairing (same trajectory, same
 * history) instead of assuming independent samples.
 *
 * Deterministic: the PRNG is seeded, so the same deltas give the same
 * interval and a reported CI is reproducible.
 *
 * @param deltas - per-run paired differences.
 * @param options - resample count, confidence level, and PRNG seed.
 * @returns the observed mean and the percentile interval, or `undefined` when
 *   there are too few observations for an interval to mean anything.
 */
export function pairedBootstrapCi(
  deltas: readonly number[],
  options: { readonly resamples?: number; readonly confidence?: number; readonly seed?: number } = {},
): { readonly mean: number; readonly lower: number; readonly upper: number; readonly n: number } | undefined {
  if (deltas.length < 3) return undefined
  const resamples = options.resamples ?? 2_000
  const confidence = options.confidence ?? 0.95
  const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length

  // A small deterministic PRNG (mulberry32) so the interval is reproducible.
  let state = (options.seed ?? 0x9e3779b9) >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }

  const means: number[] = []
  for (let resample = 0; resample < resamples; resample += 1) {
    let sum = 0
    for (let index = 0; index < deltas.length; index += 1) {
      sum += deltas[Math.floor(next() * deltas.length)]!
    }
    means.push(sum / deltas.length)
  }
  means.sort((left, right) => left - right)
  const alpha = (1 - confidence) / 2
  return {
    mean,
    lower: percentile(means, alpha * 100),
    upper: percentile(means, (1 - alpha) * 100),
    n: deltas.length,
  }
}

/** Wins/ties/losses for a paired comparison, with the tie band stated. */
export interface PairedTally {
  readonly wins: number
  readonly ties: number
  readonly losses: number
  /** The relative band inside which a difference counts as a tie. */
  readonly tieBand: number
}

/**
 * Classify paired per-run outcomes (R4 §26).
 *
 * A "tie" needs a band: two runs of a stochastic system are never bit-equal,
 * and calling a 0.1% difference a win would manufacture significance. The band
 * is a parameter so the report states the rule it used.
 */
export function tallyPairs(
  candidate: readonly number[],
  basic: readonly number[],
  tieBand = 0.01,
): PairedTally {
  let wins = 0
  let ties = 0
  let losses = 0
  const count = Math.min(candidate.length, basic.length)
  for (let index = 0; index < count; index += 1) {
    const base = basic[index]!
    const cand = candidate[index]!
    if (base <= 0) continue
    const relative = (cand - base) / base
    if (relative < -tieBand) wins += 1
    else if (relative > tieBand) losses += 1
    else ties += 1
  }
  return { wins, ties, losses, tieBand }
}

/**
 * Whether a paired RBCR result clears the release gate (R4 §27).
 *
 * **The interval must be formed on the RATIO scale, not on deltas.** R4 §27
 * states the gate as "the upper 95% CI of aggregate RBCR < 1", so the resampled
 * quantity is RBCR itself. Passing a delta-scale interval (ratio − 1) would
 * compare an upper bound near 0 against 1 and pass everything — a units bug
 * that makes the gate vacuous, which is why the parameter is named `ratioCi`.
 *
 * `meanTarget` is an engineering margin that is reported, not gated — R4 §27
 * explicitly declines to make 0.95 an immovable constant.
 */
export function passesRbcrGate(
  ratioCi: { readonly mean: number; readonly lower: number; readonly upper: number } | undefined,
  options: { readonly meanTarget?: number } = {},
): { readonly passed: boolean; readonly meanTargetMet: boolean; readonly reason: string } {
  if (ratioCi === undefined) {
    return {
      passed: false,
      meanTargetMet: false,
      reason: 'fewer than 3 paired runs; no interval can be formed and the gate stays OPEN',
    }
  }
  const meanTarget = options.meanTarget ?? 0.95
  // A sane interval on the ratio scale brackets its own mean. If it does not,
  // the caller passed a delta-scale interval and the comparison against 1 would
  // be meaningless — fail loud rather than return a vacuous verdict.
  if (!(ratioCi.lower <= ratioCi.mean && ratioCi.mean <= ratioCi.upper)) {
    throw new Error(
      `billing: RBCR interval [${ratioCi.lower}, ${ratioCi.upper}] does not bracket its mean `
      + `${ratioCi.mean}; the gate is stated on the RATIO scale, and an interval that does not `
      + 'contain its own mean is almost certainly a delta-scale (ratio - 1) interval passed by mistake',
    )
  }
  const passed = ratioCi.upper < 1
  return {
    passed,
    meanTargetMet: ratioCi.mean <= meanTarget,
    reason: passed
      ? `upper CI bound ${ratioCi.upper.toFixed(3)} is below 1 `
        + `(mean ${ratioCi.mean.toFixed(3)}`
        + `${ratioCi.mean <= meanTarget ? '' : `, above the ${meanTarget} margin`})`
      : `upper CI bound ${ratioCi.upper.toFixed(3)} is NOT below 1 (mean ${ratioCi.mean.toFixed(3)})`,
  }
}

/* ------------------------------------------------------------------------ *
 * RC0-B: all-call billing                                                     *
 * ------------------------------------------------------------------------ */

/** One purpose's share of a run's bill. */
export interface PurposeCost {
  readonly purpose: NonNullable<RequestBill['purpose']>
  readonly calls: number
  readonly promptTokens: number
  readonly outputTokens: number
  readonly cost: number
}

/**
 * A run's FULL bill across every provider call, split by purpose.
 *
 * The split matters because the arms differ structurally: Basic pays for a
 * compaction summary per fold, while economy EF runs `semanticMode: 'none'` and
 * pays for none. Reporting only a total would hide which mechanism produced the
 * difference.
 */
export interface FullBillSummary {
  readonly arm: string
  readonly calls: number
  /** Calls that returned nothing and would be retried. */
  readonly failedCalls: number
  /** `failedCalls / calls`; the retry load this arm imposes. */
  readonly retryRate: number
  readonly uncachedInputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
  readonly promptTokens: number
  readonly cost: number
  /** Cost per purpose, in a fixed order so a report is comparable. */
  readonly byPurpose: readonly PurposeCost[]
  /** Cost of calls that had to be retried, charged to the same budget. */
  readonly retryCost: number
}

const PURPOSE_ORDER: ReadonlyArray<NonNullable<RequestBill['purpose']>> =
  ['main', 'compaction', 'rationale', 'other']

/**
 * Summarize a run's FULL bill (RC0-B).
 *
 * Retries are included deliberately. A failed attempt that was retried consumed
 * real tokens and real money, so excluding it would understate the cost of the
 * arm that needed it — and an arm that folds more makes more calls, so it is
 * exactly the arm whose retry exposure matters.
 *
 * @param arm - the arm label, for the report.
 * @param bills - every provider call the recorder observed.
 * @param profile - the routed model's economics.
 * @returns the totals, the per-purpose split, and the retry load.
 */
export function summarizeFullBill(
  arm: string,
  bills: BillLog,
  profile: ContextEconomicsProfile,
): FullBillSummary {
  const purposeTotals = new Map<NonNullable<RequestBill['purpose']>, PurposeCost>()
  for (const purpose of PURPOSE_ORDER) {
    purposeTotals.set(purpose, { purpose, calls: 0, promptTokens: 0, outputTokens: 0, cost: 0 })
  }
  let uncachedInputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let outputTokens = 0
  let promptTokens = 0
  let cost = 0
  let failedCalls = 0

  for (const bill of bills) {
    const purpose = bill.purpose ?? 'main'
    const callCost = realizedCost([bill], profile)
    const entry = purposeTotals.get(purpose)!
    purposeTotals.set(purpose, {
      purpose,
      calls: entry.calls + 1,
      promptTokens: entry.promptTokens + bill.promptTokens,
      outputTokens: entry.outputTokens + bill.outputTokens,
      cost: entry.cost + callCost,
    })
    uncachedInputTokens += bill.uncachedInputTokens
    cacheReadTokens += bill.cacheReadTokens
    cacheWriteTokens += bill.cacheWriteTokens ?? 0
    outputTokens += bill.outputTokens
    promptTokens += bill.promptTokens
    cost += callCost
    if (bill.promptTokens === 0 && bill.outputTokens === 0) failedCalls += 1
  }

  return {
    arm,
    calls: bills.length,
    failedCalls,
    retryRate: bills.length === 0 ? 0 : failedCalls / bills.length,
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    promptTokens,
    cost,
    // Only purposes that actually occurred, in the fixed order.
    byPurpose: PURPOSE_ORDER
      .map(purpose => purposeTotals.get(purpose)!)
      .filter(entry => entry.calls > 0),
    // A failed attempt still consumed whatever it consumed; when it consumed
    // nothing it costs nothing, and this is honestly 0.
    retryCost: bills
      .filter(bill => bill.promptTokens === 0 && bill.outputTokens === 0)
      .reduce((sum, bill) => sum + realizedCost([bill], profile), 0),
  }
}

/**
 * FullTaskRBCR — the release metric (RC0-B).
 *
 * `Σ C(all provider calls, candidate) / Σ C(all provider calls, basic)`.
 *
 * Distinct from `realizedBcr`, which priced only main requests. The difference
 * is not cosmetic: Basic's compaction calls are a real cost the main-only
 * version omitted.
 */
export function fullTaskRbcr(
  candidate: FullBillSummary,
  basic: FullBillSummary,
): number | undefined {
  if (basic.cost <= 0) return undefined
  return candidate.cost / basic.cost
}

/** Render a full-bill summary as Markdown for a report. */
export function fullBillToMarkdown(summary: FullBillSummary): string {
  const lines = [
    `**${summary.arm}**: ${summary.calls} provider calls, cost ${summary.cost.toFixed(4)}, `
    + `retry rate ${(summary.retryRate * 100).toFixed(1)}%`,
    '',
    '| Purpose | Calls | Prompt tokens | Output tokens | Cost |',
    '|---|---:|---:|---:|---:|',
  ]
  for (const entry of summary.byPurpose) {
    lines.push(
      `| ${entry.purpose} | ${entry.calls} | ${entry.promptTokens} | ${entry.outputTokens} | ${entry.cost.toFixed(4)} |`,
    )
  }
  return lines.join('\n')
}
