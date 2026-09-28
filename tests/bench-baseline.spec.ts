/**
 * Paired baseline spec: identical history through Basic vs EF, measuring the
 * M2 paired gate PrefixMutationDepth(EF) < Basic via the local architecture
 * metrics of bench/paired-baseline.ts.
 */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { runPairedBaseline, growTurn, type BaselineResult } from '../bench/paired-baseline.ts'
import type { Harness } from './harness.ts'
import {
  conversation,
  createHarness,
  SIGNAL,
} from './harness.ts'

const GROW_TEXT = 'fixture '.repeat(80).trim()

/** Mount a stock Basic engine in its own harness context. */
async function createBasicHarness(): Promise<Harness> {
  return createHarness({ text: 'basic digest' }, {
    contextWindow: 1_600,
    engine: 'basic',
    efConfig: { thresholdRatio: 0.3, headroomTokens: 0, retainTokens: 0, maxTokens: 512 },
  })
}

function summarize(result: BaselineResult): string {
  return [
    `arm=${result.arm}`,
    `invalidatedSuffixTotal=${result.invalidatedSuffixTokensTotal}`,
    `reclaimed=${result.reclaimedTokensTotal}`,
    `folds=${result.leafFoldCount}`,
    `samples=${result.samples.map(sample => `${sample.step}:pos${sample.firstMutationPosition}/inv${sample.invalidatedSuffixTokens}`).join(' ')}`,
  ].join(' | ')
}

describe('paired baseline: Basic vs EF prefix economics', () => {
  it('EF mutates the stable prefix strictly less than Basic across the run', async () => {
    const basicHarness = await createBasicHarness()
    const efHarness = await createHarness({ text: 'ef digest' }, {
      contextWindow: 1_600,
      efConfig: { thresholdRatio: 0.3, headroomTokens: 0, retainTokens: 0, maxTokens: 512 },
    })

    const createSession = (): Session => conversation(4)
    const grow = growTurn(GROW_TEXT)
    const steps = 8

    const basic = await runPairedBaseline({
      arm: 'B1-basic',
      harness: basicHarness,
      createSession,
      steps,
      grow,
      signal: SIGNAL,
    })
    const ef = await runPairedBaseline({
      arm: 'E2-ef',
      harness: efHarness,
      createSession,
      steps,
      grow,
      signal: SIGNAL,
    })

    // Diagnostics (visible with --reporter=verbose or on failure).
    console.log(summarize(basic))
    console.log(summarize(ef))

    // The paired gate: EF invalidates strictly less prefix per run.
    expect(ef.invalidatedSuffixTokensTotal).toBeLessThan(basic.invalidatedSuffixTokensTotal)
    // Both arms compacted (the comparison is meaningful).
    expect(basic.leafFoldCount).toBeGreaterThan(0)
    expect(ef.leafFoldCount).toBeGreaterThan(0)
    // Both arms reclaimed history (neither is a no-op).
    expect(basic.reclaimedTokensTotal).toBeGreaterThan(0)
    expect(ef.reclaimedTokensTotal).toBeGreaterThan(0)
  })
})
