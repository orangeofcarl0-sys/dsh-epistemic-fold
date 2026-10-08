# Epistemic Fold

[![CI](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/actions/workflows/ci.yml/badge.svg)](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/orangeofcarl0-sys/dsh-epistemic-fold?sort=semver)](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.1.7--rc.2-4b5563.svg)](#ci)
[![docs](https://img.shields.io/badge/docs-guide-4b5563.svg)](docs/README.md)

> **Compaction should make context smaller — not make the agent forget what it already learned.**

**Epistemic Fold** is a context runtime for long-horizon agents on the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
It folds old trajectory out of the model's active context while keeping the
original history recoverable, the frozen prefix stable, and the whole process
observable.

**Exact history stays recoverable.**
**Old trajectory leaves the hot context.**
**The agent can keep working without treating a lossy summary as the source of truth.**

[中文](README.zh.md) · [User guide](docs/USER_GUIDE.md) · [Architecture](docs/ARCHITECTURE.md) · [Research archive](docs/README.md)

![The Epistemic Fold Sidebar panel: mode, context pressure against the window, archived history, lifetime fold counts, retrieval activity, and measured provider usage](docs/assets/sidebar-panel.png)

*A real render from a live session. The Sidebar reads the same status projection as `/context status` and never enters the model prompt — unknown values show as `—`, never as a fabricated zero.*

---

## The problem

Long-running agents accumulate a lot of useful history:

- requirements and later revisions;
- failed approaches and why they failed;
- tool outputs;
- implementation decisions;
- temporary constraints;
- facts that may not matter again for hundreds of turns.

Eventually that history has to leave the active prompt.

The usual answer is to summarize it.

That helps with context size, but it creates a second problem:

```text
original history
      ↓
   summary
      ↓
summary of summary
      ↓
what exactly is still true?
```

A compressed narrative can be useful, but it is a poor canonical record. Details
can disappear, an old value can look current again, and a later agent may have no
way to recover the exact source that was folded away.

**Epistemic Fold changes the contract.**

```text
                     ┌──────────────────────┐
old model-visible ──►│ exact Fold Bundle    │─────┐
history              │ immutable + hashed   │     │
                     └──────────────────────┘     │
                                │                 │
                                ▼                 │
                     ┌──────────────────────┐     │
                     │ compact checkpoint   │     │
                     │ + bounded state      │     │
                     └──────────────────────┘     │
                                │                 │
                                ▼                 │
                          active context          │
                                │                 │
                         need old detail?         │
                                └──── search / recall ───► exact archive
```

The active prompt gets smaller. The original history does not vanish.

---

## Why this is different from "just summarize it"

| | ordinary lossy compaction | Epistemic Fold |
| --- | --- | --- |
| **source of truth** | compressed narrative often becomes the only visible representation | DSH session + exact Fold Bundle remain canonical |
| **old detail** | may be unrecoverable | exact archived messages are searchable and pageable |
| **repeated compaction** | can repeatedly rewrite previous summaries | normal folds advance a monotonic **Fold Frontier** |
| **current state** | mostly implicit in prose | deterministic state can be represented separately from narrative |
| **cache behavior** | rewriting early context can churn the prefix | leaf folds keep the frozen prefix stable; root rebases are rare |
| **observability** | usually opaque | `/context status` + Sidebar show pressure, folds, archive, recall and usage |

EF is not trying to build the world's smartest summarizer.

It is trying to make **lossy summarization non-authoritative**.

---

## A 30-second tour

### 1. Pick the trade-off you want

```text
/context mode economy
/context mode balanced
/context mode quality
```

| mode | idea |
| --- | --- |
| **Economy** | keep the hot context lean; recover older detail on demand |
| **Balanced** | keep a larger verbatim recent tail |
| **Quality** | Balanced + semantic rationale checkpoints |

The tiers use the same engine. Each rung adds one explicit retention / redundancy
lever, so the trade-off is inspectable rather than hidden behind three unrelated
implementations.

`legacy` remains the frozen EF compatibility baseline.
`basic` makes EF stand aside and delegates to the vendored Basic backend.

### 2. Watch what the runtime is doing

```text
/context status
```

Typical fields:

```text
context mode: economy

current context:
  pressure        42819 tokens
  window          131072 tokens
  occupancy       32.7%

archived history:
  archived tokens ~286000 (estimated)
  checkpoints now 6

retrieval:
  searches        12
  recalls         8

folds (lifetime):
  leaf folds      27
  root rebases    3
```

The browser Sidebar reads the same status model.

**The status UI is outside model history.** Looking at your compression state
does not consume the context it is reporting on.

### 3. Let the agent recover what left the prompt

When DSH provides a ToolRuntime, EF registers:

- `context_search` — locate relevant folded history and bounded verbatim excerpts;
- `context_recall` — retrieve a checkpoint view or exact archived messages.

So "not currently in the prompt" does not mean "gone".

---

## How folding works

A normal **Leaf Fold** only touches the open trajectory after the Fold Frontier:

```text
[frozen checkpoint][frozen checkpoint] | frontier | [open trajectory........]
                                                     └────── leaf fold ──────┘
```

The transaction is deliberately ordered:

```text
select legal span
      ↓
archive exact model-visible messages
      ↓
build checkpoint / state representation
      ↓
commit DSH surface replacement
      ↓
advance Fold Frontier
```

The archive must exist **before** the lossy replacement commits.

That gives EF its central invariant:

> **Bundle durable before surface loss.**

A **Root Fold** is different: it rebases a larger frozen surface when the recurring
carry cost is worth the cache disruption. Root folds are intentionally rare.

---

## Quick start

### Install from a release tarball

The release tarball is the simplest pinned install because it already contains the
built `lib/` — nothing runs `prepare`, no `allowBuilds` entry is needed, and you get
exactly the code the release notes describe.

```bash
dsh plugin --profile <name> add file:/path/to/dsh-epistemic-fold-0.1.0.tgz
```

### Or pin a git tag

```bash
dsh plugin --profile <name> add github:orangeofcarl0-sys/dsh-epistemic-fold#v0.1.0
```

> **A bare `github:owner/repo` spec follows the default branch, not the release.**
> `dsh plugin` never queries the GitHub Releases API: it hands the spec to pnpm,
> which resolves the bare form to the TIP of the default branch and only pins when
> the spec carries `#<tag-or-commit>` — observed as a `codeload.github.com` tarball
> URL ending in the resolved commit sha. Drop the `#v0.1.0` deliberately if you
> want unreleased work, never by accident.

### Profile bundle order

EF patches DSH's own presets in place, so it must load after `dsh-web-app`:

```jsonc
{
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

EF substitutes the compaction backend inside DSH's `standard`, `ptc`, and
`cordis` presets. `minimal` stays untouched.

Configure a default tier:

```yaml
- name: dsh-epistemic-fold
  config:
    bundleRoot: <profile persistence root>/epistemic-fold
    mode: economy
```

Then verify from a session:

```text
/context status
```

For install channels, pnpm `allowBuilds`, preset verification, browser checks and
upgrade behavior, see the [User guide](docs/USER_GUIDE.md) and the detailed
[deployment chain](docs/42_DEPLOYMENT_CHAIN.md).

---

## What is actually proven today?

EF deliberately separates measured behavior from product hypotheses.

**Established on the current implementation**

- exact archive-before-loss and hash-verified Fold Bundles;
- exact bounded recall of folded history;
- monotonic Fold Frontier behavior;
- production Leaf / Root fold transaction paths;
- retrieval ordering and temporal supersession safeguards;
- real DSH plugin mounting, preset substitution, runtime commands and Sidebar;
- an Economy path that works without a per-fold semantic-model call.

**Still open**

- whether **Balanced** or **Quality** produces a reliable long-horizon steadiness
  advantage over Economy;
- whether one mode is universally cheaper after real provider cache behavior,
  retries, tool use and route pricing are included;
- full external-benchmark ranking across modes.

That distinction is intentional. EF has repeatedly found instrumentation bugs by
running the system for real, and the project keeps those corrections instead of
turning a null result into a marketing claim.

The full evidence trail lives in [docs/README.md](docs/README.md).

---

## Product surfaces

### Runtime command

```text
/context status
/context line
/context mode economy|balanced|quality
```

### Sidebar

The Sidebar visualizes:

- context occupancy;
- archived history;
- current checkpoints;
- lifetime leaf/root folds;
- search / recall activity;
- provider usage;
- estimated cost when a matching price profile exists.

Unknown values are shown as unknown — never fabricated as zero.

### Basic fallback

Set:

```yaml
mode: basic
```

and EF deliberately disappears from the session surface:

- no EF projection;
- no Sidebar panel;
- no `/context`;
- no recall tools;
- compaction delegates to the vendored Basic backend.

You can benchmark or roll back without uninstalling the plugin.

---

## What EF does *not* try to be

Epistemic Fold is not:

- a vector database;
- a generic embedding memory layer;
- a learned compression planner;
- a semantic dependency graph;
- a multi-level "summary of summaries" hierarchy;
- a replacement for DSH goals, plans, todos, or project instructions.

Those boundaries are deliberate.

EF owns the **folding contract**. Existing DSH subsystems keep owning the state
they already own.

See [Architecture](docs/ARCHITECTURE.md#7-state-ownership-and-current-limitations)
for state ownership and the current persistence limitations around custom
`ef/anchor` events.

---

## Architecture in one line

```text
immutable history
      → exact archive
      → compact working projection
      → stable frozen surface
      ↔ bounded exact recall
```

Or, more simply:

```text
History ≠ Memory ≠ Context
```

That is the whole project.

---

## Development

This repository is a standalone plugin source tree. Tests run the vendored DSH
**sources** directly (the same source-level resolution the DSH monorepo uses), so
no build of the plugin itself is needed to test it.

Prerequisites: Node `^22.19 || >=24`, pnpm `11.7.x`, npm.

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git vendor/deepseek-harness
cd vendor/deepseek-harness
git checkout 639ed015397290b3745d163aafe02ffee4aa3f84
pnpm install

node --max-old-space-size=8192 ./node_modules/typescript/bin/tsc -b \
  packages/compaction/compaction-basic \
  packages/core/tools \
  packages/util/atomic-write

cd ../..
npm install
node scripts/generate-maps.cjs

npm test
npm run typecheck:all
npm run build
```

`vendor/` is intentionally gitignored and is part of the local development
environment; do not treat it as disposable test output. The live tier is opt-in
(`EF_LIVE=1`) and **skips** without a resolved route, so an unmeasured behavior is
never reported as a passing one.

### CI

Two lanes on every push:

- **pinned DSH baseline** (`639ed015…`, the `0.2.0-rc.2` release) — mandatory.
- **DSH master** — an allowed-to-fail compatibility probe.

Both run the typechecks, the full suite, and the keyless evaluation tiers.

> **On version numbers.** `0.2.0-rc.2` is the **test baseline CI pins**, and it is
> also the line this repository installs: `engines.dsh` and every peer range name it,
> and the vendored checkout is that same release.
>
> That last part is load-bearing. Typecheck resolves `@deepseek-ai/*` to the
> **vendored SOURCE** through `tsconfig` paths, while runtime resolves the same
> specifiers to the **npm binaries** in `node_modules`. When those were different
> lines -- vendored `0.2.0-rc.2`, installed `0.1.7-rc.2` -- the compiler checked one
> API and Node executed another, and any difference between them was invisible to
> both. A bridge importing a package missing from the installed line passed
> `typecheck:all` and died at runtime with `ERR_MODULE_NOT_FOUND`. The two are
> pinned to one line now, and a test derives that rather than restating it.

---

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

---

## Documentation

The numbered R/RC documents under `docs/` are the **research and verification
archive**, not the user manual.

Start with:

- [User guide](docs/USER_GUIDE.md) — install, modes, commands, Sidebar, troubleshooting.
- [Architecture](docs/ARCHITECTURE.md) — contracts, fold lifecycle, state and recall.
- [Development guide](docs/DEVELOPMENT.md) — local setup, tests, evaluation conventions.
- [Research / evidence map](docs/README.md) — stable docs plus the complete archive.
- [Deployment chain](docs/42_DEPLOYMENT_CHAIN.md) — the detailed DSH preset and browser path.

The complete index lives in [docs/README.md](docs/README.md).

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
