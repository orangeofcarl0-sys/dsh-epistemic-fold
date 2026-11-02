# R36 — Cost Report

## R36 spend

```text
New HTTP attempts                 0
New provider requests             0
New input tokens                  0
New output tokens                 0
New cache tokens                  0
Live runs                         0
Replay / offline runs             all R36 analysis
Currency                          not reported (no trusted price profile)
```

No R36 manifest was executed. The W1-P0 and harness manifests are `blocked`;
`eval/r36/gates.mjs` records that state. The audit, parser ablation,
certification, conditions, and gate scripts read local artifacts only.

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
