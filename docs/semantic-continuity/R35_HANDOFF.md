# R35 — Handoff

## State

```text
Repository        orangeofcarl0-sys/dsh-epistemic-fold
Branch            rc35-real-semantic-evaluation
Base              R34 HEAD 8db92f425a35e41bb77158a830de31d5c4874736
Worktree          F:/Codex_Work_Space/DSH plugin/ef-r35-live
Development set   r33-semantic-continuity-v2
Dataset digest    407148f0c3280ada831b72150640ac6cdf14dceae600c3dcdbf2a61bd8e0c87f
Holdout           r33-semantic-continuity-holdout-v1
Holdout digest    af22eb7a91155507998750f0428be8bb7c6285696179128a75e83f3eeaada663
Scorer            v2
Live status       writer-only executed (16 scored rows); continuation executed (9 valid pairs)
```

The primary worktree and the R30–R34 worktrees are untouched. R34's commits and
review package are preserved; this round adds a new worktree rather than reusing
or resetting the R34 one.

## What changed

- Retry accounting is single-source at the ledger; the adapter's telemetry is a
  cross-check only.
- One `failures` record per row separates provider, budget, fold, checker,
  harness, and task outcomes.
- Case cost is computed from ledger snapshots even when the case throws; a
  budget refusal inside a safely degraded call is recorded and stops the run.
- Per-case cost separates observed, reserved, and charged tokens, HTTP attempts
  and retries, unknown/partial usage, refusals, `caseDurationMs`, and
  `runElapsedMs`.
- `--preflight` runs the real fold with a dry-run adapter, captures the actual
  writer/rationale `maxTokens`, checks the manifest's limits, model capability,
  total plan, and run-directory collision, and makes no provider request.
- `--stage writer-only` runs the real writer/validator/journal/working-set/
  checkpoint chain and stops before the follow-up agent.
- `--stage continuation` records functional success, historical constraint
  compliance, process compliance, contract success, and verification freshness.
- The visible test command was `node --test tests`, which Node treats as a
  module path. Every visible run therefore failed. It is now `node --test`,
  which discovers `**/*.test.{js,mjs,cjs}`; D2's correct `verified` claim is
  fresh instead of being counted as false.
- The authoritative report is `<runRoot>/<runId>/report.json`; the convenience
  copy is best-effort.
- The example manifest is compatible with the real 16,384-token writer floor.
- Run-level provider availability now counts only rows that must reach the
  provider. Oracle controls can no longer mask a dead route; `runQuality` reports
  real writer calls separately from oracle controls.
- `eval/r35/run-authorized.mjs` resolves the route from the ZCode config, keeps
  the key in the child environment only, runs preflight then the pilot, and
  writes per-run artifacts. An explicit `R35_REPLICATE_ID` labels repeated runs.
- A fold whose summary is not smaller than its span is recorded as
  `fold-refused`, its raw writer output is preserved, and the run continues.
  Before the fix, one such case aborted every remaining case.
- Writer-only extraction is scored from the parsed/committed packet, not left at
  "this arm commits no semantic deltas". `runQuality` adds
  `writerExtraction`, aggregated over real writer rows only.

## Commands

```bash
npm run build                    # rebuild lib/ (gitignored)
npm run eval:build               # rebuild eval/live/dist for live.mjs
npm run eval:r33                 # R33 + R34.1 + R35 targeted suites (94 tests)
npm run eval:r35                 # only the new R35 tests (32 tests)
npm run eval:r33-verify          # dataset digest
node eval/r33/freeze.mjs --holdout --verify

node eval/r33/live.mjs --preflight \
  --manifest eval/r33/live-manifest.example.json

# AFTER explicit authorization, a resolved route, and a positive budget:
R33_LIVE=1 node eval/r33/live.mjs --run --stage writer-only \
  --cases A1,B2,C1,D1,F1,H1 --manifest <authorized-manifest.json>
```

Do not put a credential value or authorization header in the manifest. Use the
environment-variable names the manifest declares.

## Results

### Evaluation-integrity closure

- Targeted R33/R34.1/R35 suites: 14 files, 94 tests passed.
- Full suite: 1454 passed, 3 failed, 66 skipped. All three failures are the
  known installed-vs-vendored DSH drift assertions (`bridge-loads`,
  `rc3-plugin-packaging`, `rc7-inplace-drift`); no R33/R34.1/R35 test fails.
- Typecheck: source, client, and eval all pass.
- Mock provider `429, 429, 200`: 3 HTTP attempts, 2 retries, 2 unknown-usage
  attempts, final report retries 2, `retryAccounting.consistent = true`.
- Request limit 2: the third HTTP request never happens.
- Writer HTTP 500: fold remains valid, provider failure recorded, task axis not
  assessed, whole output reserve charged.
- Follow-up HTTP 500 after a successful writer: row invalid, provider failure
  with stage `follow-up`, earlier writer tokens preserved.
- All tasks fail the hidden checker: `executed-failed`,
  `measurementValid = true`, no provider failure.
- Budget refusal inside a safely degraded writer: `budget-exhausted`, 1 attempt,
  1 refusal, charged reserve preserved.
- Preflight on the example manifest: 12/12 feasible, 0 provider requests,
  0 credentials read.
- Preflight with `maxOutputTokens = 8192`: refused; actual writer bound 16,384.
- Four-arm self-test: 68/68 functional success and 68/68 contract success.
  15/17 visible suites pass per arm; C1 and D1 do not claim verification, so
  neither is a false verification. D2's `verified` claim is fresh.
- Writer-only self-test A1 S/O1: 2/2 valid, protocol parsed, commit committed,
  state digest and raw-output digest recorded; 380 raw writer characters.

### Live model experiment

The user authorized spend on `opencode` / `deepseek-v4.1-flash`. The first
authorized route was expired: 12 writer calls and 4 probes returned HTTP 401
`api_key_expired` / `ECONNREFUSED`. That phase is retained as
`provider-unavailable` evidence, not as a writer result. A refreshed key was
then supplied outside the repository; the probe returned `stop` at the 16,384
output bound, and the writer-only stage ran on the six cases.

```text
probe:                 37 input / 12 output, finish=stop, max_tokens=16,384 accepted
writer runs:           3 (5 + 6 + 6 calls)
scored rows:           16
protocol parsed:       10 / 16
gold facts in raw:     8 / 8
gold facts committed:  6 / 8 full, 1 partial, 1 unparsed
false normative:       0 accepted
verification overclaims refused: 2
authority-overreach refused:     2
provider failures:     0 in the scored runs
observed tokens:       17,280 input / 40,841 output + 1,920 cache read
writer-run wall clock: 431,168 ms
```

The writer extracted every critical fact at least once. The first bottleneck is
the response envelope: H1 was malformed in both runs and its correct `eu-west-2`
fact never reached the validator; B2 and F1 were malformed in one run each. The
second is the writer's status/kind choice: C1's 12/40 tool-proven failure was
refused because it was proposed as `verified` without `verificationQuote` and as
a `rejected-approach` on tool evidence. The validator correctly refused every
overclaim and authority-overreach proposal.

The automatic exact scorer reports 0 recall because the model paraphrases and
uses its own coordinates. Manual adjudication against the frozen transcript finds
the facts equivalent; the original score and the adjudication are both preserved.
See `R35_WRITER_RESULTS.md` and `R35_ADJUDICATION.json`.

### Continuation

Three B1/S/O1/O2 continuation runs used the custom text-JSON tool loop and the
hidden checkers:

```text
run  valid  task  contract  process violations  false verification  requests
r1   18/24   7       3            12                   3             162
r2   24/24  10       6            13                   4             209
r3   24/24   4       0            22                   4             207
```

r1 lost three B1/O2 rows to a fold-refusal abort. r2 introduced a fallback but
passed an empty checkpoint to the follow-up; every r2 B1/S pair is therefore
excluded. r3 fixes the fallback to the uncompressed transcript and is the
authoritative complete-pair run.

Across the 9 valid B1/S pairs (r1 3, r3 6): 0 rescue, 0 damage, 0 both, 9
neither. The dominant measured bottleneck is the agent's process compliance, not
semantic memory delivery. The full breakdown is in
`R35_BEHAVIORAL_COMPARISON.md`.

## Known limits

- The follow-up loop is a custom text-JSON loop, not the production DSH agent
  loop.
- `recall` searches the frozen transcript, not production `context_search`.
- Same-user code is not OS-sandboxed; `ISOLATION_LEVEL.osSandbox = none`.
- The holdout is frozen but unexecuted.
- The custom loop's `maxTokens` for follow-up is 1,024; the writer/rationale
  call is 16,384 on these transcripts. The manifest's bound must cover the
  writer.
- No currency is reported; no trusted price profile exists.
- Scripted and mock results are instrument checks, not model behaviour.

## Next step

The live evidence is saved and frozen. The next work is not another memory
subsystem; it is the two bottlenecks the data actually shows:

1. **Writer contract.** Enforce and test the response envelope
   (`{"deltas":[...]}`), the `verified` + `verificationQuote` rule, and the
   `rejected-approach` authority rule. The writer produced correct content that
   the validator could not accept: H1/C1 tool facts marked `verified`, and C1
   negative knowledge encoded as a normative rejected-approach on tool evidence.
2. **Agent process compliance.** The custom loop often finishes without running
   the visible tests and sometimes claims a verification it does not have. The
   contract metric already detects this; the loop or the task prompt must require
   the process, not just reward the functional checker.
3. **Then** a larger paired run (more cases and replicates, family-aware
   analysis) to test whether the writer-contract fix changes contract success.

Do not change the frozen dataset, gold, or hidden checkers to make the numbers
look better. Do not count the r2 fallback rows as a full-history baseline. No
MemoryOS, vector database, Experience Bank, knowledge graph, second compaction
engine, or active prefetcher is justified by the current evidence.

## Review package

`R35_REVIEW_PACKAGE/` (not committed) contains the patch, commit patches, test
logs, manifests, reports, docs, environment, and checksums. It contains no
credentials, authorization headers, or private environment values.
