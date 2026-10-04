/**
 * The fold-trigger decomposition, reported once per routed target (RC1-A §7-§8).
 *
 * Answers "who actually controls compaction?" — the threshold a deployment
 * believes it set, or the headroom that really binds. It was a private corner of
 * `engine.ts` holding its own map and rendering its own log lines; it needs only
 * the resolved config and a log sink, so it belongs beside the arithmetic it
 * renders rather than inside the transaction engine.
 *
 * @module dsh-epistemic-fold/trigger-diagnostics
 */

import type { ResolvedEpistemicFoldConfig } from './policy.ts'
import { triggerBreakdown, triggerBreakdownToText } from './trigger.ts'
import type { TriggerBreakdown } from './trigger.ts'

/** Where a rendered breakdown is written; `info` is the only level used. */
export type TriggerLogSink = (line: string) => void

/**
 * The most recent trigger decomposition per routed target.
 *
 * Kept per target rather than as one value because a session can be rerouted
 * mid-flight, and the binding constraint is a property of the WINDOW, not of the
 * engine. Reported once per target so a long run does not spam the log with the
 * same six lines.
 */
export class TriggerDiagnostics {
  private readonly reports = new Map<string, TriggerBreakdown>()

  /**
   * The decomposition for one routed target, or `undefined` before the engine
   * has resolved that target's capacity.
   *
   * @param provider - routed provider.
   * @param model - routed model.
   * @returns the breakdown, so a caller can ask "who controls compaction?"
   *   without re-deriving the arithmetic.
   */
  for(provider: string, model: string): TriggerBreakdown | undefined {
    return this.reports.get(`${provider}/${model}`)
  }

  /**
   * Report the decomposition once per routed target.
   *
   * Logged rather than thrown: a headroom-bound trigger is a legitimate
   * configuration, and the failure mode being prevented is a deployment reading
   * `thresholdRatio: 0.8` and believing it folds at 80% of the window. Naming
   * the binding constraint in the log is what makes that visible without turning
   * a valid configuration into a startup error.
   *
   * @param options.target - the routed target this breakdown describes.
   * @param options.contextWindow - the target's context window in tokens.
   * @param options.reserved - tokens reserved for the completion.
   * @param options.config - the resolved EF policy face.
   * @param options.log - sink for the rendered lines.
   */
  report(options: {
    readonly target: { readonly provider: string; readonly model: string }
    readonly contextWindow: number
    readonly reserved: number
    readonly config: ResolvedEpistemicFoldConfig
    readonly log: TriggerLogSink
  }): void {
    const { target, contextWindow, reserved, config, log } = options
    const key = `${target.provider}/${target.model}`
    if (this.reports.has(key)) return
    let breakdown: TriggerBreakdown
    try {
      breakdown = triggerBreakdown(config, contextWindow, reserved)
    } catch {
      // `resolveEfCompactSpec` already threw with the actionable message.
      return
    }
    this.reports.set(key, breakdown)
    const lines = triggerBreakdownToText(breakdown).split(String.fromCharCode(10))
    log(`[epistemic-fold] fold trigger for ${key}:`)
    for (const line of lines) log(`[epistemic-fold] ${line}`)
  }
}
