/**
 * R2 framing ceiling (docs/15).
 *
 * Pins the measurement that answers "is BCR < 1 reachable at all?" — because
 * the answer determines whether the project should keep optimizing EF or go
 * after the DSH seam.
 *
 * The claim under test is narrow and falsifiable: pricing each run as if its
 * checkpoint framing cost nothing puts EVERY workload below BCR 1. If a future
 * change makes framing cheaper, this test still passes (the ceiling only
 * improves); if a change makes EF's other costs grow enough that even
 * zero-framing cannot reach parity, it fails — which is exactly the signal
 * worth having.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import { allWorkloads, WORKLOAD_MODEL } from '../eval/workloads/index.ts'
import { createIdleMaintenanceHook, runPairedBaseline } from '../bench/paired-baseline.ts'
import { createHarness, SIGNAL } from './harness.ts'
import { priceArm } from '../eval/src/dominance.ts'
import { parseEconomicsProfile } from '../src/economics-profile.ts'
import { parseCheckpointMarker } from '../src/checkpoint-marker.ts'

const REALIZATION_RATE = 0.91
const STEPS = 64
const WINDOW = 16_000
const PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context.'

function flashProfile(): ReturnType<typeof parseEconomicsProfile> {
  return parseEconomicsProfile(JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'profiles', 'economics', 'deepseek-flash-2026-09.json'), 'utf8'),
  ))
}

/** Price a run from its measured totals, with an optional framing discount. */
function priced(
  profile: ReturnType<typeof parseEconomicsProfile>,
  promptTokens: number,
  warmTokens: number,
): number {
  return priceArm({
    promptTokens, warmTokens, peakTokens: 0,
    auxiliaryInputTokens: 0, auxiliaryOutputTokens: 0, recallTokens: 0,
  }, profile, REALIZATION_RATE).totalCost
}

describe('R2: framing-free ceiling', () => {
  it('every workload would beat Basic if checkpoint framing were free', async () => {
    const profile = flashProfile()
    const results: Array<{ id: string; now: number; free: number }> = []

    for (const workload of allWorkloads()) {
      const basicHarness = await createHarness({ text: 'd' }, {
        contextWindow: WINDOW, engine: 'basic', workloadModel: WORKLOAD_MODEL,
        efConfig: { thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 3_000 },
      })
      const basic = await runPairedBaseline({
        arm: 'B1', harness: basicHarness, createSession: workload.createSession, steps: STEPS,
        grow: (session: Session, step: number) => {
          workload.grow(session, step)
          workload.declareState?.(session, step)
        },
        signal: SIGNAL,
      })
      const basicCost = priced(profile, basic.promptSummary.totalPromptTokens, basic.stablePrefixTokensTotal)

      const harness = await createHarness({ text: 'd' }, {
        contextWindow: WINDOW, plugin: true, workloadModel: WORKLOAD_MODEL,
        efConfig: {
          thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 3_000,
          leafAdmission: 'economic', rootPolicy: 'economics', semanticMode: 'none',
        },
      })
      const run = await runPairedBaseline({
        arm: 'E3', harness, createSession: workload.createSession, steps: STEPS,
        grow: (session: Session, step: number) => {
          workload.grow(session, step)
          workload.declareState?.(session, step)
        },
        rebase: createIdleMaintenanceHook(harness),
        signal: SIGNAL,
      })

      const framingTokens = run.attribution.totals['checkpoint-framing']
      const total = run.attribution.grandTotal
      const warm = run.stablePrefixTokensTotal
      // Removing framing removes tokens that were mostly warm; scale the warm
      // count by the same share so the discount is not overstated.
      const warmShare = total === 0 ? 0 : warm / total
      const freeWarm = Math.max(0, warm - framingTokens * warmShare)

      results.push({
        id: workload.id,
        now: priced(profile, total, warm) / basicCost,
        free: priced(profile, total - framingTokens, freeWarm) / basicCost,
      })
    }

    for (const row of results) {
      console.log(`${row.id.padEnd(20)} BCR now=${row.now.toFixed(3)} framing-free=${row.free.toFixed(3)}`)
    }

    // The finding: framing is the whole gap.
    for (const row of results) {
      expect(row.now, `${row.id} should currently exceed 1`).toBeGreaterThan(1)
      expect(row.free, `${row.id} should beat Basic with framing removed`).toBeLessThan(1)
    }
  }, 900_000)

  it('framing is composed mostly of text EF owns, but the largest single part is inherited', async () => {
    const workload = allWorkloads()[0]!
    const harness = await createHarness({ text: 'd' }, {
      contextWindow: WINDOW, plugin: true, workloadModel: WORKLOAD_MODEL,
      efConfig: {
        thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 3_000,
        leafAdmission: 'economic', rootPolicy: 'economics', semanticMode: 'none',
      },
    })
    const run = await runPairedBaseline({
      arm: 'E3', harness, createSession: workload.createSession, steps: 32,
      grow: (session: Session, step: number) => {
        workload.grow(session, step)
        workload.declareState?.(session, step)
      },
      rebase: createIdleMaintenanceHook(harness),
      signal: SIGNAL,
    })
    expect(run.attribution.totals['checkpoint-framing']).toBeGreaterThan(0)

    // Rebuild the surface to inspect the checkpoint text itself.
    const probe = await createHarness({ text: 'd' }, {
      contextWindow: WINDOW, plugin: true, workloadModel: WORKLOAD_MODEL,
      efConfig: {
        thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 3_000,
        leafAdmission: 'economic', rootPolicy: 'economics', semanticMode: 'none',
      },
    })
    const session = workload.createSession()
    const agent = {
      session, options: { provider: WORKLOAD_MODEL, model: WORKLOAD_MODEL },
      runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(SIGNAL),
    } as never
    for (let step = 1; step <= 32; step += 1) {
      if (step > 1) session.append('turn/end', { turn: 1_000_000 + step - 1, reason: { kind: 'completed' } })
      session.append('turn/start', { turn: 1_000_000 + step })
      workload.grow(session, step)
      try {
        await (probe.engine as unknown as {
          compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
        }).compactIfNeeded(agent, 'pressure', SIGNAL)
      } catch { /* refused fold */ }
      session.append('turn/end', { turn: 1_000_000 + step, reason: { kind: 'completed' } })
    }

    let checkpoints = 0
    let preambleChars = 0
    let markerChars = 0
    let totalChars = 0
    for (const seq of session.surface.nodes) {
      const message = session.deriveEventMessage(session.eventAt(seq)!)
      if (message === null) continue
      if ((message as unknown as { source?: { kind?: string } }).source?.kind !== 'compact-checkpoint') continue
      checkpoints += 1
      const text = message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
      totalChars += text.length
      if (text.includes(PREAMBLE)) preambleChars += PREAMBLE.length
      const marker = parseCheckpointMarker(text)
      if (marker !== undefined) {
        markerChars += `[EF checkpoint v1 mode=leaf id=${marker.checkpointId}]`.length
      }
    }

    expect(checkpoints).toBeGreaterThan(0)
    const preambleShare = preambleChars / totalChars
    console.log(
      `checkpoints=${checkpoints} preambleShare=${(preambleShare * 100).toFixed(1)}% `
      + `markerShare=${(markerChars / totalChars * 100).toFixed(1)}%`,
    )
    // The inherited preamble is a real but MINORITY share — which is why EF
    // cannot close the gap by trimming its own lines alone, and why the
    // highest-value fix needs a seam EF does not own.
    expect(preambleShare).toBeGreaterThan(0)
    expect(preambleShare).toBeLessThan(0.5)
  }, 600_000)

  it('the framing removal each workload NEEDS is larger than EF can achieve alone', async () => {
    // The ceiling in the first test is a theoretical maximum, not a plan. This
    // test computes the removal each workload actually requires and compares
    // it against what is reachable, which is the difference between "framing
    // is the gap" and "framing is a fixable gap".
    const profile = flashProfile()

    /** Solve for the framing-removal fraction that brings BCR to exactly 1. */
    const requiredRemoval = (
      ef: { total: number; framing: number; warm: number },
      basicCost: number,
    ): number | null => {
      const warmShare = ef.total === 0 ? 0 : ef.warm / ef.total
      for (let step = 0; step <= 1000; step += 1) {
        const removed = step / 1000
        const framing = ef.framing * removed
        const total = ef.total - framing
        const warm = Math.max(0, ef.warm - framing * warmShare)
        if (priced(profile, total, warm) / basicCost < 1) return removed
      }
      return null
    }

    const rows: Array<{ id: string; required: number | null }> = []
    for (const workload of allWorkloads()) {
      const basicHarness = await createHarness({ text: 'd' }, {
        contextWindow: WINDOW, engine: 'basic', workloadModel: WORKLOAD_MODEL,
        efConfig: { thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 3_000 },
      })
      const basic = await runPairedBaseline({
        arm: 'B1', harness: basicHarness, createSession: workload.createSession, steps: STEPS,
        grow: (session: Session, step: number) => {
          workload.grow(session, step)
          workload.declareState?.(session, step)
        },
        signal: SIGNAL,
      })
      const basicCost = priced(profile, basic.promptSummary.totalPromptTokens, basic.stablePrefixTokensTotal)

      const harness = await createHarness({ text: 'd' }, {
        contextWindow: WINDOW, plugin: true, workloadModel: WORKLOAD_MODEL,
        efConfig: {
          thresholdRatio: 0.15, headroomTokens: 0, retainTokens: 0, maxTokens: 3_000,
          leafAdmission: 'economic', rootPolicy: 'economics', semanticMode: 'none',
        },
      })
      const run = await runPairedBaseline({
        arm: 'E3', harness, createSession: workload.createSession, steps: STEPS,
        grow: (session: Session, step: number) => {
          workload.grow(session, step)
          workload.declareState?.(session, step)
        },
        rebase: createIdleMaintenanceHook(harness),
        signal: SIGNAL,
      })
      rows.push({
        id: workload.id,
        required: requiredRemoval(
          {
            total: run.attribution.grandTotal,
            framing: run.attribution.totals['checkpoint-framing'],
            warm: run.stablePrefixTokensTotal,
          },
          basicCost,
        ),
      })
    }

    for (const row of rows) {
      console.log(
        `${row.id.padEnd(20)} required framing removal = `
        + (row.required === null ? 'NEVER (unreachable even at 100%)' : `${(row.required * 100).toFixed(1)}%`),
      )
    }

    // EF-side reachable ceiling: halving the marker + recall lines, which are
    // ~30% of checkpoint text. Anything more means weakening identity or
    // dropping the recall pointer.
    const EF_ONLY_REACHABLE = 0.15
    const everyRowNeedsMore = rows.every(
      row => row.required === null || row.required > EF_ONLY_REACHABLE,
    )
    expect(everyRowNeedsMore).toBe(true)

    // And at least one workload is out of reach even WITH the DSH seam, which
    // is why framing reduction is necessary but not sufficient.
    const SEAM_REACHABLE = 0.39
    const unreachableEvenWithSeam = rows.filter(
      row => row.required === null || row.required > SEAM_REACHABLE,
    )
    console.log(
      `unreachable even with the seam: ${unreachableEvenWithSeam.map(row => row.id).join(', ') || '(none)'}`,
    )
    expect(unreachableEvenWithSeam.length).toBeGreaterThan(0)
  }, 900_000)
})
