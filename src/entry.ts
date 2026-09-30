/**
 * The DSH entry for the bare package name `dsh-epistemic-fold` (RC7).
 *
 * ## Why this is the DOCTOR and not the plugin
 *
 * The bare package name is load-bearing, and that is not obvious. DSH's client
 * module system discovers a package's browser half by scanning the host Loader
 * for a row whose `name` is an EXACT package specifier — a bare name with no `/`:
 *
 *   exactPackageSpecifier('dsh-epistemic-fold')          -> accepted
 *   exactPackageSpecifier('dsh-epistemic-fold/doctor')   -> rejected (contains '/')
 *
 * A row named with a subpath is skipped, so the package's `client.js` never
 * reaches the browser and its Sidebar panel silently never appears. That was a
 * real RC7 regression: moving the only top-level row to `.../doctor` dropped the
 * panel, and it was found by driving the real web UI and observing that EF's
 * client module was absent from `window.__DSH_BOOT__`.
 *
 * So the bare name mounts the DOCTOR, which is:
 *
 *  - **always mounted**, so the roster always finds the package; and
 *  - **observation-only** — no service, no projection, no state — so a root-plane
 *    entry cannot reproduce the RC4-A defect (a mounted EF reporting folds it is
 *    not performing).
 *
 * The PLUGIN is deliberately NOT mounted here. In a preset-based profile it is
 * mounted per preset, inside that preset's compaction realm; mounting it at the
 * root as well would create a second engine whose surface reports on sessions it
 * never folds. Deployments with no preset plane mount `dsh-epistemic-fold/plugin`
 * explicitly.
 *
 * ## The DSH contract this satisfies
 *
 * The loader `import()`s this file and reads `name`, `inject`, `Config`, and
 * `default` or `apply`. This module surfaces the doctor under those names.
 *
 * @module dsh-epistemic-fold/entry
 */

import { apply as mountDoctor, inject as doctorInject, name as doctorName } from './doctor.ts'

/** Cordis plugin name; the loader uses it in diagnostics and row addressing. */
export const name = doctorName

/** Services the entry needs before it can be constructed. */
export const inject = doctorInject

/**
 * Mount the doctor.
 *
 * No `Config`: the doctor takes only an optional `quiet` flag, and a deployment
 * that wants the success line suppressed sets it through the row's config, which
 * Schemastery validates as a loose object rather than a strict schema.
 */
export { mountDoctor as apply }
export default mountDoctor
