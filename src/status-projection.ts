/**
 * The EF status projection (RC4): the Sidebar's data source.
 *
 * ## Why this exists rather than the panel calling `/context status`
 *
 * RC4's directive draws the line: **command = control, Sidebar = observation**.
 * The command renders TEXT for a human; a panel that ran the command and parsed
 * its output would be reading a rendering of the facts instead of the facts, and
 * the two could disagree the moment either changes. So the panel and the command
 * are two renderers over ONE model.
 *
 * ## The constraint that shapes this file
 *
 * A `SessionProjectionRegistry` unit must be a PURE FOLD: `apply(state, event)`
 * sees committed session events and nothing else, and `view(state)` sees only
 * that state. It cannot read the bundle store, the token meter, or a pricing
 * profile. So this projection carries exactly what the EVENT LOG can support —
 * and deliberately does not carry what it cannot:
 *
 *   carried                    derived from
 *   ------                     ------------
 *   mode                       the config, seeded at init
 *   archivedTokens             Σ `compaction/summary`.shadowedTokenCount
 *   folds / roots              `compaction/end` and `compaction/start` pairing
 *   recalls / searches         `tool/call` names
 *   cost                       Σ `assistant/message` usage, priced at view time
 *   resumed / modelChanges     the header reason and the model-change notice
 *
 * **`archivedTokens` is BETTER here than in the command.** The command sums
 * `chars / 4` over archived message text, which is a heuristic and is labelled
 * `estimated`. `shadowedTokenCount` is the meter's own number for the span a fold
 * replaced, so this figure is `measured`. The two renderers therefore disagree by
 * construction, and the disagreement is honest: one has better data.
 *
 * ## It never reaches the model
 *
 * A projection is a CLIENT-facing read surface. Nothing here enters a prompt, so
 * adding it cannot invalidate a prefix cache or grow the context it reports on —
 * which is the whole reason the directive insists the panel be an observation
 * plane.
 *
 * @module dsh-epistemic-fold/status-projection
 */

import { z } from 'zod'
import type { ZodType } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { costOf } from './economics-profile.ts'
import type { ContextEconomicsProfile } from './economics-profile.ts'
import { parseCheckpointMarker } from './checkpoint-marker.ts'
import { isTierModeName } from './preset.ts'
import type { FoldModeName } from './preset.ts'

/** The EF status wire key. */
export const EF_STATUS_KEY = 'epistemicFold.status' as const

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'epistemicFold.status': FoldStatusState
  }
  interface SessionProjectionMap {
    'epistemicFold.status': FoldStatusView
  }
}

/** What the fold accumulates from the event log. */
export interface FoldStatusState {
  /** The configured mode. Seeded at init; a runtime switch is not an event. */
  readonly mode: FoldModeName
  /** Σ shadowedTokenCount over every fold — the meter's own number. */
  readonly archivedTokens: number
  /** Leaf folds that have completed (LIFETIME). */
  readonly folds: number
  /** Root rebases that have completed (LIFETIME). */
  readonly roots: number
  /**
   * EF checkpoints frozen on the surface RIGHT NOW.
   *
   * Distinct from `folds + roots`, which is a lifetime total. A root rebase
   * collapses the surface to one checkpoint, so a session that folded 40 times
   * and rebased has many lifetime folds and one current checkpoint. RC4-A found
   * the panel rendering `folds + roots` under the label "Checkpoints now",
   * which is the same conflation RC2.1 corrected on the command plane.
   *
   * Maintained from the checkpoint markers: every fold adds one (its own
   * checkpoint joins the frozen prefix), and the marker's mode says whether the
   * fold also collapsed the prefix to itself.
   */
  readonly currentCheckpoints: number
  /** `context_recall` calls. */
  readonly recalls: number
  /** `context_search` calls. */
  readonly searches: number
  /** Cumulative provider usage, from assistant settlements. */
  readonly uncachedInputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
  /** Whether any provider usage was reported at all. */
  readonly hasUsage: boolean
  /** A resume boundary was recorded. */
  readonly resumed: boolean
  /** Mid-session model changes. */
  readonly modelChanges: number
  /** Compaction transactions that ended with an error. */
  readonly failedCompactions: number
}

/** What the client renders. Every figure carries how it was obtained. */
export interface FoldStatusView {
  readonly mode: string
  /** Whether the mode names a product tier (vs the engine default). */
  readonly isTier: boolean
  readonly archivedTokens: number
  readonly folds: number
  readonly roots: number
  readonly currentCheckpoints: number
  readonly recalls: number
  readonly searches: number
  readonly resumed: boolean
  readonly modelChanges: number
  readonly failedCompactions: number
  /**
   * Estimated cost, or `null` when it cannot be priced.
   *
   * `null` rather than `0`: a session with no reported usage has an UNKNOWN
   * cost, and a zero would read as "this mode is free" — the same distinction
   * the command plane makes.
   */
  readonly cost: number | null
  /** The profile the cost was priced with, when there is one. */
  readonly costProfileId: string | null
  /** Provider-reported cumulative usage, for a panel that shows the basis. */
  readonly usage: {
    readonly uncachedInputTokens: number
    readonly cacheReadTokens: number
    readonly cacheWriteTokens: number
    readonly outputTokens: number
  } | null
}

const stateSchema = z.looseObject({
  mode: z.string(),
  archivedTokens: z.number(),
  folds: z.number(),
  roots: z.number(),
  currentCheckpoints: z.number(),
  recalls: z.number(),
  searches: z.number(),
  uncachedInputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  outputTokens: z.number(),
  hasUsage: z.boolean(),
  resumed: z.boolean(),
  modelChanges: z.number(),
  failedCompactions: z.number(),
})

const viewSchema = z.looseObject({
  mode: z.string(),
  isTier: z.boolean(),
  archivedTokens: z.number(),
  folds: z.number(),
  roots: z.number(),
  currentCheckpoints: z.number(),
  recalls: z.number(),
  searches: z.number(),
  resumed: z.boolean(),
  modelChanges: z.number(),
  failedCompactions: z.number(),
  cost: z.number().nullable(),
  costProfileId: z.string().nullable(),
  usage: z.object({
    uncachedInputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheWriteTokens: z.number(),
    outputTokens: z.number(),
  }).nullable(),
})

/** Read one signed number out of an event's data, defaulting to 0. */
function numberOf(data: unknown, key: string): number {
  const value = (data as Record<string, unknown> | undefined)?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Fold one committed event into the status state. */
export function reduceStatusEvent(state: FoldStatusState, event: SessionEvent): FoldStatusState {
  switch (event.type) {
    case 'compaction/summary': {
      // The meter's own count for the span this fold replaced. Accumulated
      // rather than recomputed: the archive only grows, and re-deriving it
      // would need the bundle store, which a pure fold cannot read.
      const archivedTokens = state.archivedTokens + numberOf(event.data, 'shadowedTokenCount')
      // Leaf vs root is read from EF's OWN marker inside the checkpoint body,
      // which is the same identity the frontier uses. Counting here rather than
      // at `compaction/end` keeps the classification with the text that carries
      // it; a fold whose summary is unreadable simply is not a root.
      const summary = (event.data as { summary?: readonly { type?: string; text?: string }[] }).summary
      const text = (summary ?? []).map(block => (block.type === 'text' ? block.text ?? '' : '')).join('')
      const marker = parseCheckpointMarker(text)
      const root = marker?.mode === 'root'
      return {
        ...state,
        archivedTokens,
        folds: state.folds + (root ? 0 : 1),
        roots: state.roots + (root ? 1 : 0),
        // A leaf checkpoint JOINS the frozen prefix, so the surface gains one.
        // A root REBASES: the prefix collapses to the single new checkpoint, so
        // the count becomes one rather than growing.
        currentCheckpoints: root ? 1 : state.currentCheckpoints + 1,
      }
    }
    case 'compaction/end': {
      const failed = (event.data as { error?: string } | undefined)?.error !== undefined
      // A failed transaction is COUNTED but is not a fold: `compaction/summary`
      // already counted the ones that produced a checkpoint, so counting here
      // too would double it.
      return failed ? { ...state, failedCompactions: state.failedCompactions + 1 } : state
    }
    case 'tool/call': {
      const name = (event.data as { name?: string } | undefined)?.name
      if (name === 'context_recall') return { ...state, recalls: state.recalls + 1 }
      if (name === 'context_search') return { ...state, searches: state.searches + 1 }
      return state
    }
    case 'assistant/message': {
      // DSH's own `tokenUsage` unit accumulates the same buckets; this keeps a
      // private copy because `view()` receives only this state and therefore
      // cannot read another unit's value to price it.
      const usage = (event.data as { usage?: {
        inputTokens?: number; cacheReadTokens?: number
        cacheWriteTokens?: number; outputTokens?: number
      } } | undefined)?.usage
      if (usage === undefined) return state
      const cacheRead = usage.cacheReadTokens ?? 0
      return {
        ...state,
        // `inputTokens` is the whole prompt and the cached part is inside it.
        uncachedInputTokens: state.uncachedInputTokens
          + Math.max(0, (usage.inputTokens ?? 0) - cacheRead),
        cacheReadTokens: state.cacheReadTokens + cacheRead,
        cacheWriteTokens: state.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
        outputTokens: state.outputTokens + (usage.outputTokens ?? 0),
        hasUsage: true,
      }
    }
    case 'request/header': {
      const reason = (event.data as { reason?: string } | undefined)?.reason
      return reason === 'resume' ? { ...state, resumed: true } : state
    }
    case 'user/message': {
      // A model change is a durable user-role notice the model-selection
      // install appends. Detected from the event's own message content.
      const message = (event.data as { message?: { content?: readonly { type?: string; text?: string }[] } })
        .message
      const text = (message?.content ?? [])
        .map(block => (block.type === 'text' ? block.text ?? '' : '')).join('')
      return text.includes('[model changed:') ? { ...state, modelChanges: state.modelChanges + 1 } : state
    }
    default:
      return state
  }
}

/** Price a state's usage, or `null` when there is nothing to price. */
function priceState(
  state: FoldStatusState,
  profile: ContextEconomicsProfile | undefined,
): { readonly cost: number | null; readonly profileId: string | null } {
  if (profile === undefined || !state.hasUsage) return { cost: null, profileId: null }
  const breakdown = costOf(profile, {
    uncachedInputTokens: state.uncachedInputTokens,
    cacheReadTokens: state.cacheReadTokens,
    cacheWriteTokens: state.cacheWriteTokens,
    outputTokens: state.outputTokens,
  })
  return { cost: breakdown.totalCost, profileId: profile.id }
}

/** Options for {@link registerEpistemicFoldStatus}. */
export interface StatusProjectionOptions {
  /**
   * The mode in force, read AT VIEW TIME rather than captured at registration.
   *
   * A getter, not a value, because `/context mode` switches the tier of a
   * RUNNING session. Capturing the mode here would leave the panel reporting
   * the mode the session started in — a displayed value disagreeing with
   * reality, which is the class of defect this project keeps correcting.
   *
   * The panel therefore reflects a switch at the next committed event. A switch
   * produces no event of its own, so the projection is not republished the
   * instant it happens; the figure is stale for at most one event, and never
   * permanently wrong.
   */
  readonly mode: FoldModeName | (() => FoldModeName)
  /**
   * The profile to price with, or `undefined` to report cost as unknown.
   *
   * Resolved by the CALLER, because the profile depends on the routed model and
   * a pure fold cannot look one up. Absent means the panel shows `unknown`,
   * which is the honest answer for a route this deployment has no prices for.
   */
  readonly profile?: ContextEconomicsProfile
}

/**
 * Build the status projection unit.
 *
 * @param options - the mode and the pricing profile.
 * @returns the projection definition, ready to register.
 */
export function epistemicFoldStatusProjection(options: StatusProjectionOptions): {
  key: typeof EF_STATUS_KEY
  stateSchema: ZodType<FoldStatusState>
  stateVersion: number
  init: () => FoldStatusState
  apply: (state: FoldStatusState, event: SessionEvent) => FoldStatusState
  wire: { viewSchema: ZodType<FoldStatusView>; view: (state: FoldStatusState) => FoldStatusView }
} {
  const empty = (): FoldStatusState => ({
    mode: modeNow(),
    archivedTokens: 0,
    folds: 0,
    roots: 0,
    currentCheckpoints: 0,
    recalls: 0,
    searches: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    hasUsage: false,
    resumed: false,
    modelChanges: 0,
    failedCompactions: 0,
  })
  const modeNow = (): FoldModeName =>
    typeof options.mode === 'function' ? options.mode() : options.mode
  return {
    key: EF_STATUS_KEY,
    stateSchema: stateSchema as unknown as ZodType<FoldStatusState>,
    // Bumped when the state fields or their fold semantics change, so persisted
    // rows from an older unit are discarded rather than forward-applied.
    stateVersion: 1,
    init: empty,
    apply: reduceStatusEvent,
    wire: {
      viewSchema: viewSchema as unknown as ZodType<FoldStatusView>,
      view: state => {
        const { cost, profileId } = priceState(state, options.profile)
        // The LIVE mode, not the folded one: the mode lives in configuration
        // rather than in the event log, so the state cannot carry a switch.
        const mode = modeNow()
        return {
          mode,
          isTier: isTierModeName(mode),
          archivedTokens: state.archivedTokens,
          folds: state.folds,
          roots: state.roots,
          currentCheckpoints: state.currentCheckpoints,
          recalls: state.recalls,
          searches: state.searches,
          resumed: state.resumed,
          modelChanges: state.modelChanges,
          failedCompactions: state.failedCompactions,
          cost,
          costProfileId: profileId,
          usage: state.hasUsage
            ? {
              uncachedInputTokens: state.uncachedInputTokens,
              cacheReadTokens: state.cacheReadTokens,
              cacheWriteTokens: state.cacheWriteTokens,
              outputTokens: state.outputTokens,
            }
            : null,
        }
      },
    },
  }
}

/**
 * Register the status projection against the context's registry.
 *
 * @returns the exact disposer that unregisters the unit.
 */
export function registerEpistemicFoldStatus(
  ctx: Context,
  options: StatusProjectionOptions,
): () => void {
  const registry = ctx.get('sessionProjections')
  if (registry === undefined) return () => {}
  return registry.register(epistemicFoldStatusProjection(options) as never)
}
