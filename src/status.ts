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
 * ## The two rules that shape every field
 *
 * **1. A figure is MEASURED or ESTIMATED, never a bare number.** The project
 * learned this the hard way in RC1.1, where a cache-contract measurement was
 * presented as a price result. So provider-reported token usage is `measured`
 * because DSH's own `tokenUsage` projection accumulated it; MONEY is `estimated`
 * because the provider's bill is authoritative; and a figure derived from a
 * heuristic is `estimated` even when the underlying text is real — see
 * {@link archivedTokens}.
 *
 * **2. An unestablished figure is `undefined`, and renders `unknown` — never 0.**
 * "No data" and "zero" mean opposite things to someone deciding whether a mode
 * is working, so the renderer distinguishes them and this module never
 * substitutes one for the other.
 *
 * ## Current vs lifetime (RC2.1)
 *
 * Two pairs of numbers look alike and mean different things, so they are
 * reported separately and named for which one they are:
 *
 *  - {@link checkpoints} is the count of EF checkpoints **currently frozen on the
 *    surface** — what the model can see right now.
 *  - {@link folds} is the **lifetime** count of folds that have ever been
 *    committed, read from the bundles the store holds.
 *
 * A session that folded 40 times and then rebased down to one checkpoint has
 * `checkpoints = 1` and `folds.leaves = 40`. Reporting either number under the
 * other's name would be wrong in a way a user could not detect.
 *
 * @module dsh-epistemic-fold/status
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { locateFoldFrontier } from './frontier.ts'
import { compactionFailed, requestHeaderReason, toolCallName } from './event-data.ts'
import { costOf } from './economics-profile.ts'
import type { ContextEconomicsProfile } from './economics-profile.ts'
import { isTierModeName } from './preset.ts'
import type { FoldModeName, TierModeName } from './preset.ts'

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
  /** Compaction transactions that ended with an error recorded. */
  readonly failedCompactions: number
  /** Whether the session shows a resume/restart boundary. */
  readonly resumed: boolean
}

/**
 * LIFETIME fold counts: how many folds this session has ever committed.
 *
 * Distinct from {@link ContextStatus.checkpoints}, which counts what is frozen
 * on the surface NOW. Read from the bundles the store holds, which are written
 * once and never removed in production — so this is a lifetime record, and it
 * survives a rebase that collapses the surface back to a single checkpoint.
 */
export interface FoldLifetimeCounts {
  readonly leaves: Figure
  readonly roots: Figure
  /**
   * Emergency rebases: overflow recovery inside a live turn.
   *
   * Counted apart from `roots` because the two are different EVENTS that happen
   * to share a surface effect. A root is deferred maintenance chosen at idle; an
   * emergency rebase is forced because the provider already refused the request.
   * Folding them into one number would erase exactly the distinction a reader
   * needs to tell "maintenance ran" from "recovery ran".
   */
  readonly emergencies: Figure
  /**
   * Whether the counts are complete.
   *
   * `false` when the store could not be read, in which case the counts are
   * LIFETIME-MINIMUM values rather than totals. Reported so a reader is not told
   * a lower bound is a total.
   */
  readonly complete: boolean
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
   * ABSENT when no reading exists — a session before its first provider report
   * has an UNKNOWN pressure, and `0` would say the context is empty, which is the
   * opposite of the truth for a session that has not been measured yet.
   */
  readonly currentContext?: Figure
  /** The routed model's window, when known. */
  readonly contextWindow?: number
  /**
   * Occupancy as a fraction of the window.
   *
   * ABSENT unless BOTH the pressure and the window are known. A ratio with a
   * missing numerator is not a ratio.
   */
  readonly occupancy?: number
  /** The fold threshold this configuration resolves to, when resolvable. */
  readonly foldThreshold?: number
  /**
   * `archived history`: tokens held in published checkpoints' archives.
   *
   * **`estimated`, not `measured`.** The message COUNT is measured — it is a
   * count of real archived messages. The TOKEN figure is derived from a fixed
   * `chars / 4` density heuristic, which systematically misprices CJK text and
   * JSON, so it is an estimate and is labelled as one. RC2 shipped this as
   * `measured`, which was wrong: the input was real but the conversion to tokens
   * was a heuristic, and calling that measured is the RC1.1 error repeating.
   */
  readonly archivedTokens?: Figure
  /** How many archived messages that represents. `measured` — it is a count. */
  readonly archivedMessages?: number
  /**
   * EF checkpoints CURRENTLY frozen on the surface.
   *
   * What the model can see now. Not a lifetime total — see {@link folds}.
   */
  readonly checkpoints: Figure
  /** `recalls`: how many times the model read folded history back. */
  readonly recalls: Figure
  /** How many `context_search` calls were made. */
  readonly searches: Figure
  /** `folds`: LIFETIME counts, distinct from the current checkpoint count. */
  readonly folds: FoldLifetimeCounts
  /** The lifecycle facts a long session passes through. */
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
  /**
   * Provider-reported cumulative usage for this session, straight from DSH.
   *
   * Taken from the token meter's own `tokenUsage` projection rather than
   * recomputed from the log, so the figure a user sees here is the same one the
   * rest of the harness reports. ABSENT before any provider reports usage.
   */
  readonly usage?: TokenUsageProjection
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
  /**
   * The bundles the store holds for this session.
   *
   * Used for TWO distinct figures: the archive size (how much history is folded
   * away and recoverable) and the LIFETIME fold counts. `undefined` means the
   * store was not consulted, which is not the same as "nothing is archived".
   */
  readonly bundles?: readonly {
    readonly mode?: string
    readonly archive: {
      /** Absent on a referential bundle; the COUNT is present either way. */
      readonly shadowedMessages?: readonly { readonly content: readonly unknown[] }[]
      readonly messageCount: number
    }
  }[]
  /**
   * The fold counts as the ENGINE reports them, when the caller has them.
   *
   * Preferred over deriving them from bundles, because the engine knows what it
   * actually committed rather than what is still on disk.
   */
  readonly foldCounts?: {
    readonly leaves: number
    readonly roots: number
    /**
     * Emergency rebases, when the engine reports them.
     *
     * Optional because an older caller may not supply it; `undefined` means
     * "not reported" and the bundle-derived fallback is used instead, rather
     * than reporting a zero that would claim none happened.
     */
    readonly emergencies?: number
  }
  /** The priced profile for the routed model, for the cost estimate. */
  readonly profile?: ContextEconomicsProfile
  /**
   * Provider-reported cumulative usage.
   *
   * Supplied from DSH's own `tokenUsage` projection. Absent before any provider
   * reports usage, in which case the cost cannot be priced and is omitted.
   */
  readonly usage?: TokenUsageProjection
  /** The tier's summary/evidence, when the mode names one. */
  readonly tier?: { readonly summary: string; readonly evidence: string }
}

/**
 * Count the lifecycle facts a session log records.
 *
 * Reads the durable log rather than any in-memory counter, so the answer is the
 * same after a restart as it was before one — which is the point of reporting
 * it: a resumed session's numbers must not reset.
 *
 * This deliberately does NOT report leaf/root counts. Those are LIFETIME figures
 * derived from bundles, and the version of this function that read them off the
 * SURFACE frontier reported a current count under a lifetime name — a session
 * that folded 40 times and rebased to one checkpoint would have shown `leaves=1`.
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
      if (compactionFailed(event)) failedCompactions += 1
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
      if (requestHeaderReason(event) === 'resume') resumed = true
    }
  }

  return {
    ...(route === undefined ? {} : { route }),
    modelChanges,
    compactions,
    failedCompactions,
    resumed,
  }
}

/** Count `context_search` / `context_recall` calls in the durable log. */
function countRecallCalls(session: Session): { readonly searches: number; readonly recalls: number } {
  let searches = 0
  let recalls = 0
  for (let raw = 0; raw < session.seq; raw += 1) {
    const event = session.eventAt(raw as never)
    if (event?.type !== 'tool/call') continue
    const name = toolCallName(event)
    if (name === 'context_search') searches += 1
    else if (name === 'context_recall') recalls += 1
  }
  return { searches, recalls }
}

/**
 * Sum the archived messages the store holds for one session.
 *
 * @returns the message count (measured) and a token estimate, or `undefined`
 *   when the caller supplied no bundles — in which case the archive size is
 *   UNKNOWN, not zero, and the two mean opposite things.
 */
function archiveFigures(bundles: ContextStatusInput['bundles']): {
  readonly messages: number
  readonly tokens: number
} | undefined {
  if (bundles === undefined) return undefined
  let messages = 0
  let characters = 0
  for (const bundle of bundles) {
    // The COUNT is always available and is what the caller reports as
    // `measured`. A referential bundle does not carry its message bytes, so the
    // token ESTIMATE silently covers only the bundles that do — which is why
    // that figure is `estimated` and why this loop must not treat a missing
    // archive as an empty one.
    messages += bundle.archive.messageCount
    for (const message of bundle.archive.shadowedMessages ?? []) {
      for (const block of message.content) {
        const text = (block as { type?: string; text?: string })
        if (text.type === 'text' && typeof text.text === 'string') characters += text.text.length
      }
    }
  }
  // The same fixed density heuristic the token meter uses for un-priced text.
  // It is a HEURISTIC: it systematically underprices CJK text and JSON schemas,
  // so the caller must report this figure as `estimated`. The message COUNT
  // above is a real count and stays `measured`.
  return { messages, tokens: Math.ceil(characters / 4) }
}

/**
 * LIFETIME fold counts, from the bundles the store holds.
 *
 * Bundles are written once and never removed in production, so this is a record
 * of every fold the session has committed — including folds whose checkpoints a
 * later root rebase has since collapsed off the surface.
 *
 * @returns the counts and whether they are complete.
 */
function foldCountsFrom(bundles: ContextStatusInput['bundles']): FoldLifetimeCounts {
  if (bundles === undefined) {
    // The store was not consulted. A zero here would claim the session never
    // folded, which is exactly the confusion this split exists to prevent.
    return {
      leaves: { value: 0, basis: 'measured', note: 'store not consulted — count unavailable' },
      roots: { value: 0, basis: 'measured', note: 'store not consulted — count unavailable' },
      emergencies: { value: 0, basis: 'measured', note: 'store not consulted — count unavailable' },
      complete: false,
    }
  }
  let leaves = 0
  let roots = 0
  let emergencies = 0
  for (const bundle of bundles) {
    // Classified by mode, not by `isRebaseMode`: the STRUCTURAL question and the
    // AUDIT question are different, and this function answers the audit one.
    // `isRebaseMode` is what the surface-shape rules use.
    switch (bundle.mode) {
      case 'leaf': leaves += 1; break
      case 'root': roots += 1; break
      case 'emergency': emergencies += 1; break
      // A bundle with no readable mode is a leaf by EF's own convention: only
      // `leaf` grows the prefix, and an unreadable marker is not evidence of a
      // rebase. Counting it as a leaf keeps the total honest instead of
      // dropping it from every column.
      default: leaves += 1; break
    }
  }
  return {
    leaves: {
      value: leaves,
      basis: 'measured',
      note: 'leaf folds this session has ever committed (lifetime, not the current surface)',
    },
    roots: {
      value: roots,
      basis: 'measured',
      note: 'root rebases this session has ever committed (lifetime)',
    },
    emergencies: {
      value: emergencies,
      basis: 'measured',
      note: 'emergency rebases this session has ever committed (provider-overflow recovery)',
    },
    complete: true,
  }
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
  const folds: FoldLifetimeCounts = input.foldCounts !== undefined
    ? {
      leaves: {
        value: input.foldCounts.leaves,
        basis: 'measured' as const,
        note: 'leaf folds this session has ever committed (lifetime)',
      },
      roots: {
        value: input.foldCounts.roots,
        basis: 'measured' as const,
        note: 'root rebases this session has ever committed (lifetime)',
      },
      // A caller that does not report emergencies gets the bundle-derived count
      // rather than a fabricated zero, so "not reported" never reads as "none".
      emergencies: input.foldCounts.emergencies === undefined
        ? foldCountsFrom(input.bundles).emergencies
        : {
          value: input.foldCounts.emergencies,
          basis: 'measured' as const,
          note: 'emergency rebases this session has ever committed (overflow recovery)',
        },
      complete: true,
    }
    : foldCountsFrom(input.bundles)

  // NO measurement means UNKNOWN, not zero. A session before its first provider
  // report has an unestablished pressure, and reporting `0 measured` would say
  // the context is empty — the opposite of the truth.
  const currentContext: Figure | undefined = measurement === undefined
    ? undefined
    : {
      value: measurement.totalTokens,
      basis: 'measured',
      note: 'the prompt pressure the next request would carry',
    }

  // Cost is priced from DSH's own provider-reported usage, so both halves must
  // exist: no profile means no prices, no usage means no split to price.
  const cost = input.profile !== undefined && input.usage !== undefined
    ? (() => {
      const breakdown = costOf(input.profile, {
        uncachedInputTokens: input.usage.uncachedInputTokens,
        cacheReadTokens: input.usage.cacheReadTokens,
        cacheWriteTokens: input.usage.cacheWriteTokens,
        outputTokens: input.usage.outputTokens,
      })
      return {
        value: breakdown.totalCost,
        basis: 'estimated' as const,
        note: 'published prices applied to the provider-reported split; the provider bill is authoritative',
      }
    })()
    : undefined

  // Occupancy needs BOTH halves. A ratio with a missing numerator is not a ratio.
  const occupancy = currentContext !== undefined
    && input.contextWindow !== undefined
    && input.contextWindow > 0
    ? currentContext.value / input.contextWindow
    : undefined

  return {
    mode: input.mode,
    ...(isTierModeName(input.mode) ? { tier: input.mode } : {}),
    ...(input.tier === undefined ? {} : { tierSummary: input.tier.summary, tierEvidence: input.tier.evidence }),
    ...(currentContext === undefined ? {} : { currentContext }),
    ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
    ...(occupancy === undefined ? {} : { occupancy }),
    ...(input.foldThreshold === undefined ? {} : { foldThreshold: input.foldThreshold }),
    ...(archive === undefined
      ? {}
      : {
        archivedTokens: {
          value: archive.tokens,
          // ESTIMATED: a `chars / 4` heuristic, not a provider count. The input
          // is real; the conversion to tokens is not a measurement.
          basis: 'estimated' as const,
          note: 'archived text priced by a fixed chars/4 heuristic — folded off the surface, still recoverable',
        },
        archivedMessages: archive.messages,
      }),
    checkpoints: {
      value: frontier.frozenCount,
      basis: 'measured',
      note: 'EF checkpoints CURRENTLY frozen on the surface (not a lifetime total)',
    },
    recalls: { value: calls.recalls, basis: 'measured', note: 'context_recall calls in the durable log' },
    searches: { value: calls.searches, basis: 'measured', note: 'context_search calls in the durable log' },
    folds,
    lifecycle,
    ...(cost === undefined ? {} : { cost }),
    ...(cost === undefined || input.profile === undefined
      ? {}
      : { costProfileId: input.profile.id }),
    ...(input.usage === undefined ? {} : { usage: input.usage }),
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
  // `unknown`, not `0`: a session before its first provider report has an
  // unestablished pressure, and printing zero would say the context is empty.
  lines.push(`  pressure        ${figure(status.currentContext?.value, status.currentContext?.basis)} tokens`)
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
  lines.push(`  archived tokens ${figure(status.archivedTokens?.value, status.archivedTokens?.basis)}`)
  lines.push(`  archived msgs   ${figure(status.archivedMessages)}`)
  // Named for what it is: the CURRENT surface, not a lifetime total.
  lines.push(`  checkpoints now ${figure(status.checkpoints.value)}`)

  lines.push('')
  lines.push('retrieval:')
  lines.push(`  recalls         ${figure(status.recalls.value)}`)
  lines.push(`  searches        ${figure(status.searches.value)}`)

  lines.push('')
  // The lifetime counts, labelled as lifetime so they cannot be read as the
  // current surface. A session that folded 40 times and rebased to one
  // checkpoint reads `checkpoints now 1` above and `leaf folds 40` here.
  lines.push('folds (lifetime):')
  lines.push(`  leaf folds      ${figure(status.folds.leaves.value)}`)
  lines.push(`  root rebases    ${figure(status.folds.roots.value)}`)
  if (!status.folds.complete) {
    lines.push('  NOTE            the store was not consulted; these are minimums, not totals')
  }
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
    // Never `0.00`: an unestablished cost has an UNKNOWN value, and printing
    // zero would read as "this mode is free".
    //
    // RC18: two different unknowns, and conflating them sends the reader
    // looking for the wrong thing. No usage means the session has not been
    // billed yet; usage WITHOUT a price card means this deployment has no rates
    // for the route. The second is newly reachable now that pricing no longer
    // falls back to synthetic rates, so the command names it.
    lines.push(status.usage === undefined
      ? '  unknown         (no priced calls in this session)'
      : '  unknown         (no price card for this route)')
  } else {
    lines.push(`  ${figure(status.cost.value, status.cost.basis)}`)
    if (status.costProfileId !== undefined) lines.push(`  priced with     ${status.costProfileId}`)
  }
  if (status.usage !== undefined) {
    // The provider's own cumulative split, so a reader can see the basis of the
    // estimate rather than only its total.
    lines.push('')
    lines.push('provider usage (cumulative, measured):')
    lines.push(`  uncached in     ${figure(status.usage.uncachedInputTokens)}`)
    lines.push(`  cache reads     ${figure(status.usage.cacheReadTokens)}`)
    lines.push(`  cache writes    ${figure(status.usage.cacheWriteTokens)}`)
    lines.push(`  output          ${figure(status.usage.outputTokens)}`)
  }
  return lines.join(String.fromCharCode(10))
}

/**
 * A one-line summary, for a status bar or a log line.
 *
 * `ctx` prints `unknown` when no reading exists, and the fold figures are the
 * LIFETIME counts — the same distinction the full report makes, kept here so the
 * compact form cannot drift from it.
 */
export function contextStatusToLine(status: ContextStatus): string {
  const parts = [
    `mode=${status.mode}`,
    `ctx=${status.currentContext === undefined ? 'unknown' : status.currentContext.value}`,
    status.contextWindow === undefined ? undefined : `window=${status.contextWindow}`,
    `checkpoints=${status.checkpoints.value}`,
    `recalls=${status.recalls.value}`,
    `folds=${status.folds.leaves.value}`,
    `roots=${status.folds.roots.value}`,
    status.cost === undefined ? 'cost=unknown' : `cost~${status.cost.value.toFixed(4)}`,
  ].filter((part): part is string => part !== undefined)
  return parts.join(' ')
}
