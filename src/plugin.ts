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
import { createAnchorService } from './anchor-service.ts'
import { EpistemicFoldEngine } from './engine.ts'
import { registerIdleRebaseConsumer } from './idle-rebase.ts'
import type { IdleRebaseAttempt, IdleRebaseRegistration } from './idle-rebase.ts'
import { FOLD_FRAMING_SECTION, framingModeFor } from './framing.ts'
import { registerEpistemicFoldProjection } from './projection.ts'
import { registerRecallTools } from './tools.ts'
import type { EpistemicFoldConfig } from './policy.ts'

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
    mode: z.union(['legacy', 'economy'] as const),
    auto: z.boolean(),
    modelPolicies: z.array(z.any()),
    frozenCheckpointTokenBudget: z.number(),
    semanticMode: z.union(['none', 'rationale'] as const),
    bundleRoot: z.string(),
  })

  /** The engine instance this plugin mounts (owns `ctx.compaction`). */
  readonly engine: EpistemicFoldEngine
  /** The anchor service this plugin provides as `ctx.epistemicFold`. */
  readonly anchors: AnchorService

  constructor(ctx: Context, config: EpistemicFoldConfig = {}) {
    // The engine owns ctx.compaction (one compaction backend per context).
    // Constructing it here places it on the plugin's own fiber, so unloading
    // the plugin disposes the engine with it.
    this.engine = new EpistemicFoldEngine(ctx, config)

    // Anchor service: the sanctioned `ef/anchor` producer, provided for the
    // plugin's fiber lifetime (cordis requires provide, not assignment).
    this.anchors = createAnchorService()
    ctx.provide('epistemicFold', this.anchors)

    // Deterministic state projection + recall tools: registered for the
    // plugin's lifetime, torn down when the plugin unloads. Recall tools
    // register only when a ToolRuntime is present (compaction-only
    // deployments mount cleanly without `ctx.tools`).
    ctx.effect(() => {
      const disposers: Array<() => void> = [registerEpistemicFoldProjection(ctx)]
      if (ctx.get('tools') !== undefined) {
        disposers.push(registerRecallTools(ctx, this.engine.bundleStore))
      }
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'epistemic-fold composition')

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
      const resolved = framingModeFor(this.engine.efConfig.framingMode, ctx.get('systemPrompt') !== undefined)
      if (resolved.fallback !== undefined) {
        ctx.logger.warn(`[epistemic-fold] ${resolved.fallback}`)
        return () => {}
      }
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
