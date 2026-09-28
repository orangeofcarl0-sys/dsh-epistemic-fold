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
  let previous = historyDigests(session)
  let previousMeasurement = meter.measure(session)
  let invalidatedTotal = 0
  let stableTotal = 0
  let reclaimedTotal = 0
  let leafFoldCount = 0
  let rootFoldCount = 0

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
    }
    if (engineAny.efConfig !== undefined) {
      const { frozenCheckpointLoad } = await import('../src/leaf-policy.ts')
      checkpointLoad = frozenCheckpointLoad(session, measurement).tokens
    }

    samples.push({
      step,
      promptTokens: measurement.totalTokens,
      firstMutationPosition: position,
      invalidatedSuffixTokens: invalidated,
      stablePrefixTokens: stable,
      appendedTokens,
      checkpointLoad,
    })
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
