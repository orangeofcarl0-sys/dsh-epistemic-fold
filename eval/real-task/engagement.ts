/**
 * RC7-E: engagement classification and the split metric set.
 *
 * ## The defect this fixes
 *
 * The first parallel runs produced a BIMODAL quality distribution:
 *
 *   basic     [0.00, 1.00, 1.00, 1.00, 1.00]
 *   economy   [0.00, 1.00, 1.00, 1.00, 1.00]
 *
 * A mean of 0.80 over that describes no run that actually happened. What
 * happened is "four complete successes and one run that barely executed the
 * task", and those are different facts about different things.
 *
 * The cause was visible in the timelines. The failing cells stopped after two
 * tool calls:
 *
 *   rounds=4  calls=4  timeline: list_files -> context_search
 *   LOST constraint-retained, revision-honoured, no-resurrection, interface-honoured
 *
 * The model declared itself done having written none of the files the task
 * requires. Scoring that as "quality 0.00" conflates two unrelated events:
 *
 *   1. **The session did the work and lost its facts** — what EF exists to
 *      prevent, and what the steadiness probes measure.
 *   2. **The session declined to do the work** — a model-behaviour event that no
 *      context runtime can be credited or blamed for.
 *
 * ## Why the disengaged runs must NOT simply be dropped
 *
 * It is tempting to filter them out and report the survivors. That would be
 * wrong, and for a specific reason: **the mode changes what the model sees, so it
 * can plausibly change whether the model keeps working.** A tier whose checkpoints
 * read differently might nudge a session toward stopping early. Dropping those
 * runs would hide exactly the effect a mode could have.
 *
 * So both layers are reported, unconditionally:
 *
 *   End-to-end reliability        — did the arm get the job done at all
 *   Epistemic quality | engaged   — given it did the work, did it keep its facts
 *
 * Neither is a subset of the other, and neither alone answers "is this mode good".
 *
 * ## The contract is task-defined, never a tool-call count
 *
 * A gate like "at least N tool calls" is wrong: a better model may finish in
 * fewer. The contract is what each task's own WORK steps require, expressed as
 * milestones already observable in the run:
 *
 *   - **required artifacts exist** — the files the task asked to be written;
 *   - **the declared interface exists** — the export / schema shape it named;
 *   - **the executable was actually invoked** — the task said "run it with
 *     run_node", so `run_node` appearing in the timeline is the milestone.
 *
 * All three are read from evidence the run already produces. No new
 * instrumentation, and no proxy for "the model tried hard".
 *
 * @module eval/real-task/engagement
 */

import type { TaskRun } from './metrics.ts'

/**
 * What one task requires for a run to count as ENGAGED.
 *
 * Every field names evidence the run already carries: check ids from the task's
 * own `quality` list, and a tool name from the timeline.
 */
export interface ExecutionContract {
  /**
   * Quality-check ids that must pass for the task to count as engaged.
   *
   * These are the task's ARTIFACT milestones — "src/paginate.js was written" —
   * not its constraint checks. A run that wrote the files but got a constraint
   * wrong has still done the work; that is what the steadiness layer is for.
   */
  readonly requiredArtifacts: readonly string[]
  /**
   * Quality-check ids that must pass for the declared INTERFACE to count.
   *
   * The task named a specific interface ("export `paginate` as a named export",
   * "the config parses as JSON"). Writing a file that does not expose it is not
   * completing the task.
   */
  readonly requiredInterface: readonly string[]
  /**
   * The tool whose appearance in the timeline proves the run executed its work.
   *
   * `undefined` when the task never asked for execution. Every task in this
   * suite does — each WORK step says "run it with run_node" — so this is stated
   * rather than assumed, and a future task that only writes files can opt out.
   */
  readonly executionTool?: string
}

/** The contract for each task id in this suite. */
export const EXECUTION_CONTRACTS: Readonly<Record<string, ExecutionContract>> = {
  'coding-paginate': {
    requiredArtifacts: ['module-exists', 'test-exists'],
    requiredInterface: ['named-export'],
    executionTool: 'run_node',
  },
  'research-retry-policy': {
    requiredArtifacts: ['config-exists', 'checker-exists'],
    requiredInterface: ['config-valid-json'],
    executionTool: 'run_node',
  },
  'tool-heavy-manifest': {
    requiredArtifacts: ['schema-exists', 'sample-exists', 'validator-exists'],
    requiredInterface: ['all-fields-present'],
    executionTool: 'run_node',
  },
}

/**
 * How a run ended, as a state machine rather than a boolean.
 *
 * `answered` used to mean both "did the task" and "stopped talking", which is
 * the conflation this module exists to remove.
 */
export type EngagementVerdict =
  /** Every provider call failed: nothing about the task was measured. */
  | 'transport-failed'
  /** The loop hit its round cap while still working. */
  | 'truncated'
  /** Answered AND satisfied its task's execution contract. */
  | 'completed'
  /**
   * Answered WITHOUT satisfying its contract — the early-stop case.
   *
   * The model stopped and reported done; the task's artifacts do not exist. This
   * is a model-behaviour event, reported as its own outcome rather than as a
   * partial quality score.
   */
  | 'answered-incomplete'

/** The evidence behind one verdict, so a reader can check the classification. */
export interface EngagementEvidence {
  readonly verdict: EngagementVerdict
  /** Artifact milestones that passed, out of those required. */
  readonly artifactsMet: number
  readonly artifactsRequired: number
  /** Interface milestones that passed, out of those required. */
  readonly interfaceMet: number
  readonly interfaceRequired: number
  /** Whether the execution tool appeared in the timeline. */
  readonly executed: boolean
  /** Required milestones that did NOT pass, for the report. */
  readonly missing: readonly string[]
}

/**
 * Classify one run against its task's execution contract.
 *
 * Pure: reads only the run and the contract table. The order of the checks is
 * deliberate — a transport failure is not a completion, and a truncated run that
 * happened to write its files is still truncated, because the round cap is the
 * reason it stopped.
 *
 * @param run - one arm's result for one task.
 * @returns the verdict plus the evidence it was derived from.
 */
export function classifyEngagement(run: TaskRun): EngagementEvidence {
  const contract = EXECUTION_CONTRACTS[run.taskId]
  if (contract === undefined) {
    throw new Error(
      `engagement: no execution contract for task "${run.taskId}". `
      + 'Add one rather than letting the run fall through to a default — an '
      + 'unclassified run would be scored as engaged without evidence.',
    )
  }

  const passed = new Set(run.quality.checks.filter(check => check.passed).map(check => check.id))
  const missing: string[] = []
  let artifactsMet = 0
  for (const id of contract.requiredArtifacts) {
    if (passed.has(id)) artifactsMet += 1
    else missing.push(id)
  }
  let interfaceMet = 0
  for (const id of contract.requiredInterface) {
    if (passed.has(id)) interfaceMet += 1
    else missing.push(id)
  }
  const executed = contract.executionTool === undefined
    || run.timeline.includes(contract.executionTool)
  if (!executed) missing.push(`ran:${String(contract.executionTool)}`)

  const satisfied = missing.length === 0
  const verdict: EngagementVerdict = run.outcome === 'transport-failed'
    ? 'transport-failed'
    : run.outcome === 'truncated'
      ? 'truncated'
      : satisfied ? 'completed' : 'answered-incomplete'

  return {
    verdict,
    artifactsMet,
    artifactsRequired: contract.requiredArtifacts.length,
    interfaceMet,
    interfaceRequired: contract.requiredInterface.length,
    executed,
    missing,
  }
}

/** One arm's split report. */
export interface ArmReport {
  readonly arm: string
  readonly mode: string
  /** Runs observed. Every count below is "out of n". */
  readonly n: number

  // ── Layer 1: end-to-end reliability ────────────────────────────────────────
  /** Runs that satisfied their execution contract. */
  readonly completed: number
  /** Answered without doing the work — the early-stop case. */
  readonly answeredIncomplete: number
  readonly truncated: number
  readonly transportFailed: number
  /** `completed / n`, the unconditional completion rate. */
  readonly completionRate: number

  // ── Layer 2: epistemic quality, CONDITIONAL on engagement ──────────────────
  /** Mean quality over COMPLETED runs only; `undefined` when none completed. */
  readonly qualityGivenCompleted: number | undefined
  /** Mean steadiness over COMPLETED runs only; `undefined` when none completed. */
  readonly steadyGivenCompleted: number | undefined

  // ── The unconditional bottom line ──────────────────────────────────────────
  /**
   * Runs that completed AND passed every quality check AND every steadiness
   * probe. This is the honest "did the arm do the whole job correctly" count,
   * and it is the numerator of cost-per-success.
   */
  readonly e2eSuccess: number
  /** `e2eSuccess / n`. */
  readonly e2eSuccessRate: number

  // ── Cost, priced per SUCCESSFUL task ───────────────────────────────────────
  /** Total realized cost across every run, including the failures. */
  readonly totalCost: number
  /**
   * `totalCost / e2eSuccess` — what one correctly completed task actually cost.
   *
   * `undefined` when nothing succeeded: an arm that never finishes has no
   * per-success cost, and reporting `Infinity` or the mean per-call cost would
   * both mislead. This is the figure that catches "10% cheaper per call but
   * stops early one time in ten".
   */
  readonly costPerSuccess: number | undefined
}

/** Mean over the values, or `undefined` for an empty set. */
function meanOrUndefined(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * Build the split report for one arm.
 *
 * @param arm - the arm label.
 * @param mode - the mode the arm ran.
 * @param runs - every run for this arm, INCLUDING the ones that did not engage.
 *   Passing only the survivors would be the exact error this module prevents.
 * @returns the two-layer report.
 */
export function reportArm(
  arm: string,
  mode: string,
  runs: readonly TaskRun[],
): ArmReport {
  const n = runs.length
  const verdicts = runs.map(classifyEngagement)
  const completedRuns = runs.filter((_, index) => verdicts[index]!.verdict === 'completed')
  const count = (v: EngagementVerdict): number => verdicts.filter(x => x.verdict === v).length

  // E2E success is the conjunction, evaluated per run rather than from the
  // pooled means: a run at quality 0.75 and steadiness 1.00 is not a success,
  // and no combination of means can express that.
  const e2eSuccess = runs.filter((run, index) =>
    verdicts[index]!.verdict === 'completed'
    && run.quality.passed === run.quality.total
    && run.steadiness.satisfied === run.steadiness.total).length

  const totalCost = runs.reduce((sum, run) => sum + run.cost.total, 0)

  return {
    arm,
    mode,
    n,
    completed: count('completed'),
    answeredIncomplete: count('answered-incomplete'),
    truncated: count('truncated'),
    transportFailed: count('transport-failed'),
    completionRate: n === 0 ? 0 : count('completed') / n,
    qualityGivenCompleted: meanOrUndefined(completedRuns.map(run => run.quality.score)),
    steadyGivenCompleted: meanOrUndefined(completedRuns.map(run => run.steadiness.score)),
    e2eSuccess,
    e2eSuccessRate: n === 0 ? 0 : e2eSuccess / n,
    totalCost,
    costPerSuccess: e2eSuccess === 0 ? undefined : totalCost / e2eSuccess,
  }
}

/** Format an optional number, so `undefined` reads as "not measurable". */
function fmt(value: number | undefined, digits = 2): string {
  return value === undefined ? 'n/a' : value.toFixed(digits)
}

/**
 * Render the split report as a table.
 *
 * Counts are printed as `k/n` rather than as a percentage, because at these
 * sample sizes a percentage invites a rate estimate the data cannot support.
 * "1/5" says what was observed; "20%" claims a property of the population.
 */
export function armReportsToText(reports: readonly ArmReport[]): string {
  const lines: string[] = []
  lines.push('arm       mode      n   completed   early-stop  truncated  transport   quality|comp  steady|comp  e2e        cost/success')
  for (const r of reports) {
    lines.push(
      r.arm.padEnd(10) + r.mode.padEnd(10) + String(r.n).padEnd(4)
      + `${r.completed}/${r.n}`.padEnd(12)
      + `${r.answeredIncomplete}/${r.n}`.padEnd(12)
      + `${r.truncated}/${r.n}`.padEnd(11)
      + `${r.transportFailed}/${r.n}`.padEnd(12)
      + fmt(r.qualityGivenCompleted).padEnd(14)
      + fmt(r.steadyGivenCompleted).padEnd(13)
      + `${r.e2eSuccess}/${r.n}`.padEnd(11)
      + (r.costPerSuccess === undefined ? 'n/a (no success)' : r.costPerSuccess.toFixed(6)),
    )
  }
  return lines.join('\n')
}

/**
 * One line stating what the sample can and cannot support.
 *
 * Written because the first runs' tables were read as rate estimates, and the
 * whole point of this module is that they are not.
 *
 * @param reports - the arm reports.
 * @param taskCount - how many distinct tasks the sample covered.
 * @returns the caveat text, or a note that the sample is too small to read.
 */
export function sampleCaveat(reports: readonly ArmReport[], taskCount: number): string {
  const n = Math.max(0, ...reports.map(r => r.n))
  const lines: string[] = []
  lines.push(`Sample: n=${n} per arm across ${taskCount} task(s).`)
  lines.push('  Counts are observations, not rate estimates: "1/5" means one early-stop was')
  lines.push('  seen in five runs, not that the failure rate is 20%.')
  if (n < 10) {
    lines.push(`  At n=${n} an arm at 5/5 cannot be distinguished from one that fails 10% of the time.`)
  }
  const anyEarlyStop = reports.some(r => r.answeredIncomplete > 0)
  if (anyEarlyStop) {
    lines.push('  An early-stop is attributed to NOTHING here: this sample cannot separate a mode')
    lines.push('  effect from provider/model variance, or from their interaction.')
  }
  const allClean = reports.every(r => r.answeredIncomplete === 0 && r.truncated === 0)
  if (allClean) {
    lines.push('  No early-stop was OBSERVED in this batch. That is not a claim of stability.')
  }
  return lines.join('\n')
}
