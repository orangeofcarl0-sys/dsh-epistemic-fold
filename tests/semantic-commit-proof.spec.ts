/**
 * R31-B: historical fold commit proof.
 *
 * These fixtures build the REAL event transaction Basic appends — start,
 * summary, replacement, end — on a real DSH Session. They then change the
 * CURRENT surface and assert that the historical verdict does not move. That
 * is the property the old `surface.nodes.includes(...)` classifier could not
 * have: it confused "still resident" with "ever committed".
 *
 * @module tests/semantic-commit-proof
 */

import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { canonicalHash } from '../src/checkpoint/hash.ts'
import { retireDerivedAnswers } from '../src/checkpoint/inventory.ts'
import { proveFoldCommit } from '../src/semantic/proof.ts'
import { classifyPacket } from '../src/semantic/commit.ts'
import { SEMANTIC_SCHEMA_VERSION } from '../src/semantic/types.ts'
import type { SemanticPacket } from '../src/semantic/types.ts'

const BODY = '[EF1 L cp:cp-1]\n\nChanged in this fold\n- The timeout is 30 seconds.'

function userMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Open a session with two surface messages the first fold can shadow. */
function sessionWithSpan(): { session: Session; span: number[] } {
  const session = Session.create(SessionId(`proof-${randomUUID()}`))
  for (const text of ['fixture user 0', 'fixture user 1']) {
    session.append('user/message', userMessage(text), { surfaceOp: 'append' })
  }
  return { session, span: [0, 1] }
}

interface FoldOptions {
  readonly body?: string
  /** Span to replace; defaults to [0,1] for the first fold. */
  readonly span?: readonly number[]
  readonly omitReplacement?: boolean
  readonly omitEnd?: boolean
  readonly endError?: string
}

interface FoldSeqs {
  readonly compactionId: string
  readonly startSeq: number
  readonly summarySeq: number
  readonly replacementSeq?: number
  readonly endSeq?: number
}

/** Append the exact event shape Basic's `commitCompactionBody` writes. */
function commitFold(session: Session, options: FoldOptions = {}): FoldSeqs {
  const body = options.body ?? BODY
  const span = [...(options.span ?? [0, 1])]
  const compactionId = CompactionId(randomUUID())
  const lifecycle = { compactionId, turn: null }
  const start = session.append('compaction/start', lifecycle)
  const summary = session.append('compaction/summary', {
    ...lifecycle,
    summary: [{ type: 'text', text: body }],
    shadowedRange: { start: SessionSeq(span[0]!), end: SessionSeq(span[span.length - 1]!) },
    shadowedSeqs: span.map(seq => SessionSeq(seq)),
    shadowedTokenCount: 100,
    provider: 'test',
    model: 'test',
  } as never)
  let replacementSeq: number | undefined
  if (options.omitReplacement !== true) {
    const replacement = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: body }],
      source: compactCheckpointSource(compactionId),
    }), {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(span[0]!), endSeq: SessionSeq(span[span.length - 1]!) },
      sourceEventSeqs: [start.seq, summary.seq, ...span.map(seq => SessionSeq(seq))],
    })
    replacementSeq = Number(replacement.seq)
  }
  let endSeq: number | undefined
  if (options.omitEnd !== true) {
    const end = session.append('compaction/end', {
      ...lifecycle,
      ...(options.endError === undefined ? {} : { error: options.endError }),
    })
    endSeq = Number(end.seq)
  }
  return {
    compactionId,
    startSeq: Number(start.seq),
    summarySeq: Number(summary.seq),
    ...(replacementSeq === undefined ? {} : { replacementSeq }),
    ...(endSeq === undefined ? {} : { endSeq }),
  }
}

/** The packet a fold would have staged, with its real source-content digest. */
function packetFor(session: Session, options: {
  readonly span?: readonly number[]
  readonly body?: string
  readonly stagedAtSeq: number
  readonly sourceDigest?: string
}): SemanticPacket {
  const span = [...(options.span ?? [0, 1])]
  const body = options.body ?? BODY
  let sourceDigest = options.sourceDigest
  if (sourceDigest === undefined) {
    const messages: Message[] = []
    for (const seq of span) {
      const event = session.eventAt(SessionSeq(seq))
      if (event === undefined) throw new Error(`fixture has no event ${seq}`)
      const derived = session.deriveEventMessage(event)
      if (derived === null) throw new Error(`fixture event ${seq} derives no message`)
      messages.push(derived)
    }
    sourceDigest = canonicalHash(retireDerivedAnswers(messages).messages)
  }
  return {
    schemaVersion: SEMANTIC_SCHEMA_VERSION,
    packetId: `packet-${randomUUID()}`,
    sessionId: session.id,
    checkpointId: 'cp-1',
    mode: 'active',
    authority: 'journal',
    status: 'staged',
    spanDigest: canonicalHash(span),
    foldedSeqs: span,
    createdAt: 1,
    stagedAtSeq: options.stagedAtSeq,
    bodyDigest: canonicalHash(body),
    sourceDigest,
    ops: [],
    handoff: '',
    deltaParse: 'absent',
    proposed: [],
    accepted: [],
    refused: [],
  }
}

describe('R31-B1: commit proof is independent of current residency', () => {
  it('proves a fold that committed and was later folded away', () => {
    const { session } = sessionWithSpan()
    const first = commitFold(session)
    const packet = packetFor(session, { stagedAtSeq: first.startSeq - 1 })

    const before = proveFoldCommit(packet, session)
    expect(before.status).toBe('committed')
    if (before.status !== 'committed') return
    expect(before.proof.replacementSeq).toBe(first.replacementSeq)
    expect(before.proof.unclosed).toBe(false)

    // A second fold shadows the first replacement. The first checkpoint is no
    // longer resident; that must not change what history says about its commit.
    const second = commitFold(session, { span: [first.replacementSeq!], body: '[EF1 L cp:cp-2]\n\nsecond' })
    expect(session.surface.nodes).not.toContain(first.replacementSeq)
    expect(session.surface.nodes).toContain(second.replacementSeq)

    const after = proveFoldCommit(packet, session)
    expect(after.status).toBe('committed')
    if (after.status !== 'committed') return
    expect(after.proof).toEqual(before.proof)
  })

  it('classifies an already-committed packet as activated even when not resident', () => {
    const { session } = sessionWithSpan()
    const first = commitFold(session)
    commitFold(session, { span: [first.replacementSeq!], body: '[EF1 L cp:cp-2]\n\nsecond' })
    const packet = packetFor(session, { stagedAtSeq: first.startSeq - 1 })
    const verdict = classifyPacket(packet, session)
    expect(verdict).toMatchObject({ status: 'activated', messageSeq: first.replacementSeq })
  })
})

describe('R31-B5: partial commits are distinguished', () => {
  it('REFUSES a summary whose replacement never landed', () => {
    const { session } = sessionWithSpan()
    const fold = commitFold(session, { omitReplacement: true, omitEnd: true })
    const packet = packetFor(session, { stagedAtSeq: fold.startSeq - 1 })
    const verdict = proveFoldCommit(packet, session)
    expect(verdict.status).toBe('aborted')
    if (verdict.status !== 'aborted') return
    expect(verdict.reason).toBe('summary-without-replacement')
  })

  it('treats the in-process window before the replacement as UNRESOLVED, not aborted', () => {
    const { session } = sessionWithSpan()
    const fold = commitFold(session, { omitReplacement: true, omitEnd: true })
    const packet = packetFor(session, { stagedAtSeq: fold.startSeq - 1 })
    const verdict = proveFoldCommit(packet, session, { inFlight: true })
    expect(verdict.status).toBe('unresolved')
  })

  it('COMMITS when the replacement landed and compaction/end failed', () => {
    // The end marker is a closure, not the commit point. Basic appends the
    // replacement first; a failing close must not erase what already happened.
    const { session } = sessionWithSpan()
    const fold = commitFold(session, { endError: 'close failed' })
    const packet = packetFor(session, { stagedAtSeq: fold.startSeq - 1 })
    const verdict = proveFoldCommit(packet, session)
    expect(verdict.status).toBe('committed')
    if (verdict.status !== 'committed') return
    expect(verdict.proof.endError).toBe('close failed')
    expect(verdict.proof.endSeq).toBe(fold.endSeq)
    expect(verdict.proof.unclosed).toBe(false)
  })

  it('COMMITS when the close marker is missing entirely', () => {
    const { session } = sessionWithSpan()
    const fold = commitFold(session, { omitEnd: true })
    const packet = packetFor(session, { stagedAtSeq: fold.startSeq - 1 })
    const verdict = proveFoldCommit(packet, session)
    expect(verdict.status).toBe('committed')
    if (verdict.status !== 'committed') return
    expect(verdict.proof.unclosed).toBe(true)
    expect(verdict.proof.endSeq).toBeUndefined()
  })

  it('ABORTS a fold whose compaction ended without a summary', () => {
    const { session } = sessionWithSpan()
    const compactionId = CompactionId(randomUUID())
    const start = session.append('compaction/start', { compactionId, turn: null })
    session.append('compaction/end', { compactionId, turn: null, error: 'summarizer failed' })
    const packet = packetFor(session, { stagedAtSeq: Number(start.seq) })
    const verdict = proveFoldCommit(packet, session)
    expect(verdict.status).toBe('aborted')
    if (verdict.status !== 'aborted') return
    expect(verdict.reason).toBe('compaction-ended-without-summary')
  })
})

describe('R31-B3: identity is bound to content and transaction, not a digest match', () => {
  it('CONFLICTS when the same seqs hold different source content', () => {
    const { session } = sessionWithSpan()
    const first = commitFold(session)
    const packet = packetFor(session, { stagedAtSeq: first.startSeq - 1 })

    // Same seq positions, different bytes: a session restored from a different
    // history. The digest the packet carries must refuse the grant.
    const other = sessionWithSpan()
    const otherFold = commitFold(other.session)
    const foreign = packetFor(other.session, { stagedAtSeq: otherFold.startSeq - 1 })
    if (foreign.sourceDigest === undefined) throw new Error('fixture packet has no source digest')
    const verdict = proveFoldCommit(
      { ...packet, sessionId: session.id, sourceDigest: foreign.sourceDigest },
      session,
    )
    expect(verdict.status).toBe('conflict')
    if (verdict.status !== 'conflict') return
    expect(verdict.detail).toMatch(/source content/u)
  })

  it('CONFLICTS when the committed span is not the packet doc\'s span', () => {
    const { session } = sessionWithSpan()
    const fold = commitFold(session)
    const packet = packetFor(session, { stagedAtSeq: fold.startSeq - 1, span: [0] })
    const verdict = proveFoldCommit(packet, session)
    expect(verdict.status).toBe('conflict')
    if (verdict.status !== 'conflict') return
    expect(verdict.detail).toMatch(/not the packet's span/u)
  })

  it('CONFLICTS on a summary with no matching open-start', () => {
    const { session } = sessionWithSpan()
    const compactionId = CompactionId(randomUUID())
    const summary = session.append('compaction/summary', {
      compactionId,
      summary: [{ type: 'text', text: BODY }],
      shadowedRange: { start: SessionSeq(0), end: SessionSeq(1) },
      shadowedSeqs: [SessionSeq(0), SessionSeq(1)],
      shadowedTokenCount: 100,
      provider: 'test',
      model: 'test',
    } as never)
    const packet = packetFor(session, { stagedAtSeq: Number(summary.seq) - 1 })
    const verdict = proveFoldCommit(packet, session)
    expect(verdict.status).toBe('conflict')
    if (verdict.status !== 'conflict') return
    expect(verdict.detail).toMatch(/open-start/u)
  })

  it('CONFLICTS when the replacement lacks the transaction citations', () => {
    const { session } = sessionWithSpan()
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
    // A replacement event for the span, but it does not cite this transaction.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: BODY }],
      source: compactCheckpointSource(compactionId),
    }), {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(1) },
      sourceEventSeqs: [SessionSeq(0), SessionSeq(1)],
    })
    const packet = packetFor(session, { stagedAtSeq: Number(start.seq) })
    const verdict = proveFoldCommit(packet, session)
    expect(verdict.status).toBe('aborted')
    if (verdict.status !== 'aborted') return
    expect(verdict.reason).toBe('summary-without-replacement')
    void summary
  })

  it('ABORTS when a retry wrote a different body under the same checkpoint', () => {
    const { session } = sessionWithSpan()
    const fold = commitFold(session, { body: '[EF1 L cp:cp-1]\n\nthe body that won' })
    const packet = packetFor(session, {
      stagedAtSeq: fold.startSeq - 1,
      body: '[EF1 L cp:cp-1]\n\nthe body that lost',
    })
    const verdict = proveFoldCommit(packet, session)
    expect(verdict.status).toBe('aborted')
    if (verdict.status !== 'aborted') return
    expect(verdict.reason).toBe('different-body')
  })
})
