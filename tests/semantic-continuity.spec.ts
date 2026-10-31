/**
 * Semantic Continuity: the transaction, end to end.
 *
 * These tests drive the REAL engine and the REAL projection. The only scripted
 * part is the model's text, which is the boundary a controlled adapter is
 * allowed to own. Everything that decides state — validation, planning,
 * staging, the commit predicate, activation, replay — runs for real.
 *
 * The host here is the vendored 0.1.7 line, which has no
 * `appendPluginRecord`; the deployment therefore uses the JOURNAL authority.
 * `semantic-host-0.2.spec.ts` covers the session-record authority on the real
 * 0.2.1 API.
 *
 * @module tests/semantic-continuity
 */

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { locateFoldFrontier } from '../src/fold/frontier.ts'
import { EpistemicFoldEngine } from '../src/fold/engine.ts'
import { FileSemanticJournal } from '../src/semantic/journal.ts'
import { registerEpistemicFoldProjection } from '../src/state/projection.ts'
import { makeTemp } from '../eval/tmp.ts'
import { mountRuntime } from '../eval/src/runtime-mount.ts'
import { Context } from '@deepseek-ai/cordis'
import { ControlledAdapter, MODEL, SIGNAL, createHarness, conversation, foldAgent } from './harness.ts'
import type { Harness, Session } from './harness.ts'

/** The writer call is the one whose last user message is the writer instruction. */
function isWriterCall(options: GenerateOptions): boolean {
  const last = options.messages[options.messages.length - 1]
  if (last === undefined) return false
  return last.content.some(block =>
    block.type === 'text' && block.text.startsWith('You are the SEMANTIC WRITER'))
}

/** A writer reply with one handoff and a deltas block. */
function writerReply(handoff: string, deltas: readonly unknown[]): string {
  return [
    '<handoff>', handoff, '</handoff>',
    '<deltas>', JSON.stringify({ deltas }), '</deltas>',
  ].join('\n')
}

/** One constraint delta citing an exact quote from the folded span. */
function constraintDelta(quote: string, statement: string, subjectKey = 'timeout'): Record<string, unknown> {
  return {
    kind: 'constraint',
    subjectKey,
    statement,
    status: 'claimed',
    evidence: [{ quote }],
  }
}

interface Box {
  text: string
}

/** Mount one harness over a fresh temp root; `box.text` is the current reply. */
async function semanticHarness(
  continuity: 'active' | 'shadow' | 'off',
): Promise<{ readonly h: Harness; readonly root: string; readonly box: Box }> {
  const root = await makeTemp('ef-sem-')
  const box: Box = { text: writerReply('empty', []) }
  const h = await createHarness(
    { textFor: options => isWriterCall(options) ? box.text : 'digest' },
    {
      efConfig: {
        semanticContinuity: continuity,
        semanticMode: 'rationale',
        semanticWorkingSetTokens: 512,
        bundleRoot: join(root, 'bundles'),
        semanticRoot: join(root, 'semantic'),
      },
    },
  )
  registerEpistemicFoldProjection(h.ctx)
  return { h, root, box }
}

/** Fold the whole open trajectory; the last surface node is a closed turn. */
async function foldOpen(h: Harness, session: Session): Promise<string> {
  const frontier = locateFoldFrontier(session)
  const nodes = [...session.surface.nodes]
  const start = nodes[frontier.firstOpenPosition]
  const end = nodes[nodes.length - 1]
  if (start === undefined || end === undefined) throw new Error('fixture has nothing to fold')
  await h.engine.compactRegion(start, end, foldAgent(session), SIGNAL)
  await h.engine.reconcileSemantics(session)
  return h.engine.publishedBundle!.rendered.text
}

/** Filler that makes a one-turn span larger than the framed checkpoint. */
const PADDING = ` ${'padding '.repeat(160)}`.trimEnd()

/** Close the open turn with one user/assistant exchange, then open the next. */
function appendClosedTurn(session: Session, turn: number, userText: string, assistantText: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `${userText} ${PADDING}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `${assistantText} ${PADDING}` }],
      source: { kind: 'model', provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: turn + 1 })
}

/** Normalize the random checkpoint id so two arms can be compared. */
function withoutCheckpointId(text: string): string {
  return text.replace(/cp:[0-9a-f-]+/gu, 'cp:<id>')
}

describe('active mode: a committed fold becomes state', () => {
  it('stages, commits, activates, and carries the state into the next checkpoint', async () => {
    const { h, root, box } = await semanticHarness('active')
    box.text = writerReply('We chose a lease because a lock lost on crash blocks progress.', [
      constraintDelta('fixture user 1', 'The timeout is 30 seconds.'),
      {
        kind: 'decision',
        subjectKey: 'coordination',
        statement: 'Coordination uses a lease, not a lock.',
        status: 'claimed',
        evidence: [{ quote: 'fixture assistant 1' }],
      },
    ])
    const session = conversation(2)

    const first = await foldOpen(h, session)
    expect(first).toContain('Changed in this fold')
    expect(first).toContain('The timeout is 30 seconds.')
    expect(first).toContain('Coordination uses a lease, not a lock.')

    const journal = new FileSemanticJournal(join(root, 'semantic'))
    const read = await journal.list(session.id)
    expect(read.invalid).toHaveLength(0)
    expect(read.packets).toHaveLength(1)
    expect(read.packets[0]!.status).toBe('activated')
    expect(read.packets[0]!.mode).toBe('active')
    expect(read.packets[0]!.ops.length).toBeGreaterThan(0)

    // The next fold starts a new span; its carried section must show the state
    // the previous fold committed, not re-emit it as "changed".
    appendClosedTurn(session, 3, 'Second phase starts here.', 'Acknowledged.')
    box.text = writerReply('Continuing the second phase.', [])
    const second = await foldOpen(h, session)
    expect(second).toContain('State from earlier folds (later checkpoints supersede it)')
    expect(second).toContain('The timeout is 30 seconds.')
    expect(h.engine.semanticDiagnostics.health).toBe('ready')
    expect(h.engine.semanticDiagnostics.committed).toBeGreaterThan(0)
  })

  it('keeps the second value when a coordinate is revised across folds', async () => {
    const { h, root, box } = await semanticHarness('active')
    box.text = writerReply('first', [
      constraintDelta('The timeout is 30 seconds.', 'The timeout is 30 seconds.'),
    ])
    const session = conversation(2)
    await foldOpen(h, session)

    appendClosedTurn(session, 3, 'The timeout is 60 seconds.', 'Noted, 60 seconds.')
    box.text = writerReply('second', [
      constraintDelta('The timeout is 60 seconds.', 'The timeout is 60 seconds.'),
    ])
    const second = await foldOpen(h, session)
    expect(second).toContain('The timeout is 60 seconds.')
    expect(second).not.toContain('The timeout is 30 seconds.')

    const packets = (await new FileSemanticJournal(join(root, 'semantic')).list(session.id)).packets
    expect(packets).toHaveLength(2)
    expect(packets.every(packet => packet.status === 'activated')).toBe(true)
  })
})

describe('transaction safety', () => {
  it('does not activate a packet whose fold was rejected by the shrink check', async () => {
    // A bundle is written before Basic checks that the replacement is smaller;
    // a rejected fold must therefore leave a staged packet, never state.
    const { h, root, box } = await semanticHarness('active')
    box.text = writerReply('x'.repeat(20_000), [
      constraintDelta('fixture user 1', 'The timeout is 30 seconds.'),
    ])
    const session = conversation(2)
    const frontier = locateFoldFrontier(session)
    const nodes = [...session.surface.nodes]
    const start = nodes[frontier.firstOpenPosition]!
    const end = nodes[nodes.length - 1]!

    await expect(h.engine.compactRegion(start, end, foldAgent(session), SIGNAL))
      .rejects.toThrow(/not smaller/u)
    await h.engine.reconcileSemantics(session)

    const packets = (await new FileSemanticJournal(join(root, 'semantic')).list(session.id)).packets
    expect(packets).toHaveLength(1)
    expect(packets[0]!.status).toBe('abandoned')

    // A following fold must not carry the abandoned value.
    appendClosedTurn(session, 3, 'A fresh phase.', 'Ready.')
    box.text = writerReply('fresh', [])
    const body = await foldOpen(h, session)
    expect(body).not.toContain('The timeout is 30 seconds.')
  })

  it('replays activated packets after a restart without duplicating state', async () => {
    const { h, root, box } = await semanticHarness('active')
    box.text = writerReply('first', [
      constraintDelta('The timeout is 30 seconds.', 'The timeout is 30 seconds.'),
    ])
    const session = conversation(2)
    await foldOpen(h, session)

    appendClosedTurn(session, 3, 'The timeout is 60 seconds.', 'Noted.')
    box.text = writerReply('second', [
      constraintDelta('The timeout is 60 seconds.', 'The timeout is 60 seconds.'),
    ])
    await foldOpen(h, session)

    // A new CONTEXT, engine, projection, and bundle store over the SAME session
    // log and journal: the restart face. A second engine on the same context is
    // refused by cordis (one `compaction` service), which is why this mounts a
    // fresh runtime and registers the same controlled adapter.
    const ctx2 = new Context()
    mountRuntime(ctx2)
    registerEpistemicFoldProjection(ctx2)
    ctx2.llm.registerAdapter([MODEL], new ControlledAdapter(1_000_000, h.control))
    const restarted = new EpistemicFoldEngine(ctx2, {
      semanticContinuity: 'active',
      semanticMode: 'rationale',
      semanticWorkingSetTokens: 512,
      bundleRoot: join(root, 'bundles'),
      semanticRoot: join(root, 'semantic'),
    }, { bundleStore: h.store })
    appendClosedTurn(session, 4, 'A third phase.', 'Ready.')
    box.text = writerReply('third', [])
    const nodes = [...session.surface.nodes]
    const frontier = locateFoldFrontier(session)
    const start = nodes[frontier.firstOpenPosition]!
    const end = nodes[nodes.length - 1]!
    await restarted.compactRegion(start, end, foldAgent(session), SIGNAL)
    await restarted.reconcileSemantics(session)
    const body = restarted.publishedBundle!.rendered.text

    expect(body).toContain('The timeout is 60 seconds.')
    expect(body).not.toContain('The timeout is 30 seconds.')
    const packets = (await new FileSemanticJournal(join(root, 'semantic')).list(session.id)).packets
    expect(packets.filter(packet => packet.status === 'activated')).toHaveLength(3)
  })
})

describe('shadow mode: measurement without commitment', () => {
  it('leaves the visible checkpoint byte-identical to the off arm', async () => {
    const off = await semanticHarness('off')
    const shadow = await semanticHarness('shadow')
    const reply = writerReply('A shadow handoff that must never be visible.', [
      constraintDelta('fixture user 1', 'The timeout is 30 seconds.'),
    ])
    off.box.text = reply
    shadow.box.text = reply

    const offBody = await foldOpen(off.h, conversation(2))
    const shadowBody = await foldOpen(shadow.h, conversation(2))

    expect(withoutCheckpointId(shadowBody)).toBe(withoutCheckpointId(offBody))
    // The off arm makes one compaction call; shadow adds exactly one,
    // recorded diagnostic writer call.
    expect(off.h.control.calls).toHaveLength(1)
    expect(shadow.h.control.calls).toHaveLength(2)

    const packet = shadow.h.engine.lastSemanticPacket!
    expect(packet.mode).toBe('shadow')
    expect(packet.ops).toHaveLength(0)
    expect(packet.plannedOps!.length).toBeGreaterThan(0)
    // Nothing was journaled, so a later active pass cannot mistake it for intent.
    const files = await readdir(join(shadow.root, 'semantic'))
      .then(entries => entries.length)
      .catch(() => 0)
    expect(files).toBe(0)
  })
})
