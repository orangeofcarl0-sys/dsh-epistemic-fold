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

import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'

/** The DSH capability this package depends on for economy framing. */
export interface DshCapabilities {
  /** Whether `frameCheckpoint` exists as an overridable hook on the base engine. */
  readonly frameCheckpointSeam: boolean
}

/**
 * Inspect the ACTUAL base class for the seam.
 *
 * This is a single, deliberate `typeof` probe of a prototype method — the one
 * runtime check the contract permits, performed once per engine construction
 * rather than per fold. Its result is used to FAIL LOUD, never to select a
 * silent fallback, which is what separates it from the sniffing R4 §4 forbids:
 * the forbidden form picks a behavior on a missing capability; this form
 * refuses to proceed.
 *
 * @returns the capabilities present in the loaded DSH build.
 */
export function detectDshCapabilities(): DshCapabilities {
  const prototype = BasicCompactionEngine.prototype as unknown as Record<string, unknown>
  return {
    frameCheckpointSeam: typeof prototype['frameCheckpoint'] === 'function',
  }
}

/** The minimum DSH package version this build expects the seam in. */
export const REQUIRED_DSH_RANGE = '>=0.1.7-rc.2'

/**
 * Assert the DSH build supports the requested framing mode (R4 §4).
 *
 * Called once, from the engine constructor, where the request is known. The
 * rule is narrow on purpose:
 *
 * - `legacy` framing requires nothing, so it always passes. The default
 *   deployment must mount on any DSH build.
 * - `system-dedup` requires the seam, and a MISSING seam is an error, not a
 *   silent downgrade. The message names the exact remedy.
 *
 * @param requestedFramingMode - the framing mode the deployment asked for.
 * @param capabilities - what the loaded DSH build provides.
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
    'epistemic-fold: framingMode "system-dedup" requires the DSH `frameCheckpoint` seam, which '
    + `this @deepseek-ai/dsh-compaction-basic build does not provide (expected ${REQUIRED_DSH_RANGE}). `
    + 'Refusing to start rather than silently running with per-checkpoint framing: that would report '
    + 'an economy saving this deployment does not actually get. Either upgrade DSH to a build with '
    + 'the seam, apply it with `node scripts/apply-framing-seam.mjs <dsh-root>`, or set '
    + 'framingMode: "legacy" explicitly.',
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
