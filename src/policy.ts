/**
 * EF policy face: plugin configuration resolution and the routed-model
 * pressure math. Pure functions, no engine state — the engine orchestrates
 * transactions, this module decides the budgets (separation per RFC-001 §11:
 * policy chooses, validator vetoes).
 *
 * @module dsh-epistemic-fold/policy
 */

import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'

/** Resolve the exact provider/model durably routed for the latest request. */
export function routedTarget(session: Session): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/**
 * Output tokens the routed request reserves, charged to the same window as
 * the prompt (mirror of Basic's reservation rule).
 */
export function reservedCompletionTokens(agent: Agent, defaultMaxTokens: number | undefined): number {
  const configured = agent.session.requestHeader()?.config.maxTokens
  return configured ?? defaultMaxTokens ?? 0
}

/** Resolved EF policy (flat fields; exact-target overrides are a Basic feature EF does not narrow further). */
export interface ResolvedEpistemicFoldConfig {
  readonly thresholdRatio: number
  readonly headroomTokens: number
  readonly retainRatio: number
  readonly retainTokens?: number
  readonly compactionRetries: number
  /** Frozen-checkpoint budget; 0 disables the rebase advice (plan §15). */
  readonly frozenCheckpointTokenBudget: number
}

const DEFAULT_THRESHOLD_RATIO = 0.8
const DEFAULT_RETAIN_RATIO = 0.16
const DEFAULT_HEADROOM_TOKENS = 65_536
const DEFAULT_FROZEN_BUDGET = 24_000

/** Public plugin configuration: Basic's compaction policy plus EF's budget. */
export interface EpistemicFoldConfig extends BasicCompactionConfig {
  /** Advisory budget for the frozen checkpoint prefix (plan §15). */
  frozenCheckpointTokenBudget?: number
}

/** Resolve and validate the EF-specific policy face of the plugin config. */
export function resolveEfConfig(config: EpistemicFoldConfig = {}): ResolvedEpistemicFoldConfig {
  const headroomTokens = config.headroomTokens ?? DEFAULT_HEADROOM_TOKENS
  const thresholdRatio = config.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO
  const retainRatio = config.retainRatio ?? DEFAULT_RETAIN_RATIO
  const retainTokens = config.retainTokens
  if (!Number.isFinite(thresholdRatio) || thresholdRatio <= 0 || thresholdRatio > 1) {
    throw new Error('epistemic-fold: thresholdRatio must be a number in (0, 1]')
  }
  if (!Number.isInteger(headroomTokens) || headroomTokens < 0) {
    throw new Error('epistemic-fold: headroomTokens must be a non-negative integer')
  }
  if (retainTokens !== undefined
    && (!Number.isInteger(retainTokens) || retainTokens < 0)) {
    throw new Error('epistemic-fold: retainTokens must be a non-negative integer')
  }
  const compactionRetries = config.compactionRetries ?? 1
  if (!Number.isInteger(compactionRetries) || compactionRetries < 0) {
    throw new Error('epistemic-fold: compactionRetries must be a non-negative integer')
  }
  const frozenCheckpointTokenBudget = config.frozenCheckpointTokenBudget ?? DEFAULT_FROZEN_BUDGET
  if (!Number.isInteger(frozenCheckpointTokenBudget) || frozenCheckpointTokenBudget < 0) {
    throw new Error('epistemic-fold: frozenCheckpointTokenBudget must be a non-negative integer')
  }
  return {
    thresholdRatio,
    headroomTokens,
    retainRatio,
    ...(retainTokens === undefined ? {} : { retainTokens }),
    compactionRetries,
    frozenCheckpointTokenBudget,
  }
}

/** Concrete pressure and retention budgets for one routed model capacity. */
export interface EfCompactSpec {
  readonly contextWindow: number
  readonly thresholdTokens: number
  readonly retainTokens: number
  readonly compactionRetries: number
}

/**
 * Scale one EF policy into budgets (mirror of Basic's `resolveCompactSpec`
 * math: pressure capped by both the window fraction and the capacity left
 * after the completion reservation plus headroom; retention scales the
 * message budget before headroom is deducted).
 */
export function resolveEfCompactSpec(
  config: ResolvedEpistemicFoldConfig,
  contextWindow: number,
  reservedCompletionTokens: number,
): EfCompactSpec {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new Error(`epistemic-fold: contextWindow (${contextWindow}) must be a positive integer`)
  }
  const messageBudgetTokens = contextWindow - reservedCompletionTokens
  if (messageBudgetTokens <= 0) {
    throw new Error(
      `epistemic-fold: routed model reserves ${reservedCompletionTokens} completion tokens of its `
      + `${contextWindow}-token window, leaving no message budget`,
    )
  }
  const pressureBudgetTokens = messageBudgetTokens - config.headroomTokens
  if (pressureBudgetTokens <= 0) {
    throw new Error(
      `epistemic-fold: routed model reserves ${reservedCompletionTokens} completion tokens and `
      + `${config.headroomTokens} headroom tokens of its ${contextWindow}-token window, `
      + 'leaving no pressure budget',
    )
  }
  const thresholdTokens = Math.floor(Math.min(
    contextWindow * config.thresholdRatio,
    pressureBudgetTokens,
  ))
  const retainTokens = config.retainTokens
    ?? Math.floor(messageBudgetTokens * config.retainRatio)
  if (retainTokens >= thresholdTokens) {
    throw new Error(
      `epistemic-fold: retainTokens (${retainTokens}) must be less than threshold tokens ${thresholdTokens}`,
    )
  }
  return {
    contextWindow,
    thresholdTokens,
    retainTokens,
    compactionRetries: config.compactionRetries,
  }
}
