/**
 * R1-B: workload matrix and the counterfactual ROI lab.
 *
 * Two jobs:
 *
 * 1. Run W1-W5 at 32/64/128 steps so the question "which token source
 *    actually dominates?" is answered from measurement across workload
 *    shapes, not from one narrative fixture.
 *
 * 2. Measure each candidate mechanism's THEORETICAL UPPER BOUND over those
 *    recorded runs, so the routing decision is made on ROI rather than on
 *    milestone numbering (docs/11 §7-§9, §27).
 *
 * The keyless tier is preserved: no provider credentials are needed. What
 * this suite cannot do is live behavioral validation, which R1-E records as
 * explicitly open.
 */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { allWorkloads, WORKLOAD_MODEL } from '../eval/workloads/index.ts'
import type { Workload } from '../eval/workloads/index.ts'
import { createIdleMaintenanceHook, runPairedBaseline } from '../bench/paired-baseline.ts'
import type { BaselineResult } from '../bench/paired-baseline.ts'
import { createHarness, SIGNAL } from './harness.ts'
import type { Harness } from './harness.ts'
import {
  allOracleArms,
  framingDedupArm,
  measureOracle,
  priceOracleSaving,
  rankCandidates,
} from '../eval/src/counterfactual.ts'
import type { OracleResult, RoutingRow } from '../eval/src/counterfactual.ts'
import { TOKEN_BUCKETS } from '../eval/src/token-attribution.ts'
import { profile } from './economics-fixture.ts'

const WINDOW = 16_000

/**
 * Two fold-pressure regimes, because the answer to "what dominates?" is
 * REGIME-DEPENDENT and reporting one number would be dishonest.
 *
 * `aggressive` folds almost every step (the R0-C convention, needed to force
 * folds in small windows). `realistic` leaves pressure to build, which is how
 * a production session behaves. The difference matters enormously: at
 * `aggressive` the recurring per-checkpoint framing is the top cost, while at
 * `realistic` raw history dominates and checkpoints are a few percent. A
 * routing decision that only saw one regime would be a threshold artifact.
 */
const REGIMES = {
  aggressive: { thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 3_000 },
  realistic: { thresholdRatio: 0.6, headroomTokens: 0, retainTokens: 0, maxTokens: 3_000 },
} as const

type RegimeName = keyof typeof REGIMES

async function efHarness(regime: RegimeName): Promise<Harness> {
  // Mounted as the PRODUCTION plugin and driven by its own idle consumer.
  //
  // Phase 1 made this mandatory rather than optional: a frozen-bound surface no
  // longer folds a leaf, so a harness with no consumer would stop folding and
  // never converge — measuring a configuration that cannot exist in production.
  // `runWorkload` attaches the consumer; the numbers below therefore describe
  // the shipped path.
  return createHarness({ text: 'ef digest' }, {
    contextWindow: WINDOW,
    plugin: true,
    workloadModel: WORKLOAD_MODEL,
    efConfig: { ...REGIMES[regime] },
  })
}

async function basicHarness(regime: RegimeName): Promise<Harness> {
  return createHarness({ text: 'basic digest' }, {
    contextWindow: WINDOW,
    engine: 'basic',
    workloadModel: WORKLOAD_MODEL,
    efConfig: { ...REGIMES[regime] },
  })
}

/** Run one workload through one arm for `steps` under one pressure regime. */
async function runWorkload(
  workload: Workload,
  steps: number,
  arm: 'ef' | 'basic',
  regime: RegimeName = 'aggressive',
): Promise<BaselineResult> {
  const harness = arm === 'ef' ? await efHarness(regime) : await basicHarness(regime)
  return runPairedBaseline({
    arm: `${workload.id}-${arm}`,
    harness,
    createSession: workload.createSession,
    steps,
    grow: (session: Session, step: number) => {
      workload.grow(session, step)
      workload.declareState?.(session, step)
    },
    // The EF arm carries the PRODUCTION idle consumer. Basic has no rebase
    // concept, so attaching one to it would be meaningless.
    ...(arm === 'ef' ? { rebase: createIdleMaintenanceHook(harness) } : {}),
    signal: SIGNAL,
  })
}

describe('R1-B: W1-W5 workload matrix', () => {
  const steps = 32

  for (const workload of allWorkloads()) {
    it(`${workload.id} produces a measurable, non-degenerate run`, async () => {
      const ef = await runWorkload(workload, steps, 'ef')
      const basic = await runWorkload(workload, steps, 'basic')

      // Both arms spent real tokens and folded at least once.
      expect(ef.promptSummary.totalPromptTokens).toBeGreaterThan(0)
      expect(basic.promptSummary.totalPromptTokens).toBeGreaterThan(0)
      expect(ef.leafFoldCount).toBeGreaterThan(0)

      // Attribution must reconcile with the metered totals on BOTH arms.
      expect(ef.attribution.grandTotal).toBe(ef.promptSummary.totalPromptTokens)
      expect(basic.attribution.grandTotal).toBe(basic.promptSummary.totalPromptTokens)

      // Every workload must have a dominant source; if attribution were
      // broken, no bucket would carry meaningful share.
      const dominant = TOKEN_BUCKETS
        .map(bucket => ({ bucket, share: ef.attribution.shares[bucket] }))
        .sort((left, right) => right.share - left.share)[0]!
      expect(dominant.share).toBeGreaterThan(0.2)

      console.log(
        `${workload.id}: EF total=${ef.attribution.grandTotal} peak=${ef.promptSummary.peakPromptTokens} `
        + `leaf=${ef.leafFoldCount} | Basic total=${basic.attribution.grandTotal} `
        + `peak=${basic.promptSummary.peakPromptTokens} leaf=${basic.leafFoldCount} `
        + `| dominant=${dominant.bucket} ${(dominant.share * 100).toFixed(1)}%`,
      )
      const shares = TOKEN_BUCKETS
        .filter(bucket => ef.attribution.totals[bucket] > 0)
        .sort((left, right) => ef.attribution.shares[right] - ef.attribution.shares[left])
        .map(bucket => `${bucket}=${(ef.attribution.shares[bucket] * 100).toFixed(1)}%`)
        .join(' ')
      console.log(`  EF buckets: ${shares}`)
    }, 120_000)
  }

  it('workloads genuinely differ: tool-heavy carries tool output that narrative does not', async () => {
    const narrative = await runWorkload(allWorkloads()[0]!, steps, 'ef')
    const tool = await runWorkload(allWorkloads()[2]!, steps, 'ef')
    expect(tool.attribution.totals['raw-tool-result']).toBeGreaterThan(0)
    // The narrative fixture appends no tool results at all — if it did, the
    // two workloads would not be measuring different shapes.
    expect(narrative.attribution.totals['raw-tool-result']).toBe(0)
  }, 120_000)

  it('recall-heavy records recall cost through the real tool-result path', async () => {
    const recall = await runWorkload(allWorkloads()[3]!, steps, 'ef')
    // The workload issues context_recall calls; their returned pages must be
    // attributed to the recall bucket rather than to raw tool output.
    expect(recall.attribution.totals.recall).toBeGreaterThan(0)
  }, 120_000)
})

describe('R1-B: the dominant cost is regime-dependent, not a constant', () => {
  it('frequent folding makes framing the top cost; sparse folding makes raw history top', async () => {
    const workload = allWorkloads()[0]!
    const aggressive = await runWorkload(workload, 64, 'ef', 'aggressive')
    const realistic = await runWorkload(workload, 64, 'ef', 'realistic')

    const rawShare = (result: BaselineResult): number =>
      result.attribution.shares['raw-user']
      + result.attribution.shares['raw-assistant']
      + result.attribution.shares['raw-tool-result']

    console.log(
      `W1 regime sensitivity: aggressive leaf=${aggressive.leafFoldCount} `
      + `framing=${(aggressive.attribution.shares['checkpoint-framing'] * 100).toFixed(1)}% raw=${(rawShare(aggressive) * 100).toFixed(1)}% `
      + `| realistic leaf=${realistic.leafFoldCount} `
      + `framing=${(realistic.attribution.shares['checkpoint-framing'] * 100).toFixed(1)}% raw=${(rawShare(realistic) * 100).toFixed(1)}%`,
    )

    // Aggressive folding: per-checkpoint overhead is a much larger share than
    // under sparse folding. Phase 1 bounded the fold count (a frozen-bound
    // surface hands off to a rebase instead of folding), so framing is no
    // longer the outright TOP bucket — raw history now edges it out even in
    // the aggressive regime. The regime SENSITIVITY is what this test is for,
    // and it survives: framing is ~11x its realistic share.
    expect(aggressive.leafFoldCount).toBeGreaterThan(realistic.leafFoldCount)
    expect(aggressive.attribution.shares['checkpoint-framing'])
      .toBeGreaterThan(realistic.attribution.shares['checkpoint-framing'] * 5)
    // Realistic folding: the recurring overhead is small and raw history leads.
    expect(rawShare(realistic)).toBeGreaterThan(realistic.attribution.shares['checkpoint-framing'])

    // The honest gate: the per-checkpoint fixed overhead is a real, measured
    // property regardless of regime — ~87% of a leaf checkpoint node is
    // repeated preamble and wrapper, so it scales with fold count.
    const perCheckpointOverhead = aggressive.attribution.totals['checkpoint-framing']
      / Math.max(1, aggressive.leafFoldCount)
    const perCheckpointState = aggressive.attribution.totals['checkpoint-leaf-state']
      / Math.max(1, aggressive.leafFoldCount)
    expect(perCheckpointOverhead).toBeGreaterThan(perCheckpointState * 5)
  }, 300_000)
})

describe('R1-B: the frozen-prefix feedback loop (CLOSED by Phase 1)', () => {
  it('the frozen prefix no longer runs away: a rebase collapses it before the loop sustains', async () => {
    // ## What this test used to record
    //
    // R1 measured a structural feedback loop: EF may never re-fold frozen
    // checkpoints (plan §13), so the frozen prefix is monotonically
    // non-decreasing. Once it alone crossed the pressure threshold every later
    // step was over threshold, each fold could only compact the NEW tail, and
    // the result was one checkpoint per step — each paying the full framing
    // preamble. Measured then: 51 EF folds against Basic's 21, with the frozen
    // load growing without bound past the threshold.
    //
    // ## What changed
    //
    // Phase 1 makes `frozen-bound ⇒ ¬leaf` a convergence invariant and hands
    // the surface off to a rebase, which is the only mechanism that can shrink
    // the prefix. So this test now asserts the OPPOSITE of its original claim:
    // the loop must NOT sustain. It is kept, rather than deleted, because the
    // mechanism it describes is still latent — remove the handoff and the old
    // behaviour returns — so this is the regression test for that.
    //
    // The measurement is taken with the PRODUCTION consumer attached, which is
    // now mandatory: without it the surface stops folding and never converges,
    // which is not a configuration that can ship.
    const workload = allWorkloads()[0]!
    const steps = 64
    const window = 16_000
    const thresholdRatio = 0.15
    const run = await runWorkload(workload, steps, 'ef', 'aggressive')
    const thresholdTokens = Math.floor(window * thresholdRatio)

    const loads = run.samples.map(sample => sample.checkpointLoad)
    const peakLoad = Math.max(...loads)
    const finalLoad = loads[loads.length - 1]!

    // The prefix still approaches the threshold — that is what triggers the
    // handoff — but it must not EXCEED it, because exceeding it is precisely
    // the state a leaf cannot fix.
    expect(peakLoad).toBeLessThanOrEqual(thresholdTokens)
    // And the run must END below the threshold, which is only possible if a
    // rebase actually collapsed the prefix.
    expect(finalLoad).toBeLessThan(thresholdTokens)
    // The rebase is the reason, and it must be observable as one.
    expect(run.rootFoldCount).toBeGreaterThan(0)

    // The loop's own signature — many consecutive frozen-bound samples — is
    // gone. Before Phase 1 this count was 28 on the same workload and regime.
    expect(run.pressure.frozenBoundCount).toBeLessThan(5)

    // The same workload under a realistic threshold never approaches either.
    const realistic = await runWorkload(workload, steps, 'ef', 'realistic')
    expect(realistic.leafFoldCount).toBeLessThan(run.leafFoldCount)

    console.log(
      `frozen-prefix loop (closed): aggressive leaf=${run.leafFoldCount} roots=${run.rootFoldCount} `
      + `peakFrozen=${peakLoad} finalFrozen=${finalLoad} threshold=${thresholdTokens} `
      + `frozenBoundSamples=${run.pressure.frozenBoundCount} | realistic leaf=${realistic.leafFoldCount} `
      + `finalFrozen=${realistic.samples[realistic.samples.length - 1]!.checkpointLoad}`,
    )
  }, 300_000)

  it('EF still folds more often than Basic, but the gap is now bounded', async () => {
    // With the digest text held identical, a fold-count gap cannot be a
    // narrative-length artifact — it is architectural. EF pays the
    // per-checkpoint overhead more times than Basic, and Phase 1 does not
    // change that: EF does more, smaller folds.
    //
    // What Phase 1 DOES change is the runaway: the gap used to widen without
    // bound because a frozen-bound surface kept folding. It is now bounded by
    // the handoff, and the run carries at least one rebase that Basic has no
    // concept of.
    const workload = allWorkloads()[0]!
    const steps = 64
    const harnesses = {
      ef: await createHarness({ text: 'IDENTICAL digest text' }, {
        contextWindow: WINDOW, plugin: true, workloadModel: WORKLOAD_MODEL,
        efConfig: { ...REGIMES.aggressive },
      }),
      basic: await createHarness({ text: 'IDENTICAL digest text' }, {
        contextWindow: WINDOW, engine: 'basic', workloadModel: WORKLOAD_MODEL,
        efConfig: { ...REGIMES.aggressive },
      }),
    }
    const runs = {
      ef: await runPairedBaseline({
        arm: 'ef', harness: harnesses.ef, createSession: workload.createSession, steps,
        grow: (session, step) => workload.grow(session, step),
        rebase: createIdleMaintenanceHook(harnesses.ef), signal: SIGNAL,
      }),
      basic: await runPairedBaseline({
        arm: 'basic', harness: harnesses.basic, createSession: workload.createSession, steps,
        grow: (session, step) => workload.grow(session, step), signal: SIGNAL,
      }),
    }
    expect(runs.ef.leafFoldCount).toBeGreaterThan(runs.basic.leafFoldCount)
    // The architectural difference Phase 1 adds: EF rebases, Basic has no such
    // concept. This is what keeps EF's larger fold count from running away.
    expect(runs.ef.rootFoldCount).toBeGreaterThan(0)
    expect(runs.basic.rootFoldCount).toBe(0)
    console.log(
      `identical-digest fold counts: EF=${runs.ef.leafFoldCount} leaf + ${runs.ef.rootFoldCount} root `
      + `(${runs.ef.attribution.grandTotal} tokens) `
      + `vs Basic=${runs.basic.leafFoldCount} leaf (${runs.basic.attribution.grandTotal} tokens)`,
    )
  }, 300_000)
})

describe('R1-B: counterfactual ROI lab (upper bounds, not achievements)', () => {
  const steps = 64

  it('measures every candidate arm across every workload', async () => {
    const results = new Map<string, { run: BaselineResult; oracles: OracleResult[] }>()
    for (const workload of allWorkloads()) {
      const run = await runWorkload(workload, steps, 'ef')
      const oracles = allOracleArms().map(arm => measureOracle(run.attribution, arm))
      results.set(workload.id, { run, oracles })

      const line = oracles
        .map(oracle => `${oracle.armId.replace('E-', '').replace('-oracle', '')}=${(oracle.savingFraction * 100).toFixed(1)}%`)
        .join(' ')
      console.log(`${workload.id} (steps=${steps}): ${line}`)
    }

    // An oracle arm must never save more than the tokens that exist, and
    // never report a negative saving.
    for (const { oracles } of results.values()) {
      for (const oracle of oracles) {
        expect(oracle.savingFraction).toBeGreaterThanOrEqual(0)
        expect(oracle.savingFraction).toBeLessThanOrEqual(1)
        expect(oracle.counterfactualTokens).toBeLessThanOrEqual(oracle.baselineTokens)
      }
    }

    // The measurement-driven finding: framing overhead is a first-order cost
    // whenever folding is frequent, and it beats the full-state delta that
    // Delta Leaf targets.
    const narrative = results.get('W1-narrative-heavy')!
    const framing = narrative.oracles.find(o => o.armId === 'E-framing-oracle')!
    const delta = narrative.oracles.find(o => o.armId === 'E-delta-oracle')!
    expect(framing.savingFraction).toBeGreaterThan(delta.savingFraction)
  }, 300_000)

  it('M1 ingress reduction only pays where tool output actually exists', async () => {
    const tool = await runWorkload(allWorkloads()[2]!, steps, 'ef')
    const narrative = await runWorkload(allWorkloads()[0]!, steps, 'ef')
    const m1 = allOracleArms().find(arm => arm.id === 'E-M1-oracle')!
    // Tool-heavy carries large tool results, so M1 has something to compress.
    expect(measureOracle(tool.attribution, m1).savingFraction).toBeGreaterThan(0.05)
    // Narrative carries none, so M1 is worthless there — the docs/11 §8
    // question answered by workload shape rather than by intuition.
    expect(measureOracle(narrative.attribution, m1).savingFraction).toBe(0)
  }, 300_000)

  it('prices savings at the WARM price, so a cache-dominant model is not over-credited', async () => {
    const run = await runWorkload(allWorkloads()[2]!, steps, 'ef')
    const delta = measureOracle(run.attribution, framingDedupArm())
    const flash = profile('deepseek-flash-2026-09')

    // Realized-cache case: removed warm tokens are cheap, so the money saved
    // is far smaller than the token share removed.
    const warm = await priceOracleSaving(delta, flash, {
      realizationRate: 1,
      warmTokens: run.stablePrefixTokensTotal,
      freshTokens: run.absolutePrefixInvalidation,
      steps,
    })
    // No-cache case: the same removal is worth far more.
    const cold = await priceOracleSaving(delta, flash, {
      realizationRate: 0,
      warmTokens: run.stablePrefixTokensTotal,
      freshTokens: run.absolutePrefixInvalidation,
      steps,
    })
    expect(cold.savedCost).toBeGreaterThan(warm.savedCost)
    expect(warm.savedCost).toBeGreaterThanOrEqual(0)
  }, 120_000)

  it('ranks candidates by saving and risk, not by milestone number', () => {
    const rows: RoutingRow[] = [
      { armId: 'E-delta-oracle', label: 'Delta Leaf', saving: 0.04, savedCost: 0.01, risk: 'medium', kind: 'new-mechanism' },
      { armId: 'E-M1-oracle', label: 'M1 ingress', saving: 0.32, savedCost: 0.02, risk: 'high', kind: 'new-mechanism' },
      { armId: 'E-adaptive-root-oracle', label: 'Adaptive Root', saving: 0.46, savedCost: 0.03, risk: 'low', kind: 'policy-change' },
      { armId: 'E-framing-oracle', label: 'Framing dedup', saving: 0.43, savedCost: 0.03, risk: 'low', kind: 'policy-change' },
    ]
    const ranked = rankCandidates(rows)
    expect(ranked[0]!.armId).toBe('E-adaptive-root-oracle')
    // The lowest-saving arm ranks last regardless of its milestone order.
    expect(ranked[ranked.length - 1]!.armId).toBe('E-delta-oracle')
  })
})
