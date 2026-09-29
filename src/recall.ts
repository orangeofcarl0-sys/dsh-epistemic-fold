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
import type { FoldBundleStore, RecallPage } from './types.ts'

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
  /** Index into the archived messages of the matching message. */
  readonly matchedMessageIndex?: number
  /** Bounded verbatim text around the match, so the model can judge relevance. */
  readonly excerpt?: string
  /** Total archived messages in this checkpoint, so the model knows the size. */
  readonly archiveMessages: number
  /**
   * The `exact`-depth page offset that CONTAINS the matched message.
   *
   * This is the actionable part: `context_recall(ref, depth='exact', offset)`
   * lands directly on the matching page instead of paging from zero. Absent
   * when the match was not in the archive (an id or summary hit).
   */
  readonly exactPageOffset?: number
}

/**
 * M0 lexical search over a session's checkpoints: exact checkpoint id,
 * checkpoint text, and tool names / file paths appearing in the archived
 * messages. No embedding (D-013).
 *
 * RC1.3 enriches each hit with WHERE it matched and a bounded excerpt. This
 * serves only content the bundle already archived, so provenance is unchanged —
 * search remains a pointer into recall, never a way around it.
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
  const hits: SearchHit[] = []
  for (const descriptor of bundles) {
    const bundle = await options.store.read(options.sessionId, descriptor.checkpointId)
    if (bundle === null) continue
    const location = locate(bundle, query)
    if (location !== null) {
      hits.push({
        checkpointId: bundle.checkpointId,
        mode: bundle.mode,
        createdAt: bundle.createdAt,
        text: bundle.rendered.text,
        matchKind: location.kind,
        ...(location.messageIndex === undefined ? {} : { matchedMessageIndex: location.messageIndex }),
        ...(location.excerpt === undefined ? {} : { excerpt: location.excerpt }),
        archiveMessages: bundle.archive.shadowedMessages.length,
        ...(location.messageIndex === undefined
          ? {}
          : { exactPageOffset: Math.floor(location.messageIndex / EXACT_PAGE_LIMIT) * EXACT_PAGE_LIMIT }),
      })
    }
    if (hits.length >= limit) break
  }
  return hits
}

/** Where one bundle matched, in the order the faces are checked. */
interface MatchLocation {
  readonly kind: SearchMatchKind
  readonly messageIndex?: number
  readonly excerpt?: string
}

/**
 * M0 match rule: id equality or case-insensitive substring over text faces.
 *
 * Precedence is id → checkpoint text → archived messages, and the FIRST
 * matching message wins. Id first because it is unambiguous; the archive is
 * scanned in order so the same query always reports the same index.
 */
function locate(
  bundle: { checkpointId: string; rendered: { text: string }; archive: { shadowedMessages: readonly Message[] } },
  query: string,
): MatchLocation | null {
  if (bundle.checkpointId === normalizeCheckpointRef(query)) return { kind: 'id' }
  const needle = query.toLowerCase()
  if (bundle.rendered.text.toLowerCase().includes(needle)) {
    return { kind: 'checkpoint-text', excerpt: excerptAround(bundle.rendered.text, needle) }
  }
  const messages = bundle.archive.shadowedMessages
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    for (const block of message.content) {
      if (block.type === 'text' && block.text.toLowerCase().includes(needle)) {
        return { kind: 'message-text', messageIndex: index, excerpt: excerptAround(block.text, needle) }
      }
      if (block.type === 'tool-call' && block.name.toLowerCase().includes(needle)) {
        return { kind: 'tool-name', messageIndex: index, excerpt: toolCallExcerpt(block.name, block.arguments) }
      }
    }
  }
  return null
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
