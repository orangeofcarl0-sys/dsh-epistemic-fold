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
import { describeRefFailure, resolveArchiveRefs, resolveArchiveRefsFromLog } from '../checkpoint/archive-refs.ts'
import type { EventSource, LogReader, ResolveResult } from '../checkpoint/archive-refs.ts'
import { normalizeCheckpointRef, parseCheckpointMarker } from '../checkpoint/checkpoint-marker.ts'
import { isFallbackCheckpointLine } from '../checkpoint/compiler.ts'
import { INVENTORY_EXCERPT_CHARS, inventoryEntriesOf, inventoryOf } from '../checkpoint/inventory.ts'
import type { BundleVerification, CheckpointBundleV1, FoldBundleStore, RecallPage } from '../types.ts'

/** Maximum messages one exact page may return. */
export const EXACT_PAGE_LIMIT = 20

/**
 * How many archive entries one `detail` page carries.
 *
 * Twelve rather than the subagent descriptor's ten: `detail` is the depth a model reaches
 * for AFTER a fold, when it is looking for one thing in an archive it can no longer see,
 * and the two extra lines cost ~200 characters against the blind exact page they replace.
 */
export const DETAIL_INVENTORY_LINES = 12

/**
 * Worst-case characters one `detail` page occupies, for a caller sizing its context.
 *
 * The ENTRY COUNT is what enforces this -- each preview is clipped to
 * `INVENTORY_EXCERPT_CHARS` and the rest is the role, the index and JSON framing. The
 * number is published so a caller can bound the payload before asking for it, rather than
 * discovering the size after the fold it was supposed to survive.
 */
export const DETAIL_PAGE_CHARS = DETAIL_INVENTORY_LINES * (INVENTORY_EXCERPT_CHARS + 60)

/** Depth of a recall request. */
export type RecallDepth = 'summary' | 'detail' | 'exact'

/**
 * What a caller is told when a checkpoint has no semantic digest.
 *
 * It names TWO ways forward, because they answer different questions: `detail` says WHAT
 * the archive holds, `exact` returns the messages themselves. The measured failure this
 * exists to fix is a model that received its own marker back, twice, with nothing telling
 * it that a third depth would have returned content.
 */
const NO_SUMMARY_NOTE =
  'this checkpoint has no semantic summary: its marker names a location, not content. '
  + 'Use depth="detail" for a bounded inventory of what it holds -- every entry carries '
  + 'the `offset` that opens it -- or depth="exact" with that `offset` for the archived messages.'

/** The note served by `detail` when the checkpoint view itself was informative. */
const DETAIL_NOTE =
  'this checkpoint has no semantic digest; `text` is its own view and `descriptor` is a '
  + 'bounded inventory of the archive behind it. Open any entry with depth="exact".'

/**
 * Whether a checkpoint's view carries nothing but its identity and the fallback boilerplate.
 *
 * ## Why this is not simply "is the text equal to the marker"
 *
 * Both shapes occur in the wild, and only one of them is the bare marker:
 *
 *   real LHTB bundle   `[EF1 L cp:75c8a907-...]`                     (nothing else)
 *   compiler fallback  the marker, then `- Folded N message(s); semantic summary
 *                      unavailable.` and one more line
 *
 * The second shape is produced by `renderFallbackCheckpoint`, and it is still not a summary:
 * it says the summary is unavailable. A predicate that only recognised the bare marker would
 * report that checkpoint as having a summary, which is the misreading this exists to remove.
 *
 * A bundle with NO marker at all returns false: a root fold's state projection is real
 * information even when there is no digest.
 */
function hasNoSemanticContent(text: string, checkpointId: string): boolean {
  let markerSeen = false
  const rest: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!markerSeen) {
      const parsed = parseCheckpointMarker(trimmed)
      if (parsed !== undefined && normalizeCheckpointRef(parsed.checkpointId) === checkpointId) {
        markerSeen = true
        continue
      }
    }
    if (trimmed.length === 0) continue
    if (isFallbackCheckpointLine(trimmed)) continue
    rest.push(trimmed)
  }
  return markerSeen && rest.length === 0
}

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
  /**
   * Whether `text` is a real checkpoint view, or only the marker.
   *
   * `false` means the checkpoint has no semantic digest AND no state projection, so `text`
   * carries nothing the caller does not already have from the surface. Reported explicitly
   * because "the summary is empty" and "there is no summary" are different claims -- and
   * the model that received its own marker back had no way to tell them apart, so it stopped.
   */
  readonly summaryAvailable?: boolean
  /** The bounded, indexed inventory `detail` serves when there is no digest. */
  readonly descriptor?: RecallDescriptorView
  /** What to do next, when the answer is not the content itself. */
  readonly note?: string
}

/** One entry of a `detail` inventory, as the model reads it. */
export interface RecallInventoryEntry {
  /** Position in the archived message list. */
  readonly index: number
  readonly role: string
  /** What this message is, bounded; never the whole body. */
  readonly preview: string
  /** The `offset` an `exact` page takes to open THIS message. Equal to `index`. */
  readonly offset: number
}

/** What a checkpoint holds, with the index that opens each entry. */
export interface RecallDescriptorView {
  readonly handle: string
  readonly mode: string
  readonly messageCount: number
  readonly span?: SourceRange
  readonly entries: readonly RecallInventoryEntry[]
  /** Continue the inventory here; absent when this page reached the end. */
  readonly nextIndex?: number
  /** Worst-case characters a page of this shape occupies; see `DETAIL_PAGE_CHARS`. */
  readonly pageBudgetChars: number
}

/**
 * Serve one recall request from the bundle store. Every result is bounded;
 * corruption and absence are explicit statuses rather than crashes (D-015).
 *
 * `source` is needed only by REFERENTIAL bundles, whose archive is a ref list
 * rather than stored bytes. A caller that has the session in hand passes
 * `sessionEventSource(session)`; resolution then costs no I/O. Without it, a
 * referential bundle reports `unavailable` instead of guessing — serving the
 * wrong bytes under a checkpoint id would be worse than serving none.
 */
export async function recall(options: {
  store: FoldBundleStore
  /** The session requesting recall — bundles outside it read as absent. */
  sessionId: SessionId
  checkpointId: string
  depth?: RecallDepth
  offset?: number
  limit?: number
  /** Where to resolve referential archives from; see the note above. */
  source?: EventSource
}): Promise<RecallResult | null> {
  const { store, sessionId } = options
  const checkpointId = normalizeCheckpointRef(options.checkpointId)
  // DEFAULT 'detail', not 'summary' and not 'exact'.
  //
  // 'summary' was a no-op for a marker-only checkpoint: it returned the marker the caller
  // already had. 'exact' would page 20 messages, and 20 archived tool results can be far
  // larger than the fold that just removed them -- an unrequested depth that re-inflates the
  // context is not a safe default. 'detail' is bounded, indexed and navigable, and it names
  // the exact call that opens any entry it lists.
  const depth = options.depth ?? 'detail'
  const verification = await store.verify(sessionId, checkpointId)
  const served = await serveDepth({
    checkpointId,
    verification,
    depth,
    ...(options.offset === undefined ? {} : { offset: options.offset }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    resolve: bundle => archiveMessages(bundle, options.source),
  })
  // A missing bundle is still reported rather than silently dropped: recall is
  // degraded, never silent (D-015).
  return served ?? {
    checkpointId,
    mode: 'unknown',
    depth,
    unavailable: 'bundle not found',
  }
}

/**
 * Recall a checkpoint belonging to ANOTHER session, by opening its stored log.
 *
 * EXPERIMENTAL and gated (`allowCrossSessionRecall`, default off). Recall is
 * session-scoped by construction — `FoldBundleStore.read` refuses a foreign
 * session — so serving one needs two things the default path does not: an
 * ownership lookup, and a log to resolve refs against.
 *
 * The ordering is deliberate: a checkpoint belonging to the CALLING session is
 * never served through here, so enabling the experiment cannot change what an
 * ordinary recall returns. It only adds an answer for refs that would otherwise
 * be "not found".
 *
 * @param options.requesting - the session doing the recall; its own checkpoints
 *   are refused here so the caller's normal path stays authoritative.
 * @param options.logReader - the persistence service, when the host has one.
 * @returns the result, or `null` when no session owns the checkpoint.
 */
export async function recallForeign(options: {
  store: FoldBundleStore
  requesting: SessionId
  logReader: LogReader | undefined
  checkpointId: string
  depth?: RecallDepth
  offset?: number
  limit?: number
  signal?: AbortSignal
}): Promise<RecallResult | null> {
  const checkpointId = normalizeCheckpointRef(options.checkpointId)
  const owner = await options.store.findSessionOf?.(checkpointId)
  if (owner === undefined) return null
  if (owner === options.requesting) {
    // The caller's own checkpoint: the ordinary path already handled it (or
    // found it missing), and re-serving it here would let a store that answers
    // inconsistently produce two different answers for one ref.
    return null
  }
  const verification = await options.store.verify(owner, checkpointId)
  // A missing bundle is `null` here rather than the direct path's explicit
  // "not found": this path is a second answer for a ref the ordinary path
  // already reported, so absence adds nothing.
  return serveDepth({
    checkpointId,
    verification,
    depth: options.depth ?? 'detail',
    ...(options.offset === undefined ? {} : { offset: options.offset }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    // exact: an inline archive is already here; a referential one is resolved
    // from the owner's stored log, range-read rather than replayed.
    resolve: bundle => bundle.archive.shadowedMessages !== undefined
      ? { status: 'resolved' as const, messages: bundle.archive.shadowedMessages }
      : resolveArchiveRefsFromLog(
        options.logReader,
        owner,
        bundle.archive.refs,
        options.signal,
      ),
  })
}

/**
 * Serve one VERIFIED bundle at the requested depth, or `null` when it is missing.
 *
 * This is the ONE depth dispatch, paging rule and corruption report for both
 * recall paths. They differ only in WHERE their exact archive comes from — the
 * live session or an inline archive for `recall`, the owner's stored log for
 * `recallForeign` — so everything else lives here and the two cannot drift.
 *
 * `resolve` is called for the exact depth, and for `detail` on a checkpoint with no
 * semantic digest -- the inventory IS the archive, so it cannot be built without one.
 * `summary` never touches the archive, and a `detail` request that a digest can answer
 * does not either, so a referential bundle pays the resolution cost only when the
 * alternative would be returning nothing.
 */
async function serveDepth(options: {
  checkpointId: string
  verification: BundleVerification
  depth: RecallDepth
  offset?: number
  limit?: number
  resolve: (bundle: CheckpointBundleV1) => ResolveResult | Promise<ResolveResult>
}): Promise<RecallResult | null> {
  const { checkpointId, verification, depth } = options
  if (verification.status === 'missing') return null
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
    const text = bundle.rendered.text
    const markerOnly = hasNoSemanticContent(text, checkpointId)
    return {
      checkpointId,
      mode: bundle.mode,
      depth,
      text,
      summaryAvailable: !markerOnly,
      ...(markerOnly ? { note: NO_SUMMARY_NOTE } : {}),
    }
  }
  if (depth === 'detail') {
    const semantic = bundle.semantic?.text
    if (semantic !== undefined && semantic.trim().length > 0) {
      return { checkpointId, mode: bundle.mode, depth, text: semantic, summaryAvailable: true }
    }
    // No digest. THIS is the depth that must not degrade to the marker: the caller asked
    // for more than the summary, so the only honest answer is what the archive HOLDS.
    //
    // Before this, `detail` returned `rendered.text`, and for a marker-only checkpoint
    // that is the same 40-character string `summary` had already handed back -- so
    // escalating a depth produced no new information and, worse, no signal that a depth
    // which DOES return content existed. Measured on a real fold: the model asked twice
    // and recovered zero characters, while the archive held the task statement verbatim.
    const resolved = await options.resolve(bundle)
    if (resolved.status === 'unresolved') {
      return {
        checkpointId,
        mode: bundle.mode,
        depth,
        summaryAvailable: false,
        unavailable: describeRefFailure(resolved.failures),
      }
    }
    const inventory = inventoryEntriesOf(resolved.messages, {
      ...(options.offset === undefined ? {} : { offset: options.offset }),
      limit: options.limit ?? DETAIL_INVENTORY_LINES,
    })
    const span = sourceRangeOf(bundle)
    const view = bundle.rendered.text
    const markerOnly = hasNoSemanticContent(view, checkpointId)
    return {
      checkpointId,
      mode: bundle.mode,
      depth,
      // A state projection is real information and is kept; a bare marker is not, and
      // repeating it would be the no-op this change removes.
      ...(markerOnly ? {} : { text: view }),
      summaryAvailable: !markerOnly,
      descriptor: {
        handle: checkpointId,
        mode: bundle.mode,
        messageCount: bundle.archive.messageCount,
        ...(span === undefined ? {} : { span }),
        entries: inventory.entries.map(entry => ({ ...entry, offset: entry.index })),
        ...(inventory.nextIndex === undefined ? {} : { nextIndex: inventory.nextIndex }),
        pageBudgetChars: DETAIL_PAGE_CHARS,
      },
      note: markerOnly ? NO_SUMMARY_NOTE : DETAIL_NOTE,
    }
  }
  // exact: paginated over the archived messages.
  const resolved = await options.resolve(bundle)
  if (resolved.status === 'unresolved') {
    return {
      checkpointId,
      mode: bundle.mode,
      depth: 'exact',
      unavailable: describeRefFailure(resolved.failures),
    }
  }
  const messages = resolved.messages
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
 * The archived messages of a bundle, from bytes or from refs.
 *
 * One place decides this so every reader agrees: an inline archive is its own
 * answer, and a referential one is resolved (and digest-verified) or reported
 * unresolved. Returns a result rather than a possibly-empty array, because an
 * empty array is a legitimate archive and must not be confused with a failure
 * to obtain one.
 */
export function archiveMessages(
  bundle: CheckpointBundleV1,
  source: EventSource | undefined,
): ResolveResult {
  const inline = bundle.archive.shadowedMessages
  if (inline !== undefined) return { status: 'resolved', messages: inline }
  return resolveArchiveRefs(bundle.archive.refs, source)
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

/**
 * How a hit was found.
 *
 * `verified`  the checkpoint id, or the query as a literal substring.
 * `partial`   the message shares query WORDS but not the query. Always a candidate:
 *             the caller must open it to find out whether it is the thing it wants.
 *
 * There is deliberately no `semantic` member. This repository has no embedding model and
 * adding one is out of scope, so a label claiming semantic similarity would be a claim
 * nothing here can support.
 */
export type SearchConfidence = 'verified' | 'partial'

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
   * How strong the match is: `verified` or `partial`.
   *
   * `matchKind` says WHERE the query landed; this says HOW SURE the search is, and the
   * two are deliberately separate fields because they answer different questions. A
   * literal substring hit is `verified`. A hit that only shares WORDS with the query is
   * `partial`, and is never reported as verified -- measured on a real fold, the query
   * "task: reverse engineer hidden program CLI outputs" shares no phrase with the task
   * instruction, and a search that answered it as a confident hit would be inventing a
   * match rather than finding one.
   */
  readonly confidence: SearchConfidence
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
  /** Where to resolve referential archives from; see `recall`. */
  source?: EventSource
}): Promise<SearchHit[]> {
  const query = options.query.trim()
  if (query.length === 0) return []
  const scanned = await scanBundles(options)
  return verifiedHits(scanned, query, options.limit ?? 10)
}

/** One bundle, read once, with whatever the query located in it. */
interface ScannedBundle {
  readonly bundle: CheckpointBundleV1
  /** The archive, or `null` when a referential one could not be resolved. */
  readonly messages: readonly Message[] | null
  /** The VERIFIED (id or literal) location, or `null` when the query is not literal here. */
  readonly location: MatchLocation | null
}

/**
 * Read every checkpoint in the session ONCE and locate the query in each.
 *
 * One scan serves both `search` and `searchWithDiagnosis`, and it is also why the partial
 * pass costs nothing extra: the resolved messages are already in hand, so a second pass over
 * the same bytes does not re-read a referential archive.
 *
 * An unresolvable bundle is KEPT in the result with `messages: null` rather than dropped.
 * "I could not read this" and "this does not match" are different claims, and a diagnosis
 * that conflated them would report a read failure as an absent fact.
 */
async function scanBundles(options: {
  store: FoldBundleStore
  sessionId: SessionId
  query: string
  source?: EventSource
}): Promise<ScannedBundle[]> {
  const query = options.query.trim()
  const out: ScannedBundle[] = []
  for (const descriptor of await options.store.list(options.sessionId)) {
    const bundle = await options.store.read(options.sessionId, descriptor.checkpointId)
    if (bundle === null) continue
    // A referential bundle needs its archive resolved before it can be searched: the
    // bytes to match against are not in the file.
    const resolved = archiveMessages(bundle, options.source)
    if (resolved.status === 'unresolved') {
      out.push({ bundle, messages: null, location: null })
      continue
    }
    out.push({ bundle, messages: resolved.messages, location: locate(bundle, resolved.messages, query) })
  }
  return out
}

/** Build the model-facing hit from a located match. ONE place, so both paths agree. */
function hitOf(
  bundle: CheckpointBundleV1,
  location: MatchLocation,
  confidence: SearchConfidence,
): SearchHit {
  const range = sourceRangeOf(bundle)
  return {
    checkpointId: bundle.checkpointId,
    mode: bundle.mode,
    createdAt: bundle.createdAt,
    text: bundle.rendered.text,
    matchKind: location.kind,
    confidence,
    ...(location.messageIndex === undefined ? {} : { matchedMessageIndex: location.messageIndex }),
    ...(location.earliestMessageIndex === undefined
      ? {}
      : { earliestMatchedMessageIndex: location.earliestMessageIndex }),
    matchCount: location.matchCount,
    ...(location.excerpt === undefined ? {} : { excerpt: location.excerpt }),
    archiveMessages: bundle.archive.messageCount,
    ...(range === undefined ? {} : { sourceRange: range }),
  }
}

/** The verified hits, NEWEST FIRST and limited AFTER ordering (RC1.3.1). */
function verifiedHits(scanned: readonly ScannedBundle[], query: string, limit: number): SearchHit[] {
  if (query.length === 0) return []
  // ORDER FIRST, THEN LIMIT (RC1.3.1). The store lists bundles in ascending
  // `createdAt`, so applying the limit during the scan kept the OLDEST
  // checkpoints and dropped the newest — with more matching checkpoints than the
  // limit, the current value was the first thing lost. Ordering the full match
  // set before slicing is what makes the limit mean "the most recent N".
  return scanned
    .filter(entry => entry.location !== null)
    .sort((left, right) => compareCheckpointRecencyDescending(left.bundle, right.bundle))
    .slice(0, limit)
    .map(entry => hitOf(entry.bundle, entry.location!, 'verified'))
}
/** How many browse candidates a diagnosis returns. */
export const SEARCH_BROWSE_CANDIDATES = 3

/** Shortest query term that can contribute to a partial match. */
const MIN_TERM_CHARS = 4

/** Shared prefix length at which two words count as the same word. */
const TERM_PREFIX_CHARS = 5

/** Distinct query terms a message must share before it is worth reporting. */
const MIN_MATCHED_TERMS = 2

/** Query terms a partial pass needs before it runs at all. */
const MIN_QUERY_TERMS = 2

/**
 * Words that carry no retrieval signal.
 *
 * Short and boring on purpose: the list only has to remove the scaffolding a model wraps
 * around a query ("task:", "the", "what"), and a longer one would start deleting the
 * words that make a query specific.
 */
const STOPWORDS = new Set([
  'task', 'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'when', 'where',
  'which', 'was', 'were', 'are', 'has', 'have', 'had', 'not', 'but', 'you', 'your', 'its',
  'about', 'into', 'over', 'than', 'then', 'they', 'them', 'there', 'here', 'how', 'why',
])

/** The terms of a query: lowercase alphanumerics, minus stopwords and short noise. */
export function queryTerms(query: string): string[] {
  return [...new Set(
    query.toLowerCase().split(/[^a-z0-9_]+/u).filter(term => term.length >= 3 && !STOPWORDS.has(term)),
  )]
}

/**
 * Whether a term occurs in `text`, allowing a shared word PREFIX.
 *
 * The prefix rule is what makes this useful rather than pedantic: "outputs" and "output",
 * "engineer" and "engine" are the same word for retrieval purposes, and an exact-token
 * rule would miss the task instruction on the very query that failed to find it. Five
 * characters is long enough that unrelated words rarely collide and short enough to absorb
 * a plural or a suffix.
 */
function termMatches(text: string, term: string): boolean {
  if (text.includes(term)) return true
  if (term.length < MIN_TERM_CHARS) return false
  const prefix = term.slice(0, TERM_PREFIX_CHARS)
  let at = text.indexOf(prefix)
  while (at >= 0) {
    if (at === 0 || !/[a-z0-9_]/u.test(text[at - 1]!)) return true
    at = text.indexOf(prefix, at + 1)
  }
  return false
}

interface PartialMatch {
  readonly index: number
  readonly terms: readonly string[]
  readonly excerpt: string
  readonly earliest: number
  readonly count: number
}

/**
 * The best PARTIAL match in an archive: the message sharing the most query terms, newest
 * first on a tie.
 *
 * It requires `MIN_MATCHED_TERMS` DISTINCT terms. One shared word is not a candidate, it is
 * a coincidence — "engine" alone appears in most of these archives, and reporting it would
 * teach the model that a partial hit means nothing.
 */
function locatePartial(messages: readonly Message[], terms: readonly string[]): PartialMatch | null {
  if (terms.length < MIN_QUERY_TERMS) return null
  let best: { index: number; terms: string[]; excerpt: string } | null = null
  let earliest: number | undefined
  let count = 0
  for (let index = 0; index < messages.length; index += 1) {
    const raw = messages[index]!.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
    if (raw.trim().length === 0) continue
    const lowered = raw.toLowerCase()
    const shared = terms.filter(term => termMatches(lowered, term))
    if (shared.length === 0) continue
    count += 1
    earliest ??= index
    if (shared.length >= MIN_MATCHED_TERMS && (best === null || shared.length >= best.terms.length)) {
      best = { index, terms: shared, excerpt: excerptAround(raw, shared[0]!) }
    }
  }
  if (best === null) return null
  return { ...best, earliest: earliest ?? best.index, count }
}

/** The partial hits, best-scoring first, then newest first. */
function partialHits(
  readable: readonly ScannedBundle[],
  terms: readonly string[],
  limit: number,
): SearchHit[] {
  const scored: Array<{ entry: ScannedBundle; match: PartialMatch }> = []
  for (const entry of readable) {
    if (entry.messages === null) continue
    const match = locatePartial(entry.messages, terms)
    if (match !== null) scored.push({ entry, match })
  }
  scored.sort((left, right) => {
    if (left.match.terms.length !== right.match.terms.length) {
      return right.match.terms.length - left.match.terms.length
    }
    return compareCheckpointRecencyDescending(left.entry.bundle, right.entry.bundle)
  })
  return scored.slice(0, limit).map(({ entry, match }) => hitOf(entry.bundle, {
    kind: 'message-text',
    messageIndex: match.index,
    earliestMessageIndex: match.earliest,
    matchCount: match.count,
    excerpt: match.excerpt,
  }, 'partial'))
}

/** One checkpoint a caller can browse when the query matched nothing. */
export interface BrowseCandidate {
  readonly checkpointId: string
  readonly mode: string
  readonly createdAt: number
  readonly messageCount: number
  readonly sourceRange?: SourceRange
  /** What this checkpoint holds, in the same form `context_recall depth="detail"` serves. */
  readonly inventory: readonly string[]
}

/** The five answers a search can give, none of which is "the fact does not exist". */
export type SearchOutcome = 'hits' | 'partial' | 'browse' | 'no-archive' | 'unreadable'

/**
 * What a search found, and — when it found nothing — what to do instead.
 *
 * ## Why an outcome and not just an empty array
 *
 * `hits: []` is the most misread answer this layer can give. It is true of four different
 * situations that call for four different next actions, and the measured failure is a model
 * that received it and concluded the history did not hold what it was looking for:
 *
 *   hits        the query matched literally; open the hit.
 *   partial     nothing literal, but these share query WORDS; verify before trusting one.
 *   browse      nothing at all; read the candidates' inventories and open an entry.
 *   no-archive  there are no checkpoints; nothing was ever folded.
 *   unreadable  checkpoints exist and could not be READ; this is a failure, not an absence.
 *
 * The last two are the reason this type exists. Reporting either of them as `hits: []`
 * would state, in the one place a model is most likely to believe it, that a fact is absent
 * when the truth is that the search could not look.
 */
export interface SearchDiagnosis {
  readonly outcome: SearchOutcome
  readonly hits: readonly SearchHit[]
  readonly candidates: readonly BrowseCandidate[]
  readonly checkpoints: number
  readonly note: string
}

/**
 * Browse candidates: the NEWEST few, plus the OLDEST.
 *
 * The oldest is not a rounding-out of the list. A task statement is the FIRST message of the
 * FIRST checkpoint, so a newest-first candidate list shows exactly the checkpoints that do
 * NOT contain it — which is the failure this whole change exists to fix. This is the one
 * place where "furthest back" is the feature rather than the tiebreak.
 */
function browseCandidates(scanned: readonly ScannedBundle[]): BrowseCandidate[] {
  const newestFirst = [...scanned].sort((left, right) => compareCheckpointRecencyDescending(left.bundle, right.bundle))
  const chosen = newestFirst.slice(0, Math.max(1, SEARCH_BROWSE_CANDIDATES - 1))
  const oldest = newestFirst[newestFirst.length - 1]
  if (oldest !== undefined && !chosen.includes(oldest)) chosen.push(oldest)
  return chosen.map(entry => {
    const range = sourceRangeOf(entry.bundle)
    return {
      checkpointId: entry.bundle.checkpointId,
      mode: entry.bundle.mode,
      createdAt: entry.bundle.createdAt,
      messageCount: entry.bundle.archive.messageCount,
      ...(range === undefined ? {} : { sourceRange: range }),
      inventory: entry.messages === null
        ? ['(archive unreadable: its references could not be resolved)']
        : inventoryOf(entry.messages),
    }
  })
}

/**
 * Search, and say what the answer MEANS when it is empty.
 *
 * `search` keeps its array signature because existing callers and the retrieval taxonomy
 * read it that way; this is the richer answer the TOOL serves, and it is additive.
 */
export async function searchWithDiagnosis(options: {
  store: FoldBundleStore
  sessionId: SessionId
  query: string
  limit?: number
  source?: EventSource
}): Promise<SearchDiagnosis> {
  const query = options.query.trim()
  const limit = options.limit ?? 10
  const scanned = await scanBundles(options)
  if (scanned.length === 0) {
    return {
      outcome: 'no-archive',
      hits: [],
      candidates: [],
      checkpoints: 0,
      note: 'this session has no folded checkpoints, so there is no folded history to search.',
    }
  }
  const readable = scanned.filter(entry => entry.messages !== null)
  if (readable.length === 0) {
    return {
      outcome: 'unreadable',
      hits: [],
      candidates: browseCandidates(scanned),
      checkpoints: scanned.length,
      note: 'checkpoints exist but none could be READ (unresolved archive references). This is a failure to look, not evidence that the fact is absent.',
    }
  }
  const verified = verifiedHits(scanned, query, limit)
  if (verified.length > 0) {
    return {
      outcome: 'hits',
      hits: verified,
      candidates: [],
      checkpoints: scanned.length,
      note: 'verified: the query appears literally in the archived history. Open a hit with context_recall depth="exact" at its matchedMessageIndex.',
    }
  }
  const terms = queryTerms(query)
  const partial = partialHits(readable, terms, limit)
  const candidates = browseCandidates(scanned)
  if (partial.length > 0) {
    return {
      outcome: 'partial',
      hits: partial,
      candidates,
      checkpoints: scanned.length,
      note: 'no literal match. These are PARTIAL candidates: they share words with the query, NOT meaning. Open one to find out whether it is what you want, or read the browse candidates instead.',
    }
  }
  return {
    outcome: 'browse',
    hits: [],
    candidates,
    checkpoints: scanned.length,
    note: 'no lexical match for this query. That does NOT mean the history lacks the fact: read the candidates, each of which lists what its checkpoint holds, and open the entry you want with context_recall depth="exact" and its offset.',
  }
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
  bundle: { checkpointId: string; rendered: { text: string } },
  archiveMessages: readonly Message[],
  query: string,
): MatchLocation | null {
  if (bundle.checkpointId === normalizeCheckpointRef(query)) {
    return { kind: 'id', matchCount: 1 }
  }
  const needle = query.toLowerCase()
  const archive = locateInArchive(archiveMessages, needle)
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
