/**
 * Named configuration tiers: the product's three-mode surface (RC2).
 *
 * Through R3 a deployment had to set `leafAdmission`, `rootPolicy`,
 * `semanticMode`, `framingMode` and several budget knobs individually, which
 * requires understanding the internals before you can use the product. R4 §34
 * replaced that with one mode name. RC2 extends the vocabulary to the THREE
 * TIERS the product actually exposes:
 *
 *   economy    lowest cost; quality measured at parity with Basic
 *   balanced   a small premium for checkpoints that carry narrative
 *   quality    a larger premium for maximum steadiness
 *
 * `legacy` remains the engine's own default and is deliberately NOT a tier: it
 * is what the engine does when no mode is named, and it is the frozen research
 * baseline. The command surface offers the three tiers; `legacy` is reported as
 * the current mode when it is what a deployment configured.
 *
 * ## Two rules that keep a tier honest
 *
 * 1. **A tier is a named SET of values, not a branch.** There is no
 *    `if (mode === 'quality')` anywhere in the engine. `resolvePreset` produces
 *    the same flat config a user could write by hand, and the engine cannot tell
 *    the difference — so a tier can only choose among settings the engine
 *    already supports, and never becomes a second source of truth for policy.
 *
 * 2. **A tier declares what is MEASURED and what is a HYPOTHESIS.** Only
 *    `economy` has measured end-to-end evidence (RC1.3: parity with Basic at
 *    roughly a seventeenth of the cost, reproduced over two independent n=9
 *    runs). `balanced` and `quality` are composed from capabilities the engine
 *    already has, and their steadiness benefit is a DECLARED HYPOTHESIS with no
 *    live measurement behind it yet. Every tier carries that status, so no
 *    report can present an unmeasured rung as a measured one — the same rule
 *    that keeps OPEN distinct from PASS everywhere else in this project.
 *
 * The ladder varies only the levers that plausibly buy STEADINESS, and holds
 * everything else identical, so a difference between two tiers is attributable
 * to the one lever that changed:
 *
 *   economy   marker checkpoints, default retention
 *   balanced  + the checkpoint carries narrative prose
 *   quality   + a larger verbatim recent tail
 *
 * @module dsh-epistemic-fold/preset
 */

import type { EpistemicFoldConfig } from './policy.ts'

/** Every mode name the engine accepts, including the non-tier default. */
export type FoldModeName = 'legacy' | 'economy' | 'balanced' | 'quality'

/** The three tiers the PRODUCT surface exposes. */
export type TierModeName = 'economy' | 'balanced' | 'quality'

/** Every mode name, for validation and diagnostics. */
export const FOLD_MODE_NAMES: readonly FoldModeName[] = ['legacy', 'economy', 'balanced', 'quality']

/** The tier names, in ascending cost order. */
export const TIER_MODE_NAMES: readonly TierModeName[] = ['economy', 'balanced', 'quality']

/** Whether a string is a known mode name (including `legacy`). */
export function isFoldModeName(value: unknown): value is FoldModeName {
  return typeof value === 'string' && (FOLD_MODE_NAMES as readonly string[]).includes(value)
}

/** Whether a string names one of the three product tiers. */
export function isTierModeName(value: unknown): value is TierModeName {
  return typeof value === 'string' && (TIER_MODE_NAMES as readonly string[]).includes(value)
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
  'retainRatio',
] as const

type PresetKey = (typeof PRESET_KEYS)[number]

/**
 * How much live evidence stands behind a tier's claimed benefit.
 *
 * `measured` — an end-to-end live comparison exists and is cited.
 * `hypothesis` — composed from supported capabilities, benefit NOT measured.
 *
 * A tier whose benefit is a hypothesis is still shippable; what is not
 * shippable is describing it as though it were measured.
 */
export type TierEvidenceStatus = 'measured' | 'hypothesis'

/** One named tier: its values, what it claims, and what backs the claim. */
export interface TierDefinition {
  readonly name: TierModeName
  /** The policy keys this tier fills in. Never operational fields. */
  readonly values: Readonly<Partial<Record<PresetKey, unknown>>>
  /** One line a user-facing surface can show. */
  readonly summary: string
  /** What this tier is FOR, in the user's terms. */
  readonly intent: string
  /**
   * The mechanism the tier expects to buy steadiness with.
   *
   * `none` for the cheapest rung: it makes no steadiness claim at all, which is
   * exactly what "measured at parity" means — it is not trying to be steadier
   * than Basic, only cheaper.
   */
  readonly steadinessMechanism: string
  readonly evidence: TierEvidenceStatus
  /** The measurement behind the claim, or the statement that none exists. */
  readonly evidenceDetail: string
}

/**
 * The three tiers.
 *
 * `economy`'s values are EXACTLY the configuration R3-B/C measured and RC1.3
 * re-verified — the ladder's first rung must not drift from the tested policy,
 * or every cost figure attributed to it becomes wrong.
 */
export const TIERS: Readonly<Record<TierModeName, TierDefinition>> = {
  economy: {
    name: 'economy',
    values: {
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
       * narrative was advisory, so an auxiliary call is not needed to carry
       * DECLARED facts across a fold.
       */
      semanticMode: 'none',
      /**
       * No per-checkpoint preamble; the semantics live in one system-prompt
       * section. REQUIRES `ctx.systemPrompt`, and `framingModeFor` REFUSES TO
       * START without it rather than silently running the costlier framing.
       */
      framingMode: 'system-dedup',
    },
    summary: 'Lowest cost; quality measured at parity with Basic',
    intent: 'Long sessions where cost matters and retrieval is acceptable',
    steadinessMechanism: 'none — this tier makes no steadiness claim',
    evidence: 'measured',
    evidenceDetail:
      'RC1.3: un-hinted 3.00/3 n=9, matching Basic, searching 9/9; reproduced over '
      + 'two independent runs. RC1.3.1 re-ran it after the chronology change.',
  },
  balanced: {
    name: 'balanced',
    values: {
      // Identical to economy on admission, rebasing and framing, so the ONLY
      // difference between the two rungs is the semantic face. That is what
      // makes a measured difference attributable to it.
      leafAdmission: 'economic',
      rootPolicy: 'economics',
      /**
       * One auxiliary call per fold, and the checkpoint carries narrative prose.
       *
       * This is the steadiness lever: a rationale checkpoint keeps the
       * conversation's own words, so a fact does not depend on the model
       * choosing to retrieve it. RC1.2 measured the tax (priced from the call's
       * real size, not a 512-token assumption).
       */
      semanticMode: 'rationale',
      framingMode: 'system-dedup',
    },
    summary: 'A small premium for checkpoints that carry narrative',
    intent: 'Work where losing the thread costs more than an extra call per fold',
    steadinessMechanism:
      'the checkpoint itself carries narrative prose, so fewer facts depend on '
      + 'the model choosing to search',
    evidence: 'hypothesis',
    evidenceDetail:
      'No live measurement. The mechanism is supported (RC1.2-C priced the call; RC1.2-B '
      + 'proved both semantic modes recover folded facts) but the END-TO-END steadiness '
      + 'benefit is unmeasured — RC1.3 measured that economy already reaches parity '
      + 'without it, which weakens rather than supports the case for paying it.',
  },
  quality: {
    name: 'quality',
    values: {
      leafAdmission: 'economic',
      rootPolicy: 'economics',
      semanticMode: 'rationale',
      framingMode: 'system-dedup',
      /**
       * Keep a larger recent tail verbatim (1.5x the engine default of 0.16).
       *
       * The second steadiness lever: facts inside the retained tail never leave
       * the surface at all, so they depend on neither the checkpoint nor recall.
       * This is what makes the third rung more expensive in a way the second is
       * not — a bigger tail is carried on EVERY request, not once per fold.
       *
       * BOUNDED DELIBERATELY. `resolveEfCompactSpec` refuses a configuration
       * whose retention reaches its own fold threshold, and retention competes
       * with the headroom reserve for the same window. 0.24 is safe across the
       * windows this project ships profiles for, and the tier suite resolves
       * every rung against them rather than assuming it.
       */
      retainRatio: 0.24,
    },
    summary: 'A larger premium for maximum steadiness',
    intent: 'Long-horizon work where a lost detail is expensive to rediscover',
    steadinessMechanism:
      'narrative checkpoints AND a larger verbatim tail, so fewer facts ever '
      + 'leave the surface',
    evidence: 'hypothesis',
    evidenceDetail:
      'No live measurement. Composed of two supported capabilities; neither the '
      + 'combined nor the individual steadiness benefit has been measured, and the '
      + 'retention rung carries cost on every request rather than once per fold.',
  },
}

/**
 * Resolve a mode name into a config, WITHOUT overriding anything explicit.
 *
 * @param mode - the requested mode name.
 * @param explicit - the user's own configuration.
 * @returns `explicit` with the tier's values filled in for keys the user did
 *   not supply. For `legacy` this is `explicit` unchanged, because `legacy` is
 *   the engine's own default.
 */
export function resolvePreset(
  mode: FoldModeName,
  explicit: EpistemicFoldConfig = {},
): EpistemicFoldConfig {
  if (mode === 'legacy') return { ...explicit }
  const tier = TIERS[mode]
  const resolved: EpistemicFoldConfig = { ...explicit }
  // Fill by OMISSION: a key the user set is never touched, so an explicit
  // setting always wins over the tier. Only the keys THIS tier owns are
  // considered, so `economy` cannot silently acquire `quality`'s retention.
  const target = resolved as Record<string, unknown>
  for (const key of Object.keys(tier.values) as PresetKey[]) {
    if (target[key] === undefined) target[key] = tier.values[key]
  }
  return resolved
}

/**
 * The values one tier fills in, for a report or a `--print-config` surface.
 * @param mode - the tier to describe.
 * @returns that tier's exact settings, or `{}` for `legacy`.
 */
export function tierValuesFor(mode: FoldModeName): Readonly<Record<string, unknown>> {
  if (mode === 'legacy') return {}
  return { ...TIERS[mode].values }
}

/**
 * The economy preset's values.
 *
 * Kept as a named accessor because the R3/RC1 measurements are attributed to
 * this exact set; callers that mean "the measured economy arm" should say so
 * rather than reaching for the tier table.
 */
export function economyPresetValues(): Readonly<Record<string, unknown>> {
  return tierValuesFor('economy')
}

/** One key where the user's explicit value disagrees with a tier. */
export interface PresetOverride {
  readonly key: string
  readonly preset: unknown
  readonly explicit: unknown
}

/**
 * Which tier keys the user overrode, so a deployment can see where it departs
 * from the named mode. Reported, never enforced: an override is a deliberate
 * choice, not an error.
 *
 * Only keys the TIER actually sets can be overridden. A key the tier leaves to
 * the engine (retention, for the two cheaper rungs) is not an "override" when a
 * user sets it — the tier never had an opinion to disagree with.
 */
export function presetOverrides(
  mode: FoldModeName,
  explicit: EpistemicFoldConfig = {},
): readonly PresetOverride[] {
  if (mode === 'legacy') return []
  const values = TIERS[mode].values
  const target = explicit as Record<string, unknown>
  const overrides: PresetOverride[] = []
  for (const key of Object.keys(values) as PresetKey[]) {
    const value = target[key]
    if (value === undefined) continue
    if (value !== values[key]) {
      overrides.push({ key, preset: values[key], explicit: value })
    }
  }
  return overrides
}

/** One rung of the ladder, as a user-facing surface should present it. */
export interface TierSummary {
  readonly name: TierModeName
  readonly summary: string
  readonly intent: string
  readonly steadinessMechanism: string
  readonly evidence: TierEvidenceStatus
  readonly evidenceDetail: string
}

/** The ladder in ascending cost order, for a picker or a help screen. */
export function tierLadder(): readonly TierSummary[] {
  return TIER_MODE_NAMES.map(name => {
    const tier = TIERS[name]
    return {
      name: tier.name,
      summary: tier.summary,
      intent: tier.intent,
      steadinessMechanism: tier.steadinessMechanism,
      evidence: tier.evidence,
      evidenceDetail: tier.evidenceDetail,
    }
  })
}

/**
 * Render the ladder as text, marking each rung's evidence status.
 *
 * The status is printed on every rung rather than only on the unmeasured ones,
 * so a reader cannot mistake its absence for a claim.
 */
export function tierLadderToText(): string {
  const lines = ['epistemic-fold modes (ascending cost):']
  for (const tier of tierLadder()) {
    lines.push(`  ${tier.name.padEnd(9)} ${tier.summary}`)
    lines.push(`            for: ${tier.intent}`)
    lines.push(`            steadiness: ${tier.steadinessMechanism}`)
    lines.push(`            evidence: ${tier.evidence.toUpperCase()} — ${tier.evidenceDetail}`)
  }
  return lines.join('\n')
}
