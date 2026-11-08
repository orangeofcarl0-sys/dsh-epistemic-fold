/**
 * EF-C0 WP3 — Core / Semantic boundary contracts.
 *
 * One test per contract. The contracts are the ones a future change must not
 * break; each test drives the REAL engine transaction, with the scripted
 * adapter owning only the model's text.
 *
 *   C1  Core works with semantic off.
 *   C2  A semantic failure cannot corrupt the fold transaction.
 *   C3  Semantic state cannot rewrite canonical history.
 *   C4  Selection cannot mutate authoritative state.
 *   C5  Feature off means no hidden semantic effect.
 *   C6  Basic mode mounts no EF surface.
 *   C7  Archive stays recoverable after a semantic refusal.
 *
 * @module tests/convergence-boundaries
 */

import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import { locateFoldFrontier } from '../src/fold/frontier.ts'
import { recall } from '../src/recall/recall.ts'
import { emptyCurrentState } from '../src/state/state.ts'
import type { Anchor, FoldCurrentState } from '../src/state/state.ts'
import { selectTaskAwareContext } from '../eval/r38/src/task-aware-selector.ts'
import { createHarness, conversation, foldAgent, MODEL, SIGNAL } from './harness.ts'
import type { Harness, SemanticFace } from './harness.ts'
import { makeTemp } from '../eval/tmp.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

function lastText(options: GenerateOptions): string {
  const last = options.messages[options.messages.length - 1]
  if (last === undefined) return ''
  return last.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

const isWriterCall = (options: GenerateOptions): boolean =>
  lastText(options).startsWith('You are the SEMANTIC WRITER')

function writerReply(deltas: readonly unknown[]): string {
  return [
    '<handoff>', 'A terse handoff.', '</handoff>',
    '<deltas>', JSON.stringify({ deltas }), '</deltas>',
  ].join('\n')
}

interface Box {
  reply: string
}

interface FoldResult {
  readonly h: Harness
  readonly root: string
  readonly session: SessionType
  readonly calls: readonly GenerateOptions[]
}

async function foldOnce(
  efConfig: Record<string, unknown>,
  face: Omit<SemanticFace, 'textFor'> = {},
  options: { readonly session?: SessionType; readonly plugin?: boolean; readonly tools?: boolean } = {},
): Promise<FoldResult> {
  const root = await makeTemp('ef-c0-boundary-')
  const box: Box = { reply: writerReply([]) }
  const h = await createHarness(
    {
      ...face,
      textFor: call => (isWriterCall(call) ? box.reply : 'digest'),
    },
    {
      projection: true,
      systemPrompt: true,
      ...(options.plugin === true ? { plugin: true } : {}),
      ...(options.tools === true ? { tools: true } : {}),
      efConfig: {
        bundleRoot: join(root, 'bundles'),
        semanticRoot: join(root, 'semantic'),
        ...efConfig,
      },
    },
  )
  const session = options.session ?? conversation(2)
  const frontier = locateFoldFrontier(session)
  const nodes = [...session.surface.nodes]
  const start = nodes[frontier.firstOpenPosition]
  const end = nodes[nodes.length - 1]
  if (start === undefined || end === undefined) throw new Error('fixture has nothing to fold')
  await h.engine.compactRegion(start, end, foldAgent(session), SIGNAL)
  await h.engine.reconcileSemantics(session)
  return { h, root, session, calls: h.control.calls.map(call => call.options) }
}

/** One closed turn whose user message states a value, then an open turn. */
function timeoutSession(): SessionType {
  // The span must be larger than the framed checkpoint, or Basic refuses the
  // fold as non-reclaiming and the test would be about admission, not history.
  const padding = ` ${'padding '.repeat(160)}`.trimEnd()
  const session = Session.create(SessionId(`ef-c0-c3-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    header: { config: { provider: MODEL, model: MODEL } },
    reason: 'initial',
  })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `The timeout is 60 seconds.${padding}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `Understood.${padding}` }],
      source: { kind: 'model', provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  return session
}

function anchor(id: string, kind: Anchor['kind'], value: string, domain: Anchor['authority']): Anchor {
  return {
    id,
    kind,
    value,
    authority: domain,
    lifecycle: 'active',
    sourceRefs: [{ seq: SessionSeq(0) }],
  }
}

describe('C1: Core works with semantic off', () => {
  it('the fold commits a bundle and a body with no semantic layer', async () => {
    const { h } = await foldOnce({ mode: 'economy', semanticMode: 'none', semanticContinuity: 'off' })
    expect(h.engine.publishedBundle, 'the fold must publish a bundle').toBeDefined()
    expect(h.engine.publishedBundle!.rendered.text.length).toBeGreaterThan(0)
    expect(h.engine.semanticDiagnostics.health).toBe('archive-only')
    expect(h.engine.semanticDiagnostics.mode).toBe('off')
  })
})

describe('C2: a semantic failure cannot corrupt the fold transaction', () => {
  it('a writer error leaves the bundle and checkpoint intact', async () => {
    const { h } = await foldOnce(
      { mode: 'economy', semanticContinuity: 'active' },
      { failure: { kind: 'error', message: 'writer down' } },
    )
    expect(h.engine.publishedBundle, 'the archive must still be written').toBeDefined()
    expect(h.engine.semanticWriterStats.failures).toBe(1)
    expect(h.engine.lastSemanticPacket, 'a failed writer stages nothing').toBeUndefined()
    // The deterministic body is still a valid checkpoint.
    expect(h.engine.publishedBundle!.rendered.text).toContain('[EF1')
  })
})

describe('C3: semantic state cannot rewrite canonical history', () => {
  it('a claim that contradicts the user message leaves the raw event unchanged', async () => {
    const session = timeoutSession()
    const userSeq = session.surface.nodes[0]!
    const before = session.deriveEventMessage(session.eventAt(userSeq)!)
    const beforeText = before!.content.map(block => (block.type === 'text' ? block.text : '')).join('')

    const box = { reply: writerReply([{
      kind: 'constraint',
      subjectKey: 'timeout',
      statement: 'The timeout is 30 seconds.',
      status: 'claimed',
      evidence: [{ quote: 'The timeout is 60 seconds.' }],
    }]) }
    const root = await makeTemp('ef-c0-c3-')
    const h = await createHarness(
      { textFor: call => (isWriterCall(call) ? box.reply : 'digest') },
      {
        projection: true,
        systemPrompt: true,
        efConfig: {
          bundleRoot: join(root, 'bundles'),
          semanticRoot: join(root, 'semantic'),
          mode: 'economy',
          semanticContinuity: 'active',
        },
      },
    )
    const frontier = locateFoldFrontier(session)
    const nodes = [...session.surface.nodes]
    await h.engine.compactRegion(
      nodes[frontier.firstOpenPosition]!,
      nodes[nodes.length - 1]!,
      foldAgent(session),
      SIGNAL,
    )
    await h.engine.reconcileSemantics(session)

    // The semantic layer recorded a claim that differs from the raw message...
    expect(h.engine.lastSemanticPacket?.accepted[0]?.statement).toBe('The timeout is 30 seconds.')
    expect(h.engine.lastSemanticReceipt?.outcome).toBe('committed')

    // ...and the raw event still says what the user said.
    const after = session.deriveEventMessage(session.eventAt(userSeq)!)
    const afterText = after!.content.map(block => (block.type === 'text' ? block.text : '')).join('')
    expect(afterText).toBe(beforeText)
    expect(afterText).toContain('60 seconds')
    expect(afterText).not.toContain('30 seconds')
  })
})

describe('C4: selection cannot mutate authoritative state', () => {
  it('the task-aware selector leaves its input state byte-identical', () => {
    const state: FoldCurrentState = {
      ...emptyCurrentState(),
      constraints: {
        'constraint:timeout': anchor('constraint:timeout', 'constraint', 'The timeout is 60 seconds.', 'normative'),
      },
      stateHeads: {
        'decision:queue': anchor('decision:queue', 'decision', 'Use a durable queue.', 'decision'),
      },
    }
    const snapshot = JSON.stringify(state)
    const selection = selectTaskAwareContext({
      state,
      frame: {
        sessionId: 'c4',
        files: ['src/queue.ts'],
        symbols: ['enqueue'],
        currentRequest: 'implement the queue',
        semanticStateRevision: 'r1',
        sessionEventWatermark: 0,
      },
      budgetTokens: 200,
    })
    expect(JSON.stringify(state), 'selection must not mutate state').toBe(snapshot)
    expect(selection.selectedAnchorIds.length + selection.omittedAnchorIds.length).toBe(2)
    expect(new Set([...selection.selectedAnchorIds, ...selection.omittedAnchorIds]))
      .toEqual(new Set(['constraint:timeout', 'decision:queue']))
  })

  it('the selector source contains no write API', async () => {
    const source = await readFile(join(HERE, '..', 'eval', 'r38', 'src', 'task-aware-selector.ts'), 'utf8')
    expect(source).not.toMatch(/writeFile|appendFile|createWriteStream/u)
    expect(source).not.toMatch(/semanticJournal|journal\.write/u)
    expect(source).not.toMatch(/\.retire\(/u)
  })
})

describe('C5: feature off means no hidden semantic effect', () => {
  it('off creates no journal directory and no packet', async () => {
    const { h, root } = await foldOnce({ mode: 'economy', semanticMode: 'none', semanticContinuity: 'off' })
    expect(existsSync(join(root, 'semantic'))).toBe(false)
    expect(h.engine.lastSemanticPacket).toBeUndefined()
    expect(h.engine.lastSemanticReceipt).toBeUndefined()
  })
})

describe('C6: basic mode mounts no EF surface', () => {
  it('no anchor service, no recall tools, no EF bundle', async () => {
    const { h } = await foldOnce({ mode: 'basic' }, {}, { plugin: true, tools: true })
    expect(h.engine.basicMode).toBe(true)
    expect(h.plugin?.anchors).toBeUndefined()
    const names = h.ctx.tools.schemas().map(schema => schema.name)
    expect(names).not.toContain('context_search')
    expect(names).not.toContain('context_recall')
    expect(h.engine.publishedBundle).toBeUndefined()
  })
})

describe('C7: archive stays recoverable after a semantic refusal', () => {
  it('a refused delta does not prevent exact recall of the folded span', async () => {
    const box = { reply: writerReply([{
      kind: 'constraint',
      subjectKey: 'invented',
      statement: 'A fact that was never said.',
      status: 'claimed',
      // Not a verbatim quote from the folded span: the validator must refuse it.
      evidence: [{ quote: 'this phrase does not appear anywhere in the conversation' }],
    }]) }
    const root = await makeTemp('ef-c0-c7-')
    const h = await createHarness(
      { textFor: call => (isWriterCall(call) ? box.reply : 'digest') },
      {
        projection: true,
        systemPrompt: true,
        efConfig: {
          bundleRoot: join(root, 'bundles'),
          semanticRoot: join(root, 'semantic'),
          mode: 'economy',
          semanticContinuity: 'active',
        },
      },
    )
    const session = conversation(2)
    const frontier = locateFoldFrontier(session)
    const nodes = [...session.surface.nodes]
    await h.engine.compactRegion(
      nodes[frontier.firstOpenPosition]!,
      nodes[nodes.length - 1]!,
      foldAgent(session),
      SIGNAL,
    )
    await h.engine.reconcileSemantics(session)

    expect(h.engine.lastSemanticPacket?.refused.length ?? 0).toBeGreaterThan(0)
    const bundle = h.engine.publishedBundle!
    expect(bundle, 'the fold must still publish').toBeDefined()

    const recalled = await recall({
      store: h.store,
      sessionId: session.id,
      checkpointId: bundle.checkpointId,
      depth: 'exact',
      limit: 20,
    })
    expect(recalled?.unavailable, 'recall must not be unavailable').toBeUndefined()
    expect(recalled?.page?.totalMessages).toBe(bundle.archive.messageCount)
    expect(recalled?.page?.messages.length).toBe(Math.min(20, bundle.archive.messageCount))
  })
})
