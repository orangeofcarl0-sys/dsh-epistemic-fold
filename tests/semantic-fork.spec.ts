/**
 * R31-D4: fork boundaries for semantic state.
 *
 * DSH forks copy the event log through an inclusive seq and assign the child a
 * NEW session id. The journal is keyed by session id, so the child has no rows
 * even though its log contains the parent's prefix. The engine seeds exactly
 * the parent commits BEFORE the cut; later commits cannot cross it.
 *
 * When the parent journal cannot be found, the engine cannot tell "no state"
 * from "lost state", so it blocks Active writing for that child and says so.
 *
 * @module tests/semantic-fork
 */

import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
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

function isWriterCall(options: { readonly messages: readonly { readonly content: readonly { readonly type: string; readonly text?: string }[] }[] }): boolean {
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

async function foldOpen(h: Harness, session: Session): Promise<string> {
  const frontier = locateFoldFrontier(session)
  const nodes = [...session.surface.nodes]
  const start = nodes[frontier.firstOpenPosition]
  const end = nodes[nodes.length - 1]
  if (start === undefined || end === undefined) throw new Error('nothing to fold')
  await h.engine.compactRegion(start, end, foldAgent(session), SIGNAL)
  await h.engine.reconcileSemantics(session)
  return h.engine.publishedBundle!.rendered.text
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

async function harness(): Promise<{ readonly h: Harness; readonly root: string; readonly box: { text: string } }> {
  const root = await makeTemp('ef-r31-fork-')
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
  return { h, root, box }
}

describe('R31-D4: a child inherits A and B, never C', () => {
  it('seeds commits before the fork boundary and excludes later ones', async () => {
    const { h, root, box } = await harness()
    const parent = h.ctx.sessions.create(SessionId(`parent-${randomUUID()}`), {
      meta: { cwd: root },
    })
    seedConversation(parent)

    box.text = writerReply('A', [constraint('alpha', 'Constraint alpha from fold A.', 'fixture user 1')])
    await foldOpen(h, parent)
    appendClosedTurn(parent, 3, 'Second parent phase.')
    box.text = writerReply('B', [constraint('beta', 'Constraint beta from fold B.', 'Second parent phase')])
    await foldOpen(h, parent)
    const bReplacement = h.engine.publishedBundle!.rendered.text.includes('cp:')
      ? h.engine.lastSemanticPacket?.checkpointId
      : undefined
    expect(bReplacement).toBeTypeOf('string')
    const bSeq = h.engine.lastSemanticReceipt?.proof?.replacementSeq
    expect(bSeq).toBeTypeOf('number')

    // ---- Fork THROUGH fold B. The child has A and B in its log.
    const child = h.ctx.sessions.fork(
      parent,
      bSeq as never,
      SessionId(`child-${randomUUID()}`),
    )
    expect(child.header.parentSession).toBe(parent.id)
    expect(Number(child.inheritedEventCount)).toBe((bSeq as number) + 1)
    expect(child.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)

    // ---- Parent continues with fold C AFTER the fork.
    appendClosedTurn(parent, 4, 'Third parent phase after fork.')
    box.text = writerReply('C', [constraint('gamma', 'Constraint gamma from fold C.', 'Third parent phase')])
    const parentBody = await foldOpen(h, parent)
    expect(parentBody).toContain('Constraint gamma from fold C.')

    // ---- Child reconciles: it must inherit A and B, not C.
    const inherited = await h.engine.reconcileSemantics(child)
    expect(inherited.health).toBe('ready')
    const childJournal = await new FileSemanticJournal(join(root, 'semantic')).list(child.id)
    const committed = [...childJournal.receipts.values()].filter(receipt => receipt.outcome === 'committed')
    expect(committed).toHaveLength(2)
    expect(committed.every(receipt => (receipt.proof?.commitOrder ?? Infinity) < Number(child.inheritedEventCount)))
      .toBe(true)
    // A new child-owned packet id, not the parent's row.
    expect(committed.every(receipt => receipt.sessionId === child.id)).toBe(true)

    // ---- A child fold renders A and B, and no C.
    appendClosedTurn(child, 4, 'Child continues.')
    box.text = writerReply('child', [])
    const childBody = await foldOpen(h, child)
    expect(childBody).toContain('Constraint alpha from fold A.')
    expect(childBody).toContain('Constraint beta from fold B.')
    expect(childBody).not.toContain('Constraint gamma from fold C.')
    expect(h.engine.semanticDiagnostics.health).toBe('ready')
  }, 60_000)

  it('blocks Active writing when the parent journal cannot be found', async () => {
    const { h, root, box } = await harness()
    // A parent with NO semantic journal directory: it never ran an active fold.
    const parent = h.ctx.sessions.create(SessionId(`parent-empty-${randomUUID()}`), {
      meta: { cwd: root },
    })
    seedConversation(parent)
    const boundary = parent.seq - 1
    const child = h.ctx.sessions.fork(
      parent,
      boundary as never,
      SessionId(`child-blocked-${randomUUID()}`),
    )

    const report = await h.engine.reconcileSemantics(child)
    expect(report.health).toBe('partial')
    expect(report.detail).toMatch(/parent journal directory is not present/u)

    appendClosedTurn(child, 3, 'Blocked child continues.')
    box.text = writerReply('should not commit', [constraint('delta', 'Constraint delta must not be written.', 'Blocked child continues')])
    const body = await foldOpen(h, child)
    // The degradation is VISIBLE, and no new semantic packet was committed.
    expect(body).toContain('semantic continuity withheld')
    expect(body).not.toContain('Constraint delta must not be written.')
    const journal = await new FileSemanticJournal(join(root, 'semantic')).list(child.id)
    expect(journal.packets).toHaveLength(0)
    expect(h.engine.semanticDiagnostics.health).toBe('partial')
  }, 60_000)
})
