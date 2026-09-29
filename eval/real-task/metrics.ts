/**
 * RC2 §2: the three metrics a real-task comparison records.
 *
 *   Cost             what the task actually cost, from the provider's own bill
 *   TaskQuality      did the work get done, judged from the ARTIFACT
 *   EpistemicSteady  did the session keep its grip on what it had established
 *
 * ## Why these three, and why they are separate
 *
 * Cost alone cannot compare modes: the cheapest mode that fails the task is not
 * cheaper, it is useless. Quality alone cannot either: every mode here can
 * finish an easy task, and the differences appear in what a long session
 * FORGETS. So steadiness is measured in its own right, because it is the only
 * one of the three that the `balanced` and `quality` tiers claim to improve —
 * and a claim that is not measured separately can never be confirmed or refuted.
 *
 * ## EpistemicSteady is a set of CHECKABLE PROBES
 *
 * It is deliberately not a rating. Each probe is a property of the final state
 * that is either true or false, checked against the real workspace and the real
 * answer:
 *
 *   constraint-retained    a constraint declared at the start is still respected
 *   revision-honoured      a spec revised mid-task is used in its CURRENT form
 *   no-resurrection        a superseded value did not come back as current
 *   interface-honoured     an interface declared early still matches its use
 *
 * The score is the fraction satisfied. A probe that cannot be evaluated (the
 * artifact is missing) counts as FAILED, not as absent — because an agent that
 * produced nothing has not demonstrated steadiness, and scoring it as "not
 * applicable" would let a total failure read as a clean sheet.
 *
 * @module eval/real-task/metrics
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One checkable property of a finished task. */
export interface SteadinessProbe {
  readonly id: string
  /** What the probe establishes, in the user's terms. */
  readonly question: string
  /**
   * Evaluate the probe against the finished state.
   * @returns whether the property holds.
   */
  readonly holds: (state: FinishedState) => Promise<boolean> | boolean
}

/** Everything a probe may inspect after a task has run. */
export interface FinishedState {
  /** The final assistant text. */
  readonly answer: string
  /** Read one workspace file, or `undefined` when it is absent. */
  readonly read: (path: string) => Promise<string | undefined>
  /** Every workspace file path, relative and slash-separated. */
  readonly files: readonly string[]
}

/** The outcome of one probe. */
export interface ProbeResult {
  readonly id: string
  readonly question: string
  readonly held: boolean
}

/** One arm's steadiness result. */
export interface SteadinessResult {
  readonly probes: readonly ProbeResult[]
  /** Fraction of probes satisfied; 0 when there are none. */
  readonly score: number
  readonly satisfied: number
  readonly total: number
}

/**
 * Evaluate a probe set against a finished task.
 *
 * @returns per-probe results and the fraction satisfied.
 */
export async function measureSteadiness(
  state: FinishedState,
  probes: readonly SteadinessProbe[],
): Promise<SteadinessResult> {
  const results: ProbeResult[] = []
  for (const probe of probes) {
    let held = false
    try {
      held = await probe.holds(state)
    } catch {
      // A probe that throws could not be established. That is a FAILURE, not an
      // absence: silently dropping it would let a broken artifact score well.
      held = false
    }
    results.push({ id: probe.id, question: probe.question, held })
  }
  const satisfied = results.filter(result => result.held).length
  return {
    probes: results,
    score: results.length === 0 ? 0 : satisfied / results.length,
    satisfied,
    total: results.length,
  }
}

/** One arm's realized cost, from the provider bill. */
export interface CostResult {
  /** Total realized cost across every call the arm made. */
  readonly total: number
  readonly calls: number
  /** Calls that returned nothing — reported, never hidden. */
  readonly failedCalls: number
  /** Prompt tokens the provider charged at the miss price. */
  readonly uncachedInputTokens: number
  /** Prompt tokens the provider charged at the hit price. */
  readonly cacheReadTokens: number
  readonly outputTokens: number
}

/** How the task ended. */
export type TaskOutcomeKind =
  /** The model stopped calling tools and produced an answer. */
  | 'answered'
  /** The loop hit its round cap while still working. */
  | 'truncated'
  /** Every provider call failed; nothing was measured. */
  | 'transport-failed'

/** One arm's full result for one task. */
export interface TaskRun {
  readonly arm: string
  readonly taskId: string
  readonly outcome: TaskOutcomeKind
  readonly rounds: number
  readonly cost: CostResult
  readonly quality: QualityResult
  readonly steadiness: SteadinessResult
  /** Tool calls by name, so the timeline can be read without the raw log. */
  readonly toolCalls: Readonly<Record<string, number>>
  /** The order tools were called in, for the timeline. */
  readonly timeline: readonly string[]
  /** The final answer, bounded for a report. */
  readonly answer: string
}

/** TaskQuality: was the work done? */
export interface QualityResult {
  /** Checks that passed, out of all checks. */
  readonly passed: number
  readonly total: number
  readonly score: number
  readonly checks: readonly { readonly id: string; readonly passed: boolean; readonly detail?: string }[]
}

/**
 * Build a `FinishedState` from a real workspace directory.
 *
 * The file list and reads are the REAL filesystem, so a quality check that looks
 * for a written artifact cannot be satisfied by the model saying it wrote one.
 */
export async function finishedState(
  root: string,
  answer: string,
  listFiles: (root: string) => Promise<readonly string[]>,
): Promise<FinishedState> {
  const files = await listFiles(root)
  return {
    answer,
    files,
    read: async (path: string) => {
      try {
        return await readFile(join(root, path), 'utf8')
      } catch {
        return undefined
      }
    },
  }
}

/** Render one task run as a timeline block, for a human reading the result. */
export function taskRunToText(run: TaskRun): string {
  const lines = [
    `${run.arm} / ${run.taskId}: ${run.outcome}`,
    `  rounds=${run.rounds} calls=${run.cost.calls} failed=${run.cost.failedCalls} `
    + `cost=${run.cost.total.toFixed(6)}`,
    `  quality=${run.quality.passed}/${run.quality.total} `
    + `steadiness=${run.steadiness.satisfied}/${run.steadiness.total}`,
  ]
  if (run.timeline.length > 0) {
    lines.push(`  timeline: ${run.timeline.join(' -> ')}`)
  }
  for (const probe of run.steadiness.probes) {
    lines.push(`    ${probe.held ? 'OK  ' : 'LOST'} ${probe.id}`)
  }
  return lines.join('\n')
}

/**
 * Whether `text` presents `value` as CURRENT for `subject`.
 *
 * The resurrection check cannot be a substring test: a correct answer very often
 * NAMES the superseded value — "25, superseding the earlier 10" — and flagging
 * that would score a correct answer wrong. So the text is split into clauses and
 * a clause counts only when it mentions the value AND the subject AND carries no
 * marker that marks the value obsolete.
 *
 * This is the same reasoning RC1.3's `assertsSupersession` used for its answer
 * scoring, applied here to the artifact's prose.
 *
 * @param text - the text to read.
 * @param value - the superseded value, as a pattern.
 * @param subject - what the value is a value OF.
 * @returns whether any clause asserts the value as current.
 */
export function assertsValueAsCurrent(
  text: string,
  value: RegExp,
  subject: RegExp,
): boolean {
  const clauses = text
    .split(/[.;,\n]/u)
    .map(clause => clause.trim())
    .filter(clause => clause.length > 0)
  // Markers that make a mention HISTORICAL rather than current.
  const obsolete = /supersed|earlier|original|previous|old\b|was\b|were\b|no longer|now\b|revis|correct|instead|not\b|obsolete|replaced/iu
  return clauses.some(clause =>
    value.test(clause) && subject.test(clause) && !obsolete.test(clause))
}
