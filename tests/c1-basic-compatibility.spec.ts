/**
 * EF-C1 WP4 — Basic compatibility certification.
 *
 * ## Three objects, never one
 *
 *   Historical Basic   the vendored reference `src/basic` was copied from
 *   EF `mode: basic`   EF's own copy, standing aside (Bv)
 *   Host Native Basic  the installed `@deepseek-ai/dsh-compaction-basic` (B0)
 *
 * `rc7-vendored-basic.spec.ts` proves the copy is byte-identical to the
 * reference when the vendor tree is present. `rc7-basic-mode.spec.ts` proves Bv
 * and B0 produce a byte-identical checkpoint on a normal fold, and that Bv
 * mounts no EF surface. This file adds the CONTRACT cases those do not cover:
 *
 *   normal leaf fold      span, replacement, checkpoint
 *   tool pair boundary    a call/result pair is never split
 *   summary failure       the documented fallback still produces a checkpoint
 *   compaction abort      an aborted fold replaces nothing
 *   restart               a checkpoint survives event-log reconstruction
 *
 * Cross-version comparisons are contract-level, not byte-level: B0 and Bv may
 * resolve to different DSH lines (see `eval/c1/out/dsh-compatibility.json`).
 * Byte parity is asserted only where the existing RC7 test already establishes
 * that both arms are the same source.
 *
 * @module tests/c1-basic-compatibility
 */

import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import { locateFoldFrontier } from '../src/fold/frontier.ts'
import type { EpistemicFoldConfig } from '../src/config/policy.ts'
import { createHarness, foldAgent, SIGNAL } from './harness.ts'
import type { Harness } from './harness.ts'

const WINDOW = 12_000
const SHARED = {
  thresholdRatio: 0.15,
  headroomTokens: 0,
  retainTokens: 300,
  maxTokens: 3_000,
} as const

const filler = (units: number): string =>
  Array.from({ length: units }, (_, i) => `bg ${i} ${'payload '.repeat(12)}`).join(' ')

/** A session with one closed tool-using turn and one open turn, past threshold. */
function seedWithToolPair(tag: string): SessionType {
  const session = Session.create(SessionId(`c1-basic-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`))
  const callId = ToolCallId('call-1')
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `The batch limit is 64. ${filler(120)}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', {
    header: { config: { provider: 'live', model: 'live' } },
    reason: 'initial',
  })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will read the file.' },
        { type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"a.txt"}' },
      ],
      source: { kind: 'model', provider: 'live', model: 'live' },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'read_file', arguments: '{"path":"a.txt"}' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId,
      isError: false,
      content: [{ type: 'text', text: `file contents ${filler(40)}` }],
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: filler(260) }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return session
}

async function mount(arm: 'B0' | 'Bv', failure = false): Promise<Harness> {
  return createHarness(
    failure
      ? { text: 'unused', failure: { kind: 'error', message: 'scripted summary failure' } }
      : { text: 'SEMANTIC-SUMMARY-MARKER' },
    {
      contextWindow: WINDOW,
      ...(arm === 'B0' ? { engine: 'basic' as const } : { plugin: true, projection: true, systemPrompt: true, tools: true }),
      workloadModel: 'live',
      efConfig: {
        ...(arm === 'Bv' ? { mode: 'basic' as const } : {}),
        ...SHARED,
      } as EpistemicFoldConfig,
    },
  )
}

interface FoldOutcome {
  readonly folded: boolean
  readonly checkpoints: number
  readonly body: string | null
  readonly surfaceBefore: number
  readonly surfaceAfter: number
  readonly span: { readonly start: number; readonly end: number } | null
}

async function foldAll(harness: Harness, session: SessionType, signal: AbortSignal = SIGNAL): Promise<FoldOutcome> {
  const frontier = locateFoldFrontier(session)
  const nodes = [...session.surface.nodes]
  const start = nodes[frontier.firstOpenPosition]
  const end = nodes[nodes.length - 1]
  const surfaceBefore = nodes.length
  let folded = false
  if (start !== undefined && end !== undefined) {
    try {
      await (harness.engine as unknown as {
        compactRegion(a: number, b: number, agent: unknown, s: AbortSignal): Promise<unknown>
      }).compactRegion(start, end, foldAgent(session), signal)
      folded = true
    } catch {
      folded = false
    }
  }
  const bodies: string[] = []
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message !== null && isCompactCheckpointSource(message.source)) {
      bodies.push(message.content.map(block => (block.type === 'text' ? block.text : '')).join(''))
    }
  }
  return {
    folded,
    checkpoints: bodies.length,
    body: bodies[0] ?? null,
    surfaceBefore,
    surfaceAfter: session.surface.nodes.length,
    span: start === undefined || end === undefined ? null : { start, end },
  }
}

/** Whether a span contains a tool call and its matching result together. */
function pairIsWhole(session: SessionType, start: number, end: number): boolean {
  let calls = 0
  let results = 0
  for (const seq of session.surface.nodes) {
    const at = Number(seq)
    if (at < start || at > end) continue
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (event.type === 'assistant/message') {
      const message = session.deriveEventMessage(event)
      calls += message?.content.filter(block => block.type === 'tool-call').length ?? 0
    }
    if (event.type === 'tool/result') results += 1
  }
  // Either both sides are inside the span, or neither is. The span is legal
  // only when the counts agree; a split pair would leave one side outside.
  return calls === results
}

/** Collected outcomes, written only when an explicit generator dir is set. */
const RECORD: Array<Record<string, unknown>> = []

function record(arm: string, caseId: string, outcome: FoldOutcome): void {
  const { body: _body, ...rest } = outcome
  RECORD.push({ arm, case: caseId, ...rest })
}

describe('EF-C1 Basic compatibility: B0 and Bv agree on the contract', () => {
  for (const arm of ['B0', 'Bv'] as const) {
    it(`${arm}: a normal leaf fold takes a legal span and replaces it with one checkpoint`, async () => {
      const harness = await mount(arm)
      const session = seedWithToolPair(`${arm}-leaf`)
      const outcome = await foldAll(harness, session)
      record(arm, 'leaf', outcome)
      expect(outcome.folded, `${arm} must fold`).toBe(true)
      expect(outcome.checkpoints).toBe(1)
      expect(outcome.body).not.toBeNull()
      expect(outcome.surfaceAfter, `${arm} must replace the folded span`).toBeLessThan(outcome.surfaceBefore)
      expect(outcome.span).not.toBeNull()
      expect(outcome.span!.start).toBeLessThanOrEqual(outcome.span!.end)
    }, 300_000)

    it(`${arm}: the fold never splits a tool call from its result`, async () => {
      const harness = await mount(arm)
      const session = seedWithToolPair(`${arm}-pair`)
      const outcome = await foldAll(harness, session)
      record(arm, 'tool-pair', outcome)
      expect(outcome.span).not.toBeNull()
      expect(
        pairIsWhole(session, outcome.span!.start, outcome.span!.end),
        `${arm} split a tool call/result pair`,
      ).toBe(true)
    }, 300_000)

    it(`${arm}: a summary failure is contained and replaces nothing`, async () => {
      const harness = await mount(arm, true)
      const session = seedWithToolPair(`${arm}-failure`)
      const before = [...session.surface.nodes]
      const outcome = await foldAll(harness, session)
      record(arm, 'summary-failure', outcome)
      // Basic's documented failure contract: `compaction/summary-error` has no
      // listener by default, so the fold FAILS rather than replacing the span
      // with a partial summary. The surface is the evidence that nothing was
      // lost. A host that supplies a recovery listener may turn this into a
      // retry or a fallback; that is the listener's contract, not Basic's.
      expect(outcome.folded, `${arm} must fail the fold rather than lose the span`).toBe(false)
      expect(outcome.checkpoints, `${arm} must not write a checkpoint`).toBe(0)
      expect([...session.surface.nodes]).toEqual(before)
    }, 300_000)

    it(`${arm}: an aborted fold replaces nothing`, async () => {
      const harness = await mount(arm)
      const session = seedWithToolPair(`${arm}-abort`)
      const before = [...session.surface.nodes]
      const controller = new AbortController()
      controller.abort()
      const outcome = await foldAll(harness, session, controller.signal)
      record(arm, 'abort', outcome)
      expect(outcome.checkpoints, `${arm} must not write a checkpoint on abort`).toBe(0)
      expect([...session.surface.nodes]).toEqual(before)
    }, 300_000)

    it(`${arm}: a checkpoint survives event-log reconstruction`, async () => {
      const harness = await mount(arm)
      const session = seedWithToolPair(`${arm}-restart`)
      const outcome = await foldAll(harness, session)
      record(arm, 'restart', outcome)
      expect(outcome.body).not.toBeNull()
      const restored = Session.create(SessionId(`restored-${arm}-${Date.now()}`), session.snapshotEvents())
      let restoredBody: string | null = null
      for (const seq of restored.surface.nodes) {
        const message = restored.deriveEventMessage(restored.eventAt(seq)!)
        if (message !== null && isCompactCheckpointSource(message.source)) {
          restoredBody = message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
          break
        }
      }
      expect(restoredBody, `${arm}'s checkpoint must be readable after reconstruction`).toBe(outcome.body)
      expect(createHash('sha256').update(restoredBody!).digest('hex'))
        .toBe(createHash('sha256').update(outcome.body!).digest('hex'))
    }, 300_000)
  }

  it('B0 and Bv produce the same checkpoint body for the same input', async () => {
    const b0 = await foldAll(await mount('B0'), seedWithToolPair('parity-b0'))
    const bv = await foldAll(await mount('Bv'), seedWithToolPair('parity-bv'))
    record('B0', 'parity', b0)
    record('Bv', 'parity', bv)
    expect(b0.body, 'native Basic must fold').not.toBeNull()
    expect(bv.body, 'EF mode:basic must fold').not.toBeNull()
    expect(bv.body).toBe(b0.body)
  }, 300_000)

  it('records the compatibility matrix when an explicit output directory is set', () => {
    const out = process.env['EF_C1_BASIC_OUT']
    if (out !== undefined) {
      mkdirSync(out, { recursive: true })
      writeFileSync(join(out, 'basic-compatibility.json'), `${JSON.stringify({
        schemaVersion: 1,
        work: 'EF-C1',
        generator: 'tests/c1-basic-compatibility.spec.ts',
        generatedAt: new Date().toISOString(),
        executionKind: 'scripted adapter; contract-level comparison, not a model result',
        arms: RECORD,
        note: 'B0 resolves to the installed host Basic; Bv is EF mode:basic over src/basic. Byte parity is asserted only where both resolve to the same source (see rc7-vendored-basic).',
      }, null, 2)}\n`, 'utf8')
    }
    expect(RECORD.length).toBeGreaterThanOrEqual(10)
  })
})
