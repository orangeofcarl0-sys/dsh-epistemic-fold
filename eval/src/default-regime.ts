/**
 * RC0-E: what regime do the SHIPPED defaults actually reach?
 *
 * RC0 §19/§35 raised the concern and RC0-C confirmed it empirically: the live
 * tier that produced R3/R4's numbers used a 6000–8000 token window with a tiny
 * frozen budget so that folds and rebases would occur inside a short test.
 * Those are MECHANISM knobs, not product defaults. A user who writes
 * `mode: economy` gets:
 *
 *   contextWindow    131072 (the routed model's real window)
 *   headroomTokens   65536  (the default)
 *   frozenBudget     24000  (the default)
 *
 * and nothing else. So the operating regime R3/R4 measured is NOT the regime a
 * default deployment runs in, and this module computes — analytically, from the
 * config itself — which mechanisms can engage at those numbers.
 *
 * The analysis is pure arithmetic, which is the point: it is cheap, exact, and
 * does not depend on a provider. The live soak confirms it.
 *
 * @module eval/src/default-regime
 */

import { resolveEfCompactSpec, resolveEfConfig } from '../../src/policy.ts'
import type { EpistemicFoldConfig } from '../../src/policy.ts'

/** Where each mechanism's engagement threshold sits, in tokens or turns. */
export interface RegimeBoundaries {
  /** The pressure threshold a fold must cross. */
  readonly foldThresholdTokens: number
  /** The frozen-prefix load a rebase must exceed. */
  readonly rebaseThresholdTokens: number
  /** Tokens a session must reach before ANY fold can happen. */
  readonly tokensBeforeFirstFold: number
  /**
   * Folds needed for the frozen prefix to reach the rebase budget, at a given
   * per-checkpoint size. `Infinity` when a checkpoint is free.
   */
  readonly foldsToReachRebase: (tokensPerCheckpoint: number) => number
  /** The default configuration these boundaries were computed from. */
  readonly config: EpistemicFoldConfig
}

/**
 * Compute the boundaries the DEFAULTS imply.
 *
 * @param contextWindow - the routed model's window.
 * @param reservedCompletionTokens - output tokens reserved against it.
 * @param config - the configuration to analyze; defaults are used when omitted.
 * @returns the fold and rebase engagement points.
 */
export function regimeBoundaries(
  contextWindow: number,
  reservedCompletionTokens: number,
  config: EpistemicFoldConfig = {},
): RegimeBoundaries {
  const resolved = resolveEfConfig(config)
  const spec = resolveEfCompactSpec(resolved, contextWindow, reservedCompletionTokens)
  return {
    foldThresholdTokens: spec.thresholdTokens,
    rebaseThresholdTokens: resolved.frozenCheckpointTokenBudget,
    tokensBeforeFirstFold: spec.thresholdTokens,
    foldsToReachRebase: (tokensPerCheckpoint: number) =>
      tokensPerCheckpoint <= 0 ? Number.POSITIVE_INFINITY
        : Math.ceil(resolved.frozenCheckpointTokenBudget / tokensPerCheckpoint),
    config,
  }
}

/**
 * Whether the two mechanisms can both engage at these defaults.
 *
 * The load-bearing comparison is between the FOLD threshold and the REBASE
 * budget. A rebase is only reachable if the frozen prefix can grow past its
 * budget, and the frozen prefix grows by one checkpoint per fold — so the
 * question is how many folds that takes, and whether a session long enough to
 * produce them is realistic.
 */
export interface RegimeVerdict {
  /** Folds needed before the rebase budget is crossed. */
  readonly foldsToRebase: number
  /**
   * Approximate turns needed, at a given per-turn growth, to reach that many
   * folds. Each fold needs a full threshold's worth of growth.
   */
  readonly turnsToRebase: (tokensPerTurn: number, tokensPerCheckpoint: number) => number
  /** Whether the rebase mechanism is realistically reachable. */
  readonly rebaseReachable: boolean
  readonly reason: string
}

/**
 * Judge whether the rebase path is reachable at these defaults.
 *
 * @param boundaries - the computed boundaries.
 * @param tokensPerCheckpoint - observed checkpoint size for the workload shape.
 * @param tokensPerTurn - observed growth per turn.
 * @param realisticTurns - the session length considered realistic (default 2000).
 * @returns the verdict, with the arithmetic that produced it.
 */
export function judgeRegime(
  boundaries: RegimeBoundaries,
  tokensPerCheckpoint: number,
  tokensPerTurn: number,
  realisticTurns = 2_000,
): RegimeVerdict {
  const foldsToRebase = boundaries.foldsToReachRebase(tokensPerCheckpoint)
  const turnsToRebase = (perTurn: number, perCheckpoint: number): number => {
    const folds = boundaries.foldsToReachRebase(perCheckpoint)
    if (!Number.isFinite(folds)) return Number.POSITIVE_INFINITY
    // Each fold requires the surface to regrow to the threshold, which takes
    // threshold/perTurn turns; the first fold also needs that same growth.
    const turnsPerFold = perTurn <= 0
      ? Number.POSITIVE_INFINITY
      : boundaries.foldThresholdTokens / perTurn
    return folds * turnsPerFold
  }
  const turns = turnsToRebase(tokensPerTurn, tokensPerCheckpoint)
  const reachable = turns <= realisticTurns
  return {
    foldsToRebase,
    turnsToRebase,
    rebaseReachable: reachable,
    reason: reachable
      ? `a rebase needs ${foldsToRebase} fold(s) at ${tokensPerCheckpoint} tokens/checkpoint, `
        + `about ${Math.round(turns)} turns at ${tokensPerTurn} tokens/turn — within a `
        + `${realisticTurns}-turn session`
      : `a rebase needs ${foldsToRebase} fold(s) at ${tokensPerCheckpoint} tokens/checkpoint, `
        + `about ${Number.isFinite(turns) ? Math.round(turns) : 'infinitely many'} turns at `
        + `${tokensPerTurn} tokens/turn — beyond a ${realisticTurns}-turn session, so the rebase `
        + 'path does not engage at these defaults',
  }
}

/** Render the regime analysis for a report. */
export function regimeToMarkdown(boundaries: RegimeBoundaries, verdict: RegimeVerdict): string {
  return [
    `- Fold threshold: **${boundaries.foldThresholdTokens}** tokens`,
    `- Rebase budget: **${boundaries.rebaseThresholdTokens}** tokens`,
    `- Folds to cross the rebase budget: **${verdict.foldsToRebase}**`,
    `- Rebase reachable: **${verdict.rebaseReachable ? 'yes' : 'no'}**`,
    `- ${verdict.reason}`,
  ].join('\n')
}
