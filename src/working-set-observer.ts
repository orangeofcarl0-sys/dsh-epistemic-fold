/**
 * The Thermal Working-Set Observer's wiring: the ONE place the `workingSet`
 * config flag is read, and the only code that runs because of it.
 *
 * ## Why a single entry point rather than three call sites
 *
 * The three readings — the working-set decomposition, the thermal residency
 * report and the shadow folding decision — must be unable to change a fold
 * decision. The strongest form of that guarantee is not a promise in three
 * places; it is one function whose return value is only ever logged. So the
 * engine calls {@link observeWorkingSet} at one point in its fold path, uses the
 * result for nothing but a log line, and this module is the only reader of the
 * flag. A test asserts that: it scans the engine for any other reference to
 * `workingSet` and for any use of the observer's result beyond logging.
 *
 * ## What it cannot do, by construction
 *
 * It takes a session, a measurement and read-only policy values. It does not
 * receive the engine, the candidate registry, the rebase-intent registry, or an
 * `Agent`, so it has no way to fold, to record an intent, or to run
 * `runMaintenance`. It performs no I/O and issues no LLM call: every input is a
 * value already in memory, and the only effect is the `log` callback.
 *
 * ## What it must never log
 *
 * No message text, no tool output, no checkpoint body, no bundle bytes. Every
 * field below is a NUMBER, an enum, or a fixed string this project authored —
 * so a credential or a piece of tool output cannot reach telemetry even by
 * accident, because no code path reads one. The thermal report's per-anchor
 * lines carry anchor IDS and derived reasons only; an id is EF's own identifier,
 * not user content.
 *
 * @module dsh-epistemic-fold/working-set-observer
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { EfCompactSpec, ResolvedEpistemicFoldConfig } from './policy.ts'
import { selectLeafSpan } from './leaf-policy.ts'
import { assessWorkingSet, describeWorkingSet } from './working-set.ts'
import { assessThermalResidency, describeThermal } from './thermal.ts'
import { decideShadowFolding, describeShadowDecision, shadowProfileId } from './shadow-policy.ts'
import type { FoldCurrentState } from './state.ts'

/** Everything one observation produced, for telemetry and tests. */
export interface WorkingSetObservation {
  readonly workingSet: ReturnType<typeof assessWorkingSet>
  readonly thermal: ReturnType<typeof assessThermalResidency>
  readonly shadow: ReturnType<typeof decideShadowFolding>
  /** The profile the shadow decision was priced under. */
  readonly profileId: string
  /** The rendered lines, exactly as they were logged. */
  readonly lines: readonly string[]
}

/** Options for {@link observeWorkingSet}. */
export interface ObserveWorkingSetOptions {
  readonly session: Session
  readonly measurement: TokenMeasurement
  readonly spec: EfCompactSpec
  readonly config: ResolvedEpistemicFoldConfig
  readonly provider: string
  readonly model: string
  readonly stepsSinceRootRebase: number
  /** The deterministic state, when the projection is mounted. */
  readonly state?: FoldCurrentState
  /**
   * Prices one rendered checkpoint body. The engine passes a closure over the
   * token meter; omitting it degrades the root estimate to `unknown` rather
   * than to a guess.
   */
  readonly estimateText?: (text: string) => number
  /** Where the lines go. The engine passes its own logger. */
  readonly log: (line: string) => void
  /** Label distinguishing the decision point, e.g. `pressure` or `overflow`. */
  readonly stage: string
}

/**
 * Compute and log one observation.
 *
 * @param options - the surface, the spec in force, and a log sink.
 * @returns everything computed, so a test can assert on the numbers rather than
 *   on the log text.
 */
export function observeWorkingSet(options: ObserveWorkingSetOptions): WorkingSetObservation {
  const {
    session, measurement, spec, config, provider, model,
    stepsSinceRootRebase, state, estimateText, log, stage,
  } = options
  const workingSet = assessWorkingSet({
    session,
    measurement,
    thresholdTokens: spec.thresholdTokens,
    retainTokens: spec.retainTokens,
    ...(state === undefined ? {} : { state }),
    ...(estimateText === undefined ? {} : { estimateText }),
  })
  // The fold span the decomposition measured is handed to the thermal reading,
  // so the two agree on what "the working region" is instead of each computing
  // its own idea of it.
  const leafSpan = selectLeafSpanForThermal(session, measurement, spec.retainTokens)
  const thermal = assessThermalResidency({
    session,
    ...(state === undefined ? {} : { state }),
    ...(leafSpan === undefined ? {} : { leafSpan }),
  })
  const shadow = decideShadowFolding({
    session,
    measurement,
    spec,
    config,
    stepsSinceRootRebase,
    provider,
    model,
    ...(state === undefined ? {} : { state }),
    ...(estimateText === undefined ? {} : { estimateText }),
  })
  const profileId = shadowProfileId(config, provider, model)

  const lines = [
    `[epistemic-fold] working-set (${stage}): ${describeWorkingSet(workingSet)}`,
    `[epistemic-fold] working-set (${stage}): thermal ${describeThermal(thermal)}`,
    `[epistemic-fold] working-set (${stage}): ${describeShadowDecision(shadow)} `
    + `[profile ${profileId}]`,
  ]
  for (const blocker of shadow.blockers) {
    lines.push(`[epistemic-fold] working-set (${stage}): blocked — ${blocker}`)
  }
  for (const line of lines) log(line)
  return { workingSet, thermal, shadow, profileId, lines }
}

/**
 * The fold span, in surface positions, or `undefined` when none is legal.
 *
 * A local re-derivation rather than a call into the decomposition's result: the
 * decomposition reports span SIZE, and the thermal reading needs POSITIONS. Both
 * come from `selectLeafSpan`, so they cannot disagree about which span it is.
 */
function selectLeafSpanForThermal(
  session: Session,
  measurement: TokenMeasurement,
  retainTokens: number,
): { readonly startIdx: number; readonly endIdx: number } | undefined {
  const span = selectLeafSpan(session, measurement, retainTokens)
  return span === null ? undefined : { startIdx: span.startIdx, endIdx: span.endIdx }
}
