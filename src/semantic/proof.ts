/**
 * Historical fold commit proof: did the compaction transaction that produced
 * this packet's exact body actually land a surface replacement?
 *
 * ## Residency is not commit evidence
 *
 * The previous classifier asked whether the replacement event was still on the
 * CURRENT surface. That answers "is the checkpoint resident now", which is a
 * different fact. A checkpoint that committed in fold F1 and was folded into
 * F2 is no longer resident, but its fold still committed — and a packet staged
 * in F1 that was never activated must be activated from the log, not demoted to
 * `archived-only`.
 *
 * ## What the log actually proves
 *
 * Basic appends the summary and the replacement synchronously, in one call with
 * no yield:
 *
 *     compaction/start   compactionId
 *     compaction/summary compactionId, summary, shadowedSeqs, shadowedRange
 *     user/message       surfaceOp.replace(start..end), source.kind=compact-checkpoint,
 *                        sourceEventSeqs=[start.seq, summary.seq, ...shadowedSeqs]
 *     compaction/end     compactionId, optional error
 *
 * `Session.append` validates a surface operation before committing the event,
 * so a `user/message` with `surfaceOp: replace` in the append-only log is
 * evidence that the replacement was applied at that point. The current surface
 * is irrelevant to that conclusion.
 *
 * `compaction/end` is a CLOSURE marker, not the commit point. A missing end (or
 * one that records an error) does not erase a replacement that already landed:
 * `compaction/end` is best-effort after the surface has changed. The proof
 * records it as `unclosed` / `endError` and still reports `committed`.
 *
 * ## The three partial states, kept distinct
 *
 *   summary exists, replacement missing   the bundle is durable, the model
 *                                         never saw the body -> NOT committed
 *   summary + replacement, no longer resident
 *                                         historically committed -> YES
 *   replacement landed, end failed        historically committed -> YES
 *
 * ## Identity is not "a digest matched somewhere"
 *
 * A packet is proven only when ALL of these agree:
 *
 *   - session identity;
 *   - checkpoint id in the summary's marker;
 *   - exact body digest;
 *   - compaction id shared by start and summary;
 *   - the span's seqs, in order, equal the summary's `shadowedSeqs`;
 *   - the archived source content re-derives to the packet's `sourceDigest`;
 *   - the replacement cites the start and the summary in `sourceEventSeqs`.
 *
 * Anything less is `conflict` (evidence exists but disagrees) or `unresolved`
 * (not enough evidence yet). Neither activates state.
 *
 * @module dsh-epistemic-fold/semantic/proof
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { canonicalHash } from '../checkpoint/hash.ts'
import { parseCheckpointMarker } from '../checkpoint/checkpoint-marker.ts'
import { retireDerivedAnswers } from '../checkpoint/inventory.ts'
import type { CheckpointBundleV1 } from '../types.ts'

/** The immutable facts that prove one fold committed, recorded on the packet/receipt. */
export interface HistoricalFoldProof {
  readonly proofVersion: 1
  readonly sessionId: string
  readonly checkpointId: string
  readonly compactionId: string
  readonly startSeq: number
  readonly summarySeq: number
  /** The replacement `user/message` seq — the historical commit point. */
  readonly replacementSeq: number
  /** `compaction/end` seq, when the log carries one. */
  readonly endSeq?: number
  /** The close marker's error text, when it recorded a failure. */
  readonly endError?: string
  /** The exact span the summary replaced, in the summary's order. */
  readonly shadowedSeqs: readonly number[]
  /** `canonicalHash(shadowedSeqs)` — the span identity. */
  readonly spanDigest: string
  /**
   * `canonicalHash` of the archived source messages, after the deterministic
   * derived-answer retirement the archive itself applies. This binds the record
   * to CONTENT, not only to event positions.
   */
  readonly sourceDigest: string
  readonly bodyDigest: string
  readonly summaryDigest: string
  /** Monotonic logical commit order: the replacement's seq. Never wall time. */
  readonly commitOrder: number
  /** True when the transaction has no close marker. The replacement still landed. */
  readonly unclosed: boolean
}

/** Why a fold attempt did not commit. */
export type FoldAbortReason =
  | 'different-body'
  | 'summary-without-replacement'
  | 'compaction-ended-without-summary'
  /**
   * A compaction opened, the process is no longer executing it, and the log
   * carries neither a summary nor a close marker. Basic's commit block is
   * synchronous and cannot resume after a restart, so this is a terminated
   * attempt, not an operation that may still land.
   */
  | 'compaction-crashed-open'

/** The proof's verdict. Only `committed` may activate semantic state. */
export type FoldProofResult =
  | { readonly status: 'committed'; readonly proof: HistoricalFoldProof; readonly detail?: string }
  | {
    readonly status: 'aborted'
    readonly reason: FoldAbortReason
    readonly detail: string
    readonly summarySeq?: number
  }
  | { readonly status: 'unresolved'; readonly detail: string }
  | { readonly status: 'conflict'; readonly detail: string }

/** The packet fields a proof needs. Declared structurally so legacy readers can use it. */
export interface FoldProofSubject {
  readonly sessionId: string
  readonly checkpointId: string
  readonly foldedSeqs: readonly number[]
  readonly spanDigest: string
  readonly bodyDigest: string
  /** Absent only for a v3 packet; such a packet needs a verified bundle to migrate. */
  readonly sourceDigest?: string
  readonly stagedAtSeq: number
}

/** Options for {@link proveFoldCommit}. */
export interface FoldProofOptions {
  /**
   * Whether the fold that staged this packet is still executing in THIS
   * process. A summary with no replacement is `unresolved` while the fold can
   * still append it, and `aborted` after a restart (the synchronous commit
   * block cannot resume).
   */
  readonly inFlight?: boolean
  /**
   * The bundle for this checkpoint, when the caller already read one. Enables
   * the referential/embedded archive check and is REQUIRED to migrate a v3
   * packet, which has no `sourceDigest` of its own.
   */
  readonly bundle?: CheckpointBundleV1
}

/** The text of a `compaction/summary`, or undefined when it carries none. */
export function summaryTextOf(event: { readonly type: string; readonly data: unknown }): string | undefined {
  if (event.type !== 'compaction/summary') return undefined
  const data = event.data as { summary?: unknown }
  if (!Array.isArray(data.summary)) return undefined
  return data.summary.map(block => {
    if (block === null || typeof block !== 'object') return ''
    const typed = block as { type?: unknown; text?: unknown }
    return typed.type === 'text' && typeof typed.text === 'string' ? typed.text : ''
  }).join('\n')
}

interface CompactionSummary {
  readonly seq: number
  readonly compactionId: string
  readonly shadowedSeqs: readonly number[]
  /** The replacement range the summary itself was built for. */
  readonly shadowedRange?: { readonly start: number; readonly end: number }
  readonly text: string
  readonly event: SessionEvent
}

interface CompactionStart {
  readonly seq: number
  readonly compactionId: string
}

interface CompactionEnd {
  readonly seq: number
  readonly compactionId: string
  readonly error?: string
}

function numberArray(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: number[] = []
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0) return undefined
    out.push(entry)
  }
  return out
}

function shadowedRangeOf(value: unknown): { readonly start: number; readonly end: number } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const range = value as { start?: unknown; end?: unknown }
  if (typeof range.start !== 'number' || !Number.isSafeInteger(range.start) || range.start < 0) return undefined
  if (typeof range.end !== 'number' || !Number.isSafeInteger(range.end) || range.end < 0) return undefined
  return { start: range.start, end: range.end }
}

function summariesOf(events: readonly SessionEvent[]): readonly CompactionSummary[] {
  const out: CompactionSummary[] = []
  for (const event of events) {
    const text = summaryTextOf(event)
    if (text === undefined) continue
    const data = event.data as { compactionId?: unknown; shadowedSeqs?: unknown; shadowedRange?: unknown }
    if (typeof data.compactionId !== 'string') continue
    const shadowedSeqs = numberArray(data.shadowedSeqs)
    if (shadowedSeqs === undefined) continue
    out.push({
      seq: Number(event.seq),
      compactionId: data.compactionId,
      shadowedSeqs,
      ...(shadowedRangeOf(data.shadowedRange) === undefined
        ? {}
        : { shadowedRange: shadowedRangeOf(data.shadowedRange)! }),
      text,
      event,
    })
  }
  return out
}

function startsOf(events: readonly SessionEvent[]): readonly CompactionStart[] {
  const out: CompactionStart[] = []
  for (const event of events) {
    if (event.type !== 'compaction/start') continue
    const data = event.data as { compactionId?: unknown }
    if (typeof data.compactionId === 'string') {
      out.push({ seq: Number(event.seq), compactionId: data.compactionId })
    }
  }
  return out
}

function endsOf(events: readonly SessionEvent[]): readonly CompactionEnd[] {
  const out: CompactionEnd[] = []
  for (const event of events) {
    if (event.type !== 'compaction/end') continue
    const data = event.data as { compactionId?: unknown; error?: unknown }
    if (typeof data.compactionId !== 'string') continue
    out.push({
      seq: Number(event.seq),
      compactionId: data.compactionId,
      ...(typeof data.error === 'string' ? { error: data.error } : {}),
    })
  }
  return out
}

/**
 * Whether one replacement event is EXACTLY the transaction this summary
 * requires, or why it is not.
 *
 * Basic's `commitCompactionBody` writes, without yielding:
 *
 *   surfaceOp:      { op: 'replace', startSeq: shadowedRange.start, endSeq: shadowedRange.end }
 *   source:         { kind: 'compact-checkpoint', compactionId }
 *   sourceEventSeqs:[startSeq, summarySeq, ...shadowedSeqs]
 *
 * A containment check (`includes`) is not enough: any replacement that cited
 * the same two events would pass, including one for a different range or a
 * different compaction. The comparison here is exact, in order, and includes
 * the checkpoint source's compaction identity.
 *
 * @returns `undefined` when the event is the required replacement, else a detail.
 */
function replacementProblem(
  session: Session,
  event: SessionEvent | undefined,
  summary: CompactionSummary,
  startSeq: number,
): string | undefined {
  if (event === undefined) return 'the replacement event is absent'
  if (event.type !== 'user/message') return `seq ${Number(event.seq)} is a ${event.type}, not a checkpoint message`
  const surfaceOp = (event as { surfaceOp?: unknown }).surfaceOp
  if (surfaceOp === null || typeof surfaceOp !== 'object') return 'the replacement carries no surfaceOp'
  const op = surfaceOp as { op?: unknown; startSeq?: unknown; endSeq?: unknown }
  if (op.op !== 'replace') return 'the surface operation is not a replace'
  const expectedRange = summary.shadowedRange
  if (expectedRange === undefined) return 'the summary carries no shadowedRange to compare against'
  if (op.startSeq !== expectedRange.start || op.endSeq !== expectedRange.end) {
    return `the replacement range ${String(op.startSeq)}..${String(op.endSeq)} is not the summary's `
      + `${expectedRange.start}..${expectedRange.end}`
  }
  const message = session.deriveEventMessage(event)
  if (message === null) return 'the replacement does not derive a message'
  if (message.source.kind !== 'compact-checkpoint') return 'the replacement source is not a compact-checkpoint'
  const sourceCompactionId = (message.source as { compactionId?: unknown }).compactionId
  if (sourceCompactionId !== summary.compactionId) {
    return `the replacement source names compaction ${String(sourceCompactionId)}, `
      + `not ${summary.compactionId}`
  }
  const cited = (event as { sourceEventSeqs?: unknown }).sourceEventSeqs
  if (!Array.isArray(cited)) return 'the replacement carries no sourceEventSeqs'
  const expected = [startSeq, summary.seq, ...summary.shadowedSeqs]
  const actual = cited.map(value => Number(value))
  if (!sameSeqList(actual, expected)) {
    return `the replacement cites [${actual.join(',')}], not the transaction's ordered `
      + `[${expected.join(',')}]`
  }
  return undefined
}

/** The source content hash, reproducing the archive's own retire-then-hash rule. */
function sourceDigestOf(
  session: Session,
  seqs: readonly number[],
): { readonly digest: string } | { readonly refused: string } {
  const messages = []
  for (const seq of seqs) {
    const event = session.eventAt(seq as never)
    if (event === undefined) return { refused: `source event ${seq} is absent from the log` }
    const message = session.deriveEventMessage(event)
    if (message === null) return { refused: `source event ${seq} no longer derives a message` }
    messages.push(message)
  }
  return { digest: canonicalHash(retireDerivedAnswers(messages).messages) }
}

/** Whether two number arrays are equal in value AND order. */
function sameSeqList(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Prove whether one packet's fold committed.
 *
 * @param subject - the packet fields that identify the body and span.
 * @param session - the live or reopened session log.
 * @param options - in-process liveness and an optional verified bundle.
 * @returns a verdict; only `committed` carries a proof and may activate state.
 */
export function proveFoldCommit(
  subject: FoldProofSubject,
  session: Session,
  options: FoldProofOptions = {},
): FoldProofResult {
  const events = session.snapshotEvents()
  if (String(session.id) !== String(subject.sessionId)) {
    return { status: 'conflict', detail: 'the packet names a different session than this log' }
  }
  if (canonicalHash([...subject.foldedSeqs]) !== subject.spanDigest) {
    return { status: 'conflict', detail: 'the packet\'s spanDigest does not hash its foldedSeqs' }
  }
  if (options.bundle !== undefined) {
    const bundleProblem = bundleDisagreement(subject, options.bundle)
    if (bundleProblem !== undefined) return { status: 'conflict', detail: bundleProblem }
  }

  const starts = startsOf(events)
  const ends = endsOf(events)
  const summaries = summariesOf(events)
  const startById = new Map(starts.map(start => [start.compactionId, start]))
  const exact: CompactionSummary[] = []
  let sawSameCheckpointDifferentBody: CompactionSummary | undefined

  for (const summary of summaries) {
    const marker = parseCheckpointMarker(summary.text)
    if (marker?.checkpointId !== subject.checkpointId) continue
    if (canonicalHash(summary.text) !== subject.bodyDigest) {
      sawSameCheckpointDifferentBody ??= summary
      continue
    }
    exact.push(summary)
  }

  // No exact body in the log. Distinguish "the fold wrote another body" from
  // "there is not enough evidence yet" using the compaction that was open when
  // the packet was staged — never `session.seq > stagedAtSeq` alone.
  if (exact.length === 0) {
    if (sawSameCheckpointDifferentBody !== undefined) {
      return {
        status: 'aborted',
        reason: 'different-body',
        detail: 'a summary for this checkpoint carries a different body; a retry won and this one '
          + 'was never visible',
        summarySeq: sawSameCheckpointDifferentBody.seq,
      }
    }
    const own = [...starts].reverse().find(start => start.seq <= subject.stagedAtSeq)
    if (own !== undefined) {
      const ended = ends.find(end => end.compactionId === own.compactionId && end.seq > own.seq)
      if (ended !== undefined) {
        return {
          status: 'aborted',
          reason: 'compaction-ended-without-summary',
          detail: `compaction ${own.compactionId} ended at seq ${ended.seq} without a summary for this packet`
            + (ended.error === undefined ? '' : `: ${ended.error}`),
        }
      }
      const laterSummary = summaries.find(summary =>
        summary.compactionId === own.compactionId && summary.seq > own.seq)
      if (laterSummary !== undefined) {
        return {
          status: 'aborted',
          reason: 'different-body',
          detail: `compaction ${own.compactionId} committed a different checkpoint body`,
          summarySeq: laterSummary.seq,
        }
      }
      // An open compaction with no terminal close is only still-runnable while
      // THIS process is inside it. After a restart Basic's synchronous commit
      // block cannot resume, so the attempt is terminated rather than
      // indefinitely `unresolved` (which would keep a stale in-flight packet in
      // the journal forever).
      if (options.inFlight !== true) {
        return {
          status: 'aborted',
          reason: 'compaction-crashed-open',
          detail: `compaction ${own.compactionId} opened at seq ${own.seq} and never wrote a summary; `
            + 'the transaction cannot resume after a restart',
        }
      }
      return {
        status: 'unresolved',
        detail: `compaction ${own.compactionId} is still open and has not written this packet's body`,
      }
    }
    return {
      status: 'unresolved',
      detail: `no exact summary for checkpoint ${subject.checkpointId} and no compaction owns seq ${subject.stagedAtSeq}`,
    }
  }

  // An exact body exists. Every candidate must agree on identity and source;
  // one that does not is a CONFLICT, not a reason to try the next candidate.
  for (const summary of exact) {
    const start = startById.get(summary.compactionId)
    if (start === undefined || start.seq >= summary.seq) {
      return {
        status: 'conflict',
        detail: `summary at seq ${summary.seq} names compaction ${summary.compactionId}, `
          + 'but no matching open-start record precedes it',
      }
    }
    if (!sameSeqList(summary.shadowedSeqs, subject.foldedSeqs)) {
      return {
        status: 'conflict',
        detail: `the committed span ${summary.shadowedSeqs.join(',')} is not the packet's span `
          + `${subject.foldedSeqs.join(',')}`,
      }
    }
    if (summary.shadowedSeqs.length === 0) {
      return { status: 'conflict', detail: 'the summary replaced an empty span' }
    }
    if (summary.shadowedRange === undefined) {
      return { status: 'conflict', detail: 'the summary carries no shadowedRange' }
    }
    if (summary.shadowedRange.start !== summary.shadowedSeqs[0]
      || summary.shadowedRange.end !== summary.shadowedSeqs[summary.shadowedSeqs.length - 1]) {
      return {
        status: 'conflict',
        detail: `the summary's range ${summary.shadowedRange.start}..${summary.shadowedRange.end} `
          + 'is not the first and last of its shadowedSeqs',
      }
    }
    const source = sourceDigestOf(session, summary.shadowedSeqs)
    if ('refused' in source) return { status: 'conflict', detail: source.refused }
    if (subject.sourceDigest === undefined) {
      return {
        status: 'conflict',
        detail: 'the packet has no source digest; only a verified bundle can establish its source identity',
      }
    }
    if (source.digest !== subject.sourceDigest) {
      return {
        status: 'conflict',
        detail: `the source content hashes to ${source.digest}, not the packet's ${subject.sourceDigest}`,
      }
    }

    const replacementSeq = summary.seq + 1
    const replacement = session.eventAt(replacementSeq as never)
    if (replacement === undefined) {
      // The summary is the last event. In-process this can be the microtask
      // between Basic's two synchronous appends; after a restart it is a
      // partial commit that can never resume. A terminal close marker settles
      // the question even if a stale in-process `inFlight` marker remains.
      const closed = ends.find(candidate =>
        candidate.compactionId === summary.compactionId && candidate.seq > summary.seq)
      if (closed !== undefined) {
        return {
          status: 'aborted',
          reason: 'summary-without-replacement',
          detail: 'the summary landed but the transaction closed without a replacement; the bundle is '
            + 'durable and the fold did not commit'
            + (closed.error === undefined ? '' : `: ${closed.error}`),
          summarySeq: summary.seq,
        }
      }
      return options.inFlight === true
        ? { status: 'unresolved', detail: `waiting for the replacement after summary seq ${summary.seq}` }
        : {
            status: 'aborted',
            reason: 'summary-without-replacement',
            detail: 'the summary landed but the replacement never did; the bundle is durable and the '
              + 'fold did not commit',
            summarySeq: summary.seq,
          }
    }
    const problem = replacementProblem(session, replacement, summary, start.seq)
    if (problem !== undefined) {
      const closed = ends.find(candidate =>
        candidate.compactionId === summary.compactionId && candidate.seq > summary.seq)
      return {
        status: 'aborted',
        reason: 'summary-without-replacement',
        detail: `seq ${replacementSeq} is not the replacement this summary requires: ${problem}`
          + (closed?.error === undefined ? '' : `; the transaction closed with: ${closed.error}`),
        summarySeq: summary.seq,
      }
    }

    const end = ends.find(candidate =>
      candidate.compactionId === summary.compactionId && candidate.seq > replacementSeq)
    const proof: HistoricalFoldProof = {
      proofVersion: 1,
      sessionId: String(session.id),
      checkpointId: subject.checkpointId,
      compactionId: summary.compactionId,
      startSeq: start.seq,
      summarySeq: summary.seq,
      replacementSeq,
      ...(end === undefined ? {} : { endSeq: end.seq }),
      ...(end?.error === undefined ? {} : { endError: end.error }),
      shadowedSeqs: [...summary.shadowedSeqs],
      spanDigest: canonicalHash([...summary.shadowedSeqs]),
      sourceDigest: source.digest,
      bodyDigest: subject.bodyDigest,
      summaryDigest: canonicalHash(summary.text),
      commitOrder: replacementSeq,
      unclosed: end === undefined,
    }
    return {
      status: 'committed',
      proof,
      ...(end?.error === undefined ? {} : {
        detail: `the replacement landed but compaction/end recorded an error: ${end.error}`,
      }),
    }
  }

  return {
    status: 'unresolved',
    detail: `no committed replacement found for checkpoint ${subject.checkpointId}`,
  }
}

/** A bundle either agrees with the packet or supplies the missing source identity. */
function bundleDisagreement(subject: FoldProofSubject, bundle: CheckpointBundleV1): string | undefined {
  if (String(bundle.sessionId) !== String(subject.sessionId)) return 'the bundle belongs to another session'
  if (bundle.checkpointId !== subject.checkpointId) return 'the bundle names another checkpoint'
  if (bundle.rendered.digest !== subject.bodyDigest) return 'the bundle rendered a different body'
  if (!sameSeqList(bundle.source.orderedSurfaceSeqs.map(Number), subject.foldedSeqs)) {
    return 'the bundle covers a different span'
  }
  if (subject.sourceDigest !== undefined && bundle.archive.logicalHash !== subject.sourceDigest) {
    return 'the bundle archive hash disagrees with the packet source digest'
  }
  return undefined
}
