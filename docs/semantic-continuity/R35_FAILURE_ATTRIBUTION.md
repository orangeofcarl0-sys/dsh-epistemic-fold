# R35 — Failure Attribution

## Status

The first authorized live attempt failed before any semantic behavior could be
observed: 6 real writer calls, 6 HTTP 401 `api_key_expired`, 0 writer outputs,
0 tokens. The earliest confirmable failure is **provider authentication** — not
the writer prompt, the validator, the journal, or the agent. No real-model
semantic failure can be attributed yet.

This document records that first real failure, the instrument defect it exposed,
and the local counterexamples that prove each distinction.

## 0. The first real failure: authentication, not semantics

```text
historical fact
  -> real EF fold                     executed
  -> semantic writer request          6 attempted
  -> provider authentication          FAILED: HTTP 401 api_key_expired
  -> writer output                    none
  -> deltas / validator / journal     never reached
```

The six cases (A1, B2, C1, D1, F1, H1) all stopped at the same point. The fold
still produced a deterministic checkpoint, so the rows are valid measurements of
the fold path, but they are not writer measurements: `writer.call = failed`,
`writer.protocol = not-called`, `writer.rawOutput = null`, and
`failures.task.assessed = false`.

Attribution rule applied: do not advance a later stage’s explanation when an
earlier stage failed. The writer did not “omit” anything; it was never heard
from.

### The instrument defect this exposed

The first run of the pilot reported `executed-success` and “12/12 writer
measurements valid”. Six of those rows were O1 oracle controls that never touch
the network; they masked the fact that all six real writer calls had failed. The
run-level test required every row to carry a provider failure, which oracle rows
do not.

Fixed by separating provider rows from controls:

```text
rowExpectsProviderCall(stage, arm)   writer-only: S only
providerAvailability(rows)           successes over rows that must call
writerMeasurements(rows)             real calls vs oracle controls
```

The corrected run is `provider-unavailable` with 0/6 real writer calls
completed. The superseded report remains in the run archive as evidence.

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
  the follow-up's 131,072 / 1,024 charged reserve remain in `cost`. Because the
  writer call succeeded, the route is not reported as unavailable; the run is
  `executed-failed` with `measurementValid = false`, which says the measurement
  is incomplete rather than blaming the provider for the whole run.
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
whether a real writer follows the protocol at all
writer omission on a real model
real protocol malformation
real unsupported normative claims
real verification overclaim
real retrieval failure
real cost per successful task
```

These require a working provider route. The authorized attempt died at
authentication, before any of them could be observed. No prompt, gold, or writer
change was made in anticipation of what that run might show.
