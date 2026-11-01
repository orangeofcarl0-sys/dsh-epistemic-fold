/**
 * R32-B: recovery admission and historical-proof hardening.
 *
 * A missing journal directory is not the same fact as an unreadable one, and an
 * unreadable one is not the same fact as an empty one. These tests separate
 * them, then prove that a blocked fold still archives history and still shows
 * the model an explicit degradation instead of a complete-looking state.
 *
 * @module tests/r32-recovery
 */

import { describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { makeTemp } from '../eval/tmp.ts'
import { classifyPacket } from '../src/semantic/commit.ts'
import { FileSemanticJournal, NullSemanticJournal } from '../src/semantic/journal.ts'
import type { JournalRead, SemanticJournal } from '../src/semantic/journal.ts'
import { proveFoldCommit } from '../src/semantic/proof.ts'
import type { ContinuityAdmission } from '../src/semantic/admission.ts'
import { emptyCurrentState } from '../src/state/state.ts'
import type { FoldCurrentState } from '../src/state/state.ts'
import { locateFoldFrontier } from '../src/fold/frontier.ts'
import {
  SIGNAL,
  conversation,
  createHarness,
  foldAgent,
  type Harness,
  type Session as HarnessSession,
} from './harness.ts'
import { CHECKPOINT, commitFold, packetFor, sessionWithSpan } from './r32-fixtures.ts'

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

async function foldOpen(h: Harness, session: HarnessSession): Promise<string> {
  const frontier = locateFoldFrontier(session)
  const nodes = [...session.surface.nodes]
  const start = nodes[frontier.firstOpenPosition]
  const end = nodes[nodes.length - 1]
  if (start === undefined || end === undefined) throw new Error('nothing to fold')
  await h.engine.compactRegion(start, end, foldAgent(session), SIGNAL)
  await h.engine.reconcileSemantics(session)
  return h.engine.publishedBundle?.rendered.text ?? ''
}

async function admissionOf(
  h: Harness,
  session: HarnessSession,
): Promise<ContinuityAdmission> {
  const internal = h.engine as unknown as {
    semanticAdmissionOf(
      session: HarnessSession,
      base: FoldCurrentState,
    ): Promise<ContinuityAdmission>
  }
  return await internal.semanticAdmissionOf(session, emptyCurrentState())
}

function bodyAt(session: Session, summarySeq: number): string {
  const data = session.eventAt(SessionSeq(summarySeq))?.data as {
    summary?: readonly { readonly text?: string }[]
  } | undefined
  return data?.summary?.map(block => block.text ?? '').join('\n') ?? ''
}

/** A journal whose reads fail with a chosen errno, without relying on Windows ACLs. */
class InjectedFailureJournal implements SemanticJournal {
  constructor(private readonly code: 'EACCES' | 'EIO') {}
  async write(): Promise<void> {}
  async writeReceipt(): Promise<void> {}
  async hasSession(): Promise<boolean> { return true }
  async sessionState(): Promise<'present'> { return 'present' }
  async list(): Promise<JournalRead> {
    throw Object.assign(new Error(this.code === 'EACCES' ? 'permission denied' : 'i/o error'), {
      code: this.code,
    })
  }
}

describe('R32-B: journal presence is three-valued', () => {
  it('treats ENOENT on a new session as a valid empty journal', async () => {
    const root = await makeTemp('ef-r32-recovery-')
    const journal = new FileSemanticJournal(join(root, 'semantic'))
    const read = await journal.list(SessionId('brand-new'))
    expect(read.state).toBe('valid-empty')
    expect(read.packets).toHaveLength(0)
    expect(read.invalid).toHaveLength(0)
    expect(await journal.sessionState(SessionId('brand-new'))).toBe('absent')
    expect(await journal.hasSession(SessionId('brand-new'))).toBe(false)
  })

  it('reports a directory-shaped file as UNREADABLE, not as an empty journal', async () => {
    const root = await makeTemp('ef-r32-recovery-')
    const id = `unreadable-${randomUUID()}`
    await writeFile(join(root, id), 'not a directory', 'utf8')
    const journal = new FileSemanticJournal(root)
    const read = await journal.list(SessionId(id))
    expect(read.state).toBe('unreadable')
    expect(read.invalid.some(issue => issue.code === 'io')).toBe(true)
    expect(await journal.sessionState(SessionId(id))).toBe('unreadable')
  })

  it('blocks an Active fold when the journal read throws EACCES', async () => {
    const h = await createHarness({}, {
      efConfig: { semanticContinuity: 'active', semanticMode: 'rationale' },
      semanticJournal: new InjectedFailureJournal('EACCES'),
      projection: true,
    })
    const session = conversation(1)
    const report = await h.engine.reconcileSemantics(session)
    expect(report.health).toBe('unavailable')
    expect(report.detail).toMatch(/permission denied/u)
    expect((await admissionOf(h, session)).mode).toBe('blocked')
  })

  it('blocks an Active fold when the journal read throws EIO', async () => {
    const h = await createHarness({}, {
      efConfig: { semanticContinuity: 'active', semanticMode: 'rationale' },
      semanticJournal: new InjectedFailureJournal('EIO'),
      projection: true,
    })
    const session = conversation(1)
    const report = await h.engine.reconcileSemantics(session)
    expect(report.health).toBe('unavailable')
    expect(report.detail).toMatch(/i\/o error/u)
    expect((await admissionOf(h, session)).mode).toBe('blocked')
  })

  it('reports a corrupt packet as an integrity problem', async () => {
    const root = await makeTemp('ef-r32-recovery-')
    const id = `corrupt-${randomUUID()}`
    const journal = new FileSemanticJournal(join(root, 'semantic'))
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(journal.root, id), { recursive: true })
    await writeFile(join(journal.root, id, 'junk.json'), 'not json', 'utf8')
    const read = await journal.list(SessionId(id))
    expect(read.state).toBe('ok')
    expect(read.invalid.some(issue => issue.code === 'corrupt' || issue.code === 'io')).toBe(true)
  })
})

describe('R32-B: a blocked fold does not write semantic state but still archives', () => {
  it('shows the degradation, stages no packet, and keeps exact recall working', async () => {
    const root = await makeTemp('ef-r32-recovery-')
    const box = { text: writerReply('start', []) }
    const h = await createHarness(
      { textFor: options => isWriterCall(options) ? box.text : 'digest' },
      {
        plugin: true,
        systemPrompt: true,
        tools: true,
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
    const session = conversation(2)
    const journal = new FileSemanticJournal(join(root, 'semantic'))
    // A receipt with no packet is a contradiction the engine must refuse to
    // write on top of. The aborted outcome keeps the schema valid.
    const orphanDir = join(journal.root, String(session.id))
    const { mkdir } = await import('node:fs/promises')
    await mkdir(orphanDir, { recursive: true })
    await writeFile(join(orphanDir, 'orphan.receipt.json'), JSON.stringify({
      kind: 'receipt-file',
      schemaVersion: 4,
      receipt: {
        kind: 'receipt',
        schemaVersion: 4,
        packetId: 'orphan',
        sessionId: session.id,
        checkpointId: 'cp-orphan',
        outcome: 'aborted',
        opsDigest: 'no-ops',
        decidedAt: 1,
      },
    }), 'utf8')

    // The harness does not inject this journal; the engine was built with the
    // file journal at the same root, so the orphan is already visible.
    box.text = writerReply('must not commit', [{
      kind: 'constraint',
      subjectKey: 'r32-blocked',
      statement: 'This must never become semantic state while blocked.',
      status: 'claimed',
      evidence: [{ quote: 'fixture' }],
    }])
    const body = await foldOpen(h, session)

    expect(body).toContain('SEMANTIC STATE INCOMPLETE')
    expect(body).toContain('semantic continuity withheld')
    expect(body).not.toContain('This must never become semantic state while blocked.')

    const read = await journal.list(session.id)
    expect(read.packets).toHaveLength(0)
    expect(read.orphans).toHaveLength(1)
    expect(h.engine.semanticDiagnostics.health).toBe('partial')

    // History is archived and exact recall still returns it. A blocked semantic
    // layer must not turn a context-overflow recovery into a lost run.
    const bundle = h.engine.publishedBundle
    expect(bundle).toBeDefined()
    const recall = await h.ctx.tools.execute({
      callId: ToolCallId(`call-${randomUUID()}`),
      name: 'context_recall',
      arguments: {
        ref: `cp:${bundle?.checkpointId ?? ''}`,
        depth: 'exact',
        offset: 0,
        limit: 1,
      },
      agent: foldAgent(session),
      signal: SIGNAL,
    })
    expect(recall.isError).toBe(false)
    expect(JSON.stringify(recall.content)).toContain('fixture')
  }, 60_000)
})

describe('R32-B: the historical replacement is checked field by field', () => {
  it('rejects a replacement whose surface range is not the summary range', () => {
    const session = sessionWithSpan()
    const seqs = commitFold(session, { wrongRange: true })
    const body = bodyAt(session, seqs.summarySeq)
    const packet = packetFor({ session, span: [0, 1], body })
    const verdict = proveFoldCommit(packet, session)
    expect(verdict.status).toBe('aborted')
    if (verdict.status === 'aborted') expect(verdict.reason).toBe('summary-without-replacement')
  })

  it('rejects a replacement whose source citations are out of order', () => {
    const session = sessionWithSpan()
    const seqs = commitFold(session, { wrongSourceOrder: true })
    const packet = packetFor({ session, span: [0, 1], body: bodyAt(session, seqs.summarySeq) })
    const verdict = proveFoldCommit(packet, session)
    expect(verdict.status).toBe('aborted')
  })

  it('rejects a replacement whose source names another compaction', () => {
    const session = sessionWithSpan()
    const seqs = commitFold(session, { wrongCompaction: true })
    const packet = packetFor({ session, span: [0, 1], body: bodyAt(session, seqs.summarySeq) })
    const verdict = proveFoldCommit(packet, session)
    expect(verdict.status).toBe('aborted')
  })

  it('settles a summary with no replacement when the transaction closed with an error', () => {
    const session = sessionWithSpan()
    const seqs = commitFold(session, { omitReplacement: true, endError: 'shrink check failed' })
    const packet = packetFor({ session, span: [0, 1], body: bodyAt(session, seqs.summarySeq) })
    const verdict = proveFoldCommit(packet, session, { inFlight: true })
    expect(verdict.status).toBe('aborted')
    if (verdict.status === 'aborted') {
      expect(verdict.reason).toBe('summary-without-replacement')
      expect(verdict.detail).toContain('shrink check failed')
    }
    const classified = classifyPacket(packet, session, { inFlight: true })
    expect(classified.status).toBe('archived-only')
  })

  it('treats an open compaction that outlived its process as terminated, not pending', () => {
    const session = sessionWithSpan()
    const start = session.append('compaction/start', {
      compactionId: CompactionId('crashed-compaction'),
      turn: null,
    })
    const packet = packetFor({
      session,
      span: [0, 1],
      body: `[EF1 L cp:${CHECKPOINT}]\n\nnever written`,
      stagedAtSeq: Number(start.seq) + 1,
    })
    const live = proveFoldCommit(packet, session, { inFlight: true })
    expect(live.status).toBe('unresolved')
    const restarted = proveFoldCommit(packet, session)
    expect(restarted.status).toBe('aborted')
    if (restarted.status === 'aborted') expect(restarted.reason).toBe('compaction-crashed-open')
  })
})

describe('R32-B: the null journal stays honest', () => {
  it('reports valid-empty and absent rather than pretending a session exists', async () => {
    const journal: SemanticJournal = new NullSemanticJournal()
    const read = await journal.list(SessionId('null-session'))
    expect(read.state).toBe('valid-empty')
    expect(await journal.sessionState(SessionId('null-session'))).toBe('absent')
  })
})
