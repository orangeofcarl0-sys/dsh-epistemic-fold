/**
 * RC0-A: the effective-configuration surface.
 *
 * A named mode is only useful if a deployment can see what it actually
 * resolved to. `mode: economy` expands into four policy keys, one of which
 * (`framingMode`) depends on an external DSH capability — so "what did I
 * actually configure?" is not answerable from the YAML alone.
 *
 * This module answers it, and it answers it WITHOUT throwing, so a preflight
 * or `/ef-config` style surface can report a problem instead of forcing the
 * deployment into the failure. The decision to fail is still made by the
 * engine; this is the diagnostic that explains it.
 *
 * @module dsh-epistemic-fold/effective-config
 */

import { DSH_SEAM_PROVENANCE, framingModeSupported } from './compat.ts'
import type { DshCapabilities } from './compat.ts'
import { FOLD_MODE_NAMES, TIERS, isFoldModeName, isTierMode, presetOverrides, tierValuesFor } from './preset.ts'
import type { TierModeName } from './preset.ts'
import { resolveEfConfig, DEFAULT_RETAIN_RATIO } from './policy.ts'
import type { EpistemicFoldConfig } from './policy.ts'
import { triggerBreakdown, triggerBreakdownToText } from './trigger.ts'
import type { TriggerBreakdown } from './trigger.ts'

/** One resolved setting, with where it came from. */
export interface EffectiveSetting {
  readonly key: string
  readonly value: unknown
  /** `preset` when the mode supplied it, `explicit` when the user did. */
  readonly origin: 'preset' | 'explicit' | 'engine-default'
}

/** The resolved configuration plus the caveats a deployment must know. */
export interface EffectiveConfig {
  readonly mode: string
  readonly settings: readonly EffectiveSetting[]
  /** Keys the user set that differ from the preset's value. */
  readonly overrides: readonly { readonly key: string; readonly preset: unknown; readonly explicit: unknown }[]
  /** Whether `system-dedup` framing can actually run in this build. */
  readonly systemDedupSupported: boolean
  /**
   * Problems that will make the engine REFUSE to start. Reported here so a
   * preflight can surface them; the engine still throws.
   */
  readonly blockers: readonly string[]
  /**
   * The trigger arithmetic, when the routed model's capacity is known.
   *
   * `undefined` when no capacity was supplied, because the ratio/capacity
   * comparison is meaningless without a window — and reporting a breakdown
   * computed against an assumed window would be exactly the kind of confident
   * wrong answer this surface exists to prevent (RC1-A §7).
   */
  readonly trigger?: TriggerBreakdown
  /**
   * The named tier's own claim and how well backed it is (RC2).
   *
   * `undefined` for `legacy`, which is not a tier. Present for every tier so a
   * diagnostic surface reports `HYPOTHESIS` alongside the settings rather than
   * letting an unmeasured rung read as a measured one.
   */
  readonly tier?: {
    readonly name: TierModeName
    readonly summary: string
    readonly intent: string
    readonly steadinessMechanism: string
    readonly evidence: string
    readonly evidenceDetail: string
  }
}

/** The keys a tier may own, in report order. */
const PRESET_OWNED = [
  'leafAdmission',
  'rootPolicy',
  'semanticMode',
  'framingMode',
  'retainRatio',
] as const

/** Engine defaults for the tier-owned keys, so `origin` is always knowable. */
const ENGINE_DEFAULTS: Readonly<Record<string, unknown>> = {
  leafAdmission: 'legacy',
  rootPolicy: 'legacy',
  semanticMode: 'rationale',
  framingMode: 'legacy',
  retainRatio: DEFAULT_RETAIN_RATIO,
}

/**
 * Describe what a configuration actually resolves to.
 *
 * @param config - the deployment's configuration, as written.
 * @param capabilities - the DSH build's capabilities.
 * @param capacity - the routed model's window and output reservation. Supplied
 *   when known, so the report can name the binding trigger constraint (RC1-A
 *   §7); omitted, the breakdown is simply absent rather than assumed.
 * @returns the resolved settings, the user's overrides, and any blockers.
 */
export function describeEffectiveConfig(
  config: EpistemicFoldConfig = {},
  capabilities?: DshCapabilities,
  capacity?: { readonly contextWindow: number; readonly reservedCompletionTokens: number },
): EffectiveConfig {
  const mode = config.mode ?? 'legacy'
  const known = isFoldModeName(mode)
  const blockers: string[] = []

  if (!known) {
    blockers.push(
      `unknown mode ${JSON.stringify(mode)}; expected one of `
      + FOLD_MODE_NAMES.map(name => JSON.stringify(name)).join(', '),
    )
  }

  const overrides = known ? presetOverrides(mode, config) : []
  const overrideKeys = new Set(overrides.map(entry => entry.key))
  const explicit = config as Record<string, unknown>

  const settings: EffectiveSetting[] = PRESET_OWNED.map(key => {
    const value = explicit[key]
    if (overrideKeys.has(key)) return { key, value, origin: 'explicit' as const }
    if (value !== undefined) return { key, value, origin: 'explicit' as const }
    if (known && mode !== 'legacy') {
      // Filled by the tier; resolved here so the report needs no second pass.
      // Only keys the tier OWNS appear as `preset`; a key it leaves to the
      // engine must report as `engine-default`, or the report would claim the
      // tier chose a value it never mentioned.
      const tierValues = tierValuesFor(mode)
      if (key in tierValues) {
        return { key, value: tierValues[key], origin: 'preset' as const }
      }
    }
    return { key, value: ENGINE_DEFAULTS[key], origin: 'engine-default' as const }
  })

  const supported = framingModeSupported(capabilities)
  const framing = settings.find(setting => setting.key === 'framingMode')?.value
  if (framing === 'system-dedup' && !supported.systemDedup) {
    // The engine throws on this; the preflight reports it.
    blockers.push(
      'framingMode "system-dedup" requires the DSH `frameCheckpoint` seam, which this build does '
      + `not provide (${DSH_SEAM_PROVENANCE})`,
    )
  }

  // The trigger arithmetic, when the window is known. An unknown mode has no
  // resolvable policy to break down, so it is skipped rather than guessed.
  let trigger: TriggerBreakdown | undefined
  if (capacity !== undefined && known) {
    try {
      trigger = triggerBreakdown(
        resolveEfConfig(config),
        capacity.contextWindow,
        capacity.reservedCompletionTokens,
      )
    } catch {
      // A configuration whose reservation and headroom leave no message budget
      // is reported by the engine's own throw. The preflight stays descriptive.
    }
  }

  return {
    mode: String(mode),
    settings,
    overrides,
    systemDedupSupported: supported.systemDedup,
    blockers,
    ...(trigger === undefined ? {} : { trigger }),
    ...(known && isTierMode(mode) ? { tier: tierSummaryFor(mode) } : {}),
  }
}

/** One tier's user-facing claim, for the effective-config report. */
function tierSummaryFor(mode: TierModeName): NonNullable<EffectiveConfig['tier']> {
  const tier = TIERS[mode]
  return {
    name: tier.name,
    summary: tier.summary,
    intent: tier.intent,
    steadinessMechanism: tier.steadinessMechanism,
    evidence: tier.evidence,
    evidenceDetail: tier.evidenceDetail,
  }
}

/**
 * Render the effective configuration for a log line or a report.
 *
 * The blockers are printed LAST and prefixed so they cannot be missed, because
 * a deployment reading this output is deciding whether it is safe to start.
 */
export function effectiveConfigToText(effective: EffectiveConfig): string {
  const lines = [`epistemic-fold effective configuration (mode: ${effective.mode})`]
  if (effective.tier !== undefined) {
    // The claim and its backing are printed BEFORE the settings, because a
    // reader deciding whether to adopt a tier needs to know how much of it is
    // measured before reading what it resolves to.
    lines.push(`  tier: ${effective.tier.summary}`)
    lines.push(`    for: ${effective.tier.intent}`)
    lines.push(`    steadiness: ${effective.tier.steadinessMechanism}`)
    lines.push(`    evidence: ${effective.tier.evidence.toUpperCase()} — ${effective.tier.evidenceDetail}`)
  }
  for (const setting of effective.settings) {
    lines.push(`  ${setting.key} = ${JSON.stringify(setting.value)}  [${setting.origin}]`)
  }
  if (effective.overrides.length > 0) {
    lines.push('  explicit overrides of the preset:')
    for (const override of effective.overrides) {
      lines.push(`    ${override.key}: preset ${JSON.stringify(override.preset)} -> ${JSON.stringify(override.explicit)}`)
    }
  }
  lines.push(`  system-dedup framing available: ${effective.systemDedupSupported ? 'yes' : 'no'}`)
  if (effective.trigger !== undefined) {
    lines.push('  fold trigger (who controls compaction):')
    for (const line of triggerBreakdownToText(effective.trigger).split(String.fromCharCode(10))) {
      lines.push(line)
    }
  }
  if (effective.blockers.length > 0) {
    lines.push('  BLOCKERS (the engine will refuse to start):')
    for (const blocker of effective.blockers) lines.push(`    - ${blocker}`)
  }
  return lines.join('\n')
}
