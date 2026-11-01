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
Live status       blocked / not-executed (0 provider requests, 0 tokens)
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

## Commands

```bash
npm run build                    # rebuild lib/ (gitignored)
npm run eval:build               # rebuild eval/live/dist for live.mjs
npm run eval:r33                 # R33 + R34.1 + R35 targeted suites (85 tests)
npm run eval:r35                 # only the new R35 tests (23 tests)
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

- Targeted R33/R34.1/R35 suites: 14 files, 85 tests passed.
- Full suite: 1445 passed, 3 failed, 66 skipped. All three failures are the
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

```text
real writer outputs:       0
real B1/S pairs:           0
real tool loops:           0
real checker outcomes:     0
observed/charged tokens:   0
```

There is no real-model result. The gate is blocked on explicit authorization,
a resolved provider/model route, and a positive budget including a per-request
output bound.

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

## Next step (requires the user)

Run the writer-only pilot first:

1. Supply explicit permission to spend, a resolved route, a model id, a
   positive request/input/output/wall-clock budget, and a per-request output
   bound of at least 16,384.
2. Run `--preflight`; resolve every `infeasible` or `unknown-model-capability`.
3. Run `--stage writer-only` on 4–6 discriminating cases.
4. Save raw output, protocol, proposals, refusals, commit state, source support,
   and usage before changing any writer prompt.
5. Only then run `--stage continuation` for B1/S/O1/O2.

Do not start R35 product changes before that evidence exists. No MemoryOS,
vector database, Experience Bank, knowledge graph, second compaction engine, or
active prefetcher is justified by the current evidence.

## Review package

`R35_REVIEW_PACKAGE/` (not committed) contains the patch, commit patches, test
logs, manifests, reports, docs, environment, and checksums. It contains no
credentials, authorization headers, or private environment values.
