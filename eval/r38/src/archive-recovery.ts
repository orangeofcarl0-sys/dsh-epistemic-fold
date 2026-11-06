/**
 * R38-M0 WP4: bounded archive recovery.
 *
 * ## The distinction this module refuses to collapse
 *
 * "Not in semantic state" is not "not in history". R37-C measured a committed
 * fact recall near 0.514, so a missing state value is common and says nothing
 * about whether the raw event exists. This module reports one of:
 *
 *   found-in-active-state      the selected context already contains it
 *   found-in-archive-only      recovered from a verified checkpoint archive
 *   coverage-not-assessed      a bound stopped the search before the answer
 *   not-found-in-checked-scope every inspected checkpoint was searched, no hit
 *   unavailable                the archive could not be read at all
 *
 * ## Bounds
 *
 * The caller freezes every limit. Recovery never loops "until it finds gold":
 *
 *   maxArchiveDescriptors   checkpoints inspected
 *   maxSearchOperations     detail reads
 *   maxExactPages           exact pages opened
 *   maxReturnedChars        excerpt bytes returned
 *   maxReturnedTokens       excerpt tokens returned
 *
 * ## Reuse, not a second archive
 *
 * It calls the existing `recall` (detail, then exact) over the existing
 * `FoldBundleStore`. No embedding backend, no second database, no new index.
 *
 * @module eval/r38/src/archive-recovery
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { CheckpointBundleV1, FoldBundleStore } from '../../../src/types.ts'
import { recall } from '../../../src/recall/recall.ts'

/** Every limit the caller freezes before a recovery attempt. */
export interface RecoveryBudget {
  readonly maxArchiveDescriptors: number
  readonly maxSearchOperations: number
  readonly maxExactPages: number
  readonly maxReturnedChars: number
  readonly maxReturnedTokens: number
}

/** The default bounds. Deliberately small: recovery is a lookup, not a crawl. */
export const DEFAULT_RECOVERY_BUDGET: RecoveryBudget = {
  maxArchiveDescriptors: 8,
  maxSearchOperations: 8,
  maxExactPages: 6,
  maxReturnedChars: 1200,
  maxReturnedTokens: 300,
}

/** The five coverage statuses. */
export type CoverageStatus =
  | 'found-in-active-state'
  | 'found-in-archive-only'
  | 'coverage-not-assessed'
  | 'not-found-in-checked-scope'
  | 'unavailable'

/** One recovered passage. */
export interface RecoveredPassage {
  readonly checkpointId: string
  readonly offset: number
  readonly role: string
  readonly excerpt: string
  readonly sourceRefs: readonly number[]
}

/** The recovery result. */
export interface RecoveryResult {
  readonly status: CoverageStatus
  readonly queryTerms: readonly string[]
  readonly recovered: readonly RecoveredPassage[]
  readonly inspectedCheckpoints: readonly string[]
  readonly searchOperations: number
  readonly exactPages: number
  readonly returnedChars: number
  readonly returnedTokens: number
  readonly truncated: boolean
  readonly notes: readonly string[]
  /** Recovery never writes state; this is always true. */
  readonly stateUnchanged: true
}

/** Options for {@link recoverFromArchive}. */
export interface RecoverOptions {
  readonly store: FoldBundleStore
  readonly sessionId: SessionId
  /** Terms that must ALL appear. Empty terms mean "no query to assess". */
  readonly terms: readonly string[]
  /** The already-selected context; a hit here needs no archive read. */
  readonly activeText?: string
  readonly budget?: RecoveryBudget
}

function normalizeTerms(terms: readonly string[]): string[] {
  return [...new Set(terms.map(term => term.trim().toLowerCase()).filter(term => term.length >= 2))]
}

function matches(text: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return false
  const lower = text.toLowerCase()
  return terms.every(term => lower.includes(term))
}

function messageText(message: Message): string {
  return message.content
    .map(block => block.type === 'text' ? block.text : '')
    .filter(text => text.length > 0)
    .join('\n')
}

/** A bounded window around the first matching term. */
function excerptAround(text: string, terms: readonly string[], maxChars: number): string {
  if (text.length <= maxChars) return text
  const lower = text.toLowerCase()
  const first = terms
    .map(term => lower.indexOf(term))
    .filter(index => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0
  const start = Math.max(0, first - Math.floor(maxChars / 3))
  const end = Math.min(text.length, start + maxChars)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/** Read the seqs behind the page offsets, when the bundle still has refs. */
async function refsFor(
  store: FoldBundleStore,
  sessionId: SessionId,
  checkpointId: string,
  offsets: readonly number[],
): Promise<Map<number, readonly number[]>> {
  const out = new Map<number, readonly number[]>()
  const bundle: CheckpointBundleV1 | null = await store.read(sessionId, checkpointId).catch(() => null)
  if (bundle === null) return out
  for (const offset of offsets) {
    const ref = bundle.archive.refs[offset]
    out.set(offset, ref === undefined ? [] : [Number(ref.seq)])
  }
  return out
}

/**
 * Search the archive for terms the selected context does not contain.
 *
 * @param options - the store, session, terms, selected text and frozen bounds.
 * @returns the status, recovered passages and the cost actually paid.
 */
export async function recoverFromArchive(options: RecoverOptions): Promise<RecoveryResult> {
  const budget = options.budget ?? DEFAULT_RECOVERY_BUDGET
  const terms = normalizeTerms(options.terms)
  const notes: string[] = []
  const recovered: RecoveredPassage[] = []
  const inspectedCheckpoints: string[] = []
  let searchOperations = 0
  let exactPages = 0
  let returnedChars = 0
  let truncated = false

  if (terms.length === 0) {
    return {
      status: 'coverage-not-assessed',
      queryTerms: [],
      recovered: [],
      inspectedCheckpoints: [],
      searchOperations: 0,
      exactPages: 0,
      returnedChars: 0,
      returnedTokens: 0,
      truncated: false,
      notes: ['no query terms were supplied; absence was not assessed'],
      stateUnchanged: true,
    }
  }
  if (options.activeText !== undefined && matches(options.activeText, terms)) {
    return {
      status: 'found-in-active-state',
      queryTerms: terms,
      recovered: [],
      inspectedCheckpoints: [],
      searchOperations: 0,
      exactPages: 0,
      returnedChars: 0,
      returnedTokens: 0,
      truncated: false,
      notes: ['the selected context already contains every term'],
      stateUnchanged: true,
    }
  }

  const descriptors = await options.store.list(options.sessionId).catch(() => [])
  if (descriptors.length === 0) {
    return {
      status: 'unavailable',
      queryTerms: terms,
      recovered: [],
      inspectedCheckpoints: [],
      searchOperations: 0,
      exactPages: 0,
      returnedChars: 0,
      returnedTokens: 0,
      truncated: false,
      notes: ['the session has no readable checkpoint archive'],
      stateUnchanged: true,
    }
  }

  const ordered = [...descriptors].sort((left, right) => right.createdAt - left.createdAt)
  const inspect = ordered.slice(0, Math.max(0, budget.maxArchiveDescriptors))
  let coverageIncomplete = inspect.length < ordered.length
  if (coverageIncomplete) {
    notes.push(`descriptor-limit: inspected ${inspect.length} of ${ordered.length}`)
  }

  for (const descriptor of inspect) {
    if (searchOperations >= budget.maxSearchOperations) {
      coverageIncomplete = true
      notes.push('search-operation-limit reached')
      break
    }
    searchOperations += 1
    inspectedCheckpoints.push(descriptor.checkpointId)
    const detail = await recall({
      store: options.store,
      sessionId: options.sessionId,
      checkpointId: descriptor.checkpointId,
      depth: 'detail',
    })
    if (detail === null) {
      notes.push(`checkpoint-missing:${descriptor.checkpointId}`)
      continue
    }
    if (detail.unavailable !== undefined) {
      notes.push(`checkpoint-unavailable:${descriptor.checkpointId}:${detail.unavailable}`)
      continue
    }
    const candidates = new Set<number>()
    for (const entry of detail.descriptor?.entries ?? []) {
      if (matches(entry.preview, terms)) candidates.add(entry.offset)
    }
    if (candidates.size === 0 && detail.text !== undefined && matches(detail.text, terms)) {
      candidates.add(0)
    }
    if (candidates.size === 0) continue

    const refs = await refsFor(options.store, options.sessionId, descriptor.checkpointId, [...candidates])
    for (const offset of candidates) {
      if (exactPages >= budget.maxExactPages) {
        coverageIncomplete = true
        notes.push('exact-page-limit reached')
        break
      }
      exactPages += 1
      const page = await recall({
        store: options.store,
        sessionId: options.sessionId,
        checkpointId: descriptor.checkpointId,
        depth: 'exact',
        offset,
        limit: 1,
      })
      if (page?.page === undefined) {
        notes.push(`exact-unavailable:${descriptor.checkpointId}:${offset}`)
        continue
      }
      for (const message of page.page.messages) {
        const text = messageText(message)
        if (!matches(text, terms)) continue
        const remainingChars = budget.maxReturnedChars - returnedChars
        const remainingTokens = budget.maxReturnedTokens - Math.ceil(returnedChars / 4)
        if (remainingChars <= 0 || remainingTokens <= 0) {
          truncated = true
          coverageIncomplete = true
          notes.push('returned-size-limit reached')
          break
        }
        const excerpt = excerptAround(text, terms, Math.min(remainingChars, remainingTokens * 4))
        returnedChars += excerpt.length
        recovered.push({
          checkpointId: descriptor.checkpointId,
          offset,
          role: message.role,
          excerpt,
          sourceRefs: refs.get(offset) ?? [],
        })
      }
      if (truncated) break
    }
    if (truncated) break
  }

  const status: CoverageStatus = recovered.length > 0
    ? 'found-in-archive-only'
    : coverageIncomplete
      ? 'coverage-not-assessed'
      : inspectedCheckpoints.length === 0
        ? 'unavailable'
        : 'not-found-in-checked-scope'

  return {
    status,
    queryTerms: terms,
    recovered,
    inspectedCheckpoints,
    searchOperations,
    exactPages,
    returnedChars,
    returnedTokens: Math.ceil(returnedChars / 4),
    truncated,
    notes,
    stateUnchanged: true,
  }
}
