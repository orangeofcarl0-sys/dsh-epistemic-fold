/**
 * Leaf-fold span selection: from the fold frontier forward, choose the
 * largest balanced closed span that preserves the verbatim recent tail.
 * Unlike Basic's selector, the span NEVER begins before the frontier —
 * frozen checkpoints are never re-folded (plan §13).
 *
 * @module dsh-epistemic-fold/leaf-policy
 */

import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { locateFoldFrontier } from './frontier.ts'

/** One inclusive surface-position span a leaf fold may replace. */
export interface LeafSpan {
  readonly start: SessionSeq
  readonly end: SessionSeq
  readonly startIdx: number
  readonly endIdx: number
}

/**
 * Select `[frontier + 1, bestSafeEnd]` on the current surface. The recent
 * tail retains at least `retainTokens` verbatim (0 during overflow), the end
 * boundary walks left until tool pairing stays balanced, and the span is
 * non-empty only when it reaches past the frontier.
 * @param session - session whose surface is measured.
 * @param measurement - token-meter measurement matching the current surface.
 * @param retainTokens - minimum recent-tail budget kept verbatim.
 * @param frontierIdx - frontier position from {@link locateFoldFrontier};
 * callers may pass `-1` to fall back to re-location (tests, direct calls).
 * @returns the span to fold, or `null` when nothing beyond the frontier is safely foldable.
 */
export function selectLeafSpan(
  session: Session,
  measurement: TokenMeasurement,
  retainTokens: number,
  frontierIdx?: number,
): LeafSpan | null {
  const pricedNodes = measurement.nodes
  const nodes = session.surface.nodes
  if (pricedNodes.length === 0) return null
  if (nodes.length !== pricedNodes.length
    || nodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
    throw new Error('epistemic-fold: token-meter surface does not match the current session surface')
  }

  const frontier = frontierIdx ?? locateFoldFrontier(session).firstOpenPosition - 1
  const systemHeadAtZero = nodes.length > 0
    && session.deriveEventMessage(session.eventAt(nodes[0]!)!)?.role === 'system'
  const firstIdx = Math.max(frontier + 1, systemHeadAtZero ? 1 : 0)
  if (firstIdx >= pricedNodes.length) return null

  // Retain the verbatim tail, then walk the boundary left to the nearest
  // balanced edge (mirrors Basic's retention walk, restricted past the frontier).
  let accumulated = 0
  let keepFromIdx = pricedNodes.length
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    accumulated += pricedNodes[index]!.tokens
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx <= firstIdx) return null
  while (keepFromIdx > firstIdx) {
    if (toolPairingBalancedBefore(session, nodes[keepFromIdx]!)) break
    keepFromIdx -= 1
  }
  if (keepFromIdx <= firstIdx) return null

  return {
    start: nodes[firstIdx]!,
    end: nodes[keepFromIdx - 1]!,
    startIdx: firstIdx,
    endIdx: keepFromIdx - 1,
  }
}

/**
 * Sum the heuristic token cost of every EF checkpoint currently on the
 * surface — the frozen prefix's recurring price — and report whether it
 * exceeds the configured budget, which recommends a root rebase (plan §15).
 */
export function frozenCheckpointLoad(
  session: Session,
  measurement: TokenMeasurement,
): { tokens: number; count: number; ids: string[] } {
  const frontier = locateFoldFrontier(session)
  let tokens = 0
  const ids: string[] = []
  for (const checkpoint of frontier.frozen) {
    const node = measurement.nodes[checkpoint.position]
    tokens += node?.tokens ?? 0
    ids.push(checkpoint.checkpointId)
  }
  return { tokens, count: frontier.frozenCount, ids }
}
