/**
 * Hand-written type face for the vendored JSONL persistence backend.
 *
 * `scripts/vendor-types-paths.json` maps `@deepseek-ai/*` onto BUILT declaration
 * output, and CI builds declarations for three DSH packages only
 * (`.github/workflows/ci.yml` → `tsc -b compaction-basic core/tools
 * atomic-write`), so `session-persistence-jsonl` has none and the generated
 * tsconfig `paths` map cannot contain it. Runtime resolution is unaffected —
 * `scripts/vendor-paths.json` aliases the package to the vendored source for
 * vitest — so only the type face is missing.
 *
 * `tests/persistence-compat.spec.ts` mounts the real backend because a
 * write → close → reopen is the only way to observe the persistence contract;
 * this declares just the default export it needs. Same pattern as
 * `scripts/framing-seam.d.mts`.
 */
declare module '@deepseek-ai/dsh-session-persistence-jsonl' {
  /** The backend's plugin entry, mounted through `ctx.plugin`. */
  const plugin: import('@deepseek-ai/cordis').Plugin
  export default plugin
}
