/**
 * Archive evidence locators: an EXECUTABLE address for one archived message.
 *
 * ## The failure this exists to remove
 *
 * The E2E index campaign rendered `Archived calls` as prose:
 *
 *   Archived calls
 *   - read_file logs/gateway-2026-10-11.log
 *
 * A model read that line, then re-issued `read_file` on the path. The file had
 * been rotated out of the workspace, so the tool returned ENOENT and the model
 * concluded the evidence was gone. The line named a WORKSPACE action while the
 * bytes lived in an ARCHIVE MESSAGE. That is an address-space confusion, not a
 * prompt-quality problem, and more words do not fix it.
 *
 * A locator is the address the model should have had:
 *
 *   - identity is (checkpoint id, archived message index, message digest);
 *   - retrieval is `context_recall` with `depth: "exact"` and that index;
 *   - the result is an OBSERVATION at that point in history, never a claim
 *     about the current workspace.
 *
 * ## Identity is verified, not asserted
 *
 * The digest is `canonicalHash` of the archived message. `resolveArchiveLocator`
 * re-reads the message through the existing recall path and refuses a mismatch.
 * A locator therefore cannot silently point at different bytes after a rewrite,
 * a migration, or a corrupt bundle.
 *
 * ## Untrusted labels
 *
 * Tool arguments are model-written history. A path may contain a newline, a
 * quote, an instruction, or invalid JSON. The locator's IDENTITY never depends
 * on them: only a short path-like token survives into the rendered line, and
 * anything else is omitted. The archive message is the evidence; the label is a
 * hint.
 *
 * ## Default off
 *
 * The locator changes the checkpoint body, so it is behind `archiveLocator`
 * (default false). No tool is registered and no existing tool is intercepted:
 * `read_file` still reads the workspace, and only `context_recall` can open the
 * archive.
 *
 * @module dsh-epistemic-fold/checkpoint/locator
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { EventSource } from './archive-refs.ts'
import { canonicalHash } from './hash.ts'
import { recall } from '../recall/recall.ts'
import type { FoldBundleStore } from '../types.ts'

/** How many addresses one checkpoint may carry. */
export const MAX_ARCHIVE_LOCATORS = 3

/** Hard bound on the rendered section, so a locator list cannot become a transcript. */
export const MAX_LOCATOR_SECTION_CHARS = 720

/** Longest label kept from an untrusted argument. */
export const MAX_LOCATOR_LABEL_CHARS = 96

/**
 * Tools whose result is an observation. Actions are excluded: a write is not
 * evidence about what was read, and `finish` is a marker.
 */
const ACTION_TOOLS = new Set(['write_file', 'edit_file', 'finish'])

/** The argument keys that name a location, in order of usefulness. */
const LABEL_KEYS = ['path', 'query', 'pattern', 'url'] as const

/**
 * A label is kept only when it is ONE path-like token.
 *
 * Spaces are excluded deliberately. A model-written path containing
 * `IGNORE ALL PREVIOUS INSTRUCTIONS` is not a path, and rendering it beside a
 * real retrieval call would give it the shape of runtime-authored text. The
 * address survives without the label; the injection does not.
 */
const SAFE_LABEL = /^[A-Za-z0-9._/\\@:+-]{1,96}$/u
const SAFE_TOOL = /^[a-z][a-z0-9_-]{0,40}$/u
const SAFE_CHECKPOINT = /^[A-Za-z0-9-]{8,80}$/u

/** One archived message the model may open, with its verified identity. */
export interface ArchiveLocator {
  readonly checkpointId: string
  /** Index in the archived message list; the `offset` an exact page takes. */
  readonly messageIndex: number
  /** `canonicalHash` of the archived message, checked again on resolution. */
  readonly messageDigest: string
  readonly kind: 'tool-result'
  readonly tool: string
  /** An untrusted, sanitized hint; never part of the identity. */
  readonly label?: string
  /** How many characters the observation had; a relevance hint, not content. */
  readonly observedChars: number
}

interface ToolCall {
  readonly name: string
  readonly label?: string
}

function textOf(message: Message): string {
  return message.content
    .map(block => block.type === 'text' ? block.text : '')
    .filter(text => text.length > 0)
    .join('\n')
}

/** A safe label from one tool-call's JSON arguments, or `undefined`. */
function labelOf(argumentsText: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsText)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  for (const key of LABEL_KEYS) {
    const value = (parsed as Record<string, unknown>)[key]
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.length > 0 && trimmed.length <= MAX_LOCATOR_LABEL_CHARS && SAFE_LABEL.test(trimmed)) {
        return trimmed
      }
    }
  }
  return undefined
}

/** Every assistant tool call in the span, keyed by call id. */
function toolCallsOf(messages: readonly Message[]): Map<string, ToolCall> {
  const calls = new Map<string, ToolCall>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'tool-call' || block.name === undefined || !SAFE_TOOL.test(block.name)) continue
      const id = String(block.id)
      if (id.length === 0) continue
      const label = block.arguments === undefined ? undefined : labelOf(block.arguments)
      calls.set(id, label === undefined ? { name: block.name } : { name: block.name, label })
    }
  }
  return calls
}

/**
 * Select the archived tool-result messages worth addressing.
 *
 * Ordered by archive position, so two reads of one path at different times stay
 * distinguishable. Bounded to the newest `limit`; within that window the order
 * is chronological. Identical (tool, label, digest) triples are deduplicated —
 * they would open byte-identical observations.
 *
 * @param messages - the archived messages of one fold, in archive order.
 * @param checkpointId - the checkpoint that holds them.
 * @param options.limit - maximum addresses; capped at {@link MAX_ARCHIVE_LOCATORS}.
 * @returns the locators, possibly empty.
 */
export function selectArchiveLocators(
  messages: readonly Message[],
  checkpointId: string,
  options: { readonly limit?: number } = {},
): readonly ArchiveLocator[] {
  if (!SAFE_CHECKPOINT.test(checkpointId)) return []
  const calls = toolCallsOf(messages)
  const found: ArchiveLocator[] = []
  const seen = new Set<string>()
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== 'tool' || message.toolCallId === undefined) continue
    const call = calls.get(String(message.toolCallId))
    if (call === undefined || ACTION_TOOLS.has(call.name)) continue
    const text = textOf(message)
    if (text.length === 0) continue
    const digest = canonicalHash(message)
    const key = `${call.name}\0${call.label ?? ''}\0${digest}`
    if (seen.has(key)) continue
    seen.add(key)
    found.push({
      checkpointId,
      messageIndex,
      messageDigest: digest,
      kind: 'tool-result',
      tool: call.name,
      ...(call.label === undefined ? {} : { label: call.label }),
      observedChars: text.length,
    })
  }
  const limit = Math.max(1, Math.min(options.limit ?? MAX_ARCHIVE_LOCATORS, MAX_ARCHIVE_LOCATORS))
  return found.slice(Math.max(0, found.length - limit))
}

/** One locator rendered as a single model-readable line. */
export function renderArchiveLocator(locator: ArchiveLocator): string {
  const label = locator.label === undefined ? '' : ` ${locator.label}`
  return `- archived observation from ${locator.tool}${label} @${locator.messageIndex}`
    + ` -> context_recall {"ref":"cp:${locator.checkpointId}","depth":"exact",`
    + `"offset":${locator.messageIndex},"limit":1}`
}

/**
 * Render the section, or `''` when it would not fit.
 *
 * A whole locator is dropped rather than truncated: half an address is worse
 * than no address, because the model cannot tell which part is missing. The
 * checkpoint's marker and the existing recall affordance remain.
 *
 * @param locators - selected addresses.
 * @returns a bounded section, or the empty string.
 */
export function renderArchiveLocatorSection(locators: readonly ArchiveLocator[]): string {
  if (locators.length === 0) return ''
  const header = [
    'Historical evidence (archived messages, NOT current workspace files)',
    'These are observations at the time they were read; opening one does not read the current workspace.',
  ]
  const lines = locators.map(renderArchiveLocator)
  while (lines.length > 0) {
    const text = [...header, ...lines].join('\n')
    if (text.length <= MAX_LOCATOR_SECTION_CHARS) return text
    lines.pop()
  }
  return ''
}

/** The outcome of opening one locator. */
export type LocatorResolution =
  | { readonly status: 'resolved'; readonly message: Message; readonly historical: true }
  | { readonly status: 'unavailable'; readonly reason: string }

/**
 * Open one locator through the EXISTING recall path and verify its identity.
 *
 * The requesting session is supplied by the caller and never read from the
 * locator: a checkpoint id alone must not grant access to another session's
 * archive. The store's own session check is the authority, so this function
 * cannot widen access by construction.
 *
 * @param options.store - the bundle store.
 * @param options.sessionId - the session asking.
 * @param options.locator - the address.
 * @param options.source - ref resolution for a referential archive.
 * @returns the archived message, or an explicit unavailability.
 */
export async function resolveArchiveLocator(options: {
  readonly store: FoldBundleStore
  readonly sessionId: SessionId
  readonly locator: ArchiveLocator
  readonly source?: EventSource
}): Promise<LocatorResolution> {
  const { locator } = options
  if (!SAFE_CHECKPOINT.test(locator.checkpointId)) {
    return { status: 'unavailable', reason: 'invalid checkpoint reference' }
  }
  const result = await recall({
    store: options.store,
    sessionId: options.sessionId,
    checkpointId: locator.checkpointId,
    depth: 'exact',
    offset: locator.messageIndex,
    limit: 1,
    ...(options.source === undefined ? {} : { source: options.source }),
  })
  if (result === null) return { status: 'unavailable', reason: 'bundle not found' }
  if (result.unavailable !== undefined) return { status: 'unavailable', reason: result.unavailable }
  const message = result.page?.messages[0]
  if (message === undefined) return { status: 'unavailable', reason: 'archived message absent' }
  if (canonicalHash(message) !== locator.messageDigest) {
    return { status: 'unavailable', reason: 'archived message digest mismatch' }
  }
  return { status: 'resolved', message, historical: true }
}
