/**
 * The direct-recall SIZE GATE (docs/67): whether a recall may return its content,
 * and the refusal payload when it may not.
 *
 * Moved out of `tools.ts`, where the decision sat apart from its verdict function
 * and its refusal payload — policy that could not be exercised without registering
 * tools. `gateRecallPayload` now owns the decision AND the payload; the caller
 * supplies only the descriptor lookup.
 *
 * @module dsh-epistemic-fold/gate
 */

import type { CheckpointDescriptor } from "./descriptors.ts"
import { subagentRecallStats } from "./recall-telemetry.ts"

// ---------------------------------------------------------------- the gate

/**
 * Characters per token used to price a refusal.
 *
 * Deliberately a constant rather than a tokenizer: the gate runs inside a tool call,
 * before any model call, and an estimate that is off by a few percent cannot change the
 * decision it informs. It is LABELLED as an estimate in the payload so a reader never
 * mistakes it for a measurement.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 4

/**
 * The rendered size of a value, which for a recall result is what the caller would
 * receive.
 *
 * The ONE JSON-size definition: the gate prices a refusal with it, and the tool's
 * fetch/search accounting measures the material it hands the subagent with it.
 */
export function jsonChars(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

export interface RecallBudgetVerdict {
  readonly allowed: boolean
  readonly projectedChars: number
  readonly thresholdChars: number
  readonly estimatedTokens: number
  /** How far over the threshold, in characters; 0 when allowed. */
  readonly overBy: number
}

/**
 * Whether a direct recall may return its content, or must be redirected.
 *
 * A pure function so the policy can be pinned without a store, a session or a model: the
 * decision is one comparison, and the failure mode this feature exists for (a caller
 * pulling a large checkpoint into a small surface) is exactly a size question.
 */
export function recallBudgetVerdict(
  projectedChars: number,
  thresholdChars: number,
): RecallBudgetVerdict {
  const over = projectedChars - thresholdChars
  return {
    allowed: over <= 0,
    projectedChars,
    thresholdChars,
    estimatedTokens: Math.ceil(projectedChars / CHARS_PER_TOKEN_ESTIMATE),
    overBy: Math.max(0, over),
  }
}

/** EXPERIMENTAL wiring for subagent recall; present only when the flag is on. */
export interface SubagentRecallWiring {
  /** Rendered characters a direct recall may return before it is refused. */
  readonly thresholdChars: number
  /** Characters of archive one subagent run may read. */
  readonly fetchBudgetChars: number
}

/**
 * The refusal payload for a recall that would exceed the direct limit, or `null`
 * when the recall may return its content.
 *
 * ONE function owns the decision and the payload it produces, so the shape the
 * caller sees cannot drift from the verdict that produced it. The caller supplies
 * only the descriptor lookup, and a recall that is ALLOWED never calls it.
 *
 * The payload's key order is load-bearing: it is exactly what the tool returns,
 * and the tool's result is pinned byte-for-byte by the suite.
 */
export async function gateRecallPayload(
  payload: unknown,
  ref: string,
  wiring: SubagentRecallWiring,
  describe: () => Promise<CheckpointDescriptor | undefined>,
): Promise<unknown | null> {
  const verdict = recallBudgetVerdict(jsonChars(payload), wiring.thresholdChars)
  if (verdict.allowed) return null
  subagentRecallStats.gated += 1
  return {
    checkpointId: ref,
    overBudget: true,
    projectedChars: verdict.projectedChars,
    estimatedTokens: verdict.estimatedTokens,
    thresholdChars: verdict.thresholdChars,
    overBy: verdict.overBy,
    descriptor: await describe(),
    suggestion:
      'This recall would return about ' + verdict.estimatedTokens + ' tokens (an estimate at 4 '
      + 'characters per token), over the ' + wiring.thresholdChars + '-character direct limit. '
      + 'Call context_recall_subagent with the goal you are trying to answer (and this ref '
      + 'as scope if you know it): a retrieval subagent reads the archive and returns only '
      + 'what answers the goal, plus what else it saw that you may want next.',
    alternatives: [
      'context_recall with a smaller limit returns one page',
      'context_recall_subagent with no goal returns a survey of what the archive holds',
    ],
  }
}
