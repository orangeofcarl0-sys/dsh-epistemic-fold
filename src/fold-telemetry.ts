/**
 * The engine telemetry record, in one object.
 *
 * ## Why this is a unit rather than fourteen fields on the engine
 *
 * Measured (docs/68 B-1): fourteen of `EpistemicFoldEngine` mutable fields existed
 * one-to-one with a public getter, and the engine carried twenty-one getters in total. So
 * "what does this engine report" was spread through a 1,700-line class, every new counter was
 * a two-site edit INSIDE the decision code it observes, and the only way to read the whole
 * record was to call fourteen accessors in the right order.
 *
 * ## Two halves, and they behave differently
 *
 * COUNTERS only ever increase, and they count what happened rather than what is still on
 * disk (see `bundleWrites`). LAST-OBSERVED values are overwritten by whichever path ran most
 * recently. Mixing them is a real hazard, not a tidiness question: `pressureRegime` and
 * `postLeafRegime` are deliberately separate because collapsing them loses the transition
 * the I1 invariant is about.
 *
 * Every field below carries the measured failure that put it here. Do not remove a note when
 * refactoring this file: it is the only record of why the guard exists.
 *
 * @module dsh-epistemic-fold/fold-telemetry
 */

import type { ContextPolicyDecision } from "./policy-compiler.ts"
import type { EfCompactSpec } from "./policy.ts"
import type { FoldReachability, LeafAdmissionVerdict } from "./fold-economics.ts"
import type { CapacityRegime, PressureRegime } from "./pressure.ts"
import type { evaluateRootRebase } from "./root-policy.ts"

/** Which mechanism committed a fold. */
export type FoldKind = "leaf" | "root" | "emergency"

export interface FoldTelemetry {
  // ---------------------------------------------------------------- counters
  /** Root folds committed by this engine, for maintenance-path verification. */
  rootFolds: number
  /** Leaf folds committed by this engine; the counterpart to `rootFolds`. */
  leafFolds: number
  /** Emergency rebases committed by this engine (provider-overflow recovery). */
  emergencyRebases: number
  /**
   * Bundles this engine has successfully written.
   *
   * A MONOTONIC write counter, deliberately NOT `bundleStore.list().length`.
   * The two differ whenever a bundle is removed, a session directory is
   * cleaned, or the store root becomes unreadable -- and `list()` reports the
   * first two as a smaller number and the third as a thrown error, which a
   * caller that swallows it turns into the same `0` as never folded. A
   * telemetry column must count what happened, not what is still on disk.
   *
   * ## This counts PUBLISHES, not committed folds
   *
   * The two can differ, and the difference is by design. `BundleDurable` before
   * `SurfaceLoss` requires the archive to be durable BEFORE the surface is
   * replaced, so `summarize` publishes the bundle and only then does Basic
   * decide whether to commit -- and it can refuse, e.g. when the framed summary
   * is not smaller than the shadowed content. A refused fold therefore leaves a
   * published bundle behind.
   *
   * That asymmetry is the SAFE direction: a bundle with no surface replacement
   * means history was copied and nothing was lost. The consequence to know
   * about is that `context_search` can find such a bundle, so a caller must not
   * assume `bundleWrites === leafFolds + rootFolds + emergencyRebases`.
   * It is `>=`, and the excess is refused folds.
   *
   * (Measured: a one-turn session whose root fold is refused by the shrink check
   * reports `writes 1, root 0`, and the bundle is retrievable by `context_search`.)
   */
  bundleWrites: number
  /**
   * Derived retrieval answers retired at fold time, cumulatively.
   *
   * Counted rather than inferred, for the same reason every other counter here is: a fold
   * that silently retired material would be the same class of defect as one that silently
   * dropped it, and the archive cannot be asked after the fact.
   */
  derivedAnswersRetired: number

  // ---------------------------------------------------------------- last observed
  /** Pressure threshold resolved by the most recent `compactIfNeeded` (R2-A telemetry). */
  thresholdTokens: number
  /**
   * The WHOLE spec the most recent pressure check resolved, not just its threshold.
   *
   * ## Why the threshold alone was not enough
   *
   * A benchmark archive recorded `folds`, `promptTokensLast` and the fold lineage but NOT
   * the budget those folds were priced against, so a round that folded 50-109 times per cell
   * could not be told apart from one that folded 2-17 times for a reason -- the threshold had
   * to be recovered afterwards by decompressing a bundle and re-deriving
   * `min(contextWindow x thresholdRatio, window - reserve)` by hand. Measured on that round:
   * the window was 32_000 while the working set of the task was 16_471 tokens.
   *
   * Exposed so telemetry can publish what the engine ACTED on rather than a second
   * computation of it that could disagree.
   */
  compactSpec: EfCompactSpec | undefined
  /** Most recent economic leaf-admission verdict (R2-B telemetry). */
  leafAdmission: LeafAdmissionVerdict | undefined
  /** Most recent provider-aware rebase decision (R2-C telemetry). */
  rebaseDecision: ContextPolicyDecision | undefined
  /** Most recent pressure regime `compactIfNeeded` acted on (telemetry). */
  pressureRegime: PressureRegime | undefined
  /**
   * The regime the retry loop found after its most recent leaf (telemetry).
   *
   * Kept SEPARATE from `pressureRegime`, which records the regime the decision was based on.
   * The two differ whenever a leaf fold moves a span into the frozen prefix and pushes the
   * surface from open-bound to frozen-bound -- and collapsing them into one field loses
   * exactly the transition the I1 invariant is about, because the post-fold value would
   * overwrite the entry value the decision was made on.
   */
  postLeafRegime: PressureRegime | undefined
  /**
   * The CAPACITY regime the most recent overflow decision used (telemetry).
   *
   * The soft and hard classifications are not interchangeable, and the overflow path decides
   * on the hard one: a surface can be soft-frozen-bound while still comfortably inside the
   * provider limit, and folding a leaf there is correct because the open tail is what is over
   * capacity. Recording which budget governed the decision is what lets a reader (or a test)
   * tell a legal overflow leaf from an illegal frozen-bound one.
   */
  capacityRegime: CapacityRegime | undefined
  /**
   * The reachability arithmetic from the last automatic fold decision.
   *
   * Recorded because the failure it explains was previously unreadable: a
   * `pressure-unresolved` error named only `frozenTokens`, so a reader could not tell
   * "nothing was foldable" from "the fold did not help" -- and the Phase 7 report concluded
   * the wrong one. This carries the span, the checkpoint and the retained remainder, which
   * is what decides it.
   */
  foldReachability: FoldReachability | undefined
  /** Most recent idle root-rebase advice, or `undefined` before any is produced. */
  rootRebaseAdvice: ReturnType<typeof evaluateRootRebase> | undefined
}

/** A fresh record: every counter zero, every last-observed value unset. */
export function createFoldTelemetry(): FoldTelemetry {
  return {
    rootFolds: 0,
    leafFolds: 0,
    emergencyRebases: 0,
    bundleWrites: 0,
    derivedAnswersRetired: 0,
    thresholdTokens: 0,
    compactSpec: undefined,
    leafAdmission: undefined,
    rebaseDecision: undefined,
    pressureRegime: undefined,
    postLeafRegime: undefined,
    capacityRegime: undefined,
    foldReachability: undefined,
    rootRebaseAdvice: undefined,
  }
}

/**
 * Count one committed fold.
 *
 * One function rather than three increment sites, so the kind-to-counter mapping exists once.
 * The switch it replaced lived inside the fold-commit path, which is exactly where a missing
 * case is hardest to notice.
 */
export function recordFold(telemetry: FoldTelemetry, kind: FoldKind): void {
  switch (kind) {
    case "leaf": telemetry.leafFolds += 1; break
    case "root": telemetry.rootFolds += 1; break
    case "emergency": telemetry.emergencyRebases += 1; break
  }
}
