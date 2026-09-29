/**
 * RC1-B §14: build the replay corpus from keyless runs.
 *
 * The traces come from the SAME `runPairedBaseline` harness every earlier stage
 * used, driven by the SAME five workloads — so a replayed policy is being
 * judged against trajectories that were actually produced by the production
 * engine, not against a hand-written growth model. That is the whole reason a
 * zero-cost scan can be trusted enough to inform a configuration.
 *
 * Two shapes are included deliberately, and they are NOT interchangeable:
 *
 *   observed  — a real workload run at a small window, folding repeatedly. Its
 *               checkpoint sizes are MEASURED, so a fold's cost is evidenced.
 *   synthetic — a uniform-growth trace standing in for a regime no live run has
 *               reached (RC1 §20's state-rich case). It evidences no checkpoint
 *               size at all, which the trace records.
 *
 * A report that mixes them without labeling which is which would be presenting
 * arithmetic as observation.
 *
 * @module eval/policy-replay/corpus
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { runPairedBaseline } from '../../bench/paired-baseline.ts'
import { allWorkloads, WORKLOAD_MODEL } from '../workloads/index.ts'
import { createHarness, SIGNAL } from '../../tests/harness.ts'
import { syntheticTrace, traceFromBaseline } from './trace.ts'
import type { PolicyTrace } from './trace.ts'

/**
 * The window and policy the corpus OBSERVATIONS run at.
 *
 * Small ON PURPOSE, and stated here rather than hidden: a trace must CYCLE —
 * grow past the threshold, fold, grow again — or the replay compares two
 * identical runs and reports a cost ratio of exactly 1 for every candidate.
 * That vacuity is what an 8000-token window buys: at the highest α in the scan
 * (0.85 → 6800) a 60-step W2 trajectory still crosses the threshold twice,
 * while at the lowest (0.5 → 4000) it crosses four times.
 *
 * These traces compare POLICIES. They say nothing about a 131072-token
 * production window — that is RC1-A's trigger analysis and RC0's soak.
 */
export const CORPUS_WINDOW = 8_000
export const CORPUS_RESERVED = 1_500
export const CORPUS_HEADROOM = 0
export const CORPUS_THRESHOLD_RATIO = 0.15
export const CORPUS_RETAIN = 0

/**
 * The window the SYNTHETIC regimes model.
 *
 * Larger than the observation window because these traces stand in for a
 * production-shaped deployment, where a step is a few thousand tokens against
 * a much bigger window — the regime RC0 §19 found the shipped defaults sit in.
 * Their growth is set BELOW the resulting threshold (0.15 × 32768 = 4915) so
 * the trajectory cycles at a realistic cadence instead of folding every step.
 */
export const SYNTHETIC_WINDOW = 32_768
export const SYNTHETIC_RESERVED = 2_000

/**
 * Checkpoint sizes the synthetic regimes DECLARE.
 *
 * `state-rich` is the regime RC1 §20 declines to run live: a session whose
 * folds carry substantial state, so a checkpoint costs real tokens and a rebase
 * becomes economically admissible. The number is the experiment's premise, and
 * it is carried on the trace so a report cannot present it as a measurement.
 * The observed traces' own measured size — 20 tokens, marker-only — is what
 * makes the contrast meaningful rather than assumed.
 */
export const STATE_RICH_CHECKPOINT_TOKENS = 600

/** The economy policy the traces are observed under. */
export const CORPUS_EF_CONFIG = {
  thresholdRatio: CORPUS_THRESHOLD_RATIO,
  headroomTokens: CORPUS_HEADROOM,
  retainTokens: CORPUS_RETAIN,
  maxTokens: CORPUS_RESERVED,
  leafAdmission: 'economic' as const,
  rootPolicy: 'economics' as const,
  semanticMode: 'none' as const,
  framingMode: 'system-dedup' as const,
}

/**
 * Run one workload through the keyless EF arm and reduce it to a trace.
 *
 * @param workloadIndex - which workload to run.
 * @param steps - how many steps of growth.
 * @returns the trace, with measured checkpoint sizes.
 */
export async function observeTrace(workloadIndex: number, steps: number): Promise<PolicyTrace> {
  const workload = allWorkloads()[workloadIndex]!
  const harness = await createHarness({ text: 'digest' }, {
    contextWindow: CORPUS_WINDOW,
    workloadModel: WORKLOAD_MODEL,
    plugin: true,
    systemPrompt: true,
    efConfig: CORPUS_EF_CONFIG,
  })
  const result = await runPairedBaseline({
    arm: 'observe',
    harness,
    createSession: workload.createSession,
    steps,
    grow: (session: Session, step: number) => workload.grow(session, step),
    signal: SIGNAL,
  })
  return traceFromBaseline(workload.id, result, {
    contextWindow: CORPUS_WINDOW,
    reservedCompletionTokens: CORPUS_RESERVED,
    headroomTokens: CORPUS_HEADROOM,
    thresholdRatio: CORPUS_THRESHOLD_RATIO,
  })
}

/**
 * The full replay corpus.
 *
 * @param options - step counts for the observed and synthetic families.
 * @returns observed traces for W1/W2/W3/W4 plus two synthetic regimes.
 */
export async function buildCorpus(options: {
  readonly observedSteps?: number
  readonly syntheticSteps?: number
} = {}): Promise<readonly PolicyTrace[]> {
  const observedSteps = options.observedSteps ?? 60
  const syntheticSteps = options.syntheticSteps ?? 60
  const observed: PolicyTrace[] = []
  for (let index = 0; index < 4; index += 1) {
    observed.push(await observeTrace(index, observedSteps))
  }
  // The state-rich regime RC1 §20 declines to run live: a bigger checkpoint per
  // fold is what makes a rebase admissible, and that is arithmetic over the
  // trajectory rather than something 700 live turns would reveal differently.
  // Growth stays below the 4915-token threshold so the trajectory cycles.
  const stateRich = syntheticTrace('synthetic:state-rich-600cp', {
    steps: syntheticSteps,
    growthTokens: 2_400,
    contextWindow: SYNTHETIC_WINDOW,
    reservedCompletionTokens: SYNTHETIC_RESERVED,
    headroomTokens: CORPUS_HEADROOM,
    thresholdRatio: CORPUS_THRESHOLD_RATIO,
    declaredCheckpointTokens: STATE_RICH_CHECKPOINT_TOKENS,
  })
  const longTrajectory = syntheticTrace('synthetic:long-trajectory', {
    steps: syntheticSteps,
    growthTokens: 1_800,
    contextWindow: SYNTHETIC_WINDOW,
    reservedCompletionTokens: SYNTHETIC_RESERVED,
    headroomTokens: CORPUS_HEADROOM,
    thresholdRatio: CORPUS_THRESHOLD_RATIO,
    declaredCheckpointTokens: 200,
  })
  return [...observed, stateRich, longTrajectory]
}

/**
 * Whether a trace is an observation or a synthetic construction.
 *
 * A report must be able to separate them, because a synthetic trace carries no
 * measured checkpoint size and therefore cannot support a claim about what a
 * fold costs.
 */
export function traceKind(trace: PolicyTrace): 'observed' | 'synthetic' {
  return trace.id.startsWith('synthetic:') ? 'synthetic' : 'observed'
}
