/**
 * Shared R32 fixtures: a real DSH compaction transaction, its source digest,
 * the v4 packet a fold would prepare, and the receipt a committed proof yields.
 *
 * The fixtures use the exact event shape Basic's `commitCompactionBody` appends
 * — start, summary with a range, replacement citing the ordered transaction,
 * end — so proof tests exercise the production transaction rather than a
 * simplified stand-in.
 *
 * @module tests/r32-fixtures
 */

import { randomUUID } from 'node:crypto'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { canonicalHash } from '../src/checkpoint/hash.ts'
import { retireDerivedAnswers } from '../src/checkpoint/inventory.ts'
import { opsDigestOf, packetIdOf } from '../src/semantic/journal.ts'
import { proveFoldCommit } from '../src/semantic/proof.ts'
import type { HistoricalFoldProof } from '../src/semantic/proof.ts'
import { SEMANTIC_SCHEMA_VERSION } from '../src/semantic/types.ts'
import type { SemanticPacket, SemanticReceipt } from '../src/semantic/types.ts'
import type { EfAnchorEventData } from '../src/state/state.ts'

export const CHECKPOINT = 'r32-cp'

export const DEFAULT_BODY = `[EF1 L cp:${CHECKPOINT}]\n\nThe timeout is 30 seconds.`

export function userMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** A session with two surface messages a fold can shadow. */
export function sessionWithSpan(): Session {
  const session = Session.create(SessionId(`r32-${randomUUID()}`))
  for (const text of ['fixture user 0', 'fixture user 1']) {
    session.append('user/message', userMessage(text), { surfaceOp: 'append' })
  }
  return session
}

export interface CommitOptions {
  readonly body?: string
  readonly span?: readonly number[]
  readonly omitReplacement?: boolean
  readonly omitEnd?: boolean
  readonly endError?: string
  /** Break the replacement's surface range (B5). */
  readonly wrongRange?: boolean
  /** Reverse the replacement's ordered source citations (B5). */
  readonly wrongSourceOrder?: boolean
  /** Name a different compaction in the replacement source (B5). */
  readonly wrongCompaction?: boolean
  readonly summaryRange?: { readonly start: number; readonly end: number }
}

export interface FoldSeqs {
  readonly compactionId: string
  readonly startSeq: number
  readonly summarySeq: number
  readonly replacementSeq?: number
  readonly endSeq?: number
}

/** Append the exact event transaction Basic writes, with optional corruption. */
export function commitFold(session: Session, options: CommitOptions = {}): FoldSeqs {
  const body = options.body ?? DEFAULT_BODY
  const span = [...(options.span ?? [0, 1])]
  const compactionId = CompactionId(randomUUID())
  const lifecycle = { compactionId, turn: null }
  const start = session.append('compaction/start', lifecycle)
  const summary = session.append('compaction/summary', {
    ...lifecycle,
    summary: [{ type: 'text', text: body }],
    shadowedRange: options.summaryRange ?? {
      start: SessionSeq(span[0]!),
      end: SessionSeq(span[span.length - 1]!),
    },
    shadowedSeqs: span.map(seq => SessionSeq(seq)),
    shadowedTokenCount: 100,
    provider: 'test',
    model: 'test',
  } as never)
  let replacementSeq: number | undefined
  if (options.omitReplacement !== true) {
    const range = options.wrongRange === true
      ? { startSeq: SessionSeq(span[0]!), endSeq: SessionSeq(span[0]!) }
      : { startSeq: SessionSeq(span[0]!), endSeq: SessionSeq(span[span.length - 1]!) }
    const cited = options.wrongSourceOrder === true
      ? [summary.seq, start.seq, ...span.map(seq => SessionSeq(seq))]
      : [start.seq, summary.seq, ...span.map(seq => SessionSeq(seq))]
    const replacement = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: body }],
      source: compactCheckpointSource(
        options.wrongCompaction === true ? CompactionId(randomUUID()) : compactionId,
      ),
    }), {
      surfaceOp: { op: 'replace', ...range },
      sourceEventSeqs: cited,
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

/** The archive's source digest, reproducing its retire-then-hash rule. */
export function sourceDigestOf(session: Session, span: readonly number[]): string {
  const messages: Message[] = []
  for (const seq of span) {
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) throw new Error(`fixture has no event ${seq}`)
    const derived = session.deriveEventMessage(event)
    if (derived === null) throw new Error(`fixture event ${seq} derives no message`)
    messages.push(derived)
  }
  return canonicalHash(retireDerivedAnswers(messages).messages)
}

export interface FoldFixture {
  readonly session: Session
  readonly span: readonly number[]
  readonly body: string
  readonly packet: SemanticPacket
  readonly receipt: SemanticReceipt
  readonly proof: HistoricalFoldProof
  readonly seqs: FoldSeqs
}

/**
 * One committed fold plus the packet/receipt a correct engine would write.
 *
 * @param options - overrides for the event transaction.
 * @param packetOptions - overrides for the packet/ops.
 * @returns the whole fixture.
 */
export function committedFixture(
  options: CommitOptions = {},
  packetOptions: { readonly ops?: readonly EfAnchorEventData[]; readonly stagedAtSeq?: number } = {},
): FoldFixture {
  const session = sessionWithSpan()
  const span = [...(options.span ?? [0, 1])]
  const body = options.body ?? DEFAULT_BODY
  const seqs = commitFold(session, options)
  const packet = packetFor({
    session,
    span,
    body,
    ...(packetOptions.ops === undefined ? {} : { ops: packetOptions.ops }),
    ...(packetOptions.stagedAtSeq === undefined ? {} : { stagedAtSeq: packetOptions.stagedAtSeq }),
  })
  const verdict = proveFoldCommit(packet, session)
  if (verdict.status !== 'committed') {
    throw new Error(`fixture fold did not prove committed: ${verdict.status} ${verdict.detail}`)
  }
  const receipt: SemanticReceipt = {
    kind: 'receipt',
    schemaVersion: SEMANTIC_SCHEMA_VERSION,
    packetId: packet.packetId,
    sessionId: packet.sessionId,
    checkpointId: packet.checkpointId,
    outcome: 'committed',
    proof: verdict.proof,
    opsDigest: opsDigestOf(packet),
    decidedAt: 1,
  }
  return { session, span, body, packet, receipt, proof: verdict.proof, seqs }
}

/** Build a well-formed v4 packet for one session's fold. */
export function packetFor(input: {
  readonly session: Session
  readonly span: readonly number[]
  readonly body: string
  readonly ops?: readonly EfAnchorEventData[]
  readonly stagedAtSeq?: number
  readonly checkpointId?: string
}): SemanticPacket {
  const checkpointId = input.checkpointId ?? CHECKPOINT
  const bodyDigest = canonicalHash(input.body)
  return {
    schemaVersion: SEMANTIC_SCHEMA_VERSION,
    packetId: packetIdOf({
      sessionId: input.session.id,
      checkpointId,
      foldedSeqs: input.span,
      bodyDigest,
    }),
    sessionId: input.session.id,
    checkpointId,
    mode: 'active',
    authority: 'journal',
    status: 'staged',
    spanDigest: canonicalHash([...input.span]),
    foldedSeqs: [...input.span],
    createdAt: 1,
    stagedAtSeq: input.stagedAtSeq ?? 2,
    bodyDigest,
    sourceDigest: sourceDigestOf(input.session, input.span),
    ops: [...(input.ops ?? [])],
    handoff: '',
    deltaParse: 'absent',
    proposed: [],
    accepted: [],
    refused: [],
  }
}
