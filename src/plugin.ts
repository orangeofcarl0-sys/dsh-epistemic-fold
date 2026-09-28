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
import type { AnchorService } from './anchor-service.ts'
import { createAnchorService } from './anchor-service.ts'
import { EpistemicFoldEngine } from './engine.ts'
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
  }
}
export default EpistemicFoldPlugin
