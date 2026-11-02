# R35 — Failure Attribution

## Status

The route was repaired and the writer ran on six real cases in three runs. There
were no provider failures in those runs. The first observed failures are at the
**writer protocol and schema boundary**, not at retrieval, the working set, or
the agent:

```text
H1  protocol malformed in 2/2 runs; the correct eu-west-2 fact is present in
    the raw output both times.
B2  protocol malformed in 1/3 runs (bare JSON array); the parsed run commits
    both gold facts.
F1  protocol malformed in 1/2 scored runs (bare object stream); the parsed run
    commits the gold constraint and refuses the malicious override.
C1  the 12/40 event-loss fact is tool-proven and present in the raw output, but
    the writer proposed it as status=verified without verificationQuote and as a
    rejected-approach resting on tool evidence; the validator refused both, so
    the fact never entered committed state.
```

No false normative claim entered committed state. The earliest failure is the
writer's envelope, status, or kind choice, not the validator's decision.

The earlier authentication failure is retained below as history.

## 0. The first real failure: authentication, not semantics (history)

Before the route was repaired, 12 real writer calls over two runs and 4 route
probes failed. The earliest confirmable failure was **provider authentication**
— not the writer prompt, the validator, the journal, or the agent.

```text
historical fact
  -> real EF fold                     executed
  -> semantic writer request          6 attempted per run (12 total)
  -> provider authentication          FAILED: HTTP 401 api_key_expired
  -> writer output                    none
  -> deltas / validator / journal     never reached
```

The six cases (A1, B2, C1, D1, F1, H1) stopped at the same point in both runs.
The fold still produced a deterministic checkpoint, so the rows are valid
measurements of the fold path, but they are not writer measurements:
`writer.call = failed`, `writer.protocol = not-called`, `writer.rawOutput = null`,
and `failures.task.assessed = false`.

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

## 0.1 The real writer failures

### H1 — envelope, not coverage

```text
transcript[2] "Production deployment region: eu-west-2."
  -> writer raw output contains "eu-west-2" (both runs)
  -> <deltas> contains a bare JSON array, not {"deltas":[...]}
  -> parseWriterOutput: malformed
  -> no proposal reaches the validator
  -> no state is committed
```

This is the earliest failure: the writer's serialization. The fact was extracted
correctly; the envelope was wrong. H1 is the strongest counterexample to a
retrieval or working-set explanation, because the model never got that far.

### B2 and F1 — unstable envelope

- B2 r1 used the object envelope and committed both gold facts; B2 r2 used a
  bare array and committed nothing. The semantic content was equivalent in both.
- F1 r1 streamed bare objects (not an array or envelope) and committed nothing;
  F1 r2 used the envelope, committed the legacyAdapter constraint, and the
  validator refused the override-based rejected-approach correctly.

The protocol failure is intermittent on B2 and F1, and stable on A1/C1/D1.
A one-run protocol rate would have mischaracterized all three.

### C1 — writer kind/status, then validator

```text
tool result: "fs.watch delivered 28 of 40; 12 events were lost."
  -> writer proposed finding:fs-watch-event-loss status=verified
     without verificationQuote
  -> validator refused: verification-unscoped
  -> writer proposed rejected-approach:fs-watch-backend
     with the tool result as evidence
  -> validator refused: authority-ungrounded
  -> committed state keeps "must not miss changes" and "poll instead"
  -> the 12/40 evidence is not in committed state
```

The validator is doing its job: a tool result is not decision authority, and
`verified` requires a verification quote. The earliest confirmable failure is
the writer's choice to encode tool-proven negative knowledge as a normative
rejected-approach and a verified finding without the required field. The correct
shape for the tool fact is `finding`/`observed`; that shape would have committed
the 12/40 evidence.

### B2 — a verification overclaim on an extra fact

The writer proposed a true file-read finding (`src/scheduler.mjs returns mode:
memory`) with `status: "verified"` and no `verificationQuote`. The validator
refused it as `verification-unscoped`. The gold facts were already committed, so
this refusal cost no recall; it is the correct handling of an overclaim.

### What is not a failure

The automatic scorer's `falseNormativeRate = 1` in r2 does not mean the writer
made false normative claims. It means the accepted deltas used different
coordinates from the gold, so exact matching classified supported statements as
unsupported. Manual adjudication finds no false normative claim accepted:
A1's constraint, C1's objective, D1's finding, and F1's constraint are all
supported by the transcript. The scorer stays unchanged; the raw output and the
adjudication are the evidence.

## 0.2 The task-stage failures

### B2 — process, not memory

Every arm (B1, S, O1, O2) passes the functional checker in every run and fails
the contract because no visible test was run. The memory policy is not the
difference. The earliest measurable failure is the agent's process: it finished
without executing the visible suite.

### C1 — task/agent, not memory

Every arm fails `functionality.delivers-change` in every run, including O1 with
the oracle deltas committed. The agent did not deliver the required change even
when the semantic state was correct. The task is a code-change task; the custom
loop's action choice is the bottleneck.

### D1 — false verification, not memory

Every arm fails, and three of four arms (S, O1, O2) make a false verification
claim. The agent writes a verification state the workspace does not support. The
contract metric records it. This is an agent-claim failure.

### H1 — the one writer-aligned failure, not stable

- r1: S committed only the objective; the region was refused as `verified`
  without `verificationQuote`; the S checkpoint lacked `eu-west-2`; the agent
  failed `region.production`; O1/O2 succeeded.
- r2: S's fold refused and the fallback ran with an empty checkpoint due to a
  harness defect; that row is excluded from the pair count. B1 succeeded in that
  replicate; the S failure is not a clean full-history comparison.
- r3: S's writer protocol was malformed; B1, S, O1, and O2 all failed
  `region.production`. Even the oracle arms did not rescue the task.

The H1 chain is the best writer-attribution evidence in r1, but it is not stable
across replicates. The r3 oracle failure shows that agent/task variance can
dominate the writer effect.

### A1/F1 — mixed

A1's S row succeeded in r1 and failed in r2/r3; in r1 the writer was malformed,
so the success came from the workspace/task, not semantic memory. F1's B1 and S
both passed in r2; in r3 every arm failed. These cases do not separate the arms.

### The dominant measurable failure

Across the three continuation runs, process violations (12/18, 13/24, 22/24) and
false verification claims (3, 4, 4) dominate. The memory policy is not the
binding constraint on this dataset. The contract metric, not the functional
checker, is what exposes it.

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
real retrieval-trigger failure
production DSH agent loop behaviour
Handoff-Only / Delta-Only ablation
whether a writer-contract fix changes contract success
a larger-sample paired difference
```

The writer-side and task-stage failures are now attributed: protocol envelope,
status/kind choice, validator refusal of overclaims, agent process
non-compliance, and task/agent behaviour. The retrieval-trigger and production
loop remain untested. No prompt, gold, or writer change was made after seeing
the outputs; the evidence is preserved first.
