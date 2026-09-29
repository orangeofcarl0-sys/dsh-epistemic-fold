/**
 * RC1-B §14: token-growth traces, extracted from experiments already paid for.
 *
 * Parameter search through the live API is the thing RC1 exists to stop doing.
 * A 24-turn × 3-workload × 5-replicate run at 100K context costs real money to
 * answer a question that is pure arithmetic over a growth sequence:
 *
 *   ΔT₁, ΔT₂, … ΔTₙ  →  pressure  →  fold  →  checkpoint  →  growth  →  …
 *
 * So the traces are extracted ONCE from runs that have already happened, stored
 * as data, and replayed locally as many times as a scan needs. The cost of the
 * scan is then zero, which is what makes scanning thousands of policies
 * reasonable instead of reckless.
 *
 * A trace is deliberately NOT a session. It carries only what the policy
 * arithmetic reads — per-step growth, the checkpoint a fold produced, the
 * retained tail — because a replayed trace must not be able to smuggle in
 * behavior the production path would not exhibit.
 *
 * @module eval/policy-replay/trace
 */

import type { BaselineResult } from '../../bench/paired-baseline.ts'

/** One step of an observed run, reduced to the quantities policy reads. */
export interface TraceStep {
  readonly step: number
  /** Tokens of new history appended this step (cold by definition). */
  readonly growthTokens: number
  /**
   * Surface pressure before this step's fold, measured after `grow`. This is
   * what the trigger compares against.
   */
  readonly preFoldTokens: number
  /** Surface pressure after the fold. Equals `preFoldTokens` when none ran. */
  readonly postFoldTokens: number
  /** Frozen-checkpoint load after the step. */
  readonly checkpointLoad: number
  /** Tokens of verbatim tail retained after the step. */
  readonly rawTailTokens: number
  /** Whether a leaf fold actually ran this step. */
  readonly folded: boolean
}

/**
 * One run's growth trajectory, with the configuration it was observed under.
 *
 * The originating config travels with the trace because a trace is only
 * meaningful against the window and reserve it was produced with — replaying a
 * 6000-token-window trace against a 131072-token window is exactly the
 * apples-to-oranges comparison RC0 found in its own earlier numbers.
 */
export interface PolicyTrace {
  readonly id: string
  /** The routed model's window during the observation. */
  readonly contextWindow: number
  readonly reservedCompletionTokens: number
  /** Headroom the observation ran with, so a replay can state the delta. */
  readonly headroomTokens: number
  readonly thresholdRatio: number
  /**
   * Surface pressure BEFORE the first step's growth.
   *
   * Without this the replay is wrong in a way that looks like a result: the
   * observed run began from a seeded fixture, so replaying the growth sequence
   * from zero never reaches the threshold, neither arm folds, and the cost
   * ratio is 1 by construction. The trace therefore carries its own starting
   * surface rather than assuming an empty one.
   */
  readonly initialTokens: number
  readonly steps: readonly TraceStep[]
  /** Per-fold checkpoint sizes, in fold order. Empty when nothing folded. */
  readonly checkpointSizes: readonly number[]
  /**
   * A checkpoint size the trace DECLARES rather than observed.
   *
   * RC1 §20 models the state-rich regime by assuming a larger checkpoint per
   * fold, and that assumption has to live on the trace rather than in a
   * caller's fallback: a state-rich replay whose checkpoint silently came from
   * the marker-only observation would be a different experiment wearing the
   * same label. `checkpointSizes` still wins whenever the trace actually
   * folded — a declaration never overrides a measurement.
   */
  readonly declaredCheckpointTokens?: number
  /** Per-step growth, in step order — the replay's actual input. */
  readonly growths: readonly number[]
}

/**
 * Reduce one `BaselineResult` into a replayable trace.
 *
 * `checkpointSizes` is derived as the INCREASE in frozen load across a folding
 * step. That is the checkpoint the fold created, measured rather than assumed:
 * a marker-only checkpoint and a 600-token structured checkpoint produce the
 * same trajectory shape but completely different replay arithmetic, so
 * guessing here would make every downstream number fiction.
 *
 * @param id - trace label.
 * @param result - the completed run.
 * @param config - the window/reserve/ratio the run used.
 * @returns the reduced trace.
 */
export function traceFromBaseline(
  id: string,
  result: BaselineResult,
  config: {
    readonly contextWindow: number
    readonly reservedCompletionTokens: number
    readonly headroomTokens: number
    readonly thresholdRatio: number
  },
): PolicyTrace {
  const steps: TraceStep[] = []
  const checkpointSizes: number[] = []
  let previousLoad = 0
  // The first sample's `preFoldTokens` includes the seed fixture's growth, so
  // the surface before step 1 is that value minus step 1's own growth.
  const first = result.samples[0]
  const initialTokens = first === undefined
    ? 0
    : Math.max(0, first.preFoldTokens - first.appendedTokens)
  for (const sample of result.samples) {
    const folded = sample.preFoldTokens > sample.promptTokens
    // A fold's checkpoint is the growth in frozen load it caused. Clamped at 0
    // because a root rebase COLLAPSES the frozen load, and a negative
    // "checkpoint size" would be nonsense the arithmetic would then propagate.
    const created = Math.max(0, sample.checkpointLoad - previousLoad)
    if (folded && created > 0) checkpointSizes.push(created)
    previousLoad = sample.checkpointLoad
    steps.push({
      step: sample.step,
      growthTokens: sample.appendedTokens,
      preFoldTokens: sample.preFoldTokens,
      postFoldTokens: sample.promptTokens,
      checkpointLoad: sample.checkpointLoad,
      rawTailTokens: Math.max(0, sample.promptTokens - sample.checkpointLoad),
      folded,
    })
  }
  return {
    id,
    contextWindow: config.contextWindow,
    reservedCompletionTokens: config.reservedCompletionTokens,
    headroomTokens: config.headroomTokens,
    thresholdRatio: config.thresholdRatio,
    initialTokens,
    steps,
    checkpointSizes,
    growths: steps.map(step => step.growthTokens),
  }
}

/**
 * The checkpoint size a trace implies for replay.
 *
 * A MEASURED size always wins: the trace's own median when it folded at least
 * once. A trace that never folded carries no evidence, so a DECLARED size is
 * used if the trace supplies one, and only then the caller's fallback. The
 * three-way result is reported so a replay can state which it used — a
 * declaration and a measurement support different strengths of claim, and
 * collapsing them would let arithmetic be presented as observation.
 *
 * @param trace - the trace.
 * @param fallbackTokens - size to use when the trace supplies no evidence.
 * @returns the size and where it came from.
 */
export function checkpointSizeOf(
  trace: PolicyTrace,
  fallbackTokens: number,
): { readonly tokens: number; readonly evidenced: boolean; readonly origin: 'measured' | 'declared' | 'fallback' } {
  if (trace.checkpointSizes.length > 0) {
    const sorted = [...trace.checkpointSizes].sort((left, right) => left - right)
    const middle = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 === 0
      ? (sorted[middle - 1]! + sorted[middle]!) / 2
      : sorted[middle]!
    return { tokens: median, evidenced: true, origin: 'measured' }
  }
  if (trace.declaredCheckpointTokens !== undefined) {
    return { tokens: trace.declaredCheckpointTokens, evidenced: false, origin: 'declared' }
  }
  return { tokens: fallbackTokens, evidenced: false, origin: 'fallback' }
}

/**
 * Median per-step growth of a trace — the scalar a report can quote.
 *
 * @param trace - the trace.
 * @returns the median growth, or 0 for an empty trace.
 */
export function medianGrowth(trace: PolicyTrace): number {
  if (trace.growths.length === 0) return 0
  const sorted = [...trace.growths].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}

/** A set of traces, kept together so a scan always covers all of them. */
export interface TraceCorpus {
  readonly traces: readonly PolicyTrace[]
}

/**
 * A synthetic trace for a regime no live run has reached.
 *
 * RC1 §20 is explicit that the state-rich regime does not need 700+ live turns:
 * a trace with a known per-step growth and checkpoint size answers the
 * economic question, and a scaled-down live smoke confirms the transaction
 * path separately. Synthetic traces are labeled as such so a report can never
 * present one as an observation.
 *
 * @param id - label, conventionally prefixed `synthetic:`.
 * @param options - step count, growth, and the observed window.
 * @returns a trace whose growth is uniform.
 */
export function syntheticTrace(
  id: string,
  options: {
    readonly steps: number
    readonly growthTokens: number
    readonly contextWindow: number
    readonly reservedCompletionTokens?: number
    readonly headroomTokens?: number
    readonly thresholdRatio?: number
    /** Surface pressure before the first step; defaults to empty. */
    readonly initialTokens?: number
    /** Checkpoint size the trace declares, when it evidences none itself. */
    readonly declaredCheckpointTokens?: number
  },
): PolicyTrace {
  const initialTokens = options.initialTokens ?? 0
  const steps: TraceStep[] = Array.from({ length: options.steps }, (_, index) => ({
    step: index + 1,
    growthTokens: options.growthTokens,
    // A synthetic trace has no observed fold, so pre/post are its own growth
    // accumulation — used only as provenance, never as a replay input.
    preFoldTokens: initialTokens + (index + 1) * options.growthTokens,
    postFoldTokens: initialTokens + (index + 1) * options.growthTokens,
    checkpointLoad: 0,
    rawTailTokens: initialTokens + (index + 1) * options.growthTokens,
    folded: false,
  }))
  return {
    id,
    contextWindow: options.contextWindow,
    reservedCompletionTokens: options.reservedCompletionTokens ?? 0,
    headroomTokens: options.headroomTokens ?? 0,
    thresholdRatio: options.thresholdRatio ?? 0.8,
    initialTokens,
    steps,
    checkpointSizes: [],
    ...(options.declaredCheckpointTokens === undefined
      ? {}
      : { declaredCheckpointTokens: options.declaredCheckpointTokens }),
    growths: steps.map(step => step.growthTokens),
  }
}
