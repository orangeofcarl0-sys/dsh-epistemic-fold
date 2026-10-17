/**
 * Module-level counters for the subagent-recall experiment (docs/67).
 *
 * Split out of `subagent-recall.ts` so the gate, the loop and the transport can
 * all read the SAME counters without importing each other. The barrel
 * `subagent-recall.ts` re-exports them, so the feature's public face is unchanged.
 *
 * @module dsh-epistemic-fold/recall-telemetry
 */

// ---------------------------------------------------------------- telemetry

/**
 * What this experiment did, in the shape `summaryRetryStats` established: a module-level
 * counter the host publishes rather than a value a caller has to remember.
 *
 * `gated` is the one that matters most: it counts direct recalls that were REFUSED for
 * size. A run where that stays 0 has not exercised the feature, whatever else it shows.
 */
export interface SubagentRecallStats {
  /** Direct recalls refused because they would have exceeded the threshold. */
  gated: number
  /** Subagent runs, split by whether a goal was given. */
  invocations: number
  surveyInvocations: number
  /** Model calls: one to plan the fetches, one to answer. */
  planCalls: number
  answerCalls: number
  /** Fetches the subagent executed, and the characters they cost it. */
  fetches: number
  fetchedChars: number
  /** Characters returned to the caller, which is the number the budget bounds. */
  answerChars: number
  /** Runs that ended without an answer: reported, never silently empty. */
  failures: number
  lastError: string | null
}

export const subagentRecallStats: SubagentRecallStats = {
  gated: 0,
  invocations: 0,
  surveyInvocations: 0,
  planCalls: 0,
  answerCalls: 0,
  fetches: 0,
  fetchedChars: 0,
  answerChars: 0,
  failures: 0,
  lastError: null,
}

/** Zero the counters. Called per episode by a host that reports per-episode telemetry. */
export function resetSubagentRecallStats(): void {
  subagentRecallStats.gated = 0
  subagentRecallStats.invocations = 0
  subagentRecallStats.surveyInvocations = 0
  subagentRecallStats.planCalls = 0
  subagentRecallStats.answerCalls = 0
  subagentRecallStats.fetches = 0
  subagentRecallStats.fetchedChars = 0
  subagentRecallStats.answerChars = 0
  subagentRecallStats.failures = 0
  subagentRecallStats.lastError = null
}
