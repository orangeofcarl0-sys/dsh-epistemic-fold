/**
 * R3: the deterministic span-economics matrix.
 *
 * Admission prices `selectLeafSpan(..., 0, ...)` (the widest legal span);
 * execution folds `selectLeafSpan(..., spec.retainTokens, ...)` (a suffix of
 * it). This matrix crosses admission mode, retention and framing with a
 * checkpoint body of a chosen size, and records both spans on the SAME
 * measurement, plus the engine's own outcome.
 *
 * It is keyless: the controlled adapter returns the chosen checkpoint text and
 * no provider is contacted. The artifact is `eval/r3/out/span-economics.json`;
 * the test writes it and then asserts only the structural invariants.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { createHarness, MODEL, SIGNAL } from './harness.ts'
import { probeLeafSpans } from '../src/policy/leaf-span-probe.ts'

const CONTEXT_WINDOW = 16_384
const MAX_TOKENS = 3_000
const MESSAGE_BUDGET = CONTEXT_WINDOW - MAX_TOKENS
const THRESHOLD = Math.floor(Math.min(CONTEXT_WINDOW * 0.5, MESSAGE_BUDGET - 512))
const MIN_RECLAIM_TOKENS = 600
const MIN_RECLAIM_RATIO = 0.25

const RETAIN_RATIOS = [0.04, 0.16, 0.24]
const ADMISSIONS = ['economic', 'legacy'] as const
const FRAMINGS = ['legacy', 'system-dedup'] as const
const CHECKPOINT_TOKENS = [180, 300, 500, 1_000, 2_000]

function buildSession(turns = 24, chars = 1_000): Session {
  const session = Session.create(SessionId(`span-${turns}-${chars}-${Math.random()}`))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    header: { config: { provider: MODEL, model: MODEL } },
    reason: 'initial',
  })
  for (let turn = 1; turn <= turns; turn += 1) {
    if (turn > 1) session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'u'.repeat(chars) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'a'.repeat(chars) }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  // Leave the last turn OPEN: automatic compaction refuses to append its
  // transaction events outside a turn. This is the same shape the reachability
  // fixture uses, and it is what makes the fold attempt legal.
  session.append('turn/start', { turn: turns + 1 })
  session.append('step/start', { turn: turns + 1, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'v'.repeat(chars) }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return session
}

function distribution(values: number[]): {
  count: number
  min: number | null
  median: number | null
  max: number | null
} {
  if (values.length === 0) return { count: 0, min: null, median: null, max: null }
  const sorted = [...values].sort((left, right) => left - right)
  const mid = Math.floor(sorted.length / 2)
  const midValue = sorted[mid] ?? null
  const beforeMid = sorted[mid - 1] ?? null
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    median: midValue === null
      ? null
      : sorted.length % 2 === 1 ? midValue : Math.round(((beforeMid ?? midValue) + midValue) / 2),
    max: sorted[sorted.length - 1] ?? null,
  }
}

describe('R3 span economics', () => {
  it('runs the deterministic matrix and writes the artifact', async () => {
    // The matrix is intentionally heterogeneous; the artifact is the typed
    // surface and the structural assertions below pin the fields that matter.
    const cases: any[] = []
    for (const admission of ADMISSIONS) {
      for (const retainRatio of RETAIN_RATIOS) {
        for (const framing of FRAMINGS) {
          for (const checkpointTokens of CHECKPOINT_TOKENS) {
            const retainTokens = Math.floor(MESSAGE_BUDGET * retainRatio)
            const checkpointChars = checkpointTokens * 4
            const harness = await createHarness({ text: 'x'.repeat(checkpointChars) }, {
              contextWindow: CONTEXT_WINDOW,
              leafSpanProbe: true,
              ...(framing === 'system-dedup' ? { systemPrompt: true } : {}),
              efConfig: {
                auto: false,
                thresholdRatio: 0.5,
                headroomTokens: 512,
                retainRatio,
                maxTokens: MAX_TOKENS,
                compactionRetries: 0,
                semanticMode: 'none',
                leafAdmission: admission,
                ...(admission === 'economic' ? { rootPolicy: 'economics' as const } : {}),
                framingMode: framing,
              },
            })
            const session = buildSession()
            const measurement = harness.ctx.tokenMeter.measure(session)
            const direct = probeLeafSpans({
              session,
              measurement,
              retainTokens,
              thresholdTokens: THRESHOLD,
              minReclaimTokens: MIN_RECLAIM_TOKENS,
              minReclaimRatio: MIN_RECLAIM_RATIO,
            })
            const agent = {
              session,
              options: { provider: MODEL, model: MODEL },
              runMaintenance: <T,>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(SIGNAL),
            } as never
            let outcome = 'returned'
            let error: string | null = null
            try {
              const result = await (harness.engine as unknown as {
                compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
              }).compactIfNeeded(agent, 'pressure', SIGNAL)
              outcome = result === null ? 'returned-null' : 'returned-result'
            } catch (caught) {
              outcome = 'threw'
              error = caught instanceof Error ? caught.message : String(caught)
            }
            const engineProbe = harness.engine.lastLeafSpanProbe
            const admissionVerdict = harness.engine.lastLeafAdmission
            cases.push({
              caseId: `${admission}-r${retainRatio}-${framing}-c${checkpointTokens}`,
              admission,
              retainRatio,
              retainTokens,
              framing,
              checkpointTokensRequested: checkpointTokens,
              checkpointChars,
              measurementTotalTokens: measurement.totalTokens,
              directProbe: {
                widestTokens: direct.widest?.tokens ?? null,
                executedTokens: direct.executed?.tokens ?? null,
                gapTokens: direct.gapTokens,
                estimatedCheckpointTokens: direct.estimatedCheckpointTokens,
                admissionWouldAdmit: direct.admissionWouldAdmit,
                admissionReason: direct.admissionReason,
                executionWouldAdmit: direct.executionWouldAdmit,
                executionReason: direct.executionReason,
                falseAdmission: direct.falseAdmission,
                expectedReclaimTokens: direct.expectedReclaimTokens,
                executedExpectedReclaimTokens: direct.executedExpectedReclaimTokens,
                probeError: direct.probeError ?? null,
              },
              engine: {
                outcome,
                error,
                admission: admissionVerdict === undefined ? null : {
                  admitted: admissionVerdict.admitted,
                  reason: admissionVerdict.reason ?? null,
                  reclaim: admissionVerdict.reclaim ?? null,
                },
                probe: engineProbe ?? null,
              },
            })
            await harness.ctx.fiber.dispose()
          }
        }
      }
    }

    // Floor sensitivity: at the DEFAULT floors the large spans clear both
    // sides, so the gap is real but does not flip the verdict. Set the floor
    // between the two reclaims and the same gap does exactly that. This is the
    // "admitted on the widest span, uneconomic on the executed span" case.
    const floorSensitivity = []
    for (const retainRatio of RETAIN_RATIOS) {
      const retainTokens = Math.floor(MESSAGE_BUDGET * retainRatio)
      const harness = await createHarness({ text: 'x'.repeat(500 * 4) }, {
        contextWindow: CONTEXT_WINDOW,
        efConfig: {
          auto: false,
          thresholdRatio: 0.5,
          headroomTokens: 512,
          retainRatio,
          maxTokens: MAX_TOKENS,
          compactionRetries: 0,
          semanticMode: 'none',
          leafAdmission: 'economic',
          rootPolicy: 'economics',
        },
      })
      const session = buildSession()
      const measurement = harness.ctx.tokenMeter.measure(session)
      const base = probeLeafSpans({
        session,
        measurement,
        retainTokens,
        thresholdTokens: THRESHOLD,
        minReclaimTokens: 0,
        minReclaimRatio: 0,
      })
      const executedReclaim = base.executedExpectedReclaimTokens ?? 0
      const widestReclaim = base.expectedReclaimTokens ?? 0
      const floor = executedReclaim + 1
      const sensitive = probeLeafSpans({
        session,
        measurement,
        retainTokens,
        thresholdTokens: THRESHOLD,
        minReclaimTokens: floor,
        minReclaimRatio: 0,
      })
      floorSensitivity.push({
        retainRatio,
        retainTokens,
        widestReclaim,
        executedReclaim,
        floor,
        widestTokens: base.widest?.tokens ?? null,
        executedTokens: base.executed?.tokens ?? null,
        gapTokens: base.gapTokens,
        admissionWouldAdmit: sensitive.admissionWouldAdmit,
        executionWouldAdmit: sensitive.executionWouldAdmit,
        falseAdmission: sensitive.falseAdmission,
      })
      await harness.ctx.fiber.dispose()
    }

    const summary = {
      cases: cases.length,
      admissions: ADMISSIONS.length,
      framings: FRAMINGS.length,
      retainRatios: RETAIN_RATIOS,
      checkpointTokens: CHECKPOINT_TOKENS,
      widestObserved: distribution(cases.map(entry => entry.directProbe.widestTokens).filter((value): value is number => value !== null)),
      executedObserved: distribution(cases.map(entry => entry.directProbe.executedTokens).filter((value): value is number => value !== null)),
      gaps: distribution(cases.map(entry => entry.directProbe.gapTokens).filter((value): value is number => value !== null)),
      falseAdmissions: cases.filter(entry => entry.directProbe.falseAdmission).length,
      floorSensitivityFalseAdmissions: floorSensitivity.filter(entry => entry.falseAdmission).length,
      admissionRefusals: cases.filter(entry => entry.directProbe.admissionWouldAdmit === false).length,
      executionNulls: cases.filter(entry => entry.directProbe.executedTokens === null).length,
      engineCommitted: cases.filter(entry => entry.engine.probe?.committed === true).length,
      engineRefused: cases.filter(entry => entry.engine.outcome === 'threw').length,
      engineReturned: cases.filter(entry => entry.engine.outcome.startsWith('returned')).length,
      engineProbeMissing: cases.filter(entry => entry.engine.probe === null).length,
      byAdmission: Object.fromEntries(ADMISSIONS.map(admission => {
        const subset = cases.filter(entry => entry.admission === admission)
        return [admission, {
          cases: subset.length,
          falseAdmissions: subset.filter(entry => entry.directProbe.falseAdmission).length,
          executionNulls: subset.filter(entry => entry.directProbe.executedTokens === null).length,
          committed: subset.filter(entry => entry.engine.probe?.committed === true).length,
          refused: subset.filter(entry => entry.engine.outcome === 'threw').length,
        }]
      })),
      byRetainRatio: Object.fromEntries(RETAIN_RATIOS.map(ratio => {
        const subset = cases.filter(entry => entry.retainRatio === ratio)
        return [String(ratio), {
          cases: subset.length,
          falseAdmissions: subset.filter(entry => entry.directProbe.falseAdmission).length,
          executionNulls: subset.filter(entry => entry.directProbe.executedTokens === null).length,
          medianGap: distribution(subset.map(entry => entry.directProbe.gapTokens).filter((value): value is number => value !== null)).median,
        }]
      })),
    }

    const artifact = {
      schemaVersion: 1,
      work: 'EF-R3 WP4',
      generatedAt: new Date().toISOString(),
      matrix: {
        contextWindow: CONTEXT_WINDOW,
        maxTokens: MAX_TOKENS,
        messageBudget: MESSAGE_BUDGET,
        thresholdTokens: THRESHOLD,
        minReclaimTokens: MIN_RECLAIM_TOKENS,
        minReclaimRatio: MIN_RECLAIM_RATIO,
        admissions: ADMISSIONS,
        retainRatios: RETAIN_RATIOS,
        framings: FRAMINGS,
        checkpointTokens: CHECKPOINT_TOKENS,
        note: 'A keyless controlled adapter returns a checkpoint body of the requested size. No provider request was made.',
      },
      summary,
      floorSensitivity: {
        cases: floorSensitivity,
        falseAdmissions: floorSensitivity.filter(entry => entry.falseAdmission).length,
        note: 'Each floor is set one token above the executed-span reclaim, so the widest span is still admitted while the span execution would fold is not. At the DEFAULT floors the large-span matrix clears both sides; this sensitivity shows the same gap flips the verdict when the span is near the floor.',
      },
      findings: {
        gapIsSystematic: summary.gaps.count > 0 && summary.gaps.median !== null && summary.gaps.median > 0,
        falseAdmissionObservedAtDefaultFloors: summary.falseAdmissions > 0,
        falseAdmissionObservedWithFloorSensitivity: summary.floorSensitivityFalseAdmissions > 0,
        executionNullObserved: summary.executionNulls > 0,
        note: 'A false admission is admission=true on the widest span and execution=false on the span the engine would fold. It is a deterministic span mismatch, not a model failure. The default-floor matrix measures the gap; the floor-sensitivity cases pin the verdict flip.',
      },
      cases,
      note: 'The direct probe is computed on the same measurement the engine used. The engine probe is the post-control-flow observation and may be absent when economic admission refused before the loop.',
    }
    const outDir = join(import.meta.dirname, '..', 'eval', 'r3', 'out')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'span-economics.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')

    // Structural invariants only. A fold error is a matrix outcome, not a test
    // failure: the point is to measure the two spans, not to force a commit.
    expect(cases.length).toBe(ADMISSIONS.length * RETAIN_RATIOS.length * FRAMINGS.length * CHECKPOINT_TOKENS.length)
    for (const entry of cases) {
      if (entry.directProbe.widestTokens !== null && entry.directProbe.executedTokens !== null) {
        expect(entry.directProbe.widestTokens, entry.caseId).toBeGreaterThanOrEqual(entry.directProbe.executedTokens)
      }
      if (entry.directProbe.gapTokens !== null) {
        expect(entry.directProbe.gapTokens, entry.caseId).toBe(
          entry.directProbe.widestTokens! - entry.directProbe.executedTokens!,
        )
      }
    }
    expect(summary.gaps.count).toBeGreaterThan(0)
    expect(summary.floorSensitivityFalseAdmissions, 'the floor-sensitivity cases must flip admission').toBeGreaterThan(0)
  }, 180_000)
})
