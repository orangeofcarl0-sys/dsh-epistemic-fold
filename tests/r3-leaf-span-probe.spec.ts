/**
 * R3: the exact-span probe.
 *
 * The defect is small and deterministic: economic admission prices the widest
 * legal span (`selectLeafSpan(..., 0, ...)`), while execution folds the span
 * left after `spec.retainTokens`. The probe records both on the SAME
 * measurement. It must never change a verdict, a span, or an exception path.
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { createHarness, MODEL, SIGNAL } from './harness.ts'
import { createFoldTelemetry } from '../src/fold/fold-telemetry.ts'
import { probeLeafSpans } from '../src/policy/leaf-span-probe.ts'

function buildSession(turns = 14, chars = 1_000): Session {
  const session = Session.create(SessionId(`probe-${turns}-${chars}-${Math.random()}`))
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
  return session
}

async function measuredSession() {
  const harness = await createHarness({ text: 'digest' }, { contextWindow: 32_000 })
  const session = buildSession()
  return { harness, session, measurement: harness.ctx.tokenMeter.measure(session) }
}

describe('R3 exact-span probe', () => {
  it('records a wider admission span than the execution span', async () => {
    const { harness, session, measurement } = await measuredSession()
    const probe = probeLeafSpans({
      session,
      measurement,
      retainTokens: 500,
      thresholdTokens: 100,
      minReclaimTokens: 0,
      minReclaimRatio: 0,
    })
    expect(probe.widest).not.toBeNull()
    expect(probe.executed).not.toBeNull()
    expect(probe.widest!.tokens).toBeGreaterThan(probe.executed!.tokens)
    expect(probe.gapTokens).toBe(probe.widest!.tokens - probe.executed!.tokens)
    expect(probe.gapTokens).toBeGreaterThan(0)
    expect(probe.estimatedCheckpointTokens).toBeGreaterThan(0)
    await harness.ctx.fiber.dispose()
  })

  it('records equality at retain 0, the setting the admission gate uses', async () => {
    const { harness, session, measurement } = await measuredSession()
    const probe = probeLeafSpans({
      session,
      measurement,
      retainTokens: 0,
      thresholdTokens: 100,
      minReclaimTokens: 0,
      minReclaimRatio: 0,
    })
    expect(probe.widest).not.toBeNull()
    expect(probe.executed).not.toBeNull()
    expect(probe.widest!.tokens).toBe(probe.executed!.tokens)
    expect(probe.gapTokens).toBe(0)
    await harness.ctx.fiber.dispose()
  })

  it('records execution returning no span while admission still sees one', async () => {
    const { harness, session, measurement } = await measuredSession()
    const probe = probeLeafSpans({
      session,
      measurement,
      retainTokens: 1_000_000,
      thresholdTokens: 100,
      minReclaimTokens: 0,
      minReclaimRatio: 0,
    })
    expect(probe.widest).not.toBeNull()
    expect(probe.executed).toBeNull()
    expect(probe.gapTokens).toBeNull()
    expect(probe.executionWouldAdmit).toBe(false)
    await harness.ctx.fiber.dispose()
  })

  it('distinguishes an admitted widest span from an uneconomic executed span', async () => {
    const { harness, session, measurement } = await measuredSession()
    const base = probeLeafSpans({
      session,
      measurement,
      retainTokens: 500,
      thresholdTokens: 100,
      minReclaimTokens: 0,
      minReclaimRatio: 0,
    })
    const executedReclaim = base.executedExpectedReclaimTokens!
    const widestReclaim = base.expectedReclaimTokens!
    expect(widestReclaim).toBeGreaterThan(executedReclaim)
    const floor = executedReclaim + 1
    const probe = probeLeafSpans({
      session,
      measurement,
      retainTokens: 500,
      thresholdTokens: 100,
      minReclaimTokens: floor,
      minReclaimRatio: 0,
    })
    expect(probe.admissionWouldAdmit).toBe(true)
    expect(probe.executionWouldAdmit).toBe(false)
    expect(probe.falseAdmission).toBe(true)
    await harness.ctx.fiber.dispose()
  })

  it('does not mutate the session or the measurement', async () => {
    const { harness, session, measurement } = await measuredSession()
    const beforeTotal = measurement.totalTokens
    const beforeNodes = measurement.nodes.map(node => node.tokens)
    const beforeSurface = session.surface.nodes.map(seq => String(seq))
    probeLeafSpans({
      session,
      measurement,
      retainTokens: 500,
      thresholdTokens: 100,
      minReclaimTokens: 0,
      minReclaimRatio: 0,
    })
    expect(measurement.totalTokens).toBe(beforeTotal)
    expect(measurement.nodes.map(node => node.tokens)).toEqual(beforeNodes)
    expect(session.surface.nodes.map(seq => String(seq))).toEqual(beforeSurface)
    await harness.ctx.fiber.dispose()
  })

  it('telemetry starts without a probe, so "not observed" is not zero', () => {
    expect(createFoldTelemetry().leafSpanProbe).toBeUndefined()
  })

  it('the engine records the probe without changing the fold outcome', async () => {
    const harness = await createHarness({ text: 'digest' }, {
      contextWindow: 32_000,
      leafSpanProbe: true,
      efConfig: {
        auto: false,
        thresholdRatio: 0.1,
        headroomTokens: 0,
        retainTokens: 500,
        maxTokens: 3_000,
        compactionRetries: 0,
        semanticMode: 'none',
        leafAdmission: 'economic',
        rootPolicy: 'economics',
      },
    })
    const session = buildSession()
    const agent = {
      session,
      options: { provider: MODEL, model: MODEL },
      runMaintenance: <T,>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(SIGNAL),
    } as never
    try {
      await (harness.engine as unknown as {
        compactIfNeeded(a: unknown, t: string, s: AbortSignal): Promise<unknown>
      }).compactIfNeeded(agent, 'pressure', SIGNAL)
    } catch {
      // A refusal is a valid outcome; the probe is recorded before the attempt.
    }
    const probe = harness.engine.lastLeafSpanProbe
    expect(probe).toBeDefined()
    expect(probe!.schemaVersion).toBe(1)
    expect(probe!.retainTokens).toBe(500)
    expect(probe!.widest).not.toBeNull()
    await harness.ctx.fiber.dispose()
  })
})
