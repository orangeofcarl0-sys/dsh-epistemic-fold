/**
 * RC1.1 §1: component-wise certification — "mechanics verified" and "economy
 * recommended for this route" are DIFFERENT claims.
 *
 * RC1's `CertifiedEconomyProfile` had a logical contradiction, and it was
 * load-bearing: the real cost gate was **OPEN**, yet the profile reported
 * `certified: true` and `recommendedMode()` answered `economy`. The mechanism
 * was a single conflated field — `reuseRatio: 1.0` is a **cache-contract**
 * measurement (the two request shapes cache identically), and it was being fed
 * into `priceEffect.realizedRatio`, which is a **price** claim. Those are
 * different measurements of different things, and one cannot stand in for the
 * other.
 *
 * So certification is split into named components, each with its own verdict:
 *
 *   runtime         the idle rebase path runs on the production seam
 *   cache-contract  the request shape is deterministic and reuses cache
 *   quality         task success is non-inferior (inherited where unaffected)
 *   window          the worst-case request fits with headroom, zero overflows
 *   cost            realized paired cost is below baseline
 *
 * Two derived verdicts, and the distinction is the entire point:
 *
 *   mechanicsCertified  = runtime ∧ cache-contract ∧ quality ∧ window
 *   economyRecommended  = mechanicsCertified ∧ cost
 *
 * A route can therefore be **certified as working and NOT recommended as
 * economical**, which is exactly the state this project is in. Reporting a
 * single boolean made that state unrepresentable, and the boolean that existed
 * defaulted to the flattering answer.
 *
 * @module eval/src/certified-profile
 */

import type { ContextEconomicsProfile } from '../../src/economics-profile.ts'

/** How a claim was established. */
export type EvidenceKind =
  /** Measured against the live provider, with the run recorded. */
  | 'measured'
  /** Inherited from an earlier stage's measurement, not re-taken here. */
  | 'inherited'
  /** Modeled or reasoned, with no direct measurement. */
  | 'unevidenced'

/** One claim, with where it came from. */
export interface CertifiedClaim<T> {
  readonly value: T
  readonly evidence: EvidenceKind
  /** The run, test, or report the claim rests on. */
  readonly source: string
}

/**
 * The state of one certification component.
 *
 * `OPEN` is not `FAIL`: it means the evidence is insufficient to decide, which
 * is a different situation from evidence of a defect. Collapsing the two would
 * make "we have not measured this" look like "this is broken", and — worse in
 * the other direction — would let an unmeasured component be treated as passed.
 */
export type ComponentState = 'PASS' | 'OPEN' | 'FAIL'

/** The components a route is certified on, in report order. */
export const CERTIFICATION_COMPONENTS = [
  'runtime',
  'cache-contract',
  'quality',
  'window',
  'cost',
] as const

export type CertificationComponent = (typeof CERTIFICATION_COMPONENTS)[number]

/** One component's verdict. */
export interface ComponentVerdict {
  readonly component: CertificationComponent
  readonly state: ComponentState
  readonly evidence: EvidenceKind
  /** The measurement this verdict rests on. */
  readonly source: string
  /** What the verdict means, in one line. */
  readonly detail: string
}

/** The trigger parameters the profile describes. */
export interface CertifiedTrigger {
  /** Window fraction the deployment configures. */
  readonly thresholdRatio: number
  /**
   * A SAFETY ESTIMATE from the current sampling scale — deliberately NOT called
   * a production headroom.
   *
   * RC1.1 §2: RC1 measured `H_safe ≈ 9,733` tokens, but the same measurement
   * found the meter's error is **strongly relative and shape-dependent** —
   * CJK +92%, dense JSON +52%, prose −40%. A fixed absolute reserve derived
   * from that sample has not been shown to extrapolate to a 65K-token prompt,
   * where a 90% relative error would be an order of magnitude larger. So this
   * value is reported as an estimate at a stated scale, it is NOT written into
   * the operating configuration, and the shipped 65,536 is left alone.
   */
  readonly safetyReserveEstimate?: {
    readonly tokens: number
    readonly sampledAtPromptTokens: number
    readonly caveat: string
  }
  /**
   * The effective threshold, given a window, a reservation, and a reserve.
   *
   * The reserve is an ARGUMENT rather than a field, and that is deliberate:
   * RC1.1 §2 forbids installing the sampled safety estimate as production
   * headroom, so the profile must not carry a reserve that a caller could
   * mistake for the operating value. The shipped reserve stays where it is, and
   * a caller who wants to ask "what would a different reserve do?" passes it.
   */
  readonly effectiveThresholdFor: (
    contextWindow: number,
    reservedTokens: number,
    headroomTokens: number,
  ) => number
}

/** What was validated about the route's request shape (RC1-D/RC1-E). */
export interface CertifiedCacheContract {
  readonly cacheMode: ContextEconomicsProfile['cache']['mode']
  readonly prefixDeterministic: CertifiedClaim<boolean>
  /**
   * The measured E/B reuse ratio at comparable prompt sizes.
   *
   * This is a CACHE-CONTRACT claim and nothing else. It says the two request
   * shapes reuse cache equally; it says nothing about price. RC1's profile fed
   * this value into `priceEffect.realizedRatio`, which is the contradiction
   * RC1.1 exists to remove.
   */
  readonly reuseRatioAtComparableShape: CertifiedClaim<number>
}

/** What the paired measurement found about price. */
export interface CertifiedPriceEffect {
  /**
   * The realized cost ratio (economy / baseline) from a PAIRED COST
   * measurement. `undefined` when none exists.
   *
   * Deliberately has no default and no fallback: a cache-reuse ratio is not a
   * price ratio, and the type gives a caller nowhere to put one.
   */
  readonly realizedRatio?: number
  readonly intervalUpper?: number
  readonly source: string
}

/** A route's certification, as components rather than one boolean. */
export interface CertifiedEconomyProfile {
  readonly provider: string
  readonly modelPattern: string
  /** ISO date the certification was taken. */
  readonly asOf: string
  readonly trigger: CertifiedTrigger
  readonly cache: CertifiedCacheContract
  readonly priceEffect: CertifiedPriceEffect
  /** Quality is INHERITED where the change cannot affect it. */
  readonly quality: CertifiedClaim<string>
  /**
   * What inputs the quality claim covers.
   *
   * RC1.2 narrowed this. RC1.1 measured the economy preset losing unanchored
   * narrative from the SURFACE and read that as the product boundary; RC1.2
   * then showed the facts ARE recoverable through the product's own recall path
   * (`context_search` → `context_recall`), deterministically and under BOTH
   * semantic modes. So the correct scope is not "declared state only" — it is
   * "declared state is hot on the surface; undeclared history is recoverable
   * through bounded recall", and the model must choose to look.
   */
  readonly qualityScope: string
  readonly components: readonly ComponentVerdict[]
  /**
   * Whether the MECHANICS are verified: runtime, cache contract, quality, and
   * window. This is what "EF's compression mechanism works" means.
   */
  readonly mechanicsCertified: boolean
  /**
   * Whether ECONOMY is recommended for this route. Requires mechanics AND a
   * passing cost gate — so a route whose mechanics are certified and whose cost
   * is OPEN is `mechanicsCertified: true, economyRecommended: false`.
   */
  readonly economyRecommended: boolean
  /** Components that are not PASS, so the blocker is never implicit. */
  readonly blocking: readonly ComponentVerdict[]
  /** What is missing, in prose, for a report. */
  readonly gaps: readonly string[]
}

/** Inputs to certification. Every component is stated or absent, never assumed. */
export interface CertificationEvidence {
  readonly provider: string
  readonly modelPattern: string
  readonly asOf: string
  readonly thresholdRatio: number
  readonly cacheMode: ContextEconomicsProfile['cache']['mode']
  /** Runtime: does the production seam actually carry the mechanism? */
  readonly runtime?: { readonly passed: boolean; readonly source: string; readonly detail: string }
  readonly prefixDeterministic?: { readonly value: boolean; readonly source: string }
  readonly reuseRatio?: { readonly value: number; readonly source: string }
  readonly qualitySource?: string
  readonly qualityPassed?: boolean
  /** What inputs the quality claim covers (RC1.1 §5). */
  readonly qualityScope?: string
  readonly window?: { readonly passed: boolean; readonly source: string; readonly detail: string }
  readonly priceEffect?: CertifiedPriceEffect
  readonly safetyReserveEstimate?: CertifiedTrigger['safetyReserveEstimate']
}

/**
 * A component's verdict from its evidence.
 *
 * Absent evidence is `OPEN`, never `PASS` — the rule that keeps an unmeasured
 * component from being certified by omission.
 */
function verdictOf(
  component: CertificationComponent,
  evidence: { readonly passed: boolean; readonly source: string; readonly detail: string } | undefined,
): ComponentVerdict {
  if (evidence === undefined) {
    return {
      component,
      state: 'OPEN',
      evidence: 'unevidenced',
      source: 'not measured for this route',
      detail: `no ${component} measurement is recorded, so the component is undecided`,
    }
  }
  return {
    component,
    state: evidence.passed ? 'PASS' : 'FAIL',
    evidence: 'measured',
    source: evidence.source,
    detail: evidence.detail,
  }
}

/**
 * Certify a route component by component.
 *
 * @param evidence - the route's measurements, per component.
 * @returns the profile with per-component verdicts and the two derived claims.
 */
export function certifyRoute(evidence: CertificationEvidence): CertifiedEconomyProfile {
  const gaps: string[] = []

  // --- The two components that are measurements rather than pass/fail inputs.
  const deterministic: CertifiedClaim<boolean> = evidence.prefixDeterministic === undefined
    ? { value: false, evidence: 'unevidenced', source: 'not verified for this route' }
    : { value: evidence.prefixDeterministic.value, evidence: 'measured', source: evidence.prefixDeterministic.source }

  const reuse: CertifiedClaim<number> = evidence.reuseRatio === undefined
    ? { value: Number.NaN, evidence: 'unevidenced', source: 'not measured for this route' }
    : { value: evidence.reuseRatio.value, evidence: 'measured', source: evidence.reuseRatio.source }

  const quality: CertifiedClaim<string> = evidence.qualitySource === undefined
    ? { value: 'unknown', evidence: 'unevidenced', source: 'not recorded' }
    : {
      value: evidence.qualityPassed === false ? 'REGRESSED' : 'non-inferior',
      evidence: 'inherited',
      source: evidence.qualitySource,
    }
  // RC1.1 §5 measured a boundary that scopes this claim, so the profile carries
  // it. A quality claim without its input class is the same kind of error as a
  // price claim without its measurement: it reads as unconditional when it is
  // not. The economy preset's `semanticMode: none` makes a checkpoint
  // marker-only, which carries DECLARED state and not unanchored prose.
  const qualityScope: string | undefined = evidence.qualityScope

  const priceEffect: CertifiedPriceEffect = evidence.priceEffect ?? {
    source: 'no paired cost measurement recorded',
  }

  // --- The cache contract needs BOTH its measurements.
  const cacheContract: { passed: boolean; source: string; detail: string } | undefined =
    evidence.prefixDeterministic === undefined || evidence.reuseRatio === undefined
      ? undefined
      : {
        passed: evidence.prefixDeterministic.value && evidence.reuseRatio.value >= 0.95,
        source: `${evidence.prefixDeterministic.source}; ${evidence.reuseRatio.source}`,
        detail: `prefix deterministic ${evidence.prefixDeterministic.value}, `
          + `reuse ratio at comparable shape ${evidence.reuseRatio.value.toFixed(3)}`,
      }

  // --- The cost component, and it reads ONLY the paired price measurement.
  //
  // The gate is RC0 §18/§27's: the upper bound of the paired interval must be
  // below 1. A point estimate below 1 with an interval that straddles it is
  // exactly the dispersion case this project is in, and it is OPEN rather than
  // PASS or FAIL.
  let costVerdict: ComponentVerdict
  if (priceEffect.realizedRatio === undefined) {
    costVerdict = {
      component: 'cost',
      state: 'OPEN',
      evidence: 'unevidenced',
      source: priceEffect.source,
      detail: 'no paired cost measurement exists, so cost is undecided',
    }
  } else if (priceEffect.intervalUpper === undefined) {
    costVerdict = {
      component: 'cost',
      state: 'OPEN',
      evidence: 'measured',
      source: priceEffect.source,
      detail: `point estimate ${priceEffect.realizedRatio.toFixed(3)} has no interval, so the gate `
        + 'cannot be read',
    }
  } else {
    const passed = priceEffect.intervalUpper < 1
    const straddles = priceEffect.realizedRatio < 1 && priceEffect.intervalUpper >= 1
    costVerdict = {
      component: 'cost',
      state: passed ? 'PASS' : straddles ? 'OPEN' : 'FAIL',
      evidence: 'measured',
      source: priceEffect.source,
      detail: passed
        ? `upper interval bound ${priceEffect.intervalUpper.toFixed(3)} < 1`
        : straddles
          ? `point estimate ${priceEffect.realizedRatio.toFixed(3)} is below 1 but the interval `
            + `upper bound ${priceEffect.intervalUpper.toFixed(3)} is not; the gate is undecided `
            + 'because of dispersion'
          : `upper interval bound ${priceEffect.intervalUpper.toFixed(3)} is not below 1`,
    }
  }

  const components: readonly ComponentVerdict[] = [
    verdictOf('runtime', evidence.runtime),
    verdictOf('cache-contract', cacheContract),
    verdictOf('quality', evidence.qualitySource === undefined
      ? undefined
      : {
        passed: evidence.qualityPassed !== false,
        source: evidence.qualitySource,
        detail: evidence.qualityPassed === false
          ? 'quality regressed against the baseline'
          : 'non-inferior against the baseline',
      }),
    verdictOf('window', evidence.window),
    costVerdict,
  ]

  // --- The two derived claims. `mechanicsCertified` deliberately excludes
  // `cost`, which is what makes "mechanics verified, economics open" a
  // representable and reportable state.
  const mechanicsComponents = components.filter(entry => entry.component !== 'cost')
  const mechanicsCertified = mechanicsComponents.every(entry => entry.state === 'PASS')
  const blocking = components.filter(entry => entry.state !== 'PASS')
  const economyRecommended = mechanicsCertified
    && components.find(entry => entry.component === 'cost')?.state === 'PASS'

  for (const entry of blocking) {
    gaps.push(`${entry.component}: ${entry.detail}`)
  }

  return {
    provider: evidence.provider,
    modelPattern: evidence.modelPattern,
    asOf: evidence.asOf,
    trigger: {
      thresholdRatio: evidence.thresholdRatio,
      ...(evidence.safetyReserveEstimate === undefined
        ? {}
        : { safetyReserveEstimate: evidence.safetyReserveEstimate }),
      // The reserve is supplied by the caller, never taken from the safety
      // estimate: RC1.1 §2 forbids installing an unextrapolated estimate into
      // the operating configuration.
      effectiveThresholdFor: (contextWindow, reservedTokens, headroomTokens) =>
        Math.floor(Math.min(
          contextWindow * evidence.thresholdRatio,
          contextWindow - reservedTokens - headroomTokens,
        )),
    },
    cache: {
      cacheMode: evidence.cacheMode,
      prefixDeterministic: deterministic,
      reuseRatioAtComparableShape: reuse,
    },
    priceEffect,
    quality,
    qualityScope: qualityScope
      ?? 'UNSCOPED: no input class was recorded, so this claim must not be read as unconditional',
    components,
    mechanicsCertified,
    economyRecommended,
    blocking,
    gaps,
  }
}

/**
 * Whether a route may be recommended `economy` automatically (RC1 §36).
 *
 * Narrower than RC1's version: it requires `economyRecommended`, which requires
 * a PASSING cost gate. A route whose mechanics are certified but whose cost is
 * OPEN is NOT returned — so `recommendedMode` answers `legacy` for it, which is
 * the correct posture while the price question is undecided.
 *
 * @param profiles - the certified profiles.
 * @param provider - the routed provider.
 * @param model - the routed model.
 * @returns the profile, or `undefined` when the route is not recommended.
 */
export function certifiedProfileFor(
  profiles: readonly CertifiedEconomyProfile[],
  provider: string,
  model: string,
): CertifiedEconomyProfile | undefined {
  return profiles.find(profile =>
    profile.economyRecommended
    && profile.provider === provider
    && matchesPattern(profile.modelPattern, model))
}

/** Minimal glob match, mirroring the economics-profile matcher's semantics. */
function matchesPattern(pattern: string, model: string): boolean {
  if (!pattern.includes('*')) return pattern === model
  const segments = pattern.split('*')
  let cursor = 0
  const first = segments[0]!
  if (!model.startsWith(first)) return false
  cursor = first.length
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index]!
    const isLast = index === segments.length - 1
    if (segment.length === 0) {
      if (isLast) return true
      continue
    }
    if (isLast) return model.endsWith(segment) && model.length >= cursor + segment.length
    const found = model.indexOf(segment, cursor)
    if (found < 0) return false
    cursor = found + segment.length
  }
  return true
}

/**
 * The mode a route should run under (RC1 §36).
 *
 * `economyRecommended → economy`, everything else → `legacy`. RC1.1 widens the
 * fallback: a route that is *mechanically certified* but *not* economically
 * recommended now falls back to `legacy`, because "the mechanism works" is not
 * a reason to switch a default.
 *
 * @param profiles - the certified profiles.
 * @param provider - the routed provider.
 * @param model - the routed model.
 * @returns the recommended mode name.
 */
export function recommendedMode(
  profiles: readonly CertifiedEconomyProfile[],
  provider: string,
  model: string,
): 'economy' | 'legacy' {
  return certifiedProfileFor(profiles, provider, model) === undefined ? 'legacy' : 'economy'
}

/** The one-line project state RC1.1 §6 asks for. */
export function statusLine(profile: CertifiedEconomyProfile): string {
  if (profile.economyRecommended) {
    return 'Economy mechanics certified; route-level cost confirmed.'
  }
  if (profile.mechanicsCertified) {
    return 'Economy mechanics certified; route-level cost recommendation still open.'
  }
  return 'Economy mechanics NOT certified.'
}

/** Render a profile for a report, component table first. */
export function profileToMarkdown(profile: CertifiedEconomyProfile): string {
  const lines = [
    `### ${profile.provider} / ${profile.modelPattern} (as of ${profile.asOf})`,
    '',
    '| Component | State | Evidence |',
    '|---|---|---|',
  ]
  for (const entry of profile.components) {
    lines.push(`| ${entry.component} | **${entry.state}** | ${entry.evidence} |`)
  }
  lines.push(
    '',
    `- Mechanics certified: **${profile.mechanicsCertified ? 'yes' : 'no'}**`,
    `- Economy recommended: **${profile.economyRecommended ? 'yes' : 'NO'}**`,
    `- Status: ${statusLine(profile)}`,
    `- Trigger: thresholdRatio ${profile.trigger.thresholdRatio}`
    + (profile.trigger.safetyReserveEstimate === undefined
      ? ', no safety estimate recorded'
      : `, safety estimate ${profile.trigger.safetyReserveEstimate.tokens} tokens `
        + `(sampled at ~${profile.trigger.safetyReserveEstimate.sampledAtPromptTokens} prompt tokens; `
        + 'NOT a production headroom)'),
    `- Cache: mode ${profile.cache.cacheMode}, prefix deterministic `
    + `${profile.cache.prefixDeterministic.value} (${profile.cache.prefixDeterministic.evidence}), `
    + `reuse ratio ${Number.isNaN(profile.cache.reuseRatioAtComparableShape.value)
      ? 'n/a' : profile.cache.reuseRatioAtComparableShape.value.toFixed(3)}`,
    `- Price effect: ${profile.priceEffect.realizedRatio === undefined
      ? 'NOT MEASURED'
      : `${profile.priceEffect.realizedRatio.toFixed(3)}`
        + (profile.priceEffect.intervalUpper === undefined
          ? '' : ` (upper ${profile.priceEffect.intervalUpper.toFixed(3)})`)}`,
    `- Quality: ${profile.quality.value} (${profile.quality.evidence})`,
    `- Quality scope: ${profile.qualityScope}`,
  )
  if (profile.blocking.length > 0) {
    lines.push('', '**Components not passing:**')
    for (const entry of profile.blocking) {
      lines.push(`- \`${entry.component}\` (${entry.state}): ${entry.detail}`)
    }
  }
  return lines.join('\n')
}
