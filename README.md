# Epistemic Fold

[![CI](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/actions/workflows/ci.yml/badge.svg)](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/orangeofcarl0-sys/dsh-epistemic-fold?sort=semver)](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.1.7--rc.2-4b5563.svg)](#ci)
[![docs](https://img.shields.io/badge/docs-guide-4b5563.svg)](docs/README.md)

> A contract-preserving context runtime for long-horizon agents on the DeepSeek Harness.

[中文](README.zh.md) · [Documentation](docs/README.md) · [User guide](docs/USER_GUIDE.md) · [Architecture](docs/ARCHITECTURE.md)

## Why Epistemic Fold?

Long-running agents eventually need to make room in their working context. A normal compactor can summarize old turns, but a summary is a lossy representation: facts can drift, old values can look current, and details needed much later may disappear.

Epistemic Fold (EF) treats three things as different objects:

```text
History ≠ Memory ≠ Context
```

A fold removes history from the **active model surface**, not from the canonical record. Before a lossy surface replacement commits, EF stores the exact model-visible messages in a durable, hash-verified bundle. It then keeps a compact checkpoint in the prompt and exposes bounded search/recall when exact history is needed.

```text
DSH Session / tool results
          │
          ▼
   exact fold archive ───────────────┐
          │                          │
          ▼                          │
 deterministic state                │
 + compact checkpoint               │
          │                          │
          ▼                          │
    active context                  │
          │                          │
          └──── context_search / context_recall
```

The goal is not the highest possible compression ratio. The goal is to preserve the contracts a long-running agent depends on, then optimize context size, cache locality, and cost.

## What EF provides

- **Exact archive before loss** — folded messages are persisted before the working surface is replaced.
- **Fold Frontier** — normal folds advance a monotonic boundary; already-frozen history is not repeatedly summarized.
- **Deterministic state** — current constraints, values, failures, obligations, and related state can be represented separately from narrative summaries.
- **Bounded exact recall** — `context_search` locates folded history; `context_recall` returns provenance-backed pages.
- **Leaf and root folds** — cheap incremental maintenance plus occasional rebasing when justified.
- **Three operating tiers** — Economy, Balanced, and Quality use the same engine with different cost/steadiness trade-offs.
- **Human-facing observability** — `/context status` and the Sidebar panel report context pressure, archive size, folds, recall activity, and measured/estimated cost without entering model context.
- **Native Basic fallback** — `mode: basic` makes EF stand aside and delegates compaction to a byte-identical vendored Basic backend.

## Install

The release tarball is the simplest pinned installation because it already contains the built `lib/` — nothing runs `prepare`, no `allowBuilds` entry is needed, and you get exactly the code the release notes describe.

```bash
dsh plugin --profile <name> add file:/path/to/dsh-epistemic-fold-0.1.0.tgz
```

A pinned git tag also works:

```bash
dsh plugin --profile <name> add github:orangeofcarl0-sys/dsh-epistemic-fold#v0.1.0
```

> **A bare `github:owner/repo` spec follows the default branch, not the release.**
> `dsh plugin` never queries the GitHub Releases API: it hands the spec to pnpm,
> which resolves the bare form to the TIP of the default branch and only pins when
> the spec carries `#<tag-or-commit>` — observed as a `codeload.github.com` tarball
> URL ending in the resolved commit sha. Drop the `#v0.1.0` deliberately if you
> want unreleased work, never by accident.

For a local checkout:

```bash
npm install
npm run preflight
```

Then add the checkout to the DSH profile as a `file:` dependency. The `file:` channel does **not** run the build — measured, pnpm skips `prepare` for path dependencies — so `npm install` first, or the install copies a directory whose `main` does not exist. `npm run preflight` catches that before you install.

EF substitutes itself into DSH's `standard`, `ptc`, and `cordis` presets. `minimal` is left unchanged. Bundle order matters: `dsh-epistemic-fold` must come **after** `@deepseek-ai/dsh-web-app` so the preset substitution has something to patch.

A minimal profile shape is:

```jsonc
{
  "dependencies": {
    "dsh-epistemic-fold": "file:/path/to/dsh-epistemic-fold"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-epistemic-fold"
      ]
    }
  }
}
```

See the [user guide](docs/USER_GUIDE.md) for install channels, verification, troubleshooting, and upgrade details. The low-level deployment matrix is kept in [docs/42_DEPLOYMENT_CHAIN.md](docs/42_DEPLOYMENT_CHAIN.md).

## Use

### Modes

EF exposes three user-facing tiers. `legacy` and `basic` are compatibility modes, not tiers.

| mode | behavior | evidence |
| --- | --- | --- |
| `economy` | default retention, no per-fold rationale call; older history is recovered on demand | measured on targeted retrieval and integration tests |
| `balanced` | Economy + a larger verbatim recent tail | mechanism-backed; steadiness benefit not yet established |
| `quality` | Balanced + narrative rationale checkpoints | mechanism-backed; highest cost, benefit not yet established |
| `legacy` | EF engine defaults; frozen compatibility baseline | compatibility |
| `basic` | EF stands aside; native Basic behavior and no EF surface | compatibility |

Configure a startup mode:

```yaml
- name: dsh-epistemic-fold
  config:
    bundleRoot: <profile persistence root>/epistemic-fold
    mode: economy
```

Switch a running EF tier:

```text
/context mode economy
/context mode balanced
/context mode quality
```

`legacy` and `basic` are selected by configuration rather than the runtime tier switch.

### Inspect a session

```text
/context status
/context line
```

The status surface distinguishes **measured**, **estimated**, and **unknown** values. Unknown is never rendered as a fabricated zero.

The Sidebar panel reads the same structured status projection as `/context status`; it is an observation surface only and never enters the model prompt.

### Recall folded history

EF registers two model tools when a DSH ToolRuntime is present:

- `context_search` — find relevant folded checkpoints and bounded verbatim excerpts.
- `context_recall` — recover summary or exact archived messages from a checkpoint.

Search results are ordered by conversation chronology rather than wall-clock time, and exact recall is provenance-backed.

## How folding works

A normal **Leaf Fold** compacts only the open trajectory after the current Fold Frontier:

```text
[frozen checkpoints] | frontier | [open trajectory]
                                      │
                                      └── leaf fold
```

The fold transaction:

1. selects a legal closed span;
2. writes its exact messages to the bundle store;
3. derives the checkpoint/state representation;
4. commits the surface replacement;
5. advances the frontier.

A **Root Fold** rebases a larger frozen surface when policy says the recurring carry cost justifies the cache disruption. Root folding is intentionally rare.

Anything removed from the active surface remains recoverable from the bundle store.

## Current evidence

EF keeps product claims separate from research hypotheses.

| area | status |
| --- | --- |
| bundle durability, exact archive and recall | **closed / machine verified and production exercised** |
| Fold Frontier and leaf/root transaction behavior | **closed / measured** |
| retrieval ergonomics and temporal ordering | **closed on the current contract** |
| real DSH plugin mounting, preset substitution, commands, Sidebar | **verified** |
| `economy` retrieval quality on targeted probes | **measured** |
| `balanced` / `quality` steadiness advantage | **not established** |
| route-level realized cost superiority | **open; provider/cache dependent** |
| τ²-Bench integration | **complete; no tier separation observed before folding** |
| LHTB integration | **environment/bridge verified; arm comparison pending** |

The research archive is intentionally preserved. Later reports often correct earlier ones instead of rewriting history. See [docs/README.md](docs/README.md) for the map.

## Important current limitation: state ownership

EF has a normalized state vocabulary, but it does **not** claim to own every source of agent state.

- goals remain owned by DSH goal state;
- plans remain owned by the todo/planning system;
- project guidance remains in `AGENTS.md` and the instruction loader;
- failed tool results are the only automatic production state producer currently derived by EF;
- the other anchor kinds are representable, but there is no general production producer for them.

Custom `ef/anchor` durable writes also depend on host persistence support and must not be treated as a universal persistence API on current DSH. See [Architecture](docs/ARCHITECTURE.md#7-state-ownership-and-current-limitations).

## Development

This repository is a standalone plugin source tree. Tests run the vendored DSH **sources** directly (the same source-level resolution the DSH monorepo uses), so no build of the plugin itself is needed to test it.

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

# 3. Back in the plugin repo: install tooling and regenerate the resolution maps
cd ../..
npm install
node scripts/generate-maps.cjs

# 4. Run everything
npm test
npm run typecheck:all
npm run build
```

Tests use the vendored DSH sources. `vendor/` is intentionally gitignored and is part of the local development environment; do not treat it as disposable test output.

The live tier is opt-in (`EF_LIVE=1`) and **skips** without a resolved route, so an unmeasured behavior is never reported as a passing one.

### CI

Two lanes on every push:

- **pinned DSH baseline** (`477b4f42…`, the `0.1.7-rc.2` release) — mandatory.
- **DSH master** — an allowed-to-fail compatibility probe.

Both run the typechecks, the full suite, and the keyless evaluation tiers.

> **On version numbers.** `0.1.7-rc.2` in this repository is the **test baseline CI
> pins**, not a claim about what you have installed. EF's `engines.dsh` and peer
> ranges are `>=0.1.7-rc.2`, and it is verified running on `0.2.0-rc.2`.

For the evaluation matrix, live tiers, external benchmarks, and temporary-directory discipline, see [Development](docs/DEVELOPMENT.md).

## Repository layout

```
src/
  engine.ts             EpistemicFoldEngine — Basic's transaction + EF compile hook
  fold-economics.ts     economic leaf-admission and rebase decisions (R2-B, R2-C)
  policy.ts             plugin config resolution + routed-model pressure math
  policy-compiler.ts    amortized rebase policy: break-even horizon, hard overrides
  economics-profile.ts  versioned cost model: ρ, ρ_eff, cache realization, break-even
  candidate.ts          pending fold-candidate identity (single slot per session)
  bundle-store.ts       FileBundleStore — atomic, hash-verified, 0600 permissions
  compiler.ts           input splitting, canonical bundle build, checkpoint rendering
  frontier.ts           Fold Frontier: locate/re-derive from the CURRENT surface
  leaf-policy.ts        [frontier+1, bestEnd] span selection + frozen budget load
  root-policy.ts        root rebase advisories (manual /compact = Root Fold)
  state.ts              deterministic StateReducer: anchors, supersession, lifecycles
  authority.ts          which event kinds may ground which authority domains
  anchor-service.ts     the authority-gated anchor write channel (ctx.epistemicFold)
  projection.ts         wires the reducer into ctx.sessionProjections
  renderer.ts           structured checkpoint: Current/Evidence/Open/Rationale/Recall
  recall.ts             context_search + context_recall (bounded, paginated, exact)
  tools.ts              registers the recall tools against ctx.tools
  hash.ts               canonical JSON + SHA-256 digests
  checkpoint-marker.ts  the EF1 marker protocol inside checkpoint bodies
  pressure.ts           frozen/open pressure attribution
  trigger.ts            trigger-breakdown arithmetic
  trigger-diagnostics.ts per-target trigger decomposition, reported to the log
  event-data.ts         typed readers for the session-event payloads EF inspects
  rebase-intent.ts      rebase-intent registry
  idle-rebase.ts        idle-time rebase consumer
  effective-config.ts   resolved-config reporting
  preset.ts             the tier ladder and its evidence status
  status.ts             /context status model (pure function over caller data)
  status-projection.ts  the client-facing status projection (the Sidebar's source)
  command.ts            the /context command plane
  plugin.ts             the composite plugin: owns ctx.compaction, wires the above
  entry.ts              the bare-name entry (mounts the DOCTOR, not the plugin)
  doctor.ts             always-mounted substitution doctor (observation only)
  preset-self-check.ts  turns a missed preset substitution into a loud error
  compat.ts             frameCheckpoint seam detection + fail-loud assertion
  basic/                vendored copy of DSH's Basic backend, with the seam inlined
  index.ts, types.ts    library face and shared types
client.js               the browser Sidebar panel (hand-written, no bundler)
eval/                   evaluation harness: workloads, ROI lab, Pareto, paired runner
profiles/economics/     versioned provider pricing (asOf + source)
tests/                  the suite, plus the shared harness with a controlled LLM adapter
bench/                  paired-baseline harness (Basic vs EF prefix economics)
scripts/                build, preset generation, vendoring, seam application, preflight
docs/                   design records and evaluation reports (see below)
```

## Documentation

Start with:

- [User guide](docs/USER_GUIDE.md) — install, modes, commands, Sidebar, troubleshooting.
- [Architecture](docs/ARCHITECTURE.md) — contracts, fold lifecycle, state and recall.
- [Development](docs/DEVELOPMENT.md) — local setup, tests, evaluation conventions.
- [Documentation map](docs/README.md) — stable docs plus the complete research/audit archive.
- [Deployment chain](docs/42_DEPLOYMENT_CHAIN.md) — detailed DSH preset and browser deployment path.

The numbered R/RC documents are **evidence records**, not required reading for normal use. The complete index lives in [docs/README.md](docs/README.md).

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
