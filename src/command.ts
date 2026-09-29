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
import { buildContextStatus, contextStatusToLine, contextStatusToText } from './status.ts'
import type { ContextStatus } from './status.ts'
import { resolveEfCompactSpec, resolveEfConfig, routedTarget } from './policy.ts'
import { BUILTIN_ECONOMICS_PROFILES, resolveProfile } from './economics-profile.ts'
import { TIERS, isTierModeName } from './preset.ts'
import type { FoldModeName } from './preset.ts'
import type { FoldBundleStore } from './types.ts'

/** The command name, without the leading slash. */
export const CONTEXT_COMMAND_NAME = 'context'

/** The sub-command that reports status; the default when none is given. */
export const CONTEXT_STATUS_SUBCOMMAND = 'status'

/** Everything the command handler needs, injected so it stays testable. */
export interface ContextCommandDeps {
  /** The store whose bundles describe archived history. */
  readonly store: FoldBundleStore
  /** The configuration this deployment resolved, for the mode and thresholds. */
  readonly config: () => { readonly mode: FoldModeName; readonly raw: Record<string, unknown> }
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

  // Cost: the routed model's profile, priced against what the provider reported.
  // Both halves must exist. Without a profile there are no prices, and without
  // reported usage there is no split to price.
  const profiles = (raw.economicsProfiles as never) ?? BUILTIN_ECONOMICS_PROFILES
  const profile = target === undefined
    ? undefined
    : resolveProfile(profiles, target.provider, target.model)
  const usage = readObservedUsage(session)

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
 * Sum the provider-reported usage across the session's own durable records.
 *
 * Read from the session log rather than from any in-memory counter, so the
 * figure survives a restart — and `undefined` when the log carries none,
 * because "no priced calls" and "zero tokens" differ.
 *
 * The miss/hit split is DERIVED: `TokenUsage.inputTokens` is the call's whole
 * prompt, and `cacheReadTokens` is the cached part of it, so the uncached part
 * is the difference. Clamped at zero, because a provider reporting a cache read
 * larger than its own input total is inconsistent and must not produce a
 * negative price.
 */
function readObservedUsage(session: Agent['session']): {
  readonly uncachedInputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
} | undefined {
  let inputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let outputTokens = 0
  let found = false
  for (let raw = 0; raw < session.seq; raw += 1) {
    const event = session.eventAt(raw as never)
    if (event?.type !== 'compaction/summary') continue
    const usage = (event.data as {
      usage?: {
        inputTokens?: number
        cacheReadTokens?: number
        cacheWriteTokens?: number
        outputTokens?: number
      }
    }).usage
    if (usage === undefined) continue
    found = true
    inputTokens += usage.inputTokens ?? 0
    cacheReadTokens += usage.cacheReadTokens ?? 0
    cacheWriteTokens += usage.cacheWriteTokens ?? 0
    outputTokens += usage.outputTokens ?? 0
  }
  if (!found) return undefined
  return {
    uncachedInputTokens: Math.max(0, inputTokens - cacheReadTokens),
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
  }
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
    description: 'Report Epistemic Fold status: mode, context, checkpoints, recalls, folds, cost',
    input: { hint: '[status|line]' },
    handler: async ({ agent, rawInput }) => {
      const { subcommand } = parseContextArgs(rawInput)
      switch (subcommand) {
        case CONTEXT_STATUS_SUBCOMMAND:
          return { kind: 'success', text: contextStatusToText(await gatherStatus(ctx, agent, deps)) }
        case 'line':
          // The one-line form, for a status bar or a script.
          return { kind: 'success', text: contextStatusToLine(await gatherStatus(ctx, agent, deps)) }
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
