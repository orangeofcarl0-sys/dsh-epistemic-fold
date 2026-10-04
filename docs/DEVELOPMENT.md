# Epistemic Fold Development Guide

## 1. Prerequisites

- Node `^22.19 || >=24`
- pnpm `11.7.x`
- npm
- a local checkout of DeepSeek Harness for source-level tests

The repository intentionally does not commit the DSH vendor tree.

## 2. Prepare the DSH baseline

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git vendor/deepseek-harness
cd vendor/deepseek-harness
git checkout 477b4f420553e8a52c2fbccc464d7561b239c443
pnpm install
```

Build declarations for the DSH packages used by EF:

```bash
node --max-old-space-size=8192 ./node_modules/typescript/bin/tsc -b \
  packages/compaction/compaction-basic \
  packages/core/tools \
  packages/util/atomic-write
```

Back in the plugin repository:

```bash
npm install
node scripts/generate-maps.cjs
```

## 3. Main checks

```bash
npm test
npm run typecheck:all
npm run build
npm run preflight
```

Do not hardcode the test count in documentation. The suite changes frequently; the command output is authoritative.

## 4. Evaluation commands

Keyless evaluation:

```bash
npm run eval:keyless
npm run eval:r1
npm run eval:r2
npm run eval:r3
npm run eval:r4
npm run eval:rc0
npm run eval:rc1
```

Live routes are opt-in and should skip when a route/credential is unavailable rather than silently passing.

Examples:

```bash
EF_LIVE=1 npm run eval:r1-live
EF_LIVE=1 npm run eval:r4-live
```

Treat live measurements as route-specific. Provider cache behavior and pricing can materially change results.

## 5. External benchmark lanes

The repository has integration work for:

- τ²-Bench-Verified — interaction/state reliability;
- LHTB — sustained long-horizon work;
- LongMemEval-V2 — planned/limited by local reader/embedder hardware.

External benchmark results should keep the benchmark's native score as the headline. EF-specific telemetry explains failures; it does not redefine the benchmark outcome.

### τ²

τ² is useful for interaction non-regression, but the current selected tasks can finish before EF's fold threshold. A zero-fold result is evidence about integration/pre-fold behavior, not about the quality of EF compaction.

### LHTB

LHTB reaches the actual fold regime and is therefore the more direct long-work benchmark. It is resource-heavy; run one cell at a time on constrained machines.

Before comparing modes, calibrate the local agent stack under Basic. A published model score from another agent scaffold is not a local discriminator guarantee.

## 6. Parallel evaluation

Parallel execution is useful for quality/reliability studies.

Do not reuse high-concurrency runs as realized-cost evidence unless provider cache isolation is explicitly controlled. Similar parallel requests can warm each other's prefix cache.

Cost experiments need their own purpose guard, cache namespace/order discipline, and provider usage telemetry.

## 7. Temporary directories

Evaluation code must use the managed scratch-directory helpers rather than raw untracked `mkdtemp` directories.

Why: earlier suites accumulated tens of thousands of temp directories under the OS temp volume. The disk usage was modest, but directory-count operations became expensive and filled the constrained system volume.

Use the repository helper and release/sweep paths. The sweeper is intentionally restricted to EF-owned prefixes.

Never delete the gitignored `vendor/` tree as "temporary data": tests depend on it.

## 8. Preset generation

EF substitutes its backend into DSH's own presets.

After upgrading the DSH checkout:

```bash
node scripts/generate-presets.mjs
```

The generator rewrites only the generated region in `cordis.patch.yml`.

A boot-time doctor catches missed substitutions; a DSH upgrade must not silently leave a session on native Basic while the UI claims EF is active.

## 9. Client / Sidebar

Two TypeScript projects are intentional:

- `tsconfig.json` — server/plugin/test sources;
- `tsconfig.client.json` — the browser client face.

Run:

```bash
npm run typecheck:all
```

The client uses host-provided UI modules and is kept out of the server compilation project.

## 10. Documentation discipline

Stable product documentation:

- `README.md` / `README.zh.md`
- `docs/USER_GUIDE.md`
- `docs/ARCHITECTURE.md`
- `docs/DEVELOPMENT.md`
- `docs/README.md`

Numbered R/RC documents are evidence records.

Do not rewrite an old experimental result merely because a later experiment contradicted it. Add the correction to the later record (and, where necessary, an explicit supersession note) so the audit trail remains readable.

## 11. Evaluation discipline

Rules that emerged from repeated instrumentation failures:

- distinguish `unknown` from numeric zero;
- distinguish estimated from provider-measured values;
- distinguish task non-completion from epistemic failure;
- separate current checkpoints from lifetime folds;
- never assume a "Basic" arm is Basic—verify the mounted engine;
- ensure a probe actually crosses a fold boundary before calling it a compaction test;
- preserve raw transcripts incrementally for long jobs;
- separate quality experiments from cache-sensitive cost experiments;
- use benchmark-native graders for external benchmarks;
- prefer a null result over tuning a fixture until EF wins.

## 12. Updating dependencies

The mandatory CI lane pins the verified DSH baseline. A second compatibility lane probes newer DSH.

When changing the minimum supported DSH version, check:

1. compaction transaction semantics;
2. preset structure / generated patch;
3. ToolRuntime and command injection;
4. token-meter usage semantics;
5. browser projection and Sidebar APIs;
6. the vendored Basic compatibility backend.

`src/basic/` is a compatibility copy. Do not modify it as normal feature code.
