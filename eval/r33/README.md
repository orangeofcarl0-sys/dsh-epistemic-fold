# R33 — Semantic Continuity Behavioral Evaluation

This directory is the R33 instrument. It asks whether correctly committed
semantic state changes what a follow-up agent does, not whether the journal is
well-formed.

**Current status:** offline arms and the frozen dataset are complete. The live
model run is **not executed** (no explicit budget permission or resolved route).
The scripted results are a pipeline measurement, **not a model result**.

## Quick start

```bash
npm run eval:r33-verify       # manifest matches every case
npm run eval:r33              # offline arms + R33-0 tests (25 tests)
npm run eval:r33-live-check   # interface only; no credentials
npm run eval:r33-self-test    # real fold/tool-loop plumbing; scripted adapter
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

`B0` Basic, `B1` EF off, `S` Active, `O1` oracle delta, `O2` oracle facts,
`OR` oracle evidence, `F` full history, `N` null, `FM` false-memory fault.

B0/B1 commit no semantic state; their extraction metrics are `null`, not 0.
O1 goes through the real validator and per-fold limit; it is not a bypass.

## Dataset

17 cases, 5 counterfactual pairs, 7 diagnostic singles. Risk classes:
persistent constraint, decision override, negative knowledge, validation
boundary, cross-phase dependency, authority/scope, retrieval trigger, and
history-independent controls.

To add a case:

1. Add `cases/<id>/case.json`, `workspace/`, `actions/<name>/`, `check.mjs`.
2. `npm run eval:r33-freeze`.
3. Run `npm run eval:r33`.

The schema refuses a history-dependent case if its workspace contains a gold
quote or needle. The checker must print one `R33_RESULT {json}` line with named
checks.

## Live run

```bash
R33_LIVE=1 \
EF_LIVE_BASE_URL=... EF_LIVE_API_KEY=... \
node eval/r33/live.mjs --run --manifest live-manifest.json
```

The manifest must contain a model, route env-var names, and positive request,
input-token, output-token and wall-clock limits. `0` is refused, not unlimited.
One ledger covers the fold's writer call, every follow-up turn, and every retry.

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
