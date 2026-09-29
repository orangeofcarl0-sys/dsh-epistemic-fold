/**
 * Paired-baseline benchmark harness (R0-C, test spec §8/§12/§28): identical
 * conversation history driven through two compaction arms — DSH Basic and
 * Epistemic Fold — recording three layers of economics.
 *
 * Layer 1 — Architecture locality (per step):
 *   firstMutationPosition    first model-history node differing from the
 *                            previous step
 *   invalidatedSuffixTokens  tokens the PREVIOUS request had already priced
 *                            (cache-warm) that this request can no longer reuse
 *   stablePrefixTokens       tokens that DID survive from the previous request
 *
 * Layer 2 — Context efficiency:
 *   promptTokens per step; reclaimed tokens per fold; frozen-checkpoint load
 *   (the recurring price frozen prefixes charge every later request).
 *
 * Layer 3 — Cache-adjusted cost:
 *   C_ρ = Σ missTokens + ρ · Σ hitTokens across the run, reported for
 *   ρ ∈ {0, 0.1, 0.2, 0.5, 1} — the break-even curve answering "at what cache
 *   discount does EF beat Basic?" without hardcoding any provider pricing.
 *
 * The prefix-mutation RATIO (PMA = absolutePrefixInvalidation / reclaimed) is
 * reported per arm as a SEPARATE field; the cross-arm gate is on ABSOLUTE
 * prefix invalidation — the two claims differ and must not be conflated
 * (R0-C metric correction).
 *
 * Step shape: [rebase window — turns CLOSED] → [grow: open turn, append] →
 * [automatic pressure fold — needs the open turn] → close turn happens in the
 * NEXT step's rebase window. growTurn opens one turn per step and leaves it
 * open; the rebase hook closes it before any root fold and reopens a fresh
 * turn afterwards.
 *
 * No live model is needed: the semantic face is deterministic (harness
 * adapter), so the measurement isolates the prefix architecture.
 *
 * @module bench/paired-baseline
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { sha256Hex } from '../src/hash.ts'
import {
  frozenSummary as summarizeFrozen,
  invalidatedSuffixTokens as istMetric,
  promptExposure,
  sharedPrefixTokens as sptMetric,
} from '../eval/src/metrics.ts'
import type { FrozenSummary, PromptExposure } from '../eval/src/metrics.ts'
import { attributeTokens } from '../eval/src/token-attribution.ts'
import type { RunAttribution, TokenAttribution } from '../eval/src/token-attribution.ts'
import { summarizeAttribution } from '../eval/src/token-attribution.ts'
import { classifyPressureRegime, pressureBreakdown, summarizePressureHistory } from '../src/pressure.ts'
import type { PressureHistory, PressureSample } from '../src/pressure.ts'
import type { Harness } from '../tests/harness.ts'

const BENCH_SIGNAL = new AbortController().signal
const BENCH_AGENT_OPTIONS = { provider: 'test-model', model: 'test-model' }

/** Model-history fingerprint of one surface snapshot: per-node digests. */
function historyDigests(session: Session): string[] {
  return [...session.surface.nodes].map(seq =>
    sha256Hex(JSON.stringify(session.deriveEventMessage(session.eventAt(seq)!))),
  )
}

/** First index where the current history diverges from the previous one. */
export function firstMutationPosition(previous: readonly string[], current: readonly string[]): number {
  const shared = Math.min(previous.length, current.length)
  for (let index = 0; index < shared; index += 1) {
    if (previous[index] !== current[index]) return index
  }
  return Math.min(previous.length, current.length)
}

/** Node token prices of one measurement, in surface order. */
function nodeTokens(measurement: { nodes: readonly { tokens: number }[] }): number[] {
  return measurement.nodes.map(node => node.tokens)
}

export interface StepSample {
  readonly step: number
  readonly promptTokens: number
  readonly firstMutationPosition: number
  /** Cache-warm tokens from the previous request that this request lost. */
  readonly invalidatedSuffixTokens: number
  /** Tokens that survived from the previous request (cache hits). */
  readonly stablePrefixTokens: number
  /** Tokens of history appended this step (fresh cache misses by definition). */
  readonly appendedTokens: number
  /** Frozen-checkpoint token load after the step (EF arm only; Basic: 0). */
  readonly checkpointLoad: number
  /**
   * Surface pressure BEFORE this step's fold ran, measured after `grow`
   * (R4-C). This is the pre-fold high-water mark: the surface the arm was
   * willing to let build up before reducing it.
   */
  readonly preFoldTokens: number
}

/**
 * The three peaks that R4-C requires be distinguished, because a single
 * "PeakContext" number conflated them and produced a wrong explanation in R3.
 *
 * `main` is the one that matters as a product risk: it is what actually goes
 * into the primary model request, so it is what can hit the context window.
 * `compaction` is the auxiliary summarizer/rationale request peak, which is
 * charged to the same budget but is not the user's request. `surface` is the
 * internal session-surface high-water mark, which includes the pre-fold
 * build-up a `main` peak can hide.
 */
export interface PeakBreakdown {
  /** Peak prompt tokens actually sent to the primary model. */
  readonly mainRequestPeak: number
  /**
   * Peak tokens of an auxiliary (compaction) request. `0` when the arm made no
   * auxiliary call or the harness did not observe one.
   */
  readonly compactionRequestPeak: number
  /** Peak surface pressure observed at any point, including pre-fold. */
  readonly surfacePeak: number
  /** Peak post-fold prompt tokens — the `main` peak measured after reduction. */
  readonly postFoldPeak: number
  /** Mean of `preFoldTokens - promptTokens`: how much a fold removed, on average. */
  readonly meanFoldReclaim: number
}

/** Cache-adjusted cost for one discount factor: C_ρ = miss + ρ · hit. */
export interface CacheCostPoint {
  readonly rho: number
  readonly hitTokens: number
  readonly missTokens: number
  readonly cost: number
}

/** Auxiliary compaction accounting from durable `compaction/summary` events. */
export interface AuxiliaryCompactionSummary {
  readonly callCount: number
  /** Provider-reported usage when the semantic call emitted one. */
  readonly inputTokens?: number
  readonly outputTokens?: number
}

export interface BaselineResult {
  readonly arm: string
  readonly samples: readonly StepSample[]
  /** Layer-1 gate metric: Σ invalidatedSuffixTokens (lower is better). */
  readonly absolutePrefixInvalidation: number
  /** Σ stablePrefixTokens — total prefix reuse across the run. */
  readonly stablePrefixTokensTotal: number
  /** The prefix-mutation RATIO: absolutePrefixInvalidation / reclaimed. */
  readonly prefixMutationRatio: number
  readonly reclaimedTokensTotal: number
  readonly leafFoldCount: number
  readonly rootFoldCount: number
  /** Frozen-checkpoint token load at the END of the run (recurring cost). */
  readonly finalCheckpointLoad: number
  readonly promptSummary: PromptExposure
  readonly frozenSummary: FrozenSummary
  /** Auxiliary compaction accounting (R0-C0 §5.4). */
  readonly auxiliaryCompaction: AuxiliaryCompactionSummary
  /** Layer-3 break-even curve. */
  readonly cacheEconomics: readonly CacheCostPoint[]
  /** R1-A token source attribution across the run (per step + bucket totals). */
  readonly attribution: RunAttribution
  /** R2-A pressure regime history (frozen/open split, fold-every-step flag). */
  readonly pressure: PressureHistory
  /** R4-C: the three peaks, kept separate instead of one conflated number. */
  readonly peaks: PeakBreakdown
  /** The pressure threshold in force, or 0 when no routed spec was resolved. */
  readonly thresholdTokens: number
}

interface BenchEngine {
  compactIfNeeded(agent: Agent, trigger: 'pressure', signal: AbortSignal): Promise<unknown>
}

/**
 * Run one arm over a growing conversation. `grow` appends one unit of new
 * history per step (inside a turn it opens and leaves open for the pressure
 * fold). Each step: close the previous turn → optional rebase window (root
 * folds need no open turn) → grow → automatic pressure fold.
 */
export async function runPairedBaseline(options: {
  arm: string
  harness: Harness
  /** Fresh, IDENTICAL starting history for each arm (same fixture shape). */
  createSession: () => Session
  steps: number
  grow: (session: Session, step: number) => void
  /**
   * Optional idle rebase hook, invoked each step with the turn CLOSED
   * (manual root folds are only admissible with no open turn). Returns the
   * number of root folds executed.
   */
  rebase?: (session: Session) => Promise<number>
  signal?: AbortSignal | undefined
}): Promise<BaselineResult> {
  const { harness, steps, grow } = options
  const signal = options.signal ?? BENCH_SIGNAL
  const session = options.createSession()
  const agent: Agent = { session, options: BENCH_AGENT_OPTIONS } as unknown as Agent
  const meter = harness.ctx.tokenMeter
  let virtualTurn = 1_000_000
  let turnOpen = false
  const closeTurn = (): void => {
    if (turnOpen) {
      session.append('turn/end', { turn: virtualTurn, reason: { kind: 'completed' } })
      turnOpen = false
    }
  }
  const openTurn = (): void => {
    if (!turnOpen) {
      virtualTurn += 1
      session.append('turn/start', { turn: virtualTurn })
      turnOpen = true
    }
  }
  const samples: StepSample[] = []
  const attributions: TokenAttribution[] = []
  const pressureSamples: PressureSample[] = []
  let previous = historyDigests(session)
  let previousMeasurement = meter.measure(session)
  let invalidatedTotal = 0
  let stableTotal = 0
  let reclaimedTotal = 0
  let leafFoldCount = 0
  let rootFoldCount = 0
  // R4-C peak telemetry: the pre-fold high-water mark and the auxiliary peak.
  let surfacePeak = 0
  let preFoldReclaimTotal = 0
  let preFoldSamples = 0

  for (let step = 1; step <= steps; step += 1) {
    // Rebase window: close the previous step's turn first — root folds are
    // only admissible with no open turn.
    closeTurn()
    if (options.rebase !== undefined) {
      rootFoldCount += await options.rebase(session)
    }
    // Reopen a turn: the grow append and the pressure leaf fold need one.
    openTurn()
    grow(session, step)
    const appendedStart = previousMeasurement.nodes.length
    let appendedTokens = 0
    const appendedMeasurement = meter.measure(session)
    for (let index = appendedStart; index < appendedMeasurement.nodes.length; index += 1) {
      appendedTokens += appendedMeasurement.nodes[index]?.tokens ?? 0
    }

    const beforeFolds = meter.measure(session).totalTokens
    // R4-C: the surface pressure the arm was willing to let build up BEFORE
    // reducing it. Recorded separately because R3's single "peak" number hid
    // this term and produced a wrong explanation of the peak gap.
    surfacePeak = Math.max(surfacePeak, beforeFolds)
    const engine = harness.engine as unknown as BenchEngine
    try {
      await engine.compactIfNeeded(agent, 'pressure', signal)
    } catch {
      // DSH's automatic path warns and continues when a fold cannot land
      // (e.g. the shrink check rejects a too-small span); mirror that here.
    }
    const afterTotal = meter.measure(session).totalTokens
    if (afterTotal < beforeFolds) {
      reclaimedTotal += beforeFolds - afterTotal
      leafFoldCount += 1
    }
    preFoldReclaimTotal += beforeFolds - afterTotal
    preFoldSamples += 1
    // Close the turn so the next rebase window starts from a clean state.
    closeTurn()

    const current = historyDigests(session)
    const measurement = meter.measure(session)
    const position = firstMutationPosition(previous, current)
    // Spec 09 §3: both IST and SPT are priced by the PREVIOUS request.
    const invalidated = istMetric(nodeTokens(previousMeasurement), position)
    const stable = sptMetric(nodeTokens(previousMeasurement), position)
    invalidatedTotal += invalidated
    stableTotal += stable

    let checkpointLoad = 0
    const engineAny = harness.engine as unknown as {
      efConfig?: { frozenCheckpointTokenBudget?: number }
      lastThresholdTokens?: number
    }
    if (engineAny.efConfig !== undefined) {
      const { frozenCheckpointLoad } = await import('../src/leaf-policy.ts')
      checkpointLoad = frozenCheckpointLoad(session, measurement).tokens
    }

    // R2-A: decompose this step's pressure against the threshold the engine
    // actually used, so the frozen/open regime is measured rather than guessed.
    const threshold = engineAny.lastThresholdTokens ?? 0
    if (threshold > 0 && engineAny.efConfig !== undefined) {
      const breakdown = pressureBreakdown(session, measurement, threshold)
      pressureSamples.push({
        step,
        regime: classifyPressureRegime(breakdown),
        frozenTokens: breakdown.frozenTokens,
        openTokens: breakdown.openTokens,
        totalTokens: breakdown.totalTokens,
      })
    }

    samples.push({
      step,
      promptTokens: measurement.totalTokens,
      firstMutationPosition: position,
      invalidatedSuffixTokens: invalidated,
      stablePrefixTokens: stable,
      appendedTokens,
      checkpointLoad,
      preFoldTokens: beforeFolds,
    })
    // R1-A: attribute this request's tokens by source. The measurement was
    // just taken against the current surface, so it cannot be stale.
    attributions.push(attributeTokens(session, measurement))
    previous = current
    previousMeasurement = measurement
  }

  const hitTokens = stableTotal
  const missTokens = invalidatedTotal + samples.reduce((total, sample) => total + sample.appendedTokens, 0)
  const cacheEconomics = [0, 0.1, 0.2, 0.5, 1].map(rho => ({
    rho,
    hitTokens,
    missTokens,
    cost: missTokens + rho * hitTokens,
  }))

  // Auxiliary compaction accounting: count durable compaction/summary events
  // and forward their provider-reported usage when present (R0-C0 §5.4).
  let auxCalls = 0
  let auxIn: number | undefined
  let auxOut: number | undefined
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq as never)!
    if (event.type !== 'compaction/summary') continue
    auxCalls += 1
    const usage = (event.data as { usage?: { input_tokens?: number; output_tokens?: number } }).usage
    if (usage !== undefined) {
      auxIn = (auxIn ?? 0) + (usage.input_tokens ?? 0)
      auxOut = (auxOut ?? 0) + (usage.output_tokens ?? 0)
    }
  }

  return {
    arm: options.arm,
    samples,
    absolutePrefixInvalidation: invalidatedTotal,
    stablePrefixTokensTotal: stableTotal,
    prefixMutationRatio: reclaimedTotal === 0 ? 0 : invalidatedTotal / reclaimedTotal,
    reclaimedTokensTotal: reclaimedTotal,
    leafFoldCount,
    rootFoldCount,
    finalCheckpointLoad: samples[samples.length - 1]?.checkpointLoad ?? 0,
    promptSummary: promptExposure(samples.map(sample => sample.promptTokens)),
    frozenSummary: summarizeFrozen(samples.map(sample => sample.checkpointLoad), samples.map(sample => sample.promptTokens)),
    auxiliaryCompaction: {
      callCount: auxCalls,
      ...(auxIn === undefined ? {} : { inputTokens: auxIn }),
      ...(auxOut === undefined ? {} : { outputTokens: auxOut }),
    },
    cacheEconomics,
    attribution: summarizeAttribution(attributions),
    pressure: summarizePressureHistory(pressureSamples),
    peaks: {
      // The post-fold prompt summary's peak IS the main-request peak: the
      // measurement is taken after the awaited fold, so what it prices is the
      // surface the model would actually be sent.
      mainRequestPeak: promptExposure(samples.map(sample => sample.promptTokens)).peakPromptTokens,
      // Auxiliary calls are charged to the same budget. The harness's scripted
      // adapter reports no usage, so this is 0 there and measured live.
      compactionRequestPeak: auxIn ?? 0,
      surfacePeak,
      postFoldPeak: promptExposure(samples.map(sample => sample.promptTokens)).peakPromptTokens,
      meanFoldReclaim: preFoldSamples === 0 ? 0 : preFoldReclaimTotal / preFoldSamples,
    },
    thresholdTokens: (harness.engine as unknown as { lastThresholdTokens?: number }).lastThresholdTokens ?? 0,
  }
}

/**
 * Standard grow step: appends one user message INSIDE the turn the runner
 * opened. Turn lifecycle (open for the pressure fold, close for the rebase
 * window) is owned by the runner.
 */
export function growTurn(text: string): (session: Session, step: number) => void {
  return (session, step) => {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} step ${step}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
}

/**
 * The EF arm's rebase window: reopen a turn (pressure folds need one),
 * consult the last frozen-budget advice, and when a rebase is recommended
 * close the turn, run the manual root fold, and leave a fresh open turn for
 * this step's pressure fold. Returns the number of root folds executed.
 *
 * **Superseded by {@link createIdleMaintenanceHook} (R3-0c).** This hook
 * carries its own copy of the production policy, so anything measured through
 * it describes "EF engine + a benchmark maintenance policy" rather than the
 * shipped plugin. It is kept only so earlier stages' numbers stay
 * reproducible; new measurements must use the idle hook.
 */
export function createRootRebaseHook(harness: Harness): (session: Session) => Promise<number> {
  return async session => {
    const engine = harness.engine as unknown as {
      lastRootRebaseAdvice?: { recommended: boolean } | undefined
      compactNow(agent: Agent, signal: AbortSignal): Promise<unknown>
    }
    // The advice was recorded during the PREVIOUS step's pressure fold; the
    // runner has already closed the turn, so the idle fold is admissible.
    if (engine.lastRootRebaseAdvice?.recommended !== true) return 0
    // The manual path runs inside the agent's maintenance bracket.
    const idleAgent = {
      session,
      options: BENCH_AGENT_OPTIONS,
      runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(BENCH_SIGNAL),
    } as unknown as Agent
    await engine.compactNow(idleAgent, BENCH_SIGNAL)
    return 1
  }
}

/**
 * Drive the PRODUCTION idle maintenance path (R3-0c).
 *
 * The benchmark's job is now to arrange the world — turn closed, agent idle —
 * and then step back. It emits the real `agent/status` transition and lets the
 * plugin's own consumer decide and perform the rebase. No policy is copied
 * here: if the production consumer is wrong, this hook is wrong in exactly the
 * same way, which is what `BenchPath == ProductionPath` means.
 *
 * @param harness - a harness mounted with `plugin: true`.
 * @returns the number of root folds that actually landed.
 */
export function createIdleMaintenanceHook(harness: Harness): (session: Session) => Promise<number> {
  return async session => {
    const before = rootFoldCountOf(harness.engine)
    await driveIdleMaintenance(harness, session)
    return rootFoldCountOf(harness.engine) - before
  }
}

/**
 * Emit one idle transition for an agent and wait for any maintenance it
 * triggers to settle.
 *
 * The agent stub models the parts of the real loop the consumer depends on:
 * `status`, `runMaintenance` claiming and releasing the idle phase (throwing
 * when the agent is not idle, exactly as `agent-loop` does), and the
 * `agent/status` emission itself. It is a DRIVER, not a policy — the decision
 * and the fold belong to the production consumer.
 *
 * Settling is observed through the plugin's own registration rather than by
 * polling the agent: the consumer deliberately does not block the emitting
 * turn (in production the user's next message queues behind maintenance), so
 * the only race-free way to await it is the handle the plugin exposes.
 */
export async function driveIdleMaintenance(harness: Harness, session: Session): Promise<void> {
  let busy = false
  const agent = {
    session,
    options: BENCH_AGENT_OPTIONS,
    get status(): string {
      return busy ? 'running' : 'idle'
    },
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (busy) throw new Error(`agent "${String(session.id)}" already has active work`)
      busy = true
      return (async () => {
        try {
          return await task(BENCH_SIGNAL)
        } finally {
          busy = false
        }
      })()
    },
  } as unknown as Agent
  emitAgentStatus(harness, agent, 'idle')
  const registration = harness.plugin?.idleRebase
  if (registration === undefined) {
    throw new Error(
      'driveIdleMaintenance requires a harness mounted with `plugin: true`: the production '
      + 'idle consumer is the thing under test, and there is no fallback policy here by design',
    )
  }
  await registration.settled()
}

/** Root folds an engine has run, read from its own telemetry counter. */
function rootFoldCountOf(engine: unknown): number {
  return (engine as { rootFoldCount?: number }).rootFoldCount ?? 0
}

/**
 * Emit one `agent/status` transition through the context's event bus.
 *
 * The event is agent-scoped in DSH. Scope filtering only excludes a listener
 * whose OWN context carries a different tag; the benchmark context is
 * untagged, so a plain emit reaches the plugin's listener exactly as the real
 * loop's dispatch does for an untagged composition root.
 */
function emitAgentStatus(harness: Harness, agent: Agent, status: 'idle' | 'running'): void {
  harness.ctx.emit('agent/status', { agent, status })
}
