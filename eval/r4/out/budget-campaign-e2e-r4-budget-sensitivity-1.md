# EF-R4 budget-sensitivity campaign — e2e-r4-budget-sensitivity-1

Status: **partial**, stop: `provider-usage-incomplete`, executed **3/36**.

| Arm | Budget | Cells | Correct | Incorrect | Incomplete | Step-limited | Mechanism | Cost-valid | Budget aborts | Requests | Input | Output |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B0 | 8 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 14 | 80810 | 4457 |
| B0 | 16 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0 | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0 | 16 | 1 | 0 | 0 | 1 | 0 | 0 | 1 | 0 | 3 | 15757 | 275 |
| E1 | 8 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 2 | 5 | 42538 | 821 |
| E1 | 16 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Paired comparisons

| Comparison | Pairs | Both | Neither | Left only | Right only | p |
|---|---|---|---|---|---|---|
| B0-16-vs-8 | 0 | 0 | 0 | 0 | 0 | 1 |
| E0-16-vs-8 | 0 | 0 | 0 | 0 | 0 | 1 |
| E1-16-vs-8 | 0 | 0 | 0 | 0 | 0 | 1 |
| E1-vs-B0@8 | 0 | 0 | 0 | 0 | 0 | 1 |
| E1-vs-B0@16 | 0 | 0 | 0 | 0 | 0 | 1 |

**Budget aborts:** 2 in T13-p1-E1-r1. These are local `BUDGET_EXHAUSTED` auxiliary calls, not model outcomes.

## Per-cell

| Cell | Arm | Budget | Outcome | Mechanism | Termination | Cost-valid | Budget aborts |
|---|---|---|---|---|---|---|---|
| T11-p1-B0-r1 | B0 | 8 | correct | — | finish | valid | 0 |
| T12-p1-E0-r1 | E0 | 16 | incomplete | — | finish | valid | 0 |
| T13-p1-E1-r1 | E1 | 8 | incomplete | — | finish | invalid | 2 |

