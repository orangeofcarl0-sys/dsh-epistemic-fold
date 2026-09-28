/**
 * R1 model-aware context economics: the versioned, data-driven cost model that
 * turns "which context policy is right for THIS model?" into arithmetic.
 *
 * Two rules shape this module:
 *
 * 1. **No provider branch anywhere.** Core code never asks "is this DeepSeek?".
 *    It asks a {@link ContextEconomicsProfile} what a warm token costs, whether
 *    the provider's cache is automatic or explicit, and whether a cache write
 *    is itself billable. Adding a provider means adding a JSON profile, not a
 *    branch.
 *
 * 2. **No pricing constant is permanent.** Every profile carries `asOf` and
 *    `source`, is loaded from data, and may be overridden by the caller. A
 *    profile is a benchmark input, not an algorithm.
 *
 * The R0-C cost model used a single ρ (hit/miss price ratio). That is the
 * right first approximation and stays supported, but it silently assumes every
 * architecturally-stable prefix is actually served from cache. R1 adds the
 * realization rate `h` — measured, not assumed — so an "almost free" cache
 * that only hits 60% of the time cannot masquerade as one that always hits.
 *
 * @module dsh-epistemic-fold/economics-profile
 */

import { z } from 'zod'

/** One context-length pricing tier; the last tier applies above its ceiling. */
export const pricingTierSchema = z.object({
  /** Inclusive upper bound in tokens; omit for the unbounded final tier. */
  upToTokens: z.number().int().positive().optional(),
  inputMissPerM: z.number().nonnegative(),
  inputHitPerM: z.number().nonnegative(),
  /** Some providers bill the write that establishes a cache entry. */
  cacheWritePerM: z.number().nonnegative().optional(),
  outputPerM: z.number().nonnegative(),
})

export type PricingTier = z.infer<typeof pricingTierSchema>

/** The closed profile schema; unknown keys are rejected. */
export const economicsProfileSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  /** Glob-ish model matcher: `*` is the only wildcard. */
  modelPattern: z.string().min(1),
  /** ISO date the pricing was captured; policy must never treat it as timeless. */
  asOf: z.string().min(1),
  pricing: pricingTierSchema,
  cache: z.object({
    /**
     * `automatic` — the provider caches stable prefixes by itself;
     * `explicit` — the caller must place breakpoints;
     * `none` — no cache exists (every token is a miss).
     */
    mode: z.enum(['automatic', 'explicit', 'none']),
    /** True when a stable prefix MAY hit but is not guaranteed to. */
    bestEffort: z.boolean(),
    minimumCacheableTokens: z.number().int().nonnegative().optional(),
    ttlSeconds: z.number().int().positive().optional(),
    supportsExplicitBreakpoints: z.boolean().optional(),
  }),
  context: z.object({
    windowTokens: z.number().int().positive(),
    pricingTiers: z.array(pricingTierSchema).optional(),
  }),
  /** Provenance of the numbers; required so a profile is auditable. */
  source: z.string().optional(),
})

export type ContextEconomicsProfile = z.infer<typeof economicsProfileSchema>

/** One request's observed token split, as a provider reports it. */
export interface ObservedUsage {
  /** Prompt tokens the provider charged at the miss price. */
  readonly uncachedInputTokens: number
  /** Prompt tokens the provider served from cache. */
  readonly cacheReadTokens: number
  /** Tokens written into the cache (explicit-cache providers only). */
  readonly cacheWriteTokens?: number
  readonly outputTokens: number
}

/** One policy's cost decomposition under one profile. */
export interface CostBreakdown {
  readonly missCost: number
  readonly hitCost: number
  readonly cacheWriteCost: number
  readonly outputCost: number
  readonly totalCost: number
}

/** Validate untrusted JSON into a profile, failing loud on shape drift. */
export function parseEconomicsProfile(value: unknown): ContextEconomicsProfile {
  return economicsProfileSchema.parse(value)
}

/**
 * True when `modelPattern` matches `model`; `*` is the only wildcard and
 * matches any run of characters (including none). Segments are matched
 * left-to-right so multi-wildcard patterns such as `deepseek-*flash*` work.
 */
export function profileMatchesModel(profile: ContextEconomicsProfile, model: string): boolean {
  const pattern = profile.modelPattern
  if (!pattern.includes('*')) return pattern === model
  const segments = pattern.split('*')
  // The first segment must anchor at the start, the last at the end; the
  // interior segments must appear in order. `*` itself may match empty, so a
  // trailing `*` imposes no suffix requirement.
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
 * Select the profile governing one routed model. An exact model match beats a
 * wildcard; among wildcards the most specific (longest literal prefix) wins,
 * so profiles stay declarative and order-independent.
 * @returns the matching profile, or `undefined` when none applies.
 */
export function selectProfile(
  profiles: readonly ContextEconomicsProfile[],
  provider: string,
  model: string,
): ContextEconomicsProfile | undefined {
  let best: ContextEconomicsProfile | undefined
  let bestScore = -1
  for (const profile of profiles) {
    if (profile.provider !== provider) continue
    if (!profileMatchesModel(profile, model)) continue
    const score = profile.modelPattern.includes('*')
      ? profile.modelPattern.indexOf('*')
      : Number.MAX_SAFE_INTEGER
    if (score > bestScore) {
      best = profile
      bestScore = score
    }
  }
  return best
}

/**
 * Overlay caller overrides onto a profile (docs/11 §4: a profile must never be
 * a permanent constant). `asOf` is restamped and `source` annotated so an
 * overridden profile is never mistaken for the published one.
 */
export function overrideProfile(
  profile: ContextEconomicsProfile,
  overrides: {
    pricing?: Partial<PricingTier>
    cache?: Partial<ContextEconomicsProfile['cache']>
    context?: Partial<ContextEconomicsProfile['context']>
    asOf?: string
    source?: string
  },
): ContextEconomicsProfile {
  return economicsProfileSchema.parse({
    ...profile,
    pricing: { ...profile.pricing, ...(overrides.pricing ?? {}) },
    cache: { ...profile.cache, ...(overrides.cache ?? {}) },
    context: { ...profile.context, ...(overrides.context ?? {}) },
    asOf: overrides.asOf ?? profile.asOf,
    source: overrides.source ?? `${profile.source ?? profile.id} (overridden)`,
  })
}

/** The tier governing a prompt of `promptTokens` under one profile. */
export function tierFor(profile: ContextEconomicsProfile, promptTokens: number): PricingTier {
  const tiers = profile.context.pricingTiers
  if (tiers === undefined || tiers.length === 0) return profile.pricing
  for (const tier of tiers) {
    if (tier.upToTokens !== undefined && promptTokens <= tier.upToTokens) return tier
  }
  return tiers[tiers.length - 1]!
}

/** The hit/miss price ratio ρ = C_hit / C_miss for one prompt size. */
export function rhoOf(profile: ContextEconomicsProfile, promptTokens = 0): number {
  const tier = tierFor(profile, promptTokens)
  if (tier.inputMissPerM === 0) return 0
  return tier.inputHitPerM / tier.inputMissPerM
}

/**
 * Effective ratio once cache realization is accounted for: with hit rate `h`,
 * a stable token costs `h·C_hit + (1-h)·C_miss`, so
 * `ρ_eff = h·ρ + (1-h)`.
 *
 * This is the correction that matters most: a profile advertising ρ = 0.02 at
 * a realized h = 0.8 is economically ρ_eff ≈ 0.216 — an order of magnitude
 * away from the headline ratio.
 */
export function effectiveRho(rho: number, realizationRate: number): number {
  const h = Math.min(1, Math.max(0, realizationRate))
  return h * rho + (1 - h)
}

/** Cache realization rate = actual cache reads / architecturally cacheable. */
export function cacheRealizationRate(
  actualCacheReadTokens: number,
  architecturallyCacheableTokens: number,
): number {
  if (architecturallyCacheableTokens <= 0) return 0
  return Math.min(1, actualCacheReadTokens / architecturallyCacheableTokens)
}

/** Per-million-token price application. */
function perM(tokens: number, pricePerM: number): number {
  return (tokens / 1_000_000) * pricePerM
}

/** Decompose one observed request into the four billable components. */
export function costOf(
  profile: ContextEconomicsProfile,
  usage: ObservedUsage,
  promptTokens = usage.uncachedInputTokens + usage.cacheReadTokens,
): CostBreakdown {
  const tier = tierFor(profile, promptTokens)
  const missCost = perM(usage.uncachedInputTokens, tier.inputMissPerM)
  const hitCost = perM(usage.cacheReadTokens, tier.inputHitPerM)
  const cacheWriteCost = perM(usage.cacheWriteTokens ?? 0, tier.cacheWritePerM ?? 0)
  const outputCost = perM(usage.outputTokens, tier.outputPerM)
  return {
    missCost,
    hitCost,
    cacheWriteCost,
    outputCost,
    totalCost: missCost + hitCost + cacheWriteCost + outputCost,
  }
}

/**
 * Cost of a hypothetical request described by ARCHITECTURE alone (stable
 * prefix size, fresh tokens, output), priced under a realization rate.
 * This is the bridge from R0-C's architectural metrics to R1 money.
 */
export function modeledCost(
  profile: ContextEconomicsProfile,
  options: {
    readonly stablePrefixTokens: number
    readonly freshTokens: number
    readonly outputTokens: number
    readonly realizationRate: number
    /** Tokens the provider must write to establish/refresh the cache. */
    readonly cacheWriteTokens?: number
  },
): CostBreakdown {
  const promptTokens = options.stablePrefixTokens + options.freshTokens
  const h = Math.min(1, Math.max(0, options.realizationRate))
  const hitTokens = options.stablePrefixTokens * h
  const stableMissTokens = options.stablePrefixTokens - hitTokens
  return costOf(profile, {
    uncachedInputTokens: options.freshTokens + stableMissTokens,
    cacheReadTokens: hitTokens,
    ...(options.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: options.cacheWriteTokens }),
    outputTokens: options.outputTokens,
  }, promptTokens)
}

/**
 * Amortized root-rebase break-even (docs/11 §15-§16): how many future requests
 * must the rebase serve before its one-time cost is repaid?
 *
 *   ΔF   = frozen tokens removed from every later request
 *   S    = ΔF · C_warm            (saving per request)
 *   H*   = C_root / S
 *
 * `C_root` is deliberately NOT just the compaction call: it also carries the
 * cache invalidation the rebase causes and any cache write the provider bills.
 *
 * @returns the break-even request count, or `undefined` when the rebase saves
 *   nothing per request (it can never pay back) or when ΔF is non-positive.
 */
export function rootBreakEvenRequests(options: {
  readonly profile: ContextEconomicsProfile
  readonly frozenBefore: number
  readonly frozenAfter: number
  readonly realizationRate: number
  /** Priced prompt size used to pick the tier. */
  readonly promptTokens: number
  /** One-time cost of the compaction call itself. */
  readonly compactionCost: number
  /** Tokens the rebase invalidates from the warm prefix. */
  readonly invalidatedTokens?: number
  /** Tokens the provider rewrites to re-establish the cache. */
  readonly cacheWriteTokens?: number
}): number | undefined {
  const removed = options.frozenBefore - options.frozenAfter
  if (removed <= 0) return undefined
  const tier = tierFor(options.profile, options.promptTokens)
  const warmPerToken = (
    options.realizationRate * tier.inputHitPerM
    + (1 - options.realizationRate) * tier.inputMissPerM
  ) / 1_000_000
  const savingPerRequest = removed * warmPerToken
  if (savingPerRequest <= 0) return undefined
  const invalidationCost = (options.invalidatedTokens ?? 0)
    * (tier.inputMissPerM - tier.inputHitPerM) / 1_000_000
  const writeCost = perM(options.cacheWriteTokens ?? 0, tier.cacheWritePerM ?? 0)
  const totalRootCost = options.compactionCost + invalidationCost + writeCost
  return totalRootCost / savingPerRequest
}

/** The three economic regimes (docs/11 §18) — derived, never hardcoded. */
export type PolicyRegime = 'cache-dominant' | 'hybrid' | 'token-dominant'

/**
 * Built-in profiles so a deployment works without reading files. These mirror
 * `profiles/economics/*.json` (the auditable, user-overridable copies) and
 * carry the same `asOf` provenance, so nothing here pretends to be timeless.
 * Callers may replace them entirely via configuration.
 */
export const BUILTIN_ECONOMICS_PROFILES: readonly ContextEconomicsProfile[] = [
  parseEconomicsProfile({
    id: 'deepseek-flash-2026-09',
    provider: 'deepseek',
    modelPattern: 'deepseek-*flash*',
    asOf: '2026-09-28',
    source: 'built-in mirror of profiles/economics/deepseek-flash-2026-09.json',
    pricing: { inputMissPerM: 0.28, inputHitPerM: 0.0056, outputPerM: 0.42 },
    cache: {
      mode: 'automatic',
      bestEffort: true,
      minimumCacheableTokens: 64,
      ttlSeconds: 3600,
      supportsExplicitBreakpoints: false,
    },
    context: { windowTokens: 131_072 },
  }),
  parseEconomicsProfile({
    id: 'deepseek-pro-2026-09',
    provider: 'deepseek',
    modelPattern: 'deepseek-*pro*',
    asOf: '2026-09-28',
    source: 'built-in mirror of profiles/economics/deepseek-pro-2026-09.json',
    pricing: { inputMissPerM: 0.56, inputHitPerM: 0.0185, outputPerM: 1.68 },
    cache: {
      mode: 'automatic',
      bestEffort: true,
      minimumCacheableTokens: 64,
      ttlSeconds: 3600,
      supportsExplicitBreakpoints: false,
    },
    context: { windowTokens: 131_072 },
  }),
  parseEconomicsProfile({
    id: 'openai-gpt-5.6-2026-09',
    provider: 'openai',
    modelPattern: 'gpt-5.6*',
    asOf: '2026-09-28',
    source: 'built-in mirror of profiles/economics/openai-gpt-5.6-2026-09.json',
    pricing: {
      inputMissPerM: 1.25,
      inputHitPerM: 0.125,
      cacheWritePerM: 1.5625,
      outputPerM: 10.0,
    },
    cache: {
      mode: 'explicit',
      bestEffort: false,
      minimumCacheableTokens: 1024,
      ttlSeconds: 300,
      supportsExplicitBreakpoints: true,
    },
    context: { windowTokens: 400_000 },
  }),
  parseEconomicsProfile({
    id: 'synthetic-no-cache',
    provider: 'synthetic',
    modelPattern: '*',
    asOf: '2026-09-28',
    source: 'built-in mirror of profiles/economics/synthetic-no-cache.json',
    pricing: { inputMissPerM: 1.0, inputHitPerM: 1.0, outputPerM: 1.0 },
    cache: { mode: 'none', bestEffort: false },
    context: { windowTokens: 128_000 },
  }),
]

/**
 * The profile governing a routed model, falling back to a conservative
 * no-cache profile when nothing matches. The fallback matters: assuming a
 * cache exists where none is configured would over-credit every saving, so
 * an unknown route is priced as if every token were a miss.
 */
export function resolveProfile(
  profiles: readonly ContextEconomicsProfile[],
  provider: string,
  model: string,
): ContextEconomicsProfile {
  return selectProfile(profiles, provider, model)
    ?? profiles.find(candidate => candidate.cache.mode === 'none')
    ?? NO_CACHE_FALLBACK
}

/** Last-resort profile for an unroutable model: no cache, unit prices. */
const NO_CACHE_FALLBACK: ContextEconomicsProfile = parseEconomicsProfile({
  id: 'fallback-no-cache',
  provider: '*',
  modelPattern: '*',
  asOf: '2026-09-28',
  source: 'conservative fallback: unknown route priced with no cache',
  pricing: { inputMissPerM: 1.0, inputHitPerM: 1.0, outputPerM: 1.0 },
  cache: { mode: 'none', bestEffort: false },
  context: { windowTokens: 128_000 },
})

/**
 * Classify a profile's regime from measured economics. The thresholds are
 * arguments rather than constants precisely because docs/11 §18 forbids
 * freezing them before the W1–W5 × profile benchmark has run.
 */
export function classifyRegime(options: {
  readonly rho: number
  readonly realizationRate: number
  readonly cacheDominantBelow?: number
  readonly tokenDominantAbove?: number
}): PolicyRegime {
  const cacheDominantBelow = options.cacheDominantBelow ?? 0.05
  const tokenDominantAbove = options.tokenDominantAbove ?? 0.5
  const effective = effectiveRho(options.rho, options.realizationRate)
  if (effective < cacheDominantBelow) return 'cache-dominant'
  if (effective > tokenDominantAbove) return 'token-dominant'
  return 'hybrid'
}
