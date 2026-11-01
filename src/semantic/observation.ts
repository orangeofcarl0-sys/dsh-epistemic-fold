/**
 * Writer diagnostics: four independent facts, never one blended "health".
 *
 * A fold can fail to call the writer, call it and get no `<deltas>` block, call
 * it and get a malformed block, or call it and get a syntactically valid list
 * of deltas that is nonetheless incomplete. Those are different observations,
 * and R32's single `writerHealthValue = 'ready'` assignment after parsing
 * collapsed them: a response with no deltas at all was reported exactly like a
 * complete one.
 *
 * The axes here are deliberately orthogonal:
 *
 *   CALL       success | failed | not-attempted (withheld before the request)
 *   PROTOCOL   parsed | absent | malformed | not-called
 *   DELTAS     proposed / accepted / refused / limitExceeded counts
 *   INTEGRITY  ready | partial | unavailable | conflict
 *
 * `parsed` is **not** coverage. A model may return `{"deltas":[]}` — a valid
 * answer — and the runtime cannot tell "nothing was worth recording" from
 * "everything was omitted". `coverage` therefore has exactly one value here:
 * `not-assessed`. A future predictor may replace it; inventing a positive
 * value now would be a claim the runtime cannot support.
 *
 * @module dsh-epistemic-fold/semantic/observation
 */

import type { SemanticRefusal } from './types.ts'

/** Whether the writer request ran, and whether it produced a response. */
export type WriterCallOutcome = 'success' | 'failed' | 'not-attempted'

/** What the response contained, independent of whether it was useful. */
export type WriterProtocolOutcome = 'parsed' | 'absent' | 'malformed' | 'not-called'

/** The semantic layer's operational state, as distinct from fold success. */
export type SemanticRuntimeIntegrity = 'ready' | 'partial' | 'unavailable' | 'conflict'

/** Why proposals were refused, counted by machine-readable reason. */
export type RefusalCounts = Readonly<Partial<Record<SemanticRefusal['reason'], number>>>

/**
 * Everything one fold observed about the writer.
 *
 * `limitExceeded` is broken out because the validator's generic `refused` count
 * hides the one refusal that means "the model had more to say than this fold
 * accepted". It is a DELTA fact; it does not by itself make integrity partial.
 */
export interface WriterObservation {
  readonly call: WriterCallOutcome
  readonly protocol: WriterProtocolOutcome
  readonly proposed: number
  readonly accepted: number
  readonly refused: number
  readonly limitExceeded: number
  /** Every refusal reason that occurred, so a report need not re-read packets. */
  readonly refusals: RefusalCounts
  readonly integrity: SemanticRuntimeIntegrity
  /**
   * Always `not-assessed`: parsing a protocol cannot establish that the model
   * extracted every action-critical fact. Kept explicit so a report cannot
   * mistake `ready` for "coverage complete".
   */
  readonly coverage: 'not-assessed'
  readonly detail?: string
}

/** Inputs to {@link observeWriter}; every field but the call outcome is optional. */
export interface ObserveWriterInput {
  readonly call: WriterCallOutcome
  readonly protocol?: WriterProtocolOutcome
  readonly proposed?: number
  readonly accepted?: readonly unknown[]
  readonly refused?: readonly SemanticRefusal[]
  /** Set when the layer could not run at all (e.g. no projection mounted). */
  readonly unavailable?: boolean
  /** Set when an integrity conflict withheld the writer before the call. */
  readonly conflict?: boolean
  readonly detail?: string
}

function countRefusals(refused: readonly SemanticRefusal[]): {
  readonly counts: Record<string, number>
  readonly limitExceeded: number
} {
  const counts: Record<string, number> = {}
  let limitExceeded = 0
  for (const refusal of refused) {
    counts[refusal.reason] = (counts[refusal.reason] ?? 0) + 1
    if (refusal.reason === 'limit-exceeded') limitExceeded += 1
  }
  return { counts, limitExceeded }
}

/**
 * Build the observation for one fold.
 *
 * Integrity is derived by precedence, not by a single boolean:
 *
 *  - `conflict` wins: the store contradicts itself, so nothing was written.
 *  - `unavailable`: the deployment asked for state but cannot mount it.
 *  - `partial`: the call failed or the protocol did not parse; the checkpoint
 *    still committed, but no semantic information entered it.
 *  - `ready`: the protocol parsed. An empty or all-refused delta list is still
 *    `ready`: refusal is a validator verdict on individual proposals, not a
 *    failure of the writer path.
 *
 * @param input - what the fold observed.
 * @returns the orthogonal observation.
 */
export function observeWriter(input: ObserveWriterInput): WriterObservation {
  const refused = input.refused ?? []
  const { counts, limitExceeded } = countRefusals(refused)
  const protocol = input.protocol ?? (input.call === 'success' ? 'parsed' : 'not-called')
  const integrity: SemanticRuntimeIntegrity = input.conflict === true
    ? 'conflict'
    : input.unavailable === true
      ? 'unavailable'
      : input.call !== 'success' || protocol === 'absent' || protocol === 'malformed'
        ? 'partial'
        : 'ready'
  return {
    call: input.call,
    protocol,
    proposed: input.proposed ?? 0,
    accepted: input.accepted?.length ?? 0,
    refused: refused.length,
    limitExceeded,
    refusals: counts,
    integrity,
    coverage: 'not-assessed',
    ...(input.detail === undefined || input.detail.length === 0 ? {} : { detail: input.detail }),
  }
}

/**
 * The status-surface text for one observation.
 *
 * One line, no interpretation: counts and verdicts, with coverage named as
 * unassessed rather than omitted (an omitted field reads as "fine").
 */
export function describeWriterObservation(observation: WriterObservation): string {
  return `writer call=${observation.call} protocol=${observation.protocol} `
    + `proposed=${observation.proposed} accepted=${observation.accepted} `
    + `refused=${observation.refused} limitExceeded=${observation.limitExceeded} `
    + `integrity=${observation.integrity} coverage=${observation.coverage}`
}
