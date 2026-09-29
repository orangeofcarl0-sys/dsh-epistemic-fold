/**
 * RC1-G: the certified operating profile.
 *
 * RC1 §34 is a deliberate contraction, and it is the most important structural
 * decision in the stage:
 *
 *   The live evidence comes from ONE DeepSeek-compatible route, and cache
 *   economics are strongly provider-dependent. So the deliverable is not
 *   "economy should be the global default" — it is a CERTIFIED PROFILE for the
 *   route that was actually measured.
 *
 * A profile is therefore a claim with provenance attached:
 *
 *   provider/model   which route this is about
 *   trigger          the operating parameters the evidence supports
 *   cache contract   what was validated about its request shape
 *   price effect     what the paired measurement found
 *   quality          inherited from R4/RC0, and labeled as inherited
 *
 * Three rules make a profile trustworthy rather than promotional:
 *
 * 1. **An uncertified route is not certified by omission.** `certifyRoute`
 *    returns `undefined` for a route with no evidence, and the caller must
 *    handle that. There is no default profile that quietly applies everywhere.
 *
 * 2. **Every claim cites its evidence.** A profile whose `priceEffect` has no
 *    measurement behind it is `unevidenced`, and the type says so.
 *
 * 3. **The profile does not change behavior.** It is DATA — RC1 §37 is explicit
 *    that production `src/` may stay untouched at this stage. Nothing here
 *    writes a default; `mode: economy` remains a user's explicit choice, and
 *    the global automatic default waits for multi-provider certification
 *    (§35/§36).
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

/** The trigger parameters the profile certifies. */
export interface CertifiedTrigger {
  /** Window fraction the deployment configures. */
  readonly thresholdRatio: number
  /**
   * The safety reserve, MEASURED rather than inherited. `undefined` when the
   * route's meter error has not been measured, which makes the reserve claim
   * `unevidenced` rather than silently reusing the shipped default.
   */
  readonly headroomTokens?: number
  /** The effective threshold this implies, in tokens, for a given window. */
  readonly effectiveThresholdFor: (contextWindow: number, reservedTokens: number) => number
}

/** What was validated about the route's request shape (RC1-D). */
export interface CertifiedCacheContract {
  /** The provider's caching mode, from its economics profile. */
  readonly cacheMode: ContextEconomicsProfile['cache']['mode']
  /** Whether prefix determinism was verified byte-for-byte. */
  readonly prefixDeterministic: CertifiedClaim<boolean>
  /** The measured E/B reuse ratio at comparable prompt sizes. */
  readonly reuseRatioAtComparableShape: CertifiedClaim<number>
}

/** What the paired measurement found about price. */
export interface CertifiedPriceEffect {
  /**
   * The realized cost ratio (economy / baseline). `undefined` when no paired
   * measurement exists — which makes the profile uncertifiable rather than
   * optimistic.
   */
  readonly realizedRatio?: number
  /** The upper bound of the paired interval, when one was formed. */
  readonly intervalUpper?: number
  readonly source: string
}

/** A certified operating profile for one route. */
export interface CertifiedEconomyProfile {
  readonly provider: string
  readonly modelPattern: string
  /** ISO date the certification was taken. */
  readonly asOf: string
  readonly trigger: CertifiedTrigger
  readonly cache: CertifiedCacheContract
  readonly priceEffect: CertifiedPriceEffect
  /**
   * Quality is INHERITED, and labeled so. RC1 changes WHEN a fold happens, not
   * what a checkpoint contains, so re-proving quality would be re-running a
   * measurement the change cannot affect (RC1 §32).
   */
  readonly quality: CertifiedClaim<string>
  /** Whether every load-bearing claim is measured rather than assumed. */
  readonly certified: boolean
  /** What is missing, when it is not certified. */
  readonly gaps: readonly string[]
}

/**
 * Certify a route from its evidence, or decline to.
 *
 * The decline is the important branch: a route with no paired price
 * measurement is NOT certified, and no amount of neighboring evidence
 * substitutes for it. RC1 §35 says an uncertified route keeps its current
 * behavior and a user may still select `mode: economy` explicitly — it simply
 * does not get a certification claim.
 *
 * @param evidence - the route's measurements.
 * @returns the profile, with `certified` false and `gaps` naming what is
 *   missing when the evidence is insufficient.
 */
export function certifyRoute(evidence: {
  readonly provider: string
  readonly modelPattern: string
  readonly asOf: string
  readonly thresholdRatio: number
  readonly headroomTokens?: number
  readonly headroomSource?: string
  readonly cacheMode: ContextEconomicsProfile['cache']['mode']
  readonly prefixDeterministic?: { readonly value: boolean; readonly source: string }
  readonly reuseRatio?: { readonly value: number; readonly source: string }
  readonly priceEffect?: CertifiedPriceEffect
  readonly qualitySource?: string
}): CertifiedEconomyProfile {
  const gaps: string[] = []

  const headroomClaim: CertifiedClaim<number> | undefined = evidence.headroomTokens === undefined
    ? undefined
    : {
      value: evidence.headroomTokens,
      evidence: evidence.headroomSource === undefined ? 'unevidenced' : 'measured',
      source: evidence.headroomSource ?? 'not measured for this route',
    }
  if (headroomClaim === undefined) {
    gaps.push('the safety reserve has not been measured for this route (RC1-A)')
  } else if (headroomClaim.evidence !== 'measured') {
    gaps.push('the safety reserve has no recorded source')
  }

  const deterministic: CertifiedClaim<boolean> = evidence.prefixDeterministic === undefined
    ? { value: false, evidence: 'unevidenced', source: 'not verified for this route' }
    : { value: evidence.prefixDeterministic.value, evidence: 'measured', source: evidence.prefixDeterministic.source }
  if (evidence.prefixDeterministic === undefined) {
    gaps.push('prefix determinism has not been verified for this route (RC1-D)')
  }

  const reuse: CertifiedClaim<number> = evidence.reuseRatio === undefined
    ? { value: Number.NaN, evidence: 'unevidenced', source: 'not measured for this route' }
    : { value: evidence.reuseRatio.value, evidence: 'measured', source: evidence.reuseRatio.source }
  if (evidence.reuseRatio === undefined) {
    gaps.push('the cache reuse baseline has not been measured for this route (RC1-E)')
  }

  const priceEffect: CertifiedPriceEffect = evidence.priceEffect ?? {
    source: 'no paired measurement recorded',
  }
  if (priceEffect.realizedRatio === undefined) {
    gaps.push('no paired realized cost measurement exists for this route')
  }

  const quality: CertifiedClaim<string> = evidence.qualitySource === undefined
    ? { value: 'unknown', evidence: 'unevidenced', source: 'not recorded' }
    : { value: 'non-inferior', evidence: 'inherited', source: evidence.qualitySource }

  return {
    provider: evidence.provider,
    modelPattern: evidence.modelPattern,
    asOf: evidence.asOf,
    trigger: {
      thresholdRatio: evidence.thresholdRatio,
      ...(headroomClaim === undefined ? {} : { headroomTokens: headroomClaim.value }),
      effectiveThresholdFor: (contextWindow, reservedTokens) =>
        Math.floor(Math.min(
          contextWindow * evidence.thresholdRatio,
          contextWindow - reservedTokens - (headroomClaim?.value ?? 0),
        )),
    },
    cache: {
      cacheMode: evidence.cacheMode,
      prefixDeterministic: deterministic,
      reuseRatioAtComparableShape: reuse,
    },
    priceEffect,
    quality,
    certified: gaps.length === 0,
    gaps,
  }
}

/**
 * Whether a route may be recommended `economy` automatically (RC1 §36).
 *
 * The answer is deliberately narrow: only a CERTIFIED route, and only by an
 * explicit lookup that returns `undefined` for everything else. An unknown
 * route falls back to `legacy` — never to `economy` — because an unmeasured
 * route's cache economics are exactly what makes the policy cheap or expensive,
 * and guessing in the cheap direction is how a "cost saving" ships as a
 * regression.
 *
 * @param profiles - the certified profiles.
 * @param provider - the routed provider.
 * @param model - the routed model.
 * @returns the certified profile, or `undefined` when the route is uncertified.
 */
export function certifiedProfileFor(
  profiles: readonly CertifiedEconomyProfile[],
  provider: string,
  model: string,
): CertifiedEconomyProfile | undefined {
  return profiles.find(profile =>
    profile.certified
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
 * The mode a route should run under, given certification (RC1 §36).
 *
 * `certified → economy`, `unknown → legacy`. This is the ONLY place the
 * question is answered, so no caller can accidentally invert it.
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

/** Render a profile for a report. */
export function profileToMarkdown(profile: CertifiedEconomyProfile): string {
  const lines = [
    `### ${profile.provider} / ${profile.modelPattern} (as of ${profile.asOf})`,
    '',
    `- Certified: **${profile.certified ? 'yes' : 'NO'}**`,
    `- Trigger: thresholdRatio ${profile.trigger.thresholdRatio}`
    + (profile.trigger.headroomTokens === undefined
      ? ', safety reserve NOT measured'
      : `, safety reserve ${profile.trigger.headroomTokens} tokens`),
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
  ]
  if (!profile.certified) {
    lines.push('', '**Gaps preventing certification:**')
    for (const gap of profile.gaps) lines.push(`- ${gap}`)
  }
  return lines.join('\n')
}
