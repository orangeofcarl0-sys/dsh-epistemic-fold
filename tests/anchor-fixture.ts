/**
 * Shared fixture for the live suites that DECLARE anchors before folding.
 *
 * Five suites (R1, R2, R3-F, R4-E, RC1.1) opened `declareAnchors` with the same
 * eight-line scan: collect the user-message seqs and the last tool-result seq,
 * because those are the only raw events the authority gate will accept as
 * provenance. Only that scan is shared — the declarations themselves differ per
 * suite and stay in their own files, since what each suite declares is what it
 * is measuring.
 *
 * @module tests/anchor-fixture
 */

import type { Session as SessionType } from '@deepseek-ai/dsh-session'

/**
 * The surface seqs an anchor may cite: every user message, and the last tool
 * result (the only empirical root a failure anchor can name).
 *
 * @param session - the session whose events are scanned.
 * @returns the citable seqs, in event order.
 */
export function anchorSourceSeqs(session: SessionType): {
  readonly userSeqs: readonly number[]
  readonly toolResultSeq: number | undefined
} {
  const userSeqs: number[] = []
  let toolResultSeq: number | undefined
  for (let seq = 0; seq < session.seq; seq += 1) {
    const type = session.eventAt(seq as never)?.type
    if (type === 'user/message') userSeqs.push(seq)
    if (type === 'tool/result') toolResultSeq = seq
  }
  return { userSeqs, toolResultSeq }
}
