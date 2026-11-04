# R36 — Cost Report

## R36 spend

```text
HTTP attempts                 419
successful responses          403
failed HTTP attempts           16  (local-proxy transport resets; no model result)
observed input tokens         328,150
observed output tokens         46,333
cache read tokens             233,466
cache write tokens                  0
unknown-usage attempts              9
retries                             0
run reports                        31  (including invalid rows and retries)
currency                          not reported (no trusted price profile)
```

Split by stage:

| stage | attempts | input | output | cache read | unknown |
|---|---:|---:|---:|---:|---:|
| writer-only (W0 + W1) | 12 | 16,034 | 5,062 | 2,304 | 0 |
| O2 calibration | 407 | 312,116 | 41,271 | 231,162 | 9 |
| **total** | **419** | **328,150** | **46,333** | **233,466** | **9** |

The writer-only split is 6 W0 calls and 6 W1 calls. The O2 total includes the
invalid transport rows and the per-case reruns; those attempts happened and are
counted, but the invalid rows are not used as task measurements.

The route was the local ZCode proxy `http://127.0.0.1:7866/v1` (provider
`c15ab109…`). The three direct `/zen/go/v1` keys answered HTTP 401
`api_key_expired` and were not used. The proxy passed a 16,384-token probe.

## What was executed

The authorized R36 run executed:

- W0-P0 and W1-P0 writer-only on six certified cases (one replicate each);
- O2 calibration on six cases for H0, H-step, H-output, H-finish, and the
  exploratory H-step+H-finish condition.

It did **not** execute B1/S/O1/O2. The best O2 condition reached 3/6 contract
success; A1/C1 fail on code and B2 never runs the required test, so the
comparison would be dominated by the execution floor. The B1/S rows are zero by
design, not by provider failure.

`eval/r36/out/live-results.json` is the authoritative machine-readable record;
`eval/r36/out/gate-status.json` is the authoritative gate status.

## R35 historical spend (context, not R36 spend)

From `R35_COST_REPORT.md`:

```text
HTTP attempts, whole round:        612
successful HTTP responses:         596
observed input tokens:             466,125
observed output tokens:            151,484
cache read tokens:                 318,464
unknown-usage attempts:            12  (all failed route attempts)
retries:                           0
writer-run wall clock:             431,168 ms
continuation wall clock:           1,856,906 ms
currency:                          not reported
```

Per stage:

| stage | attempts | successes | input | output | cache read |
|---|---:|---:|---:|---:|---:|
| writer-only partial | 5 | 5 | 5,089 | 14,063 | 0 |
| writer-only complete | 6 | 6 | 6,077 | 13,240 | 0 |
| writer-only r2 | 6 | 6 | 6,077 | 13,526 | 1,920 |
| continuation r1 | 162 | — | 147,294 | 36,333 | 96,640 |
| continuation r2 (invalid) | 209 | — | 151,771 | 39,639 | 109,312 |
| continuation r3 | 207 | — | 149,780 | 34,671 | 110,592 |

The failed-route requests (401) had no observed tokens; their charge is a
conservative admission reserve, not a bill. They are not zero-cost requests.

## R36 offline work

The offline scripts are deterministic and make no network call:

```bash
node eval/r36/audit-r35.mjs
node eval/r36/parser-ablation.mjs
node eval/r36/certify-cases.mjs
node eval/r36/conditions.mjs
node eval/r36/write-manifests.mjs
node eval/r36/gates.mjs
```

They read the frozen R35 raw outputs and the v2 dataset and write small JSON
artifacts under `eval/r36/`. The R35 worktree and its 8.2 MB run archive were
not modified.

## What a future live run would be allowed to spend

The manifests carry explicit positive limits; these are caps, not estimates:

| manifest | stage | requests | input | output | wall clock |
|---|---|---:|---:|---:|---:|
| w1-p0-live | writer-only | 60 | 32,000,000 | 1,000,000 | 1,800,000 ms |
| w0-p0-live-control | writer-only | 60 | 32,000,000 | 1,000,000 | 1,800,000 ms |
| h0-o2 | continuation | 400 | 200,000,000 | 5,000,000 | 3,600,000 ms |
| h-step-o2 | continuation | 400 | 200,000,000 | 5,000,000 | 3,600,000 ms |
| h-output-o2 | continuation | 400 | 200,000,000 | 5,000,000 | 3,600,000 ms |
| h-finish-o2 | continuation | 400 | 200,000,000 | 5,000,000 | 3,600,000 ms |
| h-combined-o2 (exploratory) | continuation | 400 | 200,000,000 | 5,000,000 | 3,600,000 ms |
| h-finish-o2 | continuation | 400 | 200,000,000 | 5,000,000 | 3,600,000 ms |
| b1-s-o1-o2 | continuation | 400 | 200,000,000 | 5,000,000 | 3,600,000 ms |

The 16,384-token per-request output bound is the R35 production writer floor,
not an estimate. A request whose reserve exceeds it is refused before `fetch`.

## Accounting rules retained

- `observed` is what the provider reported; `reserved` is unknown and remains
  charged; `charged` is their sum.
- An absent usage record is unknown, not zero.
- A 429 resend is a new admission and a new attempt.
- Oracle controls are not provider evidence.
- No currency conversion is attempted.

R36 does not claim a cost advantage or disadvantage for W1, P1, or the guard.
Those require the blocked live runs.
