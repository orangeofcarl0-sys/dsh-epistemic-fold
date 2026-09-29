/**
 * The DSH plugin entry (RC3): what a real harness loads.
 *
 * ## Why this is a separate file from `src/index.ts`
 *
 * `src/index.ts` is the LIBRARY surface — engine, policy, stores, recall. A
 * deployment that mounts EF into DSH needs exactly one thing from it: the
 * composite plugin CLASS. Exporting that from the library entry would put the
 * plugin's DSH service wiring into every programmatic consumer's import graph,
 * including the test harnesses that deliberately mount pieces by hand.
 *
 * So the loader resolves this file, and this file exports only the plugin.
 *
 * ## The DSH contract this satisfies
 *
 * A real plugin package declares `"main": "lib/index.js"` and is referenced from
 * a profile patch as `name: <package-name>`. The loader `import()`s that entry
 * and reads:
 *
 *  - `name` (optional) — the Cordis plugin name;
 *  - `inject` (optional) — service dependencies to await before construction;
 *  - `Config` (optional) — a Schemastery schema for the patch's `config`;
 *  - `default` or `apply` — the plugin body.
 *
 * `EpistemicFoldPlugin` already carries `static inject` and `static Config`, and
 * it is the class the loader would instantiate, so this module's whole job is to
 * surface it under the names the loader looks for. `dsh-contextvm` — the
 * third-party plugin installed in this machine's profile — is laid out the same
 * way.
 *
 * @module dsh-epistemic-fold/entry
 */

import EpistemicFoldPlugin from './plugin.ts'

/** Cordis plugin name; the loader uses it in diagnostics and row addressing. */
export const name = 'epistemic-fold'

/**
 * Services the plugin needs before it can be constructed.
 *
 * Mirrors the composite plugin's own `static inject` — the engine owns
 * `ctx.compaction`, and the state projection needs `sessionProjections`. The
 * recall tools and the `/context` command are registered CONDITIONALLY at mount
 * time (they need `ctx.tools` / `ctx.commands`), so they are deliberately not
 * listed here: requiring them would make a compaction-only deployment fail to
 * load instead of mounting without them.
 */
export const inject = EpistemicFoldPlugin.inject

/** The config schema the loader validates a patch's `config` against. */
export const Config = EpistemicFoldPlugin.Config

export { EpistemicFoldPlugin }
export default EpistemicFoldPlugin
