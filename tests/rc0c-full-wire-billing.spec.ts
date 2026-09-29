/**
 * RC0-C: FullTaskRBCR across three workload families, from the real agent path.
 *
 * This replaces R4-D's main-request-only measurement with the release metric:
 *
 *   FullTaskRBCR = Σ C(all provider calls, economy) / Σ C(all provider calls, basic)
 *
 * The recorder wraps the provider adapter at the LLM seam, so the plugin's own
 * folds, its idle rebase consumer, and Basic's compaction summarizer all issue
 * their calls through it. Nothing is hand-built by the benchmark.
 *
 * The gate (RC0 §18): paired bootstrap on the RATIO scale with the upper 95%
 * bound below 1, and wins exceeding losses. RC0 §17 is explicit that with a
 * small n this is a *deterministic paired bootstrap interval over the observed
 * runs*, not a large-sample confidence interval — so the report says so.
 *
 * Opt-in: `EF_LIVE=1`.
 *
 * @module tests/rc0c-full-wire-billing
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe as describeValues, pairedBootstrapCi, summarizeFullBill, tallyPairs } from '../eval/live/billing.ts'
import type { FullBillSummary } from '../eval/live/billing.ts'
import { fullWireWorkloads, runFullWire } from '../eval/live/full-wire.ts'
import type { FullWireRun } from '../eval/live/full-wire.ts'
import { parseEconomicsProfile } from '../src/economics-profile.ts'
import type { ContextEconomicsProfile } from '../src/economics-profile.ts'
import { resolvePreset } from '../src/preset.ts'

const LIVE_ENABLED = process.env.EF_LIVE === '1'
/** A real window, so the measured prefix behavior is the production one. */
const WINDOW = Number(process.env.EF_LIVE_WINDOW ?? 131_072)
/**
 * Turns per run. Sized to CROSS THE REAL DEFAULT THRESHOLD, which is the point
 * of RC0 §19/§35: at the shipped defaults (131072 window, 65536 headroom) the
 * pressure threshold is 65024 tokens, so the operating regime R4 measured
 * (folding at a 6000-8000 window) is not reachable until a session is that
 * large. A shorter run would produce ZERO folds in both arms and measure
 * nothing — which the vacuity guard correctly refuses.
 */
const TURNS = Number(process.env.EF_LIVE_TURNS ?? 24)
const PAIRS = Number(process.env.EF_LIVE_PAIRS ?? 5)

function flash(): ContextEconomicsProfile {
  return parseEconomicsProfile(JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'profiles', 'economics', 'deepseek-flash-2026-09.json'), 'utf8'),
  ))
}

/** One paired observation: the same workload and policy, both arms. */
interface Pair {
  readonly workload: string
  readonly replicate: number
  readonly economy: FullWireRun
  readonly basic: FullWireRun
}

/**
 * The economy arm's policy, taken FROM the preset (RC0 §19/§35).
 *
 * The live tier previously hand-set a compressed window, a tiny frozen budget,
 * and `thresholdRatio: 0.9` so folds would occur within a short test. Those are
 * MECHANISM knobs, not product defaults. Here the policy comes from
 * `resolvePreset('economy')` so the arm under test is the shipped configuration.
 */
const ECONOMY_POLICY: Readonly<Record<string, unknown>> = { ...resolvePreset('economy') }

describe.skipIf(!LIVE_ENABLED)('RC0-C live: FullTaskRBCR from the real agent path', () => {
  it('prices ALL provider calls for both arms across three workload families', async () => {
    const pairs: Pair[] = []
    const runs: FullWireRun[] = []

    for (let replicate = 0; replicate < PAIRS; replicate += 1) {
      for (const workload of fullWireWorkloads()) {
        // Same workload, same replicate, both arms — a genuine pair.
        const economy = await runFullWire({
          arm: `E4-${workload.id}-${replicate}`,
          basic: false,
          workload,
          turns: TURNS,
          window: WINDOW,
          policy: ECONOMY_POLICY,
          idleMaintenance: true,
          systemPrompt: true,
        })
        const basic = await runFullWire({
          arm: `B1-${workload.id}-${replicate}`,
          basic: true,
          workload,
          turns: TURNS,
          window: WINDOW,
          policy: {},
          idleMaintenance: false,
          // BOTH arms mount SystemPrompt. The first version gave it only to the
          // economy arm, which made the wire shapes incomparable: EF's requests
          // carried a system prompt and Basic's did not.
          systemPrompt: true,
        })
        pairs.push({ workload: workload.id, replicate, economy, basic })
        runs.push(economy, basic)
        console.log(
          `${workload.id} rep${replicate}: economy calls=${economy.bills.length} `
          + `prompts=[${economy.callPromptTokens.join(',')}] folds=${economy.folds} roots=${economy.roots}`
          + ` | basic calls=${basic.bills.length} prompts=[${basic.callPromptTokens.join(',')}] `
          + `folds=${basic.folds} compactionCall=${basic.sawCompactionCall}`,
        )
      }
    }

    const profile = flash()
    const summarize = (run: FullWireRun): FullBillSummary => summarizeFullBill(run.arm, run.bills, profile)

    // Diagnostic: the cache split is what turns identical prompt sizes into
    // different costs, so dump it before any verdict.
    for (const pair of pairs.slice(0, 1)) {
      for (const [label, run] of [['E4', pair.economy], ['B1', pair.basic]] as const) {
        console.log(`${run.workload} ${label} splits: ` + run.callSplits
          .map(s => `${s.purpose[0]}:${s.prompt}/${s.uncached}u`).join(' '))
      }
    }

    // --- NOISE FLOOR, measured before any verdict.
    //
    // The first full-wire run showed identical prompt sequences and identical
    // call counts in both arms, yet a 2.39x cost ratio on one workload. Two
    // arms with the SAME requests cannot differ by policy, so the difference
    // must come from provider cache state at the time each ran. Running the
    // SAME arm twice establishes how large that effect is: if two identical
    // runs differ by more than the claimed effect, the ratio is not evidence.
    const noiseRuns: number[] = []
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const rerun = await runFullWire({
        arm: `B1-noise-${repeat}`,
        basic: true,
        workload: fullWireWorkloads()[0]!,
        turns: TURNS,
        window: WINDOW,
        policy: {},
        idleMaintenance: false,
        systemPrompt: true,
      })
      noiseRuns.push(summarizeFullBill(rerun.arm, rerun.bills, profile).cost)
    }
    const noiseRatio = Math.min(...noiseRuns) === 0
      ? Number.NaN
      : Math.max(...noiseRuns) / Math.min(...noiseRuns)
    console.log(
      `
NOISE FLOOR: two identical Basic runs cost ${noiseRuns.map(c => c.toFixed(5)).join(' vs ')} `
      + `-> ${Number.isFinite(noiseRatio) ? noiseRatio.toFixed(3) : 'n/a'}x spread`,
    )

    // --- Per-family detail, so a mechanism difference is attributable.
    console.log('\n| Workload | Economy calls | Basic calls | Economy cost | Basic cost | RBCR |')
    console.log('|---|---:|---:|---:|---:|---:|')
    const perFamily: Array<{ workload: string; ratio: number; engaged: boolean; folds: number }> = []
    for (const workload of fullWireWorkloads()) {
      const family = pairs.filter(pair => pair.workload === workload.id)
      const economyCalls = family.reduce((sum, pair) => sum + pair.economy.bills.length, 0)
      const basicCalls = family.reduce((sum, pair) => sum + pair.basic.bills.length, 0)
      const economyCost = family.reduce((sum, pair) => sum + summarize(pair.economy).cost, 0)
      const basicCost = family.reduce((sum, pair) => sum + summarize(pair.basic).cost, 0)
      const ratio = basicCost === 0 ? Number.NaN : economyCost / basicCost
      const folds = family.reduce((sum, pair) => sum + pair.economy.folds + pair.basic.folds, 0)
      // A workload where NEITHER arm folded is a NULL TEST: the two arms issue
      // identical requests, so its ratio measures nothing about the policy and
      // must not be averaged into a verdict. At the real defaults a session
      // needs ~65024 tokens before any fold happens, so a workload that grows
      // slowly simply has not engaged the mechanism yet.
      const engaged = folds > 0
      perFamily.push({ workload: workload.id, ratio, engaged, folds })
      console.log(
        `| ${workload.id} | ${economyCalls} | ${basicCalls} | ${economyCost.toFixed(5)} | `
        + `${basicCost.toFixed(5)} | ${ratio.toFixed(3)} | ${engaged ? `${folds} folds` : 'NULL (no folds)'} |`,
      )
    }
    const engagedFamilies = perFamily.filter(entry => entry.engaged)
    console.log(
      `
engaged families: ${engagedFamilies.map(e => e.workload).join(', ') || '(none)'}; `
      + `null tests: ${perFamily.filter(e => !e.engaged).map(e => e.workload).join(', ') || '(none)'}`,
    )

    // --- The paired ratio series, one point per (workload, replicate).
    // NULL tests are excluded: their arms are byte-identical, so including them
    // would pull the mean toward 1 and understate the engaged effect.
    const engagedIds = new Set(engagedFamilies.map(entry => entry.workload))
    const ratios = pairs
      .filter(pair => engagedIds.has(pair.workload))
      .map(pair => {
        const basicCost = summarize(pair.basic).cost
        return basicCost === 0 ? Number.NaN : summarize(pair.economy).cost / basicCost
      })
    const usable = ratios.filter(Number.isFinite)
    console.log(`\npaired ratios (n=${usable.length}): ${usable.map(r => r.toFixed(3)).join(', ')}`)

    // --- RC0 §18's gate, on the ratio scale.
    const ci = pairedBootstrapCi(usable, { seed: 20260929 })
    const engagedPairs = pairs.filter(pair => engagedIds.has(pair.workload))
    const tally = tallyPairs(
      engagedPairs.map(pair => summarize(pair.economy).cost),
      engagedPairs.map(pair => summarize(pair.basic).cost),
    )
    console.log(`paired bootstrap interval (deterministic, over observed runs): ${ci === undefined ? 'OPEN (n<3)' : JSON.stringify(ci)}`)
    console.log(`wins/ties/losses: ${tally.wins}/${tally.ties}/${tally.losses} (tie band ±${tally.tieBand * 100}%)`)

    // --- Vacuity guards, before any verdict is read.
    const economyFolds = runs.filter(run => run.arm.startsWith('E4')).reduce((sum, run) => sum + run.folds, 0)
    const economyRoots = runs.filter(run => run.arm.startsWith('E4')).reduce((sum, run) => sum + run.roots, 0)
    expect(economyFolds, 'the economy arm must fold repeatedly').toBeGreaterThan(0)
    console.log(`economy trajectory: ${economyFolds} folds, ${economyRoots} rebases across ${pairs.length} runs`)
    // A ratio over runs that produced no bills would be meaningless.
    expect(pairs.every(pair => pair.basic.bills.length > 0)).toBe(true)
    expect(pairs.every(pair => pair.economy.bills.length > 0)).toBe(true)

    // --- Robust statistics BEFORE the mean.
    //
    // The 5-pair run produced nine ratios in 0.776-0.984 and ONE at 2.265.
    // That is bimodal, not a spread, and a mean over it is not a summary of
    // anything: the single point drags the mean from ~0.95 to 1.074 and drives
    // the CI upper bound to 1.353. Reporting only the mean would describe the
    // outlier rather than the effect.
    const distribution = describeValues(usable)
    console.log(
      `
RBCR distribution: n=${distribution.count} mean=${distribution.mean.toFixed(3)} `
      + `median=${distribution.median.toFixed(3)} p10=${distribution.p10.toFixed(3)} `
      + `p90=${distribution.p90.toFixed(3)} min=${distribution.min.toFixed(3)} max=${distribution.max.toFixed(3)}`,
    )
    // An outlier is flagged, never silently dropped: a point this far from the
    // rest is either a real mechanism difference or a measurement artifact, and
    // deciding which requires looking at it rather than removing it.
    const outlierThreshold = distribution.median * 1.5
    const outliers = usable.filter(value => value > outlierThreshold)
    if (outliers.length > 0) {
      console.log(
        `OUTLIER(S) beyond 1.5x the median (${outlierThreshold.toFixed(3)}): `
        + `${outliers.map(v => v.toFixed(3)).join(', ')} — retained in the mean, and the mean is `
        + 'therefore NOT a good summary of this sample',
      )
    }
    const belowParity = usable.filter(value => value < 1).length
    console.log(
      `paired ratios below 1: ${belowParity}/${usable.length}`
      + (outliers.length > 0
        ? ` (excluding the outlier: ${usable.filter(v => v <= outlierThreshold && v < 1).length}/${usable.length - outliers.length})`
        : ''),
    )

    // --- The finding, stated either way.
    const mean = distribution.mean
    const upper = ci?.upper ?? Number.POSITIVE_INFINITY
    console.log(
      `\nFullTaskRBCR mean ${mean.toFixed(3)}; CI upper ${Number.isFinite(upper) ? upper.toFixed(3) : 'n/a'}; `
      + `gate ${upper < 1 && tally.wins > tally.losses ? 'PASS' : 'OPEN'}`,
    )
    console.log(
      `NOTE (RC0 §17): this is a deterministic paired bootstrap interval over ${usable.length} observed runs, `
      + 'not a large-sample confidence interval.',
    )

    // RC0 §28: no single workload should systematically lose money, because an
    // average can hide one family funding another.
    for (const entry of perFamily) {
      console.log(
        `  ${entry.workload.padEnd(20)} RBCR ${entry.ratio.toFixed(3)} `
        + `${entry.engaged ? `(engaged, ${entry.folds} folds)` : '(NULL — not exercised at this scale)'}`,
      )
    }

    // The gate is reported, not asserted into a shape: with n < 3 the interval
    // cannot be formed and the verdict must stay OPEN rather than be inferred.
    if (usable.length < 3) expect(ci).toBeUndefined()
  }, 3_600_000)
})
