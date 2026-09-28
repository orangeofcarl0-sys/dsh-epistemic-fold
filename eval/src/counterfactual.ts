/**
 * R1-B counterfactual ROI lab: what a proposed mechanism WOULD save if it
 * worked perfectly, measured before anyone writes it into production.
 *
 * docs/11 §7-§9 is explicit that the order matters: simulate the theoretical
 * upper bound first, and only productionize when the measured ROI justifies
 * the new correctness seam. A mechanism that could save 2-3% is not worth a
 * new way to lose state; one that could save 30-50% is worth it even before
 * there is direct evidence, because the upper bound already settles it.
 *
 * The oracle arms here are SHADOW policies over the SAME recorded surface:
 * they re-price an existing run under an idealized representation and report
 * the delta. They are not implementations, they never run in production, and
 * they make their idealization assumptions explicit so a saving can never be
 * mistaken for an achievable one.
 *
 * @module eval/counterfactual
 */

import type { ContextEconomicsProfile } from '../../src/economics-profile.ts'
import { modeledCost } from '../../src/economics-profile.ts'
import type { RunAttribution, TokenBucket } from './token-attribution.ts'
import { TOKEN_BUCKETS } from './token-attribution.ts'

/** One counterfactual policy's idealization assumptions, stated openly. */
export interface OracleArm {
  readonly id: string
  readonly label: string
  /**
   * The idealization this arm assumes. A saving measured under a generous
   * assumption is an UPPER BOUND, and the report must say so.
   */
  readonly assumption: string
  /**
   * Tokens this arm removes from one step's attribution.
   * @returns the removed tokens per bucket (never more than the bucket holds).
   */
  readonly remove: (attribution: RunAttributionStepView) => Partial<Record<TokenBucket, number>>
}

/** The per-step view an oracle arm reasons over. */
export interface RunAttributionStepView {
  readonly buckets: Readonly<Record<TokenBucket, number>>
  readonly total: number
  readonly checkpoints: { readonly leaf: number; readonly root: number; readonly basic: number }
}

/** One arm's measured effect across a run. */
export interface OracleResult {
  readonly armId: string
  readonly label: string
  readonly assumption: string
  /** Tokens the arm removes across the run, by bucket. */
  readonly removedByBucket: Readonly<Partial<Record<TokenBucket, number>>>
  readonly removedTotal: number
  /** Run prompt tokens before / after the idealization. */
  readonly baselineTokens: number
  readonly counterfactualTokens: number
  /** Fraction of prompt tokens removed (0 when the run spent nothing). */
  readonly savingFraction: number
  /** Prompt exposure (total/peak) under each policy. */
  readonly baselinePeakTokens: number
  readonly counterfactualPeakTokens: number
}

function clampRemove(
  buckets: Readonly<Record<TokenBucket, number>>,
  requested: Partial<Record<TokenBucket, number>>,
): Partial<Record<TokenBucket, number>> {
  const removed: Partial<Record<TokenBucket, number>> = {}
  for (const bucket of TOKEN_BUCKETS) {
    const want = requested[bucket]
    if (want === undefined || want <= 0) continue
    removed[bucket] = Math.min(want, buckets[bucket])
  }
  return removed
}

function removedSum(removed: Partial<Record<TokenBucket, number>>): number {
  return TOKEN_BUCKETS.reduce((sum, bucket) => sum + (removed[bucket] ?? 0), 0)
}

/**
 * Measure one oracle arm over a recorded run.
 *
 * @param run - the run's per-step attributions (the shadow surface).
 * @param arm - the idealization to apply.
 * @returns the arm's measured effect; `savingFraction` is the upper bound.
 */
export function measureOracle(run: RunAttribution, arm: OracleArm): OracleResult {
  const removedByBucket: Partial<Record<TokenBucket, number>> = {}
  let baselineTokens = 0
  let counterfactualTokens = 0
  let baselinePeakTokens = 0
  let counterfactualPeakTokens = 0

  for (const step of run.steps) {
    baselineTokens += step.total
    baselinePeakTokens = Math.max(baselinePeakTokens, step.total)
    const removed = clampRemove(step.buckets, arm.remove({
      buckets: step.buckets,
      total: step.total,
      checkpoints: step.checkpoints,
    }))
    for (const [bucket, tokens] of Object.entries(removed)) {
      removedByBucket[bucket as TokenBucket] = (removedByBucket[bucket as TokenBucket] ?? 0) + tokens
    }
    const after = step.total - removedSum(removed)
    counterfactualTokens += after
    counterfactualPeakTokens = Math.max(counterfactualPeakTokens, after)
  }

  return {
    armId: arm.id,
    label: arm.label,
    assumption: arm.assumption,
    removedByBucket,
    removedTotal: removedSum(removedByBucket),
    baselineTokens,
    counterfactualTokens,
    savingFraction: baselineTokens === 0 ? 0 : removedSum(removedByBucket) / baselineTokens,
    baselinePeakTokens,
    counterfactualPeakTokens,
  }
}

// ---------------------------------------------------------------------------
// The shadow arms (docs/11 §7)
// ---------------------------------------------------------------------------

/**
 * Delta Leaf: the idealized generational-leaf representation. Assumes every
 * leaf checkpoint AFTER the first carries only its state CHANGES rather than a
 * full Current snapshot, so the recurring full-snapshot payload disappears
 * from every later request.
 *
 * This is deliberately generous: it charges the FIRST leaf checkpoint its full
 * state payload (the snapshot has to exist somewhere) and removes the state
 * payload of every subsequent one. The rationale is left untouched, since a
 * delta leaf still needs its local reasoning. If even this generous version
 * does not beat the status quo on a workload, no real Delta Leaf can.
 */
export function deltaLeafArm(): OracleArm {
  return {
    id: 'E-delta-oracle',
    label: 'E-delta-oracle (idealized Delta Leaf)',
    assumption:
      'Every leaf checkpoint after the first carries only state changes: the full Current snapshot '
      + 'is charged once and the recurring full-state payload is removed from all later checkpoints. '
      + 'Rationale and framing are unchanged, and no correctness cost is charged.',
    remove: (step) => {
      if (step.checkpoints.leaf <= 1) return {}
      // One full snapshot is still carried by the first leaf; the rest become
      // deltas. Conservatively keep one leaf's worth of state in the surface.
      const perLeaf = step.buckets['checkpoint-leaf-state'] / step.checkpoints.leaf
      return { 'checkpoint-leaf-state': perLeaf * (step.checkpoints.leaf - 1) }
    },
  }
}

/**
 * M1 ingress reduction: the idealized typed-tool-result representation. Every
 * raw tool result is replaced by a small typed summary plus an artifact
 * reference, so a large tool output costs a bounded number of tokens.
 *
 * The bounded size is a parameter because the honest question is "how small
 * would a typed result have to be before this pays?" — not "assume it is
 * free". The default keeps 4% of the raw result, i.e. a 25x reduction, which
 * is already an aggressive idealization for real tool output.
 */
export function m1IngressArm(options: { readonly retainedFraction?: number } = {}): OracleArm {
  const retainedFraction = options.retainedFraction ?? 0.04
  return {
    id: 'E-M1-oracle',
    label: 'E-M1-oracle (idealized typed tool results)',
    assumption:
      `Every raw tool result is replaced by a typed summary plus an artifact ref retaining `
      + `${(retainedFraction * 100).toFixed(1)}% of its tokens (a ${(1 / retainedFraction).toFixed(0)}x reduction). `
      + 'No information is assumed lost and no extra retrieval cost is charged.',
    remove: (step) => ({
      'raw-tool-result': step.buckets['raw-tool-result'] * (1 - retainedFraction),
    }),
  }
}

/**
 * M5 generational merge: the idealized hierarchy. Assumes frozen leaf
 * checkpoints periodically merge into ONE root snapshot, so the frozen prefix
 * stops growing linearly in the number of folds.
 *
 * The idealization is strong — it assumes a merge costs nothing on the request
 * path and that a single merged snapshot carries all retained state. It is
 * therefore an upper bound on what M5 could ever buy, which is exactly what a
 * routing decision needs.
 */
export function m5GenerationalArm(options: { readonly mergedFrozenFraction?: number } = {}): OracleArm {
  const mergedFraction = options.mergedFrozenFraction ?? 0.25
  return {
    id: 'E-M5-oracle',
    label: 'E-M5-oracle (idealized generational merge)',
    assumption:
      `All frozen leaf checkpoints merge into a single root snapshot retaining `
      + `${(mergedFraction * 100).toFixed(0)}% of their combined tokens, with zero merge cost on the `
      + 'request path and no state loss. An upper bound on any real generational fold.',
    remove: (step) => {
      if (step.checkpoints.leaf <= 1) return {}
      const frozen = step.buckets['checkpoint-leaf-state']
        + step.buckets['checkpoint-leaf-rationale']
        + step.buckets['checkpoint-framing']
      const merged = frozen * mergedFraction
      // The merged snapshot is a root: charge it there, remove the leaves.
      const removable = frozen - merged
      const share = frozen === 0 ? 0 : removable / frozen
      return {
        'checkpoint-leaf-state': step.buckets['checkpoint-leaf-state'] * share,
        'checkpoint-leaf-rationale': step.buckets['checkpoint-leaf-rationale'] * share,
        'checkpoint-framing': step.buckets['checkpoint-framing'] * share,
      }
    },
  }
}

/**
 * Adaptive Root: the idealized provider-aware rebase. Assumes the rebase
 * fires exactly when it is economically justified and removes the frozen
 * prefix's recurring cost from every subsequent request.
 *
 * Unlike the other arms this is NOT a new mechanism — it is a policy change
 * over existing machinery, so a strong result here routes to R1-D rather than
 * to a new fold mode.
 */
export function adaptiveRootArm(): OracleArm {
  return {
    id: 'E-adaptive-root-oracle',
    label: 'E-adaptive-root-oracle (idealized amortized rebase)',
    assumption:
      'A root rebase fires whenever its payback horizon is met, collapsing the frozen prefix to a '
      + 'single snapshot at no request-path cost after the rebase itself. An upper bound on an '
      + 'amortized-cost rebase policy over the EXISTING root fold.',
    remove: (step) => {
      if (step.checkpoints.leaf === 0) return {}
      // Keep one checkpoint's worth (the post-rebase snapshot); the rest is
      // the recurring load the rebase removes.
      const frozen = step.buckets['checkpoint-leaf-state']
        + step.buckets['checkpoint-leaf-rationale']
        + step.buckets['checkpoint-framing']
      const perCheckpoint = frozen / step.checkpoints.leaf
      return {
        'checkpoint-leaf-state': Math.max(0, step.buckets['checkpoint-leaf-state'] - perCheckpoint),
        'checkpoint-leaf-rationale': Math.max(0, step.buckets['checkpoint-leaf-rationale'] - perCheckpoint * 0.2),
        'checkpoint-framing': Math.max(0, step.buckets['checkpoint-framing'] - perCheckpoint * 0.8),
      }
    },
  }
}

/**
 * Framing deduplication: the idealized "state the handoff instruction once"
 * representation.
 *
 * This arm exists because measurement, not intuition, demanded it. Every leaf
 * checkpoint on the surface repeats the SAME ~116-token preamble plus the
 * `<compacted-summary>` wrapper and marker line, so each checkpoint node is
 * ~87% fixed overhead and ~13% payload. With one checkpoint per fold, that
 * overhead grows linearly in the fold count — and it dwarfs the full-state
 * payload that a Delta Leaf representation would remove.
 *
 * The idealization assumes the preamble is stated once per surface (or folded
 * into the system prompt) while every checkpoint keeps its own marker and
 * state, so no identity or recall capability is lost. It is a policy/layout
 * change over existing machinery, not a new fold mode.
 */
export function framingDedupArm(): OracleArm {
  return {
    id: 'E-framing-oracle',
    label: 'E-framing-oracle (deduplicated handoff preamble)',
    assumption:
      'The repeated per-checkpoint preamble and summary wrapper are emitted once per surface instead '
      + 'of once per checkpoint. Every checkpoint keeps its marker, state, rationale, and recall '
      + 'pointer, so no identity or recoverability is assumed lost. An upper bound on what framing '
      + 'deduplication could save.',
    remove: (step) => {
      if (step.checkpoints.leaf <= 1) return {}
      // One checkpoint keeps its framing; the rest contribute their repeated
      // share. Only the framing bucket is touched — state and rationale stay.
      const perCheckpoint = step.buckets['checkpoint-framing'] / step.checkpoints.leaf
      return { 'checkpoint-framing': perCheckpoint * (step.checkpoints.leaf - 1) }
    },
  }
}

/** Every shadow arm, in docs/11 §7 order plus the measurement-driven addition. */
export function allOracleArms(): readonly OracleArm[] {
  return [deltaLeafArm(), m1IngressArm(), m5GenerationalArm(), adaptiveRootArm(), framingDedupArm()]
}

// ---------------------------------------------------------------------------
// Money: turning a saving into a routing decision
// ---------------------------------------------------------------------------

/** One arm's saving expressed in money under one profile. */
export interface OracleEconomics {
  readonly armId: string
  readonly savingFraction: number
  readonly baselineCost: number
  readonly counterfactualCost: number
  /** Absolute money saved across the run. */
  readonly savedCost: number
}

/**
 * Price an arm's token saving under a profile.
 *
 * The saving is attributed at the WARM price, because the tokens an arm
 * removes from a recurring prefix are exactly the tokens that would otherwise
 * have been billed at the cache-hit price. Pricing them at the miss price
 * would overstate every arm's value on a cache-dominant model — precisely the
 * error docs/11 §3 warns about, and the one that would make a "48% token
 * saving" look like a 48% bill reduction when it is nothing of the kind.
 *
 * @param result - the arm's measured token effect.
 * @param profile - the routed model's economics.
 * @param options - the run's measured architectural split, realization rate,
 *   and prompt sizing for tier selection.
 * @returns money saved, or `undefined` when the profile has no prices.
 */
export function priceOracleSaving(
  result: OracleResult,
  profile: ContextEconomicsProfile,
  options: {
    readonly realizationRate: number
    /**
     * Warm (stable-prefix) tokens the run actually carried, summed across
     * steps. Removed tokens are charged at this price, not at the miss price.
     */
    readonly warmTokens: number
    /** Fresh (miss) tokens the run actually carried, summed across steps. */
    readonly freshTokens: number
    readonly outputTokensPerStep?: number
    readonly steps: number
  },
): OracleEconomics {
  const steps = Math.max(1, options.steps)
  const outputTokensPerStep = options.outputTokensPerStep ?? 0

  const baseline = modeledCost(profile, {
    stablePrefixTokens: options.warmTokens,
    freshTokens: options.freshTokens,
    outputTokens: outputTokensPerStep * steps,
    realizationRate: options.realizationRate,
  }).totalCost

  // The removed tokens are drawn from the warm region: an arm that shrinks the
  // frozen prefix removes cache-warm tokens, so the saving is the warm price,
  // not the miss price. The removed count can never exceed what was warm.
  const removedWarm = Math.min(result.removedTotal, options.warmTokens)
  const counterfactual = modeledCost(profile, {
    stablePrefixTokens: options.warmTokens - removedWarm,
    freshTokens: options.freshTokens,
    outputTokens: outputTokensPerStep * steps,
    realizationRate: options.realizationRate,
  }).totalCost

  return {
    armId: result.armId,
    savingFraction: result.savingFraction,
    baselineCost: baseline,
    counterfactualCost: counterfactual,
    savedCost: baseline - counterfactual,
  }
}

/** Implementation risk/complexity of each candidate, for the routing gate. */
export type CandidateRisk = 'low' | 'medium' | 'high'

/** One row of the docs/11 §27 route-selection table. */
export interface RoutingRow {
  readonly armId: string
  readonly label: string
  /** Saving fraction on this workload (upper bound). */
  readonly saving: number
  /** Money saved on this workload under the priced profile. */
  readonly savedCost: number
  readonly risk: CandidateRisk
  /** Whether this arm is a new mechanism or a policy change over existing ones. */
  readonly kind: 'new-mechanism' | 'policy-change'
}

/**
 * Rank candidates by measured saving against implementation risk and
 * correctness cost (docs/11 §27). The gate is deliberately NOT the milestone
 * numbering: a high-saving low-risk policy change outranks a high-saving
 * high-risk new mechanism.
 *
 * @returns rows sorted by saving descending, so the strongest evidence leads.
 */
export function rankCandidates(rows: readonly RoutingRow[]): readonly RoutingRow[] {
  return [...rows].sort((left, right) => {
    if (right.saving !== left.saving) return right.saving - left.saving
    return left.risk.localeCompare(right.risk)
  })
}
