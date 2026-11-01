/**
 * Every EF configuration key, in one table.
 *
 * ## Why this exists
 *
 * Adding ONE key (`rationaleHintTokens`, commit 0376ca3) took 14 registration sites across 5 files,
 * and missing one of them caused a HARD failure rather than a test failure:
 *
 *   BasicCompactionConfig: unknown key "rationaleHintTokens"
 *
 * That error came from `src/basic/config.ts`, which validates its keys strictly, and it killed every
 * economy/balanced/quality mount -- because the TIER supplies the key, so no fixture had to name it.
 *
 * ## The two dimensions, and why one list is not enough
 *
 * `presetOwned` and `efOwned` are INDEPENDENT, and conflating them is what made the failure hard to
 * see. `retainRatio` is the proof: a tier may set it (`presetOwned: true`) but it is a BASIC key, so
 * it must NOT be stripped (`efOwned: false`). Every other preset-owned key is EF's own and must be
 * stripped. One list cannot express both.
 *
 * ## What is NOT here
 *
 * This is deliberately a TABLE, not a schema framework. The interfaces stay hand-written, the
 * resolver keeps its bespoke throws, and the plugin schema keeps `z.any()` for EF's block --
 * `docs/68` declined the larger refactor because deriving the interfaces would change error text and
 * types that tests pin. What this removes is the four hand-maintained LISTS, which is where the drift
 * actually happened.
 *
 * @module dsh-epistemic-fold/ef-keys
 */

/** One EF configuration key. */
export interface EfKeySpec {
  /** The key as it appears in config. */
  readonly name: string
  /** Whether a TIER may set it (the preset ladder owns it). */
  readonly presetOwned: boolean
  /**
   * Whether EF owns it, i.e. it must be stripped before Basic validates.
   *
   * NOT the same as `presetOwned`: `retainRatio` is preset-owned and Basic-owned.
   */
  readonly efOwned: boolean
  /** The engine default, where the resolver falls back to one. */
  readonly default?: unknown
}

export const EF_KEYS: readonly EfKeySpec[] = [
  // Order matches the lists this replaces, so a report or a test that depends on it is unchanged.
  { name: 'frozenCheckpointTokenBudget', presetOwned: false, efOwned: true },
  { name: 'semanticMode', presetOwned: true, efOwned: true, default: 'rationale' },
  { name: 'semanticContinuity', presetOwned: false, efOwned: true, default: 'off' },
  { name: 'semanticWorkingSetTokens', presetOwned: false, efOwned: true, default: 1024 },
  { name: 'semanticCheckpointTokens', presetOwned: false, efOwned: true, default: 4096 },
  { name: 'semanticRoot', presetOwned: false, efOwned: true },
  { name: 'rationaleHintTokens', presetOwned: true, efOwned: true, default: 800 },
  { name: 'bundleRoot', presetOwned: false, efOwned: true },
  { name: 'leafAdmission', presetOwned: true, efOwned: true, default: 'legacy' },
  { name: 'minReclaimTokens', presetOwned: false, efOwned: true },
  { name: 'minReclaimRatio', presetOwned: false, efOwned: true },
  { name: 'rootPolicy', presetOwned: true, efOwned: true, default: 'legacy' },
  { name: 'economicsProfiles', presetOwned: false, efOwned: true },
  { name: 'cacheRealizationRate', presetOwned: false, efOwned: true },
  { name: 'paybackHorizonRequests', presetOwned: false, efOwned: true },
  { name: 'framingMode', presetOwned: true, efOwned: true, default: 'legacy' },
  { name: 'mode', presetOwned: false, efOwned: true },
  { name: 'referentialArchive', presetOwned: false, efOwned: true },
  { name: 'allowCrossSessionRecall', presetOwned: false, efOwned: true },
  { name: 'subagentRecall', presetOwned: false, efOwned: true },
  { name: 'subagentRecallThresholdChars', presetOwned: false, efOwned: true },
  { name: 'subagentRecallFetchBudgetChars', presetOwned: false, efOwned: true },
  // `retainRatio` LAST because it is the one entry that is preset-owned but NOT EF-owned: a tier
  // may set it, and it must survive the strip because Basic is the layer that validates it.
  { name: 'retainRatio', presetOwned: true, efOwned: false },
] as const

/**
 * Keys Basic must not see. Derived, so the strip list cannot fall behind the table.
 *
 * This is the list whose omission caused the mount failure, and the ONLY guard on it was a subset
 * check in the wrong direction -- see `tests/plugin-composition.spec.ts`.
 */
export const EF_OWNED_CONFIG_KEYS: readonly string[] =
  EF_KEYS.filter(key => key.efOwned).map(key => key.name)

/** Keys a tier may set, in report order. Derived from the same table. */
/**
 * Keys a tier may set, in REPORT order.
 *
 * The order is the shipped preset order rather than the table's, because the effective-config
 * report prints these and a test pins the sequence.
 */
const PRESET_REPORT_ORDER = [
  'leafAdmission', 'rootPolicy', 'semanticMode', 'rationaleHintTokens', 'framingMode', 'retainRatio',
] as const

export const PRESET_OWNED_KEYS: readonly string[] = PRESET_REPORT_ORDER.filter(name =>
  EF_KEYS.some(key => key.name === name && key.presetOwned))

/** The engine default for a key, or `undefined` when it has none. */
export function efKeyDefault(name: string): unknown {
  return EF_KEYS.find(key => key.name === name)?.default
}

