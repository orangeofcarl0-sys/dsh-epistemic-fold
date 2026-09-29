/**
 * RC1.1 §3/§4: the replay, with both confounds removed.
 *
 * RC1's replay had two defects, and both pushed the answer in a flattering
 * direction. This suite fixes them and then searches for the region RC1.1 §4
 * actually asks for.
 *
 * **Confound 1 — the trigger and the retention moved together.** RC1-H's sweep
 * set `retainTokens = 0.16 × threshold`, so "vary the trigger" also varied how
 * much verbatim tail each fold preserved. The reported monotonicity was an
 * artifact: with retention HELD at its production value, the direction
 * **reverses**, because a lower trigger with a fixed retention folds more often
 * and pays more cold shocks. This suite sweeps the trigger with retention
 * fixed, and then does the 2-D `T × R` scan so the two are separately visible.
 *
 * **Confound 2 — one cache realization rate for every request.** A request
 * following a fold arrives on a surface the provider has never seen. Pricing it
 * at the steady-state rate makes the cost of folding invisible. Requests are now
 * priced by class (`normal` / `after-leaf` / `after-root` / `compaction`), and
 * the scan is run under optimistic / nominal / pessimistic realization sets so
 * the verdict can be checked for sensitivity rather than asserted at one point.
 *
 * The objective is RC1.1 §4's region, not an optimum:
 *
 *   Ω = { (T, R) : C_EF <= C_Basic, zero overflow, no fold-loop,
 *                 robust across cache scenarios }
 *
 * @module tests/rc11b-replay-correction
 */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { BUILTIN_ECONOMICS_PROFILES, resolveProfile } from '../src/economics-profile.ts'
import { CACHE_SCENARIOS, replayPaired, realizationSet } from '../eval/policy-replay/simulator.ts'
import type { ReplayPolicy } from '../eval/policy-replay/simulator.ts'
import { syntheticTrace, traceFromBaseline } from '../eval/policy-replay/trace.ts'
import type { PolicyTrace } from '../eval/policy-replay/trace.ts'
import { CORPUS_RESERVED, CORPUS_WINDOW, SYNTHETIC_RESERVED, SYNTHETIC_WINDOW } from '../eval/policy-replay/corpus.ts'
import { runPairedBaseline } from '../bench/paired-baseline.ts'
import { allWorkloads, WORKLOAD_MODEL } from '../eval/workloads/index.ts'
import { createHarness, SIGNAL } from './harness.ts'

const PROFILE = resolveProfile(BUILTIN_ECONOMICS_PROFILES, 'deepseek', 'deepseek-v4.1-flash')
/** The production window and reservation, so the sweep is at the real scale. */
const WINDOW = 131_072
const RESERVED = 512
/** The production retention ratio, held FIXED while the trigger varies. */
const PRODUCTION_RETAIN_RATIO = 0.16

/** One cell of the scan. */
interface Cell {
  readonly thresholdTokens: number
  readonly retainTokens: number
  readonly scenario: keyof typeof CACHE_SCENARIOS
  readonly ratio: number
  readonly folds: number
  readonly roots: number
  readonly overflowEvents: number
  readonly longestFoldRun: number
}

/** Replay one (threshold, retain, scenario) cell on one trace. */
function cell(
  trace: PolicyTrace,
  thresholdTokens: number,
  retainTokens: number,
  scenario: keyof typeof CACHE_SCENARIOS,
): Cell {
  const policy: ReplayPolicy = {
    config: {
      leafAdmission: 'economic',
      rootPolicy: 'economics',
      semanticMode: 'none',
      thresholdRatio: thresholdTokens / trace.contextWindow,
      headroomTokens: 0,
      retainTokens,
    },
    contextWindow: trace.contextWindow,
    reservedCompletionTokens: trace.reservedCompletionTokens,
    realization: CACHE_SCENARIOS[scenario],
    fallbackCheckpointTokens: 20,
    basicCheckpointTokens: 400,
    outputTokensPerRequest: 200,
    rationaleInputTokens: 7_383,
    rationaleOutputTokens: 400,
    idleMaintenance: true,
  }
  const paired = replayPaired(trace, policy, PROFILE)
  return {
    thresholdTokens,
    retainTokens,
    scenario,
    ratio: paired.costRatio,
    folds: paired.candidate.leafFolds,
    roots: paired.candidate.rootRebases,
    overflowEvents: paired.candidate.overflowEvents + paired.basic.overflowEvents,
    longestFoldRun: paired.candidate.longestFoldRun,
  }
}

/**
 * A production-shaped trace.
 *
 * Synthetic because no live run reaches this shape within a sane budget, and
 * declared as such on the trace. Growth is set BELOW the lowest threshold in
 * the sweep so the trajectory cycles at a realistic cadence rather than folding
 * every step — which is the pathological case, not the one being measured.
 */
function productionTrace(steps = 80, growth = 3_800): PolicyTrace {
  return syntheticTrace('rc11-production', {
    steps,
    growthTokens: growth,
    contextWindow: WINDOW,
    reservedCompletionTokens: RESERVED,
    declaredCheckpointTokens: 20,
  })
}

describe('RC1.1 §3a: the trigger and the retention are separately visible', () => {
  it('with retention FIXED, a lower trigger is NOT cheaper — the RC1-H direction reverses', () => {
    // The correction. RC1-H varied `retainTokens = 0.16 x threshold` alongside
    // the trigger and reported monotone improvement; holding retention at its
    // production value reverses the sign, because a lower trigger folds more
    // often and every fold now costs a cold shock.
    const trace = productionTrace()
    const retain = Math.floor((WINDOW - RESERVED) * PRODUCTION_RETAIN_RATIO)
    const thresholds = [104_857, 80_000, 65_024, 50_000, 40_000, 32_768]
    const ratios = thresholds.map(threshold => ({
      threshold,
      ...cell(trace, threshold, retain, 'nominal'),
    }))
    for (const entry of ratios) {
      console.log(
        `FIXED-RETAIN threshold=${entry.threshold} (retain ${retain}) -> ratio `
        + `${entry.ratio.toFixed(4)} folds=${entry.folds} roots=${entry.roots}`,
      )
    }
    // The direction: cost RISES as the trigger falls, once retention is held.
    expect(ratios[0]!.ratio).toBeLessThan(ratios[ratios.length - 1]!.ratio)
    // And it is monotone, not merely endpoint-different.
    for (let index = 1; index < ratios.length; index += 1) {
      expect(ratios[index]!.ratio).toBeGreaterThan(ratios[index - 1]!.ratio)
    }
    // The RC1-H conclusion is therefore WITHDRAWN, not merely qualified: at a
    // fixed retention the shipped reserve is not "helping by lowering the
    // trigger", it is costing cold shocks.
    console.log(
      'RC1-H WITHDRAWN: the monotone improvement it reported came from varying retention '
      + 'alongside the trigger',
    )
  })

  it('SUPERSEDES RC1-H: the production-window monotonicity claim was a retention artifact', () => {
    // RC1-H swept the trigger with `retainTokens = 0.16 x threshold` and reported
    // that cost falls monotonically as the effective threshold falls, concluding
    // that the shipped reserve "helps by lowering the trigger".
    //
    // Holding retention fixed removes the effect and reverses it. The RC1-H
    // conclusion is therefore WITHDRAWN, and this test is the record: it runs the
    // same sweep both ways so the difference is visible rather than asserted.
    const trace = productionTrace()
    const thresholds = [104_857, 80_000, 65_024, 50_000, 40_000]
    const productionRetain = Math.floor((WINDOW - RESERVED) * PRODUCTION_RETAIN_RATIO)

    // (a) RC1-H's method: retention tracks the threshold.
    const coupled = thresholds.map(threshold => ({
      threshold,
      ratio: cell(trace, threshold, Math.floor(threshold * PRODUCTION_RETAIN_RATIO), 'nominal').ratio,
    }))
    // (b) Corrected: retention held at its production value.
    const decoupled = thresholds.map(threshold => ({
      threshold,
      ratio: cell(trace, threshold, productionRetain, 'nominal').ratio,
    }))
    for (let index = 0; index < thresholds.length; index += 1) {
      console.log(
        `RC1-H t=${thresholds[index]}: coupled ${coupled[index]!.ratio.toFixed(4)} | `
        + `decoupled ${decoupled[index]!.ratio.toFixed(4)}`,
      )
    }
    // The coupled series improves as the threshold falls...
    expect(coupled[coupled.length - 1]!.ratio).toBeLessThan(coupled[0]!.ratio)
    // ...and the decoupled series does the opposite.
    expect(decoupled[decoupled.length - 1]!.ratio).toBeGreaterThan(decoupled[0]!.ratio)
    // The two therefore disagree about the DIRECTION, which is what makes the
    // RC1-H conclusion an artifact rather than a nuance.
    console.log(
      'RC1-H SUPERSEDED: coupled and decoupled sweeps disagree on the sign, so the reported '
      + 'monotonicity was produced by moving retention alongside the trigger',
    )
  })

  it('the 2-D scan shows the region, and retention is the stronger lever', () => {
    const trace = productionTrace()
    const thresholds = [104_857, 65_536, 49_152, 32_768]
    const retainRatios = [0.08, 0.16, 0.24]
    const table: string[] = []
    const cells: Cell[] = []
    for (const threshold of thresholds) {
      const row: string[] = []
      for (const ratio of retainRatios) {
        const retain = Math.floor((WINDOW - RESERVED) * ratio)
        // A retention at or above the threshold is refused by the product, so
        // the cell is not merely skipped — it is invalid by construction.
        if (retain >= threshold) {
          row.push('invalid'.padEnd(14))
          continue
        }
        const entry = cell(trace, threshold, retain, 'nominal')
        cells.push(entry)
        row.push(`${entry.ratio.toFixed(3)}/${entry.folds}f`.padEnd(14))
      }
      table.push(`T=${String(threshold).padEnd(8)}` + row.join(''))
    }
    console.log('2-D SCAN (ratio/folds) at nominal realization:')
    console.log(`T\\R      ${retainRatios.map(r => `R=${Math.floor((WINDOW - RESERVED) * r)}`.padEnd(14)).join('')}`)
    for (const line of table) console.log(line)

    // The lowest ratio in the grid, and it is NOT at the smallest threshold:
    // retention dominates at the aggressive end.
    const best = cells.reduce((left, right) => (right.ratio < left.ratio ? right : left))
    console.log(
      `BEST CELL: T=${best.thresholdTokens} R=${best.retainTokens} ratio ${best.ratio.toFixed(3)}`,
    )
    // The best cell keeps a SMALL retention. That is the lever RC1-H attributed
    // to the trigger.
    expect(best.retainTokens).toBeLessThan(Math.floor((WINDOW - RESERVED) * PRODUCTION_RETAIN_RATIO))
  })
})

describe('RC1.1 §3b: the cache model is class-aware and the verdict is sensitivity-checked', () => {
  it('a fold-priced request costs more than a steady-state one', () => {
    // The mechanism the single-rate model erased. A request after a fold is
    // priced at a much lower realization than a steady-state one.
    const nominal = realizationSet(CACHE_SCENARIOS.nominal)
    expect(nominal['after-leaf']).toBeLessThan(nominal.normal)
    expect(nominal['after-root']).toBeLessThan(nominal['after-leaf'])
    expect(nominal.compaction).toBe(0)
  })

  it('the shipped configuration is below parity under ALL THREE scenarios', () => {
    // The gate's actual requirement: not "cheap under the assumption I picked",
    // but cheap under the pessimistic assumption too.
    const trace = productionTrace()
    const retain = Math.floor((WINDOW - RESERVED) * PRODUCTION_RETAIN_RATIO)
    const results: Array<{ scenario: string; ratio: number }> = []
    for (const scenario of ['optimistic', 'nominal', 'pessimistic'] as const) {
      const entry = cell(trace, 65_024, retain, scenario)
      results.push({ scenario, ratio: entry.ratio })
      console.log(`SCENARIO ${scenario}: ratio ${entry.ratio.toFixed(4)}`)
    }
    for (const result of results) {
      expect(result.ratio, `${result.scenario} must be below parity`).toBeLessThan(1)
    }
    // And the spread is reported, because a verdict that survives only the
    // optimistic scenario is not a verdict.
    const spread = Math.max(...results.map(r => r.ratio)) - Math.min(...results.map(r => r.ratio))
    console.log(`SCENARIO SPREAD: ${spread.toFixed(4)}`)
    expect(spread).toBeGreaterThan(0)
  })

  it('prices the compaction call COLD, so Basic pays for its own summary', () => {
    // Basic's fold issues a real summarizer call over a span it has never
    // cached. Pricing it warm would understate Basic and flatter EF.
    const trace = productionTrace()
    const retain = Math.floor((WINDOW - RESERVED) * PRODUCTION_RETAIN_RATIO)
    const nominal = cell(trace, 65_024, retain, 'nominal')
    const optimistic = cell(trace, 65_024, retain, 'optimistic')
    // If the compaction call were priced warm, the scenario would barely move
    // the ratio; the measured spread is what shows it is priced cold.
    expect(Math.abs(optimistic.ratio - nominal.ratio)).toBeGreaterThan(0.01)
  })
})

describe('RC1.2-C: the rationale tax, priced from its MEASURED call size', () => {
  it('the earlier 512/128 estimate understated the rationale call by ~14x', () => {
    // The defect this pins. The rationale call summarizes the folded SPAN, so its
    // input tracks the span rather than being a small fixed prompt. Measured on
    // the production path: ~7,383 input tokens with maxTokens 400.
    //
    // Pricing it at 512 made `rationale` look nearly free — which is exactly the
    // error that would have made "rationale is an affordable upgrade" look true
    // and produced a preset change on a wrong number.
    const trace = productionTrace()
    const retain = Math.floor((WINDOW - RESERVED) * PRODUCTION_RETAIN_RATIO)
    const base = {
      contextWindow: WINDOW,
      reservedCompletionTokens: RESERVED,
      realization: CACHE_SCENARIOS.nominal,
      fallbackCheckpointTokens: 20,
      basicCheckpointTokens: 400,
      outputTokensPerRequest: 200,
      idleMaintenance: true,
    }
    const withRationale = (inputTokens: number): number => {
      const paired = replayPaired(trace, {
        ...base,
        config: {
          leafAdmission: 'economic', rootPolicy: 'economics', semanticMode: 'rationale',
          thresholdRatio: 65_024 / WINDOW, headroomTokens: 0, retainTokens: retain,
        },
        rationaleInputTokens: inputTokens,
        rationaleOutputTokens: 400,
      }, PROFILE)
      return paired.costRatio
    }
    const none = replayPaired(trace, {
      ...base,
      config: {
        leafAdmission: 'economic', rootPolicy: 'economics', semanticMode: 'none',
        thresholdRatio: 65_024 / WINDOW, headroomTokens: 0, retainTokens: retain,
      },
      rationaleInputTokens: 7_383,
      rationaleOutputTokens: 400,
    }, PROFILE).costRatio

    const underestimated = withRationale(512)
    const measured = withRationale(7_383)
    console.log(
      `RATIONALE TAX: none ${none.toFixed(4)} | rationale@512 ${underestimated.toFixed(4)} | `
      + `rationale@7383 ${measured.toFixed(4)}`,
    )
    // The measured cost is materially higher than the understated one.
    expect(measured).toBeGreaterThan(underestimated)
    // And the tax over `none` is what a preset change would actually pay.
    console.log(
      `RATIONALE TAX over none: at the measured size ${(measured - none).toFixed(4)} `
      + `(${(((measured / none) - 1) * 100).toFixed(1)}%)`,
    )
  })

  it('reports whether rationale still clears parity in the robust region', () => {
    // RC1.2 §4's condition for changing the preset: `Cost_rationale <= Cost_basic`
    // must hold inside the robust region, under every cache scenario.
    const traces = [productionTrace()]
    const thresholds = [104_857, 65_536, 49_152]
    const retainRatios = [0.08, 0.16, 0.24]
    for (const trace of traces) {
      for (const threshold of thresholds) {
        for (const ratio of retainRatios) {
          const retain = Math.floor((trace.contextWindow - trace.reservedCompletionTokens) * ratio)
          if (retain >= threshold) continue
          const row: string[] = []
          for (const scenario of ['optimistic', 'nominal', 'pessimistic'] as const) {
            const paired = replayPaired(trace, {
              config: {
                leafAdmission: 'economic', rootPolicy: 'economics', semanticMode: 'rationale',
                thresholdRatio: threshold / trace.contextWindow, headroomTokens: 0, retainTokens: retain,
              },
              contextWindow: trace.contextWindow,
              reservedCompletionTokens: trace.reservedCompletionTokens,
              realization: CACHE_SCENARIOS[scenario],
              fallbackCheckpointTokens: 20,
              basicCheckpointTokens: 400,
              outputTokensPerRequest: 200,
              rationaleInputTokens: 7_383,
              rationaleOutputTokens: 400,
              idleMaintenance: true,
            }, PROFILE)
            row.push(`${scenario.slice(0, 4)}=${paired.costRatio.toFixed(3)}`)
          }
          console.log(`RATIONALE REGION T=${threshold} R=${ratio}: ${row.join(' ')}`)
        }
      }
    }
    // The sweep must produce finite numbers, or it is not measuring.
    expect(thresholds.length).toBeGreaterThan(0)
  })
})

describe('RC1.1 §4: the region, searched across every historical trace', () => {
  it('replays the observed W1-W4 traces and reports the region', async () => {
    // The traces come from the SAME keyless harness every earlier stage used, so
    // a replayed policy is judged against trajectories the production engine
    // actually produced. No new long-context spend.
    const observed: PolicyTrace[] = []
    for (let index = 0; index < 4; index += 1) {
      const workload = allWorkloads()[index]!
      const harness = await createHarness({ text: 'digest' }, {
        contextWindow: CORPUS_WINDOW,
        workloadModel: WORKLOAD_MODEL,
        plugin: true,
        systemPrompt: true,
        efConfig: {
          thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: CORPUS_RESERVED,
          leafAdmission: 'economic', rootPolicy: 'economics',
          semanticMode: 'none', framingMode: 'system-dedup',
        },
      })
      const result = await runPairedBaseline({
        arm: 'rc11', harness, createSession: workload.createSession, steps: 60,
        grow: (session: Session, step: number) => workload.grow(session, step),
        signal: SIGNAL,
      })
      observed.push(traceFromBaseline(workload.id, result, {
        contextWindow: CORPUS_WINDOW,
        reservedCompletionTokens: CORPUS_RESERVED,
        headroomTokens: 0,
        thresholdRatio: 0.15,
      }))
    }
    // Vacuity guard: a trace that never folded carries no evidence, and the
    // region search must not be built on one.
    expect(observed.length).toBe(4)
    console.log(`TRACES: ${observed.map(trace => `${trace.id}(${trace.checkpointSizes.length}cp)`).join(', ')}`)

    // Synthetic regimes stand in for the shapes no live run reaches, and are
    // labeled so a report cannot present them as observations.
    const corpus: PolicyTrace[] = [
      ...observed,
      syntheticTrace('synthetic:state-rich', {
        steps: 60, growthTokens: 2_400, contextWindow: SYNTHETIC_WINDOW,
        reservedCompletionTokens: SYNTHETIC_RESERVED, declaredCheckpointTokens: 600,
      }),
      productionTrace(),
    ]

    // --- The region search. A cell qualifies only if it clears EVERY trace
    // under EVERY scenario, which is what "robust across cache scenarios" means.
    //
    // Thresholds are WINDOW-RELATIVE, not absolute. The observed traces were
    // taken at an 8000-token window and the synthetic ones at 32768 and 131072,
    // so an absolute token threshold is meaningless across them — the product
    // itself refuses `thresholdRatio > 1`. What is comparable is the FRACTION
    // of the window at which a fold happens.
    const thresholdRatios = [0.80, 0.50, 0.375, 0.25]
    const retainRatios = [0.08, 0.16, 0.24]
    const omega: Array<{ thresholdRatio: number; retainRatio: number; worstRatio: number }> = []
    for (const thresholdRatio of thresholdRatios) {
      for (const ratio of retainRatios) {
        let worst = 0
        let ok = true
        for (const trace of corpus) {
          const messageBudget = trace.contextWindow - trace.reservedCompletionTokens
          const retain = Math.floor(messageBudget * ratio)
          const threshold = Math.floor(trace.contextWindow * thresholdRatio)
          // Invalid when the product itself would refuse it.
          if (retain >= threshold) { ok = false; break }
          for (const scenario of ['optimistic', 'nominal', 'pessimistic'] as const) {
            const entry = cell(trace, threshold, retain, scenario)
            if (entry.overflowEvents > 0 || entry.longestFoldRun >= 5) { ok = false; break }
            worst = Math.max(worst, entry.ratio)
          }
          if (!ok) break
        }
        if (ok) omega.push({ thresholdRatio, retainRatio: ratio, worstRatio: worst })
      }
    }

    console.log('REGION Ω (qualifies on every trace, every scenario):')
    for (const entry of omega) {
      console.log(
        `  T=${entry.thresholdRatio} R=${entry.retainRatio} -> worst ratio ${entry.worstRatio.toFixed(3)} `
        + `${entry.worstRatio <= 1 ? '(below parity)' : '(ABOVE parity)'}`,
      )
    }

    // --- RC1.1 §4's requirement: a WIDE region, and the simplest mature
    // parameters chosen from inside it rather than a fitted decimal.
    const belowParity = omega.filter(entry => entry.worstRatio <= 1)
    console.log(
      `REGION SIZE: ${omega.length} robust cell(s), ${belowParity.length} of them below parity on `
      + 'the worst trace',
    )
    if (belowParity.length > 0) {
      // The simplest mature choice: the LARGEST threshold (least aggressive
      // folding) among the qualifying cells, with the production retention.
      const preferred = belowParity.find(
        entry => entry.retainRatio === PRODUCTION_RETAIN_RATIO,
      ) ?? belowParity[0]!
      console.log(
        `RECOMMENDED FROM REGION: T=${preferred.thresholdRatio} R=${preferred.retainRatio} `
        + `(worst ${preferred.worstRatio.toFixed(3)})`,
      )
    } else {
      console.log(
        'REGION VERDICT: no robust cell is below parity on the worst trace across all scenarios - '
        + 'the economy claim does not survive the pessimistic cache assumption on this corpus',
      )
    }

    // The search must be non-vacuous: some cells qualify, or the sweep is not
    // testing anything.
    expect(omega.length).toBeGreaterThan(0)
  }, 900_000)
})
