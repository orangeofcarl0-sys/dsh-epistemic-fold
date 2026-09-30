/**
 * RC7-D: the parallel long-task runner.
 *
 * ## Why this exists
 *
 * The existing real-task driver runs its cells SEQUENTIALLY, and a single
 * coding task takes ~50s of wall clock. That makes the sample size a function of
 * patience rather than of the question: RC2 could afford one replicate, which is
 * why its conclusion had to be hedged as "read as a timeline, not statistics".
 *
 * Measured against the `space-bunny-free` route, concurrency is not the
 * constraint: 50 simultaneous requests all returned HTTP 200 in 3.8s. So the
 * runs can be dispatched together and the sample can be sized by the question.
 *
 * ## What it does NOT change
 *
 * Each cell is an INDEPENDENT `runTaskArm` call with its own workspace, session,
 * engine and recorder — the same function the sequential driver calls. This
 * module adds scheduling, not semantics. A parallel run and a sequential run of
 * the same cells produce the same per-cell results; the difference is wall clock.
 *
 * ## Honesty rules carried over
 *
 * - **Bounded concurrency, not unbounded.** A provider is not a compute cluster;
 *   the default cap is deliberately modest so a run cannot turn a provider-side
 *   rate limit into a wall of indistinguishable failures.
 * - **A failed cell is REPORTED, never silently dropped.** A run that loses
 *   cells to errors and reports only the survivors would overstate quality.
 * - **Every cell records its own cost and usage**, so pooling is arithmetic on
 *   measured numbers rather than on estimates.
 *
 * @module eval/real-task/parallel
 */

import { runTaskArm } from './driver.ts'
import { taskRunToText } from './metrics.ts'
import type { ArmRunResult, ArmSpec, LifecycleScenario } from './driver.ts'
import type { RealTask } from './tasks.ts'
import type { ContextEconomicsProfile } from '../../src/economics-profile.ts'
import { newWorkspace } from './driver.ts'
import { releaseTemp } from '../tmp.ts'

/** One unit of work: a (task, arm, scenario, replicate) cell. */
export interface CellSpec {
  readonly task: RealTask
  readonly arm: ArmSpec
  readonly scenario: LifecycleScenario
  readonly replicate: number
}

/** A completed cell, or the error that stopped it. */
export type CellOutcome =
  | { readonly kind: 'ok'; readonly spec: CellSpec; readonly run: ArmRunResult; readonly ms: number }
  | { readonly kind: 'failed'; readonly spec: CellSpec; readonly error: string; readonly ms: number }

/** Scheduling options. */
export interface ParallelOptions {
  /** Maximum cells in flight at once. */
  readonly concurrency?: number
  /** Sink for progress lines; defaults to stdout. */
  readonly log?: (line: string) => void
  /**
   * What this run is allowed to conclude.
   *
   * Defaults to `'quality'`, and that default is load-bearing. A concurrent run
   * is safe for quality and steadiness — each cell owns its workspace, session
   * and engine — but it is NOT safe for cost:
   *
   * **A provider's prefix cache is shared across requests, and these cells run
   * similar prompts at the same time.** One arm's request can warm the prefix
   * that another arm's request then reads at the hit price. The measured cost of
   * an arm would then depend on which OTHER arms happened to be in flight beside
   * it. This project has already been burned once by cross-run cache
   * contamination, and the cost gate is currently OPEN partly because of it.
   *
   * So a run declares its purpose. `'quality'` means the cost figures are printed
   * for completeness and are explicitly NOT a conclusion. `'cost'` requires the
   * caller to have isolated the cache — which this module cannot verify, so it
   * refuses to grant the label to a run with more than one cell in flight.
   */
  readonly purpose?: RunPurpose
}

/** What a run is allowed to conclude. */
export type RunPurpose = 'quality' | 'cost'

/**
 * Refuse a cost claim from a concurrent run.
 *
 * Stated as a thrown error rather than a warning because the failure it prevents
 * is invisible: a contaminated cost number looks exactly like a clean one, and
 * the project's cost gate has already been reopened once by exactly this class
 * of mistake.
 *
 * @param purpose - what the run claims to measure.
 * @param concurrency - how many cells will be in flight.
 * @throws when a cost run would run more than one cell at a time.
 */
export function assertPurposeAllowed(purpose: RunPurpose, concurrency: number): void {
  if (purpose === 'cost' && concurrency > 1) {
    throw new Error(
      `parallel: a run claiming purpose 'cost' may not use concurrency ${concurrency}. `
      + 'Concurrent cells share the provider prefix cache, so one arm can warm another\'s '
      + 'prefix and no per-arm cost is isolated. Either use concurrency 1, or run with '
      + "purpose 'quality' and treat the cost column as non-conclusive.",
    )
  }
}

/**
 * Run every cell with a bounded number in flight.
 *
 * Cells are dispatched in the given order and results are returned in that same
 * order, so a caller can index them positionally regardless of completion order.
 * A cell that throws does not stop the run: it becomes a `failed` outcome.
 *
 * @param cells - the cells to run.
 * @param profile - the economics profile every arm prices against.
 * @param options - concurrency cap and log sink.
 * @returns one outcome per cell, in input order.
 */
export async function runCellsParallel(
  cells: readonly CellSpec[],
  profile: ContextEconomicsProfile,
  options: ParallelOptions = {},
): Promise<readonly CellOutcome[]> {
  const limit = Math.max(1, options.concurrency ?? 4)
  const log = options.log ?? ((line: string) => console.log(line))
  const purpose: RunPurpose = options.purpose ?? 'quality'
  // Refuse a cost claim the schedule cannot support, BEFORE any provider call.
  assertPurposeAllowed(purpose, limit)
  if (purpose === 'quality' && limit > 1) {
    log('parallel: purpose=quality — cost columns below are NOT a conclusion '
      + '(concurrent cells share the provider prefix cache)')
  }
  const outcomes: CellOutcome[] = new Array(cells.length)
  let next = 0
  let done = 0

  /** One worker: pull the next index until the queue is empty. */
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= cells.length) return
      const spec = cells[index]!
      const label = `${spec.task.id}/${spec.arm.label}/${spec.scenario}/r${spec.replicate}`
      const started = Date.now()
      let workspaceRoot: string | undefined
      try {
        // Each cell owns its workspace, so parallel cells cannot collide.
        workspaceRoot = await newWorkspace()
        const run = await runTaskArm({ ...spec, profile, workspaceRoot })
        outcomes[index] = { kind: 'ok', spec, run, ms: Date.now() - started }
        log(`  ok   ${label} (${((Date.now() - started) / 1000).toFixed(0)}s) `
          + `quality=${run.quality.score.toFixed(2)} steady=${run.steadiness.score.toFixed(2)} `
          + `cost=${run.cost.total.toFixed(6)}`)
        // The per-check detail, so a low score can be DIAGNOSED from the run
        // output rather than requiring a re-run under a debugger.
        for (const line of taskRunToText(run).split(String.fromCharCode(10))) {
          log(`       ${line}`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        outcomes[index] = { kind: 'failed', spec, error: message, ms: Date.now() - started }
        log(`  FAIL ${label}: ${message.slice(0, 160)}`)
      } finally {
        // The run has already read everything it needs off disk — `run` carries
        // the file-derived results — so the workspace is dead weight from here.
        // Releasing it per cell is what keeps a 25-cell batch from leaving 25
        // directories behind, which is how this suite previously leaked 44,035.
        if (workspaceRoot !== undefined) await releaseTemp(workspaceRoot)
      }
      done += 1
      if (done % 10 === 0) log(`  ... ${done}/${cells.length} cells complete`)
    }
  }

  log(`parallel: ${cells.length} cells, concurrency ${limit}`)
  await Promise.all(Array.from({ length: Math.min(limit, cells.length) }, () => worker()))
  return outcomes
}

/**
 * Pooling lives in `./engagement.ts`, and deliberately NOT here.
 *
 * The first version of this file pooled each arm into a single mean quality and
 * steadiness. That is what produced the misleading `0.80` for a BIMODAL arm
 * (`[0.00, 1.00, 1.00, 1.00, 1.00]`): a mean over that distribution describes no
 * run that happened. The split report replaces it — completion counts first,
 * then quality and steadiness CONDITIONAL on having engaged, then cost per
 * SUCCESSFUL task.
 *
 * A second pooling implementation here would be a duplicate source of truth for
 * exactly the number this project just had to correct, so this module now does
 * scheduling only and re-exports the one report that exists.
 */
export { reportArm, armReportsToText, sampleCaveat, classifyEngagement } from './engagement.ts'
export type { ArmReport, EngagementEvidence, EngagementVerdict } from './engagement.ts'
