/**
 * The native DSH plugin entry (R0-B): ONE mount that composes the whole
 * runtime — the compaction engine (owns `ctx.compaction`), the deterministic
 * state projection, the recall tools, and the anchor service.
 *
 * Loader deployments reference this class by package name in the DSH profile
 * YAML, exactly like `@deepseek-ai/dsh-compaction-basic`:
 *
 * ```yaml
 * - name: dsh-epistemic-fold
 *   config:
 *     bundleRoot: <profile persistence root>/epistemic-fold
 *     semanticMode: rationale
 * ```
 *
 * Programmatic deployments can `ctx.plugin(EpistemicFoldPlugin, config)` with
 * the same effect.
 *
 * @module dsh-epistemic-fold/plugin
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: makes the optional sibling service available to `ctx.get()`.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { AnchorService } from './anchor-service.ts'
import { createAnchorService, hostAdmitsPluginEvents } from './anchor-service.ts'
import { EpistemicFoldEngine } from './engine.ts'
import { registerIdleRebaseConsumer } from './idle-rebase.ts'
import type { IdleRebaseAttempt, IdleRebaseRegistration } from './idle-rebase.ts'
import { FOLD_FRAMING_SECTION, framingModeFor } from './framing.ts'
import { describeEffectiveConfig, effectiveConfigToText } from './effective-config.ts'
import type { EffectiveConfig } from './effective-config.ts'
import { registerEpistemicFoldProjection } from './projection.ts'
import { registerEpistemicFoldStatus } from './status-projection.ts'
import { BUILTIN_ECONOMICS_PROFILES } from './economics-profile.ts'
import { registerRecallTools } from './tools.ts'
import { registerContextCommand } from './command.ts'
import type { LogReader } from './archive-refs.ts'
import type { EpistemicFoldConfig } from './policy.ts'

/**
 * The persistence service as a log reader, or `undefined` when the host has
 * none.
 *
 * `sessionPersistence` is an OPTIONAL sibling — a compaction-only deployment
 * mounts no persistence plane — and cordis THROWS on `ctx.get` for a service
 * that was not injected. So this probes rather than assumes, and the caller
 * only reaches for it when the cross-session experiment is enabled.
 */
function logReaderFrom(ctx: Context): LogReader | undefined {
  try {
    return ctx.get('sessionPersistence') as LogReader | undefined
  } catch {
    return undefined
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The sanctioned producer of `ef/anchor` events (authority-gated). */
    epistemicFold: AnchorService
  }
}

/**
 * Composite DSH plugin. `static inject` mirrors the engine's own needs —
 * the child engine plugin re-declares them when mounted through the loader.
 * Recall tools register ONLY when a ToolRuntime is present: a compaction-only
 * deployment (no `ctx.tools`) still mounts cleanly.
 */
export class EpistemicFoldPlugin {
  static inject = [...EpistemicFoldEngine.inject, 'sessionProjections']

  static Config: z<EpistemicFoldConfig> = z.object({
    thresholdRatio: z.number(),
    headroomTokens: z.number(),
    retainRatio: z.number(),
    retainTokens: z.number(),
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    maxTokens: z.number(),
    compactionRetries: z.number(),
    maxOverflowRetries: z.number(),
    framingMode: z.union(['legacy', 'system-dedup'] as const),
    mode: z.union(['legacy', 'basic', 'economy', 'balanced', 'quality'] as const),
    auto: z.boolean(),
    modelPolicies: z.array(z.any()),
    frozenCheckpointTokenBudget: z.number(),
    semanticMode: z.union(['none', 'rationale'] as const),
    bundleRoot: z.string(),
  })

  /** The engine instance this plugin mounts (owns `ctx.compaction`). */
  readonly engine: EpistemicFoldEngine
  /**
   * The anchor service this plugin provides as `ctx.epistemicFold`.
   *
   * ABSENT under `mode: basic`: that mode mounts no EF surface, and a provided
   * service is a surface. A consumer that needs it must handle its absence,
   * exactly as it must when EF is not installed at all.
   */
  readonly anchors: AnchorService | undefined
  /** What the configuration actually resolved to (RC0-A). */
  readonly effectiveConfig: EffectiveConfig

  constructor(ctx: Context, config: EpistemicFoldConfig = {}) {
    // RC0-A: report what this configuration actually resolves to BEFORE the
    // engine is constructed, so a deployment can see the effective settings and
    // any blocker in the log rather than only in an exception.
    this.effectiveConfig = describeEffectiveConfig(config)
    for (const line of effectiveConfigToText(this.effectiveConfig).split(String.fromCharCode(10))) {
      ctx.logger.info(`[epistemic-fold] ${line}`)
    }
    // The engine owns ctx.compaction (one compaction backend per context).
    // Constructing it here places it on the plugin's own fiber, so unloading
    // the plugin disposes the engine with it.
    this.engine = new EpistemicFoldEngine(ctx, config)

    // `mode: basic` mounts NO EF surface at all (RC7, the C2 requirement).
    //
    // The RC4-A blocker is the reason this is a construction-time decision: a
    // mounted EF whose engine is not folding still REPORTS — the Sidebar panel
    // and `/context` would show an EF with zero folds while Basic did the work,
    // which reads as "EF is idle" rather than "EF is not running". Suppressing
    // the engine's behaviour is not enough; the surface must not exist.
    //
    // So under `basic` the plugin returns here, having provided `ctx.compaction`
    // (the engine delegates to Basic) and nothing else: no anchor service, no
    // projection, no status, no recall tools, no command. A session under
    // `mode: basic` is indistinguishable from one where EF is not installed.
    if (this.engine.basicMode) {
      ctx.logger.info(
        '[epistemic-fold] mode "basic": EF is standing aside — compaction delegates to the '
        + 'vendored Basic backend, and no EF surface (projection, status, tools, command) is registered.',
      )
      return
    }

    // Anchor service: the sanctioned `ef/anchor` producer, provided for the
    // plugin's fiber lifetime (cordis requires provide, not assignment).
    //
    // The capability probe is wired here rather than defaulted in the service:
    // `ef/anchor` is outside DSH's known event vocabulary, and a host whose
    // `append` drops the `ignorable` marker would persist a log it then refuses
    // to reopen. Refusing the write is the only safe answer, and only the
    // mounted plugin knows which host it is on. The answer cannot change within
    // a process, so it is probed once rather than on every write.
    let admitsPluginEvents: boolean | undefined
    this.anchors = createAnchorService({
      durableWritesAllowed: () => (admitsPluginEvents ??= hostAdmitsPluginEvents()),
    })
    ctx.provide('epistemicFold', this.anchors)

    // Deterministic state projection + recall tools: registered for the
    // plugin's lifetime, torn down when the plugin unloads.
    //
    // The projection is unconditional. The recall tools need `ctx.tools`, which
    // is an OPTIONAL sibling — a compaction-only deployment mounts cleanly
    // without it — and cordis makes optionality a specific idiom:
    //
    //   ctx.get('tools')            THROWS when 'tools' is not in `inject`
    //   ctx.inject(['tools'], cb)   runs `cb` only once the service exists
    //
    // RC3 found this the hard way: the first real DSH boot failed with
    // `cannot get property "tools" without inject`. Every test harness had
    // pre-mounted a ToolRuntime, so the broken probe was never exercised — the
    // failure was only reachable in a real host, which is exactly the class of
    // bug the harness could not see.
    ctx.effect(() => {
      const disposers: Array<() => void> = [registerEpistemicFoldProjection(ctx)]
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'epistemic-fold projection')

    // The client-facing status projection (RC4): the Sidebar's data source.
    // Registered on the SAME registry as the state projection, but WITH a wire
    // view so a client can read it. Nothing here enters a prompt, so it cannot
    // affect the context it reports on.
    ctx.effect(() => {
      const profiles = config.economicsProfiles ?? BUILTIN_ECONOMICS_PROFILES
      const dispose = registerEpistemicFoldStatus(ctx, {
        // A GETTER: `/context mode` switches the tier of a running session, and
        // capturing the mode here would leave the panel reporting the startup
        // mode forever.
        mode: () => this.engine.currentMode,
        // RC18: hand over the WHOLE list, not one entry. The unit resolves the
        // profile that governs the session's own routed model, which it reads
        // from the `request/header` events it already folds. Passing
        // `profiles[0]` — as this did — priced every session with the first
        // shipped list and named it in the panel, so a free route reported a
        // DeepSeek Flash cost. A deployment whose route is priced differently
        // sets `economicsProfiles`; the figure is labelled as an estimate
        // either way, and names the list it actually used. With no list at all
        // the panel reports cost as UNKNOWN rather than guessing.
        ...(profiles.length === 0 ? {} : { profiles }),
      })
      return () => dispose()
    }, 'epistemic-fold status projection')

    ctx.inject(['tools'], toolsCtx => {
      // The cross-session resolver is wired ONLY when the experiment is on, so a
      // default deployment never even reaches for the persistence service. The
      // flag is read once here rather than per call: it is a mount-time policy,
      // and a tool that changed behavior mid-session would be a different tool.
      const crossSession = this.engine.efConfig.allowCrossSessionRecall
      const reader = crossSession ? logReaderFrom(toolsCtx) : undefined
      const dispose = registerRecallTools(toolsCtx, this.engine.bundleStore, {
        ...(reader === undefined ? {} : { logReader: reader }),
      })
      return () => dispose()
    })

    // The `/context` diagnostic command (RC2 §3). Registered through
    // `ctx.inject` for the same reason: a compaction-only deployment has no
    // command registry, and the command simply does not exist there rather than
    // failing the mount.
    ctx.inject(['commands'], commandCtx => {
      const dispose = registerContextCommand(commandCtx, {
        store: this.engine.bundleStore,
        // The RAW config, not the resolved one: `mode` is a naming face the
        // resolver expands and then drops, so the resolved object cannot report
        // which tier a deployment actually asked for.
        // The mode is read from the ENGINE, not the constructor argument: a
        // runtime `/context mode` switch changes what is in force, and a status
        // report that kept echoing the startup value would be lying after the
        // first switch.
        config: () => ({ mode: this.engine.currentMode, raw: config as Record<string, unknown> }),
        setMode: mode => this.engine.setMode(mode, config),
      })
      return () => dispose?.()
    })

    // The idle rebase consumer (R3-0b): the production half of R2-C's handoff.
    // Registered unconditionally — whether a rebase is ever justified is the
    // policy's decision, not the wiring's — and torn down with the plugin so
    // unloading cannot leave maintenance firing on a disposed engine.
    ctx.effect(() => {
      const registration = registerIdleRebaseConsumer({
        ctx,
        engine: this.engine,
        intents: this.engine.rebaseIntentRegistry,
        onAttempt: attempt => {
          this.lastIdleRebaseAttempt = attempt
          if (attempt.outcome === 'rebased') {
            ctx.logger.info(`[epistemic-fold] idle rebase ran: ${attempt.reason ?? ''}`)
          }
        },
      })
      this.idleRebase = registration
      return () => {
        registration.dispose()
        this.idleRebase = undefined
      }
    }, 'epistemic-fold idle rebase consumer')

    // Checkpoint framing semantics (R3-C). Under `legacy` the per-checkpoint
    // preamble carries them and nothing is registered. Under `system-dedup`
    // the preamble is gone, so this section is what tells the model what a
    // checkpoint is — O(1) per request instead of O(checkpoints), and
    // cache-stable because it never changes.
    ctx.effect(() => {
      // RC0-A: resolve against the mounted context. A `system-dedup` request
      // without a system prompt throws here (inside the effect, so the mount
      // fails loudly) instead of degrading to per-checkpoint framing.
      const resolved = framingModeFor(this.engine.efConfig.framingMode, ctx.get('systemPrompt') !== undefined)
      if (resolved.mode !== 'system-dedup') return () => {}
      const systemPrompt = ctx.get('systemPrompt')
      if (systemPrompt === undefined) return () => {}
      const dispose = systemPrompt.section({
        name: 'epistemic-fold:checkpoints',
        // Ahead of the deployment persona: it is a statement about how to read
        // the conversation, not about who the model is.
        order: systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') - 1,
        text: FOLD_FRAMING_SECTION,
      })
      return () => {
        dispose()
      }
    }, 'epistemic-fold framing section')
  }

  /** Most recent idle rebase attempt; `undefined` before any idle event. */
  lastIdleRebaseAttempt: IdleRebaseAttempt | undefined

  /**
   * The registered idle consumer, once mounted. Exposed so a benchmark can
   * await the maintenance it triggered through the REAL path rather than
   * reimplementing the policy (R3-0c: `BenchPath == ProductionPath`).
   */
  idleRebase: IdleRebaseRegistration | undefined
}
export default EpistemicFoldPlugin
