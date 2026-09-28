/**
 * R1-E Pareto reporting: no single winner, a frontier.
 *
 * docs/11 §23-§24 is unambiguous that a policy which is 1% cheaper but carries
 * 70% more peak context is not "better" — the objectives do not collapse into
 * one number. Money, context footprint, and task success are separate axes,
 * and only policies satisfying the correctness hard gates may enter the
 * comparison at all.
 *
 * This module therefore computes a Pareto frontier rather than a ranking, and
 * refuses to include any candidate that failed a hard gate — correctness is a
 * filter, never a term to be traded against cost.
 *
 * @module eval/pareto
 */

/** One policy's measured position on the three axes. */
export interface PolicyPoint {
  readonly id: string
  readonly label: string
  /** Dollar-equivalent cost under the profile, lower is better. */
  readonly effectiveCost: number
  /** Peak prompt tokens, lower is better. */
  readonly peakContext: number
  /** Task success probability in [0, 1], higher is better. */
  readonly taskSuccess: number
  /**
   * Correctness hard gates. A point failing any of these is excluded from the
   * frontier entirely — economics cannot buy correctness.
   */
  readonly gates: {
    readonly authorityLossRate: number
    readonly stateStalenessRate: number
    readonly criticalConstraintViolations: number
    readonly exactRecallMismatch: number
    readonly crossSessionLeak: number
  }
}

/** Whether a point satisfies every correctness hard gate. */
export function passesHardGates(point: PolicyPoint): boolean {
  const { gates } = point
  return gates.authorityLossRate === 0
    && gates.stateStalenessRate === 0
    && gates.criticalConstraintViolations === 0
    && gates.exactRecallMismatch === 0
    && gates.crossSessionLeak === 0
}

/** Points excluded from the frontier, with the gates each one failed. */
export interface ExcludedPoint {
  readonly id: string
  readonly failedGates: readonly string[]
}

function failedGates(point: PolicyPoint): string[] {
  const failed: string[] = []
  if (point.gates.authorityLossRate !== 0) failed.push('authorityLossRate')
  if (point.gates.stateStalenessRate !== 0) failed.push('stateStalenessRate')
  if (point.gates.criticalConstraintViolations !== 0) failed.push('criticalConstraintViolations')
  if (point.gates.exactRecallMismatch !== 0) failed.push('exactRecallMismatch')
  if (point.gates.crossSessionLeak !== 0) failed.push('crossSessionLeak')
  return failed
}

/**
 * Whether `left` dominates `right`: at least as good on every axis and
 * strictly better on one. All three axes are "lower is better" except task
 * success, which is inverted here.
 */
function dominates(left: PolicyPoint, right: PolicyPoint): boolean {
  const costOk = left.effectiveCost <= right.effectiveCost
  const peakOk = left.peakContext <= right.peakContext
  const successOk = left.taskSuccess >= right.taskSuccess
  const strictlyBetter = left.effectiveCost < right.effectiveCost
    || left.peakContext < right.peakContext
    || left.taskSuccess > right.taskSuccess
  return costOk && peakOk && successOk && strictlyBetter
}

/** The Pareto frontier plus the gate-excluded candidates. */
export interface ParetoResult {
  /** Non-dominated, gate-passing points. */
  readonly frontier: readonly PolicyPoint[]
  /** Gate-passing points that some frontier member dominates. */
  readonly dominated: readonly PolicyPoint[]
  /** Points that failed a correctness gate and never entered comparison. */
  readonly excluded: readonly ExcludedPoint[]
}

/**
 * Compute the Pareto frontier over (cost, peak context, task success).
 *
 * @param points - candidate policies with measured axes and gate outcomes.
 * @returns the frontier, the dominated set, and the gate-excluded set.
 */
export function paretoFrontier(points: readonly PolicyPoint[]): ParetoResult {
  const eligible: PolicyPoint[] = []
  const excluded: ExcludedPoint[] = []
  for (const point of points) {
    if (passesHardGates(point)) {
      eligible.push(point)
    } else {
      excluded.push({ id: point.id, failedGates: failedGates(point) })
    }
  }

  const frontier: PolicyPoint[] = []
  const dominated: PolicyPoint[] = []
  for (const candidate of eligible) {
    const isDominated = eligible.some(other => other.id !== candidate.id && dominates(other, candidate))
    if (isDominated) dominated.push(candidate)
    else frontier.push(candidate)
  }

  return { frontier, dominated, excluded }
}

/**
 * Render a Pareto result as a Markdown table, so a report can present the
 * frontier without re-deriving it. Excluded points are listed separately with
 * the gates they failed — never folded into the comparison.
 */
export function paretoToMarkdown(result: ParetoResult): string {
  const lines = [
    '| Policy | Effective cost | Peak context | Task success |',
    '|---|---:|---:|---:|',
    ...result.frontier.map(point =>
      `| ${point.label} | ${point.effectiveCost.toFixed(4)} | ${point.peakContext} | ${(point.taskSuccess * 100).toFixed(1)}% |`),
  ]
  if (result.dominated.length > 0) {
    lines.push('', 'Dominated (some frontier policy is at least as good everywhere):', '')
    lines.push('| Policy | Effective cost | Peak context | Task success |')
    lines.push('|---|---:|---:|---:|')
    lines.push(...result.dominated.map(point =>
      `| ${point.label} | ${point.effectiveCost.toFixed(4)} | ${point.peakContext} | ${(point.taskSuccess * 100).toFixed(1)}% |`))
  }
  if (result.excluded.length > 0) {
    lines.push('', 'Excluded by correctness hard gates (not comparable on economics):', '')
    lines.push('| Policy | Failed gates |')
    lines.push('|---|---|')
    lines.push(...result.excluded.map(point => `| ${point.id} | ${point.failedGates.join(', ')} |`))
  }
  return lines.join('\n')
}
