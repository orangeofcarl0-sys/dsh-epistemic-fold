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
 * Resolve the auxiliary-call target: the durably routed provider/model when
 * one exists, otherwise the agent's own routing options.
 */
export function conversationTarget(
  agent: Agent,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const routed = routedTarget(agent.session)
  if (routed !== undefined) return routed
  if (agent.options.provider === undefined || agent.options.provider.length === 0
    || agent.options.model === undefined || agent.options.model.length === 0) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
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
  /**
   * Structured-checkpoint semantic face (R0-A): `none` renders purely
   * deterministically (zero LLM calls); `rationale` makes ONE small
   * rationale-only auxiliary call. The default full-checkpoint prompt of
   * Basic is never used for the Rationale slot.
   */
  readonly semanticMode: 'none' | 'rationale'
  /** Resolved bundle directory. */
  readonly bundleRoot: string
  /**
   * Leaf admission policy (R2-B).
   *
   * `legacy` — admit every structurally legal, balanced, past-frontier span
   * (the R0/R1 behavior).
   * `economic` — additionally require that the fold actually reclaims enough
   * to be worth its checkpoint, and FORBID a leaf entirely once the frozen
   * prefix alone is over threshold (a leaf then cannot restore headroom; it
   * only appends another checkpoint to a prefix that already exceeds it).
   */
  readonly leafAdmission: LeafAdmissionMode
  /** Minimum net reclaim in tokens for an economic leaf fold. */
  readonly minReclaimTokens: number
  /** Minimum Marginal Reclaim Ratio (`reclaim / span`) for an economic fold. */
  readonly minReclaimRatio: number
}

/** Leaf admission policy mode (R2-B). */
export type LeafAdmissionMode = 'legacy' | 'economic'

const DEFAULT_THRESHOLD_RATIO = 0.8
const DEFAULT_RETAIN_RATIO = 0.16
const DEFAULT_HEADROOM_TOKENS = 65_536
const DEFAULT_FROZEN_BUDGET = 24_000
const DEFAULT_SEMANTIC_MODE = 'rationale'
const DEFAULT_BUNDLE_ROOT = '.epistemic-fold/bundles'
const DEFAULT_LEAF_ADMISSION: LeafAdmissionMode = 'legacy'
/**
 * Default reclaim floors. `minReclaimTokens` is set above the ~530-token
 * framing preamble a checkpoint costs, so a fold must reclaim more than the
 * overhead it creates. `minReclaimRatio` rejects folds whose span is nearly
 * the size of the checkpoint it produces (docs/11 §7's 11.8% example).
 */
const DEFAULT_MIN_RECLAIM_TOKENS = 600
const DEFAULT_MIN_RECLAIM_RATIO = 0.25

/** Public plugin configuration: Basic's compaction policy plus EF's budget. */
export interface EpistemicFoldConfig extends BasicCompactionConfig {
  /** Advisory budget for the frozen checkpoint prefix (plan §15). */
  frozenCheckpointTokenBudget?: number
  /** Structured-checkpoint semantic face; default `rationale`. */
  semanticMode?: 'none' | 'rationale'
  /**
   * Durable bundle directory (R0-B). Loader deployments set this to the
   * profile's persistence root; the default keeps the standalone/dev layout.
   */
  bundleRoot?: string
  /** Leaf admission policy (R2-B); default `legacy` until the R2 gates pass. */
  leafAdmission?: LeafAdmissionMode
  /** Minimum net reclaim in tokens for an economic leaf fold. */
  minReclaimTokens?: number
  /** Minimum Marginal Reclaim Ratio for an economic leaf fold. */
  minReclaimRatio?: number
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
  const semanticMode = config.semanticMode ?? DEFAULT_SEMANTIC_MODE
  if (semanticMode !== 'none' && semanticMode !== 'rationale') {
    throw new Error('epistemic-fold: semanticMode must be "none" or "rationale"')
  }
  const bundleRoot = config.bundleRoot ?? DEFAULT_BUNDLE_ROOT
  const leafAdmission = config.leafAdmission ?? DEFAULT_LEAF_ADMISSION
  if (leafAdmission !== 'legacy' && leafAdmission !== 'economic') {
    throw new Error('epistemic-fold: leafAdmission must be "legacy" or "economic"')
  }
  const minReclaimTokens = config.minReclaimTokens ?? DEFAULT_MIN_RECLAIM_TOKENS
  if (!Number.isFinite(minReclaimTokens) || minReclaimTokens < 0) {
    throw new Error('epistemic-fold: minReclaimTokens must be a non-negative number')
  }
  const minReclaimRatio = config.minReclaimRatio ?? DEFAULT_MIN_RECLAIM_RATIO
  if (!Number.isFinite(minReclaimRatio) || minReclaimRatio < 0 || minReclaimRatio > 1) {
    throw new Error('epistemic-fold: minReclaimRatio must be a number in [0, 1]')
  }
  return {
    thresholdRatio,
    headroomTokens,
    retainRatio,
    ...(retainTokens === undefined ? {} : { retainTokens }),
    compactionRetries,
    frozenCheckpointTokenBudget,
    semanticMode,
    bundleRoot,
    leafAdmission,
    minReclaimTokens,
    minReclaimRatio,
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
