# R35 — Failure Attribution

## Status

No real-model failure can be attributed yet: there are 0 provider requests and 0
real writer outputs. This document records the failure mechanisms the instrument
now distinguishes, and the local counterexamples that prove each distinction.

## 1. A retry counted twice

`BudgetLedger.retry()` runs inside the adapter when a 429 attempt is abandoned.
R34's main loop also added `rateLimitTelemetry.retries` to the ledger at the end
of the run, so `429, 429, 200` reported four retries. The second loop is removed.
The report carries:

```text
retryAccounting.authority = ledger
retryAccounting.ledgerRetries = 2
retryAccounting.adapter.retries = 2
retryAccounting.consistent = true
```

The adapter counter is a cross-check only. A mismatch is reported as a
diagnostic; it is never added.

## 2. A provider failure read as a task failure

R34 stored a normal-path provider failure at
`row.behaviourDetail.providerFailure` and an exception-path failure at
`row.providerFailures`, then tested only the second. A run where every model call
failed could be reported as an ordinary negative task result. Rows now carry one
`failures` record, and `runStatus` uses provider evidence separately from task
evidence.

Verified cases:

- **Writer HTTP 500, fold safely degrades.** The fold still commits a
  deterministic checkpoint. The row is valid for the writer-only measurement,
  has `failures.provider[0].kind = provider-http-error` and
  `stage = fold-writer`, and `failures.task.assessed = false`. The run status is
  `provider-unavailable` because no provider call succeeded.
- **Follow-up HTTP 500 after a successful writer.** The row is invalid,
  `failures.outcome = provider-http-error`, `stage = follow-up`, and
  `failures.task.assessed = false`. The writer's observed input/output tokens and
  the follow-up's 131,072 / 1,024 charged reserve remain in `cost`.
- **Every task fails the hidden checker, provider healthy.** The row is valid,
  `failures.outcome = valid-task-failure`, `failures.provider` is empty,
  `failures.task.assessed = true`, and the run is `executed-failed` with
  `measurementValid = true`. This is a research result, not a harness error.

## 3. An exception that hid spent money

The exception branch wrote zero cost. The case boundary now snapshots the ledger
before and after the call and computes the delta regardless of how the case
ended. A budget refusal thrown inside a safely degraded writer is counted as a
refusal, its request stays charged, and the run stops with `budget-exhausted`
instead of reporting a successful writer-only measurement.

## 4. A stale test result promoted to a verified revision

The follow-up loop hashes the workspace source after every write and after every
visible test run, excluding `verification.json` because it is task metadata, not
source. `verifiedCurrentCode` is true only when the last passing test's digest
equals the final source digest. A model that writes code, runs a passing test,
edits again, and claims `verified` is recorded as a false verification claim.
The historical passing run remains in `lastPassingTest`, but it is not promoted.

## 5. A budget refusal that never reaches the runner

The adapter's budget refusal is thrown before `fetch`. The engine catches writer
failures and safely degrades the fold, so the runner does not see the exception.
`RecordingAdapter` now records the thrown refusal before rethrowing, and the row
attributes it to the budget axis. The run status is `budget-exhausted` with the
actual attempt count and charged reserve.

## 6. What is still unattributed

```text
writer omission on a real model
real protocol malformation
real unsupported normative claims
real verification overclaim
real retrieval failure
real cost per successful task
```

These require the authorized live run. No prompt, gold, or writer change was
made in anticipation of what that run might show.
