/**
 * RC1-A: the trigger breakdown — who actually controls compaction.
 *
 * `resolveEfCompactSpec` computes `min(αW, W − O − H)` correctly, but it
 * returns ONE number. That number hides which of the two bounds won, and the
 * answer changes what the configuration MEANS:
 *
 *   thresholdRatio = 0.8  →  "fold at 80% of the window"
 *
 * reads as an 80%-full trigger, while on a 131072-token window with the
 * shipped 65536-token headroom the capacity term binds and the real trigger is
 * 65024 tokens — **49.6%**, not 80%. A deployment that reads only
 * `thresholdRatio` is reasoning about a policy it is not running.
 *
 * So the ratio bound and the capacity bound are reported separately, with the
 * binding constraint named. This is pure arithmetic over the same two inputs
 * `resolveEfCompactSpec` uses, so it cannot disagree with the engine.
 *
 * The three knobs have distinct jobs and the breakdown keeps them distinct:
 *
 *   `thresholdRatio`            when to fold under normal conditions
 *   `reservedCompletionTokens`  window held for the routed model's own output
 *   `headroomTokens`            token-meter error + one-step burst + transport
 *
 * The last one is a SAFETY RESERVE. It is not supposed to be the compaction
 * trigger, and when it is, the breakdown says so.
 *
 * @module dsh-epistemic-fold/trigger
 */

import { resolveEfCompactSpec } from './policy.ts'
import type { ResolvedEpistemicFoldConfig } from './policy.ts'

/** Which bound produced the effective threshold. */
export type BindingConstraint = 'ratio' | 'headroom'

/**
 * One routed model's trigger arithmetic, decomposed.
 *
 * `effectiveThreshold === min(ratioThreshold, capacityThreshold)` always, and
 * `binding` names which one that was — so "who controls compaction" is
 * answerable from the numbers rather than inferred.
 */
export interface TriggerBreakdown {
  readonly contextWindow: number
  /** Output tokens the routed request reserves against the window. */
  readonly reservedCompletionTokens: number
  /** Safety reserve held back from the message budget. */
  readonly headroomTokens: number
  /** Window fraction the deployment configured. */
  readonly thresholdRatio: number
  /** `contextWindow * thresholdRatio` — the ratio bound. */
  readonly ratioThreshold: number
  /** `contextWindow - reserved - headroom` — the capacity bound. */
  readonly capacityThreshold: number
  /** The threshold the engine actually uses: the smaller of the two bounds. */
  readonly effectiveThreshold: number
  readonly binding: BindingConstraint
  /**
   * `effectiveThreshold / contextWindow` — the window fraction at which a fold
   * actually happens. Differs from `thresholdRatio` exactly when capacity binds.
   */
  readonly effectiveRatio: number
  /** The retention budget the same spec resolves to. */
  readonly retainTokens: number
}

/**
 * Decompose the fold trigger for one routed model capacity (RC1-A §7/§8).
 *
 * @param config - the RESOLVED configuration (post-preset).
 * @param contextWindow - the routed model's window.
 * @param reservedCompletionTokens - output tokens the routed request reserves.
 * @returns both bounds, the effective threshold, and which bound binds.
 * @throws when the reservation plus headroom leave no message budget — the same
 *   configuration error `resolveEfCompactSpec` raises, surfaced here rather than
 *   returning a negative threshold that would look like a measurement.
 */
export function triggerBreakdown(
  config: ResolvedEpistemicFoldConfig,
  contextWindow: number,
  reservedCompletionTokens: number,
): TriggerBreakdown {
  // Delegated, not reimplemented: if this ever disagrees with the engine's own
  // spec resolution, the engine is wrong or this is, and both read one function.
  const spec = resolveEfCompactSpec(config, contextWindow, reservedCompletionTokens)
  const ratioThreshold = Math.floor(contextWindow * config.thresholdRatio)
  const capacityThreshold = contextWindow - reservedCompletionTokens - config.headroomTokens
  // `<=` rather than `<`: on a tie the ratio bound is reported as binding only
  // when it is the strictly smaller one, so the diagnostic names the SAFETY
  // reserve whenever the reserve is what actually limits folding. A tie means
  // the reserve is not the limiter, so `ratio` is the honest label.
  const binding: BindingConstraint = capacityThreshold < ratioThreshold ? 'headroom' : 'ratio'
  return {
    contextWindow,
    reservedCompletionTokens,
    headroomTokens: config.headroomTokens,
    thresholdRatio: config.thresholdRatio,
    ratioThreshold,
    capacityThreshold,
    effectiveThreshold: spec.thresholdTokens,
    binding,
    effectiveRatio: contextWindow === 0 ? 0 : spec.thresholdTokens / contextWindow,
    retainTokens: spec.retainTokens,
  }
}

/**
 * Render the breakdown as the preflight lines RC1-A §7 asks for.
 *
 * Grouped thousands separators are used because the whole failure mode this
 * diagnostic exists to prevent is a reader skimming past `65,024` and reading
 * the `0.80` next to it.
 *
 * @param breakdown - the computed breakdown.
 * @returns one line per quantity, ending with the binding constraint.
 */
export function triggerBreakdownToText(breakdown: TriggerBreakdown): string {
  const grouped = (value: number): string => value.toLocaleString('en-US')
  return [
    `  Configured thresholdRatio: ${breakdown.thresholdRatio.toFixed(2)}`,
    `  Ratio-bound threshold:     ${grouped(breakdown.ratioThreshold)}`,
    `  Headroom-bound threshold:  ${grouped(breakdown.capacityThreshold)}`,
    `  Effective threshold:       ${grouped(breakdown.effectiveThreshold)}`,
    `  Binding constraint:        ${breakdown.binding}`,
    `  Effective window fraction: ${(breakdown.effectiveRatio * 100).toFixed(1)}%`,
  ].join('\n')
}

/**
 * Whether the safety reserve has silently become the fold trigger.
 *
 * True when the capacity bound is what limits folding. This is not an error —
 * on a small window with a large reservation it is unavoidable — but it IS the
 * condition under which `thresholdRatio` no longer describes the behavior, so
 * a deployment tuning `thresholdRatio` needs to know the knob is inert.
 */
export function headroomDominates(breakdown: TriggerBreakdown): boolean {
  return breakdown.binding === 'headroom'
}
