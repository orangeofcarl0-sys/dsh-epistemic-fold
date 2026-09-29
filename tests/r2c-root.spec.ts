/**
 * R2-C: provider-aware rebase policy and the leaf-refusal handoff.
 *
 * R2-B proved that refusing an uneconomic leaf and stopping is a 1.8x
 * regression: the history that is no longer folded stays on the surface as raw
 * tokens, which cost far more than the framing tax the refusal avoided. R2-C
 * supplies the missing half — the refusal hands off to a rebase, the only
 * mechanism that can actually shrink the frozen prefix.
 *
 * **R3-0c re-baselined these tests onto the production path.** R2-C originally
 * drove the handoff through `createRootRebaseHook()`, a benchmark-local copy of
 * the rebase policy. That made the finding real but made its *measurement*
 * describe "EF engine + benchmark policy". The arms below now mount the real
 * plugin and let ITS idle consumer do the rebase, so the numbers describe the
 * shipped runtime. The finding itself is unchanged: admission + handoff is a
 * large win over legacy.
 */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { allWorkloads, WORKLOAD_MODEL } from '../eval/workloads/index.ts'
import { createIdleMaintenanceHook, runPairedBaseline } from '../bench/paired-baseline.ts'
import type { BaselineResult } from '../bench/paired-baseline.ts'
import { createHarness, SIGNAL } from './harness.ts'
import type { Harness } from './harness.ts'
import { compileContextPolicy } from '../src/policy-compiler.ts'
import { BUILTIN_ECONOMICS_PROFILES, resolveProfile, selectProfile } from '../src/economics-profile.ts'
import { resolveEfConfig } from '../src/policy.ts'

interface Arm {
  readonly label: string
  readonly config: Record<string, unknown>
  readonly rebase: boolean
}

async function runArm(arm: Arm, steps: number, workloadIndex = 0): Promise<BaselineResult> {
  const workload = allWorkloads()[workloadIndex]!
  const harness: Harness = await createHarness({ text: 'ef digest' }, {
    contextWindow: 16_000,
    plugin: true,
    workloadModel: WORKLOAD_MODEL,
    efConfig: {
      thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 3_000,
      ...arm.config,
    },
  })
  return runPairedBaseline({
    arm: arm.label,
    harness,
    createSession: workload.createSession,
    steps,
    grow: (session: Session, step: number) => workload.grow(session, step),
    ...(arm.rebase ? { rebase: createIdleMaintenanceHook(harness) } : {}),
    signal: SIGNAL,
  })
}

const LEGACY: Arm = { label: 'E0-legacy', config: {}, rebase: false }
const ECON_LEAF: Arm = { label: 'E1-econ-leaf', config: { leafAdmission: 'economic' }, rebase: false }
const ECON_ROOT: Arm = {
  label: 'E2-econ-root',
  config: { leafAdmission: 'economic', rootPolicy: 'economics' },
  rebase: true,
}

describe('R2-C: config surface', () => {
  it('defaults to legacy root policy, so nothing changes until the gates pass', () => {
    expect(resolveEfConfig({}).rootPolicy.mode).toBe('legacy')
    expect(resolveEfConfig({}).rootPolicy.profiles.length).toBeGreaterThanOrEqual(4)
  })

  it('rejects an unknown root policy and an out-of-range realization rate', () => {
    expect(() => resolveEfConfig({ rootPolicy: 'nope' as never })).toThrow(/rootPolicy/u)
    expect(() => resolveEfConfig({ cacheRealizationRate: 2 })).toThrow(/cacheRealizationRate/u)
    expect(() => resolveEfConfig({ paybackHorizonRequests: -1 })).toThrow(/paybackHorizonRequests/u)
  })

  it('prices an unroutable model with NO cache rather than inventing a discount', () => {
    // Assuming a cache where none is configured would over-credit every saving.
    const profile = resolveProfile(BUILTIN_ECONOMICS_PROFILES, 'unknown-provider', 'unknown-model')
    expect(profile.cache.mode).toBe('none')
    expect(profile.pricing.inputHitPerM).toBe(profile.pricing.inputMissPerM)
  })

  it('routes a known model to its own profile, without any provider branch', () => {
    expect(selectProfile(BUILTIN_ECONOMICS_PROFILES, 'deepseek', 'deepseek-v4.1-flash')?.id)
      .toBe('deepseek-flash-2026-09')
    expect(selectProfile(BUILTIN_ECONOMICS_PROFILES, 'openai', 'gpt-5.6-turbo')?.id)
      .toBe('openai-gpt-5.6-2024-09'.replace('2024', '2026'))
  })
})

describe('R2-C: the handoff is what fixes R2-B regression', () => {
  it('admission + handoff beats both legacy and admission-alone', async () => {
    const legacy = await runArm(LEGACY, 64)
    const leafOnly = await runArm(ECON_LEAF, 64)
    const withRoot = await runArm(ECON_ROOT, 64)

    console.log(
      `legacy=${legacy.attribution.grandTotal} leaf-only=${leafOnly.attribution.grandTotal} `
      + `econ+root=${withRoot.attribution.grandTotal} (roots=${withRoot.rootFoldCount})`,
    )

    // Admission alone regresses (the R2-B finding, restated here as the
    // baseline this stage must beat).
    expect(leafOnly.attribution.grandTotal).toBeGreaterThan(legacy.attribution.grandTotal)
    // The handoff turns it into a large win.
    expect(withRoot.attribution.grandTotal).toBeLessThan(legacy.attribution.grandTotal)
    // And the rebase actually ran — the gain is not an accounting artifact.
    expect(withRoot.rootFoldCount).toBeGreaterThan(0)
  }, 300_000)

  it('lowers peak context, not just the total', async () => {
    const legacy = await runArm(LEGACY, 64)
    const withRoot = await runArm(ECON_ROOT, 64)
    expect(withRoot.promptSummary.peakPromptTokens).toBeLessThan(legacy.promptSummary.peakPromptTokens)
    console.log(
      `peak: legacy=${legacy.promptSummary.peakPromptTokens} econ+root=${withRoot.promptSummary.peakPromptTokens}`,
    )
  }, 300_000)

  it('shrinks the frozen prefix — the thing a leaf fold cannot do', async () => {
    const legacy = await runArm(LEGACY, 64)
    const withRoot = await runArm(ECON_ROOT, 64)
    expect(withRoot.finalCheckpointLoad).toBeLessThan(legacy.finalCheckpointLoad)
    console.log(
      `final frozen load: legacy=${legacy.finalCheckpointLoad} econ+root=${withRoot.finalCheckpointLoad}`,
    )
  }, 300_000)

  it('keeps attribution reconciling and pressure decomposing exactly', async () => {
    const withRoot = await runArm(ECON_ROOT, 32)
    expect(withRoot.attribution.grandTotal).toBe(withRoot.promptSummary.totalPromptTokens)
    for (const sample of withRoot.pressure.samples) {
      expect(sample.frozenTokens + sample.openTokens).toBe(sample.totalTokens)
    }
  }, 300_000)
})

describe('R2-C: overrides never demand an impossible action', () => {
  it('demands a rebase, not a leaf, when no leaf can restore headroom', () => {
    const base = {
      economics: BUILTIN_ECONOMICS_PROFILES[0]!,
      telemetry: {
        frozenTokens: 40_000, frozenCheckpointCount: 10,
        rawTailTokens: 1_000, promptTokens: 41_000, recentFoldCadence: 100,
      },
      pressure: { contextWindow: 100_000, currentTokens: 95_000 },
    }
    // With a leaf available the pressure override demands a leaf...
    const withLeaf = compileContextPolicy({
      ...base,
      policy: { paybackHorizonRequests: 200, pressureRatio: 0.8, leafAvailable: true },
    })
    expect(withLeaf.action).toBe('leaf')
    // ...but when the caller has established that no leaf can help, demanding
    // one would restate the fold-every-step loop as policy.
    const withoutLeaf = compileContextPolicy({
      ...base,
      policy: { paybackHorizonRequests: 200, pressureRatio: 0.8, leafAvailable: false },
    })
    expect(withoutLeaf.action).toBe('root')
    expect(withoutLeaf.overridden).toBe(true)
    expect(withoutLeaf.reason).toContain('rebase is required')
  })

  it('still refuses to select the rejected Delta Leaf representation', () => {
    const decision = compileContextPolicy({
      economics: BUILTIN_ECONOMICS_PROFILES[0]!,
      telemetry: {
        frozenTokens: 40_000, frozenCheckpointCount: 10,
        rawTailTokens: 1_000, promptTokens: 41_000, recentFoldCadence: 100,
      },
      pressure: { contextWindow: 100_000, currentTokens: 95_000 },
      policy: { paybackHorizonRequests: 200, pressureRatio: 0.8, leafAvailable: false },
    })
    expect(decision.leafRepresentation).toBe('snapshot')
  })
})
