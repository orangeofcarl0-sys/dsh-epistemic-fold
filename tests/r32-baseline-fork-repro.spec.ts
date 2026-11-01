/**
 * R32 baseline reproduction for partial fork inheritance.
 *
 * R31 returned as soon as ANY child receipt existed, so a crash after the first
 * inherited commit left the rest missing forever. This file uses only R31 APIs
 * and can be copied to the baseline worktree; there it fails because the second
 * commit is never filled in.
 *
 * @module tests/r32-baseline-fork-repro
 */

import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { locateFoldFrontier } from '../src/fold/frontier.ts'
import { FileSemanticJournal } from '../src/semantic/journal.ts'
import {
  MODEL,
  SIGNAL,
  createHarness,
  foldAgent,
  type Harness,
  type Session,
} from './harness.ts'
import { makeTemp } from '../eval/tmp.ts'

const PADDING = ` ${'padding '.repeat(220)}`.trimEnd()

function writerReply(handoff: string, deltas: readonly unknown[]): string {
  return [
    '<handoff>', handoff, '</handoff>',
    '<deltas>', JSON.stringify({ deltas }), '</deltas>',
  ].join('\n')
}

function isWriterCall(options: {
  readonly messages: readonly { readonly content: readonly { readonly type: string; readonly text?: string }[] }[]
}): boolean {
  const last = options.messages[options.messages.length - 1]
  return last?.content.some(block =>
    block.type === 'text' && block.text?.startsWith('You are the SEMANTIC WRITER')) === true
}

function appendClosedTurn(session: Session, turn: number, userText: string): void {
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
      content: [{ type: 'text', text: `Acknowledged ${turn}. ${PADDING}` }],
      source: { kind: 'model', provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: turn + 1 })
}

function seedConversation(session: Session): void {
  for (let turn = 1; turn <= 2; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `Phase ${turn} fixture user ${turn} ${PADDING}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `Acknowledged phase ${turn}. ${PADDING}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: 3 })
}

async function foldOpen(h: Harness, session: Session): Promise<void> {
  const frontier = locateFoldFrontier(session)
  const nodes = [...session.surface.nodes]
  const start = nodes[frontier.firstOpenPosition]
  const end = nodes[nodes.length - 1]
  if (start === undefined || end === undefined) throw new Error('nothing to fold')
  await h.engine.compactRegion(start, end, foldAgent(session), SIGNAL)
  await h.engine.reconcileSemantics(session)
}

function constraint(subject: string, value: string, quote: string): Record<string, unknown> {
  return {
    kind: 'constraint',
    subjectKey: subject,
    statement: value,
    status: 'claimed',
    evidence: [{ quote }],
  }
}

describe('R32 baseline: a partial fork inheritance is completed', () => {
  it('fills the second inherited commit after a crash left only the first', async () => {
    const root = await makeTemp('ef-r32-fork-repro-')
    const box = { text: writerReply('start', []) }
    const h = await createHarness(
      { textFor: options => isWriterCall(options) ? box.text : 'digest' },
      {
        plugin: true,
        systemPrompt: true,
        efConfig: {
          auto: false,
          bundleRoot: join(root, 'bundles'),
          semanticRoot: join(root, 'semantic'),
          semanticContinuity: 'active',
          semanticMode: 'rationale',
          semanticWorkingSetTokens: 512,
        },
      },
    )
    const parent = h.ctx.sessions.create(SessionId(`parent-${randomUUID()}`), { meta: { cwd: root } })
    seedConversation(parent)

    box.text = writerReply('A', [constraint('alpha', 'Constraint alpha from fold A.', 'fixture user 1')])
    await foldOpen(h, parent)
    appendClosedTurn(parent, 3, 'Second parent phase.')
    box.text = writerReply('B', [constraint('beta', 'Constraint beta from fold B.', 'Second parent phase')])
    await foldOpen(h, parent)
    const boundary = h.engine.lastSemanticReceipt?.proof?.replacementSeq
    if (boundary === undefined) throw new Error('fold B has no proof')

    const child = h.ctx.sessions.fork(parent, boundary as never, SessionId(`child-${randomUUID()}`))
    const journal = new FileSemanticJournal(join(root, 'semantic'))
    await h.engine.reconcileSemantics(child)
    const first = await journal.list(child.id)
    const committed = [...first.receipts.values()]
      .filter(receipt => receipt.outcome === 'committed' && receipt.proof !== undefined)
      .sort((left, right) => (left.proof!.commitOrder) - (right.proof!.commitOrder))
    expect(committed).toHaveLength(2)

    const later = committed[1]!
    const dir = join(root, 'semantic', String(child.id))
    await rm(join(dir, `${later.packetId}.json`))
    await rm(join(dir, `${later.packetId}.receipt.json`))

    const repaired = await h.engine.reconcileSemantics(child)
    expect(repaired.health).toBe('ready')
    const after = await journal.list(child.id)
    // R31 returned early because the FIRST receipt existed, leaving size 1.
    expect([...after.receipts.values()].filter(receipt => receipt.outcome === 'committed'))
      .toHaveLength(2)
  }, 60_000)
})
