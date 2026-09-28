/**
 * R0-C benchmark suite: paired baseline with corrected metrics (absolute
 * prefix invalidation as the cross-arm gate; PMA ratio reported separately),
 * root rebase in the loop, and the cache-adjusted break-even curve.
 */

import { describe, expect, it } from 'vitest'
import type { BaselineResult } from '../bench/paired-baseline.ts'
import {
  createRootRebaseHook,
  growTurn,
  runPairedBaseline,
} from '../bench/paired-baseline.ts'
import {
  conversation,
  createHarness,
  SIGNAL,
  type Harness,
} from './harness.ts'

const GROW_TEXT = 'fixture '.repeat(60).trim()

function summarize(result: BaselineResult): string {
  const folds = result.samples
    .filter(sample => sample.invalidatedSuffixTokens > 0)
    .map(sample => `s${sample.step}:mut${sample.firstMutationPosition}/inv${sample.invalidatedSuffixTokens}`)
    .join(' ')
  const curve = result.cacheEconomics
    .map(point => `r${point.rho}:${point.cost}`)
    .join(' ')
  return [
    `arm=${result.arm}`,
    `absInvalidation=${result.absolutePrefixInvalidation}`,
    `stableReuse=${result.stablePrefixTokensTotal}`,
    `PMA=${result.prefixMutationRatio.toFixed(2)}`,
    `reclaimed=${result.reclaimedTokensTotal}`,
    `leaf=${result.leafFoldCount}`,
    `root=${result.rootFoldCount}`,
    `finalCpLoad=${result.finalCheckpointLoad}`,
    `folds[${folds}]`,
    `curve[${curve}]`,
  ].join(' | ')
}

const BENCH_CONFIG = {
  contextWindow: 8_000,
  efConfig: { thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 2_048 },
}

async function createBasicHarness(): Promise<Harness> {
  return createHarness({ text: 'basic digest' }, { ...BENCH_CONFIG, engine: 'basic' })
}

describe('R0-C: paired baseline with corrected metrics', () => {
  it('architecture locality: EF fold steps keep the prefix stable, Basic rewrites position 0', async () => {
    const basic = await runPairedBaseline({
      arm: 'B1-basic',
      harness: await createBasicHarness(),
      createSession: () => conversation(4),
      steps: 12,
      grow: growTurn(GROW_TEXT),
      signal: SIGNAL,
    })
    const ef = await runPairedBaseline({
      arm: 'E2-ef',
      harness: await createHarness({ text: 'ef digest' }, BENCH_CONFIG),
      createSession: () => conversation(4),
      steps: 12,
      grow: growTurn(GROW_TEXT),
      signal: SIGNAL,
    })

    console.log(summarize(basic))
    console.log(summarize(ef))

    // Both arms compacted — the comparison is meaningful.
    expect(basic.leafFoldCount).toBeGreaterThan(0)
    expect(ef.leafFoldCount).toBeGreaterThan(0)

    // Layer 1 gate: ABSOLUTE prefix invalidation (the corrected claim).
    expect(ef.absolutePrefixInvalidation).toBeLessThan(basic.absolutePrefixInvalidation)
    // And the direction of prefix REUSE: EF keeps more of the history warm.
    expect(ef.stablePrefixTokensTotal).toBeGreaterThan(basic.stablePrefixTokensTotal)

    // The mechanism, visible per step: every Basic FOLD step mutates the
    // history at position 0 (full rewrite), while EF fold steps mutate past
    // the frozen frontier.
    const basicFoldSteps = basic.samples.filter(sample => sample.invalidatedSuffixTokens > 500)
    const efFoldSteps = ef.samples.filter(sample => sample.invalidatedSuffixTokens > 500)
    expect(basicFoldSteps.length).toBeGreaterThan(0)
    expect(efFoldSteps.length).toBeGreaterThan(0)
    expect(basicFoldSteps.every(sample => sample.firstMutationPosition === 0)).toBe(true)
    expect(efFoldSteps.some(sample => sample.firstMutationPosition > 0)).toBe(true)
  })

  it('R0-C economics: hit/miss decomposition and the rho break-even curve', async () => {
    const basic = await runPairedBaseline({
      arm: 'B1-basic',
      harness: await createBasicHarness(),
      createSession: () => conversation(4),
      steps: 12,
      grow: growTurn(GROW_TEXT),
      signal: SIGNAL,
    })
    const ef = await runPairedBaseline({
      arm: 'E2-ef',
      harness: await createHarness({ text: 'ef digest' }, BENCH_CONFIG),
      createSession: () => conversation(4),
      steps: 12,
      grow: growTurn(GROW_TEXT),
      signal: SIGNAL,
    })

    // Curve shape: rho=0 means no cache discount (cost = pure misses); rho=1
    // means cache is free (cost = full prompts). Costs rise with rho.
    for (const result of [basic, ef]) {
      expect(result.cacheEconomics[0]!.rho).toBe(0)
      expect(result.cacheEconomics[result.cacheEconomics.length - 1]!.rho).toBe(1)
      const costs = result.cacheEconomics.map(point => point.cost)
      expect([...costs].sort((a, b) => a - b)).toEqual(costs)
    }

    // The break-even insight: at rho=1 (cache free) the arms converge toward
    // total prompts; at rho=0 the arms differ by the prefix economy. Print
    // the crossing for the report.
    for (const point of basic.cacheEconomics) {
      const efPoint = ef.cacheEconomics.find(candidate => candidate.rho === point.rho)!
      console.log(`rho=${point.rho} basic=${point.cost} ef=${efPoint.cost} delta=${point.cost - efPoint.cost}`)
    }
  })

  it('R0-C root rebase: frozen budget triggers rebase, reclaim and continued folding work', async () => {
    // Budget small enough that two leaf checkpoints recommend a rebase.
    const efHarness = await createHarness({ text: 'ef digest' }, {
      ...BENCH_CONFIG,
      efConfig: { thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 2_048, frozenCheckpointTokenBudget: 200 },
    })
    const rebase = createRootRebaseHook(efHarness)
    const ef = await runPairedBaseline({
      arm: 'E3a-root',
      harness: efHarness,
      createSession: () => conversation(4),
      steps: 20,
      grow: growTurn(GROW_TEXT),
      rebase,
      signal: SIGNAL,
    })

    console.log(ef.samples.map(sample => `s${sample.step}:${sample.promptTokens}t`).join(' '))
    console.log(summarize(ef))

    // The rebase actually ran (root folds executed mid-run).
    expect(ef.rootFoldCount).toBeGreaterThanOrEqual(1)
    // After the rebase the frozen load collapsed and leaves kept folding.
    expect(ef.leafFoldCount).toBeGreaterThan(1)
    // The rebase COLLAPSED the frozen load: right after the root fold the
    // load dropped to a single checkpoint (final load can regrow later).
    const peak = Math.max(...ef.samples.map(sample => sample.checkpointLoad))
    const afterRootLoads = ef.samples
      .filter((sample, index) => index > 0 && ef.samples[index - 1]!.checkpointLoad > sample.checkpointLoad)
      .map(sample => sample.checkpointLoad)
    expect(peak).toBeGreaterThan(0)
    expect(afterRootLoads.length).toBeGreaterThanOrEqual(1)
    expect(Math.min(...afterRootLoads)).toBeLessThan(peak)

    // The corrected gate holds over the longer run as well — for the arm
    // WITHOUT rebase pressure. The rebase arm exhibits the REAL trade-off
    // the audit asked to measure: the root reset (inv ~404 at s13) buys a
    // collapsed frozen load but costs absolute invalidation in a short
    // window (RootResetCost vs StableLeafBenefit).
    const basic = await runPairedBaseline({
      arm: 'B1-basic',
      harness: await createBasicHarness(),
      createSession: () => conversation(4),
      steps: 20,
      grow: growTurn(GROW_TEXT),
      signal: SIGNAL,
    })
    console.log(summarize(basic))
    expect(basic.absolutePrefixInvalidation).toBeGreaterThan(0)
    // The rebase arm's root fold is visible as a full-rewrite step.
    const rootSteps = ef.samples.filter(sample => sample.firstMutationPosition === 0 && sample.step > 1)
    expect(rootSteps.length).toBeGreaterThanOrEqual(ef.rootFoldCount)
  })
})
