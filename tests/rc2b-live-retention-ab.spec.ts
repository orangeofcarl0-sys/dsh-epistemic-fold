/**
 * RC2.1: the ONE critical A/B — economy vs balanced, retention isolated.
 *
 * RC2 ran four arms across three tasks and could not rank them: TaskQuality
 * saturated at 1.00, and the single steadiness loss did not reproduce. The
 * lesson was that the instrument, not the code, was the limit. RC2.1's directive
 * is to stop widening and ask ONE question properly.
 *
 * ## The question
 *
 * `balanced` claims that a larger verbatim tail buys steadiness. That claim is
 * tested by varying EXACTLY ONE thing — `retainRatio` — and nothing else:
 *
 *   economy    retainRatio = engine default (0.16)
 *   balanced   retainRatio = 0.24
 *
 * Both arms are EF, both are `semanticMode: none`, both use the same window,
 * threshold, tasks and probe set. So a difference in the steadiness score is
 * attributable to retention, and only retention.
 *
 * ## Why the tasks were changed
 *
 * RC2's tasks were solved in every mode, so no metric could separate anything.
 * The tasks here are the same KIND but harder in the one way that matters: more
 * work lands AFTER the facts are folded, so the session must actually depend on
 * what it kept. A task that needs nothing it forgot cannot measure forgetting.
 *
 * ## Scope, stated up front
 *
 * One A/B, two arms, three tasks, a few replicates. That is enough to say
 * whether retention's benefit is VISIBLE, and not enough to put a number on it.
 * The report says which of those it is.
 *
 * @module tests/rc2b-live-retention-ab
 */

import { describe, expect, it } from 'vitest'
import { flashProfile, newWorkspace, runTaskArm } from '../eval/real-task/driver.ts'
import type { ArmRunResult, ArmSpec } from '../eval/real-task/driver.ts'
import { RETENTION_AB_TASKS } from '../eval/real-task/tasks.ts'
import type { RealTask } from '../eval/real-task/tasks.ts'
import { taskRunToText } from '../eval/real-task/metrics.ts'

const LIVE_ENABLED = process.env.EF_LIVE === '1'

/** How many times to repeat each (task, arm) cell. */
const REPLICATES = Number(process.env.EF_AB_REPLICATES ?? 3)

/**
 * The two arms, differing ONLY in retention.
 *
 * Declared here rather than taken from `ARMS` so the isolation is explicit at
 * the point of use: if someone edits the ladder, this A/B keeps asking its own
 * question instead of silently measuring something else.
 */
const ECONOMY: ArmSpec = { engine: 'ef', mode: 'economy', label: 'economy' }
const BALANCED: ArmSpec = { engine: 'ef', mode: 'balanced', label: 'balanced' }
const AB_ARMS: readonly ArmSpec[] = [ECONOMY, BALANCED]

/** Mean over the non-empty values, or 0. */
function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

/** One cell's result. */
interface Cell {
  readonly task: RealTask
  readonly run: ArmRunResult
}

describe.skipIf(!LIVE_ENABLED)('RC2.1 live: economy vs balanced, retention isolated', () => {
  it('measures whether a larger verbatim tail buys steadiness', async () => {
    const profile = flashProfile()
    const cells: Cell[] = []

    for (let replicate = 0; replicate < REPLICATES; replicate += 1) {
      for (const task of RETENTION_AB_TASKS) {
        for (const arm of AB_ARMS) {
          const workspaceRoot = await newWorkspace()
          const run = await runTaskArm({ task, arm, replicate, scenario: 'plain', profile, workspaceRoot })
          cells.push({ task, run })
          console.log(taskRunToText(run))
        }
      }
    }

    // --- Vacuity: an arm that never used a tool or never folded measured
    // nothing about a context runtime.
    const toolUsing = cells.filter(cell => Object.keys(cell.run.toolCalls).length > 0)
    console.log(`RC2.1 SANITY: ${toolUsing.length}/${cells.length} runs made at least one tool call`)
    expect(toolUsing.length, 'the tasks must actually use tools').toBeGreaterThan(0)

    // --- The comparison.
    console.log('')
    console.log('RC2.1 RETENTION A/B (economy 0.16 vs balanced 0.24, all else identical):')
    const rows = AB_ARMS.map(arm => {
      const armCells = cells.filter(cell => cell.run.arm === arm.label)
      return {
        label: arm.label,
        runs: armCells.length,
        cost: mean(armCells.map(cell => cell.run.cost.total)),
        quality: mean(armCells.map(cell => cell.run.quality.score)),
        steady: mean(armCells.map(cell => cell.run.steadiness.score)),
        steadyRaw: armCells.map(cell => cell.run.steadiness.satisfied),
        steadyTotal: armCells[0]?.run.steadiness.total ?? 0,
        truncated: armCells.filter(cell => cell.run.outcome !== 'answered').length,
      }
    })
    for (const row of rows) {
      console.log(
        `  ${row.label.padEnd(9)} runs=${row.runs} cost=${row.cost.toFixed(6)} `
        + `quality=${row.quality.toFixed(2)} steady=${row.steady.toFixed(2)} `
        + `[${row.steadyRaw.join(', ')}]/${row.steadyTotal} not-answered=${row.truncated}`,
      )
    }

    const economy = rows.find(row => row.label === 'economy')!
    const balanced = rows.find(row => row.label === 'balanced')!
    const steadyDelta = balanced.steady - economy.steady
    const costDelta = balanced.cost - economy.cost

    console.log('')
    console.log(
      `RC2.1 RESULT: steadiness ${economy.steady.toFixed(2)} -> ${balanced.steady.toFixed(2)} `
      + `(delta ${steadyDelta >= 0 ? '+' : ''}${steadyDelta.toFixed(2)}); `
      + `cost ${economy.cost.toFixed(6)} -> ${balanced.cost.toFixed(6)} `
      + `(delta ${costDelta >= 0 ? '+' : ''}${costDelta.toFixed(6)})`,
    )

    // --- Which probes each arm lost. A score says how much was kept; this says
    // WHAT was dropped, which is the actionable half.
    console.log('')
    console.log('RC2.1 LOST PROBES:')
    for (const arm of AB_ARMS) {
      const armCells = cells.filter(cell => cell.run.arm === arm.label)
      const lost = new Map<string, number>()
      for (const cell of armCells) {
        for (const probe of cell.run.steadiness.probes) {
          if (!probe.held) lost.set(probe.id, (lost.get(probe.id) ?? 0) + 1)
        }
      }
      const summary = [...lost.entries()].map(([id, count]) => `${id} x${count}`).join(', ') || 'none'
      console.log(`  ${arm.label.padEnd(9)} ${summary}`)
    }

    // --- The verdict, stated so the report cannot pick a flattering reading
    // afterwards. A NULL result is a legitimate and expected outcome here: the
    // tier's benefit is a hypothesis, and this is the run that could have
    // refuted it.
    console.log('')
    if (steadyDelta > 0) {
      console.log(
        'RC2.1 VERDICT: retention bought a steadiness improvement on this sample. The tier\'s '
        + 'hypothesis is SUPPORTED but NOT established — the sample is small, and a single '
        + 'probe flipping is within model variance.',
      )
    } else if (steadyDelta === 0) {
      console.log(
        'RC2.1 VERDICT: retention bought NO measurable steadiness improvement on this sample. '
        + 'The tier\'s benefit remains UNCONFIRMED. That does not refute it — it means this '
        + 'instrument could not see it, and the honest status stays HYPOTHESIS.',
      )
    } else {
      console.log(
        'RC2.1 VERDICT: retention measured WORSE on this sample. With this few runs that is '
        + 'most likely variance rather than a real regression, but it is reported as measured.',
      )
    }

    // --- Transport health: a degraded provider window makes everything above
    // uninterpretable, so it is reported rather than assumed.
    const failed = cells.reduce((sum, cell) => sum + cell.run.cost.failedCalls, 0)
    const totalCalls = cells.reduce((sum, cell) => sum + cell.run.cost.calls, 0)
    console.log(
      `RC2.1 TRANSPORT: ${failed}/${totalCalls} provider calls returned nothing `
      + `(${totalCalls === 0 ? 0 : ((failed / totalCalls) * 100).toFixed(1)}%)`,
    )

    expect(cells.length).toBe(RETENTION_AB_TASKS.length * AB_ARMS.length * REPLICATES)
  }, 3_600_000)
})
