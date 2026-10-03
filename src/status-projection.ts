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
 *   archivedItems              Σ `compaction/summary`.shadowedSeqs.length
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
import { costOf, selectProfile } from './economics-profile.ts'
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
  /**
   * Σ `shadowedSeqs.length` over every fold: how many items left the surface.
   *
   * Not messages only — a folded region carries user messages, assistant
   * messages and tool results, so the label must say ITEMS. Measured on a real
   * session: 211 items = 48 user + 82 assistant + 81 tool results.
   */
  readonly archivedItems: number
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
  /**
   * The routed provider/model, folded from `request/header`.
   *
   * RC18: the panel needs this to price the session with the RIGHT price list.
   * Before it, the caller passed a single profile (`profiles[0]`), so a session
   * on any other model was priced with the first shipped list — measured: a
   * Space Bunny Free session (a free route) reported `~0.0044`, which is
   * 15.9k tokens at DeepSeek Flash's miss rate, and named that list beside it.
   *
   * The event log is the only source available here, and it is the same one
   * `routedTarget` uses on the host side (`session.requestHeader()?.config`),
   * so the two renderers agree by construction rather than by convention.
   *
   * Empty strings mean "no header seen yet", which resolves to the no-cache
   * fallback — the honest answer for a route with no known prices.
   */
  readonly provider: string
  readonly model: string
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
  /** Items the folds took off the surface: messages and tool results together. */
  readonly archivedItems: number
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
  /**
   * The route the session actually ran on, as folded from `request/header`.
   *
   * RC18: carried so the panel can say WHICH route it could not price, rather
   * than leaving a bare `—` that reads as a panel failure. Empty before the
   * first request.
   */
  readonly pricedRoute: string
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
  archivedItems: z.number(),
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
  provider: z.string(),
  model: z.string(),
  resumed: z.boolean(),
  modelChanges: z.number(),
  failedCompactions: z.number(),
})

const viewSchema = z.looseObject({
  mode: z.string(),
  isTier: z.boolean(),
  archivedTokens: z.number(),
  archivedItems: z.number(),
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
  pricedRoute: z.string(),
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
      // RC20: how many ITEMS the fold took off the surface.
      //
      // This was believed unreachable — "the count only exists in the bundle
      // store, which a pure fold cannot read" — and that was wrong. The event
      // carries `shadowedSeqs`, the seq of every node in the folded region, and
      // DSH's own UI derives its count the same way
      // (`ui-chat/.../conversation-nodes/command.ts`: `data.shadowedSeqs.length`).
      //
      // Counted, not summed from a field, so a malformed array cannot inflate
      // it: every entry must be a non-negative safe integer, exactly the
      // validity rule DSH applies. A summary that fails the check contributes
      // nothing rather than a wrong number.
      const seqs = (event.data as { shadowedSeqs?: unknown }).shadowedSeqs
      const archivedItems = state.archivedItems
        + (Array.isArray(seqs)
          && seqs.every(seq => Number.isSafeInteger(seq) && (seq as number) >= 0)
          ? seqs.length
          : 0)
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
        archivedItems,
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
      const data = event.data as {
        reason?: string
        header?: { config?: { provider?: string; model?: string } }
      } | undefined
      // The routed route, kept current: a `change` header REPLACES it, which is
      // what makes the price list follow a mid-session model switch.
      const config = data?.header?.config
      const provider = typeof config?.provider === 'string' ? config.provider : state.provider
      const model = typeof config?.model === 'string' ? config.model : state.model
      return {
        ...state,
        provider,
        model,
        ...(data?.reason === 'resume' ? { resumed: true } : {}),
      }
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
   * The price lists this deployment knows, in preference order.
   *
   * RC18: the unit resolves the one that governs the session's OWN routed
   * model, read from the `request/header` events it already folds. Passing a
   * single profile here — which is what the plugin used to do with
   * `profiles[0]` — prices every session with one list regardless of which
   * model it actually ran on, and names that list in the panel. Measured: a
   * Space Bunny Free session reported `~0.0044` under
   * `Priced with deepseek-flash-2026-09`, which is 15.9k tokens at DeepSeek
   * Flash's miss rate for a route that is free.
   *
   * Empty or absent means cost is reported as UNKNOWN, which is the honest
   * answer for a deployment with no prices at all.
   */
  readonly profiles?: readonly ContextEconomicsProfile[]
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
    archivedItems: 0,
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
    provider: '',
    model: '',
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
    // 3: `archivedItems` joined the state, so a row persisted at 2 lacks it and
    // would forward-apply as `undefined` rather than as a count.
    stateVersion: 3,
    init: empty,
    apply: reduceStatusEvent,
    wire: {
      viewSchema: viewSchema as unknown as ZodType<FoldStatusView>,
      view: state => {
        // Price with the list that governs THIS session's route.
        //
        // `selectProfile`, NOT `resolveProfile`: the two differ exactly where
        // this panel needs them to. `resolveProfile` falls back to a synthetic
        // no-cache card when nothing matches, which is right for the ENGINE —
        // it needs a conservative upper bound so it never over-credits a saving
        // on an unknown route. It is wrong for an OBSERVATION panel: the
        // fallback's 1.0/M is a made-up rate, so a free route would be shown a
        // confident `~7.31`, which reads as "this session cost seven dollars".
        //
        // A route with no prices has an UNKNOWN cost, and this panel's rule is
        // to render `—` rather than a number it cannot establish. That is the
        // same distinction it already makes between an unestablished figure and
        // a measured zero.
        const profile = (options.profiles ?? []).length === 0
          ? undefined
          : selectProfile(options.profiles ?? [], state.provider, state.model)
        const { cost, profileId } = priceState(state, profile)
        // The LIVE mode, not the folded one: the mode lives in configuration
        // rather than in the event log, so the state cannot carry a switch.
        const mode = modeNow()
        return {
          mode,
          isTier: isTierModeName(mode),
          archivedTokens: state.archivedTokens,
          archivedItems: state.archivedItems,
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
          pricedRoute: state.provider.length === 0
            ? ''
            : (state.model.length === 0 ? state.provider : `${state.provider}/${state.model}`),
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
