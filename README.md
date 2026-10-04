# Epistemic Fold

[![CI](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/actions/workflows/ci.yml/badge.svg)](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/orangeofcarl0-sys/dsh-epistemic-fold?sort=semver)](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.1.7--rc.2-4b5563.svg)](#ci)
[![docs](https://img.shields.io/badge/docs-49%20documents-4b5563.svg)](docs/)

> **Epistemic Fold for DeepSeek Harness**
> *A contract-preserving context runtime for long-horizon agents.*

[中文文档](README.zh.md)

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

Concretely, when the runtime folds a span of conversation it:

1. **archives the exact model-visible messages** into an immutable,
   hash-verified `CheckpointBundle` *before* any lossy surface replacement
   commits (`BundleDurable ≺ SurfaceLoss`);
2. **never re-folds what is already frozen** — a monotonically advancing *Fold
   Frontier* separates frozen checkpoints from the open trajectory, so the cached
   prefix stays byte-stable across folds;
3. **maintains a deterministic current-state model** from provenance-grounded
   state events and failed tool results. The reducer can represent objectives,
   constraints, decisions, values, evidence, failures, and obligations, but
   automatic production currently covers failed tool results only — see
   [State ownership](#state-ownership). It carries full provenance and a hard
   rule that narrative summaries can never verify state (`Raw Events → State`
   and `Raw Events → Summary` run in parallel; `Raw → Summary → State` is
   forbidden);
4. **recovers exactly** — `context_search` / `context_recall` serve bounded,
   paginated, provenance-checked recall of anything that left the working set.

The optimization goal is not maximal compression. It is correctness first — then
information density, prefix-cache locality, long-horizon state consistency, and
stable closed-loop continuation.

---

## Install

EF is a real DSH plugin: it builds to loadable JS and ships a bundle patch that
substitutes itself into DSH's own agent presets.

| channel | spec | pinned? | runs the build? | what it needs |
| --- | --- | --- | --- | --- |
| **tarball** (recommended) | the `.tgz` from [Releases](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/releases) | **yes** | no | nothing — `lib/` is prebuilt |
| **git, at a tag** | `github:orangeofcarl0-sys/dsh-epistemic-fold#v0.1.0` | **yes** | yes | one `allowBuilds` line, which dsh prints for you |
| **git, tracking main** | `github:orangeofcarl0-sys/dsh-epistemic-fold` | no | yes | the same line, but it follows every push |
| **path** | `file:/path/to/dsh-epistemic-fold` | n/a | no | run `npm install` in the source tree first |
| **registry** | `dsh-epistemic-fold` | n/a | n/a | not available — the package is `private` and unpublished |

> **Releases are not an install channel — only their attachment is.** Measured:
> `dsh plugin` never queries the GitHub Releases API. It hands the spec to pnpm,
> which resolves a git spec to a **commit tarball** on `codeload.github.com`.
> `github:owner/repo` resolves to the tip of the default branch; only an explicit
> `#<tag-or-commit>` pins anything. So the plain git spec follows every push to
> `main`, including commits that have not been released.

### Install from a release tarball (recommended)

```bash
dsh plugin --profile <name> add file:/path/to/dsh-epistemic-fold-0.1.0.tgz
```

The tarball already contains the built `lib/`, so nothing runs `prepare`, no
`allowBuilds` entry is needed, and you get exactly the code the release notes
describe.

### Install from git, pinned to a tag

```bash
dsh plugin --profile <name> add github:orangeofcarl0-sys/dsh-epistemic-fold#v0.1.0
```

The first run stops with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`. That is pnpm
blocking build scripts, not a defect: **dsh prints the exact `allowBuilds` line to
paste** into the profile's `pnpm-workspace.yaml`. Add it and re-run. The install
then builds `lib/` and generates the preset rows as part of `prepare`.

The `allowBuilds` key embeds the resolved commit, so pinning the tag also pins the
allowlist entry.

### Install from git, tracking `main`

Drop the `#v0.1.0` to follow the default branch. This is the right choice if you
want unreleased work — and the wrong one if you want what the release notes
describe, because the two diverge the moment a commit lands.

### Install from a local checkout

```bash
cd /path/to/dsh-epistemic-fold
npm install          # builds lib/ — the file: channel does NOT do this for you
npm run preflight    # verifies the tree is installable
```

then add it as a `file:` dependency. **The `file:` channel does not run the
build** — measured, pnpm skips `prepare` for path dependencies. Without
`npm install` the install copies a directory whose `main` (`lib/entry.js`) does
not exist, and the loader reports `failed to import` for an entry that is itself
the install doctor. `npm run preflight` catches that before you install.

### Configure the profile

```jsonc
// <DSH_HOME>/profiles/<name>/package.json
{
  "dependencies": { "dsh-epistemic-fold": "file:/path/to/dsh-epistemic-fold" },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-epistemic-fold"        // ← MUST come after dsh-web-app
      ]
    }
  }
}
```

Then `pnpm install` in the profile directory and boot with `dsh --profile <name>`.

**Bundle order is a correctness requirement.** The substitution patch overrides
rows that `@deepseek-ai/dsh-web-app` declares. Listed before it, the patch finds
nothing — and EF's doctor reports that loudly rather than silently leaving you on
native Basic.

**The preset menu does not change.** EF substitutes itself into DSH's own
`standard`, `ptc` and `cordis` presets, so there is nothing new to choose.
`minimal` is left exactly as DSH ships it — it declares no compaction group, so
there is nothing to substitute.

### Verify the install

```bash
# 1. the composition actually happened — three rows, one per substituted preset
grep -c "name: dsh-epistemic-fold/plugin" cordis.patch.yml

# 2. the session runs EF — inside a session under standard/ptc/cordis
/context status

# 3. the browser got the build you made
#    (in the page console)
__DSH_BOOT__.entries.find(r => r.id === 'dsh-epistemic-fold').rev
```

The doctor's own success line is **not** printed on a healthy web boot — cordis's
logger buffers in memory and `dsh-app-boot` captures only warn/error. The three
surfaces above are what you actually check. See
[the deployment chain](docs/42_DEPLOYMENT_CHAIN.md) for the full matrix.

---

## Usage

### Modes

Three **tiers**, plus `legacy` (the engine's own default) and `basic` (stand
aside entirely):

```yaml
- name: dsh-epistemic-fold
  config:
    bundleRoot: <profile persistence root>/epistemic-fold
    mode: economy     # economy | balanced | quality | legacy | basic
```

| mode | what it adds | evidence |
| --- | --- | --- |
| `economy` | — (default retention, no per-checkpoint LLM call) | **MEASURED** — RC1.3: parity with Basic at ~1/17 the cost |
| `balanced` | a larger verbatim tail (retention 0.16 → 0.24) | **HYPOTHESIS** — the RC2.1 A/B measured no gain |
| `quality` | + narrative checkpoints (`semanticMode: rationale`) | **HYPOTHESIS** — not measured |
| `legacy` | the engine's own default; no tier values applied | — |
| `basic` | nothing — folds delegate to a byte-identical Basic backend | — |

The ladder varies **one lever per rung** — retention first, then the semantic
face — with everything else held identical, so a difference between adjacent
rungs is attributable. Every tier is a named **set of values, not a branch**:
expansion happens before resolution, so the engine cannot tell a preset from the
same keys written by hand, and **an explicit setting always wins**.

`reliability` is deliberately **not** offered: there is no live evidence for what
the right reliability configuration is, and naming one would assert a conclusion
the project does not have.

The tier is chosen with `/context mode economy|balanced|quality` — not with a
preset, because a preset is picked before a session starts and DSH refuses to
recompose a running one.

### The `frameCheckpoint` seam

`framingMode: system-dedup` (which every tier selects) needs a `frameCheckpoint`
hook on the compaction engine. **EF carries that seam in its own vendored copy of
the Basic backend** (`src/basic/`), so it mounts on **any** DSH build and needs no
patch script. If the vendored copy is ever damaged, the engine **refuses to
start** rather than silently running the costlier per-checkpoint framing — which
would report an economy saving the deployment does not get.

### The Sidebar panel

EF ships a Sidebar **observation** panel (`client.js`). It reads the same status
model `/context status` renders rather than parsing the command's text, shows the
context's proportion and the provider's cache-hit share, and renders `—` for any
figure it cannot establish — never a zero. It reads a client-side projection, so
it **cannot enter the model context** by construction.

It reaches **both** right sidebars, which keep separate tab registries. The two
halves are **not** symmetric: better-sidebar is the optional idiom, and the native
registration is a **fallback**, because better-sidebar bridges its own tabs *into*
the native registry — registering both unconditionally showed two identical
entries ([docs/43](docs/43_RC17_SIDEBAR_ENTRY_DEDUPE.md)).

### Standing aside

Set `mode: basic` to get native Basic back without uninstalling. EF then delegates
folds to a byte-identical Basic backend and registers **no** EF surface at all —
no projection, no panel, no `/context`, no recall tools. This is a supported
configuration, not a degraded one.

---

## Status

**What is measured, and what is not.** EF's discipline is that a claim carries its
evidence status, and this file follows the same rule.

| area | status |
| --- | --- |
| Exact archive / recall closure, bundle store | ✅ **PRODUCTION-EXERCISED** — M0/M2 gates closed |
| Deterministic state reducer, authority and supersession invariants | ✅ **MACHINE-VERIFIED** — M3a gates closed on fixtures and live-injected anchors |
| Production state producers | ⚠️ **PARTIAL** — automatic failed-tool state only; no general anchor producer is wired into ordinary sessions |
| Fold Frontier, leaf/root folds, prefix stability | ✅ **MEASURED** |
| `economy` tier cost parity | ✅ **MEASURED** — RC1.3: parity with Basic at ~1/17 cost, reproduced |
| Recall quality | ✅ **MEASURED** — 3.00/3 n=9, matching Basic |
| Real DSH pluginization, presets, `mode: basic` | ✅ **VERIFIED** in a real host |
| Sidebar panel (both sidebars) | ✅ **VERIFIED** in a real browser |
| Route-level realized cost gate | ⚠️ **OPEN** — dispersion at n=8; must not drive the architecture |
| `balanced` / `quality` steadiness benefit | ⚠️ **HYPOTHESIS** — the RC2.1 A/B measured no gain |
| Live behavioral tier (opt-in, `EF_LIVE=1`) | ⚠️ **NULL RESULT** — the task sample did not discriminate the modes |
| External benchmarks (τ²-Bench, LHTB) | ⚠️ **PARTIAL** — integrated; see docs 33–36 |

**Frozen stages** — closed, not to be re-litigated without new incident evidence:
`M1`, `M3b`, `M4`, `M5`, `RecallPrune` (deferred by evidence); `DeltaLeaf`
(**rejected** on measured ROI, R1-B).

Only one question remains open, and it is a **pricing** question that must not
drive the architecture: the route-level realized cost gate.

### State ownership

EF's `AnchorKind` set — `objective`, `constraint`, `decision`, `value`,
`artifact`, `evidence`, `failure`, `obligation` — is a **normalized state
vocabulary**: it says what EF can *represent* in a bounded working view. It is
not a claim of domain ownership. Where a canonical owner already exists, that
owner stays authoritative and EF does not duplicate it.

| Domain | Canonical owner | EF's role |
| --- | --- | --- |
| Completion objective | DSH `dsh-goal` (`goal/change`) | none |
| Current execution plan | DSH `dsh-tool-todo` (`todo/write`) | none |
| Global / project guidance | `AGENTS.md`, loaded by `dsh-agent-instructions` | none — already durable, model-visible history |
| Tool failures | raw `tool/result` | **EF derives state — its only automatic production producer** |
| Session-local assertions, temporary constraints | no canonical owner | candidate only; no producer today |
| Decisions, evidence, artifacts, obligations | no canonical owner | no producer, and none is planned |

**Custom durable events are not persistence-safe on current DSH.** EF appends
`ef/anchor` through `ctx.epistemicFold`, but that type is outside DSH's known
event vocabulary and the current `Session.append` cannot stamp the envelope's
`ignorable` marker, so the persistence read path refuses to reopen a log
containing one (`SessionFormatUnsupportedError`). The reducer, authority gate,
and supersession semantics are verified in memory; the durable write is not.
`declare()` is therefore not a production-safe state write — see
`tests/persistence-compat.spec.ts`, which pins the host capability as a probe
rather than asserting a permanent failure.

---

## Development

This repository is a standalone plugin source tree. Tests run the vendored DSH
**sources** directly (the same source-level resolution the DSH monorepo uses), so
no build of the plugin itself is needed to test it.

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
npx vitest run                      # the whole suite
npm run typecheck:all               # src/ AND the browser client face
```

**Two typecheck projects, on purpose.** `tsconfig.json` covers `src/` and `tests/`
under full `strict`. `tsconfig.client.json` covers `client.js` — the browser face —
which cannot join the first project because it `require`s React from the host
loader rather than depending on it. Both run in CI.

The suite grows every stage, so this file deliberately does **not** state a test
count: a hardcoded number goes stale the moment a spec is added, and a stale count
is read as an unfinished suite. `vitest run` prints the authoritative totals. The
live tier is opt-in (`EF_LIVE=1`) and **skips** without a resolved route, so an
unmeasured behavior is never reported as a passing one.

### CI

Two lanes on every push:

- **pinned DSH baseline** (`477b4f42…`, the `0.1.7-rc.2` release) — mandatory.
- **DSH master** — an allowed-to-fail compatibility probe.

Both run the typechecks, the full suite, and the keyless evaluation tiers.

> **On version numbers.** `0.1.7-rc.2` in this repository is the **test baseline CI
> pins**, not a claim about what you have installed. EF's `engines.dsh` and peer
> ranges are `>=0.1.7-rc.2`, and it is verified running on `0.2.0-rc.2`.

---

## Repository layout

```
src/
  engine.ts             EpistemicFoldEngine — Basic's transaction + EF compile hook
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
  trigger.ts            trigger-breakdown reporting
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

`docs/` holds **49 documents**. They are of three kinds, and the distinction
matters when reading them: a **design record** states intent, an **evaluation
report** states what was measured, and a **defect record** states what went wrong
and what the correction was. Where a later document falsified an earlier
conclusion, the earlier document says so in place rather than being rewritten —
the audit trail is the point.

### Project entry & architecture

| Document | Contents |
|---|---|
| [00_README_EF.md](docs/00_README_EF.md) | Project entry: naming, goals, the nine core invariants, glossary |
| [01_EF_RFC_001_ARCHITECTURE.md](docs/01_EF_RFC_001_ARCHITECTURE.md) | Architecture spec: truth model, data structures, fold transactions |
| [02_EF_IMPLEMENTATION_PLAN_M0_M3.md](docs/02_EF_IMPLEMENTATION_PLAN_M0_M3.md) | Engineering DAG, gates, stop conditions |
| [03_EF_TEST_BENCHMARK_SPEC.md](docs/03_EF_TEST_BENCHMARK_SPEC.md) | Metrics (ALR/SSR/DWR/CR/PMA), test suites, benchmark arms |
| [04_EF_LOCAL_AGENT_WORK_ORDER.md](docs/04_EF_LOCAL_AGENT_WORK_ORDER.md) | Execution order and prohibitions for an implementation agent |
| [05_EF_DECISIONS_AND_OPEN_QUESTIONS.md](docs/05_EF_DECISIONS_AND_OPEN_QUESTIONS.md) | Frozen decisions, hypotheses, open questions |
| [06_FINAL_REPORT.md](docs/06_FINAL_REPORT.md) | Final M0/M2/M3a implementation report: gates, evidence, deviations |

### Evaluation

| Document | Contents |
|---|---|
| [07_R0C_EVALUATION_REPORT.md](docs/07_R0C_EVALUATION_REPORT.md) | R0-C evaluation: measurement integrity, corpus, paired continuation, long-horizon economics |
| [07_R0C_EVALUATION_CLOSURE.md](docs/07_R0C_EVALUATION_CLOSURE.md) | R0-C closure record |
| [08_BOUNDARY_CORPUS_PROTOCOL.md](docs/08_BOUNDARY_CORPUS_PROTOCOL.md) | Boundary corpus protocol: sidecar format, oracle union, action signatures |
| [09_EVALUATION_METRICS_SPEC.md](docs/09_EVALUATION_METRICS_SPEC.md) | Exact metric definitions (SPN/SPT/IST/PMA/DWR/CR/ρ) |
| [10_LOCAL_AGENT_WORK_ORDER_R0C.md](docs/10_LOCAL_AGENT_WORK_ORDER_R0C.md) | R0-C execution work order |
| [11_R1B_ROUTE_SELECTION_GATE.md](docs/11_R1B_ROUTE_SELECTION_GATE.md) | R1-B route-selection gate: measured ROI per candidate, and the rejection of production Delta Leaf |
| [12_R1_EVALUATION_REPORT.md](docs/12_R1_EVALUATION_REPORT.md) | R1 report (**generated** by `npm run eval:r1-report`): attribution, regime sensitivity, ROI bounds, policy, Pareto |
| [13_R1_LIVE_BEHAVIORAL_RESULTS.md](docs/13_R1_LIVE_BEHAVIORAL_RESULTS.md) | Live behavioral subset: the null result, measured cache realization, and the bug it found |
| [14_R2_EVALUATION_REPORT.md](docs/14_R2_EVALUATION_REPORT.md) | R2 price-dominance report: BCR 1.276 → 1.149, why the objective was not reached |
| [15_R2_FRAMING_CEILING.md](docs/15_R2_FRAMING_CEILING.md) | R2 framing-ceiling analysis: the repeated preamble is the dominant checkpoint cost |
| [16_R3_EVALUATION_REPORT.md](docs/16_R3_EVALUATION_REPORT.md) | R3 frozen-surface economy closure: pricing correctness, idle rebase, framing seam |
| [17_R4_EVALUATION_REPORT.md](docs/17_R4_EVALUATION_REPORT.md) | R4 economy default closure: real-recall workload, realized billing, window safety, presets |

### Release hardening (RC0–RC2.1)

| Document | Contents |
|---|---|
| [18_RC0_RELEASE_HARDENING.md](docs/18_RC0_RELEASE_HARDENING.md) | RC0: the configuration contract, pairwise non-inferiority, the all-call billing recorder, and the dispersion that keeps the cost gate open |
| [19_RC1_POLICY_NORMALIZATION.md](docs/19_RC1_POLICY_NORMALIZATION.md) | RC1: trigger breakdown, measured safety reserve, replay simulator, cache microbench, certified economy profile |
| [20_RC1_1_EVIDENCE_RECONCILIATION.md](docs/20_RC1_1_EVIDENCE_RECONCILIATION.md) | RC1.1: component-wise certification, the reserve as a scoped estimate, both replay confounds removed, the withdrawn RC1-H conclusion |
| [21_RC1_2_RECALL_CLOSURE.md](docs/21_RC1_2_RECALL_CLOSURE.md) | RC1.2: the real agent-loop recall smoke, the deterministic mechanism proof, the rationale tax at its measured size |
| [22_RC1_3_RETRIEVAL_ERGONOMICS.md](docs/22_RC1_3_RETRIEVAL_ERGONOMICS.md) | RC1.3: the un-hinted baseline, per-fact failure taxonomy, the self-describing search hit, and the rule that brought economy to parity |
| [23_RC1_3_1_TEMPORAL_RETRIEVAL_GUARD.md](docs/23_RC1_3_1_TEMPORAL_RETRIEVAL_GUARD.md) | RC1.3.1: newest-first chronology from source spans, latest-match supersession, `matchedMessageIndex` — freezes the retrieval layer |
| [24_RC2_PRODUCT_INTEGRATION.md](docs/24_RC2_PRODUCT_INTEGRATION.md) | RC2: the three-tier ladder with declared evidence status, `/context status` on the real command plane, and why the real-task comparison did not discriminate |
| [25_RC2_1_STATUS_AND_RETENTION_AB.md](docs/25_RC2_1_STATUS_AND_RETENTION_AB.md) | RC2.1: four `/context status` defects, the EF-legacy-vs-Basic baseline correction, the retention-first reorder, and the A/B that measured no steadiness gain |

### Product integration (RC3–RC7)

| Document | Contents |
|---|---|
| [26_RC3_REAL_DSH_PLUGINIZATION.md](docs/26_RC3_REAL_DSH_PLUGINIZATION.md) | RC3: the build step, the bundle patch, the `ctx.inject` bug only a real host could find, and the correction of RC2's "in DSH" claim |
| [27_RC4_SIDEBAR_PANEL.md](docs/27_RC4_SIDEBAR_PANEL.md) | RC4: the command/observation split over one shared status model, and the hand-written client bundle |
| [28_RC4A_INTERACTION_AUDIT.md](docs/28_RC4A_INTERACTION_AUDIT.md) | RC4-A: the command surface exercised case by case, the web-profile `isolate` finding, the failure-as-success defect |
| [29_RC5_PRESET_DESIGN.md](docs/29_RC5_PRESET_DESIGN.md) | RC5: EF as its own preset — why declaring beats overriding, the exact substitution, the restatement cost |
| [30_RC6_PRIOR_ART_SURVEY.md](docs/30_RC6_PRIOR_ART_SURVEY.md) | RC6: how other DSH context/compaction plugins actually work |
| [31_RC7_TRANSFORMATION_PLAN.md](docs/31_RC7_TRANSFORMATION_PLAN.md) | RC7: in-place substitution + the vendored Basic copy; why that shape and not the alternatives |
| [32_RC7D_PARALLEL_LONG_TASK_TESTING.md](docs/32_RC7D_PARALLEL_LONG_TASK_TESTING.md) | RC7-D: parallel long-task testing |

### External benchmarks (RC8–RC10)

| Document | Contents |
|---|---|
| [33_RC8_EXTERNAL_BENCHMARKS.md](docs/33_RC8_EXTERNAL_BENCHMARKS.md) | RC8: external benchmark integration — what is real and what is blocked |
| [34_RC9_TAU2_INTEGRATION.md](docs/34_RC9_TAU2_INTEGRATION.md) | RC9: τ²-Bench-Verified integration (the Interaction-State lane) |
| [35_RC10_LHTB_INTEGRATION.md](docs/35_RC10_LHTB_INTEGRATION.md) | RC10: LHTB integration (the LongWork lane) |
| [36_RC10_SESSION_PAUSE.md](docs/36_RC10_SESSION_PAUSE.md) | RC10: session state, paused |

### Interaction surface (RC11–RC21)

| Document | Contents |
|---|---|
| [37_RC11_BROWSER_VERIFICATION.md](docs/37_RC11_BROWSER_VERIFICATION.md) | RC11: real-browser verification of the interaction surface |
| [38_RC12_PRESET_BACKEND_DOCTOR_DEFECT.md](docs/38_RC12_PRESET_BACKEND_DOCTOR_DEFECT.md) | RC12: the preset backend mounted the **doctor** — every session silently ran Basic |
| [39_RC13_SIDEBAR_PANEL_RENDER_DEFECT.md](docs/39_RC13_SIDEBAR_PANEL_RENDER_DEFECT.md) | RC13: the panel called a hook the sidebar never passes |
| [40_RC14_DUAL_SIDEBAR_ADAPTER.md](docs/40_RC14_DUAL_SIDEBAR_ADAPTER.md) | RC14: dual sidebar adaptation — and the falsified "the type registers, the body does not" trace |
| [41_RC15_NATIVE_SIDEBAR_RENDERS.md](docs/41_RC15_NATIVE_SIDEBAR_RENDERS.md) | RC15: the native panel renders — a thunked `description`, and `inject: ['slots']` |
| [42_DEPLOYMENT_CHAIN.md](docs/42_DEPLOYMENT_CHAIN.md) | **The deployment chain: GitHub to a running DSH** — the operational document |
| [43_RC17_SIDEBAR_ENTRY_DEDUPE.md](docs/43_RC17_SIDEBAR_ENTRY_DEDUPE.md) | RC17: one guide entry, not two — and the recursion the fix's own test found |
| [44_RC18_HONEST_PRICING.md](docs/44_RC18_HONEST_PRICING.md) | RC18: the panel priced every session with the wrong rate card |
| [45_RC19_PANEL_READABILITY.md](docs/45_RC19_PANEL_READABILITY.md) | RC19: making the panel readable — units, proportion, cache-hit share, locale |
| [46_RC20_ARCHIVED_ITEM_COUNT.md](docs/46_RC20_ARCHIVED_ITEM_COUNT.md) | RC20: the archived-item count was reachable all along |
| [47_RC21_CLIENT_TYPECHECK_AND_CONTRACT.md](docs/47_RC21_CLIENT_TYPECHECK_AND_CONTRACT.md) | RC21: typechecking the client face, and pinning its contract with the host |

**Start here if you are new:** [00](docs/00_README_EF.md) for the model,
[42](docs/42_DEPLOYMENT_CHAIN.md) to install and operate it, and
[47](docs/47_RC21_CLIENT_TYPECHECK_AND_CONTRACT.md) for how the recent work is
verified.

---

## License

[MIT](LICENSE)

`src/basic/` is vendored from DeepSeek Harness (MIT) with the `frameCheckpoint`
seam inlined. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
