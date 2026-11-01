/**
 * R31-C5/C7: fail-closed recovery and legacy migration.
 *
 * The journal may be newer than the session log (an older backup), or the
 * session may have committed while the receipt write was interrupted. Those
 * two cross-store cases have OPPOSITE correct answers:
 *
 *   session committed, receipt missing  -> re-prove, then write the receipt
 *   receipt committed, proof missing    -> CONFLICT; never re-grant state
 *
 * These tests write each store independently, then run the real reconciler.
 *
 * @module tests/semantic-recovery
 */

import { describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { makeTemp } from '../eval/tmp.ts'
import { canonicalHash } from '../src/checkpoint/hash.ts'
import { buildBundle } from '../src/checkpoint/compiler.ts'
import { FileBundleStore } from '../src/checkpoint/bundle-store.ts'
import { retireDerivedAnswers } from '../src/checkpoint/inventory.ts'
import { FileSemanticJournal, packetIdOf } from '../src/semantic/journal.ts'
import type { ContinuityAdmission } from '../src/semantic/admission.ts'
import { emptyCurrentState, stateKeyText } from '../src/state/state.ts'
import type { EfAnchorEventData, FoldCurrentState } from '../src/state/state.ts'
import { createHarness } from './harness.ts'
import type { Session as HarnessSession } from './harness.ts'
import {
  LEGACY_SEMANTIC_SCHEMA_VERSION,
  SEMANTIC_SCHEMA_VERSION,
} from '../src/semantic/types.ts'
import type { SemanticPacket, SemanticReceipt } from '../src/semantic/types.ts'

const CHECKPOINT = 'recovery-uuid'
const BODY = `[EF1 L cp:${CHECKPOINT}]\n\nThe timeout is 30 seconds.`
const OPS: readonly EfAnchorEventData[] = [{
  op: 'declare',
  anchor: {
    id: 'semantic-timeout',
    kind: 'constraint',
    stateKey: { namespace: 'semantic', entity: 'constraint', property: 'timeout' },
    value: 'The timeout is 30 seconds.',
    authority: 'normative',
    lifecycle: 'active',
    sourceRefs: [{ seq: SessionSeq(0) }],
  },
}]

function userMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

interface CommittedFixture {
  readonly session: Session
  readonly span: readonly number[]
  readonly body: string
  readonly startSeq: number
  readonly summarySeq: number
  readonly replacementSeq: number
}

/** A real committed fold over the first two surface messages. */
function committedFold(session: Session = Session.create(SessionId(`recovery-${randomUUID()}`))): CommittedFixture {
  if (session.seq === 0) {
    for (const text of ['fixture user 0', 'fixture user 1']) {
      session.append('user/message', userMessage(text), { surfaceOp: 'append' })
    }
  }
  const span = [0, 1]
  const compactionId = CompactionId(randomUUID())
  const lifecycle = { compactionId, turn: null }
  const start = session.append('compaction/start', lifecycle)
  const summary = session.append('compaction/summary', {
    ...lifecycle,
    summary: [{ type: 'text', text: BODY }],
    shadowedRange: { start: SessionSeq(0), end: SessionSeq(1) },
    shadowedSeqs: [SessionSeq(0), SessionSeq(1)],
    shadowedTokenCount: 100,
    provider: 'test',
    model: 'test',
  } as never)
  const replacement = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: BODY }],
    source: compactCheckpointSource(compactionId),
  }), {
    surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(1) },
    sourceEventSeqs: [start.seq, summary.seq, SessionSeq(0), SessionSeq(1)],
  })
  const end = session.append('compaction/end', lifecycle)
  void end
  return {
    session,
    span,
    body: BODY,
    startSeq: Number(start.seq),
    summarySeq: Number(summary.seq),
    replacementSeq: Number(replacement.seq),
  }
}

interface Composite {
  readonly journal: FileSemanticJournal
  readonly store: FileBundleStore
  readonly root: string
}

async function composite(): Promise<Composite> {
  const root = await makeTemp('ef-recovery-')
  return {
    root,
    journal: new FileSemanticJournal(join(root, 'semantic')),
    store: new FileBundleStore(join(root, 'bundles')),
  }
}

async function writeBundleFor(fixture: CommittedFixture, store: FileBundleStore): Promise<string> {
  const messages: Message[] = []
  for (const seq of fixture.span) {
    const event = fixture.session.eventAt(SessionSeq(seq))
    if (event === undefined) throw new Error('missing fixture event')
    const derived = fixture.session.deriveEventMessage(event)
    if (derived === null) throw new Error('fixture event derives no message')
    messages.push(derived)
  }
  const bundle = buildBundle({
    candidate: {
      checkpointId: CHECKPOINT,
      mode: 'leaf',
      sessionId: fixture.session.id,
      preparedSurfaceGeneration: 0,
      sourceDigestSeed: 'recovery-seed',
    },
    orderedSurfaceSeqs: fixture.span.map(seq => SessionSeq(seq)),
    shadowedMessages: messages,
    renderedText: fixture.body,
  })
  await store.write(bundle)
  return bundle.archive.logicalHash
}

function packetFor(
  fixture: CommittedFixture,
  options: { readonly sourceDigest?: string; readonly schemaVersion?: number } = {},
): SemanticPacket {
  const messages: Message[] = []
  for (const seq of fixture.span) {
    const event = fixture.session.eventAt(SessionSeq(seq))
    if (event === undefined) throw new Error('missing fixture event')
    const derived = fixture.session.deriveEventMessage(event)
    if (derived !== null) messages.push(derived)
  }
  const bodyDigest = canonicalHash(fixture.body)
  return {
    schemaVersion: options.schemaVersion ?? SEMANTIC_SCHEMA_VERSION,
    packetId: packetIdOf({
      sessionId: fixture.session.id,
      checkpointId: CHECKPOINT,
      foldedSeqs: fixture.span,
      bodyDigest,
    }),
    sessionId: fixture.session.id,
    checkpointId: CHECKPOINT,
    mode: 'active',
    authority: 'journal',
    status: 'staged',
    spanDigest: canonicalHash([...fixture.span]),
    foldedSeqs: [...fixture.span],
    createdAt: 1,
    stagedAtSeq: fixture.startSeq - 1,
    bodyDigest,
    ...(options.sourceDigest === undefined
      ? { sourceDigest: canonicalHash(retireDerivedAnswers(messages).messages) }
      : { sourceDigest: options.sourceDigest }),
    ops: [...OPS],
    handoff: '',
    deltaParse: 'absent',
    proposed: [],
    accepted: [],
    refused: [],
  }
}

function engineFor(parts: Composite) {
  return createHarness({}, {
    efConfig: {
      semanticContinuity: 'active',
      semanticMode: 'rationale',
      bundleRoot: join(parts.root, 'bundles'),
      semanticRoot: join(parts.root, 'semantic'),
    },
    semanticJournal: parts.journal,
    bundleStore: parts.store,
  })
}

/** Read the engine's semantic admission without running a fold. */
async function admissionOf(
  engine: { reconcileSemantics(session: HarnessSession): Promise<unknown> },
  session: HarnessSession,
): Promise<ContinuityAdmission> {
  const internal = engine as unknown as {
    semanticAdmissionOf(session: HarnessSession, base: FoldCurrentState): Promise<ContinuityAdmission>
  }
  return await internal.semanticAdmissionOf(session, emptyCurrentState())
}

/** The state a caller may use; a blocked admission is never a complete state. */
async function semanticStateOf(
  engine: { reconcileSemantics(session: HarnessSession): Promise<unknown> },
  session: HarnessSession,
): Promise<FoldCurrentState> {
  const admission = await admissionOf(engine, session)
  return admission.mode === 'active' ? admission.state : emptyCurrentState()
}

describe('R31-C5: cross-store recovery is fail-closed', () => {
  it('recovers a committed session whose receipt is missing', async () => {
    const parts = await composite()
    const fixture = committedFold()
    const sourceDigest = await writeBundleFor(fixture, parts.store)
    const packet = packetFor(fixture, { sourceDigest })
    await parts.journal.write(packet)

    const h = await engineFor(parts)
    const report = await h.engine.reconcileSemantics(fixture.session as unknown as HarnessSession)
    expect(report.activated).toBe(1)
    expect(report.health).toBe('ready')

    const read = await parts.journal.list(fixture.session.id)
    const receipt = read.receipts.get(packet.packetId)
    expect(receipt?.outcome).toBe('committed')
    expect(receipt?.proof?.replacementSeq).toBe(fixture.replacementSeq)

    const state = await semanticStateOf(h.engine, fixture.session as unknown as HarnessSession)
    expect(state.constraints['semantic-timeout']?.value).toBe('The timeout is 30 seconds.')
  })

  it('marks a committed receipt with no log proof as conflict and never re-appends', async () => {
    const parts = await composite()
    const fixture = committedFold()
    const sourceDigest = await writeBundleFor(fixture, parts.store)
    const packet = packetFor(fixture, { sourceDigest })
    await parts.journal.write(packet)
    const receipt: SemanticReceipt = {
      kind: 'receipt',
      schemaVersion: SEMANTIC_SCHEMA_VERSION,
      packetId: packet.packetId,
      sessionId: packet.sessionId,
      checkpointId: packet.checkpointId,
      outcome: 'committed',
      proof: {
        proofVersion: 1,
        sessionId: String(packet.sessionId),
        checkpointId: packet.checkpointId,
        compactionId: 'compaction-elsewhere',
        startSeq: 1,
        summarySeq: 2,
        replacementSeq: 3,
        shadowedSeqs: [...fixture.span],
        spanDigest: canonicalHash([...fixture.span]),
        sourceDigest,
        bodyDigest: packet.bodyDigest,
        summaryDigest: 'elsewhere',
        commitOrder: 3,
        unclosed: false,
      },
      opsDigest: canonicalHash(packet.ops),
      decidedAt: 1,
    }
    await parts.journal.writeReceipt(receipt)

    // The session the journal was written against is NOT this log: a restore
    // from an older backup with the same identity but different history.
    const other = Session.create(fixture.session.id)
    other.append('user/message', userMessage('unrelated history'), { surfaceOp: 'append' })
    const before = other.seq

    const h = await engineFor(parts)
    const report = await h.engine.reconcileSemantics(other as unknown as HarnessSession)
    expect(report.health).toBe('partial')
    expect(report.detail).toMatch(/cannot prove|no valid proof/u)
    expect(other.seq).toBe(before)

    const admission = await admissionOf(h.engine, other as unknown as HarnessSession)
    expect(admission.mode).toBe('blocked')
    const state = await semanticStateOf(h.engine, other as unknown as HarnessSession)
    expect(state.constraints['semantic-timeout']).toBeUndefined()
    expect(state.stateHeads[stateKeyText({
      namespace: 'semantic', entity: 'constraint', property: 'timeout',
    })]).toBeUndefined()

    // The receipt is immutable: no "repair" rewrite happened.
    const read = await parts.journal.list(other.id)
    expect(read.receipts.size).toBe(1)
    expect(await readFile(
      join(parts.root, 'semantic', String(other.id), `${packet.packetId}.receipt.json`),
      'utf8',
    )).toContain('"committed"')
  })
})

describe('R31-C7: legacy migration requires a verified bundle and a proof', () => {
  it('migrates a v3 journal packet, preserves the old file, and applies it once', async () => {
    const parts = await composite()
    const fixture = committedFold()
    const sourceDigest = await writeBundleFor(fixture, parts.store)
    const modern = packetFor(fixture, { sourceDigest })
    const legacy = {
      ...modern,
      schemaVersion: LEGACY_SEMANTIC_SCHEMA_VERSION,
      status: 'activated',
    } as SemanticPacket
    delete (legacy as { sourceDigest?: string }).sourceDigest
    const dir = join(parts.root, 'semantic', String(fixture.session.id))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${modern.packetId}.json`), JSON.stringify({
      kind: 'packet',
      schemaVersion: LEGACY_SEMANTIC_SCHEMA_VERSION,
      packet: legacy,
    }), 'utf8')

    const h = await engineFor(parts)
    const report = await h.engine.reconcileSemantics(fixture.session as unknown as HarnessSession)
    expect(report.health).toBe('ready')
    expect(h.engine.semanticDiagnostics.reconciled).toBeGreaterThan(0)

    const read = await parts.journal.list(fixture.session.id)
    expect(read.packets.map(entry => entry.packetId)).toContain(modern.packetId)
    expect(read.receipts.get(modern.packetId)?.outcome).toBe('committed')
    expect(read.legacy.map(entry => entry.packetId)).toContain(modern.packetId)
    // The original bytes are preserved under an audit name.
    expect(await readFile(join(dir, `${modern.packetId}.v3.json`), 'utf8')).toContain('"schemaVersion":3')

    const state = await semanticStateOf(h.engine, fixture.session as unknown as HarnessSession)
    expect(state.constraints['semantic-timeout']?.value).toBe('The timeout is 30 seconds.')

    // Idempotent: a second pass writes nothing and reports no conflict.
    const second = await h.engine.reconcileSemantics(fixture.session as unknown as HarnessSession)
    expect(second.health).toBe('ready')
    expect(second.activated).toBe(0)
  })

  it('migrates a legacy session-record only when the bundle proves its source', async () => {
    const parts = await composite()
    const fixture = committedFold()
    await writeBundleFor(fixture, parts.store)
    // The old session-record authority: ops and body digest, no source digest.
    const packet = packetFor(fixture, {
      sourceDigest: canonicalHash(retireDerivedAnswers([]).messages),
    })
    const untyped = fixture.session as unknown as {
      append(type: string, data: unknown): unknown
    }
    untyped.append('ef/semantic', {
      schemaVersion: LEGACY_SEMANTIC_SCHEMA_VERSION,
      packetId: packet.packetId,
      checkpointId: CHECKPOINT,
      foldedSeqs: [...fixture.span],
      bodyDigest: packet.bodyDigest,
      ops: [...OPS],
    })

    const h = await engineFor(parts)
    const report = await h.engine.reconcileSemantics(fixture.session as unknown as HarnessSession)
    expect(report.health).toBe('ready')
    const read = await parts.journal.list(fixture.session.id)
    expect(read.receipts.get(packet.packetId)?.outcome).toBe('committed')

    const state = await semanticStateOf(h.engine, fixture.session as unknown as HarnessSession)
    expect(state.constraints['semantic-timeout']?.value).toBe('The timeout is 30 seconds.')
  })

  it('does not migrate when the bundle is absent: no bundle, no source identity', async () => {
    const parts = await composite()
    const fixture = committedFold()
    const modern = packetFor(fixture)
    const legacy = {
      ...modern,
      schemaVersion: LEGACY_SEMANTIC_SCHEMA_VERSION,
      status: 'activated',
    } as SemanticPacket
    delete (legacy as { sourceDigest?: string }).sourceDigest
    const dir = join(parts.root, 'semantic', String(fixture.session.id))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${modern.packetId}.json`), JSON.stringify({
      kind: 'packet',
      schemaVersion: LEGACY_SEMANTIC_SCHEMA_VERSION,
      packet: legacy,
    }), 'utf8')

    const h = await engineFor(parts)
    const report = await h.engine.reconcileSemantics(fixture.session as unknown as HarnessSession)
    expect(report.health).toBe('partial')
    expect(report.unrepairable).toBeGreaterThan(0)
    const read = await parts.journal.list(fixture.session.id)
    expect(read.receipts.size).toBe(0)
    expect(read.packets).toHaveLength(0)
  })
})
