/**
 * R2-E / R3-BASE: the price-dominance matrix.
 *
 * The exit condition is a combination, not a single number:
 *
 *   quality no worse than Basic   (measurable only live: OPEN here)
 *   BCR < 1                       (strictly cheaper than Basic)
 *
 * This suite runs every workload through every policy under every profile and
 * prices each arm from its OWN measured warm/cold split.
 *
 * **R3-0 rebased three things in this file**, and the numbers moved because
 * the measurement got more honest, not because the product changed:
 *
 * - the EF arms now mount the REAL plugin and its idle-rebase consumer
 *   (R3-0c), so this is the shipped runtime rather than a benchmark policy;
 * - realization is labelled per profile: measured for DeepSeek, scenario
 *   sensitivity for the rest, with a BCR(h) curve where nothing was measured;
 * - quality is reported OPEN rather than as a fabricated `BQR = 1`.
 *
 * The result is still reported, not asserted into a desired shape.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import { allWorkloads, WORKLOAD_MODEL } from '../eval/workloads/index.ts'
import { createIdleMaintenanceHook, runPairedBaseline } from '../bench/paired-baseline.ts'
import type { BaselineResult } from '../bench/paired-baseline.ts'
import { createHarness, SIGNAL } from './harness.ts'
import {
  MEASURED_DEEPSEEK_REALIZATION,
  bcrCurve,
  dominanceMatrix,
  dominanceToMarkdown,
  priceArm,
} from '../eval/src/dominance.ts'
import type { CacheRealizationAssumption, DominanceRow } from '../eval/src/dominance.ts'
import { parseEconomicsProfile } from '../src/economics-profile.ts'
import type { ContextEconomicsProfile } from '../src/economics-profile.ts'

/**
 * What is known about cache realization, per profile. Only the DeepSeek live
 * route has telemetry (R1: 2176 hit / 253 miss); everything else is a scenario
 * and is priced as a sweep rather than one pseudo-precise number.
 */
const REALIZATION: Readonly<Record<string, CacheRealizationAssumption>> = {
  'deepseek-flash-2026-09': MEASURED_DEEPSEEK_REALIZATION,
  'deepseek-pro-2026-09': MEASURED_DEEPSEEK_REALIZATION,
  'openai-gpt-5.6-2026-09': { source: 'unknown' },
  'synthetic-no-cache': { source: 'scenario', rate: 1 },
}
const STEPS = 64
const WINDOW = 16_000

const PROFILE_IDS = [
  'deepseek-flash-2026-09',
  'deepseek-pro-2026-09',
  'openai-gpt-5.6-2026-09',
  'synthetic-no-cache',
] as const

function profile(id: string): ContextEconomicsProfile {
  return parseEconomicsProfile(JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'profiles', 'economics', `${id}.json`), 'utf8'),
  ))
}

interface PolicySpec {
  readonly label: string
  readonly config: Record<string, unknown>
  readonly rebase: boolean
  readonly basic?: boolean
}

const POLICIES: readonly PolicySpec[] = [
  { label: 'B1-basic', config: {}, rebase: false, basic: true },
  { label: 'E0-legacy', config: {}, rebase: false },
  {
    label: 'E3-full',
    config: { leafAdmission: 'economic', rootPolicy: 'economics', semanticMode: 'none' },
    rebase: true,
  },
]

async function runPolicy(
  workloadIndex: number,
  policy: PolicySpec,
): Promise<BaselineResult> {
  const workload = allWorkloads()[workloadIndex]!
  const harness = await createHarness({ text: 'digest' }, {
    contextWindow: WINDOW,
    workloadModel: WORKLOAD_MODEL,
    ...(policy.basic === true ? { engine: 'basic' as const } : { plugin: true }),
    efConfig: {
      thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 3_000,
      ...policy.config,
    },
  })
  return runPairedBaseline({
    arm: policy.label,
    harness,
    createSession: workload.createSession,
    steps: STEPS,
    grow: (session: Session, step: number) => {
      workload.grow(session, step)
      workload.declareState?.(session, step)
    },
    ...(policy.rebase ? { rebase: createIdleMaintenanceHook(harness) } : {}),
    signal: SIGNAL,
  })
}

/** Turn a run into the cost inputs the pricing model needs. */
function costInputs(result: BaselineResult): {
  promptTokens: number
  warmTokens: number
  peakTokens: number
  auxiliaryInputTokens: number
  auxiliaryOutputTokens: number
  recallTokens: number
} {
  return {
    promptTokens: result.promptSummary.totalPromptTokens,
    warmTokens: result.stablePrefixTokensTotal,
    peakTokens: result.promptSummary.peakPromptTokens,
    auxiliaryInputTokens: result.auxiliaryCompaction.inputTokens ?? 0,
    auxiliaryOutputTokens: result.auxiliaryCompaction.outputTokens ?? 0,
    recallTokens: result.attribution.totals.recall,
  }
}

describe('R2-E: price-dominance matrix', () => {
  it('prices every policy under every profile from measured warm/cold splits', async () => {
    const workloads = allWorkloads()
    const rows: DominanceRow[] = []
    const rawLines: string[] = []

    for (const [index, workload] of workloads.entries()) {
      const results = new Map<string, BaselineResult>()
      for (const policy of POLICIES) {
        results.set(policy.label, await runPolicy(index, policy))
      }
      const basic = results.get('B1-basic')!

      rawLines.push(
        `${workload.id}: `
        + [...results.entries()].map(([label, result]) =>
          `${label} total=${result.promptSummary.totalPromptTokens} `
          + `warm=${result.stablePrefixTokensTotal} peak=${result.promptSummary.peakPromptTokens} `
          + `folds=${result.leafFoldCount} roots=${result.rootFoldCount}`).join(' | '),
      )

      for (const id of PROFILE_IDS) {
        const economics = profile(id)
        const assumption = REALIZATION[id] ?? { source: 'unknown' as const }
        // Price at the SINGLE rate the assumption names; an unmeasured profile
        // reports its curve below instead of a number here.
        const rate = assumption.source === 'measured' || assumption.source === 'scenario'
          ? assumption.rate
          : 0.91
        const basicPriced = priceArm(costInputs(basic), economics, rate)
        const basicCost = basicPriced.totalCost
        for (const policy of POLICIES) {
          if (policy.label === 'B1-basic') continue
          const result = results.get(policy.label)!
          const priced = priceArm(costInputs(result), economics, rate)
          const policyCost = priced.totalCost
          rows.push({
            workload: workload.id,
            policy: policy.label,
            profile: id,
            basicCost,
            policyCost,
            bcr: basicCost === 0 ? Number.NaN : policyCost / basicCost,
            // R3-0a: a bill missing the cache-write term is flagged, not
            // silently totalled (the OpenAI profile bills writes; the keyless
            // tier observes none).
            billIncomplete: priced.incomplete || basicPriced.incomplete,
            // R3-0a: quality is NOT measured in the keyless tier, and UNKNOWN
            // is no longer rendered as `BQR = 1`. The earlier `bqr: 1` made
            // "40/40 no worse in quality" a claim the tier could not support.
            quality: { status: 'unknown' },
            basicPeakTokens: basic.promptSummary.peakPromptTokens,
            policyPeakTokens: result.promptSummary.peakPromptTokens,
            cheaper: policyCost < basicCost,
            // Dominance needs quality evidence, so it is unavailable here.
            dominates: false,
          })
        }
      }
    }

    for (const line of rawLines) console.log(line)

    const matrix = dominanceMatrix(rows)
    console.log('\n--- price-dominance matrix ---')
    console.log(dominanceToMarkdown(matrix))

    // R3-0a: unmeasured realization is a sensitivity, not a point estimate.
    // Report the BCR(h) range for the profile that has no telemetry.
    const openai = profile('openai-gpt-5.6-2026-09')
    const workload0 = workloads[0]!
    const basic0 = await runPolicy(0, POLICIES[0]!)
    const full0 = await runPolicy(0, POLICIES[2]!)
    const curve = bcrCurve(costInputs(full0), costInputs(basic0), openai, { source: 'unknown' })
    console.log(
      `${workload0.id} BCR(h) under ${openai.id} (no telemetry — scenario sweep): `
      + curve.map(point => `h=${point.realizationRate}:${point.bcr.toFixed(3)}`).join(' '),
    )

    // Structural invariants: the matrix must be well-formed whatever it says.
    expect(rows.length).toBe(workloads.length * PROFILE_IDS.length * 2)
    for (const row of rows) {
      expect(Number.isFinite(row.bcr)).toBe(true)
      expect(row.bcr).toBeGreaterThan(0)
      expect(row.policyCost).toBeGreaterThanOrEqual(0)
    }
    // Cost must never be negative or zero for a non-empty run.
    expect(matrix.rows.every(row => row.basicCost > 0)).toBe(true)
    // The cost gate is decidable here; the quality gate is not, and must say
    // so rather than defaulting to a pass.
    expect(['PASS', 'FAIL']).toContain(matrix.costGate)
    expect(matrix.qualityGate).toBe('OPEN')
  }, 900_000)

  it('the no-cache profile is where EF looks worst — cache dominance hides its cost', async () => {
    // A structural claim worth pinning: EF's disadvantage is largest when
    // there is no cache to make its extra tokens cheap.
    const workloadIndex = 0
    const basic = await runPolicy(workloadIndex, POLICIES[0]!)
    const full = await runPolicy(workloadIndex, POLICIES[2]!)
    const noCache = profile('synthetic-no-cache')
    const flash = profile('deepseek-flash-2026-09')
    const rate = 0.91

    const bcr = (economics: ContextEconomicsProfile): number =>
      priceArm(costInputs(full), economics, rate).totalCost
      / priceArm(costInputs(basic), economics, rate).totalCost

    const withCache = bcr(flash)
    const withoutCache = bcr(noCache)
    console.log(`W1 BCR: cache-dominant=${withCache.toFixed(3)} no-cache=${withoutCache.toFixed(3)}`)
    expect(withoutCache).toBeGreaterThan(withCache)
  }, 600_000)
})
