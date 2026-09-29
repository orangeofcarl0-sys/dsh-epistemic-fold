/**
 * RC1-B §15/§16: the broad-plateau scan.
 *
 * RC1 §16 states the objective precisely, and it is not the usual one:
 *
 *   find a ROBUST OPERATING REGION, not  argmin_α C(α)
 *
 * A parameter tuned to the fourth decimal is fitted to the traces it was tuned
 * on and says nothing about the next workload. A parameter that is within 2% of
 * optimal across a WIDE band, with zero overflow and stable fold cadence
 * everywhere in that band, is a parameter whose exact value does not matter —
 * which is what makes it safe to ship.
 *
 * So the scan reports, for each candidate, the worst case across the whole
 * corpus rather than the mean, and the plateau is defined by how much of the
 * parameter space stays inside a tolerance. The output is a recommendation of
 * the SIMPLEST value inside the plateau (RC1 §15's `0.8`, not `0.734`).
 *
 * @module eval/policy-replay/report
 */

import type { ContextEconomicsProfile } from '../../src/economics-profile.ts'
import { replayGate, replayPaired } from './simulator.ts'
import type { PairedReplay, ReplayPolicy } from './simulator.ts'
import type { PolicyTrace } from './trace.ts'

/** One candidate's outcome across an entire trace corpus. */
export interface ScanPoint {
  /** The parameter values this point varies, for the report's axis labels. */
  readonly label: string
  readonly config: Readonly<Record<string, unknown>>
  /** Worst (highest) cost ratio across the corpus — the gate's quantity. */
  readonly worstCostRatio: number
  /** Mean cost ratio across the corpus, EXCLUDING vacuous traces. */
  readonly meanCostRatio: number
  /** Total overflow events across every trace. */
  readonly overflowEvents: number
  /** Longest sustained fold run anywhere in the corpus. */
  readonly worstFoldRun: number
  /** Traces that failed the RC1-B gate, by id. */
  readonly failedTraces: readonly string[]
  /**
   * Traces where neither arm folded, so the ratio was 1 by construction.
   *
   * Reported separately and EXCLUDED from the mean, because a vacuous trace
   * contributes a cost ratio of exactly 1 to every candidate alike. Leaving it
   * in drags every mean toward 1 and makes a corpus that mostly does not cycle
   * look like a corpus where every policy performs identically — the vacuity
   * failure, restated as an averaging artifact.
   */
  readonly vacuousTraces: readonly string[]
  /** The paired replays, retained so a report can drill into one trace. */
  readonly pairs: readonly PairedReplay[]
}

/**
 * Scan a corpus with one candidate builder (RC1-B §15).
 *
 * @param corpus - the traces to replay.
 * @param candidates - label plus policy for each point to evaluate.
 * @param profile - the routed model's economics.
 * @returns one scan point per candidate, in input order.
 */
export function scan(
  corpus: readonly PolicyTrace[],
  candidates: readonly { readonly label: string; readonly config: Readonly<Record<string, unknown>>; readonly policy: ReplayPolicy }[],
  profile: ContextEconomicsProfile,
): readonly ScanPoint[] {
  const points: ScanPoint[] = []
  for (const candidate of candidates) {
    const pairs: PairedReplay[] = []
    const failed: string[] = []
    const vacuous: string[] = []
    let worstCostRatio = 0
    let costRatioSum = 0
    let informative = 0
    let overflowEvents = 0
    let worstFoldRun = 0
    for (const trace of corpus) {
      const paired = replayPaired(trace, candidate.policy, profile)
      pairs.push(paired)
      const gate = replayGate(paired)
      if (gate.vacuous) {
        vacuous.push(trace.id)
        // A vacuous trace still participates in the overflow and fold-run
        // scans, because those conditions are observable even when nothing
        // folded — it is only the COST RATIO that is uninformative.
        overflowEvents += paired.candidate.overflowEvents + paired.basic.overflowEvents
        worstFoldRun = Math.max(worstFoldRun, paired.candidate.longestFoldRun)
        continue
      }
      if (!gate.passed) failed.push(`${trace.id} (${gate.failures.join('; ')})`)
      worstCostRatio = Math.max(worstCostRatio, paired.costRatio)
      costRatioSum += paired.costRatio
      informative += 1
      overflowEvents += paired.candidate.overflowEvents + paired.basic.overflowEvents
      worstFoldRun = Math.max(worstFoldRun, paired.candidate.longestFoldRun)
    }
    points.push({
      label: candidate.label,
      config: candidate.config,
      worstCostRatio,
      meanCostRatio: informative === 0 ? Number.NaN : costRatioSum / informative,
      overflowEvents,
      worstFoldRun,
      failedTraces: failed,
      vacuousTraces: vacuous,
      pairs,
    })
  }
  return points
}

/** A parameter band inside which every point is acceptable. */
export interface Plateau {
  /** Whether any point qualified at all. */
  readonly found: boolean
  /** Labels inside the band, in scan order. */
  readonly labels: readonly string[]
  /**
   * The point to ship: the SIMPLEST member of the band, chosen by the caller's
   * preference order rather than by its cost.
   */
  readonly recommended?: ScanPoint
  readonly reason: string
}

/**
 * Find the broad plateau and pick a simple value inside it (RC1 §15/§16).
 *
 * Qualification is the RC1-B gate plus a cost tolerance, and "broad" is a
 * MINIMUM band width: a single qualifying point is a fitted parameter, not a
 * robust region, and reporting it as one would be the overfitting RC1 §16
 * explicitly forbids. `minWidth` defaults to 3.
 *
 * The recommendation is chosen by `prefer` — a caller-supplied order over
 * labels, normally "the value a mature implementation would already use" — and
 * falls back to the cheapest qualifying point only when no preference matches.
 *
 * @param points - the scan result.
 * @param options - tolerance, minimum band width, and the simplicity order.
 * @returns the plateau and the recommended point.
 */
export function findPlateau(
  points: readonly ScanPoint[],
  options: {
    readonly tolerance?: number
    readonly minWidth?: number
    readonly prefer?: readonly string[]
  } = {},
): Plateau {
  const tolerance = options.tolerance ?? 1
  const minWidth = options.minWidth ?? 3
  const qualifying = points.filter(point =>
    point.failedTraces.length === 0 && point.worstCostRatio <= tolerance)
  if (qualifying.length === 0) {
    return {
      found: false,
      labels: [],
      reason: `no candidate cleared the gate within tolerance ${tolerance} on every trace`,
    }
  }
  // A corpus that never cycles produces a worst ratio of 0 (nothing was ever
  // measured) for every candidate. That is not a plateau; it is an absence of
  // measurement, and reporting it as one would be the most flattering possible
  // way to say nothing.
  const measured = qualifying.filter(point => Number.isFinite(point.meanCostRatio) && point.worstCostRatio > 0)
  if (measured.length === 0) {
    return {
      found: false,
      labels: qualifying.map(point => point.label),
      reason: 'every qualifying candidate is vacuous: no trace in the corpus cycled for any of '
        + 'them, so no cost ratio was measured and there is no plateau to report',
    }
  }
  const labels = qualifying.map(point => point.label)
  if (qualifying.length < minWidth) {
    return {
      found: false,
      labels,
      reason: `${qualifying.length} qualifying point(s) is narrower than the ${minWidth}-point `
        + 'minimum band, so the result is a fitted parameter rather than a robust region',
    }
  }
  const preferred = options.prefer
    ?.map(label => qualifying.find(point => point.label === label))
    .find(point => point !== undefined)
  const recommended = preferred
    ?? [...qualifying].sort((left, right) => left.worstCostRatio - right.worstCostRatio)[0]!
  return {
    found: true,
    labels,
    recommended,
    reason: `${qualifying.length} points qualify within tolerance ${tolerance} `
      + `(worst cost ratio <= ${tolerance}, no overflow, no sustained fold run); `
      + `recommending "${recommended.label}" (worst ${recommended.worstCostRatio.toFixed(3)}x)`,
  }
}

/**
 * Render a scan as a Markdown table, worst case first.
 *
 * The worst-case column is the gate's quantity and is listed before the mean,
 * because a candidate that is cheap on average and above 1 somewhere is not
 * cheaper — it is cheaper for some workloads and dearer for others, which is a
 * different claim.
 *
 * @param points - the scan result.
 * @returns the Markdown table.
 */
export function scanToMarkdown(points: readonly ScanPoint[]): string {
  const lines = [
    '| Candidate | Worst cost ratio | Mean cost ratio | Overflows | Longest fold run | Failed | Vacuous |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ]
  for (const point of points) {
    const mean = Number.isFinite(point.meanCostRatio) ? point.meanCostRatio.toFixed(3) : 'n/a'
    lines.push(
      `| ${point.label} | ${point.worstCostRatio.toFixed(3)} | ${mean} `
      + `| ${point.overflowEvents} | ${point.worstFoldRun} | ${point.failedTraces.length} `
      + `| ${point.vacuousTraces.length} |`,
    )
  }
  return lines.join('\n')
}
