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
import { BUILTIN_ECONOMICS_PROFILES } from './economics-profile.ts'
import type { ContextEconomicsProfile } from './economics-profile.ts'
import type { FramingMode } from './framing.ts'

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
  /** Provider-aware rebase policy (R2-C). */
  readonly rootPolicy: ResolvedEconomicsPolicy
  /**
   * Checkpoint framing strategy (R3-B/C).
   *
   * `legacy` — Basic's per-checkpoint preamble and wrapper tags, exactly as
   * inherited. Correct with no system-prompt dependency.
   * `system-dedup` — no per-checkpoint preamble; the semantics move to one
   * stable system-prompt section, which is where they belong if they are
   * constant. Requires `ctx.systemPrompt`, and RESOLVES to `legacy` when it is
   * absent rather than silently dropping the preamble.
   */
  readonly framingMode: FramingMode
}

/** Leaf admission policy mode (R2-B). */
export type LeafAdmissionMode = 'legacy' | 'economic'

/**
 * Root rebase decision mode (R2-C).
 *
 * `legacy` — recommend a rebase when the frozen prefix exceeds a fixed token
 * budget. A heuristic that cannot express the thing that matters: a rebase is
 * only worth its cost if the prefix it removes will be carried for enough
 * FURTHER requests to pay it back, and warm tokens are far cheaper on some
 * models than others.
 *
 * `economics` — decide with the amortized break-even horizon
 * (`H* = C_root / (ΔF · C_warm)`) under the routed model's own economics
 * profile. No provider branch: the decision reads the profile's numbers.
 */
export type RootPolicyMode = 'legacy' | 'economics'

/** Resolved economics policy face for provider-aware rebasing (R2-C). */
export interface ResolvedEconomicsPolicy {
  readonly mode: RootPolicyMode
  /** Candidate profiles, selected by routed provider/model. */
  readonly profiles: readonly ContextEconomicsProfile[]
  /** Measured cache realization `h`; defaults to 1 when unmeasured. */
  readonly realizationRate: number
  /** Rebase when the break-even horizon is at most this many requests. */
  readonly paybackHorizonRequests: number
  /** One-time cost charged to a rebase, in profile currency. */
  readonly compactionCost: number
}

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
const DEFAULT_ROOT_POLICY: RootPolicyMode = 'legacy'
const DEFAULT_REALIZATION_RATE = 1
/**
 * Payback horizon for `economics` mode. 200 requests is deliberately generous
 * in R2-C's first cut: it admits a rebase whose saving is small per request,
 * which is the correct default while the policy is opt-in and being measured.
 * A production default must be justified by the R2-E matrix, not assumed here.
 */
const DEFAULT_PAYBACK_HORIZON = 200
const DEFAULT_COMPACTION_COST = 0
/**
 * Default framing is `legacy` until the R3 economy gate is actually met.
 * Flipping it is a product decision the matrix must justify, not a default.
 */
const DEFAULT_FRAMING_MODE: FramingMode = 'legacy'

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
  /** Provider-aware rebase policy (R2-C); default `legacy`. */
  rootPolicy?: RootPolicyMode
  /** Candidate economics profiles for `economics` mode; defaults to the shipped set. */
  economicsProfiles?: readonly ContextEconomicsProfile[]
  /** Measured cache realization for `economics` mode; default 1 (fully realized). */
  cacheRealizationRate?: number
  /** Payback horizon for `economics` mode, in requests. */
  paybackHorizonRequests?: number
  /**
   * Checkpoint framing strategy (R3-B/C); default `legacy`. `system-dedup`
   * moves the checkpoint preamble into one stable system-prompt section,
   * requiring `ctx.systemPrompt` to be mounted.
   */
  framingMode?: FramingMode
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
  const rootPolicy = config.rootPolicy ?? DEFAULT_ROOT_POLICY
  if (rootPolicy !== 'legacy' && rootPolicy !== 'economics') {
    throw new Error('epistemic-fold: rootPolicy must be "legacy" or "economics"')
  }
  const realizationRate = config.cacheRealizationRate ?? DEFAULT_REALIZATION_RATE
  if (!Number.isFinite(realizationRate) || realizationRate < 0 || realizationRate > 1) {
    throw new Error('epistemic-fold: cacheRealizationRate must be a number in [0, 1]')
  }
  const paybackHorizonRequests = config.paybackHorizonRequests ?? DEFAULT_PAYBACK_HORIZON
  if (!Number.isFinite(paybackHorizonRequests) || paybackHorizonRequests < 0) {
    throw new Error('epistemic-fold: paybackHorizonRequests must be a non-negative number')
  }
  const framingMode = config.framingMode ?? DEFAULT_FRAMING_MODE
  if (framingMode !== 'legacy' && framingMode !== 'system-dedup') {
    throw new Error('epistemic-fold: framingMode must be "legacy" or "system-dedup"')
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
    framingMode,
    rootPolicy: {
      mode: rootPolicy,
      profiles: config.economicsProfiles ?? BUILTIN_ECONOMICS_PROFILES,
      realizationRate,
      paybackHorizonRequests,
      compactionCost: DEFAULT_COMPACTION_COST,
    },
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
