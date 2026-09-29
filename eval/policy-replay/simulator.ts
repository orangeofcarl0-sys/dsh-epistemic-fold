/**
 * RC1-B §12/§13: the virtual policy replay.
 *
 * The rule this module exists to enforce:
 *
 *   SimPolicy == ProductionPolicy
 *
 * the same rule R3 established as `BenchPath == ProductionPath`. The simulator
 * therefore does NOT reimplement admission, break-even, or regime logic. It
 * calls the production functions — `leafMarginalReclaim`,
 * `compileContextPolicy` (and through it `rootBreakEvenRequests`),
 * `effectiveRho` — and owns only what a replay genuinely has to own:
 *
 *   - surface token state (frozen prefix, verbatim tail)
 *   - growth
 *   - the fold OUTCOME model (what a fold leaves behind)
 *   - checkpoint cost
 *   - cache mutation accounting
 *
 * The outcome model is where a simulator can lie, so it is stated explicitly
 * and kept to the two structural behaviors the project has actually measured:
 *
 *   EF leaf   — the frozen prefix is MONOTONIC. A fold replaces the foldable
 *               span with one checkpoint that JOINS the frozen prefix, so the
 *               prefix grows by one checkpoint per fold and is never re-folded.
 *   Basic     — no frozen prefix. A fold replaces the whole surface above the
 *               retained tail with one summary, so the next fold can re-fold
 *               that summary. This is the difference that makes EF's floor
 *               higher and Basic's re-foldable.
 *
 * Cost is cache-adjusted at the profile's own `rho` under a realization rate
 * `h`, plus the auxiliary compaction call each arm's `semanticMode` implies.
 * It is an ESTIMATE, and the report says so: RC0 established that modeled
 * economics may guide architecture but only realized billing may flip a
 * default. What this buys is a parameter search at zero API cost.
 *
 * @module eval/policy-replay/simulator
 */

import {
  effectiveRho,
  rhoOf,
  tierFor,
} from '../../src/economics-profile.ts'
import type { ContextEconomicsProfile } from '../../src/economics-profile.ts'
import { leafMarginalReclaim } from '../../src/pressure.ts'
import { compileContextPolicy } from '../../src/policy-compiler.ts'
import { resolveEfCompactSpec, resolveEfConfig } from '../../src/policy.ts'
import type { EpistemicFoldConfig } from '../../src/policy.ts'
import { checkpointSizeOf } from './trace.ts'
import type { PolicyTrace } from './trace.ts'

/** Which arm a replay simulates. */
export type ReplayArm = 'ef' | 'basic'

/**
 * The four request classes a cache realization rate must be stated for
 * (RC1.1 §3b).
 *
 * The previous simulator priced EVERY request at one `h`. That is wrong in a
 * direction that flatters the policy: a request following a fold arrives on a
 * surface the provider has never seen, so its realization is near zero, and
 * averaging those into a single rate hides the cost the fold actually imposes.
 * RC1-E measured exactly this shape live — a root mutation showed 0.236 reuse
 * against 0.933 warm — so the classes are not a refinement, they are the
 * mechanism.
 *
 *   `normal`      steady state; nothing structural changed since the last request
 *   `after-leaf`  the first request after a leaf fold appended a checkpoint
 *   `after-root`  the first request after a root rebase rewrote the prefix
 *   `compaction`  the auxiliary summarizer call, which shares no prefix at all
 */
export const CACHE_CLASSES = ['normal', 'after-leaf', 'after-root', 'compaction'] as const
export type CacheClass = (typeof CACHE_CLASSES)[number]

/** A realization rate per request class. */
export type CacheRealization = Readonly<Record<CacheClass, number>>

/**
 * The nominal realization set, and the sensitivity band around it.
 *
 * `nominal` uses the RC1-E measurements where they exist (after-leaf and
 * after-root show a genuine cold shock) and a conservative mid-value for
 * `normal`, since RC1-E's stable-append probes measured 0.93 but that is the
 * BEST case — a prefix that nothing disturbed.
 *
 * `optimistic` and `pessimistic` exist because RC1.1 §3b asks for a
 * sensitivity analysis rather than a point estimate: the whole point of the
 * gate is to know whether the verdict survives the assumption, and a single
 * `h` cannot answer that.
 */
export const CACHE_SCENARIOS: Readonly<Record<'optimistic' | 'nominal' | 'pessimistic', CacheRealization>> = {
  optimistic: { 'normal': 0.95, 'after-leaf': 0.35, 'after-root': 0.10, 'compaction': 0.0 },
  nominal: { 'normal': 0.85, 'after-leaf': 0.24, 'after-root': 0.05, 'compaction': 0.0 },
  pessimistic: { 'normal': 0.60, 'after-leaf': 0.05, 'after-root': 0.0, 'compaction': 0.0 },
}

/** One candidate operating profile to replay. */
export interface ReplayPolicy {
  /** Deployment configuration, as a user would write it. */
  readonly config: EpistemicFoldConfig
  /** Routed model's window. */
  readonly contextWindow: number
  /** Output tokens the routed request reserves. */
  readonly reservedCompletionTokens: number
  /**
   * Realized cache hit rate per request CLASS (RC1.1 §3b).
   *
   * A single number is still accepted for compatibility and is expanded to the
   * same rate in every class, but a caller that supplies one is stating that
   * folds impose no cache cost — which RC1-E measured to be false. New work
   * should pass {@link CACHE_SCENARIOS}.
   */
  readonly realization: CacheRealization | number
  /**
   * Tokens one checkpoint costs, when the trace itself never evidenced one.
   * The trace's own median wins whenever it exists.
   */
  readonly fallbackCheckpointTokens: number
  /**
   * Tokens Basic's summary checkpoint costs. Kept separate from EF's because
   * the two arms produce structurally different checkpoints, and using one
   * number for both would erase the mechanism being measured.
   */
  readonly basicCheckpointTokens: number
  /** Output tokens per request, for the cost estimate. */
  readonly outputTokensPerRequest: number
  /** Whether the arm performs idle rebase maintenance (EF only). */
  readonly idleMaintenance: boolean
}

/** Expand a scalar realization into every class, or pass a set through. */
export function realizationSet(value: CacheRealization | number): CacheRealization {
  if (typeof value !== 'number') return value
  return { 'normal': value, 'after-leaf': value, 'after-root': value, 'compaction': value }
}

/** One step's simulated state, kept for diagnosis rather than only totals. */
export interface ReplayStep {
  readonly step: number
  readonly frozenTokens: number
  readonly tailTokens: number
  readonly promptTokens: number
  readonly folded: boolean
  readonly rebased: boolean
  /** Which cache class this request was priced under (RC1.1 §3b). */
  readonly cacheClass: CacheClass
  /** The realization rate applied to this request. */
  readonly realization: number
  readonly cost: number
}

/** The outcome of replaying one trace under one policy. */
export interface ReplayResult {
  readonly arm: ReplayArm
  readonly traceId: string
  readonly steps: readonly ReplayStep[]
  /** Total cache-adjusted context cost across the run. */
  readonly totalCost: number
  /** Sum of per-request prompt tokens — the surface the model was shown. */
  readonly totalPromptTokens: number
  readonly leafFolds: number
  readonly rootRebases: number
  /** Peak request prompt tokens. */
  readonly peakPromptTokens: number
  /**
   * Steps where the request exceeded the window. Must be 0: a simulated
   * overflow means the policy would have needed the emergency path.
   */
  readonly overflowEvents: number
  /**
   * The longest run of consecutive steps that folded. A sustained run is the
   * fold-every-step loop R1 measured, and RC1 §40 names it a gate failure.
   */
  readonly longestFoldRun: number
  /** Fold cadence: folds per step. */
  readonly foldRate: number
  /** Whether the frozen prefix alone ever exceeded the threshold. */
  readonly frozenBound: boolean
}

/** Cache-adjusted cost of one request under one profile, at one realization. */
function requestCost(
  profile: ContextEconomicsProfile,
  promptTokens: number,
  outputTokens: number,
  realizationRate: number,
): number {
  const tier = tierFor(profile, promptTokens)
  const warm = effectiveRho(rhoOf(profile, promptTokens), realizationRate)
  // Every prompt token is priced at the effective warm/miss blend. A model with
  // no cache has rho 1, so this collapses to the plain miss price.
  const inputCost = (promptTokens / 1_000_000) * tier.inputMissPerM * warm
  const outputCost = (outputTokens / 1_000_000) * tier.outputPerM
  return inputCost + outputCost
}

/**
 * Simulate one trace under one policy (RC1-B §12).
 *
 * @param trace - the growth trajectory to replay.
 * @param policy - the candidate operating profile.
 * @param arm - which compaction arm to simulate.
 * @param profile - the routed model's economics, used for pricing and for the
 *   production root decision.
 * @returns the per-step trajectory and the run totals.
 */
export function simulate(
  trace: PolicyTrace,
  policy: ReplayPolicy,
  arm: ReplayArm,
  profile: ContextEconomicsProfile,
): ReplayResult {
  const resolved = resolveEfConfig(policy.config)
  // Expanded once, so every request is priced against the same class set.
  const realizations = realizationSet(policy.realization)
  // The TRACE owns the window. A trace is an observation made at a particular
  // capacity, and replaying it at a different one silently changes the
  // threshold it was produced against — the apples-to-oranges error RC0 found
  // in its own earlier numbers. A scan varies the POLICY; the window travels
  // with the trace, so this is applied here rather than trusted to callers.
  const contextWindow = trace.contextWindow
  const reservedCompletionTokens = trace.reservedCompletionTokens
  const spec = resolveEfCompactSpec(resolved, contextWindow, reservedCompletionTokens)
  const checkpoint = arm === 'ef'
    ? checkpointSizeOf(trace, policy.fallbackCheckpointTokens)
    : { tokens: policy.basicCheckpointTokens, evidenced: true, origin: 'declared' as const }
  const checkpointTokens = checkpoint.tokens

  // Surface state. EF carries a monotonically non-decreasing frozen prefix;
  // Basic carries none, because its next fold may re-fold its own summary.
  // The tail starts at the trace's own initial surface, not at zero: an
  // observed run begins from a seeded fixture, and starting empty would mean
  // the replay never reaches the threshold and both arms cost the same.
  let frozenTokens = 0
  let frozenCount = 0
  let tailTokens = trace.initialTokens
  const steps: ReplayStep[] = []
  let totalCost = 0
  let totalPromptTokens = 0
  let peakPromptTokens = 0
  let leafFolds = 0
  let rootRebases = 0
  let overflowEvents = 0
  let longestFoldRun = 0
  let currentFoldRun = 0
  let frozenBound = false

  for (const step of trace.steps) {
    tailTokens += step.growthTokens
    let promptTokens = frozenTokens + tailTokens
    let folded = false
    let rebased = false
    /** The span a fold would replace, and what Basic's summary would price. */
    let foldable = 0

    // --- Idle rebase window (EF only), before the pressure fold, matching the
    // production order in `runFullWire`/`runPairedBaseline`: maintenance runs
    // with the turn closed, then growth, then the pressure fold.
    if (arm === 'ef' && policy.idleMaintenance && resolved.rootPolicy.mode === 'economics'
      && frozenCount > 0) {
      const decision = compileContextPolicy({
        economics: profile,
        telemetry: {
          frozenTokens,
          frozenCheckpointCount: frozenCount,
          rawTailTokens: tailTokens,
          promptTokens,
          // At idle the cooldown is relaxed, exactly as the production
          // consumer does (R3-0b), so a stale cadence cannot suppress a rebase.
          recentFoldCadence: Number.POSITIVE_INFINITY,
        },
        pressure: { contextWindow, currentTokens: promptTokens },
        policy: {
          paybackHorizonRequests: resolved.rootPolicy.paybackHorizonRequests,
          // The compiler's break-even uses the STEADY-STATE rate: the question
          // it answers is whether a rebase repays over FUTURE requests, and
          // those are normal-class requests, not cold ones.
          realizationRate: realizations.normal,
          pressureRatio: resolved.thresholdRatio,
          compactionCost: resolved.rootPolicy.compactionCost,
          // The production idle path sets this, and it is load-bearing: with a
          // leaf available the pressure override returns `leaf`, so the
          // simulator would never ask the root question at all. Matching the
          // engine here is what keeps this a replay of the product's policy
          // rather than a plausible variant of it.
          leafAvailable: false,
        },
      })
      if (decision.action === 'root') {
        // One root checkpoint remains frozen; the rest is reclaimed.
        const kept = frozenCount <= 1 ? frozenTokens : frozenTokens / frozenCount
        frozenTokens = kept
        frozenCount = 1
        promptTokens = frozenTokens + tailTokens
        rootRebases += 1
        rebased = true
      }
    }

    // --- Pressure fold.
    if (promptTokens >= spec.thresholdTokens) {
      const span = tailTokens - spec.retainTokens
      foldable = Math.max(0, span)
      // The production admission gate, called rather than reimplemented.
      const reclaim = leafMarginalReclaim({
        spanTokens: foldable,
        frozenTokens,
        frozenCount,
        fallbackCheckpointTokens: policy.fallbackCheckpointTokens,
      })
      const frozenCannotSuffice = frozenCount > 0 && frozenTokens >= spec.thresholdTokens
      if (frozenCannotSuffice) frozenBound = true

      const admitted = resolved.leafAdmission === 'economic'
        ? !frozenCannotSuffice
          && reclaim.reclaimTokens >= resolved.minReclaimTokens
          && reclaim.reclaimRatio >= resolved.minReclaimRatio
        : foldable > 0

      if (admitted && foldable > 0) {
        folded = true
        leafFolds += 1
        if (arm === 'ef') {
          // The checkpoint JOINS the frozen prefix: monotonic, never re-folded.
          frozenTokens += checkpointTokens
          frozenCount += 1
        } else {
          // Basic re-folds its own summary: the surface collapses to the
          // summary plus the retained tail, with no frozen prefix at all.
          frozenTokens = 0
          frozenCount = 0
        }
        tailTokens = spec.retainTokens
        promptTokens = frozenTokens + tailTokens
      }
    }

    if (promptTokens > contextWindow) overflowEvents += 1
    peakPromptTokens = Math.max(peakPromptTokens, promptTokens)

    // --- Cost, priced by REQUEST CLASS (RC1.1 §3b).
    //
    // The class is the state this request ARRIVES in, which is what determines
    // how much of its prefix the provider can serve from cache. A request after
    // a fold is a cold shock; a steady-state request is warm. Pricing both at
    // one rate was the defect: it made the cost of a fold invisible.
    const realization = realizations[rebased ? 'after-root' : folded ? 'after-leaf' : 'normal']
    let stepCost = requestCost(profile, promptTokens, policy.outputTokensPerRequest, realization)
    if (folded && arm === 'ef' && resolved.semanticMode === 'rationale') {
      // A rationale-only auxiliary call: small prompt, small output, and it
      // shares no prefix with the conversation, so it is priced cold.
      stepCost += requestCost(profile, 512, 128, realizations.compaction)
    }
    if (folded && arm === 'basic') {
      // Basic summarizes the span it folds — a real provider call over the
      // span, which is likewise a fresh prefix rather than a cached one.
      stepCost += requestCost(
        profile, foldable + checkpointTokens, checkpointTokens, realizations.compaction,
      )
    }
    totalCost += stepCost
    totalPromptTokens += promptTokens

    steps.push({
      step: step.step,
      frozenTokens,
      tailTokens,
      promptTokens,
      folded,
      rebased,
      cacheClass: rebased ? 'after-root' : folded ? 'after-leaf' : 'normal',
      realization,
      cost: stepCost,
    })

    if (folded) {
      currentFoldRun += 1
      longestFoldRun = Math.max(longestFoldRun, currentFoldRun)
    } else {
      currentFoldRun = 0
    }
  }

  return {
    arm,
    traceId: trace.id,
    steps,
    totalCost,
    totalPromptTokens,
    leafFolds,
    rootRebases,
    peakPromptTokens,
    overflowEvents,
    longestFoldRun,
    foldRate: trace.steps.length === 0 ? 0 : leafFolds / trace.steps.length,
    frozenBound,
  }
}

/** A paired replay: the candidate against Basic on the same trace. */
export interface PairedReplay {
  readonly traceId: string
  readonly candidate: ReplayResult
  readonly basic: ReplayResult
  /** `candidate.totalCost / basic.totalCost`. */
  readonly costRatio: number
}

/**
 * Replay one trace under both arms and pair the results (RC1-B §40).
 *
 * The trace's OWN window and reservation are used, overriding whatever the
 * policy carries. A trace is an observation made at a particular window, and
 * replaying it at a different one silently changes the threshold it was
 * produced against — which is the apples-to-oranges error RC0 found in its own
 * earlier numbers. What a scan varies is the POLICY (ratio, reserve,
 * retention); the window belongs to the trace.
 *
 * @param trace - the trace.
 * @param policy - the candidate operating profile.
 * @param profile - the routed model's economics.
 * @returns both runs and their cost ratio; `Infinity` when Basic's modeled cost
 *   is zero, because a ratio against nothing is not a measurement.
 */
export function replayPaired(
  trace: PolicyTrace,
  policy: ReplayPolicy,
  profile: ContextEconomicsProfile,
): PairedReplay {
  const atTraceWindow: ReplayPolicy = {
    ...policy,
    contextWindow: trace.contextWindow,
    reservedCompletionTokens: trace.reservedCompletionTokens,
  }
  const candidate = simulate(trace, atTraceWindow, 'ef', profile)
  const basic = simulate(trace, atTraceWindow, 'basic', profile)
  return {
    traceId: trace.id,
    candidate,
    basic,
    costRatio: basic.totalCost <= 0 ? Number.POSITIVE_INFINITY : candidate.totalCost / basic.totalCost,
  }
}

/**
 * Whether a replayed policy clears RC1-B §40 on one trace.
 *
 * The gate is conjunctive and deliberately conservative: an overflow, a
 * sustained fold-every-step run, or a cost above Basic each fail it on their
 * own. A candidate that wins on price by folding every step has not found a
 * better policy; it has found the loop R1 measured.
 *
 * `vacuous` is the fourth condition, and it is the one that keeps the other
 * three honest: a trace where NEITHER arm folded is two identical runs, so its
 * cost ratio is exactly 1 by construction and says nothing about the policy.
 * Counting such a trace as a pass is how a scan reports a comfortable plateau
 * that no policy earned — the same vacuity failure R1, R2 and R3 each had to
 * correct.
 */
export interface ReplayGate {
  readonly passed: boolean
  readonly failures: readonly string[]
  /** Neither arm folded: the comparison carries no information. */
  readonly vacuous: boolean
}

/**
 * Judge one paired replay against the RC1-B gate.
 *
 * @param paired - the paired replay.
 * @param options - the sustained-fold run length that counts as pathological.
 * @returns the verdict and every condition that failed.
 */
export function replayGate(
  paired: PairedReplay,
  options: { readonly pathologicalFoldRun?: number; readonly costTolerance?: number } = {},
): ReplayGate {
  const pathological = options.pathologicalFoldRun ?? 5
  const tolerance = options.costTolerance ?? 1
  const failures: string[] = []
  const vacuous = paired.candidate.leafFolds === 0 && paired.basic.leafFolds === 0
  if (vacuous) {
    failures.push('neither arm folded, so the ratio is 1 by construction and the trace is vacuous')
  }
  if (paired.candidate.overflowEvents > 0) {
    failures.push(`${paired.candidate.overflowEvents} overflow event(s)`)
  }
  if (paired.basic.overflowEvents > 0) {
    failures.push(`${paired.basic.overflowEvents} Basic overflow event(s) — the trace itself overflows`)
  }
  if (paired.candidate.longestFoldRun >= pathological) {
    failures.push(
      `sustained fold run of ${paired.candidate.longestFoldRun} steps (>= ${pathological})`,
    )
  }
  if (paired.costRatio > tolerance) {
    failures.push(`cost ratio ${paired.costRatio.toFixed(3)} > ${tolerance}`)
  }
  return { passed: failures.length === 0, failures, vacuous }
}
