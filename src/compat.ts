/**
 * R4 §4: the DSH compatibility contract.
 *
 * The R3 economy result depends on ONE thing outside this package: the
 * `frameCheckpoint` seam in `@deepseek-ai/dsh-compaction-basic`. Through R3
 * that seam was applied by `scripts/apply-framing-seam.mjs` to a vendored
 * checkout — fine for research, not a deliverable. A user who installs vanilla
 * DSH and sets `framingMode: system-dedup` must not silently get NO dedup,
 * which would report an economy saving that does not exist.
 *
 * R4 §4 forbids solving this by sniffing at runtime:
 *
 *   if ((Basic as any).frameCheckpoint) ...   // FORBIDDEN
 *
 * Fragile compatibility code of that shape cannot be tested against the
 * versions it claims to support, and it fails open — the missing branch means
 * "no dedup", not "loud error". The contract is instead:
 *
 * 1. **A declared capability, checked once, at construction.** The seam's
 *    presence is a property of the DSH build, so it is verified where the
 *    engine is built, not on every fold.
 * 2. **Fails loud when `system-dedup` was requested and the seam is absent.**
 *    Silently degrading to `legacy` would leave the user believing they run
 *    economy mode while paying full framing.
 * 3. **`legacy` needs no seam at all**, so the default deployment works on any
 *    DSH build.
 *
 * @module dsh-epistemic-fold/compat
 */

import BasicCompactionEngine from './basic/index.ts'

/** The DSH capability this package depends on for economy framing. */
export interface DshCapabilities {
  /** Whether `frameCheckpoint` exists as an overridable hook on the base engine. */
  readonly frameCheckpointSeam: boolean
}

/**
 * Inspect the ACTUAL base class for the seam.
 *
 * RC7: the base class is now EF's OWN copy (`src/basic/`), so this probe reads
 * EF's code rather than the host build's. It stays because it is still the check
 * that would catch a bad vendoring — a copy that lost the seam would otherwise
 * silently run with per-checkpoint framing and report a saving it does not get.
 *
 * What changed is the consequence: the seam is no longer a property of the
 * installed DSH, so `system-dedup` mounts on ANY build. Before RC7 this probe
 * reported `false` against the released `0.2.0-rc.2`, and every tier refused to
 * start.
 *
 * @returns the capabilities present in the base class EF extends.
 */
export function detectDshCapabilities(): DshCapabilities {
  const prototype = BasicCompactionEngine.prototype as unknown as Record<string, unknown>
  return {
    frameCheckpointSeam: typeof prototype['frameCheckpoint'] === 'function',
  }
}

/**
 * How the seam is obtained, stated honestly.
 *
 * RC7: the seam is no longer obtained from the host at all. It is a line in
 * EF's own vendored base class (`src/basic/`), so no DSH build has to provide
 * it and no patch script has to be run. The constant is retained because the
 * FAIL-LOUD path below still needs to say what is missing when a vendoring is
 * broken.
 *
 * History, kept because it is the reason the copy exists: through R3 the seam
 * was applied to a vendored DSH checkout by `scripts/apply-framing-seam.mjs`,
 * and RC0-A corrected an earlier claim that `>=0.1.7-rc.2` "should" support it.
 * It does not — the released `0.2.0-rc.2` also lacks it. Every tier therefore
 * refused to mount on a real install until RC7 moved the seam inside EF.
 */
export const DSH_SEAM_PROVENANCE =
  'EF\'s vendored base class (src/basic/), which inlines the seam; '
  + 'a build missing it indicates a broken vendoring rather than a DSH limitation'

/**
 * The version range to require ONCE the seam is released upstream.
 *
 * Left `undefined` deliberately: EF no longer needs the host to provide the
 * seam, so there is no version range to assert. `assertDshCompatibility` uses
 * the capability probe and {@link DSH_SEAM_PROVENANCE} while this is undefined.
 */
export const REQUIRED_DSH_RANGE: string | undefined = undefined

/**
 * Assert the base class supports the requested framing mode (R4 §4).
 *
 * Called once, from the engine constructor, where the request is known. The
 * rule is narrow on purpose:
 *
 * - `legacy` framing requires nothing, so it always passes.
 * - `system-dedup` requires the seam, and a MISSING seam is an error, not a
 *   silent downgrade. Since RC7 the base class is EF's own copy, so this can
 *   only fail if the vendoring itself is wrong — but it must still fail loud,
 *   because the alternative is reporting an economy saving that does not exist.
 *
 * @param requestedFramingMode - the framing mode the deployment asked for.
 * @param capabilities - what the base class provides.
 * @throws when `system-dedup` was requested but the seam is absent — the exact
 *   case R4 §3 says must never silently produce "no dedup".
 */
export function assertDshCompatibility(
  requestedFramingMode: 'legacy' | 'system-dedup',
  capabilities: DshCapabilities = detectDshCapabilities(),
): void {
  if (requestedFramingMode === 'legacy') return
  if (capabilities.frameCheckpointSeam) return
  throw new Error(
    'epistemic-fold: framingMode "system-dedup" requires a `frameCheckpoint` hook on the base '
    + `compaction engine, and the one EF extends does not provide it. It comes from ${DSH_SEAM_PROVENANCE}. `
    + 'Refusing to start rather than silently running with per-checkpoint framing: that would report '
    + 'an economy saving this deployment does not actually get. Reinstall the package (a partial '
    + 'install can lose the vendored base), or set framingMode: "legacy" (or mode: "legacy") explicitly.',
  )
}

/**
 * Whether `system-dedup` can run in this build, for a preflight report.
 *
 * Distinct from {@link assertDshCompatibility}: this never throws, so a
 * diagnostic surface can say what WOULD happen without forcing the deployment
 * into the failure.
 */
export function framingModeSupported(
  capabilities: DshCapabilities = detectDshCapabilities(),
): { readonly systemDedup: boolean; readonly legacy: true; readonly reason?: string } {
  return capabilities.frameCheckpointSeam
    ? { systemDedup: true, legacy: true }
    : {
      systemDedup: false,
      legacy: true,
      reason:
        'the DSH frameCheckpoint seam is absent; `legacy` framing is available and needs no seam, '
        + 'but `system-dedup` would silently not deduplicate',
    }
}
