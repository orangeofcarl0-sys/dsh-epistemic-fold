/**
 * The Epistemic Fold compaction engine: Basic's transaction with EF's
 * archive-before-loss compile hook, EF's frontier-scoped leaf policy, and
 * Basic-compatible pressure accounting (the math lives in `policy.ts`).
 *
 * Transaction shape (RFC-001 §6, plan §7.1 correction):
 *   candidate prepared → Basic opens its transaction → summarize() archives
 *   the shadowed span, runs the semantic call, publishes the FINAL immutable
 *   bundle atomically, then returns the checkpoint text. Basic commits the
 *   surface replacement only after summarize() returns, so a durable bundle
 *   always precedes surface loss (BundleDurable ≺ SurfaceLoss).
 *
 * Manual idle-session compaction (`compactNow`) is intentionally NOT
 * overridden: the inherited manual path never routes through `compactRegion`,
 * so the summarize hook observes no pending candidate and treats the fold as
 * a ROOT fold (D-004).
 *
 * @module dsh-epistemic-fold/engine
 */

import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { createFoldCandidate, FoldCandidateRegistry } from './candidate.ts'
import {
  buildBundle,
  renderFallbackCheckpoint,
  renderSemanticCheckpoint,
  splitSummarizationInput,
} from './compiler.ts'
import { FileBundleStore } from './bundle-store.ts'
import { hasActiveCompaction, locateFoldFrontier } from './frontier.ts'
import { selectLeafSpan } from './leaf-policy.ts'
import { leafMarginalReclaim, pressureBreakdown } from './pressure.ts'
import type { LeafMarginalReclaim } from './pressure.ts'
import { resolveProfile } from './economics-profile.ts'
import { compileContextPolicy } from './policy-compiler.ts'
import type { ContextPolicyDecision } from './policy-compiler.ts'
import { createRebaseIntentRegistry } from './rebase-intent.ts'
import type { PendingRebaseIntent, RebaseCause, RebaseIntentRegistry } from './rebase-intent.ts'
import { evaluateRootRebase } from './root-policy.ts'
import { currentFoldState, EF_CURRENT_STATE_KEY } from './projection.ts'
import { renderStructuredCheckpoint } from './renderer.ts'
import { rationaleOnly } from './rationale.ts'
import {
  conversationTarget,
  resolveEfConfig,
  reservedCompletionTokens,
  resolveEfCompactSpec,
  routedTarget,
  type EfCompactSpec,
  type EpistemicFoldConfig,
  type ResolvedEpistemicFoldConfig,
} from './policy.ts'
import type { FoldCurrentState } from './state.ts'
import type {
  CheckpointBundleV1,
  FoldBundleStore,
  FoldCommitRecordV1,
  SummarizationInput,
  SummaryResult,
} from './types.ts'

/**
 * Every config key EF owns and resolves itself. Basic validates its config
 * keys STRICTLY, so any EF key reaching the super constructor throws — this
 * list is the single place that decides what "EF-owned" means, and
 * `stripEfConfigKeys` is checked against it by a test so a newly added key
 * cannot silently leak through (a real bug found in R0).
 */
const EF_OWNED_CONFIG_KEYS = [
  'frozenCheckpointTokenBudget',
  'semanticMode',
  'bundleRoot',
  'leafAdmission',
  'minReclaimTokens',
  'minReclaimRatio',
  'rootPolicy',
  'economicsProfiles',
  'cacheRealizationRate',
  'paybackHorizonRequests',
] as const

/** Drop the EF-owned config keys so Basic's strict key validation passes. */
function stripEfConfigKeys(config: EpistemicFoldConfig): EpistemicFoldConfig {
  const basic: Record<string, unknown> = { ...config }
  for (const key of EF_OWNED_CONFIG_KEYS) delete basic[key]
  return basic as EpistemicFoldConfig
}

/** The EF-owned keys, exposed so a test can prove none is forgotten. */
export function efOwnedConfigKeys(): readonly string[] {
  return EF_OWNED_CONFIG_KEYS
}

/** Cap for the rationale-only auxiliary call (R0-A: ~100-400 tokens). */
const RATIONALE_MAX_TOKENS = 400

/**
 * Fallback estimate of a first checkpoint's size when none exists yet. A leaf
 * checkpoint's cost is dominated by the fixed framing preamble, so this is a
 * measured constant (~530 tokens observed) rather than a guess.
 */
const FRAMING_FALLBACK_TOKENS = 530

/** Why an economic leaf fold was admitted or refused (R2-B telemetry). */
export interface LeafAdmissionVerdict {
  readonly admitted: boolean
  readonly reason:
    | 'admitted'
    | 'frozen_prefix_over_threshold'
    | 'reclaim_below_floor'
    | 'ratio_below_floor'
    | 'no_span'
  readonly detail: string
  readonly reclaim?: LeafMarginalReclaim
}

/** Pressure folds required between two root rebases (R0-C anti-oscillation). */
const ROOT_REBASE_COOLDOWN = 5

export interface EpistemicFoldOptions {
  /** Durable bundle destination; defaults to `.epistemic-fold/bundles`. */
  readonly bundleStore?: FoldBundleStore
}

/**
 * Compaction backend implementing the Epistemic Fold runtime. `summarize()`
 * is EF's compile hook: the sole place where the archive is built and the
 * bundle is published, always before Basic can commit any lossy replacement.
 * Automatic pressure compaction folds ONLY the open trajectory past the fold
 * frontier — frozen checkpoints are never re-folded (plan §13).
 */
export class EpistemicFoldEngine extends BasicCompactionEngine {
  static override inject = BasicCompactionEngine.inject

  /** EF-resolved policy face; Basic keeps its own resolved config for summarization. */
  readonly efConfig: ResolvedEpistemicFoldConfig

  private readonly candidates = new FoldCandidateRegistry()
  private readonly bundles: FoldBundleStore
  /**
   * Outstanding rebase requests, keyed per agent (R3-0b). R2-C only
   * RECOMMENDED a rebase; this is the state the production consumer reads at
   * idle. It is owned by the engine because the engine is what detects the
   * condition, and it is per-agent because a rebase is an agent-level action.
   */
  private readonly rebaseIntents: RebaseIntentRegistry = createRebaseIntentRegistry()
  /** Last bundle this engine published (per transaction, for tests/telemetry). */
  private lastPublishedBundle: CheckpointBundleV1 | undefined
  private lastRootRebaseAdviceValue: ReturnType<typeof evaluateRootRebase> | undefined
  /** Pressure folds since the last root rebase — the anti-oscillation cooldown. */
  private stepsSinceRootRebase = Number.POSITIVE_INFINITY
  /** Pressure threshold resolved by the most recent `compactIfNeeded` (R2-A telemetry). */
  private lastThresholdTokensValue = 0
  /** Most recent economic leaf-admission verdict (R2-B telemetry). */
  private lastLeafAdmissionValue: LeafAdmissionVerdict | undefined
  /** Most recent provider-aware rebase decision (R2-C telemetry). */
  private lastRebaseDecisionValue: ContextPolicyDecision | undefined
  /** Root folds committed by this engine, for maintenance-path verification. */
  private rootFoldCountValue = 0

  constructor(
    ctx: ConstructorParameters<typeof BasicCompactionEngine>[0],
    config: EpistemicFoldConfig = {},
    options: EpistemicFoldOptions = {},
  ) {
    // Basic validates its config keys strictly; EF-owned fields must be
    // stripped before the super call (they are resolved by resolveEfConfig).
    super(ctx, stripEfConfigKeys(config))
    this.efConfig = resolveEfConfig(config)
    // Loader deployments pass exactly (ctx, config): the store then comes
    // from `bundleRoot` in the config face, honoring the DSH persistence
    // lifecycle (R0-B). Programmatic callers may inject a store directly.
    this.bundles = options.bundleStore ?? new FileBundleStore(this.efConfig.bundleRoot)
  }

  /** The bundle store this engine publishes checkpoints into. */
  get bundleStore(): FoldBundleStore {
    return this.bundles
  }

  /** Most recent bundle this engine published; `undefined` before the first fold. */
  get publishedBundle(): CheckpointBundleV1 | undefined {
    return this.lastPublishedBundle
  }

  /** Latest frozen-budget evaluation (pressure path); `undefined` before the first check. */
  get lastRootRebaseAdvice(): ReturnType<typeof evaluateRootRebase> | undefined {
    return this.lastRootRebaseAdviceValue
  }

  /**
   * The pressure threshold the most recent `compactIfNeeded` resolved, or 0
   * before any pressure check. Exposed so R2-A can decompose pressure against
   * the SAME threshold the engine acted on, rather than re-deriving it.
   */
  get lastThresholdTokens(): number {
    return this.lastThresholdTokensValue
  }

  /** Most recent economic leaf-admission verdict; `undefined` under `legacy`. */
  get lastLeafAdmission(): LeafAdmissionVerdict | undefined {
    return this.lastLeafAdmissionValue
  }

  /** Most recent provider-aware rebase decision (R2-C); `undefined` under `legacy`. */
  get lastRebaseDecision(): ContextPolicyDecision | undefined {
    return this.lastRebaseDecisionValue
  }

  /**
   * Root folds this engine has committed. Exposed so a benchmark can verify a
   * maintenance event actually landed a rebase rather than inferring it from a
   * token delta (R3-0c).
   */
  get rootFoldCount(): number {
    return this.rootFoldCountValue
  }

  /** The pending-rebase registry the idle consumer drives (R3-0b). */
  get rebaseIntentRegistry(): RebaseIntentRegistry {
    return this.rebaseIntents
  }

  /**
   * Record a pending rebase intent for one session (R3-0b).
   *
   * Deliberately stores identity and cause only: the measurement that
   * justified the request describes a surface that will be gone by the time
   * the agent is idle, and a stale measurement replayed as authority is worse
   * than no intent at all.
   *
   * Keyed by SESSION: the pressure turn and the later idle event are not
   * guaranteed to hold the same agent wrapper, and the session is the identity
   * both ends actually share.
   */
  private recordRebaseIntent(session: Session, cause: RebaseCause): void {
    const intent: PendingRebaseIntent = {
      sessionId: session.id,
      preparedGeneration: session.surface.replaceGeneration,
      cause,
      createdAtSeq: SessionSeq(session.seq),
    }
    this.rebaseIntents.set(session, intent)
  }

  /**
   * Re-decide a rebase against the CURRENT surface, from scratch (R3-0b).
   *
   * This is the "recommendation is not authority" rule made executable: the
   * idle consumer calls this instead of trusting whatever the pressure turn
   * concluded. Everything is re-measured — the frozen prefix, the tail, the
   * routed target — and the policy compiler runs again on those numbers.
   *
   * @returns the fresh decision, or `null` when no routed target exists (an
   *   unroutable session has no economics to reason about).
   */
  async rebaseDecisionAtIdle(agent: Agent): Promise<ContextPolicyDecision | null> {
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, undefined)
    if (info.context === undefined) return null
    const spec = resolveEfCompactSpec(
      this.efConfig,
      info.context.contextWindow,
      reservedCompletionTokens(agent, info.defaultMaxTokens),
    )
    const measurement = this.ctx.tokenMeter.measure(agent.session)
    const decision = this.evaluateEconomicRebase(agent, measurement, spec, true)
    this.lastRebaseDecisionValue = decision
    return decision
  }

  /**
   * Fold one explicitly selected surface span as a LEAF fold: the candidate
   * is prepared first so the summarize hook knows the fold identity, and
   * cleared in a `finally` so cancellation or failure never leaks the slot.
   */
  override async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    // Leaf-fold hard invariant (R0-A): a leaf fold may only compact the open
    // trajectory PAST the frontier, and the surface must carry a contiguous
    // frozen prefix. Violations are refused before any candidate exists.
    const frontier = locateFoldFrontier(agent.session)
    if (!frontier.frozenPrefixContiguous) {
      throw new Error('epistemic-fold: FRONTIER_INCONSISTENT — frozen checkpoints do not form a contiguous prefix')
    }
    if (agent.session.surface.nodes.indexOf(start) < frontier.firstOpenPosition) {
      throw new Error('epistemic-fold: leaf_before_frontier — a leaf fold may not compact frozen history')
    }
    const candidate = createFoldCandidate({
      mode: 'leaf',
      session: agent.session,
      start,
      end,
    })
    this.candidates.prepare(agent.session, candidate)
    try {
      const result = await super.compactRegion(start, end, agent, signal)
      // The durable result must fold EXACTLY the span the candidate intended.
      if (result.shadowedSeqs[0] !== start
        || result.shadowedSeqs[result.shadowedSeqs.length - 1] !== end) {
        throw new Error(
          `epistemic-fold: committed shadowed span deviates from the candidate span `
          + `(${JSON.stringify(result.shadowedSeqs)} vs [${String(start)}, ${String(end)}])`,
        )
      }
      await this.recordCommit(candidate, result)
      return result
    } finally {
      this.candidates.clear(agent.session)
    }
  }

  /** Persist the post-commit provenance record for one completed fold. */
  private async recordCommit(candidate: ReturnType<FoldCandidateRegistry['get']>, result: CompactionResult): Promise<void> {
    if (candidate === undefined) return
    const record: FoldCommitRecordV1 = {
      checkpointId: candidate.checkpointId,
      sessionId: candidate.sessionId,
      mode: candidate.mode,
      compactionId: result.compactionId,
      shadowedSeqs: [...result.shadowedSeqs],
      startSeq: result.startSeq,
      summarySeq: result.summarySeq,
      endSeq: result.endSeq,
      committedAt: Date.now(),
    }
    await this.bundles.recordCommit(record)
  }

  /**
   * Manual idle-session compaction is a ROOT fold by definition (D-004). The
   * candidate is prepared EXPLICITLY before the inherited transaction runs —
   * the summarize hook no longer infers the mode from candidate absence —
   * and the durable result is recorded post-commit.
   */
  override async compactNow(
    ...args: Parameters<BasicCompactionEngine['compactNow']>
  ): Promise<CompactionResult | null> {
    const [agent] = args
    const candidate = createFoldCandidate({ mode: 'root', session: agent.session })
    this.candidates.prepare(agent.session, candidate)
    try {
      const result = await super.compactNow(...args)
      if (result !== null) {
        await this.recordCommit(candidate, result)
        this.stepsSinceRootRebase = 0
        this.rootFoldCountValue += 1
        // A landed root clears any outstanding intent: the rebase the intent
        // asked for has happened, so a later idle event must not repeat it.
        this.rebaseIntents.clear(agent.session)
        // Invalidate the stale advice: without this, the rebase consumer
        // re-reads the pre-root recommendation every step and the arm
        // degenerates into leaf/root thrashing (R0-C anti-oscillation).
        this.lastRootRebaseAdviceValue = undefined
      }
      return result
    } finally {
      this.candidates.clear(agent.session)
    }
  }

  /**
   * Automatic pressure and overflow policy with EF's own span selection:
   * pressure/overflow thresholds mirror Basic, but the folded span always
   * starts at the fold frontier, so frozen checkpoints stay byte-stable.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - cancellation forwarded to summarization.
   * @returns the latest summary compaction result, or `null` when none ran.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    const meter = this.ctx.tokenMeter
    let measurement: TokenMeasurement = meter.measure(agent.session)
    const prune = this.ctx.get('toolResultPruner')

    if (trigger === 'context-overflow') {
      if (prune !== undefined) {
        prune.pruneSession(agent.session)
        measurement = meter.measure(agent.session)
      }
      return this.compactLeafFromFrontier(agent, measurement, 0, signal)
    }

    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    if (hasActiveCompaction(agent.session)) {
      throw new Error('epistemic-fold: compaction already in progress; the session compaction lock is already active')
    }
    if (info.context === undefined) {
      throw new Error(
        `epistemic-fold: no context capacity for ${target.provider}/${target.model}; `
        + 'configure contextWindow on that adapter model',
      )
    }
    const spec = resolveEfCompactSpec(
      this.efConfig,
      info.context.contextWindow,
      reservedCompletionTokens(agent, info.defaultMaxTokens),
    )
    this.lastThresholdTokensValue = spec.thresholdTokens
    if (measurement.totalTokens < spec.thresholdTokens) return null

    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null

    // R2-B: the economic admission gate. Structurally legal is not the same as
    // worth doing: a fold whose span barely exceeds the checkpoint it produces
    // reclaims almost nothing while paying the full framing preamble, and once
    // the frozen prefix alone exceeds the threshold a leaf CANNOT restore
    // headroom at all — it only appends another checkpoint to a prefix that
    // already exceeds the threshold, which is the self-sustaining loop R1
    // measured (51 folds vs Basic's 21 on an identical workload and digest).
    if (this.efConfig.leafAdmission === 'economic') {
      const verdict = this.admitLeafEconomically(agent.session, measurement, spec.thresholdTokens)
      this.lastLeafAdmissionValue = verdict
      if (!verdict.admitted) {
        // R2-B measured that refusing a leaf and STOPPING is a regression: the
        // history that is no longer folded stays on the surface as raw tokens,
        // which cost far more than the framing tax the refusal avoided
        // (measured: framing -46%, raw +807%, total 1.8x worse). A refusal is
        // therefore only correct as a HANDOFF to the one mechanism that can
        // actually shrink the frozen prefix.
        return this.rebaseAfterLeafRefusal(agent, measurement, spec)
      }
    }

    let result: CompactionResult | null = null
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      const span = selectLeafSpan(agent.session, measurement, spec.retainTokens)
      if (span === null) {
        if (result === null) return null
        break
      }
      result = await this.compactRegion(span.start, span.end, agent, signal)
      measurement = meter.measure(agent.session)
      if (measurement.totalTokens < spec.thresholdTokens) {
        this.recordRootRebaseAdvice(agent.session, measurement, agent)
        return result
      }
    }

    throw new Error(
      `epistemic-fold: still above threshold after ${spec.compactionRetries + 1} leaf fold attempts `
      + `(${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`,
    )
  }

  /**
   * Decide whether a leaf fold is economically admissible (R2-B).
   *
   * Two independent refusals:
   *
   * 1. **The frozen prefix alone is over threshold.** A leaf fold replaces
   *    part of the open tail with a checkpoint that JOINS the frozen prefix,
   *    so the next request is still over threshold and folds again. No leaf
   *    can end this; only a rebase can.
   * 2. **The marginal reclaim is too small.** The fold must reclaim more than
   *    the checkpoint overhead it creates (`minReclaimTokens`) and must
   *    reclaim a meaningful fraction of its span (`minReclaimRatio`).
   *
   * @param session - session whose surface is measured.
   * @param measurement - token-meter measurement matching the current surface.
   * @param thresholdTokens - the pressure threshold in force.
   * @returns the verdict, with the reason and the measured reclaim.
   */
  private admitLeafEconomically(
    session: Session,
    measurement: TokenMeasurement,
    thresholdTokens: number,
  ): LeafAdmissionVerdict {
    const breakdown = pressureBreakdown(session, measurement, thresholdTokens)
    if (breakdown.leafCannotSuffice) {
      return {
        admitted: false,
        reason: 'frozen_prefix_over_threshold',
        detail:
          `frozen prefix ${breakdown.frozenTokens} >= threshold ${thresholdTokens}; `
          + 'a leaf fold cannot restore headroom and only adds a checkpoint',
        reclaim: leafMarginalReclaim({
          spanTokens: breakdown.openTokens,
          frozenTokens: breakdown.frozenTokens,
          frozenCount: breakdown.frozenCount,
          fallbackCheckpointTokens: FRAMING_FALLBACK_TOKENS,
        }),
      }
    }

    const span = selectLeafSpan(session, measurement, 0)
    if (span === null) {
      return {
        admitted: false,
        reason: 'no_span',
        detail: 'no structurally legal span past the frontier',
      }
    }
    const spanTokens = measurement.nodes
      .slice(span.startIdx, span.endIdx + 1)
      .reduce((total, node) => total + node.tokens, 0)
    const reclaim = leafMarginalReclaim({
      spanTokens,
      frozenTokens: breakdown.frozenTokens,
      frozenCount: breakdown.frozenCount,
      fallbackCheckpointTokens: FRAMING_FALLBACK_TOKENS,
    })
    if (reclaim.reclaimTokens < this.efConfig.minReclaimTokens) {
      return {
        admitted: false,
        reason: 'reclaim_below_floor',
        detail:
          `net reclaim ${reclaim.reclaimTokens.toFixed(0)} tokens < floor ${this.efConfig.minReclaimTokens}`,
        reclaim,
      }
    }
    if (reclaim.reclaimRatio < this.efConfig.minReclaimRatio) {
      return {
        admitted: false,
        reason: 'ratio_below_floor',
        detail:
          `MRR ${(reclaim.reclaimRatio * 100).toFixed(1)}% < floor `
          + `${(this.efConfig.minReclaimRatio * 100).toFixed(1)}%`,
        reclaim,
      }
    }
    return {
      admitted: true,
      reason: 'admitted',
      detail:
        `reclaim ${reclaim.reclaimTokens.toFixed(0)} tokens, MRR ${(reclaim.reclaimRatio * 100).toFixed(1)}%`,
      reclaim,
    }
  }

  /**
   * One leaf fold from the frontier with the given retention budget; the
   * overflow path's forceful reduction (retain 0) funnels through here.
   */
  private async compactLeafFromFrontier(
    agent: Agent,
    measurement: TokenMeasurement,
    retainTokens: number,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const span = selectLeafSpan(agent.session, measurement, retainTokens)
    if (span === null) return null
    return this.compactRegion(span.start, span.end, agent, signal)
  }

  /**
   * The rebase handoff after an economic leaf refusal (R2-C, R3-0b).
   *
   * R2-B measured that refusing a leaf and stopping is a 1.8x REGRESSION: the
   * unfolded history stays on the surface as raw tokens, which cost far more
   * than the framing tax the refusal avoided. A refusal is therefore only
   * correct when it hands off to the mechanism that can actually shrink the
   * frozen prefix.
   *
   * The handoff is expressed as a PENDING INTENT rather than performed here,
   * and that is deliberate. A rebase needs an idle agent and no open turn, but
   * this path runs inside the caller's open turn and (in the real loop) inside
   * the caller's own maintenance bracket; nesting a second bracket would
   * either deadlock or corrupt the caller's transaction.
   *
   * R2-C consumed the handoff through a benchmark-only hook that re-read the
   * engine's advice and called `compactNow` — so the E3 numbers described the
   * engine plus a test policy, not the product. R3-0b replaces that with an
   * intent the PRODUCTION idle consumer drains, which re-decides from the
   * surface as it then stands.
   *
   * @returns always `null` — the caller's turn is left untouched.
   */
  private rebaseAfterLeafRefusal(
    agent: Agent,
    measurement: TokenMeasurement,
    spec: EfCompactSpec,
  ): CompactionResult | null {
    this.recordRootRebaseAdvice(agent.session, measurement, agent)

    if (this.efConfig.rootPolicy.mode !== 'economics') return null

    const decision = this.evaluateEconomicRebase(agent, measurement, spec)
    this.lastRebaseDecisionValue = decision
    if (decision.action !== 'root') return null

    // The cooldown still applies, so a rebase cannot thrash.
    if (this.stepsSinceRootRebase < ROOT_REBASE_COOLDOWN) return null

    this.recordRebaseIntent(agent.session, 'economic_leaf_refusal')
    this.ctx.logger.warn(
      `[epistemic-fold] economic rebase pending: ${decision.reason}`,
    )
    return null
  }

  /**
   * Decide whether an amortized rebase is justified for this request (R2-C).
   *
   * Uses the routed model's own economics profile — never a provider branch —
   * and the measured cache realization. The payback horizon answers the only
   * question that matters: will the frozen prefix be carried for enough
   * further requests to repay the rebase?
   *
   * @param atIdle - whether this decision is being made at the idle seam
   *   (R3-0b) rather than inside a pressure turn. It changes nothing about the
   *   economics; it only relaxes the anti-oscillation cooldown, because the
   *   cooldown exists to stop leaf/root thrashing WITHIN a turn, and an idle
   *   re-decision is by construction not part of that churn.
   */
  private evaluateEconomicRebase(
    agent: Agent,
    measurement: TokenMeasurement,
    spec: EfCompactSpec,
    atIdle = false,
  ): ContextPolicyDecision {
    const target = routedTarget(agent.session)
    const profile = resolveProfile(
      this.efConfig.rootPolicy.profiles,
      target?.provider ?? '',
      target?.model ?? '',
    )
    const breakdown = pressureBreakdown(agent.session, measurement, spec.thresholdTokens)
    return compileContextPolicy({
      economics: profile,
      telemetry: {
        frozenTokens: breakdown.frozenTokens,
        frozenCheckpointCount: breakdown.frozenCount,
        rawTailTokens: breakdown.openTokens,
        promptTokens: breakdown.totalTokens,
        recentFoldCadence: atIdle ? Number.POSITIVE_INFINITY : this.stepsSinceRootRebase,
      },
      pressure: {
        contextWindow: spec.contextWindow,
        currentTokens: breakdown.totalTokens,
      },
      policy: {
        paybackHorizonRequests: this.efConfig.rootPolicy.paybackHorizonRequests,
        realizationRate: this.efConfig.rootPolicy.realizationRate,
        pressureRatio: this.efConfig.thresholdRatio,
        compactionCost: this.efConfig.rootPolicy.compactionCost,
        rebaseCooldownFolds: atIdle ? 0 : ROOT_REBASE_COOLDOWN,
        // Inside a pressure turn this path is reached only AFTER a leaf was
        // refused, so a leaf is not an available action — without this the
        // pressure override would demand the very fold just rejected. At idle
        // the question is purely whether a root is worth it, so a leaf is
        // likewise not the alternative being weighed.
        leafAvailable: false,
      },
    })
  }

  /**
   * Record frozen-budget telemetry after pressure work settles, and — when the
   * budget heuristic fires on its own (R3-0b) — raise a pending rebase intent
   * for the idle consumer.
   *
   * Under `legacy` root policy this only logs, preserving the R0 behavior
   * exactly: the advice is emitted for a human to act on with `/compact`.
   * Under `economics` the same condition is routed through the production
   * consumer instead, because "the frozen prefix is over its budget" is
   * precisely the case where a leaf cannot help.
   */
  private recordRootRebaseAdvice(
    session: Session,
    measurement: TokenMeasurement,
    agent?: Agent,
  ): void {
    const advice = evaluateRootRebase(
      session,
      measurement,
      this.efConfig.frozenCheckpointTokenBudget,
    )
    // Anti-oscillation (R0-C): a root fold resets the frozen prefix, and the
    // very next leaf fold would immediately re-exceed a tight budget —
    // without a cooldown the arm degenerates into leaf/root thrashing.
    const recommended = advice.recommended
      && this.stepsSinceRootRebase >= ROOT_REBASE_COOLDOWN
    this.lastRootRebaseAdviceValue = { ...advice, recommended }
    this.stepsSinceRootRebase += 1
    if (!recommended) return
    if (this.efConfig.rootPolicy.mode === 'economics' && agent !== undefined) {
      this.recordRebaseIntent(agent.session, 'frozen_budget')
      return
    }
    this.ctx.logger.warn(
      `[epistemic-fold] frozen checkpoint budget exceeded: ${advice.frozenTokens} tokens across `
      + `${advice.frozenCount} checkpoints (budget ${advice.budget}); a manual root rebase `
      + '(/compact) is recommended',
    )
  }

  /**
   * The EF compile hook: archive the exact shadowed messages, run the semantic
   * call, publish the final bundle atomically, then hand Basic the checkpoint.
   * Semantic failures fall back deterministically WITHOUT entering Basic's
   * `compaction/summary-error` recovery — that recovery may rewrite the
   * selected input, which would break the prepared candidate identity.
   */
  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const session = agent.session
    const candidate = this.candidates.get(session)
    if (candidate === undefined) {
      // Every engine entry point (leaf compactRegion, root compactNow)
      // prepares its candidate explicitly; reaching the hook without one
      // means an unsanctioned caller and fails loud.
      throw new Error('epistemic-fold: summarize reached without a prepared fold candidate')
    }
    const { contextPrefix, shadowedMessages } = splitSummarizationInput(input)
    const orderedSurfaceSeqs = this.currentSpanSeqs(agent, candidate, contextPrefix.length > 0)

    // The fallback SummaryResult that lands if the semantic call fails. The
    // transaction stays a success for Basic: the bundle is durable and the
    // checkpoint is deterministic — never a summary-error recovery.
    // NOTE: Basic's transaction wraps the returned summary blocks with its
    // own durable checkpoint framing (frameSummary) — the compile hook must
    // return the UNFRAMED body or the surface lands a double-wrapped text.
    const fallbackText = renderFallbackCheckpoint(candidate, shadowedMessages.length)
    // One registry probe per fold: the structured rendering path and the
    // semantic-mode choice read the same mounted state.
    const mountedState = this.mountedState(session)

    const publish = async (
      semanticText: string | undefined,
      semanticMeta?: SummaryResult,
    ): Promise<SummaryResult> => {
      // M3a: when the deterministic projection is mounted, the checkpoint is
      // a structured handoff — machine state first, narrative in Rationale.
      const stateText = this.structuredStateText(mountedState, candidate.checkpointId, semanticText)
      const renderedText = stateText ?? (semanticText === undefined
        ? fallbackText
        : renderSemanticCheckpoint(candidate, semanticText))
      const bundle = buildBundle({
        candidate,
        orderedSurfaceSeqs,
        shadowedMessages,
        renderedText,
        ...(semanticText === undefined ? {} : { semanticText }),
      })
      await this.bundles.write(bundle)
      this.lastPublishedBundle = bundle
      if (semanticMeta !== undefined) {
        // Forward the REAL call envelope — provider, model, usage, rawOutput —
        // into compaction/summary (durable auditability, R0-A §18).
        return {
          ...semanticMeta,
          summary: [{ type: 'text', text: renderedText }],
        }
      }
      return {
        summary: [{ type: 'text', text: renderedText }],
        provider: 'epistemic-fold',
        model: 'deterministic-fallback',
      }
    }

    // Semantic ACQUISITION only (may fall back); PUBLISH below runs outside
    // every catch — a bundle write failure is an archive failure and must
    // abort the transaction, never silently downgrade to a fallback (T06).
    let semanticText: string | undefined
    let semanticMeta: SummaryResult | undefined

    if (mountedState !== undefined) {
      if (this.efConfig.semanticMode === 'rationale') {
        try {
          const rationale = await rationaleOnly({
            ctx: this.ctx,
            target: conversationTarget(agent) ?? { provider: 'unrouted', model: 'unrouted' },
            maxTokens: RATIONALE_MAX_TOKENS,
            input,
            agent,
            signal,
          })
          semanticText = rationale.text
          semanticMeta = {
            summary: [{ type: 'text', text: rationale.text }],
            provider: rationale.provider,
            model: rationale.model,
            maxTokens: rationale.maxTokens,
            ...(rationale.usage === undefined ? {} : { usage: rationale.usage }),
            rawOutput: rationale.rawOutput,
            llmStreamCall: true,
          }
        } catch (error: unknown) {
          if (signal?.aborted === true) throw error
          semanticText = undefined
        }
      }
      // semanticMode 'none': no LLM call at all — zero-LLM profile.
    } else {
      // Legacy (no projection mounted): Basic's own full-checkpoint summary
      // IS the checkpoint body — the correct prompt for that shape.
      try {
        const semantic = await super.summarize(input, agent, signal)
        const text = semantic.summary
          .map(block => block.type === 'text' ? block.text : '')
          .join('\n')
          .trim()
        if (text.length > 0) {
          semanticText = text
          semanticMeta = semantic
        }
      } catch (error: unknown) {
        if (signal?.aborted === true) throw error
        semanticText = undefined
      }
    }

    return await publish(semanticText, semanticMeta)
  }

  /**
   * The mounted EF current state for one session, or `undefined` when the
   * projection is not registered — the single probe both the rendering path
   * and the semantic-mode choice read.
   */
  private mountedState(session: Session): FoldCurrentState | undefined {
    const registry = this.ctx.get('sessionProjections')
    if (registry === undefined) return undefined
    if (registry.stateOf(session, EF_CURRENT_STATE_KEY) === undefined) return undefined
    return currentFoldState(this.ctx, session)
  }

  /**
   * The structured machine-state handoff when the EF projection is mounted;
   * `undefined` keeps the M0/M2 rendering path untouched.
   */
  private structuredStateText(
    state: FoldCurrentState | undefined,
    checkpointId: string,
    semanticText: string | undefined,
  ): string | undefined {
    if (state === undefined) return undefined
    return renderStructuredCheckpoint(state, checkpointId, semanticText)
  }

  /**
   * Surface seqs of the span being folded, read fresh when the hook runs.
   * The candidate's start/end name surface positions at prepare time; Basic
   * revalidated the span before the summarize call, so the current surface
   * still contains both boundaries.
   */
  private currentSpanSeqs(
    agent: Agent,
    candidate: ReturnType<FoldCandidateRegistry['get']>,
    hasSystemHead: boolean,
  ): readonly SessionSeq[] {
    const nodes = agent.session.surface.nodes
    if (candidate?.start !== undefined && candidate.end !== undefined) {
      const startIdx = nodes.indexOf(candidate.start)
      const endIdx = nodes.indexOf(candidate.end)
      if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
        return nodes.slice(startIdx, endIdx + 1)
      }
    }
    // Implicit root fold: everything currently on the surface except the
    // system head node, which the summarization input retains unshadowed.
    if (hasSystemHead && nodes.length > 0) return nodes.slice(1)
    return [...nodes]
  }
}

export default EpistemicFoldEngine
