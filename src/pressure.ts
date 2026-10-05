/**
 * R2-A pressure attribution: split total context pressure into the two parts
 * that need DIFFERENT responses, and detect the self-sustaining fold loop.
 *
 * R1 measured a structural feedback loop: because the frozen prefix is
 * monotonically non-decreasing (EF may never re-fold a frozen checkpoint), once
 * it alone crosses the pressure threshold *every* step is over threshold, each
 * fold can only compact the newly appended tail, and one checkpoint is emitted
 * per step — each paying the full framing preamble. On an identical workload
 * and identical digest text that produced 51 EF folds against Basic's 21.
 *
 * The root cause is that the current trigger asks a question with only one
 * answer:
 *
 *   totalTokens >= threshold  →  fold
 *
 * but "the context is too big" has two very different causes:
 *
 *   open trajectory too long  →  a leaf fold genuinely helps
 *   frozen prefix too large   →  a leaf fold CANNOT help (it only adds a
 *                                checkpoint) and only a rebase reduces load
 *
 * This module separates those cases so policy can act on the distinction. It
 * is pure and behavior-free: R2-A changes no fold decision, it only makes the
 * regime measurable so R2-B can gate on it.
 *
 * @module dsh-epistemic-fold/pressure
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { locateFoldFrontier } from './frontier.ts'
import { frozenCheckpointLoad } from './leaf-policy.ts'

/**
 * Total context pressure decomposed by what would actually fix it.
 *
 * `totalTokens` is the metered request pressure. `frozenTokens` is the part
 * held by frozen EF checkpoints — the part a leaf fold cannot touch.
 * `openTokens` is everything else: raw history past the frontier, which a leaf
 * fold CAN replace.
 */
export interface PressureBreakdown {
  readonly frozenTokens: number
  readonly openTokens: number
  readonly totalTokens: number
  /** Frozen share of the total (0 when the context is empty). */
  readonly frozenRatio: number
  /** Open share of the total (0 when the context is empty). */
  readonly openRatio: number
  /** Number of frozen checkpoints contributing to `frozenTokens`. */
  readonly frozenCount: number
  /** The pressure threshold this breakdown was evaluated against. */
  readonly thresholdTokens: number
  /**
   * True when the frozen prefix ALONE is at or above the threshold. In this
   * state a leaf fold cannot bring the context under threshold: it replaces
   * part of the open tail with a checkpoint that joins the frozen prefix, so
   * the next request is still over threshold and folds again. This is the
   * self-sustaining regime R1 measured.
   */
  readonly leafCannotSuffice: boolean
}

/**
 * Decompose current context pressure.
 *
 * @param session - session whose surface is measured.
 * @param measurement - token-meter measurement matching the current surface.
 * @param thresholdTokens - the pressure threshold in force for this request.
 * @returns the frozen/open split plus the fold-loop flag.
 * @throws when the measurement does not match the session surface — a stale
 *   measurement would attribute pressure to the wrong part.
 */
export function pressureBreakdown(
  session: Session,
  measurement: TokenMeasurement,
  thresholdTokens: number,
): PressureBreakdown {
  const nodes = session.surface.nodes
  if (nodes.length !== measurement.nodes.length
    || nodes.some((seq, index) => seq !== measurement.nodes[index]?.seq)) {
    throw new Error('pressure: token-meter measurement does not match the current session surface')
  }

  const frozen = frozenCheckpointLoad(session, measurement)
  const totalTokens = measurement.totalTokens
  // The frozen load is a subset of the measured surface, so clamping keeps the
  // decomposition exact even when the envelope carries non-surface cost.
  const frozenTokens = Math.min(frozen.tokens, totalTokens)
  const openTokens = Math.max(0, totalTokens - frozenTokens)

  return {
    frozenTokens,
    openTokens,
    totalTokens,
    frozenRatio: totalTokens === 0 ? 0 : frozenTokens / totalTokens,
    openRatio: totalTokens === 0 ? 0 : openTokens / totalTokens,
    frozenCount: frozen.count,
    thresholdTokens,
    leafCannotSuffice: frozen.count > 0 && frozenTokens >= thresholdTokens,
  }
}

/**
 * What one candidate leaf fold would actually reclaim.
 *
 * `MRR` is the fraction of the folded span that is genuinely reclaimed. A leaf
 * whose span is nearly the size of the checkpoint it produces reclaims almost
 * nothing while still paying the full framing preamble — the definition of a
 * fold not worth doing.
 */
export interface LeafMarginalReclaim {
  /** Tokens the candidate span currently occupies. */
  readonly spanTokens: number
  /** Estimated tokens the resulting checkpoint will occupy. */
  readonly checkpointTokens: number
  /** Net reclaim: `spanTokens - checkpointTokens` (may be negative). */
  readonly reclaimTokens: number
  /** Marginal Reclaim Ratio `reclaim / span`; 0 when the span is empty. */
  readonly reclaimRatio: number
}

/**
 * Estimate the marginal reclaim of one candidate span.
 *
 * The checkpoint size is estimated from the frozen prefix's own observed
 * average rather than guessed: a new leaf checkpoint is rendered by the same
 * renderer as the existing ones, so the per-checkpoint cost already on the
 * surface is the best available predictor. With no frozen checkpoint yet, the
 * caller's `fallbackCheckpointTokens` is used (the framing preamble dominates
 * a first checkpoint, so this matters).
 *
 * @param options - span size, the current frozen load, and a fallback size.
 * @returns the reclaim estimate; a negative `reclaimTokens` means the fold
 *   would make the context LARGER.
 */
export function leafMarginalReclaim(options: {
  readonly spanTokens: number
  readonly frozenTokens: number
  readonly frozenCount: number
  readonly fallbackCheckpointTokens: number
}): LeafMarginalReclaim {
  const checkpointTokens = options.frozenCount > 0
    ? options.frozenTokens / options.frozenCount
    : options.fallbackCheckpointTokens
  const reclaimTokens = options.spanTokens - checkpointTokens
  return {
    spanTokens: options.spanTokens,
    checkpointTokens,
    reclaimTokens,
    reclaimRatio: options.spanTokens <= 0 ? 0 : reclaimTokens / options.spanTokens,
  }
}

/** Which pressure regime a request is in, and what that implies. */
export type PressureRegime =
  /** Under threshold: nothing to do. */
  | 'idle'
  /** The open trajectory dominates: a leaf fold is the right response. */
  | 'open-bound'
  /** The frozen prefix alone is over threshold: only a rebase can help. */
  | 'frozen-bound'

/**
 * Classify the regime so policy can stop treating every over-threshold request
 * as a leaf-fold opportunity.
 *
 * @param breakdown - the decomposed pressure.
 * @returns `idle` under threshold, `frozen-bound` when a leaf cannot suffice,
 *   otherwise `open-bound`.
 */
export function classifyPressureRegime(breakdown: PressureBreakdown): PressureRegime {
  if (breakdown.totalTokens < breakdown.thresholdTokens) return 'idle'
  if (breakdown.leafCannotSuffice) return 'frozen-bound'
  return 'open-bound'
}

/** Whether the surface can still be sent to the provider at all. */
export type CapacityRegime =
  /** Comfortably inside the hard capacity. */
  | 'fits'
  /** The frozen prefix ALONE is at or above the hard capacity: no leaf can help. */
  | 'frozen-bound'
  /** Over the hard capacity, but the open trajectory is what pushed it there. */
  | 'open-bound'

/**
 * Classify pressure against the HARD capacity rather than the soft threshold.
 *
 * This is the sibling of {@link classifyPressureRegime}, and the two must not be
 * conflated. The soft threshold asks "do we want more headroom?"; the hard
 * capacity asks "will the provider accept this request?" — a request between the
 * two is foldable at leisure, a request at or above the hard capacity is not
 * sendable at all.
 *
 * The distinction is load-bearing because the soft threshold is CLAMPED by the
 * hard capacity (`resolveEfCompactSpec` takes the `min` of the ratio term and
 * the message budget), so `thresholdTokens === hardCapacityTokens` is reachable
 * whenever `headroomTokens` is 0 or the ratio is high. In that configuration a
 * soft-only reaction is already too late, and a caller that waits for a
 * provider overflow before acting has lost the chance to act deliberately.
 *
 * @param breakdown - the decomposed pressure.
 * @param hardCapacityTokens - `contextWindow - reservedCompletionTokens`.
 * @returns the capacity regime.
 */
export function classifyCapacityRegime(
  breakdown: PressureBreakdown,
  hardCapacityTokens: number,
): CapacityRegime {
  if (breakdown.totalTokens < hardCapacityTokens) return 'fits'
  // Same shape as the soft test, but against the hard budget: a leaf fold
  // replaces open history with a checkpoint that JOINS the frozen prefix, so
  // once that prefix alone exceeds the capacity the next request is over it
  // again no matter how many leaves run.
  if (breakdown.frozenCount > 0 && breakdown.frozenTokens >= hardCapacityTokens) {
    return 'frozen-bound'
  }
  return 'open-bound'
}

/** One step's pressure observation, for fold-cadence analysis. */
export interface PressureSample {
  readonly step: number
  readonly regime: PressureRegime
  readonly frozenTokens: number
  readonly openTokens: number
  readonly totalTokens: number
}

/** How often the run sat in each regime, and whether it was self-sustaining. */
export interface PressureHistory {
  readonly samples: readonly PressureSample[]
  readonly idleCount: number
  readonly openBoundCount: number
  readonly frozenBoundCount: number
  /**
   * True when the run spent most of its steps frozen-bound. This is the
   * signature of the fold-every-step loop: the frozen prefix, not the new
   * history, is what keeps the context over threshold.
   */
  readonly foldEveryStep: boolean
  /**
   * Consecutive frozen-bound steps observed at any point — the direct measure
   * of how long the loop sustained itself.
   */
  readonly longestFrozenBoundRun: number
}

/**
 * Summarize a run's pressure history.
 *
 * @param samples - per-step observations in step order.
 * @param options - the share of steps that counts as "most" (default 0.5).
 * @returns counts, the longest sustained loop, and the fold-every-step flag.
 */
export function summarizePressureHistory(
  samples: readonly PressureSample[],
  options: { readonly foldEveryStepShare?: number } = {},
): PressureHistory {
  const share = options.foldEveryStepShare ?? 0.5
  let idleCount = 0
  let openBoundCount = 0
  let frozenBoundCount = 0
  let longest = 0
  let current = 0
  for (const sample of samples) {
    if (sample.regime === 'idle') idleCount += 1
    else if (sample.regime === 'open-bound') openBoundCount += 1
    else frozenBoundCount += 1
    if (sample.regime === 'frozen-bound') {
      current += 1
      longest = Math.max(longest, current)
    } else {
      current = 0
    }
  }
  return {
    samples: [...samples],
    idleCount,
    openBoundCount,
    frozenBoundCount,
    foldEveryStep: samples.length > 0 && frozenBoundCount / samples.length >= share,
    longestFrozenBoundRun: longest,
  }
}

/**
 * Count frozen checkpoints currently on the surface without re-deriving the
 * whole frontier — a convenience for callers that only need the population.
 */
export function frozenCheckpointCount(session: Session): number {
  return locateFoldFrontier(session).frozenCount
}
