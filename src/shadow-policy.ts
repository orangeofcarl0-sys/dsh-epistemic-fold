/**
 * The Shadow Folding Policy: what proactive maintenance would recommend right
 * now, computed without performing any.
 *
 * ## The rule this exists to keep
 *
 * "Recommendation is not authority" is already load-bearing in this project — it
 * is why an idle rebase re-measures rather than trusting a recorded intent. A
 * shadow policy is the same discipline one step earlier: it answers "if early
 * maintenance were allowed, what would it do?" while being structurally incapable
 * of doing it. This module therefore returns a value. It never records a
 * `PendingRebaseIntent`, never calls `compactNow`, and never touches the session
 * surface — there is no code path here that can.
 *
 * ## What it reuses, and the one thing it improves
 *
 * The leaf branch delegates to the PRODUCTION gate, `admitLeafEconomically`, so a
 * shadow leaf verdict and a real leaf admission cannot disagree — the shadow is
 * literally the same question asked of the same function.
 *
 * The root branch reuses `rootBreakEvenRequests` with the profile resolved for
 * the routed model, exactly as `evaluateEconomicRebase` does. The one deliberate
 * difference is the input to that arithmetic:
 *
 *     evaluateEconomicRebase   frozenAfter = frozenTokens / frozenCheckpointCount
 *                              (the LEAF-checkpoint average)
 *     this module              frozenAfter = frozenTokens - estimatedRootReclaim
 *                              (the checkpoint a rebase would ACTUALLY leave)
 *
 * The average is the right estimate for a leaf checkpoint and the wrong one for a
 * rebase, which condenses the whole leading range: measured on the LHTB shape, the
 * leaf average is 116 tokens while the leading range a rebase would replace is
 * also small, and using the leaf average there makes a rebase look like it removes
 * almost nothing. Using the actual legal root span is what lets the shadow answer
 * "how much WOULD this rebase reclaim" instead of "how much would a leaf-sized
 * checkpoint reclaim". See `working-set.ts` for how the reclaim is derived and why
 * it is `unknown` rather than a guess when it cannot be.
 *
 * ## What it refuses to be
 *
 * Not a thermal threshold: `if (coldRatio > 0.6) root()` is not here, and would be
 * wrong even with a reliable cold ratio, because cold state is frequently state
 * that has left hot state *legitimately* (a resolved failure, a superseded value)
 * and folding it away saves the archive cost of something already archived. Not a
 * universal fix either: an early rebase cannot help an oversized last tool result,
 * which no root range covers.
 *
 * @module dsh-epistemic-fold/shadow-policy
 */

import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  classifyRegime,
  effectiveRho,
  resolveProfile,
  rhoOf,
  rootBreakEvenRequests,
} from './economics-profile.ts'
import type { ContextEconomicsProfile } from './economics-profile.ts'
import { ROOT_REBASE_COOLDOWN, admitLeafEconomically } from './fold-economics.ts'
import type { EfCompactSpec, ResolvedEpistemicFoldConfig } from './policy.ts'
import { assessWorkingSet } from './working-set.ts'
import type { WorkingSetPressure } from './working-set.ts'

/** What a shadow policy would do, and whether it could actually do it. */
export interface ShadowFoldingDecision {
  readonly action: 'none' | 'leaf' | 'root'
  /** One line naming the arithmetic behind the action. */
  readonly reason: string
  /** `span - surviving checkpoint` for the recommended action. */
  readonly estimatedNetReclaimTokens?: number
  /**
   * The break-even request count for a recommended rebase. Present only for
   * `root`, because only a rebase has a one-time cost to amortize.
   */
  readonly expectedEconomicBenefit?: number
  /**
   * How well established the recommendation is.
   *
   * `high`    — the reclaim is priced from a rendered checkpoint body.
   * `limited` — priced from an observed average rather than a rendered body.
   * `unknown` — no basis for the reclaim; the action is NOT recommended.
   */
  readonly confidence: 'high' | 'limited' | 'unknown'
  /** Whether the action could be taken now without further evidence. */
  readonly executable: boolean
  /** Every reason an action is unavailable or was refused. */
  readonly blockers: readonly string[]
  /** The decomposition the decision was made on, so a reader can check it. */
  readonly workingSet: WorkingSetPressure
}

/** Options for {@link decideShadowFolding}. */
export interface ShadowPolicyOptions {
  readonly session: Session
  readonly measurement: TokenMeasurement
  readonly spec: EfCompactSpec
  readonly config: ResolvedEpistemicFoldConfig
  /**
   * Folds since the last root rebase, for the anti-oscillation cooldown. Read
   * from the engine rather than inferred, because the engine is what observes
   * folds and therefore the only thing that knows.
   */
  readonly stepsSinceRootRebase: number
  /** The routed provider/model, for profile selection. */
  readonly provider: string
  readonly model: string
  /** See {@link AssessWorkingSetOptions.state}. */
  readonly state?: Parameters<typeof assessWorkingSet>[0]['state']
  /** See {@link AssessWorkingSetOptions.estimateText}. */
  readonly estimateText?: (text: string) => number
}

/** Confidence implied by how the surviving checkpoint was priced. */
function confidenceOf(basis: WorkingSetPressure['basis']['rootReclaimBasis']): ShadowFoldingDecision['confidence'] {
  if (basis === 'rendered-state') return 'high'
  if (basis === 'observed-average' || basis === 'framing-fallback') return 'limited'
  return 'unknown'
}
/**
 * Compute the shadow folding decision for the current surface.
 *
 * @param options - the surface, the spec in force, the resolved policy, and the
 *   routed model.
 * @returns the recommendation with its arithmetic, confidence and blockers.
 * @throws when the measurement does not match the session surface, which the
 *   decomposition already refuses.
 */
export function decideShadowFolding(options: ShadowPolicyOptions): ShadowFoldingDecision {
  const {
    session, measurement, spec, config, stepsSinceRootRebase,
    provider, model, state, estimateText,
  } = options
  const workingSet = assessWorkingSet({
    session,
    measurement,
    thresholdTokens: spec.thresholdTokens,
    retainTokens: spec.retainTokens,
    ...(state === undefined ? {} : { state }),
    ...(estimateText === undefined ? {} : { estimateText }),
  })
  const blockers: string[] = [...workingSet.blockers]
  const overThreshold = workingSet.totalTokens >= spec.thresholdTokens

  // --- Proactive leaf.
  //
  // TWO conditions, and both are needed — this is the part that is easy to get
  // wrong, and getting it wrong produces a confidently false recommendation:
  //
  //   1. the production gate admits the fold (its floors), AND
  //   2. the engine's OWN selector finds a span at the retention in force.
  //
  // Condition 2 is not implied by condition 1. `admitLeafEconomically` probes
  // `selectLeafSpan(session, measurement, 0)` — the widest span any retention
  // would allow — while the fold loop folds at `spec.retainTokens`. Measured on a
  // 2172-token surface with a 3809-token retention: the gate admits a fold
  // reclaiming 1551 tokens, and the engine's selector returns `null` because the
  // retention budget already retains the entire surface. Reporting `leaf` there
  // would be a recommendation the engine cannot execute, which is exactly what
  // `executable` exists to prevent.
  const admission = admitLeafEconomically({
    session,
    measurement,
    thresholdTokens: spec.thresholdTokens,
    minReclaimTokens: config.minReclaimTokens,
    minReclaimRatio: config.minReclaimRatio,
  })
  if (admission.admitted && workingSet.legalLeafSpanTokens > 0) {
    // The gate always prices the reclaim it admitted, so this is present; the
    // decomposition's own figure is preferred when it exists because it carries
    // the better basis (a rendered body rather than an average).
    const reclaim = workingSet.estimatedLeafReclaimTokens ?? admission.reclaim?.reclaimTokens
    return {
      action: 'leaf',
      reason:
        `a legal leaf span of ${workingSet.legalLeafSpanTokens} tokens is available and the `
        + `production gate admits it: ${admission.detail}`
        + (overThreshold
          ? ' (the surface is already over threshold, so this is a due fold rather than an early one)'
          : ' (the surface is UNDER threshold, so this would be an EARLY fold the current policy '
            + 'does not take)'),
      ...(reclaim === undefined ? {} : { estimatedNetReclaimTokens: reclaim }),
      confidence: workingSet.basis.leafReclaimBasis === 'rendered-state' ? 'high' : 'limited',
      // Under `leafAdmission: legacy` there are no floors, so a structurally
      // legal span is executable on its own. Under `economic` the gate already
      // said yes, which is the same thing.
      executable: true,
      // ## The blockers are CARRIED, not cleared
      //
      // A leaf can be worth taking and still fail to converge — that is the RC28
      // shape, and the engine itself takes exactly one fold there before stopping.
      // Clearing the blockers here would hide the non-convergence warning that
      // the decomposition computed, so a reader would see a recommendation and
      // no indication that the surface stays over threshold afterwards.
      blockers,
      workingSet,
    }
  }
  blockers.push(`no leaf fold is admissible: ${admission.detail}`)

  // --- Proactive root: the break-even arithmetic on the ACTUAL root span.
  //
  // ## Why a frozen prefix must exist first
  //
  // A rebase exists to collapse the frozen prefix. With NO frozen checkpoint
  // there is nothing to collapse, so there is no residency cost to pre-empt and a
  // "proactive rebase" would be a rebase of raw history that is already being
  // managed by leaf folds. The economics alone cannot see this: with no
  // compaction cost the break-even horizon is zero, so the arithmetic cheerfully
  // recommends a rebase of a small, healthy, entirely unfrozen surface. Measured
  // on a 4K surface against a 25.6K threshold: `root`, executable, break-even 0.0.
  //
  // This is the guard the spec names as "预计 Root 不能有效缩小上下文" — an early
  // root is not a general-purpose fix, and requiring something frozen to rebase
  // is what keeps it from becoming one.
  if (workingSet.frozenCheckpointCount === 0) {
    return {
      action: 'none',
      reason:
        'no rebase is recommended: no frozen checkpoint exists, so there is no accumulated '
        + 'checkpoint residency to collapse — leaf folds are the mechanism for raw history',
      confidence: 'high',
      executable: false,
      blockers,
      workingSet,
    }
  }
  const profile = resolveProfile(config.rootPolicy.profiles, provider, model)
  const reclaim = workingSet.estimatedRootReclaimTokens
  if (reclaim === undefined) {
    return {
      action: 'none',
      reason:
        'no rebase is recommended: the reclaim a rebase would achieve cannot be established, '
        + 'so recommending one would be a guess',
      confidence: 'unknown',
      executable: false,
      blockers,
      workingSet,
    }
  }
  if (reclaim <= 0) {
    return {
      action: 'none',
      reason:
        `no rebase is recommended: it would reclaim ${reclaim.toFixed(0)} tokens, so it would `
        + 'not shrink the context',
      confidence: confidenceOf(workingSet.basis.rootReclaimBasis),
      executable: false,
      blockers,
      workingSet,
    }
  }

  // ## Why a rebase must also REACH the threshold
  //
  // A reclaim greater than zero is not enough to make a rebase worth doing, and
  // the case that proves it is the RC28 shape. Measured on a 60,139-token
  // surface whose last node is a 60K tool result: the legal root range is the
  // single 119-token checkpoint, so a rebase "reclaims" 99 tokens — 0.16% of the
  // surface — and breaks even instantly. Reporting `root` there would be a
  // confidently false recommendation, and it is precisely the escalation RC28
  // rejected: it converts a diagnosable "nothing can reach the threshold" into an
  // action that appears to work and leaves the context over the limit.
  //
  // The gate is `rootReachable`, which is already computed and is not a new
  // knob: it asks whether the rebase brings the surface under the threshold. It
  // admits a proactive rebase below threshold (trivially reachable), admits a
  // rebase that fixes an over-threshold open-bound surface, and refuses exactly
  // the case where no mechanism can help.
  if (workingSet.rootReachable === false) {
    return {
      action: 'none',
      reason:
        `no rebase is recommended: it would reclaim ${reclaim.toFixed(0)} tokens `
        + `(${((reclaim / Math.max(1, workingSet.totalTokens)) * 100).toFixed(2)}% of the surface) `
        + `and leave ${(workingSet.totalTokens - reclaim).toFixed(0)} against a threshold of `
        + `${spec.thresholdTokens}, so it would not restore headroom. This is the shape RC28 `
        + 'identified: the retained tail — not the frozen prefix — holds the pressure, and no '
        + 'fold or rebase can reach it',
      confidence: confidenceOf(workingSet.basis.rootReclaimBasis),
      executable: false,
      blockers,
      workingSet,
    }
  }

  // The rebase replaces the leading range with one checkpoint, so the tokens
  // removed from every later request are `rootSpan - surviving` — the reclaim.
  // `rootBreakEvenRequests` reads only the DIFFERENCE of these two, so passing
  // the span and its survivor expresses ΔF exactly; passing the frozen prefix
  // (as the engine's own caller must, having nothing else) would understate it.
  // Measured on a 30-turn tool chain: 714 frozen tokens across 6 checkpoints
  // against a real leading range of 7764 and a reclaim of 7744.
  const rootSpan = workingSet.rootSpanTokens ?? 0
  const breakEven = rootBreakEvenRequests({
    profile,
    frozenBefore: rootSpan,
    frozenAfter: Math.max(0, rootSpan - reclaim),
    realizationRate: config.rootPolicy.realizationRate,
    promptTokens: workingSet.totalTokens,
    compactionCost: config.rootPolicy.compactionCost,
  })

  if (stepsSinceRootRebase < ROOT_REBASE_COOLDOWN) {
    blockers.push(
      `only ${stepsSinceRootRebase} fold(s) since the last rebase; the anti-oscillation `
      + `cooldown is ${ROOT_REBASE_COOLDOWN}`,
    )
  }

  const confidence = confidenceOf(workingSet.basis.rootReclaimBasis)
  const withinHorizon = breakEven !== undefined && breakEven <= config.rootPolicy.paybackHorizonRequests
  const cooldownClear = stepsSinceRootRebase >= ROOT_REBASE_COOLDOWN
  if (!withinHorizon || !cooldownClear) {
    const reason = breakEven === undefined
      ? 'no rebase is recommended: the rebase removes nothing per request, so it can never pay back'
      : !withinHorizon
        ? `no rebase is recommended: break-even ${breakEven.toFixed(1)} requests exceeds the `
          + `horizon of ${config.rootPolicy.paybackHorizonRequests}`
        : `no rebase is recommended: the anti-oscillation cooldown has not elapsed`
    return {
      action: 'none',
      reason,
      confidence,
      executable: false,
      blockers,
      workingSet,
    }
  }

  return {
    action: 'root',
    reason:
      `a rebase of the leading ${workingSet.rootSpanTokens ?? 0} tokens would reclaim `
      + `${reclaim.toFixed(0)} and break even in ${breakEven.toFixed(1)} request(s), within the `
      + `horizon of ${config.rootPolicy.paybackHorizonRequests} `
      + `(regime ${classifyRegime({
        rho: rhoOf(profile, workingSet.totalTokens),
        realizationRate: config.rootPolicy.realizationRate,
      })}, rho_eff ${effectiveRho(
        rhoOf(profile, workingSet.totalTokens),
        config.rootPolicy.realizationRate,
      ).toFixed(3)})`,
    estimatedNetReclaimTokens: reclaim,
    expectedEconomicBenefit: breakEven,
    confidence,
    // A rebase is executable regardless of whether the soft threshold has been
    // crossed: the whole point of a PROACTIVE rebase is to act before it is.
    // What it needs is a legal range and a reclaim, both established above.
    executable: true,
    blockers: [],
    workingSet,
  }
}

/** The profile a decision was priced under, for a report that must name it. */
export function shadowProfileId(
  config: ResolvedEpistemicFoldConfig,
  provider: string,
  model: string,
): string {
  return resolveProfile(config.rootPolicy.profiles, provider, model).id
}

/** One line naming the decision, for a log or a report. */
export function describeShadowDecision(decision: ShadowFoldingDecision): string {
  const reclaim = decision.estimatedNetReclaimTokens === undefined
    ? 'reclaim unknown'
    : `reclaim ${decision.estimatedNetReclaimTokens.toFixed(0)}`
  const benefit = decision.expectedEconomicBenefit === undefined
    ? ''
    : `, break-even ${decision.expectedEconomicBenefit.toFixed(1)} request(s)`
  return `shadow: ${decision.action} (${decision.confidence}, executable ${decision.executable}) `
    + `— ${reclaim}${benefit}; ${decision.reason}`
}

/** Exposed for a report that must show the profile list a decision could use. */
export type ShadowProfile = ContextEconomicsProfile
