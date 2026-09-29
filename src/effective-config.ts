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
import { FOLD_MODE_NAMES, economyPresetValues, isFoldModeName, presetOverrides } from './preset.ts'
import type { EpistemicFoldConfig } from './policy.ts'

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
}

/** The keys the economy preset owns, in report order. */
const PRESET_OWNED = ['leafAdmission', 'rootPolicy', 'semanticMode', 'framingMode'] as const

/** Engine defaults for the preset-owned keys, so `origin` is always knowable. */
const ENGINE_DEFAULTS: Readonly<Record<string, unknown>> = {
  leafAdmission: 'legacy',
  rootPolicy: 'legacy',
  semanticMode: 'rationale',
  framingMode: 'legacy',
}

/**
 * Describe what a configuration actually resolves to.
 *
 * @param config - the deployment's configuration, as written.
 * @param capabilities - the DSH build's capabilities.
 * @returns the resolved settings, the user's overrides, and any blockers.
 */
export function describeEffectiveConfig(
  config: EpistemicFoldConfig = {},
  capabilities?: DshCapabilities,
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
    if (known && mode === 'economy') {
      // Filled by the preset; resolved here so the report needs no second pass.
      return { key, value: economyPresetValues()[key], origin: 'preset' as const }
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

  return { mode: String(mode), settings, overrides, systemDedupSupported: supported.systemDedup, blockers }
}

/**
 * Render the effective configuration for a log line or a report.
 *
 * The blockers are printed LAST and prefixed so they cannot be missed, because
 * a deployment reading this output is deciding whether it is safe to start.
 */
export function effectiveConfigToText(effective: EffectiveConfig): string {
  const lines = [`epistemic-fold effective configuration (mode: ${effective.mode})`]
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
  if (effective.blockers.length > 0) {
    lines.push('  BLOCKERS (the engine will refuse to start):')
    for (const blocker of effective.blockers) lines.push(`    - ${blocker}`)
  }
  return lines.join('\n')
}
