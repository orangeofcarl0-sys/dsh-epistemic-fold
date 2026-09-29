/**
 * RC1-A §5/§6: measure the safety reserve instead of guessing it.
 *
 * `headroomTokens: 65536` predates every measurement in this project. It is
 * inherited from Basic's default, and nothing in R0–RC0 ever asked whether the
 * route needs it. The RC0 audit found the consequence: on a 131072-token
 * window the reserve binds, so EF does not fold until 65024 tokens — and R3/R4
 * measured their savings in a regime that folds at 5400. The shipped defaults
 * therefore do not run the policy that was validated.
 *
 * The reserve exists to absorb three things, and only three:
 *
 *   E+  token-meter UNDER-estimation (the meter said X, the provider billed X+E)
 *   G   one-step growth between two pressure checks (an append, a large tool
 *       result, a schema variation, CJK/JSON/coding text)
 *   M   a fixed engineering margin
 *
 * So the question is answerable from data the project already has: every
 * recorded provider call carries both a metered estimate and the provider's own
 * prompt count. This module turns those pairs into distributions and derives
 *
 *   H_safe = P99(E+) + P99(G) + M
 *
 * It is a MEASUREMENT module, not a policy: it returns a recommendation and the
 * evidence behind it, and never writes a default. RC1 §5 is explicit that the
 * point is to answer "is 65K necessary?", not to install a new constant.
 *
 * @module eval/src/safety-reserve
 */

/** One observed (metered estimate, provider count) pair for the same request. */
export interface MeterObservation {
  /** The token meter's own estimate of the request's prompt tokens. */
  readonly meteredTokens: number
  /** The prompt tokens the provider actually charged for. */
  readonly providerPromptTokens: number
  /** Optional label for provenance in a report (`rc0-full-wire`, `w2`, ...). */
  readonly source?: string
}

/**
 * The underestimation `E = provider − metered`, kept SIGNED.
 *
 * Overestimation is not a safety problem (the meter folded earlier than it
 * needed to, which is conservative), so the reserve only has to absorb the
 * positive tail. Reporting the signed distribution anyway keeps the negative
 * side visible: a meter that systematically over-estimates by 20% is a
 * different bug, and hiding it behind a `max(0, ·)` would hide that too.
 */
export interface SignedError {
  readonly value: number
  readonly source?: string
}

/** Distribution of a signed quantity, with the tail the reserve needs. */
export interface ErrorDistribution {
  readonly count: number
  readonly mean: number
  readonly p50: number
  readonly p90: number
  readonly p95: number
  readonly p99: number
  readonly max: number
  readonly min: number
  /**
   * The positive tail `P99(max(0, E))` — the quantity the safety reserve must
   * absorb from meter error alone. Zero when no observation under-estimated.
   */
  readonly p99Positive: number
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = (p / 100) * (sorted.length - 1)
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  if (lower === upper) return sorted[lower]!
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (rank - lower)
}

/** Summarize a signed distribution, including its positive tail. */
export function distributionOf(values: readonly number[]): ErrorDistribution {
  if (values.length === 0) {
    return { count: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0, min: 0, p99Positive: 0 }
  }
  const sorted = [...values].sort((left, right) => left - right)
  const positives = sorted.map(value => Math.max(0, value)).sort((left, right) => left - right)
  return {
    count: sorted.length,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1]!,
    min: sorted[0]!,
    p99Positive: percentile(positives, 99),
  }
}

/**
 * Meter error `E_i = provider_i − metered_i` for each paired observation.
 *
 * @param observations - paired metered/provider counts.
 * @returns the signed errors in input order, carrying their provenance.
 */
export function meterErrors(observations: readonly MeterObservation[]): readonly SignedError[] {
  return observations.map(observation => ({
    value: observation.providerPromptTokens - observation.meteredTokens,
    ...(observation.source === undefined ? {} : { source: observation.source }),
  }))
}

/**
 * One-step growth between consecutive pressure checks.
 *
 * Positive-only by construction: the quantity the reserve absorbs is how much
 * the surface can GROW between two checks, and a surface that shrank between
 * checks (a fold, a truncation) imposes no reserve requirement. Keeping the
 * signed value would let a large negative step cancel a large positive one and
 * understate the reserve.
 */
export function stepGrowths(pressureSequence: readonly number[]): readonly number[] {
  const growths: number[] = []
  for (let index = 1; index < pressureSequence.length; index += 1) {
    growths.push(Math.max(0, pressureSequence[index]! - pressureSequence[index - 1]!))
  }
  return growths
}

/** The reserve the measurements justify, with the inputs that produced it. */
export interface SafetyReserve {
  /** `P99(E+) + P99(G) + margin`. */
  readonly recommendedTokens: number
  readonly meterErrorP99: number
  readonly stepGrowthP99: number
  readonly marginTokens: number
  /** How many observations each term rests on; 0 means the term is unevidenced. */
  readonly meterErrorSamples: number
  readonly stepGrowthSamples: number
  /** Whether BOTH terms have evidence. An unevidenced reserve is not a finding. */
  readonly evidenced: boolean
  readonly note: string
}

/**
 * Derive the safety reserve from measured error and growth.
 *
 * The `M` margin is an explicit argument with a small default, because RC1 §5
 * calls it "a fixed engineering margin" and a hidden constant would be exactly
 * the failure this module exists to fix.
 *
 * @param meterError - the signed meter-error distribution.
 * @param growth - the one-step-growth distribution.
 * @param marginTokens - fixed engineering margin `M`.
 * @returns the recommended reserve plus whether it rests on real evidence.
 */
export function recommendSafetyReserve(
  meterError: ErrorDistribution,
  growth: ErrorDistribution,
  marginTokens = 1_024,
): SafetyReserve {
  const evidenced = meterError.count > 0 && growth.count > 0
  const recommendedTokens = Math.ceil(meterError.p99Positive + growth.p99 + marginTokens)
  const missing: string[] = []
  if (meterError.count === 0) missing.push('meter error')
  if (growth.count === 0) missing.push('one-step growth')
  return {
    recommendedTokens,
    meterErrorP99: meterError.p99Positive,
    stepGrowthP99: growth.p99,
    marginTokens,
    meterErrorSamples: meterError.count,
    stepGrowthSamples: growth.count,
    evidenced,
    note: evidenced
      ? `P99 meter underestimation ${meterError.p99Positive} + P99 one-step growth `
        + `${growth.p99} + margin ${marginTokens}`
      : `NOT EVIDENCED: no observations for ${missing.join(' and ')}; the number is the `
        + 'margin alone and must not be used to justify a configuration',
  }
}

/**
 * Compare a recommended reserve against the shipped one.
 *
 * The verdict is deliberately three-valued. "65K is much larger than needed"
 * and "65K is about right" are different findings, and collapsing them into a
 * boolean would let a 2× overshoot and a 100× overshoot read the same.
 */
export interface ReserveVerdict {
  readonly shippedTokens: number
  readonly recommendedTokens: number
  /** `shipped / recommended`; how many times larger the shipped reserve is. */
  readonly ratio: number
  readonly verdict: 'justified' | 'generous' | 'excessive' | 'insufficient'
  readonly evidenced: boolean
  readonly reason: string
}

/**
 * Judge the shipped reserve against the measurement (RC1-A §39).
 *
 * Bands are stated rather than tuned: within 1.5× either way is `justified`,
 * up to 5× larger is `generous`, beyond that is `excessive`, and smaller than
 * the measurement is `insufficient`. An unevidenced measurement returns
 * `insufficient` with the reason saying why — never a green verdict.
 *
 * @param recommended - the measured reserve.
 * @param shippedTokens - the reserve currently shipped.
 * @returns the verdict with the ratio that produced it.
 */
export function judgeReserve(
  recommended: SafetyReserve,
  shippedTokens: number,
): ReserveVerdict {
  if (!recommended.evidenced) {
    return {
      shippedTokens,
      recommendedTokens: recommended.recommendedTokens,
      ratio: recommended.recommendedTokens === 0
        ? Number.POSITIVE_INFINITY
        : shippedTokens / recommended.recommendedTokens,
      verdict: 'insufficient',
      evidenced: false,
      reason: `the measurement is not evidenced (${recommended.note}), so the shipped reserve `
        + 'cannot be judged; do not change it on this basis',
    }
  }
  const ratio = shippedTokens / recommended.recommendedTokens
  const verdict: ReserveVerdict['verdict'] = ratio < 1 / 1.5
    ? 'insufficient'
    : ratio <= 1.5
      ? 'justified'
      : ratio <= 5
        ? 'generous'
        : 'excessive'
  return {
    shippedTokens,
    recommendedTokens: recommended.recommendedTokens,
    ratio,
    verdict,
    evidenced: true,
    reason: `shipped ${shippedTokens} is ${ratio.toFixed(2)}x the measured recommendation `
      + `${recommended.recommendedTokens} (${recommended.note})`,
  }
}

/** Render the reserve analysis as Markdown for a report. */
export function safetyReserveToMarkdown(
  meterError: ErrorDistribution,
  growth: ErrorDistribution,
  recommended: SafetyReserve,
  verdict: ReserveVerdict,
): string {
  return [
    `| Quantity | n | P50 | P90 | P95 | P99 | max |`,
    `|---|---:|---:|---:|---:|---:|---:|`,
    `| Meter error E (signed) | ${meterError.count} | ${meterError.p50} | ${meterError.p90} `
    + `| ${meterError.p95} | ${meterError.p99} | ${meterError.max} |`,
    `| Meter underestimation E+ | ${meterError.count} | — | — | — | ${meterError.p99Positive} | — |`,
    `| One-step growth G | ${growth.count} | ${growth.p50} | ${growth.p90} `
    + `| ${growth.p95} | ${growth.p99} | ${growth.max} |`,
    '',
    `- Recommended safety reserve: **${recommended.recommendedTokens}** tokens `
    + `(${recommended.note})`,
    `- Shipped reserve: **${verdict.shippedTokens}** tokens — `
    + `**${verdict.verdict}** (${verdict.ratio.toFixed(2)}x)`,
    `- ${verdict.reason}`,
  ].join('\n')
}
