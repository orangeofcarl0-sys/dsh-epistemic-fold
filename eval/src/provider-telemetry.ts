/**
 * R1-A provider cache telemetry: what the provider ACTUALLY charged, versus
 * what the prefix architecture merely made cacheable.
 *
 * R0-C could only measure the architectural claim — "this many tokens survived
 * the previous request" — which is a statement about prefix stability, not
 * about billing. A stable prefix can still miss: the provider may route
 * elsewhere, the TTL may have expired, or the prefix may be under the
 * minimum cacheable size. R1 therefore reads the provider's own reported usage
 * from durable session events and computes the realization rate that separates
 * "cacheable" from "cached".
 *
 * No live provider is required to use this module: it reads whatever usage the
 * durable log carries. With a deterministic adapter that reports none, the
 * telemetry honestly reports `undefined` rather than inventing a hit rate.
 *
 * @module eval/provider-telemetry
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { cacheRealizationRate, effectiveRho, rhoOf } from '../../src/economics-profile.ts'
import type { ContextEconomicsProfile } from '../../src/economics-profile.ts'

/** Summed provider-reported usage across one run. */
export interface ProviderTelemetry {
  /** Prompt tokens the provider billed at the miss price. */
  readonly uncachedInputTokens: number
  /** Prompt tokens the provider served from cache. */
  readonly cacheReadTokens: number
  /** Tokens the provider wrote into the cache (explicit-cache providers). */
  readonly cacheWriteTokens: number
  readonly outputTokens: number
  /** Provider-reported total, when the adapter emitted one. */
  readonly totalTokens?: number
  /** How many assistant messages carried usage at all. */
  readonly samples: number
  /** How many carried cache fields specifically. */
  readonly cacheSamples: number
}

/** Cache economics derived from telemetry plus one profile. */
export interface CacheRealization {
  readonly telemetry: ProviderTelemetry
  /**
   * actual cache reads / (cache reads + uncached input). This is the realized
   * hit share of everything the provider had to price.
   */
  readonly realizationRate: number | undefined
  /** ρ = C_hit / C_miss for this profile. */
  readonly rho: number
  /** ρ_eff = h·ρ + (1-h) — what the workload actually pays. */
  readonly effectiveRho: number | undefined
  /**
   * The architectural claim this run's prefix stability made, when supplied.
   * Kept separate from `realizationRate` so a stable prefix can never be
   * reported as a realized cache hit.
   */
  readonly architecturalCacheableTokens?: number
  /** Tokens the architecture expected to reuse but the provider billed as miss. */
  readonly unrealizedCacheTokens?: number
}

interface UsageLike {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/**
 * Collect provider usage from the durable log.
 *
 * Reads `assistant/message` usage records, which is where a real adapter
 * reports its own billing split. Usage that omits the cache fields is counted
 * as fully uncached input, so an adapter that never reports cache is treated
 * as "no realized caching" rather than as "perfect caching".
 *
 * @param session - session whose durable log is scanned.
 * @returns summed telemetry; all-zero with `samples: 0` when no usage exists.
 */
export function collectProviderTelemetry(session: Session): ProviderTelemetry {
  let uncachedInputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let outputTokens = 0
  let totalTokens: number | undefined
  let samples = 0
  let cacheSamples = 0

  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq as never)
    if (event?.type !== 'assistant/message') continue
    const usage = (event.data as { usage?: UsageLike }).usage
    if (usage === undefined) continue
    samples += 1
    const read = usage.cacheReadTokens ?? 0
    const write = usage.cacheWriteTokens ?? 0
    if (usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined) {
      cacheSamples += 1
    }
    cacheReadTokens += read
    cacheWriteTokens += write
    uncachedInputTokens += usage.inputTokens ?? 0
    outputTokens += usage.outputTokens ?? 0
    if (usage.totalTokens !== undefined) {
      totalTokens = (totalTokens ?? 0) + usage.totalTokens
    }
  }

  return {
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    samples,
    cacheSamples,
  }
}

/**
 * Derive realized cache economics from telemetry and a profile.
 *
 * @param telemetry - provider-reported usage.
 * @param profile - the routed model's economics profile.
 * @param architecturalCacheableTokens - the prefix-architecture claim (what
 *   R0-C measured as `stablePrefixTokens`), used to cross-check the realized
 *   rate. The reported rate uses provider numbers only; this argument is
 *   carried so the two claims can never be silently conflated.
 * @returns realized rates, or `undefined` where the provider reported nothing.
 */
export function deriveCacheRealization(
  telemetry: ProviderTelemetry,
  profile: ContextEconomicsProfile,
  architecturalCacheableTokens?: number,
): CacheRealization {
  const priced = telemetry.cacheReadTokens + telemetry.uncachedInputTokens
  const realizationRate = telemetry.cacheSamples === 0 || priced === 0
    ? undefined
    : cacheRealizationRate(telemetry.cacheReadTokens, priced)
  const rho = rhoOf(profile)
  const gap = architecturalCacheableTokens === undefined
    ? undefined
    : unrealizedCacheTokens(telemetry, architecturalCacheableTokens)
  return {
    telemetry,
    realizationRate,
    rho,
    effectiveRho: realizationRate === undefined ? undefined : effectiveRho(rho, realizationRate),
    ...(architecturalCacheableTokens === undefined ? {} : { architecturalCacheableTokens }),
    ...(gap === undefined ? {} : { unrealizedCacheTokens: gap }),
  }
}

/**
 * The gap between the architectural claim and the billing reality: how many
 * tokens the prefix architecture expected to reuse but the provider charged
 * as a miss (positive), or reused beyond the architectural claim (negative).
 *
 * @returns the token gap, or `undefined` when the provider reported no cache
 *   fields at all — an unknown gap is never reported as zero.
 */
export function unrealizedCacheTokens(
  telemetry: ProviderTelemetry,
  architecturalCacheableTokens: number,
): number | undefined {
  if (telemetry.cacheSamples === 0) return undefined
  return architecturalCacheableTokens - telemetry.cacheReadTokens
}
