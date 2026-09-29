/**
 * The `/context` command (RC2 §3): the human-facing diagnostic surface.
 *
 * This is the DSH COMMAND plane, not the tool plane. A command is typed by a
 * person and its result is rendered by the client OUTSIDE model history, so it
 * costs zero model tokens — which matters, because a diagnostic a user can run
 * at any time must not itself consume the context it is reporting on.
 *
 * ## Registration is conditional
 *
 * `ctx.commands` is provided by `@deepseek-ai/dsh-commands`, which a
 * compaction-only deployment need not mount. So the command registers through
 * `ctx.inject(['commands'], …)` and simply does not exist when no command
 * registry is composed — the same rule the recall tools follow for `ctx.tools`.
 * A deployment that never mounts a UI still works.
 *
 * ## What it reports
 *
 * Exactly the fields RC2 §3 names: mode, current context, archived history,
 * checkpoint count, recalls, folds/roots, and estimated/realized cost. The
 * MODEL is built by `src/status.ts`, which is pure and separately tested; this
 * module's only job is to gather the real inputs and never invent one.
 *
 * @module dsh-epistemic-fold/command
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { buildContextStatus, contextStatusToLine, contextStatusToText } from './status.ts'
import type { ContextStatus } from './status.ts'
import { resolveEfCompactSpec, resolveEfConfig, routedTarget } from './policy.ts'
import { BUILTIN_ECONOMICS_PROFILES, resolveProfile } from './economics-profile.ts'
import { TIERS, TIER_MODE_NAMES, isTierModeName, tierLadderToText } from './preset.ts'
import type { FoldModeName } from './preset.ts'
import type { FoldBundleStore } from './types.ts'

/** The command name, without the leading slash. */
export const CONTEXT_COMMAND_NAME = 'context'

/** The sub-command that reports status; the default when none is given. */
export const CONTEXT_STATUS_SUBCOMMAND = 'status'

/**
 * The sub-command that switches tiers (RC3).
 *
 * The control plane, and deliberately the ONLY control this command exposes.
 * RC3's directive is explicit that a user normally touches three modes and
 * nothing else: a dozen internal-parameter commands would turn a context
 * runtime into a configuration console, and the internal knobs stay in config
 * where they belong.
 */
export const CONTEXT_MODE_SUBCOMMAND = 'mode'

/**
 * Apply `/context mode <tier>` and describe the result.
 *
 * Every failure is REPORTED as an error result rather than thrown, because a
 * command's job is to tell the user what happened. Four cases, each with its
 * own message: no argument (show the ladder), an unknown tier (name the valid
 * ones), no engine to switch (say so), and a switch the engine refuses (relay
 * its reason).
 */
function applyModeChange(
  deps: ContextCommandDeps,
  rest: readonly string[],
): string {
  const requested = rest[0]
  if (requested === undefined) {
    // No argument shows the ladder, which doubles as the help screen.
    return tierLadderToText()
  }
  if (!isTierModeName(requested)) {
    return `unknown mode ${JSON.stringify(requested)}; choose one of `
      + `${TIER_MODE_NAMES.map(name => JSON.stringify(name)).join(', ')}`
  }
  if (deps.setMode === undefined) {
    return 'this deployment has no switchable engine mounted, so the mode cannot be changed at runtime'
  }
  try {
    const previous = deps.setMode(requested)
    const tier = TIERS[requested]
    return previous === requested
      ? `mode is already ${requested}`
      : `mode ${previous} -> ${requested}
  ${tier.summary}
  evidence: ${tier.evidence.toUpperCase()}`
  } catch (error: unknown) {
    // The engine refuses a switch that would change framing mid-session; its
    // message already explains why, so it is relayed rather than reworded.
    return `cannot switch mode: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** Everything the command handler needs, injected so it stays testable. */
export interface ContextCommandDeps {
  /** The store whose bundles describe archived history. */
  readonly store: FoldBundleStore
  /** The configuration this deployment resolved, for the mode and thresholds. */
  readonly config: () => { readonly mode: FoldModeName; readonly raw: Record<string, unknown> }
  /**
   * Switch the running engine's tier (RC3), returning the PREVIOUS mode.
   *
   * A callback rather than an engine reference: the command is a UI surface and
   * must not reach into engine internals, and a test can drive the control plane
   * without constructing an engine at all.
   *
   * Optional, because a compaction-only deployment may have no engine to switch
   * — `/context mode` then reports that rather than pretending to succeed.
   */
  readonly setMode?: (mode: FoldModeName) => FoldModeName
}

/** Parse the command's own grammar; the handler owns it, the registry does not. */
export function parseContextArgs(rawInput: string): {
  readonly subcommand: string
  readonly rest: readonly string[]
} {
  const tokens = rawInput.trim().split(/\s+/u).filter(token => token.length > 0)
  return { subcommand: tokens[0] ?? CONTEXT_STATUS_SUBCOMMAND, rest: tokens.slice(1) }
}

/**
 * Gather the live inputs for one agent's status.
 *
 * Every step degrades to ABSENT rather than to a default: a missing meter, a
 * missing profile, or an unresolvable window leaves the corresponding figure
 * `undefined`, and the model renders `unknown`. Filling in a zero here would be
 * the exact failure RC1.1 corrected — a plausible number standing in for a
 * measurement nobody took.
 */
export async function gatherStatus(
  ctx: Context,
  agent: Agent,
  deps: ContextCommandDeps,
): Promise<ContextStatus> {
  const session = agent.session
  const { mode, raw } = deps.config()

  // The meter's own reading of the live surface.
  let measurement: ReturnType<Context['tokenMeter']['measure']> | undefined
  const meter = ctx.get('tokenMeter')
  if (meter !== undefined) {
    try {
      measurement = meter.measure(session)
    } catch {
      // A session the meter cannot read yet (before its first request header)
      // has no measurement — reported as unknown, not as zero pressure.
      measurement = undefined
    }
  }

  // The routed model's window, and the threshold this config resolves to.
  let contextWindow: number | undefined
  let foldThreshold: number | undefined
  const target = routedTarget(session)
  if (target !== undefined) {
    try {
      const info = await ctx.llm.resolveModelInfo(target.provider, target.model)
      contextWindow = info.context?.contextWindow
    } catch {
      contextWindow = undefined
    }
  }
  if (contextWindow !== undefined) {
    try {
      const reserved = session.requestHeader()?.config?.maxTokens ?? 0
      foldThreshold = resolveEfCompactSpec(
        resolveEfConfig(raw as never), contextWindow, reserved,
      ).thresholdTokens
    } catch {
      foldThreshold = undefined
    }
  }

  // Archived history, from the bundles the store actually holds.
  let loaded: NonNullable<Awaited<ReturnType<FoldBundleStore['read']>>>[] | undefined
  try {
    const descriptors = await deps.store.list(session.id)
    const read = await Promise.all(
      descriptors.map(descriptor => deps.store.read(session.id, descriptor.checkpointId)),
    )
    loaded = read.filter((bundle): bundle is NonNullable<typeof bundle> => bundle !== null)
  } catch {
    loaded = undefined
  }

  // Cost: the routed model's profile, priced against the provider's own usage.
  // Both halves must exist. Without a profile there are no prices, and without
  // reported usage there is no split to price.
  const profiles = (raw.economicsProfiles as never) ?? BUILTIN_ECONOMICS_PROFILES
  const profile = target === undefined
    ? undefined
    : resolveProfile(profiles, target.provider, target.model)
  // DSH's OWN cumulative usage, read from the token meter's projection rather
  // than re-summed from the log. RC2 hand-rolled a scan over
  // `compaction/summary` events, which missed every ordinary assistant turn —
  // the projection is the harness's own answer and cannot drift from it.
  const usage = readTokenUsage(ctx, session)

  return buildContextStatus({
    mode,
    session,
    ...(measurement === undefined ? {} : { measurement }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(foldThreshold === undefined ? {} : { foldThreshold }),
    ...(loaded === undefined ? {} : { bundles: loaded }),
    ...(profile === undefined ? {} : { profile }),
    ...(usage === undefined ? {} : { usage }),
    ...(isTierModeName(mode) ? { tier: TIERS[mode] } : {}),
  })
}

/**
 * Read the session's cumulative provider usage from DSH's own projection.
 *
 * `tokenUsage` is registered by the token meter over the whole durable log, so
 * it is authoritative in a way a local scan is not: it accounts for retries
 * (via `llm/retry-started`) and for assistant settlements the hand-rolled
 * version never saw. The four buckets it exposes are exactly the ones the cost
 * model needs.
 *
 * @returns the usage, or `undefined` when the projection is not mounted or no
 *   provider has reported yet — in which case the cost is UNKNOWN, not zero.
 */
function readTokenUsage(
  ctx: Context,
  session: Agent['session'],
): TokenUsageProjection | undefined {
  const registry = ctx.get('sessionProjections')
  if (registry === undefined) return undefined
  const state = registry.stateOf(session, 'tokenUsage')
  if (state === undefined) return undefined
  return state.totals
}

/**
 * Build the command definition.
 *
 * Exported separately from the registration so a test can invoke the handler
 * directly against a real agent and a real context, without a command registry.
 */
export function contextCommandDefinition(
  ctx: Context,
  deps: ContextCommandDeps,
): CommandDefinition {
  return {
    // Branded identity; the brand is a compile-time marker over this literal.
    definitionId: 'dsh-epistemic-fold/context' as NonNullable<CommandDefinition['definitionId']>,
    name: CONTEXT_COMMAND_NAME,
    description: 'Epistemic Fold: report status, or switch the mode tier (economy|balanced|quality)',
    input: { hint: '[status|line|mode <economy|balanced|quality>]' },
    handler: async ({ agent, rawInput }) => {
      const { subcommand, rest } = parseContextArgs(rawInput)
      switch (subcommand) {
        case CONTEXT_STATUS_SUBCOMMAND:
          return { kind: 'success', text: contextStatusToText(await gatherStatus(ctx, agent, deps)) }
        case 'line':
          // The one-line form, for a status bar or a script.
          return { kind: 'success', text: contextStatusToLine(await gatherStatus(ctx, agent, deps)) }
        case CONTEXT_MODE_SUBCOMMAND:
          return { kind: 'success', text: applyModeChange(deps, rest) }
        default:
          return {
            kind: 'error',
            text: `unknown subcommand ${JSON.stringify(subcommand)}; try `
              + `/${CONTEXT_COMMAND_NAME} ${CONTEXT_STATUS_SUBCOMMAND}`,
          }
      }
    },
  }
}

/**
 * Register `/context` against the mounted command registry.
 *
 * @returns the exact disposer that unregisters the command, or `undefined` when
 *   no command registry is composed (in which case nothing was registered).
 */
export function registerContextCommand(
  ctx: Context,
  deps: ContextCommandDeps,
): (() => void) | undefined {
  if (ctx.get('commands') === undefined) return undefined
  return ctx.commands.register(contextCommandDefinition(ctx, deps))
}

/** Re-export for a caller that wants the text without a registry. */
export { contextStatusToLine, contextStatusToText }
