# EF-R2 — e2e-r2-confirm-merged

Executed 23/54; requests 217, input 2495652, output 68189.

| Arm | Pass | Attempts | Committed | Refused | Aborted | Unverifiable | Delivered | Cells with commit | Input | Output | Aux |
|---|---|---|---|---|---|---|---|---|---|---|---|
| B0 | 4/7 | 44 | 18 | 22 | 4 | 0 | 15 | 7 | 708122 | 37741 | 44 |
| E0 | 1/7 | 36 | 33 | 0 | 0 | 3 | 30 | 7 | 811541 | 10074 | 0 |
| E1 | 5/9 | 18 | 17 | 0 | 0 | 1 | 17 | 9 | 975989 | 20374 | 18 |

## Paired ITT

| Left | Right | Pairs | Left only | Right only | Exact McNemar p |
|---|---|---|---|---|---|
| E1 | E0 | 7 | 3 | 0 | 0.25 |
| E1 | B0 | 7 | 0 | 0 | 1 |
| E0 | B0 | 7 | 0 | 3 | 0.25 |

## Feasibility

E1: 9/9 cells committed, 9/9 delivered, 0 without a commit, 0 refused, 0 aborted.

No product claim: one model, one route, one machine; the pilot and confirm are separate instance sets.

