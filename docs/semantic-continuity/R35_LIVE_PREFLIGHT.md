# R35 — Live Preflight

## Status

```text
R34.1 evaluation integrity closure:  complete
R35 live writer-only pilot:           blocked / not executed
R35 behavioural comparison:           blocked / not executed
provider requests in this round:      0
```

The instrument is ready to run. The model experiment has not run, because the
round received no explicit authorization, resolved route, or spend budget. This
document records what was verified locally and what only a provider can verify.

## What R34.1 fixes

### One attempt, one admission, one retry

The global `BudgetLedger` is injected into the OpenAI-compatible adapter and is
called immediately before `fetch`, including for each 429 resend. R34 also
walked the adapter's retry telemetry after the run and added it to the ledger a
second time. That loop is gone. The ledger is the sole authority; the adapter
counter is a cross-check and a mismatch is reported, not reconciled by adding.

Measured against a local mock provider (no network, no credential):

```text
provider script:      429, 429, 200
HTTP attempts:        3
ledger retries:       2
adapter retries:      2
unknown usage:        2
final report retries: 2
```

A second test with `limits.requests = 1` receives exactly one HTTP request; the
third would-be attempt is refused before `fetch`.

### Provider failure is not task failure

Every row now has one `failures` record with independent axes:

```text
provider   stage = fold | fold-writer | follow-up | case-boundary
budget
fold
checker
harness
task       assessed, functionalFailure, historicalConstraintViolation,
           processViolation, falseVerificationClaim
```

A non-fatal writer failure — the fold still commits a deterministic checkpoint —
does not erase a valid task outcome. A fatal follow-up failure makes the row
invalid and is classified as `provider-*`; the checker result is retained as
diagnostic evidence but `failures.task.assessed` is `false`. A run in which every
row has a provider failure and no provider call succeeded is reported as
`provider-unavailable`, even if a safely degraded fold was valid.

### Cost survives an exception

The case boundary snapshots the ledger before and after the case. A normal,
failed, budget-refused, or provider-failed case reports the requests that
actually happened. R34 wrote `attempts: 0, inputTokens: 0, outputTokens: 0` in
the exception branch; that is gone.

Per case the report separates:

```text
observedInputTokens / observedOutputTokens
reservedInputTokens / reservedOutputTokens
chargedInputTokens / chargedOutputTokens   (observed + reserved)
httpAttempts / httpRetries
unknownUsageRequests / partialUsageRequests
budgetRefusals
caseDurationMs / runElapsedMs
```

No currency is reported. There is no trusted price profile.

### Report persistence

`<R33_RUN_ROOT>/<runId>/report.json` is the authoritative run record. The
convenience copy at `eval/r33/out/live-report.json` is refreshed only when
`R35_WRITE_LATEST` is not `0`. A partial run still writes the completed rows,
the global ledger, the stop reason, and the harness error.

## The preflight

```bash
node eval/r33/live.mjs --preflight --manifest <path>
```

The preflight:

- validates the manifest shape without reading `R33_LIVE` or any route value;
- verifies the frozen dataset digest and scorer version;
- checks the built plugin, fold frontier, and eval adapter;
- runs the REAL DSH host and EF fold for every selected case/arm with a
  `DryRunAdapter`, capturing the actual `GenerateOptions.maxTokens` the
  production writer/rationale path asks for;
- computes the planned fold calls, follow-up calls, request total, input
  reserve, output bound, and worst-case retry headroom;
- checks run-directory collisions and refuses to reuse a run directory;
- reports `feasible`, `infeasible`, or `unknown-model-capability` per case/arm.

It reads no API key value, opens no connection, and writes
`eval/r33/out/preflight-report.json`.

### Measured writer bounds

The production writer/rationale budget is derived by
`rationaleOutputFor(estimateSpanTokens(...))`, whose floor is **16,384** and
whose ceiling is **32,768**. On the frozen development transcripts the actual
captured value is:

```text
per-request writer/rationale maxTokens: 16384
per-request input reserve (contextWindow): 131072
```

A `maxOutputTokens` of 8,192 — the R34 example — is therefore rejected before
any provider request. The example manifest now uses 32,768, declares the same
value as the model's capability, and preflights as 12/12 feasible:

```text
cases:   A1, B2, C1, D1, F1, H1
arms:    S, O1
stage:   writer-only
planned: 6 fold calls (O1 writers are local oracle responses)
```

If `route.maxOutputTokens` is omitted, the per-case verdict is
`unknown-model-capability` even when every local budget check passes. That is
not a pass: only the provider can confirm the ceiling.

## What the preflight does not prove

- Provider availability, latency, rate-limit behaviour, and billing.
- That the resolved model actually supports 16,384 output tokens.
- That the model follows the writer protocol.
- Any task success, semantic recall, or cost.

Those become measurable only in an authorized live run.

## Authorization required before `--run`

```text
explicit user permission to spend
resolved provider route (base URL and model id)
resolved API key in an environment variable named by the manifest
positive request, input-token, output-token, and wall-clock limits
per-request output bound >= the preflight's actual maxTokens
model output capability declared and compatible
R33_LIVE=1
```

`R33_LIVE=1` alone is not authorization. The manifest's example numbers are
illustrative, not a spend approval.
