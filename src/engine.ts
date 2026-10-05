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

// EF extends its OWN copy of Basic, not the host's package (RC7). Two things
// depend on that: `framingMode: system-dedup` needs a `frameCheckpoint` hook the
// host build does not ship, and `mode: basic` must reproduce native Basic
// exactly — which a subclass of the host engine cannot do, because virtual
// dispatch re-enters EF's own overrides. See src/basic/ and THIRD_PARTY_NOTICES.md.
import BasicCompactionEngine from './basic/index.ts'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { createFoldCandidate, FoldCandidateRegistry } from './candidate.ts'
import {
  buildBundle,
  renderFallbackCheckpoint,
  renderSemanticCheckpoint,
  splitSummarizationInput,
} from './compiler.ts'
import { FileBundleStore } from './bundle-store.ts'
import { selectCompactableRange } from './basic/region.ts'
import { hasActiveCompaction, locateFoldFrontier } from './frontier.ts'
import { selectLeafSpan } from './leaf-policy.ts'
import { assertDshCompatibility } from './compat.ts'
import { foldFrameCheckpoint, framingModeFor } from './framing.ts'
import type { FramingMode } from './framing.ts'
import type { TriggerBreakdown } from './trigger.ts'
import { TriggerDiagnostics } from './trigger-diagnostics.ts'
import {
  ROOT_REBASE_COOLDOWN,
  admitLeafEconomically,
  evaluateEconomicRebase,
  rootRebaseAdvice,
} from './fold-economics.ts'
import type { LeafAdmissionVerdict } from './fold-economics.ts'
import { classifyRegime, resolveProfile, rhoOf } from './economics-profile.ts'
import type { ContextPolicyDecision } from './policy-compiler.ts'
import { createRebaseIntentRegistry } from './rebase-intent.ts'
import type { PendingRebaseIntent, RebaseCause, RebaseIntentRegistry } from './rebase-intent.ts'
import { classifyCapacityRegime, classifyPressureRegime, pressureBreakdown } from './pressure.ts'
import type { CapacityRegime, PressureRegime } from './pressure.ts'
import { evaluateRootRebase } from './root-policy.ts'
import { currentFoldState, EF_CURRENT_STATE_KEY } from './projection.ts'
import { describeRenderedState, renderStructuredCheckpoint } from './renderer.ts'
import { rationaleOnly } from './rationale.ts'
import {
  conversationTarget,
  resolveEfConfig,
  reservedCompletionTokens,
  resolveEfCompactSpec,
  routedTarget,
  stripEfConfigKeys,
  type EfCompactSpec,
  type EpistemicFoldConfig,
  type ResolvedEpistemicFoldConfig,
} from './policy.ts'
import { isBasicMode } from './preset.ts'
import type { FoldModeName } from './preset.ts'
import type { FoldCurrentState } from './state.ts'
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

  /**
   * EF-resolved policy face; Basic keeps its own resolved config for summarization.
   *
   * MUTABLE since RC3, behind {@link setMode}. `/context mode <tier>` changes the
   * policy of a RUNNING session, so the resolved face cannot be frozen at
   * construction. Everything that reads it reads the CURRENT value, which is
   * what makes a switch take effect on the next fold rather than the next boot.
   */
  private resolvedConfig: ResolvedEpistemicFoldConfig

  /** The EF-resolved policy in force right now. */
  get efConfig(): ResolvedEpistemicFoldConfig {
    return this.resolvedConfig
  }

  /**
   * The mode name currently in force.
   *
   * Tracked separately from the resolved keys because `mode` is a NAMING face
   * that resolution expands and then drops — the resolved object cannot say
   * which tier produced it, and a status surface must be able to report it.
   */
  private currentModeValue: FoldModeName = 'legacy'

  /** The mode name in force right now. */
  get currentMode(): FoldModeName {
    return this.currentModeValue
  }

  /**
   * Whether EF is standing aside for this engine (`mode: basic`, RC7).
   *
   * Read by all five divergence points. It is a getter over the same mutable
   * field `setMode` writes, so it cannot drift from `currentMode`.
   */
  private isBasic(): boolean {
    return isBasicMode(this.currentModeValue)
  }

  /**
   * Whether this engine registered any EF surface at all.
   *
   * `mode: basic` mounts NOTHING: no projection, no status, no recall tools, no
   * command. The plugin decides that at construction, because projection
   * registration is a mount-time fact rather than a policy knob — see
   * `plugin.ts`. This accessor exists so a test can assert the suppression
   * rather than infer it.
   */
  get basicMode(): boolean {
    return this.isBasic()
  }

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
  /** Leaf folds committed by this engine; the counterpart to `rootFoldCount`. */
  private leafFoldCountValue = 0
  /** Emergency rebases committed by this engine (provider-overflow recovery). */
  private emergencyRebaseCountValue = 0
  /**
   * Bundles this engine has successfully written.
   *
   * A MONOTONIC write counter, deliberately NOT `bundleStore.list().length`.
   * The two differ whenever a bundle is removed, a session directory is
   * cleaned, or the store root becomes unreadable — and `list()` reports the
   * first two as a smaller number and the third as a thrown error, which a
   * caller that swallows it turns into the same `0` as "never folded". A
   * telemetry column must count what happened, not what is still on disk.
   *
   * ## This counts PUBLISHES, not committed folds
   *
   * The two can differ, and the difference is by design. `BundleDurable ≺
   * SurfaceLoss` requires the archive to be durable BEFORE the surface is
   * replaced, so `summarize` publishes the bundle and only then does Basic
   * decide whether to commit — and it can refuse, e.g. when the framed summary
   * is not smaller than the shadowed content. A refused fold therefore leaves a
   * published bundle behind.
   *
   * That asymmetry is the SAFE direction: a bundle with no surface replacement
   * means history was copied and nothing was lost. The consequence to know
   * about is that `context_search` can find such a bundle, so a caller must not
   * assume `bundleWriteCount === leafFoldCount + rootFoldCount +
   * emergencyRebaseCount`. It is `>=`, and the excess is refused folds.
   *
   * (Measured: a one-turn session whose root fold is refused by the shrink check
   * reports `writes 1, root 0`, and the bundle is retrievable by
   * `context_search`.)
   */
  private bundleWriteCountValue = 0
  /** Most recent pressure regime `compactIfNeeded` acted on (telemetry). */
  private lastPressureRegimeValue: PressureRegime | undefined
  /**
   * The regime the retry loop found after its most recent leaf (telemetry).
   *
   * Kept SEPARATE from `lastPressureRegimeValue`, which records the regime the
   * decision was based on. The two differ whenever a leaf fold moves a span into
   * the frozen prefix and pushes the surface from open-bound to frozen-bound —
   * and collapsing them into one field loses exactly the transition the I1
   * invariant is about, because the post-fold value would overwrite the entry
   * value the decision was made on.
   */
  private lastPostLeafRegimeValue: PressureRegime | undefined
  /**
   * The CAPACITY regime the most recent overflow decision used (telemetry).
   *
   * The soft and hard classifications are not interchangeable, and the overflow
   * path decides on the hard one: a surface can be soft-frozen-bound while still
   * comfortably inside the provider's limit, and folding a leaf there is correct
   * because the open tail is what is over capacity. Recording which budget
   * governed the decision is what lets a reader (or a test) tell a legal
   * overflow leaf from an illegal frozen-bound one.
   */
  private lastCapacityRegimeValue: CapacityRegime | undefined
  /** Framing mode in force, resolved once against the mounted context. */
  private framingModeResolved: FramingMode | undefined
  /** The per-target trigger decomposition reported to the log (RC1-A). */
  private readonly triggers = new TriggerDiagnostics()

  constructor(
    ctx: ConstructorParameters<typeof BasicCompactionEngine>[0],
    config: EpistemicFoldConfig = {},
    options: EpistemicFoldOptions = {},
  ) {
    // Basic validates its config keys strictly; EF-owned fields must be
    // stripped before the super call (they are resolved by resolveEfConfig).
    super(ctx, stripEfConfigKeys(config))
    this.resolvedConfig = resolveEfConfig(config)
    this.currentModeValue = config.mode ?? 'legacy'
    // R4 §4: the framing seam is an EXTERNAL dependency, so its presence is
    // verified once, here, against the requested mode — never sniffed per fold
    // and never silently downgraded. `legacy` needs no seam, so the default
    // deployment mounts on any DSH build.
    assertDshCompatibility(this.resolvedConfig.framingMode)
    // Loader deployments pass exactly (ctx, config): the store then comes
    // from `bundleRoot` in the config face, honoring the DSH persistence
    // lifecycle (R0-B). Programmatic callers may inject a store directly.
    this.bundles = options.bundleStore ?? new FileBundleStore(this.efConfig.bundleRoot)
  }

  /**
   * Switch the policy tier of this RUNNING engine (RC3).
   *
   * `/context mode <tier>` is the control-plane half of the product: a user
   * picks a tier and the NEXT fold uses it, without a restart and without
   * touching the session.
   *
   * ## What a switch does and does not change
   *
   * It re-resolves the policy face from the tier's values, so admission,
   * rebasing, retention and the semantic face all take effect immediately.
   * Three things are deliberately NOT changed, because changing them mid-session
   * would be a correctness hazard rather than a policy choice:
   *
   *  - **`bundleRoot`.** A tier never sets it (it is not a preset key), and a
   *    switch must not redirect where an in-flight session writes its bundles.
   *  - **`framingMode`.** It is verified against the DSH build at construction;
   *    switching it later would need a re-verification this method does not do.
   *    A tier that wanted a different framing is refused rather than
   *    half-applied.
   *  - **Everything the user set explicitly.** A tier fills by OMISSION, so an
   *    explicit key keeps winning after a switch — the same rule that governs
   *    construction.
   *
   * @param mode - the tier to switch to.
   * @param explicit - the deployment's own config, so explicit keys still win.
   * @returns the previous mode name.
   * @throws when the tier would change the framing mode, which cannot be
   *   switched at runtime.
   */
  setMode(mode: FoldModeName, explicit: EpistemicFoldConfig = {}): FoldModeName {
    const previous = this.currentModeValue
    if (mode === previous) return previous
    // `basic` is an INSTALL-TIME mode (RC7). It suppresses EF's whole surface at
    // mount — projection, status, recall tools, command — and those are
    // registrations, not policy: a running engine cannot unregister them
    // without leaving the RC4-A defect (a mounted EF reporting folds it is not
    // performing). So switching in or out of it is refused rather than
    // half-applied.
    if (isBasicMode(mode) || isBasicMode(previous)) {
      throw new Error(
        `epistemic-fold: cannot switch ${isBasicMode(previous) ? 'out of' : 'to'} mode `
        + `${JSON.stringify(mode)} at runtime — "basic" is an install-time mode, because it decides `
        + 'whether EF registers any surface at all. Restart with the mode in config instead.',
      )
    }
    const next = resolveEfConfig({ ...explicit, mode })
    if (next.framingMode !== this.resolvedConfig.framingMode) {
      throw new Error(
        `epistemic-fold: cannot switch to mode ${JSON.stringify(mode)} at runtime — it changes `
        + `framingMode (${this.resolvedConfig.framingMode} -> ${next.framingMode}), which is verified `
        + 'against the DSH build at construction. Restart with the mode in config instead.',
      )
    }
    this.resolvedConfig = next
    this.currentModeValue = mode
    return previous
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

  /**
   * Leaf folds this engine has committed.
   *
   * Counted here rather than derived from the bundle store, so telemetry
   * survives a store that is unreadable or has been cleaned. Together with
   * `rootFoldCount` and `emergencyRebaseCount` this is the engine's own
   * lifetime record of what it did.
   */
  get leafFoldCount(): number {
    return this.leafFoldCountValue
  }

  /** Emergency rebases this engine has committed (provider-overflow recovery). */
  get emergencyRebaseCount(): number {
    return this.emergencyRebaseCountValue
  }

  /** Bundles this engine has successfully written (monotonic, never decreases). */
  get bundleWriteCount(): number {
    return this.bundleWriteCountValue
  }

  /** Outstanding pending-rebase intents across all sessions (telemetry). */
  get pendingRebaseIntentCount(): number {
    return this.rebaseIntents.size
  }

  /**
   * The pressure regime the most recent `compactIfNeeded` resolved.
   *
   * `undefined` before any pressure check. Exposed so telemetry can report the
   * regime the engine actually acted on rather than re-deriving it from tokens
   * (which would silently disagree whenever the threshold moved).
   */
  get lastPressureRegime(): PressureRegime | undefined {
    return this.lastPressureRegimeValue
  }

  /**
   * The regime the retry loop found AFTER its most recent leaf, or `undefined`
   * when no leaf was folded.
   *
   * Distinct from {@link lastPressureRegime}, which is the regime the decision
   * was based on. A leaf can move a span into the frozen prefix and flip
   * open-bound to frozen-bound, so the two legitimately differ — and that
   * transition is what I1 exists to catch. Recording it separately keeps the
   * entry regime readable instead of overwriting it with the outcome.
   */
  get lastPostLeafRegime(): PressureRegime | undefined {
    return this.lastPostLeafRegimeValue
  }

  /**
   * The CAPACITY regime the most recent overflow decision used, or `undefined`
   * before any overflow recovery.
   *
   * Reported because the two classifications answer different questions and the
   * overflow path acts on this one. A soft-frozen-bound surface that is still
   * hard-open-bound may legally take a leaf — the open tail is what overflowed —
   * so a reader comparing the two fields can distinguish that from a surface
   * whose frozen prefix alone exceeded the provider's limit.
   */
  get lastCapacityRegime(): CapacityRegime | undefined {
    return this.lastCapacityRegimeValue
  }

  /** The pending-rebase registry the idle consumer drives (R3-0b). */
  get rebaseIntentRegistry(): RebaseIntentRegistry {
    return this.rebaseIntents
  }

  /**
   * The trigger decomposition for one routed target, or `undefined` before the
   * engine has resolved that target's capacity (RC1-A §8).
   *
   * @param provider - routed provider.
   * @param model - routed model.
   * @returns the breakdown, so a caller can ask "who controls compaction?"
   *   without re-deriving the arithmetic.
   */
  triggerFor(provider: string, model: string): TriggerBreakdown | undefined {
    return this.triggers.for(provider, model)
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
    const decision = evaluateEconomicRebase({
      agent,
      measurement,
      spec,
      config: this.efConfig,
      stepsSinceRootRebase: this.stepsSinceRootRebase,
      atIdle: true,
    })
    this.lastRebaseDecisionValue = decision
    return decision
  }

  /**
   * Revalidate a SAFETY rebase against the CURRENT surface.
   *
   * The sibling of {@link rebaseDecisionAtIdle}, and the difference is the whole
   * reason both exist: an economic rebase asks "would this repay?", which the
   * policy compiler answers; a safety rebase asks "is a leaf still incapable?",
   * which is a structural measurement with no price in it. The compiler is not
   * consulted — under `rootPolicy: legacy` there is no economics to consult, and
   * a safety rebase must still converge.
   *
   * Revalidation is NOT skipped. The intent recorded that a leaf could not
   * restore headroom on a surface that no longer exists: the tail may have been
   * folded away since, or a rebase may have landed. So the condition is
   * re-derived here and `null` returned when it has passed, which drops the
   * intent without acting.
   *
   * @returns a `root` decision while the frozen prefix still defeats a leaf, or
   *   `null` when the condition has cleared or no capacity is known.
   */
  async safetyRebaseDecisionAtIdle(agent: Agent): Promise<ContextPolicyDecision | null> {
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
    const breakdown = pressureBreakdown(agent.session, measurement, spec.thresholdTokens)
    const regime = classifyPressureRegime(breakdown)
    if (regime !== 'frozen-bound') {
      this.ctx.logger.info(
        `[epistemic-fold] safety rebase no longer justified: the surface is now `
        + `"${regime}" (frozen ${breakdown.frozenTokens}/${spec.thresholdTokens})`,
      )
      return null
    }
    const decision: ContextPolicyDecision = {
      // The economics regime is REPORTED, not decided on: this path bypasses the
      // compiler because a frozen prefix that defeats every leaf is structural.
      // Classifying it anyway keeps the decision shape honest for a reader
      // comparing it against an economic one.
      regime: classifyRegime({
        rho: rhoOf(resolveProfile(
          this.efConfig.rootPolicy.profiles,
          target.provider,
          target.model,
        ), measurement.totalTokens),
        realizationRate: this.efConfig.rootPolicy.realizationRate,
      }),
      action: 'root',
      leafRepresentation: 'snapshot',
      semanticMode: 'none',
      estimatedCost: 0,
      overridden: true,
      reason:
        `frozen prefix ${breakdown.frozenTokens} >= threshold ${spec.thresholdTokens} across `
        + `${breakdown.frozenCount} checkpoint(s); a leaf cannot restore headroom, so a rebase is required`,
    }
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
    // `mode: basic` — no frontier invariant, no candidate, no bundle. Basic's
    // own transaction runs unmodified. See the note on `compactIfNeeded`.
    if (this.isBasic()) return super.compactRegion(start, end, agent, signal)
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
    // Every committed fold passes through here exactly once, so the lifetime
    // counters live here rather than at each call site. Counting at the call
    // sites is how `rootFoldCount` and a second counter would drift apart.
    switch (candidate.mode) {
      case 'leaf': this.leafFoldCountValue += 1; break
      case 'root': this.rootFoldCountValue += 1; break
      case 'emergency': this.emergencyRebaseCountValue += 1; break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default: assertNever(candidate.mode, 'fold mode')
    }
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
    // `mode: basic` — a manual `/compact` must behave exactly as Basic's, so no
    // candidate is prepared and no commit record is written. See the note on
    // `compactIfNeeded`.
    if (this.isBasic()) return super.compactNow(...args)
    const [agent] = args
    const candidate = createFoldCandidate({ mode: 'root', session: agent.session })
    this.candidates.prepare(agent.session, candidate)
    try {
      const result = await super.compactNow(...args)
      if (result !== null) {
        // `recordCommit` increments `rootFoldCount` for this mode, so it must
        // not be incremented here as well.
        await this.recordCommit(candidate, result)
        this.stepsSinceRootRebase = 0
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
    // `mode: basic` — EF stands aside (RC7). Branching here is not enough on
    // its own: Basic's own `compactIfNeeded` calls `this.compactRegion`, which
    // virtual dispatch routes back into EF's override, so every divergence
    // point needs its own branch. All five are marked `mode: basic`; see
    // tests/rc7-basic-parity.spec.ts, which is what holds them together.
    if (this.isBasic()) return super.compactIfNeeded(agent, trigger, signal)
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    const meter = this.ctx.tokenMeter
    let measurement: TokenMeasurement = meter.measure(agent.session)
    const prune = this.ctx.get('toolResultPruner')

    if (trigger === 'context-overflow') {
      return this.recoverFromOverflow(agent, target, measurement, meter, prune, signal)
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
    const reserved = reservedCompletionTokens(agent, info.defaultMaxTokens)
    const spec = resolveEfCompactSpec(
      this.efConfig,
      info.context.contextWindow,
      reserved,
    )
    this.triggers.report({
      target,
      contextWindow: info.context.contextWindow,
      reserved,
      config: this.efConfig,
      log: line => this.ctx.logger.info(line),
    })
    this.lastThresholdTokensValue = spec.thresholdTokens
    if (measurement.totalTokens < spec.thresholdTokens) return null

    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null

    // R2-B: the economic admission gate. Structurally legal is not the same as
    // worth doing: a fold whose span barely exceeds the checkpoint it produces
    // reclaims almost nothing while paying the full framing preamble.
    //
    // Evaluated BEFORE the structural check so its verdict is always recorded.
    // The verdict is telemetry as much as a decision — `frozen_prefix_over_threshold`
    // is how a reader sees WHY a surface stopped folding — so short-circuiting
    // past it would trade observability for control flow.
    let admissionVerdict: LeafAdmissionVerdict | undefined
    if (this.efConfig.leafAdmission === 'economic') {
      admissionVerdict = admitLeafEconomically({
        session: agent.session,
        measurement,
        thresholdTokens: spec.thresholdTokens,
        minReclaimTokens: this.efConfig.minReclaimTokens,
        minReclaimRatio: this.efConfig.minReclaimRatio,
      })
      this.lastLeafAdmissionValue = admissionVerdict
    }

    // I1 — FrozenBound ⇒ ¬Leaf, checked BEFORE any leaf is attempted.
    //
    // The regime is a structural fact, not an economic preference: once the
    // frozen prefix alone is at or over the threshold, a leaf fold replaces open
    // history with a checkpoint that JOINS that prefix, so the next request is
    // over the threshold again and folds again. R1 measured the consequence (51
    // EF folds against Basic's 21 on an identical workload and digest).
    //
    // This is checked for EVERY mode, `legacy` included. `legacy` freezes the
    // fold DECISIONS (admission, framing, semantic face); it does not license a
    // known-futile action, because the futile action is also the one that throws
    // when retries run out. A mode whose only two outcomes are "thrash" and
    // "throw" is not a compatibility baseline.
    const regime = classifyPressureRegime(pressureBreakdown(
      agent.session,
      measurement,
      spec.thresholdTokens,
    ))
    this.lastPressureRegimeValue = regime
    if (regime === 'frozen-bound') {
      // STRUCTURAL handoff: economics has no vote. A frozen-bound surface has
      // been shown to defeat every leaf, so a rebase is the only remaining
      // mechanism and refusing it would mean choosing non-convergence.
      return this.handOffFrozenBound(agent, measurement, spec)
    }

    if (admissionVerdict !== undefined && !admissionVerdict.admitted) {
      // ECONOMIC handoff: the surface is open-bound, so a leaf remains possible
      // — it is merely not worth its framing tax. R2-B measured that refusing a
      // leaf and STOPPING is a regression: the history that is no longer folded
      // stays on the surface as raw tokens, which cost far more than the framing
      // tax the refusal avoided (measured: framing -46%, raw +807%, total 1.8x
      // worse). A refusal is therefore only correct as a HANDOFF to the one
      // mechanism that can actually shrink the frozen prefix — and because this
      // is a price judgement rather than a structural fact, `rootPolicy` keeps
      // its veto: a policy that declines the rebase has chosen to carry the raw
      // history and is entitled to that trade.
      return this.rebaseAfterLeafRefusal(agent, measurement, spec)
    }

    let result: CompactionResult | null = null
    let previousTokens = measurement.totalTokens
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

      // I1 re-checked after EVERY leaf — not just once before the loop.
      //
      // A fold that starts `open-bound` can END `frozen-bound`: the leaf moved
      // its span into the frozen prefix, which is exactly the mechanism that
      // grows the prefix. Continuing to retry from here is the loop this whole
      // path exists to prevent, so the retry stops and hands off to the only
      // mechanism that can shrink the prefix.
      const afterRegime = classifyPressureRegime(pressureBreakdown(
        agent.session,
        measurement,
        spec.thresholdTokens,
      ))
      this.lastPostLeafRegimeValue = afterRegime
      if (afterRegime === 'frozen-bound') {
        this.handOffFrozenBound(agent, measurement, spec)
        return result
      }

      // I2 — an action that did not reduce pressure must never repeat. The
      // surface replacement has already committed at this point, so the check
      // cannot undo it; what it can do is refuse to run the same action again.
      if (measurement.totalTokens >= previousTokens) {
        this.ctx.logger.warn(
          `[epistemic-fold] leaf fold did not reduce pressure `
          + `(${previousTokens} -> ${measurement.totalTokens} estimated tokens); `
          + 'refusing to repeat it',
        )
        return result
      }
      previousTokens = measurement.totalTokens
    }

    throw new Error(
      `epistemic-fold: still above threshold after ${spec.compactionRetries + 1} leaf fold attempts `
      + `(${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens}, `
      + `frozen prefix ${pressureBreakdown(agent.session, measurement, spec.thresholdTokens).frozenTokens})`,
    )
  }

  /**
   * Hand a `frozen-bound` surface to the mechanism that can actually fix it.
   *
   * The cause is `frozen_bound_safety`, and that is not a label — it is what
   * makes the handoff unconditional. A frozen-bound surface has been shown to
   * defeat every leaf fold, so a rebase is the only remaining mechanism and
   * economic policy has no vote. Under `rootPolicy: legacy` this still records
   * an intent: the alternative is to stop folding and never converge, which is
   * how a `legacy` deployment would otherwise walk into a provider overflow.
   *
   * The handoff is a pending intent rather than an immediate rebase because
   * this path runs inside the caller's open turn and (in the real loop) inside
   * the caller's own maintenance bracket; a rebase needs an idle agent, and
   * nesting a second bracket would either deadlock or corrupt the caller's
   * transaction.
   *
   * @returns always `null` — the caller's turn is left untouched.
   */
  private handOffFrozenBound(
    agent: Agent,
    measurement: TokenMeasurement,
    spec: EfCompactSpec,
  ): CompactionResult | null {
    this.recordRootRebaseAdvice(agent.session, measurement, agent)
    this.recordRebaseIntent(agent.session, 'frozen_bound_safety')
    const breakdown = pressureBreakdown(agent.session, measurement, spec.thresholdTokens)
    this.ctx.logger.warn(
      `[epistemic-fold] frozen-bound rebase pending: the frozen prefix is `
      + `${breakdown.frozenTokens} tokens across ${breakdown.frozenCount} checkpoint(s) `
      + `>= threshold ${spec.thresholdTokens}; a leaf fold cannot restore headroom`,
    )
    return null
  }

  /**
   * Provider-overflow recovery: the one path where the request has ALREADY been
   * refused, so the soft/hard distinction stops being academic.
   *
   * ## Why this is not the pressure path with a different budget
   *
   * The soft threshold asks "do we want more headroom?" and a negative answer is
   * survivable — the request goes out and the fold is deferred to idle. Here the
   * provider has returned `CONTEXT_WINDOW_EXCEEDED`, which is empirical proof
   * that the surface did NOT fit. Two consequences:
   *
   * 1. **The provider's verdict outranks the local meter.** A meter reading
   *    below the nominal capacity is an estimate that has just been falsified —
   *    tokenizer differences, tool-schema accounting and provider envelopes all
   *    sit between the two. So this path never concludes "it fits, do nothing".
   * 2. **A rebase may not be deferred to idle.** Deferring means the retry goes
   *    out over a prefix that is still too large. When the frozen prefix alone
   *    exceeds the hard capacity a leaf is mathematically incapable of helping,
   *    so the only remaining action is a rebase — now, inside this turn.
   *
   * ## Why the transaction owner differs from the idle root
   *
   * `compactNow` wraps its work in `agent.runMaintenance`, which throws unless
   * the agent is idle (`agent "... " already has active work`). This path runs
   * inside a live turn, so that bracket is unavailable — the rebase must own the
   * CURRENT turn instead. Same transaction core, different owner.
   *
   * @returns the committed result, or `null` when nothing could be reduced.
   */
  private async recoverFromOverflow(
    agent: Agent,
    target: { provider: string; model: string },
    measurement: TokenMeasurement,
    meter: { measure(session: Session): TokenMeasurement },
    prune: { pruneSession(session: Session): void } | undefined,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    if (hasActiveCompaction(agent.session)) {
      throw new Error(
        'epistemic-fold: compaction already in progress; the session compaction lock is already active',
      )
    }
    // Fail closed on an unknown capacity, exactly as the pressure path does. A
    // leaf could be attempted without knowing the hard bound, but "we cannot
    // tell whether this can possibly work" is not a reason to guess — and the
    // provider has already told us the surface does not fit.
    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
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
    const breakdown = pressureBreakdown(agent.session, measurement, spec.thresholdTokens)
    // Recorded even though this path decides on the HARD capacity: leaving the
    // field untouched would report whatever a previous pressure call happened to
    // set, which is a stale reading presented as current telemetry.
    this.lastPressureRegimeValue = classifyPressureRegime(breakdown)
    const capacity = classifyCapacityRegime(breakdown, spec.hardCapacityTokens)
    this.lastCapacityRegimeValue = capacity

    // A leaf is only worth attempting when the OPEN trajectory is what overflows.
    // When the frozen prefix alone is over the hard capacity, folding more of the
    // tail appends another checkpoint to that prefix and the retry overflows
    // again — the loop this path exists to break.
    if (capacity !== 'frozen-bound') {
      const span = selectLeafSpan(agent.session, measurement, 0)
      if (span !== null) {
        const result = await this.compactRegion(span.start, span.end, agent, signal)
        const after = meter.measure(agent.session)
        const afterBreakdown = pressureBreakdown(agent.session, after, spec.thresholdTokens)
        if (classifyCapacityRegime(afterBreakdown, spec.hardCapacityTokens) === 'fits') {
          return result
        }
        // The leaf did not bring the surface under the hard capacity, so
        // repeating it is the futile retry. Escalate to the rebase below.
        this.ctx.logger.warn(
          `[epistemic-fold] overflow leaf fold did not fit the hard capacity `
          + `(${after.totalTokens} >= ${spec.hardCapacityTokens}); escalating to an emergency rebase`,
        )
      }
    }

    // I3/I4 — the stronger mechanism must run, and if it cannot, say so.
    const rebased = await this.commitEmergencyRebase(agent, signal)
    const final = meter.measure(agent.session)
    if (classifyCapacityRegime(
      pressureBreakdown(agent.session, final, spec.thresholdTokens),
      spec.hardCapacityTokens,
    ) !== 'fits') {
      // Explicit non-convergence: the provider has refused this surface, a leaf
      // could not help, and a rebase did not fit it either. Retrying would loop,
      // so fail with the diagnosis rather than let the caller retry blind.
      throw new Error(
        `epistemic-fold: cannot fit the provider's context window after overflow recovery `
        + `(${final.totalTokens} estimated tokens >= hard capacity ${spec.hardCapacityTokens}; `
        + `frozen prefix ${pressureBreakdown(agent.session, final, spec.thresholdTokens).frozenTokens} `
        + `across ${pressureBreakdown(agent.session, final, spec.thresholdTokens).frozenCount} checkpoint(s); `
        + `${rebased === null ? 'no rebase range was available' : 'an emergency rebase committed but did not reduce enough'})`,
      )
    }
    return rebased
  }

  /**
   * Rebase the whole surface inside the CURRENT turn — the overflow-recovery
   * transaction owner.
   *
   * Distinct from `compactNow`, which is the IDLE owner: that one brackets its
   * work in `agent.runMaintenance` and is therefore unusable while a turn is
   * live (`agent "... " already has active work`). The two share the candidate,
   * the bundle, the checkpoint compiler and the provenance record; they differ
   * only in who owns the transaction.
   *
   * The transaction itself is Basic's own `compactRegion`, which is already
   * `{ owner: 'current-turn', stability: 'whole-surface' }` — the exact bracket
   * a mid-turn rebase needs. EF's override of `compactRegion` cannot be used
   * here because it prepares a LEAF candidate and enforces the leaf invariants
   * (a span may not start before the frontier), so this calls the superclass
   * directly with an `emergency` candidate already prepared.
   *
   * @returns the committed result, or `null` when no range could be rebased.
   */
  private async commitEmergencyRebase(
    agent: Agent,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const measurement = this.ctx.tokenMeter.measure(agent.session)
    // `retain 0`: recovery first. The whole point of an emergency rebase is to
    // shrink the surface below the provider's limit, so keeping a verbatim tail
    // works against the only objective this transaction has.
    const range = selectCompactableRange(agent.session, measurement, 0)
    if (range === null) return null
    const candidate = createFoldCandidate({ mode: 'emergency', session: agent.session })
    this.candidates.prepare(agent.session, candidate)
    try {
      const result = await super.compactRegion(range.start, range.end, agent, signal)
      await this.recordCommit(candidate, result)
      this.stepsSinceRootRebase = 0
      // A landed rebase satisfies any outstanding intent: the prefix it asked
      // about has been collapsed, so a later idle event must not repeat it.
      this.rebaseIntents.clear(agent.session)
      this.lastRootRebaseAdviceValue = undefined
      return result
    } finally {
      this.candidates.clear(agent.session)
    }
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

    const decision = evaluateEconomicRebase({
      agent,
      measurement,
      spec,
      config: this.efConfig,
      stepsSinceRootRebase: this.stepsSinceRootRebase,
    })
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
    const advice = rootRebaseAdvice({
      session,
      measurement,
      budget: this.efConfig.frozenCheckpointTokenBudget,
      stepsSinceRootRebase: this.stepsSinceRootRebase,
    })
    const recommended = advice.recommended
    this.lastRootRebaseAdviceValue = advice
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
   * EF's checkpoint framing hook (R3-B/C).
   *
   * Basic's default wraps every checkpoint body in a fixed preamble and
   * `<compacted-summary>` tags. That framing is the largest single component of
   * a leaf checkpoint's cost and it is repeated once per fold — the R2 framing
   * analysis measured that no EF-side dieting can remove it, which is why the
   * seam exists.
   *
   * Under `legacy` this delegates to the inherited framing, so the default
   * deployment stays byte-identical to Basic. Under `system-dedup` the framing
   * is dropped HERE because the same semantics are stated once in a stable
   * system-prompt section, where a constant belongs.
   *
   * If `ctx.systemPrompt` is absent there is nowhere to put that explanation,
   * so the mode falls back to `legacy` and the preamble stays. Dropping the
   * preamble with nowhere to say what a checkpoint is would trade correctness
   * for tokens.
   */
  protected override frameCheckpoint(
    summary: readonly ContentBlock[],
    agent: Agent,
  ): ContentBlock[] {
    // `mode: basic` — the stock framing, unconditionally. `basic` never sets
    // `system-dedup`, so the mode check below would already route here, but the
    // branch is stated so the five divergence points are symmetric and a future
    // tier cannot make `basic` inherit its framing. See `compactIfNeeded`.
    if (this.isBasic()) return super.frameCheckpoint(summary, agent)
    if (this.resolvedFramingMode() === 'legacy') {
      return super.frameCheckpoint(summary, agent)
    }
    return foldFrameCheckpoint(summary)
  }

  /**
   * The framing mode actually in force, resolved against what is mounted.
   * Cached because the fallback decision is stable for one mounting.
   */
  private resolvedFramingMode(): FramingMode {
    if (this.framingModeResolved !== undefined) return this.framingModeResolved
    // RC0-A: no fallback branch. A `system-dedup` request without a system
    // prompt THROWS here rather than silently running per-checkpoint framing,
    // because a named mode must mean one determinate behavior.
    const resolved = framingModeFor(this.efConfig.framingMode, this.ctx.get('systemPrompt') !== undefined)
    this.framingModeResolved = resolved.mode
    return resolved.mode
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
    // `mode: basic` — Basic's own summarizer, and crucially NO bundle: the fold
    // never becomes an EF checkpoint, so no `[EF1 …]` marker is stamped and
    // there is nothing for the fold frontier to misread. See `compactIfNeeded`.
    if (this.isBasic()) return super.summarize(input, agent, signal)
    const session = agent.session
    const candidate = this.candidates.get(session)
    if (candidate === undefined) {
      // Every engine entry point (leaf compactRegion, root compactNow)
      // prepares its candidate explicitly; reaching the hook without one
      // means an unsanctioned caller and fails loud.
      throw new Error('epistemic-fold: summarize reached without a prepared fold candidate')
    }
    const { contextPrefix, shadowedMessages } = splitSummarizationInput(input)
    // The archive is the authority for how many surface nodes this fold covers;
    // see `currentSpanSeqs` for why the live surface alone cannot answer it.
    const orderedSurfaceSeqs = this.currentSpanSeqs(
      agent,
      candidate,
      contextPrefix.length > 0,
      shadowedMessages.length,
    )

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
        // EXPERIMENTAL, off by default: reference the archive instead of
        // copying it. `buildArchiveRefs` verifies the seqs and messages are the
        // same length, so the refs provably identify this archive.
        ...(this.efConfig.referentialArchive ? { referentialArchive: true } : {}),
        // Bind the body to the state it projected. Only when a projection was
        // mounted, because only then is state in the body at all.
        ...(mountedState === undefined
          ? {}
          : { renderedState: describeRenderedState(mountedState) }),
      })
      await this.bundles.write(bundle)
      this.bundleWriteCountValue += 1
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
   *
   * ## Why the archive length is the authority
   *
   * A ROOT fold has no candidate span, and the surface is NOT the same set of
   * nodes the archive covers: `selectCompactableRange` deliberately retains a
   * tail (`retainTokens`, and at least one node — see its `keepFromIdx` walk),
   * so the folded span is a PREFIX of the surface. Deriving the seq list from
   * "the whole current surface" therefore appended one seq that was never
   * folded. Measured on a real session: bundle seqs 212 vs 211 archived
   * messages, and `commit.shadowedSeqs` (Basic's own result) agreed with 211 —
   * the extra seq was the retained tail.
   *
   * So the seq list is taken from the surface positions that correspond to the
   * archived messages, and the archive length decides how many those are. That
   * makes the two structurally unable to disagree, which is what a reference
   * scheme needs before it can trust a seq list at all.
   */
  private currentSpanSeqs(
    agent: Agent,
    candidate: ReturnType<FoldCandidateRegistry['get']>,
    hasSystemHead: boolean,
    archivedCount: number,
  ): readonly SessionSeq[] {
    const nodes = agent.session.surface.nodes
    if (candidate?.start !== undefined && candidate.end !== undefined) {
      const startIdx = nodes.indexOf(candidate.start)
      const endIdx = nodes.indexOf(candidate.end)
      if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
        const span = nodes.slice(startIdx, endIdx + 1)
        // Compare against the number of MESSAGES the span actually yields, not
        // the number of surface nodes in it.
        //
        // A surface node does not always derive a message: `deriveEventMessage`
        // returns `null` for events that carry none, and Basic's own
        // summarization input filters those out (`region.ts`: `.map(…).filter(
        // message => message !== null)`). So `span.length` and the archive count
        // can differ by exactly those nodes WITHOUT any inconsistency.
        //
        // Measured on a live LHTB trial: this guard fired with "20 surface
        // node(s) but archived 19 message(s)" and ended the episode, after five
        // folds had already committed cleanly. The mismatch was one
        // non-message-carrying node, which is legal. Counting the derived
        // messages makes the two structurally comparable, which is what the
        // check was always meant to do.
        const derivedCount = span.filter(
          seq => agent.session.deriveEventMessage(agent.session.eventAt(seq)!) !== null,
        ).length
        if (derivedCount !== archivedCount) {
          throw new Error(
            `epistemic-fold: leaf fold span derives ${derivedCount} message(s) from `
            + `${span.length} surface node(s) but archived ${archivedCount} message(s); `
            + "the bundle's seq refs would not identify its archive",
          )
        }
        return span
      }
    }
    // Implicit root fold: the folded span is the LEADING part of the surface,
    // excluding the system head (which the summarization input retains
    // unshadowed) and excluding the retained tail.
    //
    // Walked by DERIVED MESSAGE count rather than by node count, for the same
    // reason as the leaf path above: a surface node that yields no message does
    // not contribute to the archive, so taking `archivedCount` nodes would cover
    // the wrong span whenever such a node is present.
    const headOffset = hasSystemHead && nodes.length > 0 ? 1 : 0
    const span: SessionSeq[] = []
    let derived = 0
    for (let index = headOffset; index < nodes.length && derived < archivedCount; index += 1) {
      const seq = nodes[index]!
      span.push(seq)
      if (agent.session.deriveEventMessage(agent.session.eventAt(seq)!) !== null) derived += 1
    }
    return span
  }
}

export default EpistemicFoldEngine
