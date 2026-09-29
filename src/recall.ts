/**
 * Bounded exact recall over checkpoint bundles (RFC-001 §7–8): summary,
 * detail, and paginated exact recovery of the archived model history. Recall
 * is provenance-based — it serves only what a published bundle archived — and
 * is bounded: an exact page never dumps the whole archive.
 *
 * @module dsh-epistemic-fold/recall
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { normalizeCheckpointRef } from './checkpoint-marker.ts'
import type { CheckpointBundleV1, FoldBundleStore, RecallPage } from './types.ts'

/** Maximum messages one exact page may return. */
export const EXACT_PAGE_LIMIT = 20

/** Depth of a recall request. */
export type RecallDepth = 'summary' | 'detail' | 'exact'

export interface RecallResult {
  readonly checkpointId: string
  readonly mode: string
  readonly depth: RecallDepth
  /** Checkpoint text for summary/detail depths. */
  readonly text?: string
  /** Paginated exact messages for the `exact` depth. */
  readonly page?: RecallPage
  /** Set when the bundle is missing or corrupt: degraded, never silent. */
  readonly unavailable?: string
}

/**
 * Serve one recall request from the bundle store. Every result is bounded;
 * corruption and absence are explicit statuses rather than crashes (D-015).
 */
export async function recall(options: {
  store: FoldBundleStore
  /** The session requesting recall — bundles outside it read as absent. */
  sessionId: SessionId
  checkpointId: string
  depth?: RecallDepth
  offset?: number
  limit?: number
}): Promise<RecallResult | null> {
  const { store, sessionId } = options
  const checkpointId = normalizeCheckpointRef(options.checkpointId)
  const depth = options.depth ?? 'summary'
  const verification = await store.verify(sessionId, checkpointId)
  if (verification.status === 'missing') {
    return {
      checkpointId,
      mode: 'unknown',
      depth,
      unavailable: 'bundle not found',
    }
  }
  if (verification.status === 'corrupt') {
    return {
      checkpointId,
      mode: 'unknown',
      depth,
      unavailable: `bundle corrupt: ${verification.reason}`,
    }
  }
  const bundle = verification.bundle
  if (depth === 'summary') {
    return { checkpointId, mode: bundle.mode, depth, text: bundle.rendered.text }
  }
  if (depth === 'detail') {
    const semantic = bundle.semantic?.text
    return {
      checkpointId,
      mode: bundle.mode,
      depth,
      text: semantic ?? bundle.rendered.text,
    }
  }
  // exact: paginated over the archived messages.
  const messages = bundle.archive.shadowedMessages
  const offset = Math.max(0, Math.min(options.offset ?? 0, messages.length))
  const limit = Math.min(Math.max(1, options.limit ?? EXACT_PAGE_LIMIT), EXACT_PAGE_LIMIT)
  const page: RecallPage = {
    checkpointId,
    totalMessages: messages.length,
    offset,
    messages: messages.slice(offset, offset + limit),
    ...(offset + limit < messages.length ? { nextOffset: offset + limit } : {}),
  }
  return { checkpointId, mode: bundle.mode, depth: 'exact', page }
}

/**
 * Characters of verbatim context a hit carries around its match (RC1.3).
 *
 * The excerpt exists so the model can see WHY a checkpoint matched instead of
 * having to open a checkpoint and read it. It is bounded for the same reason
 * every other recall face is: a search hit is an affordance to recall, not a
 * second copy of the archive.
 *
 * The size is measured, not guessed. At 240 a live run showed the failure it
 * causes: a window centred on the match in a 230-character message cut the
 * message's OTHER facts off the front, so a model that searched for the error
 * code received an excerpt naming the timeout but not the batch limit — and
 * answered the third question "unknown". The excerpt was manufacturing a
 * `search-miss` out of a hit that had in fact found the message.
 */
export const SEARCH_EXCERPT_CHARS = 400

/**
 * The excerpt budget beyond which a message is truncated rather than returned
 * whole.
 *
 * Most archived messages are short, and for those the honest answer is the
 * whole message: truncating a 230-character message to 240 characters of window
 * loses information while saving nothing worth saving. Only a genuinely long
 * message is windowed.
 */
export const SEARCH_WHOLE_MESSAGE_CHARS = 600

/** Where in a bundle a query matched, and what it looked like there. */
export type SearchMatchKind = 'id' | 'checkpoint-text' | 'message-text' | 'tool-name'

/** The span of surface positions a checkpoint shadowed, in conversation order. */
export interface SourceRange {
  readonly first: number
  readonly last: number
}

/**
 * The source range of a bundle, or `undefined` when it shadowed nothing.
 *
 * `orderedSurfaceSeqs` is the durable record of WHERE in the conversation a
 * checkpoint sits, written by the fold that created it. This is the chronology
 * the retrieval layer orders by.
 */
export function sourceRangeOf(bundle: {
  source: { orderedSurfaceSeqs: readonly (number | { valueOf(): number })[] }
}): SourceRange | undefined {
  const seqs = bundle.source.orderedSurfaceSeqs.map(seq => Number(seq))
  if (seqs.length === 0) return undefined
  return { first: Math.min(...seqs), last: Math.max(...seqs) }
}

/**
 * Order two checkpoints NEWEST FIRST, by source chronology (RC1.3.1).
 *
 * ## Why the sequence span and not `createdAt`
 *
 * `createdAt` is a wall-clock reading taken when the bundle was written. It can
 * run backwards (a clock adjustment, a restored machine), it can collide (two
 * folds in the same millisecond), and it says nothing about WHERE in the
 * conversation the checkpoint belongs. `source.orderedSurfaceSeqs` is the
 * conversation's own ordering, recorded by the fold that shadowed the span, so
 * it is authoritative for "which value came later".
 *
 * `createdAt` is the fallback only for a bundle with no sequences, and such a
 * bundle never outranks a sequenced one — an unsequenced bundle cannot claim to
 * be current. Ties break on `checkpointId` so the order is total and repeatable
 * rather than inherited from filesystem read order.
 */
export function compareCheckpointRecencyDescending(
  left: { checkpointId: string; createdAt: number; source: { orderedSurfaceSeqs: readonly (number | { valueOf(): number })[] } },
  right: { checkpointId: string; createdAt: number; source: { orderedSurfaceSeqs: readonly (number | { valueOf(): number })[] } },
): number {
  const leftRange = sourceRangeOf(left)
  const rightRange = sourceRangeOf(right)
  if (leftRange !== undefined && rightRange !== undefined) {
    if (leftRange.last !== rightRange.last) return rightRange.last - leftRange.last
    if (leftRange.first !== rightRange.first) return rightRange.first - leftRange.first
  } else if (leftRange !== undefined) {
    return -1
  } else if (rightRange !== undefined) {
    return 1
  }
  if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt
  return left.checkpointId < right.checkpointId ? -1 : left.checkpointId > right.checkpointId ? 1 : 0
}

export interface SearchHit {
  readonly checkpointId: string
  readonly mode: string
  readonly createdAt: number
  /** The matched checkpoint text (summary depth). */
  readonly text: string
  /**
   * Which face of the bundle the query matched (RC1.3).
   *
   * The old hit said only "this checkpoint matched", which left the model to
   * guess whether the query hit the checkpoint SUMMARY (the fact is already
   * visible, no recall needed) or the raw ARCHIVE (the fact is folded away, a
   * targeted `context_recall` will fetch it). Those call for opposite actions,
   * so the hit now says which one it was.
   */
  readonly matchKind: SearchMatchKind
  /**
   * Index of the NEWEST archived message matching the query (RC1.3.1).
   *
   * Use this as the `offset` for `context_recall({ depth: 'exact' })`: the page
   * then BEGINS at the match, which is correct for any `limit`. It is also the
   * chronology signal — a later index is a later statement of the fact.
   *
   * This replaces `exactPageOffset`, which was page-aligned for the default page
   * size and so was only "a page containing the match", and only for a caller
   * that happened to use that size.
   */
  readonly matchedMessageIndex?: number
  /**
   * Index of the OLDEST matching archived message.
   *
   * Always present for a message match, including when it equals
   * {@link matchedMessageIndex} (a fact with no history). Reporting it
   * unconditionally keeps the shape predictable: a model reading the field never
   * has to distinguish "no older version" from "the field is missing".
   *
   * This is how a superseded value stays reachable: recall at this offset to
   * read what the current value replaced, without paging the archive from zero.
   */
  readonly earliestMatchedMessageIndex?: number
  /**
   * How many archived messages matched the query.
   *
   * A count above one is the signal that this fact has HISTORY — the model
   * should expect a newer value rather than reading the first match as current.
   */
  readonly matchCount: number
  /** Bounded verbatim text around the match, so the model can judge relevance. */
  readonly excerpt?: string
  /** Total archived messages in this checkpoint, so the model knows the size. */
  readonly archiveMessages: number
  /**
   * Where in the conversation this checkpoint sits (RC1.3.1).
   *
   * The deterministic recency key: hits are ordered by it, newest first, so a
   * model can tell which value is current without trusting a timestamp.
   */
  readonly sourceRange?: SourceRange
}

/**
 * M0 lexical search over a session's checkpoints: exact checkpoint id,
 * checkpoint text, and tool names / file paths appearing in the archived
 * messages. No embedding (D-013).
 *
 * RC1.3 enriches each hit with WHERE it matched and a bounded excerpt. RC1.3.1
 * makes the result CHRONOLOGICAL: hits are ordered newest-first by source
 * chronology, and the newest matching checkpoints are selected before the
 * limit is applied. This serves only content the bundle already archived, so
 * provenance is unchanged — search remains a pointer into recall, never a way
 * around it.
 */
export async function search(options: {
  store: FoldBundleStore
  sessionId: SessionId
  query: string
  limit?: number
}): Promise<SearchHit[]> {
  const query = options.query.trim()
  if (query.length === 0) return []
  const limit = options.limit ?? 10
  const bundles = await options.store.list(options.sessionId)
  // Collect matches WITH their bundle, so ordering can read the source
  // chronology. A `SearchHit` deliberately does not carry the whole bundle, so
  // sorting the hits directly would have nothing to sort by.
  const matched: Array<{ bundle: CheckpointBundleV1; location: MatchLocation }> = []
  for (const descriptor of bundles) {
    const bundle = await options.store.read(options.sessionId, descriptor.checkpointId)
    if (bundle === null) continue
    const location = locate(bundle, query)
    if (location !== null) matched.push({ bundle, location })
  }
  // ORDER FIRST, THEN LIMIT (RC1.3.1). The store lists bundles in ascending
  // `createdAt`, so applying the limit during the scan kept the OLDEST
  // checkpoints and dropped the newest — with more matching checkpoints than the
  // limit, the current value was the first thing lost. Ordering the full match
  // set before slicing is what makes the limit mean "the most recent N".
  matched.sort((left, right) => compareCheckpointRecencyDescending(left.bundle, right.bundle))
  return matched.slice(0, limit).map(({ bundle, location }) => {
    const range = sourceRangeOf(bundle)
    return {
      checkpointId: bundle.checkpointId,
      mode: bundle.mode,
      createdAt: bundle.createdAt,
      text: bundle.rendered.text,
      matchKind: location.kind,
      ...(location.messageIndex === undefined ? {} : { matchedMessageIndex: location.messageIndex }),
      ...(location.earliestMessageIndex === undefined
        ? {}
        : { earliestMatchedMessageIndex: location.earliestMessageIndex }),
      matchCount: location.matchCount,
      ...(location.excerpt === undefined ? {} : { excerpt: location.excerpt }),
      archiveMessages: bundle.archive.shadowedMessages.length,
      ...(range === undefined ? {} : { sourceRange: range }),
    }
  })
}

/** Where one bundle matched, in the order the faces are checked. */
interface MatchLocation {
  readonly kind: SearchMatchKind
  readonly messageIndex?: number
  readonly earliestMessageIndex?: number
  readonly matchCount: number
  readonly excerpt?: string
}

/**
 * M0 match rule: id equality or case-insensitive substring over text faces.
 *
 * Precedence is id → archive → checkpoint text, and the LATEST matching message
 * wins (RC1.3.1). The order matters twice over:
 *
 *  - **Archive before checkpoint text.** The archive is raw history; the
 *    checkpoint text is a derived summary. When both carry the query, the
 *    archive is the more actionable answer, because it is what recall returns
 *    verbatim and it is where the message-level chronology lives.
 *  - **Latest message, not first.** A value and its correction are two messages,
 *    and the correction is the one that answers the question. Returning the
 *    first match pointed the model at the superseded value and showed it in the
 *    excerpt, which reads as the current answer.
 */
function locate(
  bundle: { checkpointId: string; rendered: { text: string }; archive: { shadowedMessages: readonly Message[] } },
  query: string,
): MatchLocation | null {
  if (bundle.checkpointId === normalizeCheckpointRef(query)) {
    return { kind: 'id', matchCount: 1 }
  }
  const needle = query.toLowerCase()
  const archive = locateInArchive(bundle.archive.shadowedMessages, needle)
  if (archive !== null) return archive
  if (bundle.rendered.text.toLowerCase().includes(needle)) {
    return { kind: 'checkpoint-text', matchCount: 1, excerpt: excerptAround(bundle.rendered.text, needle) }
  }
  return null
}

/**
 * The newest archived message matching `needle`, plus the oldest and the count.
 *
 * Scans every message rather than stopping at the first: the count is what tells
 * a model the fact has history, and the oldest index is what keeps the
 * superseded value reachable.
 */
function locateInArchive(messages: readonly Message[], needle: string): MatchLocation | null {
  let newest: { index: number; excerpt: string; kind: SearchMatchKind } | undefined
  let earliest: number | undefined
  let count = 0
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    for (const block of message.content) {
      if (block.type === 'text' && block.text.toLowerCase().includes(needle)) {
        count += 1
        earliest ??= index
        newest = { index, excerpt: excerptAround(block.text, needle), kind: 'message-text' }
        break
      }
      if (block.type === 'tool-call' && block.name.toLowerCase().includes(needle)) {
        count += 1
        earliest ??= index
        newest = { index, excerpt: toolCallExcerpt(block.name, block.arguments), kind: 'tool-name' }
        break
      }
    }
  }
  if (newest === undefined) return null
  return {
    kind: newest.kind,
    messageIndex: newest.index,
    ...(earliest === undefined ? {} : { earliestMessageIndex: earliest }),
    matchCount: count,
    excerpt: newest.excerpt,
  }
}

/**
 * A bounded view of `text` around the first case-insensitive `needle`.
 *
 * A message short enough to return whole IS returned whole. Truncating it would
 * lose its other facts while saving nothing, and the live run that motivated
 * this change lost a fact exactly that way: the model searched for one value,
 * got a window that cut a sibling value off the front, and reported the sibling
 * as unknown even though the hit had found the right message.
 *
 * A longer message is windowed around the match, and ellipses mark where text
 * was cut so a truncated excerpt is never mistaken for the whole message.
 */
export function excerptAround(
  text: string,
  needle: string,
  budget = SEARCH_EXCERPT_CHARS,
  wholeMessageBudget = SEARCH_WHOLE_MESSAGE_CHARS,
): string {
  if (text.length <= wholeMessageBudget) return text
  const at = text.toLowerCase().indexOf(needle.toLowerCase())
  if (at < 0) return `${text.slice(0, budget)}…`
  const half = Math.max(0, Math.floor((budget - needle.length) / 2))
  const start = Math.max(0, at - half)
  const end = Math.min(text.length, start + budget)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/** A tool-call excerpt: the name plus a truncated argument preview. */
function toolCallExcerpt(name: string, args: string, budget = SEARCH_EXCERPT_CHARS): string {
  const room = Math.max(0, budget - name.length - 2)
  return args.length <= room ? `${name} ${args}` : `${name} ${args.slice(0, room)}…`
}
