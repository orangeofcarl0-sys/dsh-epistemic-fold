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
import BasicCompactionEngine from '../basic/index.ts'
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { createFoldCandidate, FoldCandidateRegistry } from './candidate.ts'
import {
  buildBundle,
  renderFallbackCheckpoint,
  renderSemanticCheckpoint,
  splitSummarizationInput,
} from '../checkpoint/compiler.ts'
import { FileBundleStore } from '../checkpoint/bundle-store.ts'
import { compactSurfaceRegion, selectCompactableRange } from '../basic/region.ts'
import { hasActiveCompaction, locateFoldFrontier } from './frontier.ts'
import { selectLeafSpan } from './leaf-policy.ts'
import { ActiveTaskRootRegistry, protectedTaskRootPosition, taskRootDigest } from './task-root.ts'
import type { ActiveTaskRootRef, TaskRootRegistration } from './task-root.ts'
import { assertDshCompatibility } from '../compat.ts'
import { foldFrameCheckpoint, framingModeFor } from '../checkpoint/framing.ts'
import type { FramingMode } from '../checkpoint/framing.ts'
import type { TriggerBreakdown } from '../policy/trigger.ts'
import { TriggerDiagnostics } from '../policy/trigger-diagnostics.ts'
import {
  ROOT_REBASE_COOLDOWN,
  admitLeafEconomically,
  assessFoldReachability,
  describeFoldReachability,
  evaluateEconomicRebase,
  rootRebaseAdvice,
} from '../policy/fold-economics.ts'
import type { FoldReachability, LeafAdmissionVerdict } from '../policy/fold-economics.ts'
import { classifyRegime, resolveProfile, rhoOf } from '../policy/economics-profile.ts'
import type { ContextPolicyDecision } from '../policy/policy-compiler.ts'
import { createRebaseIntentRegistry } from './rebase-intent.ts'
import type { PendingRebaseIntent, RebaseCause, RebaseIntentRegistry } from './rebase-intent.ts'
import { classifyCapacityRegime, classifyPressureRegime, pressureBreakdown } from '../policy/pressure.ts'
import type { CapacityRegime, PressureRegime } from '../policy/pressure.ts'
import { evaluateRootRebase } from '../policy/root-policy.ts'
import { currentFoldState, EF_CURRENT_STATE_KEY } from '../state/projection.ts'
import { describeRenderedState, renderStructuredCheckpoint, machineAnchorCount } from '../checkpoint/renderer.ts'
import { rationaleOnly, rationaleOutputFor } from '../checkpoint/rationale.ts'
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
} from '../config/policy.ts'
import { isBasicMode } from '../config/preset.ts'
import type { FoldModeName } from '../config/preset.ts'
import { resolveTargetPolicy } from '../basic/config.ts'
import { summarizeWithLlm } from '../basic/summarizer.ts'
import {
  isTruncationFailure,
  summaryRetryBudget,
  summaryRetryPolicy,
  summaryRetryStats,
} from '../checkpoint/summary-retry.ts'
import { retireDerivedAnswers } from '../recall/subagent-recall.ts'
import { createFoldTelemetry, recordFold } from './fold-telemetry.ts'
import type { FoldTelemetry } from './fold-telemetry.ts'
import type { ResolvedConfig, ResolvedTargetPolicy } from '../basic/types.ts'
import type { FoldCurrentState } from '../state/state.ts'
import type {
  CheckpointBundleV1,
  FoldBundleStore,
  FoldCommitRecordV1,
  SummarizationInput,
  SummaryResult,
} from '../types.ts'

// The rationale's generation cap used to live here as `RATIONALE_MAX_TOKENS`, first 400 and then
// 8192. Both were constants, and `docs/21` section 11.5 had already established that this cost is
// DERIVED from the folded span rather than carried as one. It now lives in `rationaleOutputFor`
// (src/checkpoint/rationale.ts), which is where its derivation and its two measured failures are documented.

/**
 * Tokens in the span a fold replaces, estimated from the shadowed messages.
 *
 * A 4-chars-per-token estimate is deliberate: the exact figure is not needed, because it only
 * sizes a budget that is clamped to [1024, 8192]. What matters is that the budget GROWS with the
 * span, which is `docs/21` section 11.5's principle -- the defect being fixed was a fixed 400
 * against a 1,043,005-token span.
 */
function estimateSpanTokens(messages: readonly { readonly content: readonly { readonly type: string; readonly text?: string }[] }[]): number {
  let chars = 0
  for (const m of messages) {
    for (const block of m.content) {
      if (block.type === 'text' && typeof block.text === 'string') chars += block.text.length
    }
  }
  return Math.round(chars / 4)
}

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
/** The spec a routed session resolves to, with what the callers also need from the lookup. */
interface ResolvedSpecFor {
  readonly target: NonNullable<ReturnType<typeof routedTarget>>
  readonly contextWindow: number
  readonly reserved: number
  readonly spec: EfCompactSpec
}

/** Why a spec could not be resolved, for the caller to turn into `null` or a throw. */
interface UnresolvedSpecFor {
  readonly reason: 'unrouted' | 'no-capacity'
  readonly key?: string
}

/**
 * The one "no context capacity" message.
 *
 * It was written out verbatim at two throw sites, so a reader debugging a mis-sized fold saw
 * one of them and could not tell whether the other said something different (docs/68 A-1).
 */
function noContextCapacityMessage(key: string): string {
  return `epistemic-fold: no context capacity for ${key}; configure contextWindow on that adapter model`
}

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
  /**
   * Host-declared active task roots, one per session.
   *
   * EMPTY unless a host registered one: this engine never guesses an objective from the
   * conversation, so a session with no explicit declaration behaves exactly as it did before
   * this field existed.
   */
  private readonly taskRoots = new ActiveTaskRootRegistry()
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
  /**
   * The telemetry record: counters that only increase, and last-observed values overwritten
   * by whichever path ran most recently.
   *
   * Moved out of this class by docs/68 B-1. Fourteen of its mutable fields existed
   * one-to-one with the getters below, so "what does this engine report" was spread through
   * a 1,700-line class and every new counter was a two-site edit inside the decision code it
   * observes. The FIELDS and the measured failure behind each one now live in
   * `fold-telemetry.ts`; the getters are unchanged, so no caller has to move.
   */
  private readonly telemetry: FoldTelemetry = createFoldTelemetry()
  /** Pressure folds since the last root rebase — the anti-oscillation cooldown. */
  private stepsSinceRootRebase = Number.POSITIVE_INFINITY
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
    return this.telemetry.rootRebaseAdvice
  }

  /**
   * The pressure threshold the most recent `compactIfNeeded` resolved, or 0
   * before any pressure check. Exposed so R2-A can decompose pressure against
   * the SAME threshold the engine acted on, rather than re-deriving it.
   */
  get lastThresholdTokens(): number {
    return this.telemetry.thresholdTokens
  }

  /**
   * The whole compact spec the most recent pressure check resolved, or `undefined`
   * before the first one. Companion to `lastThresholdTokens`, which reports one field
   * of it; this is what makes `contextWindow`, the hard capacity and the retain budget
   * publishable without re-deriving them.
   */
  get lastCompactSpec(): EfCompactSpec | undefined {
    return this.telemetry.compactSpec
  }

  /**
   * Derived retrieval answers this engine retired at fold time (docs/67).
   *
   * Exposed so a host can report that the exposure feature was exercised AND that its
   * provenance rule fired: `0` with subagent invocations above zero means answers were
   * produced and none had been folded yet.
   */
  /**
   * The token measurement for a session, so a HOST can compare it with its own.
   *
   * `ctx` is `protected` on the base Service class, and the tau2 harness needs the engine's own
   * reading to tell a shared-session disagreement from a stale-reference one. Exposing the one
   * measurement is narrower than exposing `ctx`, and it removes an `as unknown as` escape.
   */
  tokenMeterFor(session: Session): TokenMeasurement {
    return this.ctx.tokenMeter.measure(session)
  }

  get derivedAnswersRetired(): number {
    return this.telemetry.derivedAnswersRetired
  }

  /**
   * Rationale auxiliary calls attempted, and how many failed.
   *
   * Exposed because a FAILED rationale leaves a checkpoint byte-identical to
   * `semanticMode: 'none'` -- marker line and nothing else -- so without these the artifact
   * cannot tell "quality ran and discarded its rationale" from "quality never called out".
   */
  get rationaleAttempts(): number {
    return this.telemetry.rationaleAttempts
  }

  /** Rationale calls that threw; the difference from `rationaleAttempts` landed a rationale. */
  get rationaleFailures(): number {
    return this.telemetry.rationaleFailures
  }

  /** Most recent rationale failure reason (`MAX_TOKENS`, `UNSUPPORTED_CONTENT`, ...). */
  get rationaleFailureReason(): string | undefined {
    return this.telemetry.rationaleFailureReason
  }

  /** Character length of the most recent LANDED rationale; 0 when none landed. */
  get rationaleChars(): number {
    return this.telemetry.rationaleChars
  }

  /** Most recent economic leaf-admission verdict; `undefined` under `legacy`. */
  get lastLeafAdmission(): LeafAdmissionVerdict | undefined {
    return this.telemetry.leafAdmission
  }

  /** Most recent provider-aware rebase decision (R2-C); `undefined` under `legacy`. */
  get lastRebaseDecision(): ContextPolicyDecision | undefined {
    return this.telemetry.rebaseDecision
  }

  /**
   * Root folds this engine has committed. Exposed so a benchmark can verify a
   * maintenance event actually landed a rebase rather than inferring it from a
   * token delta (R3-0c).
   */
  get rootFoldCount(): number {
    return this.telemetry.rootFolds
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
    return this.telemetry.leafFolds
  }

  /** Emergency rebases this engine has committed (provider-overflow recovery). */
  get emergencyRebaseCount(): number {
    return this.telemetry.emergencyRebases
  }

  /** Bundles this engine has successfully written (monotonic, never decreases). */
  get bundleWriteCount(): number {
    return this.telemetry.bundleWrites
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
    return this.telemetry.pressureRegime
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
    return this.telemetry.postLeafRegime
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
    return this.telemetry.capacityRegime
  }

  /**
   * The reachability arithmetic from the most recent automatic fold decision.
   *
   * `canReachThreshold === false` means no legal fold could have brought this
   * surface under the threshold, so the engine stopped instead of retrying — and
   * a rebase would not have helped either, because it retains the same tail.
   */
  get lastFoldReachability(): FoldReachability | undefined {
    return this.telemetry.foldReachability
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
  /**
   * The compact spec for the session's routed model, or why there is none.
   *
   * Four call sites resolved the same three-step chain -- routed target, `resolveModelInfo`,
   * `resolveEfCompactSpec` -- and two of them also re-threw the same "no context capacity"
   * message verbatim. Adding a spec field or a reserve rule was therefore a four-site edit, and
   * a missed site prices folds against a different budget than its siblings (docs/68 A-1).
   *
   * Callers keep their own failure policy: the idle paths return `null`, the fold paths throw.
   * The helper returns the REASON rather than deciding, so that split stays visible at the site
   * that chooses it.
   */
  private async resolveSpecFor(
    agent: Agent,
    signal: AbortSignal | undefined,
  ): Promise<ResolvedSpecFor | UnresolvedSpecFor> {
    const target = routedTarget(agent.session)
    if (target === undefined) return { reason: 'unrouted' }
    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    if (info.context === undefined) {
      return { reason: 'no-capacity', key: `${target.provider}/${target.model}` }
    }
    const reserved = reservedCompletionTokens(agent, info.defaultMaxTokens)
    return {
      target,
      contextWindow: info.context.contextWindow,
      reserved,
      spec: resolveEfCompactSpec(this.efConfig, info.context.contextWindow, reserved),
    }
  }

  /**
   * The compaction lock, through ONE implementation and one message.
   *
   * The message was written out verbatim at two throw sites, so a change to the lock had to
   * find both (docs/68 A-2).
   *
   * ## A divergence this does NOT close, recorded so the next change finds it
   *
   * The vendored `src/basic/region.ts` EXPORTS `assertNoActiveCompaction`, and its policy is
   * not the same as `frontier.hasActiveCompaction`: the vendored one accepts an unmatched
   * `compaction/start` when a later `session/end-seed` boundary proves its owner belongs to an
   * earlier lifecycle (region.ts:320-332 and 583-611), and the frontier scan does not. On a
   * RESUMED session EF can therefore refuse a fold that Basic would allow. Reusing the vendored
   * function would change the error TYPE (`ManualCompactionError`) and its message, which is a
   * behaviour change and not part of a structural pass -- so it is reported here rather than
   * smuggled in.
   */
  private assertNoActiveCompaction(session: Session): void {
    if (hasActiveCompaction(session)) {
      throw new Error('epistemic-fold: compaction already in progress; the session compaction lock is already active')
    }
  }
  async rebaseDecisionAtIdle(agent: Agent): Promise<ContextPolicyDecision | null> {
    const resolved = await this.resolveSpecFor(agent, undefined)
    if (!('spec' in resolved)) return null
    const { spec } = resolved
    const measurement = this.ctx.tokenMeter.measure(agent.session)
    const decision = evaluateEconomicRebase({
      agent,
      measurement,
      spec,
      config: this.efConfig,
      stepsSinceRootRebase: this.stepsSinceRootRebase,
      atIdle: true,
    })
    this.telemetry.rebaseDecision = decision
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
    const resolved = await this.resolveSpecFor(agent, undefined)
    if (!('spec' in resolved)) return null
    const { target, spec } = resolved
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
    this.telemetry.rebaseDecision = decision
    return decision
  }

  /**
   * Fold one explicitly selected surface span as a LEAF fold: the candidate
   * is prepared first so the summarize hook knows the fold identity, and
   * cleared in a `finally` so cancellation or failure never leaks the slot.
   */
  /**
   * Declare the ACTIVE TASK ROOT for a session: the user event whose content is the current
   * task contract, and which every fold EF controls must leave model-visible.
   *
   * ## Why the host must say so, and why nothing here guesses
   *
   * There is no trustworthy way to read an objective off a conversation. The first user message
   * is not it (a session can open with a preamble), and a later message is not it (a revision is
   * not a new task). So a root exists only because a host called this, and its content is the
   * named event's own bytes.
   *
   * ## What is guaranteed, and what is not
   *
   * LEAF and EMERGENCY folds never include a resident root: EF selects both spans, so the
   * original user event stays exactly where it was, with its own authority and no copy made.
   *
   * A ROOT fold is NOT covered. `compactNow` delegates to the vendored Basic implementation,
   * which selects its own range and calls `compactSurfaceRegion` directly rather than
   * `this.compactRegion`, so EF has no interception point. See docs/70.
   *
   * @param ref - the declaration, or the same one again (idempotent), or a NEW one to replace.
   * @returns what the registry did, and the ref now in effect.
   */
  registerActiveTaskRoot(ref: ActiveTaskRootRef): TaskRootRegistration {
    return this.taskRoots.register(ref)
  }

  /**
   * Stop protecting a session's root. Called by a host that has no current task, and at teardown.
   *
   * @returns whether a root was actually removed.
   */
  clearActiveTaskRoot(sessionId: SessionId): boolean {
    return this.taskRoots.clear(sessionId)
  }

  /**
   * Why a registered root is or is not currently protected.
   *
   * Exposed so a caller can tell "this session has no task root" from "this session HAS one and
   * it is no longer on the surface". The second is a lost contract, and the two must not read
   * the same in a report.
   */
  taskRootStatus(session: Session):
    | { readonly status: 'unregistered' }
    | { readonly status: 'resident'; readonly position: number }
    | { readonly status: 'absent'; readonly reason: string } {
    const ref = this.taskRoots.get(session.id)
    if (ref === undefined) return { status: 'unregistered' }
    const position = protectedTaskRootPosition(session, ref)
    if (position !== undefined) return { status: 'resident', position }
    const event = session.eventAt(ref.sourceSeq)
    const message = event === undefined ? null : session.deriveEventMessage(event)
    return {
      status: 'absent',
      reason: message === null
        ? 'source-not-on-surface'
        : message.role !== 'user'
          ? 'not-a-user-message'
          : taskRootDigest(message) !== ref.sourceDigest ? 'digest-mismatch' : 'source-not-on-surface',
    }
  }

  /**
   * The surface positions no EF-selected fold may include: a resident active task root.
   *
   * Empty for a session with no registration, so the default path is unchanged; and empty for a
   * registered root that is no longer on the surface, which `taskRootStatus` reports rather than
   * this method throwing.
   */
  private protectedPositions(session: Session): readonly number[] {
    const position = protectedTaskRootPosition(session, this.taskRoots.get(session.id))
    return position === undefined ? [] : [position]
  }

  /**
   * Re-anchor a Basic-selected range so it cannot swallow a resident task root.
   *
   * The emergency rebase calls Basic's `selectCompactableRange` from EF's own code, so this is
   * the one place a Basic-selected span can be adjusted without touching Basic. The start moves
   * RIGHT past the guard and then on to the nearest balanced edge, because a span that begins on
   * a tool result whose call it excludes is the pairing violation the selectors exist to avoid.
   *
   * @returns the adjusted range, the original when nothing was in the way, or `null` when no
   *   balanced start remains inside the range.
   */
  private avoidTaskRoot(
    session: Session,
    range: { start: SessionSeq; end: SessionSeq } | null,
  ): { start: SessionSeq; end: SessionSeq } | null {
    if (range === null) return null
    const protectedPositions = this.protectedPositions(session)
    if (protectedPositions.length === 0) return range
    const nodes = session.surface.nodes
    const startIdx = nodes.indexOf(range.start)
    const endIdx = nodes.indexOf(range.end)
    if (startIdx < 0 || endIdx < 0) return range
    const guard = Math.max(
      ...protectedPositions.filter(position => position >= startIdx && position <= endIdx),
      -1,
    )
    if (guard < 0) return range
    let next = guard + 1
    while (next <= endIdx && !toolPairingBalancedBefore(session, nodes[next]!)) next += 1
    if (next > endIdx) return null
    return { start: nodes[next]!, end: range.end }
  }

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
      case 'leaf':
      case 'root':
      case 'emergency':
        recordFold(this.telemetry, candidate.mode)
        break
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
    const [agent, signal, sourceCommandId] = args
    // A host-declared root changes WHICH span a root fold may take. With no
    // registration this branch does not run and the pre-existing path is used byte for
    // byte, so a session that never declared a task root behaves exactly as before.
    const guard = this.protectedRootGuard(agent.session)
    if (guard.status === 'refused') {
      // The root is REGISTERED and the protection cannot be honoured. Folding anyway would
      // silently break the residency the host was promised, so the fold is declined and the
      // reason is recorded. `clearActiveTaskRoot` restores ordinary root compaction.
      this.refusedRootReason = guard.reason
      this.ctx.logger.warn(
        `[epistemic-fold] root fold declined: ${guard.reason} for the registered active task root`,
      )
      return null
    }
    if (guard.status === 'protected') {
      this.refusedRootReason = undefined
      return this.protectedRootFold(agent, signal, sourceCommandId)
    }
    this.refusedRootReason = undefined
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
        this.telemetry.rootRebaseAdvice = undefined
      }
      return result
    } finally {
      this.candidates.clear(agent.session)
    }
  }

  /** Why the last root fold was DECLINED to protect a registered root, or `undefined`. */
  private refusedRootReason: string | undefined

  /**
   * Why the last root fold was declined, or `undefined` when none was.
   *
   * A declined root fold returns `null`, which is also what "nothing to compact" returns.
   * Those are different facts and a caller reading only the return value cannot tell them
   * apart, so the reason is published here as well.
   */
  get lastRootRefusal(): string | undefined {
    return this.refusedRootReason
  }

  /**
   * Whether a root fold may protect a registered task root, and if not, why not.
   *
   * `none` is the ordinary case -- no host ever declared a root -- and it must stay the
   * common one: this returns `none` without touching the surface for every session that
   * never registered, which is what keeps the default path unchanged.
   *
   * `refused` covers a root that is registered but cannot be honoured. A NON-PREFIX root is
   * the case the contract names: `[Task A][CP1][history][Task B]` cannot be protected by
   * excluding one contiguous span, because Task B sits after a frozen checkpoint, and this
   * round does not re-order the surface. Folding anyway would break the frontier promise, so
   * the fold is declined instead.
   */
  private protectedRootGuard(session: Session):
    | { readonly status: 'none' }
    | { readonly status: 'protected'; readonly position: number }
    | { readonly status: 'refused'; readonly reason: string } {
    const ref = this.taskRoots.get(session.id)
    if (ref === undefined) return { status: 'none' }
    const position = protectedTaskRootPosition(session, ref)
    if (position === undefined) {
      const event = session.eventAt(ref.sourceSeq)
      const message = event === undefined ? null : session.deriveEventMessage(event)
      return {
        status: 'refused',
        reason: message === null
          ? 'source-not-on-surface'
          : message.role !== 'user'
            ? 'not-a-user-message'
            : taskRootDigest(message) !== ref.sourceDigest ? 'digest-mismatch' : 'source-not-on-surface',
      }
    }
    const firstFrozen = locateFoldFrontier(session).frozen[0]
    if (firstFrozen !== undefined && firstFrozen.position < position) {
      return { status: 'refused', reason: 'unsupported-nonprefix' }
    }
    return { status: 'protected', position }
  }

  /**
   * The dependencies `compactSurfaceRegion` needs, built from this engine.
   *
   * `BasicCompactionEngine.regionDependencies()` is private, so the four members are named
   * here explicitly rather than reached for. Every one of them is reachable from this
   * subclass, and two of them are EF's OWN overrides -- `summarize` and `frameCheckpoint` --
   * so a protected root keeps the EF summarization path and the EF checkpoint framing rather
   * than bypassing them.
   */
  private rootRegionDependencies(): Parameters<typeof compactSurfaceRegion>[0] {
    return {
      meter: this.ctx.tokenMeter,
      summarize: (input, owner, abort) => this.summarize(input, owner, abort),
      recover: (error, agent, sourceEventSeqs, signal) => this.ctx.waterfall('compaction/summary-error', {
        session: agent.session,
        sourceEventSeqs,
        error,
        ...signal === undefined ? {} : { signal },
      }, () => false),
      frameCheckpoint: (summary, agent) => this.frameCheckpoint(summary, agent),
    }
  }

  /**
   * One ROOT fold whose span excludes the resident active task root.
   *
   * ## Why this calls the exported transaction instead of `super.compactNow`
   *
   * `BasicCompactionEngine.compactNow` selects its own range and calls
   * `compactSurfaceRegion` directly, so neither EF's `compactRegion` override nor any
   * exclusion EF adds can reach it. `compactSurfaceRegion` is EXPORTED, so EF can supply the
   * span itself and keep Basic's transaction -- region validation, the compaction lock, the
   * `compaction/start`+`compaction/end` pair, the shrink check, the flush-failure path and
   * the cancellation precedence -- instead of reimplementing any of it.
   *
   * The idle bracket is the real `agent.runMaintenance`, and the error mapping mirrors
   * Basic's: an abort the agent itself requested is `cancelled`, anything else is `busy`.
   *
   * @returns the committed result, or `null` when no safe range exists past the root.
   */
  private async protectedRootFold(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId: Parameters<BasicCompactionEngine['compactNow']>[2],
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      return await agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          // A FRESH measurement: the span is chosen from the surface as it is now, not as it
          // was when the command was issued.
          const measurement = this.ctx.tokenMeter.measure(agent.session)
          const range = this.avoidTaskRoot(
            agent.session, selectCompactableRange(agent.session, measurement, 0),
          )
          if (range === null) return null
          // EXPLICIT start/end. Without them the bundle's seq list would fall back to the
          // pre-existing "the folded span is a prefix of the surface" assumption, which this
          // span deliberately is NOT -- the task root precedes it and was not folded.
          const candidate = createFoldCandidate({
            mode: 'root',
            session: agent.session,
            start: range.start,
            end: range.end,
          })
          this.candidates.prepare(agent.session, candidate)
          try {
            const result = await compactSurfaceRegion(
              this.rootRegionDependencies(),
              agent.session,
              range.start,
              range.end,
              agent,
              {
                owner: null,
                stability: 'selected-span',
                ...sourceCommandId === undefined ? {} : { sourceCommandId },
                flush: async () => { await this.ctx.sessions.flush(agent.session) },
              },
              operationSignal,
            )
            // ONE commit record, ONE counter increment, exactly as the delegating path.
            await this.recordCommit(candidate, result)
            this.stepsSinceRootRebase = 0
            this.rebaseIntents.clear(agent.session)
            this.telemetry.rootRebaseAdvice = undefined
            return result
          } finally {
            this.candidates.clear(agent.session)
          }
        } catch (error) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError('cancelled', 'manual compaction was cancelled', { cause: error })
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error) {
      throw new ManualCompactionError(
        'busy',
        'manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
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
  /**
   * Why the most recent `compactIfNeeded` declined, or null when it did not.
   *
   * Added 2026-10-17 because four different preconditions return the same `null` from this method
   * (src/fold/engine.ts:1063,1085,1135,1196), and a caller that declines a fold could not tell a full
   * surface from an empty measurement. It is TELEMETRY and not a log line: the first attempt at
   * this recorded the reason through `ctx.logger`, which in the bridge writes nowhere the harness
   * reads -- two instrumented runs produced zero output and looked like two non-events.
   */
  lastLeafDecision: string | null = null


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
    // ## A sentinel, so a stale field cannot read as a live decision
    //
    // Measured 2026-10-17: the memory bench's 20 refusals all reported `below-threshold
    // 65192<129024` while the host measured 1,260,340 on the same session at the same instant.
    // That value could only be stale -- written by the earlier fold-to-depth -- so the batch-loop
    // call was returning somewhere that writes nothing. This sentinel makes the entry point
    // visible, and every exit overwrites it, so a value of 'entered' means the call fell out
    // through a path with no verdict recorded.
    this.lastLeafDecision = 'entered basic=' + this.isBasic()
    if (this.isBasic()) return super.compactIfNeeded(agent, trigger, signal)
    const target = routedTarget(agent.session)
    // Named 2026-10-17: this is the FIRST early return, before the threshold check, and it was
    // the one the memory bench's 20 refusals actually took. `lastLeafDecision` kept the value
    // written by the earlier fold-to-depth, so the artifact reported a threshold decline
    // (65192 < 129024) that had not been evaluated at all on those calls -- a stale field read as
    // a live decision.
    if (target === undefined) { this.lastLeafDecision = 'no-routed-target'; return null }
    const meter = this.ctx.tokenMeter
    let measurement: TokenMeasurement = meter.measure(agent.session)
    const prune = this.ctx.get('toolResultPruner')

    if (trigger === 'context-overflow') {
      this.lastLeafDecision = 'context-overflow'
      return this.recoverFromOverflow(agent, measurement, meter, prune, signal)
    }

    this.assertNoActiveCompaction(agent.session)
    const resolved = await this.resolveSpecFor(agent, signal)
    if (!('spec' in resolved)) throw new Error(noContextCapacityMessage(resolved.key ?? ''))
    const { contextWindow, reserved, spec } = resolved
    this.triggers.report({
      target,
      contextWindow,
      reserved,
      config: this.efConfig,
      log: line => this.ctx.logger.info(line),
    })
    this.telemetry.thresholdTokens = spec.thresholdTokens
    this.lastLeafDecision = 'spec-resolved retries=' + spec.compactionRetries
    this.telemetry.compactSpec = spec
    if (measurement.totalTokens < spec.thresholdTokens) { this.lastLeafDecision = 'below-threshold ' + measurement.totalTokens + '<' + spec.thresholdTokens; return null }

    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    if (measurement.totalTokens < spec.thresholdTokens) { this.lastLeafDecision = 'below-threshold-after-prune ' + measurement.totalTokens; return null }

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
        // The SAME exclusion the executor applies. A decider that priced a span containing
        // the task root while the fold excluded it would authorize work it cannot do.
        protectedPositions: this.protectedPositions(agent.session),
      })
      this.telemetry.leafAdmission = admissionVerdict
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
    this.telemetry.pressureRegime = regime
    if (regime === 'frozen-bound') {
      // STRUCTURAL handoff: economics has no vote. A frozen-bound surface has
      // been shown to defeat every leaf, so a rebase is the only remaining
      // mechanism and refusing it would mean choosing non-convergence.
      this.lastLeafDecision = 'frozen-bound'
      return this.handOffFrozenBound(agent, measurement, spec)
    }

    if (admissionVerdict !== undefined && !admissionVerdict.admitted) {
      this.lastLeafDecision = 'economic-refusal ' + JSON.stringify(admissionVerdict).slice(0, 240)
      // Recorded 2026-10-17: this refusal and its rebase handoff were the last return point
      // between the threshold check and span selection, and the memory bench's 20 refusals
      // (folds 1, roots 0, compactionFailures 0, committed false) could only have come from
      // here. A refusal whose handoff also declines is a surface that grows without bound.
      this.ctx.logger.warn(
        '[epistemic-fold] leaf refused on economics: '
        + `admitted=${admissionVerdict.admitted} `
        + `totalTokens=${measurement.totalTokens} threshold=${spec.thresholdTokens} `
        + `reclaim=${JSON.stringify(admissionVerdict.reclaim ?? null)} `
        + `reason=${admissionVerdict.reason ?? ''}`,
      )
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

    // ## Reachability pre-flight — before spending a SECOND summarization call
    //
    // Computed here, before the loop, so its verdict is recorded even when the
    // first fold converges. What it gates is the RETRY, not the first fold: a
    // single fold is legitimate even when it cannot reach the threshold, because
    // it still reduces pressure and — load-bearing — it grows the frozen prefix,
    // which is the only mechanism that eventually hands off to a rebase. Gating
    // the first fold instead would freeze the prefix and make `frozen-bound`
    // unreachable, which is a worse bug than the one being fixed.
    //
    // What it prevents is the observed thrash: folding, failing to reach, folding
    // again, and throwing a message that named none of the arithmetic. The Phase 7
    // two-pass run hit that reproducibly at 53K and 68K against a 16K threshold.
    //
    // Escalating to a rebase does not rescue it, which is why the fix is "stop and
    // say why" rather than "try the other mechanism": `selectCompactableRange`
    // walks from the tail and breaks on the first iteration at `retainTokens = 0`,
    // so the last node is retained at every setting and a single node larger than
    // the threshold is un-foldable by construction. Measured on a 66K surface
    // whose last node was a 60K tool result: leaf and rebase both folded 6096
    // tokens and both retained 60020; an emergency rebase committed and left 60136.
    const reach = assessFoldReachability({
      session: agent.session,
      measurement,
      thresholdTokens: spec.thresholdTokens,
      retainTokens: spec.retainTokens,
      protectedPositions: this.protectedPositions(agent.session),
    })
    this.telemetry.foldReachability = reach

    let result: CompactionResult | null = null
    let previousTokens = measurement.totalTokens
    // Counted rather than derived: the message below used to report
    // `spec.compactionRetries + 1`, a CONSTANT, so it claimed two attempts after
    // one committed fold and a reader could not tell how much work was done.
    let committed = 0
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      let span: ReturnType<typeof selectLeafSpan>
      try {
        span = selectLeafSpan(
          agent.session, measurement, spec.retainTokens, undefined, this.protectedPositions(agent.session),
        )
      } catch (error: unknown) {
        // ## The throw that twenty refusals actually took
        //
        // `selectLeafSpan` throws when the token meter's surface and the session's surface have
        // diverged (src/fold/leaf-policy.ts:48-51), and that throw was classified `other` because its
        // message carries no error code -- so twenty compaction failures looked like twenty
        // unrelated faults. Named here so the next reader does not have to bisect to find it.
        this.lastLeafDecision = 'span-threw: ' + (error instanceof Error ? error.message : String(error)).slice(0, 200)
        throw error
      }
      if (span === null) {
        this.lastLeafDecision = 'no-span pricedNodes=' + measurement.nodes.length
          + ' surfaceNodes=' + agent.session.surface.nodes.length
          + ' firstOpen=' + locateFoldFrontier(agent.session).firstOpenPosition
          + ' retain=' + spec.retainTokens + ' total=' + measurement.totalTokens
        // ## Say WHICH precondition failed, because four of them return the same null
        //
        // `selectLeafSpan` (src/fold/leaf-policy.ts:47,61,72) returns null for an empty priced
        // node list, a frontier already at the surface end, or no room between the retained
        // tail and the frontier. All three reach here as `null`, so a caller that declines a
        // fold cannot tell a full surface from an empty measurement -- and neither could a
        // reader of the result. Measured 2026-10-17: the memory bench asked for a fold after
        // every probe batch and all 20 returned `committed: false` with the session at
        // 3,330,304 tokens against a 61,931 retain budget, which excludes two of the three
        // causes and left the third indistinguishable from a metering failure.
        this.ctx.logger.warn(
          '[epistemic-fold] leaf span unavailable: '
          + `pricedNodes=${measurement.nodes.length} `
          + `surfaceNodes=${agent.session.surface.nodes.length} `
          + `frontierFirstOpen=${locateFoldFrontier(agent.session).firstOpenPosition} `
          + `frozenCount=${locateFoldFrontier(agent.session).frozenCount} `
          + `contiguous=${locateFoldFrontier(agent.session).frozenPrefixContiguous} `
          + `retainTokens=${spec.retainTokens} totalTokens=${measurement.totalTokens} `
          + `protected=${this.protectedPositions(agent.session).length}`,
        )
        if (result === null) return null
        break
      }
      result = await this.compactRegion(span.start, span.end, agent, signal)
      const _after = meter.measure(agent.session)
      this.lastLeafDecision = 'fold-attempted span=' + span.start + '..' + span.end
        + ' resultNull=' + (result === null)
        + ' tokensBefore=' + measurement.totalTokens + ' tokensAfter=' + _after.totalTokens
      committed += 1
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
      this.telemetry.postLeafRegime = afterRegime
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

      // ## The reachability guard — a retry that cannot reach the threshold
      //
      // Checked AFTER a fold and BEFORE the next one, which is the only placement
      // that is both correct and useful. A first fold is always legitimate: it
      // reduces pressure, and it grows the frozen prefix, which is what eventually
      // makes `frozen-bound` reachable and hands the surface to a rebase. Gating
      // the FIRST fold instead would freeze the prefix and make that handoff
      // unreachable — a worse bug than the thrash being prevented (measured: a
      // 14-step workload stopped folding at step 8 and never reached
      // frozen-bound, so the I1 gates became untestable).
      //
      // Recomputed from the CURRENT measurement, not the pre-loop one: the fold
      // just committed changed both the total and the span, and a stale reading
      // would answer a question about a surface that no longer exists.
      //
      // What must not happen is the retry: the observed failure folded, did not
      // reach the threshold, folded again, and threw a message naming none of the
      // arithmetic. If the widest legal span cannot reach the threshold, the
      // second fold cannot either — the surface is a fixpoint of this action.
      const afterFold = assessFoldReachability({
        session: agent.session,
        measurement,
        thresholdTokens: spec.thresholdTokens,
        retainTokens: spec.retainTokens,
        protectedPositions: this.protectedPositions(agent.session),
      })
      this.telemetry.foldReachability = afterFold
      if (!afterFold.canReachThreshold) {
        this.ctx.logger.warn(
          `[epistemic-fold] after ${committed} committed leaf fold(s), no further fold can reach `
          + `the threshold — ${describeFoldReachability(afterFold)}. Stopping rather than retrying; `
          + 'a rebase cannot help either, because it retains the same tail.',
        )
        return result
      }
    }

    // The count is REAL, and the arithmetic is included.
    //
    // This message used to say "after ${spec.compactionRetries + 1} leaf fold
    // attempts" — a constant, so it read as "the summary succeeded, twice" even
    // when the loop had `break`-ed on a null span after a single committed fold.
    // Phase 7's report cited that sentence as evidence; it could not support it.
    // `committed` is what actually landed, and the reachability line lets a reader
    // check whether the remaining pressure was ever foldable.
    const stalled = new Error(
      `epistemic-fold: still above threshold after ${committed} committed leaf fold(s) `
      + `(${describeFoldReachability(assessFoldReachability({
        session: agent.session,
        measurement,
        thresholdTokens: spec.thresholdTokens,
        retainTokens: spec.retainTokens,
        protectedPositions: this.protectedPositions(agent.session),
      }))})`,
    ) as Error & { code?: string }
    stalled.code = 'PRESSURE_UNRESOLVED'
    throw stalled
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
    measurement: TokenMeasurement,
    meter: { measure(session: Session): TokenMeasurement },
    prune: { pruneSession(session: Session): void } | undefined,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    this.assertNoActiveCompaction(agent.session)
    // Fail closed on an unknown capacity, exactly as the pressure path does. A
    // leaf could be attempted without knowing the hard bound, but "we cannot
    // tell whether this can possibly work" is not a reason to guess — and the
    // provider has already told us the surface does not fit.
    const resolved = await this.resolveSpecFor(agent, signal)
    if (!('spec' in resolved)) throw new Error(noContextCapacityMessage(resolved.key ?? ''))
    const spec = resolved.spec
    this.telemetry.thresholdTokens = spec.thresholdTokens
    this.telemetry.compactSpec = spec
    const breakdown = pressureBreakdown(agent.session, measurement, spec.thresholdTokens)
    // Recorded even though this path decides on the HARD capacity: leaving the
    // field untouched would report whatever a previous pressure call happened to
    // set, which is a stale reading presented as current telemetry.
    this.telemetry.pressureRegime = classifyPressureRegime(breakdown)
    const capacity = classifyCapacityRegime(breakdown, spec.hardCapacityTokens)
    this.telemetry.capacityRegime = capacity

    // A leaf is only worth attempting when the OPEN trajectory is what overflows.
    // When the frozen prefix alone is over the hard capacity, folding more of the
    // tail appends another checkpoint to that prefix and the retry overflows
    // again — the loop this path exists to break.
    if (capacity !== 'frozen-bound') {
      const span = selectLeafSpan(agent.session, measurement, 0, undefined, this.protectedPositions(agent.session))
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
    const finalBreakdown = pressureBreakdown(agent.session, final, spec.thresholdTokens)
    if (classifyCapacityRegime(finalBreakdown, spec.hardCapacityTokens) !== 'fits') {
      // Explicit non-convergence: the provider has refused this surface, a leaf
      // could not help, and a rebase did not fit it either. Retrying would loop,
      // so fail with the diagnosis rather than let the caller retry blind.
      throw new Error(
        `epistemic-fold: cannot fit the provider's context window after overflow recovery `
        + `(${final.totalTokens} estimated tokens >= hard capacity ${spec.hardCapacityTokens}; `
        + `frozen prefix ${finalBreakdown.frozenTokens} `
        + `across ${finalBreakdown.frozenCount} checkpoint(s); `
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
    const range = this.avoidTaskRoot(agent.session, selectCompactableRange(agent.session, measurement, 0))
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
      this.telemetry.rootRebaseAdvice = undefined
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
    this.telemetry.rebaseDecision = decision
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
    this.telemetry.rootRebaseAdvice = advice
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
    if (this.isBasic()) return await this.summarizeWithTruncationRetry(input, agent, signal)
    const session = agent.session
    const candidate = this.candidates.get(session)
    if (candidate === undefined) {
      // Every engine entry point (leaf compactRegion, root compactNow)
      // prepares its candidate explicitly; reaching the hook without one
      // means an unsanctioned caller and fails loud.
      throw new Error('epistemic-fold: summarize reached without a prepared fold candidate')
    }
    const { contextPrefix, shadowedMessages: rawShadowed } = splitSummarizationInput(input)
    // ## A derived retrieval answer is retired at the fold, not carried into the next round
    //
    // A subagent answer is a PARAPHRASE of material that is archived elsewhere, and it is
    // regenerable by asking again. Archiving it would put a paraphrase into the main tree
    // wearing a `tool/result` kind -- an AUTHORITATIVE kind -- after which a later reader
    // cannot tell it from history. So its CONTENT is retired here.
    //
    // The length is preserved deliberately. `currentSpanSeqs` below THROWS when the span
    // derives a different number of messages than the archive holds, and that throw ends the
    // episode -- so dropping the message would convert a provenance problem into a lost run.
    // The tombstone keeps the count, the seqs and the refs, and retires only the content.
    const retirement = retireDerivedAnswers(rawShadowed)
    const shadowedMessages = retirement.messages
    if (retirement.retired > 0) {
      this.telemetry.derivedAnswersRetired += retirement.retired
      this.ctx.logger.info(
        `[epistemic-fold] retired ${retirement.retired} derived retrieval answer(s) at fold time`,
      )
    }
    // The summarizer must not read a paraphrase either, so the semantic path gets the
    // retired span. Everything else about the input is unchanged.
    const summarizationInput: SummarizationInput = retirement.retired === 0
      ? input
      : { ...input, messages: [...contextPrefix, ...shadowedMessages] }
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
      this.telemetry.bundleWrites += 1
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
        this.telemetry.rationaleAttempts += 1
        // The anchor count decides WHICH instruction the rationale gets: with anchors it
        // cites them by id; with none it is the only carrier and must preserve the facts.
        // Measured: anchors 0 made the old instruction forbid the only content that could
        // exist, leaving a 47-character marker. See rationaleInstruction().
        const anchorCount = machineAnchorCount(mountedState)
        // The span this fold replaces, for the output budget. Estimated from the shadowed
        // messages rather than taken from `measurement`, because the span has already been
        // removed from the surface by the time this hook runs. It only sizes a BUDGET, and
        // `rationaleOutputFor` clamps to [16_384, 32_768] -- NOT the [1024, 8192] this comment
        // claimed until 2026-10-19, which was wrong by a factor of sixteen and made the budget
        // look four times tighter than it is. Inside our span range the estimate cannot move the
        // cap at all: every fold from 119K to 749K gets the 16,384 floor. The comment is corrected
        // rather than deleted because the argument it makes still holds -- a 2x error in the
        // estimate cannot turn a workable budget into a tripwire.
        const foldSpanTokens = estimateSpanTokens(summarizationInput.messages)
        try {
          const rationale = await rationaleOnly({
            ctx: this.ctx,
            target: conversationTarget(agent) ?? { provider: 'unrouted', model: 'unrouted' },
            maxTokens: rationaleOutputFor(foldSpanTokens),
            anchorCount,
            hintTokens: this.efConfig.rationaleHintTokens,
            input: summarizationInput,
            agent,
            signal,
          })
          semanticText = rationale.text
          this.telemetry.rationaleChars = rationale.text.length
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
          // Recorded rather than only swallowed: a discarded rationale leaves a checkpoint
          // identical to `semanticMode: 'none'`, and before this counter existed the artifact
          // could not tell the two apart. See `rationaleAttempts` in fold-telemetry.ts.
          this.telemetry.rationaleFailures += 1
          // ## BOTH the code and the message, because `code ?? message` discarded the reason
          //
          // Measured 2026-10-19: four of five economy cells at a 252K window recorded
          // `rationaleFailureReason: "LIVE_HTTP"` and nothing else -- no status, no provider
          // words. `lastProviderError` was separately null, because the rationale call runs
          // inside the engine and never passes through the host's `modelTurn`, which is the
          // only writer of that field. So an artifact could say THAT the digest failed and
          // never WHY, and a failure that removes the whole checkpoint read as a low score.
          //
          // `code` is still first because it is the stable, greppable half; the message is
          // appended rather than replaced so neither can hide the other.
          this.telemetry.rationaleFailureReason = error instanceof Error
            ? (() => {
                const code = (error as Error & { code?: string }).code
                return code === undefined ? error.message : code + ": " + error.message
              })()
            : String(error)
          semanticText = undefined
        }
      }
      // semanticMode 'none': no LLM call at all — zero-LLM profile.
    } else {
      // Legacy (no projection mounted): Basic's own full-checkpoint summary
      // IS the checkpoint body — the correct prompt for that shape.
      try {
        const semantic = await this.summarizeWithTruncationRetry(input, agent, signal)
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
   * Summarize, retrying when the provider truncated the checkpoint at the token cap.
   *
   * ## The first attempt is `super.summarize`, unmodified
   *
   * The success path must stay byte-identical to native Basic — that is what
   * `mode: basic` is for — and the common case IS the success path. So attempt zero is
   * Basic's own call. Only a RETRY goes through EF's own invocation of
   * `summarizeWithLlm`, because a raised budget is the one thing Basic's own call
   * cannot express: it asks for the same budget again.
   *
   * ## Every arm gets this, deliberately
   *
   * A truncation is a property of the provider/model interaction, not of a compaction
   * strategy, so `mode: basic` reaching this method means the `basic` arm of a
   * comparison retries exactly as an EF arm does. The alternative — retrying only the
   * EF arms — would credit them for surviving a provider artefact. The cost is that
   * `mode: basic` is no longer indistinguishable from native Basic on this one failure
   * path; the checkpoint it produces when it succeeds is unchanged, and
   * `tests/rc7-basic-parity.spec.ts` pins that.
   *
   * ## Failure stays fail-closed
   *
   * Every attempt truncating still throws, so a half-written checkpoint never lands as
   * if it were complete. `summaryRetryStats` records how often a retry is what saved
   * the fold, which is what distinguishes \"no truncation happened\" from \"retries
   * absorbed it\" after the run.
   * @param input - replayed conversation prefix to condense.
   * @param agent - supplies the routed target whose policy sets the base budget.
   * @param signal - live turn cancellation; an aborted call is never retried.
   * @returns the first attempt's summary, or a retry's.
   */
  private async summarizeWithTruncationRetry(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    // Resolved the way Basic's own `summarize` resolves it, so a per-target
    // `maxTokens` override escalates from the override rather than from the service
    // default. EF's `conversationTarget` is byte-equivalent to the vendored one.
    const target = conversationTarget(agent)
    const policy: ResolvedConfig | ResolvedTargetPolicy = target === undefined
      ? this.config
      : resolveTargetPolicy(this.config, target)
    const { extraAttempts, ceiling } = summaryRetryPolicy()

    for (let attempt = 0; ; attempt += 1) {
      const budget = summaryRetryBudget(policy.maxTokens, attempt, ceiling)
      summaryRetryStats.attempts += 1
      try {
        return attempt === 0
          ? await super.summarize(input, agent, signal)
          : await summarizeWithLlm(this.ctx, { ...policy, maxTokens: budget }, input, agent, signal)
      } catch (error: unknown) {
        // A cancelled fold is not a provider fault and must not be retried: the
        // deadline that aborted it is still running, so a retry would spend the
        // remaining budget on a call nobody is waiting for.
        if (signal?.aborted === true) throw error
        if (!isTruncationFailure(error)) throw error
        summaryRetryStats.lastError = error instanceof Error ? error.message : String(error)
        if (attempt >= extraAttempts) {
          summaryRetryStats.exhausted += 1
          throw error
        }
        const next = summaryRetryBudget(policy.maxTokens, attempt + 1, ceiling)
        summaryRetryStats.retries += 1
        if (next > policy.maxTokens) summaryRetryStats.escalations += 1
      }
    }
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
