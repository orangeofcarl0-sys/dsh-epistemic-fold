/**
 * The DSH runtime mount sequence, in one place (docs/68 B-6).
 *
 * Four harnesses hand-wired the same service sequence — LlmRuntime, SessionStore,
 * SessionProjectionRegistry, TokenMeter, then the optional SystemPrompt and
 * ToolRuntime — and they had already diverged. `tests/harness.ts` mounted the
 * tool-result pruner with `{}` while `eval/tau2/bridge-host.ts` mounted
 * production's explicit budgets, and `eval/paired-runner.ts` mounted no pruner
 * at all.
 *
 * The divergence is not cosmetic. EF's pressure path READS
 * `ctx.get('toolResultPruner')` before deciding on a fold, and a single tool
 * result larger than the fold threshold is UN-FOLDABLE by construction (the
 * retention walk accumulates from the tail and breaks at `retainTokens = 0`, so
 * the last node is retained whatever the setting). `eval/tau2/bridge-host.ts`
 * records the measurement that proved it: 66116 -> 60136 chars, leaves=1, THREW,
 * without the pruner; 66116 -> 7406, leaves=0, converged, with it.
 *
 * This module adds no policy of its own: every mount below is exactly what the
 * call sites did. The services are independent registrations, so the relative
 * order of the optional ones is not observable.
 *
 * @module eval/src/runtime-mount
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

/** The tool-result-pruner character budgets. */
export interface ToolResultPruneConfig {
  readonly thresholdChars: number
  readonly headChars: number
  readonly tailChars: number
}

/**
 * Production's tool-result-pruner configuration — the budgets `dsh-base`
 * mounts, and the reason the shared path must name them rather than pass `{}`.
 *
 * These three values are also the pruner package's own `DEFAULTS`, so `{}`
 * resolves to the same budgets; spelling them out is therefore a documentation
 * change, not a behavioural one. The realised defect was mounting NOTHING (see
 * `eval/tau2/bridge-host.ts`), and this constant is what keeps every harness
 * that does mount it on production's numbers.
 */
export const PRODUCTION_PRUNER_CONFIG: ToolResultPruneConfig = Object.freeze({
  thresholdChars: 8_192,
  headChars: 4_096,
  tailChars: 1_024,
})

export interface MountRuntimeOptions {
  /** Mount `ctx.systemPrompt` (the R3-C framing seam needs somewhere to live). */
  systemPrompt?: boolean
  /** Mount `ctx.tools`, so the EF recall tools actually REGISTER and can execute. */
  tools?: boolean
}

/**
 * Mount the DSH runtime sequence into `ctx`. The caller owns `new Context()`.
 *
 * @param ctx - the context to mount into.
 * @param options - the optional services to include.
 */
export function mountRuntime(ctx: Context, options: MountRuntimeOptions = {}): void {
  void new LlmRuntime(ctx)
  void new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  if (options.systemPrompt === true) new SystemPrompt(ctx, {})
  if (options.tools === true) new ToolRuntime(ctx)
}

/**
 * Mount the production tool-result pruner with production's budgets.
 *
 * LAZY on purpose: the package is not a declared dependency, and a static import
 * of a missing package is not a degradation but a harness that cannot start —
 * `eval/tau2/bridge-host.ts` records the `ERR_MODULE_NOT_FOUND` that killed
 * every LHTB run in about twenty seconds, invisibly, because no test imports the
 * bridge's module graph. The dynamic import lives here so every caller gets the
 * same laziness; a caller that must RECORD the absence instead of dying wraps
 * this call in its own try/catch and keeps its own telemetry.
 *
 * @param ctx - the context to mount into.
 * @param config - character budgets; defaults to `PRODUCTION_PRUNER_CONFIG`.
 */
export async function mountToolResultPruner(
  ctx: Context,
  config: ToolResultPruneConfig = PRODUCTION_PRUNER_CONFIG,
): Promise<void> {
  const { ToolResultPruner } = await import('@deepseek-ai/dsh-compaction-tool-result-pruner')
  new ToolResultPruner(ctx, config)
}
