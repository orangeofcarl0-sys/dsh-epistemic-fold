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
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { locateFoldFrontier } from '../src/fold/frontier.ts'
import { FileSemanticJournal } from '../src/semantic/journal.ts'
import type { ContinuityAdmission } from '../src/semantic/admission.ts'
import { emptyCurrentState } from '../src/state/state.ts'
import type { FoldCurrentState } from '../src/state/state.ts'
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

/** The engine's admission, for state assertions without running a fold. */
async function admissionOf(
  h: Harness,
  session: Session,
): Promise<ContinuityAdmission> {
  const internal = h.engine as unknown as {
    semanticAdmissionOf(session: Session, base: FoldCurrentState): Promise<ContinuityAdmission>
  }
  return await internal.semanticAdmissionOf(session, emptyCurrentState())
}

/** A parent with two committed semantic folds, and a child forked through B. */
async function twoCommitFork(): Promise<{
  readonly h: Harness
  readonly root: string
  readonly parent: Session
  readonly child: Session
  readonly childJournal: FileSemanticJournal
  readonly committed: readonly { readonly packetId: string; readonly commitOrder: number }[]
}> {
  const { h, root, box } = await harness()
  const parent = h.ctx.sessions.create(SessionId(`parent-${randomUUID()}`), { meta: { cwd: root } })
  seedConversation(parent)

  box.text = writerReply('A', [constraint('alpha', 'Constraint alpha from fold A.', 'fixture user 1')])
  await foldOpen(h, parent)
  appendClosedTurn(parent, 3, 'Second parent phase.')
  box.text = writerReply('B', [constraint('beta', 'Constraint beta from fold B.', 'Second parent phase')])
  await foldOpen(h, parent)
  const boundary = h.engine.lastSemanticReceipt?.proof?.replacementSeq
  if (boundary === undefined) throw new Error('parent fold B has no proof')

  const child = h.ctx.sessions.fork(parent, boundary as never, SessionId(`child-${randomUUID()}`))
  const childJournal = new FileSemanticJournal(join(root, 'semantic'))
  const first = await h.engine.reconcileSemantics(child)
  expect(first.health).toBe('ready')
  const read = await childJournal.list(child.id)
  const committed = [...read.receipts.values()]
    .filter(receipt => receipt.outcome === 'committed' && receipt.proof !== undefined)
    .map(receipt => ({ packetId: receipt.packetId, commitOrder: receipt.proof!.commitOrder }))
    .sort((left, right) => left.commitOrder - right.commitOrder)
  expect(committed).toHaveLength(2)
  return { h, root, parent, child, childJournal, committed }
}

describe('R32-C: fork inheritance is idempotent and complete', () => {
  it('fills the missing second commit after a partial first receipt', async () => {
    const { h, root, child, childJournal, committed } = await twoCommitFork()
    const later = committed[1]!
    const dir = join(root, 'semantic', String(child.id))
    await rm(join(dir, `${later.packetId}.json`))
    await rm(join(dir, `${later.packetId}.receipt.json`))

    const partial = await childJournal.list(child.id)
    expect(partial.receipts.size).toBe(1)

    const repaired = await h.engine.reconcileSemantics(child)
    expect(repaired.health).toBe('ready')
    const after = await childJournal.list(child.id)
    const restored = [...after.receipts.values()].filter(receipt => receipt.outcome === 'committed')
    expect(restored).toHaveLength(2)
    expect(restored.some(receipt => receipt.packetId === later.packetId)).toBe(true)

    const admission = await admissionOf(h, child)
    expect(admission.mode).toBe('active')
    if (admission.mode === 'active') {
      expect(Object.values(admission.state.constraints).map(anchor => anchor.value))
        .toEqual(expect.arrayContaining(['Constraint alpha from fold A.', 'Constraint beta from fold B.']))
    }
  }, 60_000)

  it('writes only the missing receipt when the second packet survived', async () => {
    const { h, root, child, childJournal, committed } = await twoCommitFork()
    const later = committed[1]!
    const dir = join(root, 'semantic', String(child.id))
    await rm(join(dir, `${later.packetId}.receipt.json`))
    const partial = await childJournal.list(child.id)
    expect(partial.packets.some(packet => packet.packetId === later.packetId)).toBe(true)
    expect(partial.receipts.has(later.packetId)).toBe(false)

    const repaired = await h.engine.reconcileSemantics(child)
    expect(repaired.health).toBe('ready')
    const after = await childJournal.list(child.id)
    expect(after.receipts.get(later.packetId)?.outcome).toBe('committed')
  }, 60_000)

  it('is idempotent: a repeated pass writes no new files and does not change state', async () => {
    const { h, root, child } = await twoCommitFork()
    const dir = join(root, 'semantic', String(child.id))
    const beforeFiles = (await readdir(dir)).sort()
    const before = await admissionOf(h, child)
    expect(before.mode).toBe('active')

    const report = await h.engine.reconcileSemantics(child)
    expect(report.health).toBe('ready')
    expect(report.activated).toBe(0)
    expect((await readdir(dir)).sort()).toEqual(beforeFiles)
    const after = await admissionOf(h, child)
    expect(after).toEqual(before)
  }, 60_000)

  it('blocks rather than guessing when the parent journal disappears', async () => {
    const { h, root, parent, child, childJournal } = await twoCommitFork()
    const parentDir = join(root, 'semantic', String(parent.id))
    await rm(parentDir, { recursive: true, force: true })

    const report = await h.engine.reconcileSemantics(child)
    expect(report.health).toBe('partial')
    expect(report.detail).toMatch(/parent journal directory is not present/u)
    const read = await childJournal.list(child.id)
    // No NEW commit was fabricated from the surviving child rows.
    expect(read.receipts.size).toBe(2)
  }, 60_000)

  it('blocks when a parent packet no longer agrees with its receipt source digest', async () => {
    const { h, root, parent, child } = await twoCommitFork()
    const parentJournal = new FileSemanticJournal(join(root, 'semantic'))
    const parentRead = await parentJournal.list(parent.id)
    const first = parentRead.packets[0]
    if (first === undefined) throw new Error('parent has no packet')
    const path = join(root, 'semantic', String(parent.id), `${first.packetId}.json`)
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { packet: Record<string, unknown> }
    await writeFile(path, JSON.stringify({
      ...parsed,
      packet: { ...parsed.packet, sourceDigest: 'a-different-archive' },
    }, null, 2), 'utf8')

    const report = await h.engine.reconcileSemantics(child)
    expect(report.health).toBe('partial')
    expect(report.detail).toMatch(/internally inconsistent/u)
  }, 60_000)
})

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
