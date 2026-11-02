# R35 — Live Preflight

## Status

```text
R34.1 evaluation integrity closure:  complete
explicit spend authorization:        received (opencode / deepseek-v4.1-flash)
route resolution:                    resolved from the ZCode config
R35 live writer-only pilot:          executed (3 runs, 16 scored rows)
R35 behavioural comparison:          executed (3 runs; 9 valid complete pairs)
provider requests in this round:     612 (596 successful HTTP responses)
provider tokens observed:            466,125 input / 151,484 output + 318,464 cache read
```

The instrument is ready and has run. The first authorized route was expired; a
refreshed key was supplied outside the repository and the probe succeeded. The
writer-only runs then executed on the six cases. This document records the
preflight, the authorization, the dead-route phase, the repaired-route probe,
and the exact run parameters.

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
diagnostic evidence but `failures.task.assessed` is `false`.

The run-level `provider-unavailable` test was initially wrong. It required EVERY
row to carry a provider failure, so the six O1 oracle controls — which answer from
the frozen dataset without a network call — hid the fact that all six real writer
calls had failed. The authorized pilot was first reported as `executed-success`
with “12/12 writer measurements valid”. `providerAvailability()` now counts only
rows that the arm/stage design says must reach the provider (writer-only `S`;
every arm in a continuation), and `runQuality().writerMeasurements` separates
real writer calls from oracle controls. The corrected run is
`provider-unavailable` with `0/6` real writer calls completed. A regression test
covers the exact mix of failed real calls plus successful oracle controls.

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

## The authorized attempt (2026-11-01/02)

The user explicitly authorized spend on the `opencode` route with
`deepseek-v4.1-flash`, pointed at the key material in the ZCode configuration,
and placed no hard currency cap on the pilot. Because “no limit” is not an
auditable manifest value, the runner still applied finite audit limits:

```text
requests:       60        input tokens:  32,000,000
output tokens:  1,000,000 wall clock:    1,800,000 ms
maxOutputTokens: 32,768   contextWindow: 1,048,576
cases:          A1, B2, C1, D1, F1, H1
arms:           S, O1      stage: writer-only
```

The key was read from the ZCode config at `$HOME/.zcode/v2/config.json` (or the
path named by `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`) and placed only in the child
process environment as `R35_LIVE_API_KEY`. It was not printed, serialized into a
report, or written to the repository.

### Route probes

A one-request capability probe was sent before the pilot. No token was consumed.
The three OpenCode providers in the config all use the same gateway:

| Provider | Base URL | Result |
| --- | --- | --- |
| `5c7f8d75-e85e-4de5-9b27-e2b59eab1c7a` | `https://opencode.ai/zen/go/v1` | HTTP 401 `authentication_error` / `api_key_expired` |
| `ac2dbaa8-7050-48e2-9d72-b21663fe3cff` | `https://opencode.ai/zen/go/v1` | HTTP 401 `authentication_error` / `api_key_expired` |
| `b88043d7-f229-452c-b634-4152ca14aae8` | `https://opencode.ai/zen/go/v1` | HTTP 401 `authentication_error` / `api_key_expired` |
| `c15ab109-97b8-4de1-a647-9857a635be38` | `http://127.0.0.1:7866/v1` | transport failure `ECONNREFUSED` |

The provider's own message is explicit: “This API key has expired. Create a new
API key in OpenCode Console and replace it in your client or secret store.
Signing in again will not renew this key.” No alternate credential
(`OPENCODE_GO_API_KEY`, `OPENCODE_API_KEY`, `OPENAI_API_KEY`, `EF_LIVE_API_KEY`,
`R35_LIVE_API_KEY`, `DEEPSEEK_API_KEY`) was present in the environment, and the
runner does not search for one.

### Preflight result

```text
status:                  preflight-ok
feasible:                0
infeasible:              0
unknown-model-capability: 12   (6 cases x 2 arms)
blocking:                0
planned fold calls:       6
worst-case attempts:     24
worst-case input:        6,291,456
worst-case output:       98,304
provider requests:        0
credentials read:         0 (value never read by the preflight)
```

`unknown-model-capability` is honest: the ZCode provider rules declare a
1,048,576-token context window but no output ceiling for this model. The
manifest's 32,768 bound covers the measured 16,384 writer floor, so the
preflight had no blocking objection. Only the provider could confirm the
capability, and the 401 answered before that question was reached.

### Run result

```text
run id:                  r35-writer-only-provider-auth-20261102
status:                  provider-unavailable (exit 5)
real writer calls:       6 attempted, 0 completed
provider responses:      6 x HTTP 401 api_key_expired
oracle controls:         6 completed, 6 committed
fold measurements:       12 / 12 valid
observed tokens:         0
unknown-usage attempts:  6
charged input/output:    6,291,456 / 98,304
run wall clock:          3,257 ms
```

An earlier run (`r35-writer-only-provider-auth-20261101`) was executed before
the status fix and reported `executed-success`. It is retained in the run
archive as evidence of the defect, but it is **superseded** and must not be
cited as a result. Across the round, 12 real writer attempts and 4 route probes
were sent; all 16 requests failed at authentication or transport, and 0 provider
tokens were observed. The corrected report is:

```text
eval/r35/runs/r35-writer-only-provider-auth-20261102/report.json
```

No writer raw output, protocol, delta, refusal, or checkpoint semantics were
observed. The six “fold measurements” are the deterministic EF fold path around
a failed writer; they are not model behavior.

## Route repaired: the real writer runs

A refreshed key was supplied as a file outside the repository. It was read into
the runner's memory, passed to the child only as `R35_LIVE_API_KEY`, and never
printed, serialized into the manifest, or written to a report.

### Probe

```text
base URL          https://opencode.ai/zen/go/v1
model             deepseek-v4.1-flash
requested tokens  16,384
finish            stop
usage             37 input / 12 output
text              "ready"
```

The full 16,384-token writer bound is accepted, so the production floor is
usable. The credential-expiry condition is gone.

### Runs

| Run | Stage | Cases | Arms | Writer calls | Scored rows | Status |
| --- | --- | --- | --- | ---: | ---: | --- |
| `...-20261102` | writer-only | 6 | S,O1 | 5 | 9 | partial (pre-fix fold abort) |
| `...-20261102-complete` | writer-only | 6 | S,O1 | 6 | 12 | executed-success |
| `...-20261102-r2` | writer-only | 6 | S,O1 | 6 | 12 | executed-success |

The two complete runs used 6,077 input and 13,240/13,526 output tokens
respectively; r2 also read 1,920 cached prompt tokens. There were no provider
failures, no retries, and no unknown-usage attempts.

```text
protocol parsed              10 / 16 scored rows
gold facts in raw output     8 / 8
gold facts committed         6 / 8 full, 1 partial, 1 unparsed
false normative accepted     0
```

The details, raw outputs, refusals, and manual adjudication are in
`R35_WRITER_RESULTS.md`. The writer-stage result is not a task or behavioural
result.

### Continuation

The same route ran B1/S/O1/O2 with the custom text-JSON tool loop and the hidden
checkers:

```text
r1  162 requests, 18/24 valid,  7 task, 3 contract
r2  209 requests, 24/24 valid, 10 task, 6 contract (fallback rows invalid)
r3  207 requests, 24/24 valid,  4 task, 0 contract (authoritative)
```

Across the 9 valid B1/S pairs (r1 3, r3 6): 0 rescue, 0 damage, 9 neither. r2 is
excluded because its fallback used an empty checkpoint. The dominant bottleneck
is the agent's process compliance, not semantic memory. The details are in
`R35_BEHAVIORAL_COMPARISON.md`.

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
