/**
 * R4-F: named configuration presets.
 *
 * Through R3 a deployment had to set `leafAdmission`, `rootPolicy`,
 * `semanticMode`, `framingMode`, and several budget knobs individually, which
 * requires understanding the internal mechanisms before you can use the
 * product. R4 §34 replaces that with a mode name:
 *
 *   mode: 'legacy' | 'economy'
 *
 * Two rules shape this module:
 *
 * 1. **A preset is a named SET of values, not a branch.** There is no
 *    `if (mode === 'economy')` anywhere in the engine. `resolvePreset` produces
 *    the same flat config a user could write by hand, and the engine cannot
 *    tell the difference — which is what keeps the preset honest: it can only
 *    choose among settings the engine already supports.
 *
 * 2. **An explicit setting always beats the preset.** A user who names a mode
 *    AND sets a field gets their field. This is why presets are resolved by
 *    omission: a key the user supplied is never overwritten.
 *
 * `reliability` is deliberately NOT offered yet (R4 §34). W2 is called the
 * reliability region, but there is no live evidence establishing what the best
 * reliability configuration even is — `semanticMode: 'rationale'` and a legacy
 * root are plausible, not measured. Shipping a named preset would assert a
 * conclusion the project does not have.
 *
 * @module dsh-epistemic-fold/preset
 */

import type { EpistemicFoldConfig } from './policy.ts'

/** The named configuration modes a deployment may select. */
export type FoldModeName = 'legacy' | 'economy'

/** Every mode name, for validation and diagnostics. */
export const FOLD_MODE_NAMES: readonly FoldModeName[] = ['legacy', 'economy']

/** Whether a string is a known mode name. */
export function isFoldModeName(value: unknown): value is FoldModeName {
  return typeof value === 'string' && (FOLD_MODE_NAMES as readonly string[]).includes(value)
}

/**
 * The keys a preset may supply.
 *
 * Deliberately a closed list of POLICY keys: a preset never sets an operational
 * field such as `bundleRoot`, because a mode name must not silently redirect
 * where a deployment writes its bundles.
 */
const PRESET_KEYS = [
  'leafAdmission',
  'rootPolicy',
  'semanticMode',
  'framingMode',
] as const

/** The values `economy` fills in. */
const ECONOMY_PRESET = {
  /**
   * Fold only when the fold actually reclaims enough to be worth its
   * checkpoint, and forbid it entirely once the frozen prefix alone is over
   * threshold — the fold-every-step loop R1 measured.
   */
  leafAdmission: 'economic',
  /** Decide a rebase by amortized break-even under the routed model's prices. */
  rootPolicy: 'economics',
  /**
   * No LLM call for a checkpoint. The machine state is authoritative and the
   * narrative was advisory; R3 measured that removing the call costs nothing
   * in quality and removes an auxiliary request per fold.
   */
  semanticMode: 'none',
  /**
   * No per-checkpoint preamble; the semantics live in one system-prompt
   * section. REQUIRES `ctx.systemPrompt` — `resolveEfConfig` falls back to
   * `legacy` framing when it is absent rather than dropping the preamble with
   * nowhere to put the explanation.
   */
  framingMode: 'system-dedup',
} as const satisfies Pick<EpistemicFoldConfig, (typeof PRESET_KEYS)[number]>

/**
 * Resolve a mode name into a config, WITHOUT overriding anything explicit.
 *
 * @param mode - the requested mode name.
 * @param explicit - the user's own configuration.
 * @returns `explicit` with the preset's values filled in for keys the user did
 *   not supply. For `legacy` this is `explicit` unchanged, because `legacy` is
 *   the engine's own default.
 */
export function resolvePreset(
  mode: FoldModeName,
  explicit: EpistemicFoldConfig = {},
): EpistemicFoldConfig {
  if (mode === 'legacy') return { ...explicit }
  const resolved: EpistemicFoldConfig = { ...explicit }
  // Fill by OMISSION: a key the user set is never touched, so an explicit
  // setting always wins over the preset.
  const target = resolved as Record<string, unknown>
  for (const key of PRESET_KEYS) {
    if (target[key] === undefined) target[key] = ECONOMY_PRESET[key]
  }
  return resolved
}

/**
 * The preset's values, for a report or a `--print-config` surface.
 * @returns the economy preset's exact settings.
 */
export function economyPresetValues(): Readonly<Record<string, unknown>> {
  return { ...ECONOMY_PRESET }
}

/** One key where the user's explicit value disagrees with a preset. */
export interface PresetOverride {
  readonly key: string
  readonly preset: unknown
  readonly explicit: unknown
}

/**
 * Which preset keys the user overrode, so a deployment can see where it
 * departs from the named mode. Reported, never enforced: an override is a
 * deliberate choice, not an error.
 */
export function presetOverrides(
  mode: FoldModeName,
  explicit: EpistemicFoldConfig = {},
): readonly PresetOverride[] {
  if (mode === 'legacy') return []
  const target = explicit as Record<string, unknown>
  const overrides: PresetOverride[] = []
  for (const key of PRESET_KEYS) {
    const value = target[key]
    if (value === undefined) continue
    if (value !== ECONOMY_PRESET[key]) {
      overrides.push({ key, preset: ECONOMY_PRESET[key], explicit: value })
    }
  }
  return overrides
}
