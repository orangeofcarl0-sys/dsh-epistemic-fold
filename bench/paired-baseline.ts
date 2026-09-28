/**
 * Paired-baseline benchmark harness (test spec §8/§12, local architecture
 * metrics): drives identical conversation history through two compaction
 * arms — DSH Basic and Epistemic Fold — and records the prefix-stability
 * economics of every step.
 *
 * Metrics per arm:
 *   stablePrefixBytes / stablePrefixTokens — the unchanged leading history
 *     between consecutive model requests.
 *   firstMutationPosition — first model-history node that differs from the
 *     previous step (PMA's numerator source when no provider cache telemetry
 *     exists).
 *   invalidatedSuffixTokens — priced tokens from the first mutation to the
 *     history end; summed over steps this is the cache-equivalent cost.
 *   reclaimedTokens / leafFoldCount / rootFoldCount — compaction accounting.
 *
 * No live model is needed: the semantic face is deterministic (harness
 * adapter), so the measurement isolates the prefix architecture.
 *
 * @module bench/paired-baseline
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { sha256Hex } from '../src/hash.ts'
import { foldAgent } from '../tests/harness.ts'
import type { Harness } from '../tests/harness.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'

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

export interface StepSample {
  readonly step: number
  readonly totalTokens: number
  readonly firstMutationPosition: number
  readonly invalidatedSuffixTokens: number
  readonly stablePrefixBytes: number
}

export interface BaselineResult {
  readonly arm: string
  readonly samples: readonly StepSample[]
  /** Sum of per-step invalidated suffix tokens (lower is better). */
  readonly invalidatedSuffixTokensTotal: number
  /** Tokens reclaimed by compaction across the run. */
  readonly reclaimedTokensTotal: number
  readonly leafFoldCount: number
  readonly rootFoldCount: number
}

interface BenchEngine {
  compactIfNeeded(agent: Agent, trigger: 'pressure', signal: AbortSignal): Promise<unknown>
}

/** Priced tokens from `position` to the end of ONE measurement (old view). */
function suffixTokens(measurement: { nodes: readonly { tokens: number }[] }, position: number): number {
  let total = 0
  for (let index = position; index < measurement.nodes.length; index += 1) {
    total += measurement.nodes[index]?.tokens ?? 0
  }
  return total
}

/**
 * Run one arm over a growing conversation. `grow` appends one unit of new
 * history per step; after each append the arm's automatic pressure policy
 * runs exactly once, then the model history is re-fingerprinted.
 */
export async function runPairedBaseline(options: {
  arm: string
  harness: Harness
  /** Fresh, IDENTICAL starting history for each arm (same fixture shape). */
  createSession: () => Session
  steps: number
  grow: (session: Session, step: number) => void
  signal?: AbortSignal
}): Promise<BaselineResult> {
  const { harness, steps, grow } = options
  const signal = options.signal ?? new AbortController().signal
  const session = options.createSession()
  const agent: Agent = foldAgent(session)
  const meter = harness.ctx.tokenMeter
  const samples: StepSample[] = []
  let previous = historyDigests(session)
  let previousMeasurement = meter.measure(session)
  let invalidatedTotal = 0
  let reclaimedTotal = 0
  let leafFoldCount = 0
  let rootFoldCount = 0
  let previousTotal = meter.measure(session).totalTokens

  for (let step = 1; step <= steps; step += 1) {
    grow(session, step)
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

    const current = historyDigests(session)
    const measurement = meter.measure(session)
    const position = firstMutationPosition(previous, current)
    // Cache economics: the INVALIDATED tokens are the ones the previous
    // request had already priced (cache-warm) and this request can no longer
    // reuse — the OLD measurement's suffix from the first mutation onward.
    const invalidated = suffixTokens(previousMeasurement, position)
    invalidatedTotal += invalidated
    const stablePrefixBytes = previous.length === 0
      ? 0
      : position * 64 // sha256 hex digests, 64 bytes per node
    samples.push({
      step,
      totalTokens: measurement.totalTokens,
      firstMutationPosition: position,
      invalidatedSuffixTokens: invalidated,
      stablePrefixBytes,
    })
    previous = current
    previousMeasurement = measurement
    previousTotal = afterTotal
    void previousTotal
  }

  return {
    arm: options.arm,
    samples,
    invalidatedSuffixTokensTotal: invalidatedTotal,
    reclaimedTokensTotal: reclaimedTotal,
    leafFoldCount,
    rootFoldCount,
  }
}

/** Standard grow step: one closed user/assistant turn of fixture text. */
export function growTurn(text: string): (session: Session, step: number) => void {
  return (session, step) => {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} step ${step}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
}

/** Force a `ContentBlock[]` summary comparison helper for diagnostics. */
export function summaryBytes(blocks: readonly ContentBlock[]): number {
  return blocks.reduce((total, block) => total + (block.type === 'text' ? block.text.length : 0), 0)
}
