# EF-R4 — step-budget sensitivity design

**Design frozen; execution not authorized.** No provider call was made.

- Campaign: `e2e-r4-budget-sensitivity-1`
- 36 cells = 6 tasks x 3 arms x 2 budgets (8, 16)
- Six blocks of six; every block has each task once, each arm twice, each budget three times
- The 8-step cells are new; they are not paired with R3 history

## Execution order

| # | Block | Task | Arm | maxSteps |
|---|---|---|---|---|
| 1 | r4-budget-1 | T11-p1 | B0 | 8 |
| 2 | r4-budget-1 | T12-p1 | E0 | 16 |
| 3 | r4-budget-1 | T13-p1 | E1 | 8 |
| 4 | r4-budget-1 | T14-p1 | B0 | 16 |
| 5 | r4-budget-1 | T15-p1 | E0 | 8 |
| 6 | r4-budget-1 | T16-p1 | E1 | 16 |
| 7 | r4-budget-2 | T11-p1 | E0 | 16 |
| 8 | r4-budget-2 | T12-p1 | E1 | 8 |
| 9 | r4-budget-2 | T13-p1 | B0 | 16 |
| 10 | r4-budget-2 | T14-p1 | E0 | 8 |
| 11 | r4-budget-2 | T15-p1 | E1 | 16 |
| 12 | r4-budget-2 | T16-p1 | B0 | 8 |
| 13 | r4-budget-3 | T11-p1 | E1 | 8 |
| 14 | r4-budget-3 | T12-p1 | B0 | 16 |
| 15 | r4-budget-3 | T13-p1 | E0 | 8 |
| 16 | r4-budget-3 | T14-p1 | E1 | 16 |
| 17 | r4-budget-3 | T15-p1 | B0 | 8 |
| 18 | r4-budget-3 | T16-p1 | E0 | 16 |
| 19 | r4-budget-4 | T11-p1 | B0 | 16 |
| 20 | r4-budget-4 | T12-p1 | E0 | 8 |
| 21 | r4-budget-4 | T13-p1 | E1 | 16 |
| 22 | r4-budget-4 | T14-p1 | B0 | 8 |
| 23 | r4-budget-4 | T15-p1 | E0 | 16 |
| 24 | r4-budget-4 | T16-p1 | E1 | 8 |
| 25 | r4-budget-5 | T11-p1 | E0 | 8 |
| 26 | r4-budget-5 | T12-p1 | E1 | 16 |
| 27 | r4-budget-5 | T13-p1 | B0 | 8 |
| 28 | r4-budget-5 | T14-p1 | E0 | 16 |
| 29 | r4-budget-5 | T15-p1 | E1 | 8 |
| 30 | r4-budget-5 | T16-p1 | B0 | 16 |
| 31 | r4-budget-6 | T11-p1 | E1 | 16 |
| 32 | r4-budget-6 | T12-p1 | B0 | 8 |
| 33 | r4-budget-6 | T13-p1 | E0 | 16 |
| 34 | r4-budget-6 | T14-p1 | E1 | 8 |
| 35 | r4-budget-6 | T15-p1 | B0 | 16 |
| 36 | r4-budget-6 | T16-p1 | E0 | 8 |

## Budget estimate (from R3)

- Median per cell: {"requests":8,"inputTokens":153149.5,"outputTokens":1962.5,"durationMs":95558.5}
- Max per cell: {"requests":21,"inputTokens":276060,"outputTokens":9498,"durationMs":205273}
- Estimated 36 cells: {"requests":288,"inputTokens":5513382,"outputTokens":70650,"wallClockMs":3440106}
- Proposed limits: {"requests":908,"inputTokens":11925792,"outputTokens":410314,"wallClockMs":8867794,"note":"A proposal only. A live grant must set the real envelope; this file does not authorize spend."}

A live grant must set the real envelope; the proposal is not an authorization.

