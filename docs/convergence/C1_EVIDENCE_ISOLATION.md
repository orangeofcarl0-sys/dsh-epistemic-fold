# EF-C1 — Evidence Isolation

Status: verified 2026-11-08. Worktree `ef-c1-foundation`, base `327598f`.

This document answers the first C1 question: **do ordinary tests, dependency
installation and builds still modify historical authority artifacts?**

The answer before this round was yes, in four measured places. The answer after
it is no, measured the same way.

## 1. What was measured, and how

`eval/c1/observe.mjs` takes a content snapshot of every protected artifact, runs
one command, and takes the snapshot again. It never restores anything; the
before/after pair is the record.

```bash
node eval/c1/observe.mjs --id <name> -- <command...>
```

Every observation is stored under `eval/c1/out/observation-<name>.json`. The
protected set is `eval/c1/out/protected-artifacts.json` — 287 paths: 12 explicit
files plus the 275 evidence artifacts EF-C0's manifest classifies.

### Before the fix

| Trigger | Protected artifacts rewritten |
|---|---|
| `npm ci` | `cordis.patch.yml` |
| `npx vitest run tests/r33-live-entry.spec.ts` | `eval/r33/out/live-report.json`, `eval/r33/out/live-check.json` |
| `npx vitest run tests/r33-arms.spec.ts` | `eval/r33/out/offline-report.json`, `eval/r33/out/offline-report.md` |
| `npx vitest run tests/r1-report.spec.ts` | `docs/12_R1_EVALUATION_REPORT.md`, `docs/MANIFEST.json` |

The observation files are `observation-pre-*.json`. The R33 offline report did
not merely get a new timestamp: 4,618 JSON lines changed, because the committed
report is a scorerVersion 2 record and the current scorer is 3.

### After the fix

| Trigger | Protected artifacts rewritten |
|---|---|
| `npm ci` | none |
| `npx vitest run tests/r33-live-entry.spec.ts` | none |
| `npx vitest run tests/r33-arms.spec.ts` | none |
| `npx vitest run tests/r1-report.spec.ts` | none |

The observation files are `observation-post-*.json`. `tests/c1-evidence-isolation.spec.ts`
re-derives the cheap part of this property on every run: the registry is
internally consistent, and the three compare modes leave every protected hash
unchanged.

## 2. The write inventory

`eval/c1/side-effects.mjs` scans `tests/`, `eval/` and `scripts/` for write
APIs, then classifies each site against a curated table of every writer that can
reach a tracked path.

```text
write sites                     169 in 77 files
unclassified repo-shaped sites  0
```

Categories and counts (a site is classified by what it WRITES):

| Category | Sites | Meaning |
|---|---:|---|
| temporary-test-output | 83 | `makeTemp` / `mkdtemp`, outside the repository |
| frozen-historical-artifact | 59 | explicit generators of R33-R38 evidence |
| tracked-generated-config | 20 | presets, maps, docs manifest, C0/C1 data |
| latest-convenience-copy | 3 | `--check` / `--self-test` / latest live report |
| build-artifact | 3 | `lib/`, `eval/live/dist/` (gitignored) |
| tracked-generated-source | 1 | `scripts/vendor-basic.mjs` → `src/basic/*.ts` |

The scan is candidate discovery, not a verdict: a site is only classified as
temporary when its target expression does not name the repository. A site the
scan cannot classify is reported in `scan.uncoveredRepoFiles`; that list is
empty.

## 3. Verify / generate / promote

The three operations are now separate for every generator that can reach a
tracked path.

| Artifact | Verify (default) | Generate (candidate) | Promote |
|---|---|---|---|
| R1 report | `npm run eval:r1-report:check` — measure, compare, no write | `npm run eval:r1-report:generate` → `eval/r1-report/out/` | `npm run eval:r1-report:write` |
| R33 offline report | `tests/r33-arms.spec.ts` default — candidate in the test temp root | `npm run eval:r33-offline-report` → `eval/r33/offline-candidate/` | not implemented; promote is a later decision |
| docs manifest | `node scripts/generate-docs-manifest.mjs` | `--output <path>` | `--write` |
| preset block | `node scripts/generate-presets.mjs --check` (exit 2 on drift) | `--output <path>` | `--write` |
| resolution maps | `node scripts/generate-maps.cjs --check` (exit 2 on drift) | `--output <dir>` | default write, kept for the documented rebase |

Two details that matter:

- `prepare` runs `generate-presets --check --warn-only`. It must never fail an
  install: a machine with no DSH cannot verify the block, and a machine whose
  DSH moved should get a warning, not a broken `npm install`. The boot-time
  doctor remains the authority for the DSH that actually runs the plugin.
- The R33 live runner's convenience copy is now opt-in (`R35_WRITE_LATEST=1`).
  A refused run gets its own run-scoped record under `R33_RUN_ROOT` and never
  replaces the latest live report. `R35_WRITE_LATEST=0` still means "do not
  write", so the old opt-out is compatible.

## 4. The historical reports are stale, and that is recorded

Fixing the side effect exposed a second fact: two committed reports do not
reproduce from the current code. They are historical records; this round did
not rewrite them and did not edit their numbers.

`docs/convergence/data/report-baselines.json` declares each one:

| Report | Status | Cause |
|---|---|---|
| `docs/12_R1_EVALUATION_REPORT.md` | stale | the attribution model gained a `checkpoint-root` bucket; totals unchanged, root-fold tokens (W1 3,240, W3 5,160, W4 4,560) moved out of framing/identity/rationale |
| `eval/r33/out/offline-report.json` | stale | the committed report is scorerVersion 2; the current scorer is 3 and its rows carry the R36/R37 behaviour fields |
| `eval/r33/out/live-check.json` | stale | the snapshot predates scorerVersion 3 and the four fixture arms (FP/FS/FN/FH) |
| `eval/r33/out/live-report.json` | superseded | a 2026-11-01 gate-refusal record; refusals are now run-scoped |

The verification tests (`tests/r1-report.spec.ts`, `tests/r33-arms.spec.ts`,
`tests/r33-live-entry.spec.ts`) enforce two rules:

1. the committed bytes match the declared frozen hash — a silent edit fails;
2. if the current generator differs, the difference is declared with a cause
   and the observed digest — a silent drift fails.

The digest excludes run metadata (`generatedAt`, `environment`, per-case and
per-arm wall-clock durations). Those are reproducible-machine properties, not
semantic content, and a digest that included them could never be pinned.

## 5. What this does not prove

- It does not prove the reports are correct; it proves they were not silently
  changed, and that any drift is declared.
- It does not promote the stale reports. Whether to regenerate the R1 report and
  the R33 offline report is a separate decision (see `C1_DECISION.md`).
- It does not cover a future test that writes a new tracked path. The
  inventory makes that visible only after the scan is re-run; the isolation
  test checks that no CURRENT site is unclassified.
- The `npm ci` observation depends on this machine having a DSH home. On a
  machine without one, `prepare` takes the "no DSH found" branch and writes
  nothing either way.
