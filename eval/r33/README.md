# R33 — Semantic Continuity Behavioral Evaluation

This directory is the R33 instrument. It asks whether correctly committed
semantic state changes what a follow-up agent does, not whether the journal is
well-formed.

**Current status:** R33.1 closed the evaluator defects; dataset v2 and the
separate holdout are frozen. The live model run is **not executed** (no explicit
budget permission, route, or authorization). The scripted results are a pipeline
measurement, **not a model result**.

## Quick start

```bash
npm run eval:r33-verify       # manifest matches every case
node eval/r33/freeze.mjs --holdout --verify
npm run eval:r33              # offline arms + integrity tests (62 tests)
npm run eval:r33-live-check   # interface only; no credentials
npm run eval:r33-self-test    # four arms, real fold/tool-loop, scripted adapter
npm run eval:build            # only for a live --run
```

Reports are written to `eval/r33/out/`. `out/*-work/` is scratch and ignored.

## Files

| Path | What it is |
|---|---|
| `manifest.json` | Dataset id, per-case digests, dataset digest. Authoritative. |
| `cases/<id>/case.json` | Transcript, task, writer proposal, gold, action metadata, decisions. |
| `cases/<id>/workspace/**` | The exact initial files the follow-up agent sees. |
| `cases/<id>/actions/<name>/**` | Files one scripted action applies. |
| `cases/<id>/check.mjs` | Hidden checker, run outside the workspace. |
| `src/dataset.mjs` | Load, validate, digest, freeze, verify. |
| `src/schema.mjs` | Case schema and no-gold-leakage rules. |
| `src/context.mjs` | Arm contexts and the scripted decision rule. |
| `src/workspace.mjs` | Materialization, action application, checker execution. |
| `src/grade.mjs` | Extraction, behavior and paired statistics. |
| `src/budget.mjs` | One global ledger, live gate, run statuses, exit codes. |
| `freeze.mjs` | `--verify` / freeze. |
| `build-cases.mjs` | One-time authoring tool for the case directories. |
| `live.mjs` | `--check`, `--self-test`, `--run` (gated). |

## Arms

Primary live arms: `B1` EF off, `S` Active, `O1` oracle delta, `O2` oracle
current facts. Optional controls: `B0` Basic, `OR` oracle evidence, `F` full
history, `N` null, `FM` false-memory fault.

B0/B1 commit no semantic state; their extraction metrics are `null`, not 0.
O1 goes through the real validator, planner, journal, working set, and per-fold
limit; it is not a text-injection bypass. When S runs first, O1 reuses S's
handoff and records `oracleBasis: s-conditional`.

## Dataset

Development set `r33-semantic-continuity-v2`: 17 cases, 5 counterfactual pairs,
7 diagnostic singles, digest `407148f0…87f`. The separate holdout
`r33-semantic-continuity-holdout-v1` (2 cases, digest `af22eb7a…663`) is frozen
and **not executed**.

Risk classes: persistent constraint, decision override, negative knowledge,
validation boundary, cross-phase dependency, authority/scope, retrieval trigger,
and history-independent controls.

To add a case:

1. Add `cases/<id>/case.json`, `workspace/`, `actions/<name>/`, `check.mjs`, with
   `checker.expectedChecks` and `requiresTests`.
2. `npm run eval:r33-freeze`.
3. Run `npm run eval:r33`.

The schema refuses a history-dependent case if its workspace contains a gold
quote or needle, refuses a quote absent from ANY authoritative `sourceRef`, and
refuses a normative fact with no user source. The checker must print one
`R33_RESULT {json}` line; the harness reads only the last marker from a trusted
bootstrap, validates the declared checks, and never trusts stdout.

## Live run

```bash
npm run eval:build
R33_LIVE=1 R34_LIVE_BASE_URL=... R34_LIVE_API_KEY=... \
node eval/r33/live.mjs --run --manifest eval/r33/live-manifest.example.json
```

The manifest must contain a model, `maxOutputTokens`, route env-var NAMES, and
positive request, input-token, output-token and wall-clock limits. `0` is
refused, not unlimited. One ledger is admitted immediately before every HTTP
attempt, including a 429 resend; partial/unknown usage keeps its reserve.

The manifest may not embed an authorization/api-key/cookie header. `--check`
resolves no credentials; `--run` without `R33_LIVE=1` exits 3 and makes no
request.

Exit codes: `0` success, `2` partial, `3` not-executed, `4` budget-exhausted,
`5` provider-unavailable, `6` invalid-benchmark, `7` failed.

The follow-up protocol is one JSON object per turn:

```json
{"tool":"read_file","path":"src/config.mjs"}
{"tool":"write_file","path":"src/config.mjs","content":"..."}
{"tool":"list_dir"}
{"tool":"run_tests"}
{"tool":"recall","query":"..."}
{"tool":"finish","summary":"..."}
```

`recall` searches the frozen transcript. It is a controlled stand-in for exact
recall and is how the retrieval trigger is measured; the system prompt never
names the fact to look for.

## What not to infer

* Scripted 15/17 is not a model success rate.
* `coverage: not-assessed` is not “the writer covered everything”.
* A passing checker is task success for this micro-repository, not for a real
  codebase.
* Small paired samples are exploratory; see `R33_DECISION.md`.
