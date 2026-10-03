/**
 * Types for {@link ./framing-seam.mjs}.
 *
 * The module is plain JavaScript because it is consumed by two Node scripts
 * (`vendor-basic.mjs`, `apply-framing-seam.mjs`) as well as by a test, and those
 * scripts run without a build step. The main `tsconfig.json` does not enable
 * `allowJs`, so a test importing it would otherwise fail with TS7016 —
 * "implicitly has an 'any' type".
 *
 * This declaration is hand-written to match the module rather than generated:
 * the surface is two constants and one function, and a generator for that would
 * be more machinery than the thing it describes.
 */

/** One exact text edit, with the anchor that proves the source has not drifted. */
export interface SeamEdit {
  /** The module the edit belongs to. */
  readonly module: string
  /** Text proving the edit already landed. */
  readonly marker: string
  /** The exact upstream text to replace. */
  readonly find: string
  /** What it becomes. */
  readonly replace: string
}

/** The exact edits EF's vendored Basic copy carries. */
export declare const SEAM_EDITS: readonly SeamEdit[]

/** The upstream files the copy carries, in dependency order. */
export declare const SEAM_MODULES: readonly string[]

/**
 * Apply every seam edit for one module, verifying each anchor is present.
 *
 * Idempotent: an edit whose marker is present and whose anchor is gone is
 * already applied and is skipped.
 *
 * @param text the module source, already stripped of its doc comment.
 * @param module the module name.
 * @returns the patched source.
 * @throws when an anchor is missing, which means the upstream source drifted.
 */
export declare function applySeam(text: string, module: string): string
