/**
 * R2-B: economic leaf admission.
 *
 * This is the first R2 stage that CHANGES behavior, so the tests carry two
 * jobs: prove each refusal reason fires for the right cause, and prove the
 * measurable consequence — that `economic` admission actually breaks the
 * fold-every-step loop R2-A quantified, rather than merely declining a fold.
 *
 * The correctness posture is unchanged: admission can only make EF fold LESS,
 * never fold something a `legacy` run would have refused on structural
 * grounds, so the R0/R1 hard gates stay intact.
 */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { efOwnedConfigKeys, resolveEfConfig } from '../src/policy.ts'
import { allWorkloads, WORKLOAD_MODEL } from '../eval/workloads/index.ts'
import { runPairedBaseline } from '../bench/paired-baseline.ts'
import type { BaselineResult } from '../bench/paired-baseline.ts'
import { createHarness, SIGNAL } from './harness.ts'
import type { Harness } from './harness.ts'

async function harnessFor(admission: 'legacy' | 'economic', thresholdRatio: number): Promise<Harness> {
  return createHarness({ text: 'ef digest' }, {
    contextWindow: 16_000,
    projection: true,
    workloadModel: WORKLOAD_MODEL,
    efConfig: {
      thresholdRatio,
      headroomTokens: 0,
      retainTokens: 0,
      maxTokens: 3_000,
      leafAdmission: admission,
    },
  })
}

async function runW1(harness: Harness, steps: number): Promise<BaselineResult> {
  const workload = allWorkloads()[0]!
  return runPairedBaseline({
    arm: 'W1',
    harness,
    createSession: workload.createSession,
    steps,
    grow: (session: Session, step: number) => workload.grow(session, step),
    signal: SIGNAL,
  })
}

describe('R2-B: config surface', () => {
  it('defaults to legacy so nothing changes until the R2 gates pass', () => {
    const resolved = resolveEfConfig({})
    expect(resolved.leafAdmission).toBe('legacy')
    expect(resolved.minReclaimTokens).toBeGreaterThan(0)
    expect(resolved.minReclaimRatio).toBeGreaterThan(0)
  })

  it('rejects an unknown admission mode and out-of-range floors', () => {
    expect(() => resolveEfConfig({ leafAdmission: 'nope' as never })).toThrow(/leafAdmission/u)
    expect(() => resolveEfConfig({ minReclaimTokens: -1 })).toThrow(/minReclaimTokens/u)
    expect(() => resolveEfConfig({ minReclaimRatio: 1.5 })).toThrow(/minReclaimRatio/u)
  })

  it('every EF-owned key is stripped before Basic sees the config', () => {
    // A regression guard: R0 had a real bug where an EF key leaked into
    // Basic's strict validation and would have thrown in production.
    const keys = efOwnedConfigKeys()
    expect(keys).toContain('leafAdmission')
    expect(keys).toContain('minReclaimTokens')
    expect(keys).toContain('minReclaimRatio')
    expect(keys).toContain('semanticMode')
    expect(keys).toContain('bundleRoot')
    expect(keys).toContain('frozenCheckpointTokenBudget')
    // The two experimental switches are EF-owned too, and must not reach Basic.
    expect(keys).toContain('referentialArchive')
    expect(keys).toContain('allowCrossSessionRecall')
    // Constructing with every EF key set must not throw.
    expect(() => resolveEfConfig({
      leafAdmission: 'economic',
      minReclaimTokens: 100,
      minReclaimRatio: 0.1,
      semanticMode: 'none',
      bundleRoot: '/tmp/x',
      frozenCheckpointTokenBudget: 1_000,
      referentialArchive: true,
      allowCrossSessionRecall: true,
    })).not.toThrow()
  })

  it('both experimental switches default OFF', () => {
    // Default-off is the whole safety story: enabling either one moves a
    // failure mode, so an unconfigured deployment must not get it by accident.
    const resolved = resolveEfConfig({})
    expect(resolved.referentialArchive).toBe(false)
    expect(resolved.allowCrossSessionRecall).toBe(false)
  })

  it('the experimental switches are strict booleans', () => {
    // A typo like `referentialArchive: "true"` must fail loudly rather than
    // silently reading as enabled.
    expect(() => resolveEfConfig({ referentialArchive: 'true' as never }))
      .toThrow(/referentialArchive must be a boolean/u)
    expect(() => resolveEfConfig({ allowCrossSessionRecall: 1 as never }))
      .toThrow(/allowCrossSessionRecall must be a boolean/u)
  })

  it('a preset tier does not turn the experiments on', () => {
    // The tiers fill policy keys; they must never enable an experimental
    // storage mode, or picking `economy` would change how bundles are written.
    for (const mode of ['economy', 'balanced', 'quality', 'legacy'] as const) {
      const resolved = resolveEfConfig({ mode })
      expect(resolved.referentialArchive, `${mode} must not enable referentialArchive`).toBe(false)
      expect(resolved.allowCrossSessionRecall, `${mode} must not enable cross-session`).toBe(false)
    }
  })
})

describe('R2-B: economic admission breaks the fold-every-step loop', () => {
  it('folds far less often than legacy at an aggressive threshold', async () => {
    const legacy = await runW1(await harnessFor('legacy', 0.15), 64)
    const economic = await runW1(await harnessFor('economic', 0.15), 64)

    console.log(
      `legacy: folds=${legacy.leafFoldCount} tokens=${legacy.attribution.grandTotal} `
      + `frozen-bound=${legacy.pressure.frozenBoundCount}`,
    )
    console.log(
      `economic: folds=${economic.leafFoldCount} tokens=${economic.attribution.grandTotal} `
      + `frozen-bound=${economic.pressure.frozenBoundCount}`,
    )

    // The loop signature is present in the legacy run...
    expect(legacy.pressure.frozenBoundCount).toBeGreaterThan(0)
    // ...and the economic run folds strictly less, which is the whole point.
    expect(economic.leafFoldCount).toBeLessThan(legacy.leafFoldCount)
  }, 300_000)

  it('admission ALONE regresses token totals — refusing to fold leaves raw history', async () => {
    // A measured negative result, recorded deliberately because it is the
    // reason R2-C exists.
    //
    // Economic admission cuts folds 50 -> 16, which removes most of the
    // framing tax (175K -> 94K tokens). But the history that is no longer
    // folded stays on the surface as RAW tokens, which cost far more
    // (35K -> 320K). The net is a large regression.
    //
    // So "stop folding pointlessly" is NOT a fix by itself: when a leaf is
    // refused because the frozen prefix is over threshold, the correct
    // follow-up is a REBASE (which actually shrinks that prefix), not
    // inaction. R2-C wires exactly that handoff; this test pins the baseline
    // that R2-C must beat.
    const legacy = await runW1(await harnessFor('legacy', 0.15), 64)
    const economic = await runW1(await harnessFor('economic', 0.15), 64)

    const legacyRaw = legacy.attribution.totals['raw-user'] + legacy.attribution.totals['raw-assistant']
    const economicRaw = economic.attribution.totals['raw-user'] + economic.attribution.totals['raw-assistant']
    console.log(
      `admission alone: folds ${legacy.leafFoldCount}->${economic.leafFoldCount}, `
      + `framing ${legacy.attribution.totals['checkpoint-framing']}->${economic.attribution.totals['checkpoint-framing']}, `
      + `raw ${legacyRaw}->${economicRaw}, `
      + `total ${legacy.attribution.grandTotal}->${economic.attribution.grandTotal}`,
    )

    // The framing tax really does fall...
    expect(economic.attribution.totals['checkpoint-framing'])
      .toBeLessThan(legacy.attribution.totals['checkpoint-framing'])
    // ...but raw history rises by more, so the total regresses.
    expect(economicRaw).toBeGreaterThan(legacyRaw)
    expect(economic.attribution.grandTotal).toBeGreaterThan(legacy.attribution.grandTotal)
  }, 300_000)

  it('does not change behavior at a realistic threshold, where no loop exists', async () => {
    // Admission must be a targeted fix, not a blanket reduction: with a
    // realistic threshold there is no frozen-bound regime, so the two modes
    // should agree.
    const legacy = await runW1(await harnessFor('legacy', 0.6), 64)
    const economic = await runW1(await harnessFor('economic', 0.6), 64)
    console.log(`realistic: legacy folds=${legacy.leafFoldCount} economic folds=${economic.leafFoldCount}`)
    expect(economic.leafFoldCount).toBe(legacy.leafFoldCount)
  }, 300_000)

  it('keeps every correctness invariant: attribution still reconciles', async () => {
    const economic = await runW1(await harnessFor('economic', 0.15), 32)
    expect(economic.attribution.grandTotal).toBe(economic.promptSummary.totalPromptTokens)
    // Pressure decomposition remains exact under the new policy.
    for (const sample of economic.pressure.samples) {
      expect(sample.frozenTokens + sample.openTokens).toBe(sample.totalTokens)
    }
  }, 300_000)
})

describe('R2-B: admission refusals are attributable', () => {
  it('reports the frozen-prefix refusal with the measured numbers', async () => {
    // Drive the engine directly so the verdict is observable rather than
    // inferred from fold counts.
    const workload = allWorkloads()[0]!
    const harness = await harnessFor('economic', 0.15)
    const session = workload.createSession()
    const agent = {
      session,
      options: { provider: WORKLOAD_MODEL, model: WORKLOAD_MODEL },
    } as never

    let sawFrozenRefusal = false
    let sawAdmission = false
    for (let step = 1; step <= 64; step += 1) {
      if (step > 1) session.append('turn/end', { turn: 1_000_000 + step - 1, reason: { kind: 'completed' } })
      session.append('turn/start', { turn: 1_000_000 + step })
      workload.grow(session, step)
      try {
        await (harness.engine as unknown as {
          compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
        }).compactIfNeeded(agent, 'pressure', SIGNAL)
      } catch {
        // A refusal is a legitimate null result, not a failure.
      }
      const verdict = harness.engine.lastLeafAdmission
      if (verdict?.reason === 'frozen_prefix_over_threshold') {
        sawFrozenRefusal = true
        expect(verdict.detail).toMatch(/frozen prefix \d+ >= threshold \d+/u)
      }
      if (verdict?.admitted === true) sawAdmission = true
      session.append('turn/end', { turn: 1_000_000 + step, reason: { kind: 'completed' } })
    }

    // Both outcomes must be reachable: early folds are worth doing, later ones
    // are refused because the frozen prefix took over the pressure budget.
    expect(sawAdmission).toBe(true)
    expect(sawFrozenRefusal).toBe(true)
  }, 300_000)
})
