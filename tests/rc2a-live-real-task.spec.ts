/**
 * RC2 §2: the real-task mode comparison (live).
 *
 * Runs real DSH tasks — coding, research, tool-heavy — across the four modes and
 * records the three metrics. This is NOT a statistical benchmark: RC2 asks for a
 * small real sample read as a timeline, and the directive is explicit that a
 * large-sample claim is not the goal. What it must do is be HONEST about what a
 * sample this size can and cannot support.
 *
 * ## What the run is for
 *
 * RC1.3 established that `economy` reaches parity with Basic on a retrieval
 * probe. That probe carried no real work. This run asks the question a user
 * actually has: on a task that writes files, runs code, and revises its own spec
 * halfway through, do the modes differ in what the session still knows?
 *
 * ## Lifecycle scenarios
 *
 * Every arm runs the plain scenario. The restart and model-switch scenarios are
 * run for `legacy` and `economy` only — the two the comparison turns on — because
 * they are stress cases rather than the baseline, and running all four modes
 * across all three scenarios would multiply the sample without adding a
 * question. The directive's list is covered; the cost is bounded.
 *
 * @module tests/rc2a-live-real-task
 */

import { describe, expect, it } from 'vitest'
import { ARMS, flashProfile, newWorkspace, runTaskArm } from '../eval/real-task/driver.ts'
import type { ArmRunResult, LifecycleScenario } from '../eval/real-task/driver.ts'
import { CODING_TASK, REAL_TASKS, RESEARCH_TASK, TOOL_HEAVY_TASK } from '../eval/real-task/tasks.ts'
import type { RealTask } from '../eval/real-task/tasks.ts'
import { taskRunToText } from '../eval/real-task/metrics.ts'
import { LIVE_ENABLED } from './live-gate.ts'


/** How many times to repeat each (task, arm) cell. Small by design. */
const REPLICATES = Number(process.env.EF_TASK_REPLICATES ?? 1)

/**
 * The lifecycle scenarios, and which arms run them.
 *
 * `plain` runs for every arm. The two stress scenarios run for the two modes the
 * comparison is actually between: Basic's own policy, and the tier the project
 * would recommend.
 */
const SCENARIOS: readonly { readonly scenario: LifecycleScenario; readonly arms: readonly string[] }[] = [
  { scenario: 'plain', arms: ARMS.map(arm => arm.label) },
  { scenario: 'restart', arms: ['legacy', 'economy'] },
  { scenario: 'model-switch', arms: ['legacy', 'economy'] },
]

/** One (task, arm, scenario) cell's result. */
interface Cell {
  readonly task: RealTask
  readonly scenario: LifecycleScenario
  readonly run: ArmRunResult
}

/** Mean over the non-empty values, or 0. */
function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

describe.skipIf(!LIVE_ENABLED)('RC2 live: real tasks across the four modes', () => {
  it('runs every task under every arm and reports Cost / TaskQuality / EpistemicSteady', async () => {
    const profile = flashProfile()
    const cells: Cell[] = []

    for (const replicate of [0, ...Array.from({ length: Math.max(0, REPLICATES - 1) }, (_, index) => index + 1)]) {
      for (const task of REAL_TASKS) {
        for (const { scenario, arms } of SCENARIOS) {
          for (const arm of ARMS) {
            if (!arms.includes(arm.label)) continue
            const workspaceRoot = await newWorkspace()
            const run = await runTaskArm({ task, arm, replicate, scenario, profile, workspaceRoot })
            cells.push({ task, scenario, run })
            console.log(taskRunToText(run))
          }
        }
      }
    }

    // --- Vacuity guards. A run that never called a tool, or never folded,
    // measured nothing about a context runtime.
    const toolUsing = cells.filter(cell => Object.keys(cell.run.toolCalls).length > 0)
    console.log(
      `RC2 SANITY: ${toolUsing.length}/${cells.length} runs made at least one tool call`,
    )
    expect(toolUsing.length, 'the tasks must actually use tools').toBeGreaterThan(0)

    // --- THE COMPARISON, per task, plain scenario only. Mixing scenarios into
    // the per-task means would attribute a restart's effect to the mode.
    console.log('')
    console.log('RC2 PER-TASK COMPARISON (plain scenario):')
    for (const task of REAL_TASKS) {
      const rows = cells.filter(cell => cell.task.id === task.id && cell.scenario === 'plain')
      console.log(`  ${task.id} (${task.kind}):`)
      for (const arm of ARMS) {
        const armCells = rows.filter(cell => cell.run.arm === arm.label)
        if (armCells.length === 0) continue
        const quality = mean(armCells.map(cell => cell.run.quality.score))
        const steady = mean(armCells.map(cell => cell.run.steadiness.score))
        const cost = mean(armCells.map(cell => cell.run.cost.total))
        const calls = mean(armCells.map(cell => cell.run.cost.calls))
        console.log(
          `    ${arm.label.padEnd(9)} n=${armCells.length} `
          + `cost=${cost.toFixed(6)} calls=${calls.toFixed(1)} `
          + `quality=${quality.toFixed(2)} steady=${steady.toFixed(2)}`,
        )
      }
    }

    // --- The headline: cost and steadiness per mode across every task.
    console.log('')
    console.log('RC2 BY MODE (plain scenario, all tasks pooled):')
    const byMode = ARMS.map(arm => {
      const armCells = cells.filter(cell => cell.run.arm === arm.label && cell.scenario === 'plain')
      return {
        label: arm.label,
        mode: arm.mode,
        runs: armCells.length,
        cost: mean(armCells.map(cell => cell.run.cost.total)),
        quality: mean(armCells.map(cell => cell.run.quality.score)),
        steady: mean(armCells.map(cell => cell.run.steadiness.score)),
        truncated: armCells.filter(cell => cell.run.outcome !== 'answered').length,
      }
    })
    for (const row of byMode) {
      console.log(
        `  ${row.label.padEnd(9)} runs=${row.runs} cost=${row.cost.toFixed(6)} `
        + `quality=${row.quality.toFixed(2)} steady=${row.steady.toFixed(2)} `
        + `not-answered=${row.truncated}`,
      )
    }

    // --- The ladder's own claim, checked against the measurement rather than
    // asserted: does paying more actually buy steadiness on these tasks?
    const economy = byMode.find(row => row.mode === 'economy')!
    const balanced = byMode.find(row => row.mode === 'balanced')!
    const quality = byMode.find(row => row.mode === 'quality')!
    const legacy = byMode.find(row => row.mode === 'legacy')!
    console.log('')
    console.log('RC2 LADDER CHECK (the tiers\' steadiness claim):')
    console.log(
      `  economy ${economy.steady.toFixed(2)} -> balanced ${balanced.steady.toFixed(2)} `
      + `-> quality ${quality.steady.toFixed(2)} (steadiness)`,
    )
    console.log(
      `  economy ${economy.cost.toFixed(6)} -> balanced ${balanced.cost.toFixed(6)} `
      + `-> quality ${quality.cost.toFixed(6)} (cost)`,
    )
    console.log(
      `  legacy (Basic policy): cost=${legacy.cost.toFixed(6)} `
      + `quality=${legacy.quality.toFixed(2)} steady=${legacy.steady.toFixed(2)}`,
    )
    const steadyImproves = balanced.steady > economy.steady || quality.steady > economy.steady
    const costsMore = balanced.cost > economy.cost || quality.cost > economy.cost
    console.log(
      steadyImproves
        ? 'RC2 LADDER: a steadiness rung measured HIGHER than economy on this sample.'
        : 'RC2 LADDER: NO steadiness rung measured higher than economy on this sample — '
          + 'the tiers\' benefit is NOT confirmed here, which is what their HYPOTHESIS status says.',
    )
    console.log(
      costsMore
        ? 'RC2 COST: a steadiness rung cost MORE than economy, as the ladder intends.'
        : 'RC2 COST: no rung cost more than economy on this sample; the premium is not visible here.',
    )

    // --- The stress scenarios, reported separately so their effect is not
    // blended into the per-mode means.
    console.log('')
    console.log('RC2 LIFECYCLE SCENARIOS (legacy and economy only):')
    for (const { scenario } of SCENARIOS) {
      if (scenario === 'plain') continue
      const scenarioCells = cells.filter(cell => cell.scenario === scenario)
      for (const arm of ['legacy', 'economy']) {
        const armCells = scenarioCells.filter(cell => cell.run.arm === arm)
        if (armCells.length === 0) continue
        console.log(
          `  ${scenario.padEnd(13)} ${arm.padEnd(9)} n=${armCells.length} `
          + `cost=${mean(armCells.map(cell => cell.run.cost.total)).toFixed(6)} `
          + `quality=${mean(armCells.map(cell => cell.run.quality.score)).toFixed(2)} `
          + `steady=${mean(armCells.map(cell => cell.run.steadiness.score)).toFixed(2)}`,
        )
      }
    }

    // --- Which probes were LOST, per mode. This is the actionable part: a
    // steadiness number says how much was kept, this says WHAT was dropped.
    console.log('')
    console.log('RC2 LOST PROBES (what each mode forgot):')
    for (const arm of ARMS) {
      const armCells = cells.filter(cell => cell.run.arm === arm.label && cell.scenario === 'plain')
      const lost = new Map<string, number>()
      for (const cell of armCells) {
        for (const probe of cell.run.steadiness.probes) {
          if (!probe.held) lost.set(probe.id, (lost.get(probe.id) ?? 0) + 1)
        }
      }
      const summary = [...lost.entries()].map(([id, count]) => `${id}x${count}`).join(' ') || 'none'
      console.log(`  ${arm.label.padEnd(9)} ${summary}`)
    }

    // --- Transport health, reported because a degraded provider window would
    // make every number above uninterpretable.
    const failed = cells.reduce((sum, cell) => sum + cell.run.cost.failedCalls, 0)
    const totalCalls = cells.reduce((sum, cell) => sum + cell.run.cost.calls, 0)
    console.log('')
    console.log(
      `RC2 TRANSPORT: ${failed}/${totalCalls} provider calls returned nothing `
      + `(${totalCalls === 0 ? 0 : ((failed / totalCalls) * 100).toFixed(1)}%)`,
    )
    if (failed > totalCalls * 0.15) {
      console.log(
        'RC2 WARNING: the provider window was degraded; treat the metrics above as provisional.',
      )
    }

    // The assertions record the OUTCOME rather than a pass/fail on a mode: every
    // result here is a legitimate finding, including "the ladder did not show a
    // benefit on this sample".
    expect(cells.length).toBeGreaterThan(0)
    for (const task of [CODING_TASK, RESEARCH_TASK, TOOL_HEAVY_TASK]) {
      expect(cells.some(cell => cell.task.id === task.id)).toBe(true)
    }
  }, 3_600_000)
})
