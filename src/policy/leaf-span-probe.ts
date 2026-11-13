/**
 * EF-R3 — the exact-span probe.
 *
 * ## The defect this measures
 *
 * `admitLeafEconomically` prices the WIDEST legal span: it calls
 * `selectLeafSpan(session, measurement, 0, ...)`. A retention budget of 0 does
 * not mean "retain nothing" — the selector's tail walk always consumes the last
 * node before it breaks — so admission sees the largest span any retention
 * setting could produce.
 *
 * Execution then calls `selectLeafSpan(session, measurement, spec.retainTokens,
 * ...)`. That span is a suffix of the admitted one and can be materially
 * smaller. Admission's reclaim floor is therefore evaluated on a span that is
 * never folded, and the checkpoint it estimates is compared with a span that
 * may not even hold it.
 *
 * This module records both spans on the SAME measurement, plus the checkpoint
 * estimate each one implies, and (after a fold) the actual checkpoint cost and
 * surface delta. It is observational: no caller may use its result to change a
 * verdict, a span or an exception path.
 *
 * @module dsh-epistemic-fold/leaf-span-probe
 */

import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { locateFoldFrontier } from '../fold/frontier.ts'
import { selectLeafSpan } from '../fold/leaf-policy.ts'
import { FRAMING_FALLBACK_TOKENS } from './fold-economics.ts'
import { leafMarginalReclaim, pressureBreakdown } from './pressure.ts'

/** One span and its route-priced token total. */
export interface ProbedSpan {
  readonly startIdx: number
  readonly endIdx: number
  readonly start: SessionSeq
  readonly end: SessionSeq
  readonly tokens: number
}

/** The pre-fold half of the probe. */
export interface LeafSpanProbe {
  readonly schemaVersion: 1
  readonly retainTokens: number
  readonly widest: ProbedSpan | null
  readonly executed: ProbedSpan | null
  /** `widest.tokens - executed.tokens`, or null when either span is absent. */
  readonly gapTokens: number | null
  /** The checkpoint estimate admission used (same frozen state for both spans). */
  readonly estimatedCheckpointTokens: number
  /** Widest-span economics: the number admission actually evaluated. */
  readonly expectedReclaimTokens: number | null
  readonly expectedReclaimRatio: number | null
  /** Executed-span economics: the span the engine is about to fold. */
  readonly executedExpectedReclaimTokens: number | null
  readonly executedExpectedReclaimRatio: number | null
  /** What economic admission would say on the widest span. */
  readonly admissionWouldAdmit: boolean
  readonly admissionReason: string
  /** What the same floors would say on the executed span. */
  readonly executionWouldAdmit: boolean
  readonly executionReason: string
  /** True when admission admits but execution would not. The defect in one bit. */
  readonly falseAdmission: boolean
  readonly probeError?: string
  /** Filled after the fold attempt. */
  readonly committed?: boolean
  readonly actual?: {
    readonly checkpointTokens: number | null
    readonly reclaimTokens: number | null
    readonly surfaceDeltaTokens: number | null
    readonly reconciled: boolean
    readonly shadowedHeuristicTokens: number | null
  }
  readonly foldError?: string
}

function tokensOf(measurement: TokenMeasurement, span: { startIdx: number; endIdx: number }): number {
  let total = 0
  for (let index = span.startIdx; index <= span.endIdx; index += 1) {
    total += measurement.nodes[index]?.tokens ?? 0
  }
  return total
}

function probedSpan(measurement: TokenMeasurement, span: ReturnType<typeof selectLeafSpan>): ProbedSpan | null {
  if (span === null) return null
  return {
    startIdx: span.startIdx,
    endIdx: span.endIdx,
    start: span.start,
    end: span.end,
    tokens: tokensOf(measurement, span),
  }
}

function floorsFor(
  spanTokens: number | null,
  frozenTokens: number,
  frozenCount: number,
  minReclaimTokens: number,
  minReclaimRatio: number,
): { admitted: boolean; reason: string; reclaimTokens: number | null; reclaimRatio: number | null } {
  if (spanTokens === null) {
    return { admitted: false, reason: 'no_span', reclaimTokens: null, reclaimRatio: null }
  }
  const reclaim = leafMarginalReclaim({
    spanTokens,
    frozenTokens,
    frozenCount,
    fallbackCheckpointTokens: FRAMING_FALLBACK_TOKENS,
  })
  if (reclaim.reclaimTokens < minReclaimTokens) {
    return {
      admitted: false,
      reason: 'reclaim_below_floor',
      reclaimTokens: reclaim.reclaimTokens,
      reclaimRatio: reclaim.reclaimRatio,
    }
  }
  if (reclaim.reclaimRatio < minReclaimRatio) {
    return {
      admitted: false,
      reason: 'ratio_below_floor',
      reclaimTokens: reclaim.reclaimTokens,
      reclaimRatio: reclaim.reclaimRatio,
    }
  }
  return {
    admitted: true,
    reason: 'admitted',
    reclaimTokens: reclaim.reclaimTokens,
    reclaimRatio: reclaim.reclaimRatio,
  }
}

/**
 * Record the widest and executed spans on one measurement.
 *
 * The function is pure. It calls `selectLeafSpan` twice (once with retain 0,
 * once with the execution budget) and never touches the session or the
 * measurement. A structural mismatch is returned as `probeError`, not thrown.
 */
export function probeLeafSpans(options: {
  readonly session: Session
  readonly measurement: TokenMeasurement
  readonly retainTokens: number
  readonly thresholdTokens: number
  readonly minReclaimTokens: number
  readonly minReclaimRatio: number
  readonly protectedPositions?: readonly number[]
}): LeafSpanProbe {
  const {
    session,
    measurement,
    retainTokens,
    thresholdTokens,
    minReclaimTokens,
    minReclaimRatio,
  } = options
  const protectedPositions = options.protectedPositions ?? []
  try {
    const breakdown = pressureBreakdown(session, measurement, thresholdTokens)
    const widestSpan = selectLeafSpan(session, measurement, 0, undefined, protectedPositions)
    const executedSpan = selectLeafSpan(session, measurement, retainTokens, undefined, protectedPositions)
    const widest = probedSpan(measurement, widestSpan)
    const executed = probedSpan(measurement, executedSpan)
    const baseSpanTokens = widest?.tokens ?? executed?.tokens ?? 0
    const estimate = leafMarginalReclaim({
      spanTokens: baseSpanTokens,
      frozenTokens: breakdown.frozenTokens,
      frozenCount: breakdown.frozenCount,
      fallbackCheckpointTokens: FRAMING_FALLBACK_TOKENS,
    })
    const widestFloors = breakdown.leafCannotSuffice
      ? { admitted: false, reason: 'frozen_prefix_over_threshold', reclaimTokens: null, reclaimRatio: null }
      : floorsFor(
        widest?.tokens ?? null,
        breakdown.frozenTokens,
        breakdown.frozenCount,
        minReclaimTokens,
        minReclaimRatio,
      )
    const executedFloors = breakdown.leafCannotSuffice
      ? { admitted: false, reason: 'frozen_prefix_over_threshold', reclaimTokens: null, reclaimRatio: null }
      : floorsFor(
        executed?.tokens ?? null,
        breakdown.frozenTokens,
        breakdown.frozenCount,
        minReclaimTokens,
        minReclaimRatio,
      )
    const gapTokens = widest === null || executed === null ? null : widest.tokens - executed.tokens

    return {
      schemaVersion: 1,
      retainTokens,
      widest,
      executed,
      gapTokens,
      estimatedCheckpointTokens: estimate.checkpointTokens,
      expectedReclaimTokens: widestFloors.reclaimTokens,
      expectedReclaimRatio: widestFloors.reclaimRatio,
      executedExpectedReclaimTokens: executedFloors.reclaimTokens,
      executedExpectedReclaimRatio: executedFloors.reclaimRatio,
      admissionWouldAdmit: widestFloors.admitted,
      admissionReason: widestFloors.reason,
      executionWouldAdmit: executedFloors.admitted,
      executionReason: executedFloors.reason,
      falseAdmission: widestFloors.admitted && !executedFloors.admitted,
    }
  } catch (error: unknown) {
    return {
      schemaVersion: 1,
      retainTokens,
      widest: null,
      executed: null,
      gapTokens: null,
      estimatedCheckpointTokens: 0,
      expectedReclaimTokens: null,
      expectedReclaimRatio: null,
      executedExpectedReclaimTokens: null,
      executedExpectedReclaimRatio: null,
      admissionWouldAdmit: false,
      admissionReason: 'probe-error',
      executionWouldAdmit: false,
      executionReason: 'probe-error',
      falseAdmission: false,
      probeError: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Fill the post-fold half. Never throws; a probe failure is recorded.
 *
 * `beforeSurfaceTokens` is the measurement total immediately before the fold.
 * `measurement` is the fresh post-fold measurement. `shadowedTokenCount` is
 * Basic's heuristic figure, kept only as a cross-check: it is not the routed
 * span price.
 */
export function finalizeLeafSpanProbe(
  probe: LeafSpanProbe,
  options: {
    readonly session: Session
    readonly measurement: TokenMeasurement
    readonly beforeSurfaceTokens: number
    readonly committed: boolean
    readonly shadowedTokenCount?: number | null
    readonly foldError?: string
  },
): LeafSpanProbe {
  if (!options.committed) {
    return {
      ...probe,
      committed: false,
      actual: {
        checkpointTokens: null,
        reclaimTokens: null,
        surfaceDeltaTokens: null,
        reconciled: false,
        shadowedHeuristicTokens: options.shadowedTokenCount ?? null,
      },
      ...(options.foldError === undefined ? {} : { foldError: options.foldError }),
    }
  }
  try {
    const frontier = locateFoldFrontier(options.session)
    const checkpointPosition = frontier.frozen.at(-1)?.position ?? null
    const checkpointTokens = checkpointPosition === null
      ? null
      : options.measurement.nodes[checkpointPosition]?.tokens ?? null
    const surfaceDeltaTokens = options.beforeSurfaceTokens - options.measurement.totalTokens
    const reclaimTokens = probe.executed === null || checkpointTokens === null
      ? null
      : probe.executed.tokens - checkpointTokens
    return {
      ...probe,
      committed: options.committed,
      actual: {
        checkpointTokens,
        reclaimTokens,
        surfaceDeltaTokens,
        reconciled: reclaimTokens !== null && surfaceDeltaTokens === reclaimTokens,
        shadowedHeuristicTokens: options.shadowedTokenCount ?? null,
      },
      ...(options.foldError === undefined ? {} : { foldError: options.foldError }),
    }
  } catch (error: unknown) {
    return {
      ...probe,
      committed: options.committed,
      actual: {
        checkpointTokens: null,
        reclaimTokens: null,
        surfaceDeltaTokens: null,
        reconciled: false,
        shadowedHeuristicTokens: options.shadowedTokenCount ?? null,
      },
      foldError: error instanceof Error ? error.message : String(error),
    }
  }
}
