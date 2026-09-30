/**
 * RC7-E: the preset self-check — turns a silent substitution failure into a loud one.
 *
 * ## The failure this exists to catch
 *
 * EF substitutes itself into DSH's presets through a bundle patch that RESTATES
 * each preset's whole `config` (the Loader cannot address a row nested in
 * `config.plugins`). That block is therefore version-specific: it mirrors the
 * preset rows of the DSH it was generated from.
 *
 * When the rows drift, the failure is silent. Measured against the installed
 * DSH's own patch algorithm:
 *
 *   > a patch whose target row is absent WARNS AND IS SKIPPED — boot survives.
 *
 * So a DSH upgrade that renames `compaction-basic`, or restructures the
 * compaction group, would leave the user running native Basic while EF's
 * Sidebar and `/context` still report an EF. That is the RC4-A defect class
 * (a mounted EF reporting folds it never performed), reached from a different
 * direction, on a machine we cannot see.
 *
 * ## What this does
 *
 * At mount, ask the preset registry whether ANY preset actually names
 * `dsh-epistemic-fold`. If none does, the substitution did not land: log a loud,
 * actionable error. The plugin does NOT fail the mount — a user with a working
 * Basic should not lose their harness because EF's patch missed — but the
 * condition is never silent.
 *
 * ## Why it reads the registry rather than the loader tree
 *
 * The registry's `definitions` map holds each preset's declared rows, which is
 * the same data the Loader composed. Reading it needs no service beyond
 * `agentPresets`, and the check is therefore a pure read of facts the host
 * already published.
 *
 * @module dsh-epistemic-fold/preset-self-check
 */

import type { Context } from '@deepseek-ai/cordis'

/** The plugin name a substituted row carries. */
const EF_PLUGIN_NAME = 'dsh-epistemic-fold'

/** One preset's verdict. */
export interface PresetSubstitutionRow {
  readonly id: string
  /** Whether this preset's compaction backend is EF. */
  readonly usesEpistemicFold: boolean
  /** Whether this preset declares a compaction group at all. */
  readonly hasCompactionGroup: boolean
}

/** The outcome of the substitution audit. */
export interface PresetSubstitutionReport {
  /** One row per registered preset, in registry order. */
  readonly rows: readonly PresetSubstitutionRow[]
  /** How many presets run EF. */
  readonly substituted: number
  /** Presets that declare a compaction group but do NOT run EF. */
  readonly missed: readonly string[]
  /**
   * Whether the substitution landed anywhere.
   *
   * `false` is the loud condition: EF is mounted but no preset runs it, which
   * means the user is on native Basic while EF's surface reports otherwise.
   */
  readonly landed: boolean
}

/** The minimal shape this module needs from a preset registry. */
interface RegistryLike {
  readonly definitions?: Map<string, { config?: { plugins?: readonly unknown[] } }>
}

/**
 * Audit every registered preset for the EF substitution.
 *
 * Pure: reads the registry and returns a report. Separated from the logging
 * wrapper so a test can assert the verdict without capturing log output.
 *
 * @param ctx - the mounted context.
 * @returns the report, or `undefined` when no preset registry is mounted (a
 *   preset-free deployment such as headless/CLI, where this check does not apply).
 */
export function auditPresetSubstitution(ctx: Context): PresetSubstitutionReport | undefined {
  // `ctx.get` on an undeclared service throws in cordis; `agentPresets` is
  // optional here because a compaction-only deployment has no preset plane.
  let registry: RegistryLike | undefined
  try {
    registry = ctx.get('agentPresets') as RegistryLike | undefined
  } catch {
    return undefined
  }
  if (registry?.definitions === undefined) return undefined

  const rows: PresetSubstitutionRow[] = []
  for (const [id, record] of registry.definitions) {
    const plugins = record.config?.plugins ?? []
    const group = plugins.find(row => isCompactionGroup(row))
    if (group === undefined) {
      // `minimal` is the real case: it ships with no compaction group, and EF
      // deliberately leaves it alone. Not a miss.
      rows.push({ id, usesEpistemicFold: false, hasCompactionGroup: false })
      continue
    }
    const backend = compactionBackendName(group)
    rows.push({
      id,
      usesEpistemicFold: backend === EF_PLUGIN_NAME,
      hasCompactionGroup: true,
    })
  }

  const missed = rows.filter(row => row.hasCompactionGroup && !row.usesEpistemicFold).map(row => row.id)
  const substituted = rows.filter(row => row.usesEpistemicFold).length
  return { rows, substituted, missed, landed: substituted > 0 }
}

/** Whether one declared row is the compaction group. */
function isCompactionGroup(row: unknown): boolean {
  return typeof row === 'object' && row !== null && (row as { id?: unknown }).id === 'compaction'
}

/** The `name:` of the group's compaction backend row, if it declares one. */
function compactionBackendName(group: unknown): string | undefined {
  const children = (group as { config?: unknown }).config
  if (!Array.isArray(children)) return undefined
  for (const child of children) {
    if (typeof child !== 'object' || child === null) continue
    const entry = child as { id?: unknown; name?: unknown }
    if (entry.id === 'compaction-basic' && typeof entry.name === 'string') return entry.name
  }
  return undefined
}

/**
 * Audit the substitution and log loudly when it did not land.
 *
 * The message names the two likely causes, because both are actionable and
 * neither is guessable from "EF is idle": a DSH upgrade changed the preset rows,
 * or EF is listed before `@deepseek-ai/dsh-web-app` in the profile's bundle
 * order so its patch ran before the presets existed.
 *
 * @param ctx - the mounted context.
 * @returns the report, or `undefined` when the check does not apply.
 */
export function reportPresetSubstitution(ctx: Context): PresetSubstitutionReport | undefined {
  const report = auditPresetSubstitution(ctx)
  if (report === undefined) return undefined

  if (report.landed) {
    const running = report.rows.filter(row => row.usesEpistemicFold).map(row => row.id)
    ctx.logger.info(
      `[epistemic-fold] preset substitution active in ${report.substituted} preset(s): ${running.join(', ')}`,
    )
    return report
  }

  // NOT LANDED. EF is mounted, so a user could reasonably believe it is folding
  // — while native Basic does the work. Say so, and say what to do.
  ctx.logger.error(
    '[epistemic-fold] PRESET SUBSTITUTION DID NOT LAND: no agent preset names '
    + `"${EF_PLUGIN_NAME}", so sessions are running native Basic while EF's surface reports otherwise. `
    + 'Two causes, in order of likelihood: (1) this DSH build\'s preset rows changed and the generated '
    + 'block in cordis.patch.yml no longer matches — re-run `node scripts/generate-presets.mjs`; '
    + '(2) this package is listed BEFORE @deepseek-ai/dsh-web-app in the profile\'s bundle order, so its '
    + 'patch was applied before the presets existed — reorder the bundles so dsh-epistemic-fold comes last. '
    + `Presets checked: ${report.rows.map(row => row.id).join(', ') || '(none registered)'}.`,
  )
  return report
}
