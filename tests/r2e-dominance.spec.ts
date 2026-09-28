/**
 * R2-E: the price-dominance matrix.
 *
 * R2's exit condition is a combination, not a single number:
 *
 *   BQR >= 1 - ε   (quality no worse than Basic)
 *   BCR < 1        (strictly cheaper than Basic)
 *
 * This suite runs every workload through every policy under every profile and
 * prices each arm from its OWN measured warm/cold split, using the measured
 * cache realization h = 0.910 (R1 live) rather than the assumed 1.0.
 *
 * The result is reported, not asserted into a desired shape: whether EF
 * actually dominates Basic is the finding, and a null or negative finding is
 * recorded as such.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import { allWorkloads, WORKLOAD_MODEL } from '../eval/workloads/index.ts'
import { createRootRebaseHook, runPairedBaseline } from '../bench/paired-baseline.ts'
import type { BaselineResult } from '../bench/paired-baseline.ts'
import { createHarness, SIGNAL } from './harness.ts'
import { dominanceMatrix, dominanceToMarkdown, priceArm } from '../eval/src/dominance.ts'
import type { DominanceRow } from '../eval/src/dominance.ts'
import { parseEconomicsProfile } from '../src/economics-profile.ts'
import type { ContextEconomicsProfile } from '../src/economics-profile.ts'

/** Measured on the live route (R1): 2176 hit / 253 miss on a stable prefix. */
const REALIZATION_RATE = 0.91
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
    ...(policy.basic === true ? { engine: 'basic' as const } : { projection: true }),
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
    ...(policy.rebase ? { rebase: createRootRebaseHook(harness) } : {}),
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
        const basicCost = priceArm(costInputs(basic), economics, REALIZATION_RATE).totalCost
        for (const policy of POLICIES) {
          if (policy.label === 'B1-basic') continue
          const result = results.get(policy.label)!
          const policyCost = priceArm(costInputs(result), economics, REALIZATION_RATE).totalCost
          rows.push({
            workload: workload.id,
            policy: policy.label,
            profile: id,
            basicCost,
            policyCost,
            bcr: basicCost === 0 ? Number.NaN : policyCost / basicCost,
            // Quality is not measurable in the keyless tier. R1's live tier
            // found EF 32/32 vs Basic 31/32 (a null result), so BQR is held at
            // 1.0 here and the report says so explicitly rather than implying
            // a measured quality advantage.
            bqr: 1,
            basicPeakTokens: basic.promptSummary.peakPromptTokens,
            policyPeakTokens: result.promptSummary.peakPromptTokens,
            dominates: policyCost < basicCost,
          })
        }
      }
    }

    for (const line of rawLines) console.log(line)

    const matrix = dominanceMatrix(rows)
    console.log('\n--- price-dominance matrix ---')
    console.log(dominanceToMarkdown(matrix))

    // Structural invariants: the matrix must be well-formed whatever it says.
    expect(rows.length).toBe(workloads.length * PROFILE_IDS.length * 2)
    for (const row of rows) {
      expect(Number.isFinite(row.bcr)).toBe(true)
      expect(row.bcr).toBeGreaterThan(0)
      expect(row.policyCost).toBeGreaterThanOrEqual(0)
    }
    // Cost must never be negative or zero for a non-empty run.
    expect(matrix.rows.every(row => row.basicCost > 0)).toBe(true)
  }, 900_000)

  it('the no-cache profile is where EF looks worst — cache dominance hides its cost', async () => {
    // A structural claim worth pinning: EF's disadvantage is largest when
    // there is no cache to make its extra tokens cheap.
    const workloadIndex = 0
    const basic = await runPolicy(workloadIndex, POLICIES[0]!)
    const full = await runPolicy(workloadIndex, POLICIES[2]!)
    const noCache = profile('synthetic-no-cache')
    const flash = profile('deepseek-flash-2026-09')

    const bcr = (economics: ContextEconomicsProfile): number =>
      priceArm(costInputs(full), economics, REALIZATION_RATE).totalCost
      / priceArm(costInputs(basic), economics, REALIZATION_RATE).totalCost

    const withCache = bcr(flash)
    const withoutCache = bcr(noCache)
    console.log(`W1 BCR: cache-dominant=${withCache.toFixed(3)} no-cache=${withoutCache.toFixed(3)}`)
    expect(withoutCache).toBeGreaterThan(withCache)
  }, 600_000)
})
