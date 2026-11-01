# R34 — Cost Report

No live provider was contacted. All monetary fields are therefore **unknown**
and are not filled with an estimate.

## 1. Live run

```text
status                 not-executed
reason                 R33_LIVE is not 1; refusing to spend provider credits
HTTP attempts          0
provider retries       0
input tokens           0
output tokens          0
cache read/write       0
unknown usage requests 0
wall clock             0 provider time
currency cost          unknown (no request, no price profile)
cost per success       not applicable
```

A valid manifest with an absent route returns `provider-unavailable` (exit 5)
and still makes no request. A manifest with a zero limit is refused. A manifest
that embeds an authorization header is refused before the adapter is built.

## 2. Mock-provider budget certification

`tests/r331-budget-http.spec.ts` (local HTTP server, no credential, no network):

| Scenario | Server attempts | Ledger attempts | Observed input/output | Unknown | Reserved output |
|---|---:|---:|---:|---:|---:|
| 429, 429, 200 | 3 | 3 | 12 / 4 | 2 | 32 (two throttled attempts) |
| limit = 2, then 429, 429, 200 | **2** | 2 | 0 / 0 | 2 | 32; third request never sent |
| 200 with prompt only | 1 | 1 | 10 / 0 | 0 | 16 (output unreported) |
| 200 with no usage | 1 | 1 | 0 / 0 | 1 | full reserve retained |

The request limit is therefore enforced at the HTTP edge, not at the stream
wrapper. A 429 does not make its cost zero; it keeps its reserve and is counted
as unknown.

## 3. Four-arm self-test (scripted adapter)

68 rows (17 cases × B1/S/O1/O2), no provider:

| Arm | Scripted attempts | Case time (ms) | Writer calls | Accepted deltas |
|---|---:|---:|---:|---:|
| B1 | 103 | 8,867 | 0 | 0 |
| S | 103 | 9,320 | 17 | 30 |
| O1 | 86 | 10,663 | 17 (oracle) | 33 |
| O2 | 103 | 8,012 | 0 | 0 |
| **Total** | **395** | **36,862** | 34 | 63 |

Ledger totals: 3,950 scripted input tokens, 3,950 scripted output tokens, 0
unknown, 0 partial, 0 retries, 0 unresolved reservations, 37.22 s wall clock.

These are **not provider measurements**. The scripted adapter emits 10/10 usage
per stream to exercise the accounting path. They are reported so the plumbing is
auditable, not as a cost prediction.

Derived scripted figures (not live):

```text
scripted tokens per successful task      (3,950 + 3,950) / 68 = 116.2
scripted attempts per successful task     395 / 68 = 5.81
scripted case time per successful task    36,862 / 68 = 542 ms
```

## 4. Scripted offline arms (144 rows)

The offline runner uses no provider and no ledger, so its cost fields are 0 and
must not be read as free model calls. It measures the pipeline only. Any
per-arm "cost" in `offline-report.json` is therefore `not applicable`.

## 5. Currency

No trusted price profile was supplied. The harness does **not** convert tokens
to dollars, and the reports contain no invented currency figure. A future live
run may add a price profile only as an explicitly labelled estimate beside the
observed token counts.

## 6. What a live run would need to record

`--run` already writes, per row:

```text
attempts, observed input/output/cache tokens, reserved tokens,
unknown/partial usage requests, provider failures, caseDurationMs,
global runElapsedMs, per-arm tokens/attempts per success
```

The live report also carries the adapter's rate-limit telemetry and the global
ledger snapshot. A live cost claim is impossible until that report exists.
