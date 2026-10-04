/**
 * Root-fold policy: the manual `/compact` path is a Root Fold by definition
 * (D-004) — low-frequency, cache-reset-accepting global cleanup. In M2 the
 * root fold is semantic-only weak safety (plan §14): rare, manual-preferred,
 * never automatic. This module owns the frozen-budget accounting that decides
 * when a rebase is RECOMMENDED and what the rebase must reclaim.
 *
 * @module dsh-epistemic-fold/root-policy
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { frozenCheckpointLoad } from './leaf-policy.ts'

/** Telemetry emitted when the frozen prefix grows past its budget. */
export interface RootRebaseAdvice {
  readonly recommended: boolean
  readonly frozenTokens: number
  readonly budget: number
  readonly frozenCount: number
}

/**
 * Evaluate the frozen-checkpoint token budget against the current surface.
 * @param session - session whose frozen checkpoints are priced.
 * @param measurement - token-meter measurement matching the current surface.
 * @param budget - configured `frozenCheckpointTokenBudget`.
 * @returns advice; `recommended` true only when frozen checkpoints exist AND
 * their combined heuristic cost exceeds the budget.
 */
export function evaluateRootRebase(
  session: Session,
  measurement: TokenMeasurement,
  budget: number,
): RootRebaseAdvice {
  const load = frozenCheckpointLoad(session, measurement)
  return {
    recommended: budget > 0 && load.count > 0 && load.tokens > budget,
    frozenTokens: load.tokens,
    budget,
    frozenCount: load.count,
  }
}
