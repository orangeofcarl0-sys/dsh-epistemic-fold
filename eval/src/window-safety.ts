/**
 * R4-C: window safety replaces the peak-context ratio as the release gate.
 *
 * R3 reported `Peak_candidate <= Peak_Basic · 1.05` as VIOLATED at 1.14–1.22×.
 * R4-0a then established that the ratio measures fold-cadence quantization, not
 * a product risk: EF's post-fold floor is ~84 tokens lower, so it needs one
 * MORE append to cross the same threshold, and crossing on a larger multiple of
 * the step quantum raises the peak. Nothing about that is dangerous, and the
 * absolute overshoot is a few hundred tokens.
 *
 * So the ratio is the wrong gate. For a cache-dominant model, EF carrying a
 * LONGER context more cheaply is the entire point, and "shorter than Basic"
 * was never the objective. What actually matters is:
 *
 *   PeakMain + ReservedOutput + SafetyHeadroom < ContextWindow
 *
 * plus a zero context-overflow rate. The ratio is retained as a DIAGNOSTIC.
 *
 * @module eval/window-safety
 */

/** One arm's window-safety inputs for one run. */
export interface WindowSafetyInput {
  /** Peak tokens actually sent to the primary model. */
  readonly peakMainRequestTokens: number
  /** The context window of the model actually routed. */
  readonly contextWindow: number
  /** Output tokens the request reserves against that window. */
  readonly reservedOutputTokens: number
  /** Headroom the deployment wants kept free. */
  readonly safetyHeadroomTokens: number
  /** Context-overflow recoveries observed during the run. */
  readonly overflowEvents: number
}

/** The verdict, with the numbers that produced it. */
export interface WindowSafetyVerdict {
  readonly safe: boolean
  /** `PeakMain + Reserved + Headroom`, the quantity bounded by the window. */
  readonly requiredTokens: number
  readonly contextWindow: number
  /** `requiredTokens / contextWindow`; the headroom actually left, as a ratio. */
  readonly windowUtilization: number
  readonly overflowEvents: number
  /** Why it failed, when it did. */
  readonly reason?: string
}

/**
 * Evaluate window safety for one run (R4 §21).
 *
 * Two independent conditions, both of which must hold:
 *
 * 1. The worst-case request fits with its reservation and headroom intact.
 * 2. No context overflow occurred. A run that recovered from overflow may
 *    still have produced a truncated or retried turn, so a clean fit does not
 *    excuse an observed overflow.
 *
 * @param input - the run's peak, window, reservation, headroom, and overflows.
 * @returns the verdict; `reason` names every condition that failed.
 */
export function evaluateWindowSafety(input: WindowSafetyInput): WindowSafetyVerdict {
  const requiredTokens = input.peakMainRequestTokens
    + input.reservedOutputTokens
    + input.safetyHeadroomTokens
  const windowUtilization = input.contextWindow === 0
    ? Number.POSITIVE_INFINITY
    : requiredTokens / input.contextWindow

  const failures: string[] = []
  if (requiredTokens >= input.contextWindow) {
    failures.push(
      `worst-case request needs ${requiredTokens} tokens `
      + `(peak ${input.peakMainRequestTokens} + reserved ${input.reservedOutputTokens} `
      + `+ headroom ${input.safetyHeadroomTokens}) of a ${input.contextWindow}-token window`,
    )
  }
  if (input.overflowEvents > 0) {
    failures.push(`${input.overflowEvents} context-overflow event(s) observed`)
  }

  return {
    safe: failures.length === 0,
    requiredTokens,
    contextWindow: input.contextWindow,
    windowUtilization,
    overflowEvents: input.overflowEvents,
    ...(failures.length === 0 ? {} : { reason: failures.join('; ') }),
  }
}

/**
 * The peak ratio, kept as a DIAGNOSTIC (R4 §21).
 *
 * Reported so a change in fold timing is visible, never gated on. `undefined`
 * when Basic's peak is unknown or zero, because a ratio against nothing is not
 * a measurement.
 */
export function peakRatioDiagnostic(
  candidatePeak: number,
  basicPeak: number,
): number | undefined {
  if (basicPeak <= 0) return undefined
  return candidatePeak / basicPeak
}

/** Render a window-safety verdict as Markdown for a report. */
export function windowSafetyToMarkdown(verdict: WindowSafetyVerdict): string {
  return [
    `- Worst-case request: **${verdict.requiredTokens}** tokens of ${verdict.contextWindow} `
    + `(${(verdict.windowUtilization * 100).toFixed(1)}% utilized)`,
    `- Context-overflow events: **${verdict.overflowEvents}**`,
    `- Window safe: **${verdict.safe ? 'PASS' : 'FAIL'}**`
    + (verdict.reason === undefined ? '' : ` — ${verdict.reason}`),
  ].join('\n')
}
