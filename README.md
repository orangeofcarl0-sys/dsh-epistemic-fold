# Epistemic Fold

> **Epistemic Fold for DeepSeek Harness**
> *A contract-preserving context runtime for long-horizon agents.*

[English](README.md) · [中文](README.zh.md)

## What is this?

Epistemic Fold (EF) is a compaction backend plugin for the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that treats
conversation history, memory, and working context as three different things:

```
History ≠ Memory ≠ Context
```

Its core principle:

> **An agent may fold a trajectory out of the working context only after its
> externally relevant epistemic effects have been materialized, preserved, and
> made recoverable.**

Concretely, when the runtime folds a span of conversation it

1. **archives the exact model-visible messages** into an immutable, hash-verified
   `CheckpointBundle` *before* any lossy surface replacement commits
   (`BundleDurable ≺ SurfaceLoss`);
2. **never re-folds what is already frozen** — a monotonically advancing
   *Fold Frontier* separates frozen checkpoints from the open trajectory, so the
   cached prefix stays byte-stable across folds;
3. **derives the current state deterministically from raw session events** —
   objectives, constraints, decisions, values, evidence, failures, and
   obligations — with full provenance and a hard rule that narrative summaries
   can never verify state (`Raw Events → State` and `Raw Events → Summary` run
   in parallel; `Raw → Summary → State` is forbidden);
4. **recovers exactly** — `context_search` / `context_recall` serve bounded,
   paginated, provenance-checked recall of anything that left the working set.

The optimization goal is not maximal compression. It is correctness first —
then information density, prefix-cache locality, long-horizon state
consistency, and stable closed-loop continuation.

## Status

Research implementation against **DeepSeek Harness `0.1.7-rc.2`**
(verified baseline `477b4f420553e8a52c2fbccc464d7561b239c443`).

| Milestone | Scope | Gate |
|---|---|---|
| **M0** | Exact archive / recall closure, atomic bundle store, deterministic fallback | ✅ C0.1–C0.5 |
| **M2** | Fold Frontier, leaf/root folds, prefix fingerprint proofs | ✅ C2.1–C2.4 |
| **M3a** | Deterministic current state (anchors, authority, projection) | ✅ ALR=0 · SSR=0 · provenance=100% · bounded |

M1 (verified ingress reduction), M3b (negative knowledge / uncertainty),
M4 (dependency graph) and beyond are **deliberately not implemented** — each
requires observed failure evidence from benchmarks first (see
[05_EF_DECISIONS_AND_OPEN_QUESTIONS.md](05_EF_DECISIONS_AND_OPEN_QUESTIONS.md),
section F).

Paired-baseline evidence (identical history through DSH Basic vs EF): EF
invalidates **15% fewer prefix tokens** over the measured run, with the gap
growing per fold — every Basic fold rewrites the whole prefix, EF only ever
compacts past the frontier (see [06_FINAL_REPORT.md](06_FINAL_REPORT.md)).

## Development

This repository is a standalone plugin source tree. Tests run the vendored DSH
**sources** directly (the same source-level resolution the DSH monorepo uses),
so no build of the plugin itself is needed.

Prerequisites: Node `^22.19 || >=24`, pnpm `11.7.x`, npm.

```bash
# 1. Vendor the DSH monorepo at the verified baseline
git clone https://github.com/deepseek-ai/deepseek-harness.git vendor/deepseek-harness
cd vendor/deepseek-harness
git checkout 477b4f420553e8a52c2fbccc464d7561b239c443
pnpm install

# 2. Build declaration output for the packages EF consumes
node --max-old-space-size=8192 ./node_modules/typescript/bin/tsc -b \
  packages/compaction/compaction-basic packages/core/tools packages/util/atomic-write

# 3. Back in the plugin repo: install tooling and (re)generate the
#    src/type resolution maps into vitest.config.ts + tsconfig.json
cd ../..
npm install
node scripts/generate-maps.cjs

# 4. Run everything
npx vitest run                     # 49 tests across 5 suites
npx tsc --noEmit -p tsconfig.json  # type check against vendor declarations
```

`scripts/generate-maps.cjs` extracts the `@deepseek-ai/*` path table from the
vendored monorepo and emits two maps: `scripts/vendor-paths.json` (sources,
consumed by the vitest alias table) and `scripts/vendor-types-paths.json`
(built declarations, consumed by tsconfig). Re-run it after rebasing the
vendor clone onto a new DSH version.

## Repository layout

```
src/
  engine.ts        EpistemicFoldEngine — Basic's transaction + EF compile hook
  policy.ts        plugin config resolution + routed-model pressure math
  candidate.ts     pending fold-candidate identity (single slot per session)
  bundle-store.ts  FileBundleStore — atomic, hash-verified, 0600 permissions
  compiler.ts      input splitting, canonical bundle build, checkpoint rendering
  frontier.ts      Fold Frontier: locate/re-derive from the CURRENT surface
  leaf-policy.ts   [frontier+1, bestEnd] span selection + frozen budget load
  root-policy.ts   root rebase advisories (manual /compact = Root Fold)
  state.ts         deterministic StateReducer: anchors, supersession, lifecycles
  authority.ts     which event kinds may ground which authority domains
  projection.ts    wires the reducer into ctx.sessionProjections
  renderer.ts      structured checkpoint: Current/Evidence/Open/Rationale/Recall
  recall.ts        context_search + context_recall (bounded, paginated, exact)
  tools.ts         registers the recall tools against ctx.tools
  hash.ts          canonical JSON + SHA-256 digests
tests/             M0/M2/M3a suites + shared harness (controlled LLM adapter)
bench/             paired-baseline harness (Basic vs EF prefix economics)
```

## Design docs

| Document | Contents |
|---|---|
| [00_README_EF.md](00_README_EF.md) | Project entry: naming, goals, nine core invariants |
| [01_EF_RFC_001_ARCHITECTURE.md](01_EF_RFC_001_ARCHITECTURE.md) | Architecture spec: truth model, data structures, fold transactions |
| [02_EF_IMPLEMENTATION_PLAN_M0_M3.md](02_EF_IMPLEMENTATION_PLAN_M0_M3.md) | Engineering DAG, gates, stop conditions |
| [03_EF_TEST_BENCHMARK_SPEC.md](03_EF_TEST_BENCHMARK_SPEC.md) | Metrics (ALR/SSR/DWR/CR/PMA), test suites, benchmark arms |
| [04_EF_LOCAL_AGENT_WORK_ORDER.md](04_EF_LOCAL_AGENT_WORK_ORDER.md) | Execution order and prohibitions for an implementation agent |
| [05_EF_DECISIONS_AND_OPEN_QUESTIONS.md](05_EF_DECISIONS_AND_OPEN_QUESTIONS.md) | Frozen decisions, hypotheses, open questions |
| [06_FINAL_REPORT.md](06_FINAL_REPORT.md) | Final implementation report: gates, evidence, deviations, refactor record |

## License

[MIT](LICENSE)
