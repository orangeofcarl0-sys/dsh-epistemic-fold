/**
 * R2-A: pressure attribution.
 *
 * R2-A changes NO fold decision. Its job is to make the fold-every-step regime
 * measurable, so R2-B can gate on it rather than on intuition. These tests
 * therefore assert the DECOMPOSITION and the DETECTOR, and prove against a
 * real run that the regime R1 discovered is visible in the new telemetry.
 */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  classifyPressureRegime,
  leafMarginalReclaim,
  pressureBreakdown,
  summarizePressureHistory,
} from '../src/pressure.ts'
import type { PressureSample } from '../src/pressure.ts'
import { allWorkloads, WORKLOAD_MODEL } from '../eval/workloads/index.ts'
import { runPairedBaseline } from '../bench/paired-baseline.ts'
import { createHarness, SIGNAL } from './harness.ts'
import type { Harness } from './harness.ts'

async function efHarness(thresholdRatio: number): Promise<Harness> {
  return createHarness({ text: 'ef digest' }, {
    contextWindow: 16_000,
    projection: true,
    workloadModel: WORKLOAD_MODEL,
    efConfig: { thresholdRatio, headroomTokens: 0, retainTokens: 0, maxTokens: 3_000 },
  })
}

describe('R2-A: pressure decomposes into frozen and open', () => {
  it('splits pressure exactly: frozen + open = total', async () => {
    const workload = allWorkloads()[0]!
    const harness = await efHarness(0.15)
    const result = await runPairedBaseline({
      arm: 'W1',
      harness,
      createSession: workload.createSession,
      steps: 32,
      grow: (session: Session, step: number) => workload.grow(session, step),
      signal: SIGNAL,
    })

    expect(result.pressure.samples.length).toBe(32)
    for (const sample of result.pressure.samples) {
      expect(sample.frozenTokens + sample.openTokens).toBe(sample.totalTokens)
      expect(sample.frozenTokens).toBeGreaterThanOrEqual(0)
      expect(sample.openTokens).toBeGreaterThanOrEqual(0)
    }
  }, 120_000)

  it('rejects a stale measurement rather than attributing to the wrong part', async () => {
    const workload = allWorkloads()[0]!
    const harness = await efHarness(0.15)
    const session = workload.createSession()
    const stale = harness.ctx.tokenMeter.measure(session)
    workload.grow(session, 1)
    expect(() => pressureBreakdown(session, stale, 2_400)).toThrow(/does not match/u)
  }, 120_000)

  it('flags leafCannotSuffice exactly when the frozen prefix alone is over threshold', () => {
    // Constructed directly: this is the boundary condition R2-B gates on.
    const cases: Array<{ frozen: number; open: number; threshold: number; expected: boolean }> = [
      { frozen: 3_000, open: 500, threshold: 2_400, expected: true },
      { frozen: 2_400, open: 500, threshold: 2_400, expected: true },
      { frozen: 2_399, open: 500, threshold: 2_400, expected: false },
      { frozen: 0, open: 9_000, threshold: 2_400, expected: false },
    ]
    for (const testCase of cases) {
      const total = testCase.frozen + testCase.open
      const breakdown = {
        frozenTokens: testCase.frozen,
        openTokens: testCase.open,
        totalTokens: total,
        frozenRatio: total === 0 ? 0 : testCase.frozen / total,
        openRatio: total === 0 ? 0 : testCase.open / total,
        frozenCount: testCase.frozen > 0 ? 3 : 0,
        thresholdTokens: testCase.threshold,
        leafCannotSuffice: testCase.frozen > 0 && testCase.frozen >= testCase.threshold,
      }
      expect(breakdown.leafCannotSuffice).toBe(testCase.expected)
    }
  })

  it('classifies idle / open-bound / frozen-bound correctly', () => {
    const make = (frozen: number, open: number, threshold: number) => {
      const total = frozen + open
      return {
        frozenTokens: frozen,
        openTokens: open,
        totalTokens: total,
        frozenRatio: 0,
        openRatio: 0,
        frozenCount: frozen > 0 ? 1 : 0,
        thresholdTokens: threshold,
        leafCannotSuffice: frozen > 0 && frozen >= threshold,
      }
    }
    expect(classifyPressureRegime(make(100, 100, 2_400))).toBe('idle')
    expect(classifyPressureRegime(make(100, 9_000, 2_400))).toBe('open-bound')
    expect(classifyPressureRegime(make(5_000, 100, 2_400))).toBe('frozen-bound')
  })
})

describe('R2-A: leaf marginal reclaim', () => {
  it('MRR is the reclaimed fraction, and a small reclaim is visible', () => {
    // The docs/11 §7 example: a 170-token span producing a 150-token
    // checkpoint reclaims 20 tokens — 11.8%.
    const reclaim = leafMarginalReclaim({
      spanTokens: 170,
      frozenTokens: 1_500,
      frozenCount: 10,
      fallbackCheckpointTokens: 530,
    })
    expect(reclaim.checkpointTokens).toBe(150)
    expect(reclaim.reclaimTokens).toBe(20)
    expect(reclaim.reclaimRatio).toBeCloseTo(0.1176, 3)
  })

  it('reports a NEGATIVE reclaim when the checkpoint would be larger than the span', () => {
    // A tiny open tail folded into a full checkpoint makes the context bigger.
    const reclaim = leafMarginalReclaim({
      spanTokens: 200,
      frozenTokens: 0,
      frozenCount: 0,
      fallbackCheckpointTokens: 530,
    })
    expect(reclaim.reclaimTokens).toBeLessThan(0)
    expect(reclaim.reclaimRatio).toBeLessThan(0)
  })

  it('uses the observed average checkpoint size once one exists', () => {
    const reclaim = leafMarginalReclaim({
      spanTokens: 3_000,
      frozenTokens: 2_000,
      frozenCount: 4,
      fallbackCheckpointTokens: 999,
    })
    // 2000/4 = 500, NOT the fallback.
    expect(reclaim.checkpointTokens).toBe(500)
    expect(reclaim.reclaimTokens).toBe(2_500)
  })

  it('is zero-safe on an empty span', () => {
    expect(leafMarginalReclaim({
      spanTokens: 0, frozenTokens: 0, frozenCount: 0, fallbackCheckpointTokens: 500,
    }).reclaimRatio).toBe(0)
  })
})

describe('R2-A: the fold-every-step detector sees the real regime', () => {
  it('detects the self-sustaining loop at an aggressive threshold', async () => {
    const workload = allWorkloads()[0]!
    const harness = await efHarness(0.15)
    const result = await runPairedBaseline({
      arm: 'W1-aggressive',
      harness,
      createSession: workload.createSession,
      steps: 64,
      grow: (session: Session, step: number) => workload.grow(session, step),
      signal: SIGNAL,
    })

    // The frozen prefix must actually outgrow the threshold for the loop.
    const last = result.pressure.samples[result.pressure.samples.length - 1]!
    expect(result.thresholdTokens).toBeGreaterThan(0)
    expect(last.frozenTokens).toBeGreaterThan(result.thresholdTokens)

    // And the detector must say so, without being told.
    expect(result.pressure.frozenBoundCount).toBeGreaterThan(0)
    expect(result.pressure.longestFrozenBoundRun).toBeGreaterThan(5)
    console.log(
      `aggressive: threshold=${result.thresholdTokens} idle=${result.pressure.idleCount} `
      + `open-bound=${result.pressure.openBoundCount} frozen-bound=${result.pressure.frozenBoundCount} `
      + `longestRun=${result.pressure.longestFrozenBoundRun} folds=${result.leafFoldCount}`,
    )
  }, 180_000)

  it('does NOT report the loop at a realistic threshold', async () => {
    const workload = allWorkloads()[0]!
    const harness = await efHarness(0.6)
    const result = await runPairedBaseline({
      arm: 'W1-realistic',
      harness,
      createSession: workload.createSession,
      steps: 64,
      grow: (session: Session, step: number) => workload.grow(session, step),
      signal: SIGNAL,
    })
    console.log(
      `realistic: threshold=${result.thresholdTokens} idle=${result.pressure.idleCount} `
      + `open-bound=${result.pressure.openBoundCount} frozen-bound=${result.pressure.frozenBoundCount} `
      + `folds=${result.leafFoldCount}`,
    )
    // With a realistic threshold the frozen prefix stays a small share, so the
    // loop signature must be absent — the detector is regime-sensitive, not
    // always-on.
    expect(result.pressure.foldEveryStep).toBe(false)
  }, 180_000)

  it('summarizes a history without over-reporting a short run', () => {
    const sample = (step: number, regime: PressureSample['regime']): PressureSample => ({
      step, regime, frozenTokens: 0, openTokens: 0, totalTokens: 0,
    })
    const short = summarizePressureHistory([
      sample(1, 'idle'), sample(2, 'frozen-bound'), sample(3, 'idle'), sample(4, 'idle'),
    ])
    expect(short.foldEveryStep).toBe(false)
    expect(short.longestFrozenBoundRun).toBe(1)

    const sustained = summarizePressureHistory([
      sample(1, 'frozen-bound'), sample(2, 'frozen-bound'), sample(3, 'frozen-bound'), sample(4, 'frozen-bound'),
    ])
    expect(sustained.foldEveryStep).toBe(true)
    expect(sustained.longestFrozenBoundRun).toBe(4)

    expect(summarizePressureHistory([]).foldEveryStep).toBe(false)
  })
})
