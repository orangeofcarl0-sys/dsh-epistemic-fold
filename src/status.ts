/**
 * The `/context status` diagnostic surface (RC2 §3).
 *
 * A user running a long session needs one question answered without reading the
 * session log: *what is this mode doing to my context right now, and what has it
 * cost?* This module builds that answer.
 *
 * ## Why the model is separate from the command
 *
 * {@link buildContextStatus} is a PURE function over data the caller already
 * has. The command handler, a report, and a test all render the same model, so
 * the numbers a user sees cannot diverge from the numbers a report cites — and
 * the whole surface is testable without a live agent.
 *
 * ## The rule that shapes every field
 *
 * **A figure is reported as MEASURED or as ESTIMATED, never as a bare number.**
 * The project learned this the hard way in RC1.1, where a cache-contract
 * measurement was presented as a price result. So:
 *
 *  - token counts come from the real meter and are `measured`;
 *  - checkpoint and recall counts come from the real session log and are
 *    `measured`;
 *  - MONEY is `estimated`, because the true bill is the provider's, and the
 *    projection uses the routed model's published prices against the observed
 *    token split. It is labelled as an estimate in the rendered output.
 *
 * When a figure cannot be established at all, it is `undefined` and the renderer
 * prints `unknown` — it is never silently zero, because "no data" and "zero"
 * mean opposite things to someone deciding whether a mode is working.
 *
 * @module dsh-epistemic-fold/status
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { locateFoldFrontier } from './frontier.ts'
import { costOf } from './economics-profile.ts'
import type { ContextEconomicsProfile } from './economics-profile.ts'
import { isTierModeName } from './preset.ts'
import type { FoldModeName, TierModeName } from './preset.ts'
import { parseCheckpointMarker } from './checkpoint-marker.ts'
import { EXACT_PAGE_LIMIT } from './recall.ts'

/** How a figure was obtained. Printed alongside it so it is never assumed. */
export type FigureBasis = 'measured' | 'estimated'

/** A number with the basis it was obtained on. */
export interface Figure {
  readonly value: number
  readonly basis: FigureBasis
  /** What the number means, for a reader who did not build it. */
  readonly note?: string
}

/**
 * The lifecycle scenarios a long session passes through (RC2 §2).
 *
 * Reported because they change what the numbers MEAN: a fold count after a
 * restart is not the same observation as a fold count in one uninterrupted run.
 */
export interface ContextLifecycle {
  /** The routed provider/model, when the session has a durable header. */
  readonly route?: string
  /** How many times the model changed mid-session. */
  readonly modelChanges: number
  /** How many compaction transactions the log records, in total. */
  readonly compactions: number
  /** How many of those were ROOT rebases (as opposed to leaf folds). */
  readonly roots: number
  /** How many were leaf folds. */
  readonly leaves: number
  /** Compaction transactions that ended with an error recorded. */
  readonly failedCompactions: number
  /** Whether the session shows a resume/restart boundary. */
  readonly resumed: boolean
}

/** Everything `/context status` reports. */
export interface ContextStatus {
  /** The configured mode name, tier or not. */
  readonly mode: FoldModeName
  /** The tier this mode names, when it names one. */
  readonly tier?: TierModeName
  /** The tier's one-line claim, when there is one. */
  readonly tierSummary?: string
  /** Whether the tier's claim is measured or a hypothesis. */
  readonly tierEvidence?: string
  /**
   * `current context`: the prompt pressure the next request would carry.
   *
   * `measured` — it is the token meter's own reading of the live surface.
   */
  readonly currentContext: Figure
  /** The routed model's window, when known. */
  readonly contextWindow?: number
  /** Occupancy as a fraction of the window, when the window is known. */
  readonly occupancy?: number
  /** The fold threshold this configuration resolves to, when resolvable. */
  readonly foldThreshold?: number
  /**
   * `archived history`: tokens held in published checkpoints' archives.
   *
   * `measured` — summed from the bundles the store actually holds. This is
   * history that has LEFT the surface but is still recoverable, so it is the
   * number that tells a user how much the mode has folded away.
   */
  readonly archivedTokens?: Figure
  /** How many archived messages that represents. */
  readonly archivedMessages?: number
  /** `checkpoint count`: EF checkpoints currently frozen on the surface. */
  readonly checkpoints: Figure
  /** `recalls`: how many times the model read folded history back. */
  readonly recalls: Figure
  /** How many `context_search` calls were made. */
  readonly searches: Figure
  /** `folds / roots`, and the other lifecycle counters. */
  readonly lifecycle: ContextLifecycle
  /**
   * `estimated/realized cost`.
   *
   * `estimated` when a profile and an observed token split exist. ABSENT when
   * they do not — a session with no provider calls has no cost to report, and
   * printing `0.00` would read as "this mode is free".
   */
  readonly cost?: Figure
  /**
   * The profile the estimate was priced with.
   *
   * Named instead of a currency: the profile schema declares per-million rates
   * and NO currency, so printing `USD` would assert something the pricing data
   * does not say. The reader gets the exact rates' provenance instead.
   */
  readonly costProfileId?: string
}

/** The inputs the status model needs; all optional so it degrades honestly. */
export interface ContextStatusInput {
  readonly mode: FoldModeName
  readonly session: Session
  /** The token meter's reading of the live surface. */
  readonly measurement?: TokenMeasurement
  /** The routed model's window, when known. */
  readonly contextWindow?: number
  /** The fold threshold this configuration resolves to, when known. */
  readonly foldThreshold?: number
  /** Bundles the store holds for this session, for the archive figures. */
  readonly bundles?: readonly {
    readonly archive: { readonly shadowedMessages: readonly { readonly content: readonly unknown[] }[] }
  }[]
  /** The priced profile for the routed model, for the cost estimate. */
  readonly profile?: ContextEconomicsProfile
  /** Observed usage for the cost estimate. */
  readonly usage?: {
    readonly uncachedInputTokens: number
    readonly cacheReadTokens: number
    readonly cacheWriteTokens?: number
    readonly outputTokens: number
  }
  /** The tier's summary/evidence, when the mode names one. */
  readonly tier?: { readonly summary: string; readonly evidence: string }
}

/**
 * Count the lifecycle facts a session log records.
 *
 * Reads the durable log rather than any in-memory counter, so the answer is the
 * same after a restart as it was before one — which is the point of reporting
 * it: a resumed session's numbers must not reset.
 */
function readLifecycle(session: Session): ContextLifecycle {
  let modelChanges = 0
  let compactions = 0
  let failedCompactions = 0
  let resumed = false
  let route: string | undefined

  const header = session.requestHeader?.()
  if (header?.config !== undefined) {
    const { provider, model } = header.config
    if (typeof provider === 'string' && typeof model === 'string') route = `${provider}/${model}`
  }

  for (let raw = 0; raw < session.seq; raw += 1) {
    const event = session.eventAt(raw as never)
    if (event === undefined) continue
    if (event.type === 'compaction/end') {
      compactions += 1
      const data = event.data as { error?: string } | undefined
      if (data?.error !== undefined) failedCompactions += 1
    }
    // A model change is a durable user-role notice the model-selection install
    // appends; the session header is the only other routing record.
    if (event.type === 'user/message') {
      const message = session.deriveEventMessage(event)
      const text = message?.content
        .map(block => (block.type === 'text' ? block.text : ''))
        .join('') ?? ''
      if (text.includes('[model changed:')) modelChanges += 1
    }
    // A RESUME boundary is the request header's own reason: `initial` is a new
    // conversation, `resume` is a loop instance's first request over a log that
    // already had headers (process restart, fork seed). Reading it from the
    // header rather than inferring it means the flag says what the runtime
    // recorded, not what a heuristic guessed.
    if (event.type === 'request/header') {
      const reason = (event.data as { reason?: string } | undefined)?.reason
      if (reason === 'resume') resumed = true
    }
  }

  // Leaf vs root is read from the surface's own checkpoints, which is the same
  // identity the frontier uses: a checkpoint's mode letter is authoritative.
  const frontier = locateFoldFrontier(session)
  let roots = 0
  let leaves = 0
  for (const checkpoint of frontier.frozen) {
    if (checkpoint.mode === 'root') roots += 1
    else leaves += 1
  }
  return { ...(route === undefined ? {} : { route }), modelChanges, compactions, roots, leaves, failedCompactions, resumed }
}

/** Count `context_search` / `context_recall` calls in the durable log. */
function countRecallCalls(session: Session): { readonly searches: number; readonly recalls: number } {
  let searches = 0
  let recalls = 0
  for (let raw = 0; raw < session.seq; raw += 1) {
    const event = session.eventAt(raw as never)
    if (event?.type !== 'tool/call') continue
    const name = (event.data as { name?: string } | undefined)?.name
    if (name === 'context_search') searches += 1
    else if (name === 'context_recall') recalls += 1
  }
  return { searches, recalls }
}

/**
 * Sum the archived messages the store holds for one session.
 *
 * @returns message count and a rough token figure, or `undefined` when the
 *   caller supplied no bundles (in which case the archive size is UNKNOWN, not
 *   zero — the two mean opposite things).
 */
function archiveFigures(bundles: ContextStatusInput['bundles']): {
  readonly messages: number
  readonly tokens: number
} | undefined {
  if (bundles === undefined) return undefined
  let messages = 0
  let characters = 0
  for (const bundle of bundles) {
    for (const message of bundle.archive.shadowedMessages) {
      messages += 1
      for (const block of message.content) {
        const text = (block as { type?: string; text?: string })
        if (text.type === 'text' && typeof text.text === 'string') characters += text.text.length
      }
    }
  }
  // The same fixed density heuristic the token meter uses for un-priced text.
  return { messages, tokens: Math.ceil(characters / 4) }
}

/**
 * Build the status model for one session.
 *
 * Every optional input degrades to `undefined` rather than to zero, and the
 * renderer prints `unknown`, so a reader can always tell "not established" from
 * "established as zero".
 */
export function buildContextStatus(input: ContextStatusInput): ContextStatus {
  const { session, measurement } = input
  const lifecycle = readLifecycle(session)
  const calls = countRecallCalls(session)
  const frontier = locateFoldFrontier(session)
  const archive = archiveFigures(input.bundles)

  const currentContext: Figure = measurement === undefined
    ? { value: 0, basis: 'measured', note: 'no token meter reading was supplied' }
    : {
      value: measurement.totalTokens,
      basis: 'measured',
      note: 'the prompt pressure the next request would carry',
    }

  const cost = input.profile !== undefined && input.usage !== undefined
    ? (() => {
      const breakdown = costOf(input.profile, {
        uncachedInputTokens: input.usage.uncachedInputTokens,
        cacheReadTokens: input.usage.cacheReadTokens,
        outputTokens: input.usage.outputTokens,
        ...(input.usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: input.usage.cacheWriteTokens }),
      })
      return {
        value: breakdown.totalCost,
        basis: 'estimated' as const,
        note: 'published prices applied to the observed token split; the provider bill is authoritative',
      }
    })()
    : undefined

  return {
    mode: input.mode,
    ...(isTierModeName(input.mode) ? { tier: input.mode } : {}),
    ...(input.tier === undefined ? {} : { tierSummary: input.tier.summary, tierEvidence: input.tier.evidence }),
    currentContext,
    ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
    ...(input.contextWindow === undefined || input.contextWindow <= 0
      ? {}
      : { occupancy: currentContext.value / input.contextWindow }),
    ...(input.foldThreshold === undefined ? {} : { foldThreshold: input.foldThreshold }),
    ...(archive === undefined
      ? {}
      : {
        archivedTokens: {
          value: archive.tokens,
          basis: 'measured' as const,
          note: 'tokens held in published checkpoint archives — folded off the surface, still recoverable',
        },
        archivedMessages: archive.messages,
      }),
    checkpoints: {
      value: frontier.frozenCount,
      basis: 'measured',
      note: 'EF checkpoints currently frozen on the surface',
    },
    recalls: { value: calls.recalls, basis: 'measured', note: 'context_recall calls in the durable log' },
    searches: { value: calls.searches, basis: 'measured', note: 'context_search calls in the durable log' },
    lifecycle,
    ...(cost === undefined ? {} : { cost }),
    ...(cost === undefined || input.profile === undefined
      ? {}
      : { costProfileId: input.profile.id }),
  }
}

/** Format one figure, marking its basis so it is never read as exact. */
function figure(value: number | undefined, basis?: FigureBasis): string {
  if (value === undefined) return 'unknown'
  const rendered = Number.isInteger(value) ? String(value) : value.toFixed(6)
  if (basis === 'estimated') return `~${rendered} (estimated)`
  return rendered
}

/**
 * Render the status for a user.
 *
 * Deliberately plain text: it is returned by a command handler and rendered
 * outside model history, so it must read correctly in any client without
 * markup support.
 */
export function contextStatusToText(status: ContextStatus): string {
  const lines: string[] = []
  const modeLine = status.tier === undefined
    ? `${status.mode} (not a tier — the engine default)`
    : `${status.tier}`
  lines.push(`context mode: ${modeLine}`)
  if (status.tierSummary !== undefined) lines.push(`  ${status.tierSummary}`)
  if (status.tierEvidence !== undefined && status.tierEvidence !== 'measured') {
    // The status of the claim is shown to the user, not only to a report.
    lines.push(`  evidence: ${status.tierEvidence.toUpperCase()} — this mode's benefit is not yet measured`)
  }

  lines.push('')
  lines.push('current context:')
  lines.push(`  pressure        ${figure(status.currentContext.value)} tokens`)
  if (status.contextWindow !== undefined) {
    lines.push(`  window          ${figure(status.contextWindow)} tokens`)
  }
  if (status.occupancy !== undefined) {
    lines.push(`  occupancy       ${(status.occupancy * 100).toFixed(1)}%`)
  }
  if (status.foldThreshold !== undefined) {
    lines.push(`  fold threshold  ${figure(status.foldThreshold)} tokens`)
  }

  lines.push('')
  lines.push('archived history:')
  lines.push(`  archived tokens ${figure(status.archivedTokens?.value)}`)
  lines.push(`  archived msgs   ${figure(status.archivedMessages)}`)
  lines.push(`  checkpoints     ${figure(status.checkpoints.value)}`)

  lines.push('')
  lines.push('retrieval:')
  lines.push(`  recalls         ${figure(status.recalls.value)}`)
  lines.push(`  searches        ${figure(status.searches.value)}`)

  lines.push('')
  lines.push('folds:')
  lines.push(`  leaf folds      ${figure(status.lifecycle.leaves)}`)
  lines.push(`  root rebases    ${figure(status.lifecycle.roots)}`)
  lines.push(`  compactions     ${figure(status.lifecycle.compactions)}`)
  if (status.lifecycle.failedCompactions > 0) {
    lines.push(`  FAILED          ${figure(status.lifecycle.failedCompactions)}`)
  }
  if (status.lifecycle.route !== undefined) {
    lines.push(`  route           ${status.lifecycle.route}`)
  }
  if (status.lifecycle.modelChanges > 0) {
    lines.push(`  model changes   ${figure(status.lifecycle.modelChanges)}`)
  }
  if (status.lifecycle.resumed) lines.push('  resumed         yes')

  lines.push('')
  lines.push('cost:')
  if (status.cost === undefined) {
    // Never `0.00`: a session with no priced calls has an UNKNOWN cost, and
    // printing zero would read as "this mode is free".
    lines.push('  unknown         (no priced calls in this session)')
  } else {
    lines.push(`  ${figure(status.cost.value, status.cost.basis)}`)
    if (status.costProfileId !== undefined) lines.push(`  priced with     ${status.costProfileId}`)
  }
  return lines.join(String.fromCharCode(10))
}

/** A one-line summary, for a status bar or a log line. */
export function contextStatusToLine(status: ContextStatus): string {
  const parts = [
    `mode=${status.mode}`,
    `ctx=${status.currentContext.value}`,
    status.contextWindow === undefined ? undefined : `window=${status.contextWindow}`,
    `checkpoints=${status.checkpoints.value}`,
    `recalls=${status.recalls.value}`,
    `folds=${status.lifecycle.leaves}`,
    `roots=${status.lifecycle.roots}`,
    status.cost === undefined ? 'cost=unknown' : `cost~${status.cost.value.toFixed(4)}`,
  ].filter((part): part is string => part !== undefined)
  return parts.join(' ')
}

/** The exact-page size recall uses, re-exported so a status surface can cite it. */
export const STATUS_EXACT_PAGE_LIMIT = EXACT_PAGE_LIMIT

/** Marker parse passthrough, so a status surface never regexes identity itself. */
export const statusParseCheckpointMarker = parseCheckpointMarker
