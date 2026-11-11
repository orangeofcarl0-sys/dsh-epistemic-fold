# EF-R4 — R3 pilot rescore

Scorer: `r4-scoring-v1`. Historical score is the recorded R3 value; the rescored value separates task checks from mechanism exposure.

## Arm summary

| Arm | Cells | Historical pass | Task correct | Incorrect | Incomplete | Mechanism met | Cost-valid R3 | Cost-valid R4 | Step-limited |
|---|---|---|---|---|---|---|---|---|---|
| B0 | 6 | 5/6 | 5/6 | 0 | 1 | 0 | 6 | 6 | 0 |
| E0 | 6 | 1/6 | 1/6 | 0 | 5 | 1 | 6 | 6 | 5 |
| E1 | 6 | 3/6 | 3/6 | 1 | 2 | 1 | 5 | 5 | 3 |

## Paired comparisons (taskOutcome=correct)

| Left vs Right | Pairs | Both | Neither | Left only | Right only | p | Cost-valid pairs |
|---|---|---|---|---|---|---|---|
| E1 vs B0 | 6 | 3 | 1 | 0 | 2 | 0.5 | 5 |
| E1 vs E0 | 6 | 1 | 3 | 2 | 0 | 0.5 | 5 |
| E0 vs B0 | 6 | 1 | 1 | 0 | 4 | 0.125 | 6 |

## Assertions

- `historical-pilot-counts`: pass — expected {"B0":5,"E0":1,"E1":3}, actual {"B0":5,"E0":1,"E1":3}
- `rescored-task-counts`: pass — expected {"B0":5,"E0":1,"E1":3}, actual {"B0":5,"E0":1,"E1":3}
- `rescored-e1-b0-pair`: pass — expected {"both":3,"neither":1,"leftOnly":0,"rightOnly":2}, actual {"both":3,"neither":1,"leftOnly":0,"rightOnly":2}

## Per-cell

| Cell | Arm | Historical | Task outcome | Mechanism | Cost R4 | Termination |
|---|---|---|---|---|---|---|
| T11-p1-B0-r1 | B0 | pass | correct | — | valid | finish |
| T11-p1-E0-r1 | E0 | fail | incomplete | — | valid | step-limit |
| T11-p1-E1-r1 | E1 | fail | incorrect | — | valid | step-limit |
| T12-p1-B0-r1 | B0 | pass | correct | — | valid | finish |
| T12-p1-E0-r1 | E0 | fail | incomplete | — | valid | step-limit |
| T12-p1-E1-r1 | E1 | pass | correct | — | valid | finish |
| T13-p1-B0-r1 | B0 | pass | correct | — | valid | finish |
| T13-p1-E0-r1 | E0 | fail | incomplete | — | valid | step-limit |
| T13-p1-E1-r1 | E1 | pass | correct | — | valid | finish |
| T14-p1-B0-r1 | B0 | pass | correct | — | valid | finish |
| T14-p1-E0-r1 | E0 | pass | correct | — | valid | finish |
| T14-p1-E1-r1 | E1 | pass | correct | — | valid | finish |
| T15-p1-B0-r1 | B0 | pass | correct | — | valid | finish |
| T15-p1-E0-r1 | E0 | fail | incomplete | — | valid | step-limit |
| T15-p1-E1-r1 | E1 | fail | incomplete | — | valid | step-limit |
| T16-p1-B0-r1 | B0 | fail | incomplete | miss | valid | finish |
| T16-p1-E0-r1 | E0 | fail | incomplete | met | valid | step-limit |
| T16-p1-E1-r1 | E1 | fail | incomplete | met | invalid | step-limit |

