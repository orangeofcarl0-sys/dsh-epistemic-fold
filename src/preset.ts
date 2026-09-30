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
 *   balanced  + a larger verbatim recent tail   (RETENTION FIRST)
 *   quality   + a rationale checkpoint as well
 *
 * ## Why retention comes before rationale (RC2.1)
 *
 * RC2 ordered the ladder the other way: `balanced` bought the semantic face
 * (`semanticMode: rationale`, one auxiliary call per fold) and `quality` added
 * retention. That order is wrong for two reasons:
 *
 *  1. **Retention is the stronger mechanism.** A fact inside the retained tail
 *     never leaves the surface at all, so it depends on neither the checkpoint
 *     nor the model choosing to retrieve. A rationale checkpoint still has to be
 *     READ by the model, and RC1.3 measured that the marker-only economy preset
 *     already reaches parity without it.
 *  2. **Retention is the cheaper first step to justify.** It costs context on
 *     every request but no auxiliary call, and it does not add a provider round
 *     trip to every fold.
 *
 * So the cheap rung buys the stronger mechanism, and the expensive rung adds the
 * one whose measured case is weaker. That ordering is a DESIGN decision, not a
 * measurement — see each tier's `evidence` field.
 *
 * @module dsh-epistemic-fold/preset
 */

import type { EpistemicFoldConfig } from './policy.ts'

/** Every mode name the engine accepts, including the non-tier defaults. */
export type FoldModeName = 'legacy' | 'basic' | 'economy' | 'balanced' | 'quality'

/** The three tiers the PRODUCT surface exposes. */
export type TierModeName = 'economy' | 'balanced' | 'quality'

/** Every mode name, for validation and diagnostics. */
export const FOLD_MODE_NAMES: readonly FoldModeName[] = ['legacy', 'basic', 'economy', 'balanced', 'quality']

/** The tier names, in ascending cost order. */
export const TIER_MODE_NAMES: readonly TierModeName[] = ['economy', 'balanced', 'quality']

/**
 * The mode that makes EF stand aside (RC7).
 *
 * `basic` is NOT a tier and is not offered by `/context mode`: it is the
 * install-time opt-out. Under it EF delegates every fold to its own vendored
 * copy of Basic and registers none of its own surface — no state projection, no
 * status projection, no recall tools, no `/context` command. A session under
 * `mode: basic` is indistinguishable from one where EF is not installed.
 *
 * The distinction from `legacy` matters and is easy to miss:
 *
 *   legacy  EF's own default policy, marker-only checkpoints, EF's frontier.
 *   basic   EF standing aside entirely; Basic's checkpoints, Basic's surface.
 *
 * `legacy` exists because the engine must do something when no mode is named;
 * `basic` exists because a user must be able to say "not this — the native one".
 */
export const BASIC_MODE: FoldModeName = 'basic'

/** Whether a mode makes EF stand aside entirely. */
export function isBasicMode(mode: FoldModeName): boolean {
  return mode === BASIC_MODE
}

/**
 * Narrow a mode name to a TIER, so the tier table can be indexed safely.
 *
 * `legacy` and `basic` are modes but not tiers: neither appears in `TIERS`.
 * Stating that as a type predicate is what lets the resolvers below branch once
 * and then index without a cast.
 */
export function isTierMode(mode: FoldModeName): mode is TierModeName {
  return mode !== 'legacy' && mode !== BASIC_MODE
}

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
 * The retention ratio the `balanced` rung raises to.
 *
 * 1.5x the engine default of 0.16. `resolveEfCompactSpec` refuses a
 * configuration whose retention reaches its own fold threshold, and retention
 * competes with the headroom reserve for the same window — so this value is
 * CHECKED against every shipped window by the tier suite rather than assumed.
 */
export const BALANCED_RETAIN_RATIO = 0.24

/**
 * How much verbatim tail the `quality` rung keeps.
 *
 * Deliberately the SAME as `balanced`: `quality` adds the semantic face on top
 * of `balanced`'s retention, so the only difference between the top two rungs is
 * the rationale call. If this differed, a difference between them would not be
 * attributable to the lever the tier claims.
 */
export const QUALITY_RETAIN_RATIO = BALANCED_RETAIN_RATIO

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
      // Identical to economy on admission, rebasing, framing and the semantic
      // face, so the ONLY difference between the two rungs is retention. That is
      // what makes a measured difference attributable to it.
      leafAdmission: 'economic',
      rootPolicy: 'economics',
      semanticMode: 'none',
      framingMode: 'system-dedup',
      /**
       * Keep a larger recent tail verbatim (1.5x the engine default of 0.16).
       *
       * The FIRST steadiness lever, and the stronger one: facts inside the
       * retained tail never leave the surface, so they depend on neither the
       * checkpoint nor the model choosing to retrieve. It costs context on every
       * request, but no auxiliary call and no extra provider round trip per fold.
       */
      retainRatio: BALANCED_RETAIN_RATIO,
    },
    summary: 'A small premium for a larger verbatim tail',
    intent: 'Work where losing the thread costs more than carrying more context',
    steadinessMechanism:
      'a larger verbatim recent tail, so more facts never leave the surface at all '
      + 'and depend on neither the checkpoint nor recall',
    evidence: 'hypothesis',
    evidenceDetail:
      'No live measurement. The mechanism is supported by the engine (retention is '
      + 'a tested policy key) but the END-TO-END steadiness benefit is unmeasured. '
      + 'RC2.1 ran the one critical A/B for it — economy vs balanced, retention '
      + 'isolated — and reports the result.',
  },
  quality: {
    name: 'quality',
    values: {
      leafAdmission: 'economic',
      rootPolicy: 'economics',
      /**
       * The SECOND steadiness lever, added on top of `balanced`'s retention.
       *
       * A rationale checkpoint carries the conversation's own words, so a fact
       * does not depend on the model choosing to retrieve it. RC1.2-C priced the
       * call from its real size; RC1.2-B proved both semantic modes can recover
       * folded facts. What is NOT measured is whether paying for it improves
       * end-to-end steadiness — and RC1.3 found economy already reaches parity
       * without it, which weakens rather than supports the case.
       */
      semanticMode: 'rationale',
      framingMode: 'system-dedup',
      // The SAME retention as `balanced`, so the top two rungs differ only in
      // the semantic face and a difference between them is attributable to it.
      retainRatio: QUALITY_RETAIN_RATIO,
    },
    summary: 'A larger premium for a larger tail AND narrative checkpoints',
    intent: 'Long-horizon work where a lost detail is expensive to rediscover',
    steadinessMechanism:
      'a larger verbatim tail AND narrative checkpoints, so facts are protected both '
      + 'on the surface and across a fold',
    evidence: 'hypothesis',
    evidenceDetail:
      'No live measurement. Composed of two supported capabilities; neither the '
      + 'combined nor the individual steadiness benefit has been measured, and the '
      + 'rationale half carries an auxiliary call per fold plus the retention cost '
      + 'on every request.',
  },
}

/**
 * Resolve a mode name into a config, WITHOUT overriding anything explicit.
 *
 * @param mode - the requested mode name.
 * @param explicit - the user's own configuration.
 * @returns `explicit` with the tier's values filled in for keys the user did
 *   not supply. For `legacy` and `basic` this is `explicit` unchanged: neither
 *   is a tier. `legacy` is the engine's own default; `basic` makes EF stand
 *   aside, so there is nothing for it to fill in.
 */
export function resolvePreset(
  mode: FoldModeName,
  explicit: EpistemicFoldConfig = {},
): EpistemicFoldConfig {
  if (!isTierMode(mode)) return { ...explicit }
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
 * @returns that tier's exact settings, or `{}` for a non-tier mode.
 */
export function tierValuesFor(mode: FoldModeName): Readonly<Record<string, unknown>> {
  if (!isTierMode(mode)) return {}
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
  if (!isTierMode(mode)) return []
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
