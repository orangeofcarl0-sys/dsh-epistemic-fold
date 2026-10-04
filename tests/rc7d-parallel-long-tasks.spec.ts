/**
 * RC7-D: the parallel long-task run (live, opt-in).
 *
 * ## What this adds over `rc2a-live-real-task`
 *
 * That suite runs its cells sequentially, one at a time. A single coding task
 * takes ~50s, so a run with N cells costs N×50s of wall clock and the sample size
 * becomes a function of patience. This suite dispatches the same cells
 * concurrently, so the sample can be sized by the QUESTION rather than by how
 * long anyone is willing to wait.
 *
 * The cells are the same `runTaskArm` calls with the same fixtures; only the
 * scheduling differs. Nothing about the measurement changes.
 *
 * ## Why concurrency is safe here
 *
 * Measured against the route this is built for: 50 simultaneous requests all
 * returned HTTP 200 in 3.8s, and a 90K-token prompt with a buried needle was
 * retrieved correctly. The provider is not the constraint, so the runner bounds
 * concurrency at a modest default rather than at 1.
 *
 * ## What a result at this size can and cannot support
 *
 * It CAN show, per mode, whether a task was answered, what it cost, and whether
 * the session still knew its facts — with enough replicates that a single flaky
 * cell does not decide the reading.
 *
 * It CANNOT show that a mode is better in general. RC2's conclusion stands: the
 * tiers' steadiness benefit remains a hypothesis, and a larger n makes the
 * hypothesis better supported without turning it into a law. The report says
 * which of the two it is reporting.
 *
 * @module tests/rc7d-parallel-long-tasks
 */

import { describe, expect, it } from 'vitest'
import { ARMS, flashProfile } from '../eval/real-task/driver.ts'
import { REAL_TASKS } from '../eval/real-task/tasks.ts'
import { runCellsParallel } from '../eval/real-task/parallel.ts'
import { armReportsToText, reportArm, sampleCaveat } from '../eval/real-task/engagement.ts'
import type { CellOutcome, CellSpec } from '../eval/real-task/parallel.ts'
import { LIVE_ENABLED } from './live-gate.ts'

/** Live runs are opt-in: they spend real provider quota. */

/** Replicates per (task, arm). The whole point of this suite is that this can be > 1. */
const REPLICATES = Number(process.env.EF_TASK_REPLICATES ?? 3)

/** Cells in flight at once. Bounded: a provider is not a compute cluster. */
const CONCURRENCY = Number(process.env.EF_TASK_CONCURRENCY ?? 6)

describe.skipIf(!LIVE_ENABLED)('RC7-D live: parallel long tasks across the modes', () => {
  it('runs every (task, arm) cell concurrently and pools the results', async () => {
    const profile = flashProfile()

    // The cell set: every task × every arm × N replicates, plain scenario.
    // `plain` only, because a restart's effect would otherwise be attributed to
    // the mode — the same rule RC2's sequential suite follows.
    //
    // `EF_TASK_TASKS` narrows the task set. It exists for a BOUNDED run: the
    // tool-heavy task alone can take 205s per cell, so a full sweep is a poor
    // way to answer a scheduling question or to smoke-test a route.
    const only = process.env.EF_TASK_TASKS
    const tasks = only === undefined || only.length === 0
      ? REAL_TASKS
      : REAL_TASKS.filter(task => only.split(',').includes(task.id))
    expect(tasks.length, `EF_TASK_TASKS matched no task: ${String(only)}`).toBeGreaterThan(0)

    const cells: CellSpec[] = []
    for (let replicate = 0; replicate < REPLICATES; replicate += 1) {
      for (const task of tasks) {
        for (const arm of ARMS) {
          cells.push({ task, arm, scenario: 'plain', replicate })
        }
      }
    }

    const started = Date.now()
    const outcomes = await runCellsParallel(cells, profile, { concurrency: CONCURRENCY })
    const wallMs = Date.now() - started

    // --- Vacuity guards. A run whose cells all failed measured nothing, and a
    // run where no cell used a tool did not exercise a context runtime.
    const ok = outcomes.filter(o => o.kind === 'ok')
    const failed = outcomes.filter(o => o.kind === 'failed')
    console.log('')
    console.log(`RC7-D RUN: ${cells.length} cells, ${ok.length} ok, ${failed.length} failed, `
      + `wall ${(wallMs / 1000).toFixed(0)}s at concurrency ${CONCURRENCY}`)
    // The saving is the point of the suite: report it, so a run that gained
    // nothing is visible rather than assumed.
    const sequentialEstimate = ok.reduce((sum, o) => sum + o.ms, 0)
    console.log(`  sequential estimate ${(sequentialEstimate / 1000).toFixed(0)}s `
      + `-> parallel ${(wallMs / 1000).toFixed(0)}s `
      + `(${(sequentialEstimate / Math.max(1, wallMs)).toFixed(1)}x)`)
    expect(ok.length, 'at least some cells must succeed for the run to mean anything').toBeGreaterThan(0)

    const toolUsing = ok.filter(o => Object.keys(o.run.toolCalls).length > 0)
    console.log(`RC7-D SANITY: ${toolUsing.length}/${ok.length} successful runs made a tool call`)
    expect(toolUsing.length, 'the tasks must actually use tools').toBeGreaterThan(0)

    // --- The comparison, in the TWO LAYERS the directive requires.
    //
    // The first version of this suite pooled each arm into one mean quality and
    // steadiness, which reported `0.80` for a bimodal arm
    // (`[0.00, 1.00, 1.00, 1.00, 1.00]`) — a number describing no run that
    // happened. The split report replaces it.
    //
    // The disengaged runs are NOT filtered out. The mode changes what the model
    // sees, so it can plausibly change whether the model keeps working; dropping
    // those runs would hide exactly the effect a mode could have.
    const reports = (subset: readonly CellOutcome[]) => {
      const labels: string[] = []
      for (const outcome of subset) {
        if (!labels.includes(outcome.spec.arm.label)) labels.push(outcome.spec.arm.label)
      }
      return labels.map(label => {
        const armOutcomes = subset.filter(o => o.spec.arm.label === label)
        const mode = armOutcomes[0]!.spec.arm.mode
        // EVERY run goes in, including the ones that did not engage.
        const runs = armOutcomes.filter((o): o is Extract<CellOutcome, { kind: 'ok' }> => o.kind === 'ok')
          .map(o => o.run)
        return reportArm(label, mode, runs)
      })
    }

    const all = reports(outcomes)
    console.log('')
    console.log('RC7-D BY MODE — two layers, never pooled:')
    console.log(armReportsToText(all))

    // --- Per task, so a mode that wins one task and loses another is visible.
    console.log('')
    console.log('RC7-D PER TASK:')
    for (const task of tasks) {
      console.log(`  ${task.id} (${task.kind}):`)
      console.log(armReportsToText(reports(outcomes.filter(o => o.spec.task.id === task.id))))
    }

    // --- What the sample can and cannot support. Printed unconditionally,
    // because the failure this whole change addresses was a REPORTING failure.
    console.log('')
    console.log('RC7-D READING:')
    console.log(sampleCaveat(all, tasks.length))

    // --- Cost is NOT a conclusion this runner may draw (see the guard below).
    console.log('')
    console.log('RC7-D COST CAVEAT:')
    console.log('  cost/success is printed for completeness only. These cells ran CONCURRENTLY,')
    console.log('  so a provider prefix cache shared across them can warm one arm from another')
    console.log('  and no per-arm cost here is isolated. Use a blocked, cache-isolated run for')
    console.log('  any cost conclusion; this suite is for quality and steadiness.')

    // A failed cell is reported, never hidden: it is counted in the report.
    if (failed.length > 0) {
      console.log('')
      console.log(`RC7-D FAILURES (${failed.length}):`)
      for (const f of failed.slice(0, 8)) {
        console.log(`  ${f.spec.task.id}/${f.spec.arm.label}/r${f.spec.replicate}: ${f.error.slice(0, 140)}`)
      }
    }

    expect(outcomes.length).toBe(cells.length)
  }, 3_600_000)
})
