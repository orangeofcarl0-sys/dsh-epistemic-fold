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
  checkpointId: string
  depth?: RecallDepth
  offset?: number
  limit?: number
}): Promise<RecallResult | null> {
  const { store, checkpointId } = options
  const depth = options.depth ?? 'summary'
  const verification = await store.verify(checkpointId)
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

export interface SearchHit {
  readonly checkpointId: string
  readonly mode: string
  readonly createdAt: number
  /** The matched checkpoint text (summary depth). */
  readonly text: string
}

/**
 * M0 lexical search over a session's checkpoints: exact checkpoint id,
 * checkpoint text, and tool names / file paths appearing in the archived
 * messages. No embedding (D-013).
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
    const bundle = await options.store.read(descriptor.checkpointId)
    if (bundle === null) continue
    if (await matches(bundle, query)) {
      hits.push({
        checkpointId: bundle.checkpointId,
        mode: bundle.mode,
        createdAt: bundle.createdAt,
        text: bundle.rendered.text,
      })
    }
    if (hits.length >= limit) break
  }
  return hits
}

/** M0 match rule: id equality or case-insensitive substring over text faces. */
async function matches(bundle: { checkpointId: string; rendered: { text: string }; archive: { shadowedMessages: readonly Message[] } }, query: string): Promise<boolean> {
  if (bundle.checkpointId === query || `cp:${bundle.checkpointId}` === query) return true
  const needle = query.toLowerCase()
  if (bundle.rendered.text.toLowerCase().includes(needle)) return true
  for (const message of bundle.archive.shadowedMessages) {
    for (const block of message.content) {
      if (block.type === 'text' && block.text.toLowerCase().includes(needle)) return true
      if (block.type === 'tool-call' && (block.name.toLowerCase().includes(needle))) return true
    }
  }
  return false
}
