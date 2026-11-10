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
 * The surface position of the ACTIVE user request: the last user-role message
 * whose producer is the real user.
 *
 * A checkpoint is also delivered in the user role (`compact-checkpoint`), so
 * checking the role alone would pin the checkpoint instead of the request.
 * Returns `undefined` when the surface carries no real user message.
 *
 * @param session - the session whose surface is inspected.
 * @returns the position, or `undefined`.
 */
export function activeRequestPosition(session: Session): number | undefined {
  const nodes = session.surface.nodes
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = session.eventAt(nodes[index]!)
    const message = event === undefined ? undefined : session.deriveEventMessage(event)
    if (message?.role === 'user' && message.source.kind === 'user') return index
  }
  return undefined
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
 * @param protectedPositions - surface positions a fold must never include. The
 * span starts AFTER the last protected position at or past the frontier, so the
 * active task root and the active request stay on the surface verbatim. The
 * default is empty, so every pre-existing caller gets its old behaviour.
 * @returns the span to fold, or `null` when nothing beyond the frontier is safely foldable.
 */
export function selectLeafSpan(
  session: Session,
  measurement: TokenMeasurement,
  retainTokens: number,
  frontierIdx?: number,
  protectedPositions: readonly number[] = [],
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
  let firstIdx = Math.max(frontier + 1, systemHeadAtZero ? 1 : 0)
  // A protected position is never inside a leaf span. Moving the START past it
  // keeps the original event resident: nothing is copied, restated or
  // synthesised. The cost is that open messages before the protected position
  // also stay raw; that is why pinning the active request is opt-in.
  for (const position of [...protectedPositions].sort((left, right) => left - right)) {
    if (position >= firstIdx) firstIdx = position + 1
  }
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
