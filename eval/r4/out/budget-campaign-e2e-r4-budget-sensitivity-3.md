# EF-R4 budget-sensitivity campaign — e2e-r4-budget-sensitivity-3

Status: **complete**, stop: `none`, executed **36/36**.

| Arm | Budget | Cells | Correct | Incorrect | Incomplete | Step-limited | Mechanism | Cost-valid | Budget aborts | Requests | Input | Output |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B0 | 8 | 6 | 4 | 0 | 2 | 0 | 0 | 6 | 0 | 51 | 174266 | 16557 |
| B0 | 16 | 6 | 5 | 0 | 1 | 0 | 0 | 6 | 0 | 56 | 143058 | 15916 |
| E0 | 8 | 6 | 1 | 1 | 4 | 1 | 1 | 6 | 0 | 43 | 326223 | 4616 |
| E0 | 16 | 6 | 2 | 0 | 4 | 0 | 1 | 6 | 0 | 41 | 308969 | 4310 |
| E1 | 8 | 6 | 6 | 0 | 0 | 1 | 1 | 6 | 0 | 39 | 154311 | 5811 |
| E1 | 16 | 6 | 4 | 0 | 2 | 0 | 1 | 6 | 0 | 48 | 187284 | 7777 |

## Paired comparisons

| Comparison | Pairs | Both | Neither | Left only | Right only | p |
|---|---|---|---|---|---|---|
| B0-16-vs-8 | 6 | 4 | 1 | 1 | 0 | 1 |
| E0-16-vs-8 | 6 | 1 | 4 | 1 | 0 | 1 |
| E1-16-vs-8 | 6 | 4 | 0 | 0 | 2 | 0.5 |
| E1-vs-B0@8 | 6 | 4 | 0 | 2 | 0 | 0.5 |
| E1-vs-B0@16 | 6 | 3 | 0 | 1 | 2 | 1 |

## Per-cell

| Cell | Arm | Budget | Outcome | Mechanism | Termination | Cost-valid | Budget aborts |
|---|---|---|---|---|---|---|---|
| T11-p1-B0-b16-r1 | B0 | 16 | correct | — | finish | valid | 0 |
| T11-p1-B0-b8-r1 | B0 | 8 | correct | — | finish | valid | 0 |
| T11-p1-E0-b16-r1 | E0 | 16 | incomplete | — | finish | valid | 0 |
| T11-p1-E0-b8-r1 | E0 | 8 | incomplete | — | finish | valid | 0 |
| T11-p1-E1-b16-r1 | E1 | 16 | correct | — | finish | valid | 0 |
| T11-p1-E1-b8-r1 | E1 | 8 | correct | — | step-limit | valid | 0 |
| T12-p1-B0-b16-r1 | B0 | 16 | incomplete | — | finish | valid | 0 |
| T12-p1-B0-b8-r1 | B0 | 8 | incomplete | — | finish | valid | 0 |
| T12-p1-E0-b16-r1 | E0 | 16 | correct | — | finish | valid | 0 |
| T12-p1-E0-b8-r1 | E0 | 8 | incorrect | — | finish | valid | 0 |
| T12-p1-E1-b16-r1 | E1 | 16 | correct | — | finish | valid | 0 |
| T12-p1-E1-b8-r1 | E1 | 8 | correct | — | finish | valid | 0 |
| T13-p1-B0-b16-r1 | B0 | 16 | correct | — | finish | valid | 0 |
| T13-p1-B0-b8-r1 | B0 | 8 | correct | — | finish | valid | 0 |
| T13-p1-E0-b16-r1 | E0 | 16 | incomplete | — | finish | valid | 0 |
| T13-p1-E0-b8-r1 | E0 | 8 | incomplete | — | finish | valid | 0 |
| T13-p1-E1-b16-r1 | E1 | 16 | correct | — | finish | valid | 0 |
| T13-p1-E1-b8-r1 | E1 | 8 | correct | — | finish | valid | 0 |
| T14-p1-B0-b16-r1 | B0 | 16 | correct | — | finish | valid | 0 |
| T14-p1-B0-b8-r1 | B0 | 8 | correct | — | finish | valid | 0 |
| T14-p1-E0-b16-r1 | E0 | 16 | correct | — | finish | valid | 0 |
| T14-p1-E0-b8-r1 | E0 | 8 | correct | — | finish | valid | 0 |
| T14-p1-E1-b16-r1 | E1 | 16 | correct | — | finish | valid | 0 |
| T14-p1-E1-b8-r1 | E1 | 8 | correct | — | finish | valid | 0 |
| T15-p1-B0-b16-r1 | B0 | 16 | correct | — | finish | valid | 0 |
| T15-p1-B0-b8-r1 | B0 | 8 | correct | — | finish | valid | 0 |
| T15-p1-E0-b16-r1 | E0 | 16 | incomplete | — | finish | valid | 0 |
| T15-p1-E0-b8-r1 | E0 | 8 | incomplete | — | step-limit | valid | 0 |
| T15-p1-E1-b16-r1 | E1 | 16 | incomplete | — | finish | valid | 0 |
| T15-p1-E1-b8-r1 | E1 | 8 | correct | — | finish | valid | 0 |
| T16-p1-B0-b16-r1 | B0 | 16 | correct | miss | finish | valid | 0 |
| T16-p1-B0-b8-r1 | B0 | 8 | incomplete | miss | finish | valid | 0 |
| T16-p1-E0-b16-r1 | E0 | 16 | incomplete | met | finish | valid | 0 |
| T16-p1-E0-b8-r1 | E0 | 8 | incomplete | met | finish | valid | 0 |
| T16-p1-E1-b16-r1 | E1 | 16 | incomplete | met | finish | valid | 0 |
| T16-p1-E1-b8-r1 | E1 | 8 | correct | met | finish | valid | 0 |

