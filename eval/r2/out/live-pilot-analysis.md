# EF-R2 — e2e-r2-pilot-1

Executed 18/18; requests 173, input 2364910, output 62224.

| Arm | Pass | Attempts | Committed | Refused | Aborted | Unverifiable | Delivered | Cells with commit | Input | Output | Aux |
|---|---|---|---|---|---|---|---|---|---|---|---|
| B0 | 5/6 | 43 | 20 | 15 | 8 | 0 | 16 | 6 | 916786 | 39463 | 43 |
| E0 | 2/6 | 25 | 24 | 0 | 0 | 1 | 23 | 6 | 736288 | 8875 | 0 |
| E1 | 6/6 | 9 | 9 | 0 | 0 | 0 | 9 | 6 | 711836 | 13886 | 9 |

## Paired ITT

| Left | Right | Pairs | Left only | Right only | Exact McNemar p |
|---|---|---|---|---|---|
| E1 | E0 | 6 | 4 | 0 | 0.125 |
| E1 | B0 | 6 | 1 | 0 | 1 |
| E0 | B0 | 6 | 0 | 3 | 0.25 |

## Feasibility

E1: 6/6 cells committed, 6/6 delivered, 0 without a commit, 0 refused, 0 aborted.

No product claim: one model, one route, one machine; the pilot and confirm are separate instance sets.

