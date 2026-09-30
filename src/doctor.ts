/**
 * RC7-E: the always-mounted substitution doctor.
 *
 * ## Why this is a SEPARATE entry, not part of the plugin
 *
 * The first version of this check lived in `EpistemicFoldPlugin`. It could
 * never fire, and the reason is structural: EF is mounted BY the preset
 * substitution — it is a row inside each preset's compaction group. When the
 * substitution misses, EF does not mount, so a self-check inside EF never runs.
 * The check was unreachable on exactly the path it existed for. This was found
 * by booting a deliberately broken install and observing that the check's log
 * line never appeared.
 *
 * So the doctor is mounted at the TOP level, where it always runs, and it is
 * pure observation: it provides no service, registers no projection, and holds
 * no state. That is what keeps it from re-creating the RC4-A defect — a mounted
 * EF that reports while Basic folds. This entry cannot report on folds at all;
 * it reports on whether EF is INSTALLED.
 *
 * ## What it reports
 *
 * Whether any agent preset actually names `dsh-epistemic-fold`. If none does,
 * the user installed EF and is running native Basic. A patch whose target row is
 * missing only WARNS and is skipped (measured against the installed DSH's own
 * patch algorithm), so boot succeeds and nothing else says a word.
 *
 * ## What it deliberately does NOT do
 *
 * It does not repair, retry, or rewrite the preset plane. An earlier design
 * considered rewriting the loader tree at runtime; measured, that is a race
 * against boot ordering (a rewrite at 1.2s was reverted, one at 5s stuck) and it
 * can rewrite the user's `cordis.yml` with 44 KB of composed rows. A doctor that
 * says what is wrong is worth more than one that silently guesses.
 *
 * @module dsh-epistemic-fold/doctor
 */

import type { Context } from '@deepseek-ai/cordis'
import { auditPresetSubstitution } from './preset-self-check.ts'

/** Cordis plugin name; the loader uses it in diagnostics. */
export const name = 'epistemic-fold-doctor'

/**
 * Services this entry needs. `agentPresets` is NOT listed: it is absent in a
 * preset-free deployment (headless/CLI), and requiring it would make the doctor
 * fail to mount exactly where it should stay quiet.
 */
export const inject = ['loader']

/**
 * How long to wait before auditing.
 *
 * Measured, not guessed: the presets are declared by `dsh-web-app`'s own patch
 * layer, and a rewrite of that plane fired 1.2s after mount was reverted by boot
 * ordering while one fired at 5s stuck. The check only READS, so a late run is
 * harmless and an early one is the only real risk.
 */
export const CHECK_DELAY_MS = 5_000

/** Whether the doctor should log its verdict. Off for tests that assert silence. */
export interface DoctorConfig {
  readonly quiet?: boolean
}

/**
 * Mount the doctor.
 *
 * @param ctx - the host context.
 * @param config - `quiet` suppresses the success line (the failure line is never
 *   suppressed: a silent revert to Basic is the whole thing this exists to catch).
 */
export function apply(ctx: Context, config: DoctorConfig = {}): void {
  ctx.effect(() => {
    const timer = setTimeout(() => {
      try {
        const report = auditPresetSubstitution(ctx)
        // No preset registry at all: a headless/CLI deployment where EF is
        // mounted directly and there is nothing to substitute into.
        if (report === undefined) return

        if (report.landed) {
          if (config.quiet !== true) {
            const running = report.rows.filter(row => row.usesEpistemicFold).map(row => row.id)
            ctx.logger.info(
              `[epistemic-fold] substitution active in ${report.substituted} preset(s): ${running.join(', ')}`,
            )
          }
          return
        }

        ctx.logger.error(
          '[epistemic-fold] SUBSTITUTION DID NOT LAND: no agent preset names "dsh-epistemic-fold", so '
          + 'sessions are running native Basic while this package is installed. Two causes, in order of '
          + 'likelihood: (1) this DSH build\'s preset rows changed, so the generated block in this '
          + 'package\'s cordis.patch.yml no longer matches — re-run `node scripts/generate-presets.mjs` '
          + 'against this install; (2) this package is listed BEFORE @deepseek-ai/dsh-web-app in the '
          + "profile's bundle order, so its patch ran before the presets existed — reorder the bundles so "
          + 'dsh-epistemic-fold comes last. '
          + `Presets checked: ${report.rows.map(row => row.id).join(', ') || '(none registered)'}.`,
        )
      } catch (error) {
        ctx.logger.warn(`[epistemic-fold] substitution check failed: ${String(error)}`)
      }
    }, CHECK_DELAY_MS)
    // `unref` so a one-shot CLI run is not held open by this timer.
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
    return () => clearTimeout(timer)
  }, 'epistemic-fold doctor')
}

export default apply
