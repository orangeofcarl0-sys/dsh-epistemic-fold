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
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
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
  type EpistemicFoldConfig,
  type ResolvedEpistemicFoldConfig,
} from './policy.ts'
import type {
  CheckpointBundleV1,
  FoldBundleStore,
  FoldCommitRecordV1,
  SummarizationInput,
  SummaryResult,
} from './types.ts'

/** Cap for the rationale-only auxiliary call (R0-A: ~100-400 tokens). */
const RATIONALE_MAX_TOKENS = 400

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
  /** Last bundle published by this engine (per transaction, for tests/telemetry). */
  private lastPublishedBundle: CheckpointBundleV1 | undefined
  private lastRootRebaseAdviceValue: ReturnType<typeof evaluateRootRebase> | undefined

  constructor(
    ctx: ConstructorParameters<typeof BasicCompactionEngine>[0],
    config: EpistemicFoldConfig = {},
    options: EpistemicFoldOptions = {},
  ) {
    // Basic validates its config keys strictly; EF-owned fields must be
    // stripped before the super call (they are resolved by resolveEfConfig).
    const { frozenCheckpointTokenBudget: _budget, semanticMode: _mode, bundleRoot: _root, ...basicConfig } = config
    void _budget
    void _mode
    void _root
    super(ctx, basicConfig)
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
      if (result !== null) await this.recordCommit(candidate, result)
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
    if (measurement.totalTokens < spec.thresholdTokens) return null

    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null

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
        this.recordRootRebaseAdvice(agent.session, measurement)
        return result
      }
    }

    throw new Error(
      `epistemic-fold: still above threshold after ${spec.compactionRetries + 1} leaf fold attempts `
      + `(${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`,
    )
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

  /** Record frozen-budget telemetry after pressure work settles. */
  private recordRootRebaseAdvice(session: Session, measurement: TokenMeasurement): void {
    const advice = evaluateRootRebase(
      session,
      measurement,
      this.efConfig.frozenCheckpointTokenBudget,
    )
    this.lastRootRebaseAdviceValue = advice
    if (advice.recommended) {
      this.ctx.logger.warn(
        `[epistemic-fold] frozen checkpoint budget exceeded: ${advice.frozenTokens} tokens across `
        + `${advice.frozenCount} checkpoints (budget ${advice.budget}); a manual root rebase `
        + '(/compact) is recommended',
      )
    }
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

    const publish = async (
      semanticText: string | undefined,
      semanticMeta?: SummaryResult,
    ): Promise<SummaryResult> => {
      // M3a: when the deterministic projection is mounted, the checkpoint is
      // a structured handoff — machine state first, narrative in Rationale.
      const stateText = this.structuredStateText(session, candidate.checkpointId, semanticText)
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

    if (this.isProjectionMounted(session)) {
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

  /** Whether the EF current-state projection is registered on the context. */
  private isProjectionMounted(session: Session): boolean {
    const registry = this.ctx.get('sessionProjections')
    if (registry === undefined) return false
    return registry.stateOf(session, EF_CURRENT_STATE_KEY) !== undefined
  }

  /**
   * The structured machine-state handoff when the EF projection is mounted;
   * `undefined` keeps the M0/M2 rendering path untouched.
   */
  private structuredStateText(session: Session, checkpointId: string, semanticText: string | undefined): string | undefined {
    const registry = this.ctx.get('sessionProjections')
    if (registry === undefined) return undefined
    if (registry.stateOf(session, EF_CURRENT_STATE_KEY) === undefined) return undefined
    const state = currentFoldState(this.ctx, session)
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
