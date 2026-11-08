/**
 * One native DSH host per experimental cell.
 *
 * ## Why this is not the R33 follow-up loop
 *
 * R33/R34 drove a custom text-JSON tool loop and said so. The E2E round must
 * measure the REAL host: `AgentLoop`, `AgentRegistry`, `ToolRuntime`, the real
 * session log and the real compaction service. The host below is the same
 * composition `eval/r37c/native-smoke.mjs` certifies (N0/N1/N2), with the
 * scripted adapter replaced by the live one.
 *
 * ## What differs per arm
 *
 *   B0  native DSH Basic (`@deepseek-ai/dsh-compaction-basic`), auto pressure
 *   Bv  EF `mode: basic`, which delegates to the vendored Basic engine
 *   E0  EF core, `semanticMode: none`, `semanticContinuity: off`
 *   E1  EF core, `semanticMode: rationale`, `semanticContinuity: off`
 *
 * The compaction backend is the ONLY difference that matters for the fold.
 * Tools, workspace, model, operational budget and task are shared, so a
 * difference in outcome is attributable to the fold policy.
 *
 * @module eval/e2e/src/host
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile } from '@deepseek-ai/cosmokit'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { apply as applyJsonlPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createToolState, registerTools } from './tools.mjs'

/** The provider id this harness registers. It is a label, not a route. */
export const PROVIDER = 'ef-e2e'

/** Fold-relevant arm identity, kept in one place so reports cannot drift. */
export const ARMS = Object.freeze({
  B0: { backend: 'dsh-basic', ef: false, semanticMode: 'n/a', semanticContinuity: 'off', mode: 'n/a' },
  Bv: { backend: 'ef', ef: true, semanticMode: 'none', semanticContinuity: 'off', mode: 'basic' },
  E0: { backend: 'ef', ef: true, semanticMode: 'none', semanticContinuity: 'off', mode: 'economy' },
  E1: { backend: 'ef', ef: true, semanticMode: 'rationale', semanticContinuity: 'off', mode: 'economy' },
  // S-safe: the same EF core, with semantic continuity ACTIVE after the
  // source-authority fix. The writer is a real model call; every failure is
  // counted in the assigned arm, never filtered to successful commits.
  S: { backend: 'ef', ef: true, semanticMode: 'rationale', semanticContinuity: 'active', mode: 'economy' },
})

/**
 * Mount the host.
 *
 * `persistenceRoot` is optional. A seeded cell does not need it (the seed is
 * passed to `agents.create`), but a multi-stage cell resumes, so it does.
 */
export async function mountHost({
  arm,
  adapter,
  model,
  workspace,
  roots,
  persistenceRoot = null,
  thresholdRatio = 0.5,
}) {
  const spec = ARMS[arm]
  if (spec === undefined) throw new Error(`unknown arm ${arm}`)

  const ctx = new Context()
  new LlmRuntime(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx)
  new AgentRegistry(ctx)
  if (persistenceRoot !== null) {
    await applyJsonlPersistence(ctx, { root: persistenceRoot, compression: 'none' })
  }
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: createVolatile(1) })

  let plugin = null
  if (spec.backend === 'dsh-basic') {
    const { default: BasicCompaction } = await import('@deepseek-ai/dsh-compaction-basic')
    // `headroomTokens` is the space the backend keeps free before its pressure
    // threshold. Its 65,536 default is sized for a 128k window and would leave
    // NO pressure budget in a 4,096-token operational window, so the fold could
    // never fire. 512 is the same value both arms get; it is not an EF-specific
    // advantage. `maxTokens` stays at the per-request cap so the summary call
    // itself is not truncated to the headroom.
    new BasicCompaction(ctx, { auto: true, thresholdRatio, retainRatio: 0.04, headroomTokens: 512, maxTokens: 1024 })
  } else {
    const { default: EpistemicFoldPlugin } = await import('../../../lib/plugin.js')
    await mkdir(roots.bundleRoot, { recursive: true })
    await mkdir(roots.semanticRoot, { recursive: true })
    plugin = new EpistemicFoldPlugin(ctx, {
      auto: true,
      thresholdRatio,
      retainRatio: 0.04,
      headroomTokens: 512,
      maxTokens: 1024,
      mode: spec.mode,
      semanticMode: spec.semanticMode,
      semanticContinuity: spec.semanticContinuity,
      bundleRoot: roots.bundleRoot,
      semanticRoot: roots.semanticRoot,
    })
  }

  ctx.llm.registerAdapter([PROVIDER], adapter)

  const errors = []
  ctx.on('agent/error', payload => {
    errors.push({
      turn: payload?.turn ?? null,
      step: payload?.step ?? null,
      name: payload?.error?.name ?? null,
      message: payload?.error?.message ?? String(payload?.error ?? ''),
      code: payload?.error?.code ?? null,
    })
  })

  return { ctx, plugin, errors, spec, provider: PROVIDER, model }
}

/**
 * Create an agent on a seeded session.
 *
 * `seed` is a complete, contiguous event log from seq 0. The factory validates
 * it before publishing, which is why a malformed fixture fails here instead of
 * producing a plausible-looking but wrong run.
 */
export async function createSeededAgent(host, { sessionId, seed, workspace, maxSteps }) {
  const toolState = createToolState({ maxSteps })
  const handle = await host.ctx.agents.create({
    sessionId,
    seed,
    meta: { cwd: workspace, isSeeded: true },
    inheritedEventCount: seed.length,
    agentOptions: { provider: host.provider, model: host.model },
    setup: agentCtx => {
      registerTools(agentCtx, { workspace, state: toolState })
    },
  })
  return { handle, toolState }
}

/** Resume a persisted session (multi-stage cells). */
export async function resumeAgent(host, { sessionId, workspace, maxSteps }) {
  const toolState = createToolState({ maxSteps })
  const handle = await host.ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: host.provider, model: host.model },
    setup: agentCtx => {
      registerTools(agentCtx, { workspace, state: toolState })
    },
  })
  return { handle, toolState }
}

/** Dispose a host without masking the first failure with a teardown one. */
export async function disposeHost(host) {
  try {
    await host.ctx.dispose?.()
  } catch {
    // A teardown failure must not rewrite the cell's measurement.
  }
}
