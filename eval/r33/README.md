# R33 — Semantic Continuity Behavioral Evaluation

This directory is the R33 instrument. It asks whether correctly committed
semantic state changes what a follow-up agent does, not whether the journal is
well-formed.

**Current status:** R36 closed the R35 evidence and the D1/C1 benchmark
validity problems. The R35 writer evidence is reconstructed as 17 attempts / 16
scoreable rows / 1 lost row: 10/16 protocol parsed, every gold fact present in
raw output, 9/16 accepted, and the L0→L4 funnel ending at 0.625 direct
visibility. The six protocol failures are four bare arrays, one concatenated
object sequence, and one real syntax error. The D1 scorer is now temporal
(scorer v3), C1 is certified with a polling-plus-hint reference, and 7/7
behavioural cases pass visible, hidden, and historical checks. W1 aligns the
writer prompt with the validator; W0 is frozen byte-for-byte. A P1
envelope-recovery ablation raises accepted-fact recall from 0.5625 to 0.875
without changing any proposal. R36 made **zero** provider requests: the live
W1-P0, O2 calibration, and B1/S manifests are `blocked`. The R35 B1/S result
remains 9 valid pairs, all `neither`, and is not an equivalence result. The
scripted results are a pipeline measurement, **not a model result**.

## Quick start

```bash
npm run eval:r33-verify       # manifest matches every case
node eval/r33/freeze.mjs --holdout --verify
npm run eval:r33              # R33 + R34.1 + R35 targeted tests (94 tests)
npm run eval:r36-tests        # R36 audit/benchmark/writer/harness tests (22 tests)
npm run eval:r36              # deterministic R36 audit, ablation, certification, gates
npm run eval:r33-live-check   # interface only; no credentials
node eval/r33/live.mjs --preflight --manifest eval/r33/live-manifest.example.json
npm run eval:r33-self-test    # four arms, real fold/tool-loop, scripted adapter
npm run eval:build            # only for a live --run
```

Reports are written to `eval/r33/out/`. A live run writes its authoritative
report to `$R33_RUN_ROOT/<runId>/report.json`; `out/live-report.json` is a
convenience copy. `out/*-work/` and `out/self-test-runs/` are scratch and
ignored.

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
| `src/workspace.mjs` | Materialization, path containment, checker execution, source digest. |
| `src/grade.mjs` | Extraction, behavior/contract metrics, paired statistics. |
| `src/budget.mjs` | One global ledger, manifest validation, live gate, run statuses. |
| `src/failures.mjs` | One outcome/failure vocabulary for provider, budget, fold, checker, task. |
| `freeze.mjs` | `--verify` / freeze. |
| `build-cases.mjs` | One-time authoring tool for the case directories. |
| `live.mjs` | `--check`, `--preflight`, `--self-test`, `--run` (gated), `--stage`. |

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

### 1. Preflight (no provider request)

```bash
node eval/r33/live.mjs --preflight --manifest eval/r33/live-manifest.example.json
```

This runs the real fold path with a dry-run adapter and records the actual
writer/rationale `maxTokens` (currently 16,384 on these transcripts) and the
context-window input reserve. It refuses a manifest whose per-request bound is
too small, whose input budget cannot admit one reserve, whose total plan exceeds
its request limit, or whose run directory already exists. It reads no route
credential and opens no connection.

### 2. Writer-only (real fold, no follow-up)

```bash
npm run eval:build
R33_LIVE=1 R35_LIVE_BASE_URL=... R35_LIVE_API_KEY=... \
node eval/r33/live.mjs --run --stage writer-only \
  --cases A1,B2,C1,D1,F1,H1 \
  --manifest <authorized-manifest.json>
```

The real DSH fold, semantic writer, delta parsing, evidence validation, journal,
working set, and checkpoint run. The follow-up agent does not. The row records
the writer call, raw output digest, handoff, proposed/accepted/refused deltas,
refusal reasons, commit status, rendered checkpoint, state digest, and actual
provider usage.

### 3. Continuation (real follow-up agent)

```bash
R33_LIVE=1 ... node eval/r33/live.mjs --run --stage continuation \
  --cases A1,B2,C1,D1,F1,H1 --manifest <authorized-manifest.json>
```

B1/S/O1/O2 share the frozen transcript, fold boundary, initial workspace, task,
route, model parameters, tool permissions, and checker. They use separate
session, journal, bundle root, workspace, and trace.

### Manifest and gate

The manifest must contain a model, `maxOutputTokens`, route env-var NAMES, and
positive request, input-token, output-token and wall-clock limits. `0` is
refused, not unlimited. One ledger is admitted immediately before every HTTP
attempt, including a 429 resend; partial/unknown usage keeps its reserve.
`maxOutputTokens` must be at least the value `--preflight` reports.

The manifest may not embed an authorization/api-key/cookie header. `--check`
resolves no credentials; `--run` without `R33_LIVE=1` exits 3 and makes no
request.

Exit codes: `0` success, `2` partial, `3` not-executed, `4` budget-exhausted,
`5` provider-unavailable, `6` invalid-benchmark, `7` failed. Preflight uses `0`
compatible, `2` incompatible, `6` invalid.

`--run` writes `$R33_RUN_ROOT/<runId>/report.json`. The report separates
`provider`, `budget`, `fold`, `checker`, `harness`, and `task` failure axes; a
provider failure is never an agent task failure. It also reports observed,
reserved, and charged usage, HTTP attempts and retries, `caseDurationMs`, and
`runElapsedMs`.

`behaviour` keeps the historical `taskSuccess` (functional success) and adds:

```text
historicalConstraintCompliance
processCompliance
contractSuccess
verificationFreshness   currentDigest, lastModification, lastPassingTest,
                        verifiedCurrentCode
```

A passing test on an older source digest remains historical evidence; it does
not verify the final revision.

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
