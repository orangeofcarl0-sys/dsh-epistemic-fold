# Epistemic Fold v0.1.0

A contract-preserving context runtime for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
a compaction backend that treats folding a trajectory as **a verifiable
transaction**, not a lossy summary.

```text
History ≠ Memory ≠ Context
```

> An agent may fold a trajectory out of the working context only after its
> externally relevant epistemic effects have been materialized, preserved, and
> made recoverable.

## Install

Three channels, and they differ in one way that matters — whether the build runs
for you. All three are verified below.

### 1. Tarball (simplest — no build step, no allowlist)

Download `dsh-epistemic-fold-0.1.0.tgz` from this release:

```bash
dsh plugin --profile <name> add file:/path/to/dsh-epistemic-fold-0.1.0.tgz
```

The tarball already contains the built `lib/`, so nothing runs `prepare` and no
`allowBuilds` entry is needed.

### 2. Git (recommended for tracking `main`)

```bash
dsh plugin --profile <name> add github:orangeofcarl0-sys/dsh-epistemic-fold
```

The first run stops with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`. That is pnpm
blocking build scripts, not a defect: **dsh prints the exact `allowBuilds` line**
to paste into the profile's `pnpm-workspace.yaml`. Add it and re-run; the install
then builds `lib/` and generates the preset rows as part of `prepare`.

### 3. Local checkout

```bash
cd /path/to/dsh-epistemic-fold
npm install        # builds lib/ — the file: channel does NOT do this for you
npm run preflight  # verifies the tree is installable
```

The `file:` channel does not run the build. Without `npm install` the install
copies a directory whose `main` does not exist, and the loader reports
`failed to import` for an entry that is itself the install doctor. `preflight`
catches that before you install.

### After installing

**Bundle order is a correctness requirement**: `dsh-epistemic-fold` must be
listed **after** `@deepseek-ai/dsh-web-app` in `dsh.profile.bundles`, because the
substitution patch overrides rows that `dsh-web-app` declares.

**The preset menu does not change.** EF substitutes itself into DSH's own
`standard`, `ptc` and `cordis` presets, so there is nothing new to choose.
`minimal` is left exactly as DSH ships it.

## What ships

- **Exact archive / recall** — an immutable, hash-verified `CheckpointBundle`
  durable *before* any lossy surface replacement commits
  (`BundleDurable ≺ SurfaceLoss`).
- **Fold Frontier** — frozen checkpoints are never re-folded, so the cached
  prefix stays byte-stable across folds.
- **Deterministic current state** derived from raw session events, with
  provenance. Narrative summaries can never verify state
  (`Raw → Summary → State` is forbidden).
- **Bounded recall** — `context_search` / `context_recall`, paginated and
  provenance-checked.
- **Modes** — `economy` / `balanced` / `quality`, plus `legacy` and `mode: basic`
  (which stands aside entirely and delegates to a byte-identical Basic backend).
- **Interaction surface** — the `/context` command plane and a Sidebar
  observation panel that reaches **both** the native right sidebar and
  `dsh-better-sidebar`.

## Evidence status

The project's rule is that a claim carries its evidence status. This release
follows it:

| Status | What |
| --- | --- |
| **MEASURED** | Archive/recall closure, Fold Frontier, deterministic state. The `economy` tier is at **parity with Basic at roughly 1/17 the cost**, reproduced over two independent n=9 runs. |
| **HYPOTHESIS** | The `balanced` and `quality` steadiness benefits. The RC2.1 A/B measured no gain, and the tiers say so rather than borrowing an unearned name. |
| **OPEN** | The route-level realized cost gate (dispersion at n=8). It is a **pricing** question and is explicitly not allowed to drive the architecture. |
| **NOT IMPLEMENTED, by evidence** | `M1`, `M3b`, `M4/M5`, `RecallPrune` — deferred by evidence. `DeltaLeaf` was **rejected** on a measured ROI upper bound of 3.7–16.6%. |

`reliability` is deliberately not offered: there is no live evidence for what
the right reliability configuration is, and naming one would assert a conclusion
the project does not have.

## Verification at this tag

- **768 tests pass, 23 skipped.** The skips are the opt-in live tier
  (`EF_LIVE=1`), which **skips** without a resolved route rather than passing
  unmeasured.
- **Two typecheck projects clean** — `src/` and `tests/` under full `strict`,
  and `client.js` (the browser face) in its own project, since it `require`s
  React from the host loader rather than depending on it.
- **CI runs two lanes** on every push: a pinned DSH baseline (mandatory) and DSH
  master (an allowed-to-fail compatibility probe).
- **Consumer path verified end to end**: the packed tarball installs into a real
  profile and boots with EF's doctor reporting zero import failures.

## Compatibility

Verified running on DSH `0.2.0-rc.2`. `engines.dsh` and the peer ranges are
`>=0.1.7-rc.2`; the `0.1.7-rc.2` commit (`477b4f42…`) is the **test baseline CI
pins**, not a claim about your install.

The `frameCheckpoint` seam that `system-dedup` framing needs is carried **inside
EF's own vendored copy of the Basic backend**, so EF mounts on any DSH build and
needs no patch script. If that vendored copy is ever damaged, the engine refuses
to start rather than silently running the costlier framing.

## Release hygiene

No machine-specific paths and no credential values, in the tree **or the
history** — the history matters because a value removed from the working tree
still lives in every clone. `tests/release-hygiene.spec.ts` enforces this on
every push, covering both slash styles and distinguishing a credential *value*
from the name of the variable holding one.

The runner scripts require `LHTB_ROOT` / `TAU2_ROOT` and read the credential
store from `DSH_CREDENTIALS` or `~/.dsh`, with an actionable error when either is
missing. There is deliberately no default path: both benchmark checkouts live
outside this repository, and a baked-in path could only be right on the machine
it was written on.

## Distribution

Git and tarball channels only. The package is `private` and **not published to
the npm registry**, so `dsh plugin add dsh-epistemic-fold` (bare name) will not
resolve.

The tarball ships the built `lib/`, the `docs/`, and the auditable economics
profiles under `profiles/economics/` — so a consumer following the README to any
of those finds what it references.

## Documentation

49 documents in [`docs/`](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/tree/v0.1.0/docs),
in three kinds — design records, evaluation reports, and defect records. Where a
later document falsified an earlier conclusion, the earlier one says so in place
rather than being rewritten; the audit trail is the point.

New readers: [00](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/blob/v0.1.0/docs/00_README_EF.md)
for the model,
[42](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/blob/v0.1.0/docs/42_DEPLOYMENT_CHAIN.md)
to install and operate it, and
[47](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/blob/v0.1.0/docs/47_RC21_CLIENT_TYPECHECK_AND_CONTRACT.md)
for how the recent work is verified.

## License

MIT. `src/basic/` is vendored from DeepSeek Harness (MIT) with the
`frameCheckpoint` seam inlined — see
[THIRD_PARTY_NOTICES.md](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/blob/v0.1.0/THIRD_PARTY_NOTICES.md).
