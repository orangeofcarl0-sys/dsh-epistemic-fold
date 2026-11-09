# EF-E2E core campaign — e2e-lg-pilot-1

Status: **complete**. 24/24 cells executed.

| Arm | Cells | Pass | Rate | Folds | No-fold | Recall cells | Requests | Aux | Input | Output |
|---|---|---|---|---|---|---|---|---|---|---|
| B0 | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0 | 6 | 0 | 0 | 21 | 0 | 4 | 25 | 0 | 265886 | 3070 |
| E0a | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0i | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0ai | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0-L | 6 | 2 | 0.333 | 19 | 0 | 5 | 22 | 0 | 334605 | 3239 |
| E0-G | 6 | 2 | 0.333 | 27 | 0 | 5 | 48 | 0 | 396453 | 6349 |
| E0-LG | 6 | 3 | 0.5 | 18 | 0 | 4 | 29 | 0 | 187318 | 5057 |
| E1 | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| S | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Template | Arm | Pass | Rate | Mean folds | Mean requests | Aux requests | Mean input | Mean output |
|---|---|---|---|---|---|---|---|---|
| T10 | B0 | 0/0 | null | null | null | 0 | null | null |
| T10 | E0 | 0/2 | 0 | 7 | 8 | 0 | 89144 | 881.5 |
| T10 | E0a | 0/0 | null | null | null | 0 | null | null |
| T10 | E0i | 0/0 | null | null | null | 0 | null | null |
| T10 | E0ai | 0/0 | null | null | null | 0 | null | null |
| T10 | E0-L | 1/2 | 0.5 | 5.5 | 6.5 | 0 | 89078.5 | 847.5 |
| T10 | E0-G | 1/2 | 0.5 | 8 | 13 | 0 | 90538.5 | 1584.5 |
| T10 | E0-LG | 1/2 | 0.5 | 5 | 8 | 0 | 57570.5 | 1228.5 |
| T10 | E1 | 0/0 | null | null | null | 0 | null | null |
| T10 | S | 0/0 | null | null | null | 0 | null | null |
| T2 | B0 | 0/0 | null | null | null | 0 | null | null |
| T2 | E0 | 0/2 | 0 | 1 | 1 | 0 | 16008 | 297.5 |
| T2 | E0a | 0/0 | null | null | null | 0 | null | null |
| T2 | E0i | 0/0 | null | null | null | 0 | null | null |
| T2 | E0ai | 0/0 | null | null | null | 0 | null | null |
| T2 | E0-L | 0/2 | 0 | 1.5 | 1.5 | 0 | 50757 | 343.5 |
| T2 | E0-G | 1/2 | 0.5 | 3.5 | 5 | 0 | 87867.5 | 791 |
| T2 | E0-LG | 0/2 | 0 | 2 | 3.5 | 0 | 17383 | 955.5 |
| T2 | E1 | 0/0 | null | null | null | 0 | null | null |
| T2 | S | 0/0 | null | null | null | 0 | null | null |
| T9 | B0 | 0/0 | null | null | null | 0 | null | null |
| T9 | E0 | 0/2 | 0 | 2.5 | 3.5 | 0 | 27791 | 356 |
| T9 | E0a | 0/0 | null | null | null | 0 | null | null |
| T9 | E0i | 0/0 | null | null | null | 0 | null | null |
| T9 | E0ai | 0/0 | null | null | null | 0 | null | null |
| T9 | E0-L | 1/2 | 0.5 | 2.5 | 3 | 0 | 27467 | 428.5 |
| T9 | E0-G | 0/2 | 0 | 2 | 6 | 0 | 19820.5 | 799 |
| T9 | E0-LG | 2/2 | 1 | 2 | 3 | 0 | 18705.5 | 344.5 |
| T9 | E1 | 0/0 | null | null | null | 0 | null | null |
| T9 | S | 0/0 | null | null | null | 0 | null | null |

## Per-cell

| Cell | Block | Exposure | Folds (fail) | Check | Recall | Req (aux) | In | Out | Probes visible |
|---|---|---|---|---|---|---|---|---|---|
| T2-s1-E0-r1 | lg-pilot | fold | 1 (0) | fail | 0 | 1 (0) | 15972 | 390 | 0/2 |
| T2-s1-E0-L-r1 | lg-pilot | fold | 1 (0) | fail | 0 | 1 (0) | 16063 | 184 | 0/2 |
| T2-s1-E0-G-r1 | lg-pilot | fold | 2 (0) | fail | 0 | 3 (0) | 17120 | 743 | 0/2 |
| T2-s1-E0-LG-r1 | lg-pilot | fold | 2 (0) | fail | 0 | 4 (0) | 17325 | 965 | 0/2 |
| T2-s2-E0-L-r1 | lg-pilot | fold | 2 (0) | fail | 1 | 2 (0) | 85451 | 503 | 0/2 |
| T2-s2-E0-G-r1 | lg-pilot | fold | 5 (0) | pass | 6 | 7 (0) | 158615 | 839 | 0/2 |
| T2-s2-E0-LG-r1 | lg-pilot | fold | 2 (0) | fail | 0 | 3 (0) | 17441 | 946 | 0/2 |
| T2-s2-E0-r1 | lg-pilot | fold | 1 (0) | fail | 0 | 1 (0) | 16044 | 205 | 0/2 |
| T9-s1-E0-G-r1 | lg-pilot | fold | 2 (0) | fail | 2 | 7 (0) | 20318 | 918 | 0/0 |
| T9-s1-E0-LG-r1 | lg-pilot | fold | 2 (0) | pass | 2 | 3 (0) | 18770 | 333 | 0/0 |
| T9-s1-E0-r1 | lg-pilot | fold | 3 (0) | fail | 4 | 5 (0) | 36883 | 403 | 0/0 |
| T9-s1-E0-L-r1 | lg-pilot | fold | 2 (0) | pass | 2 | 3 (0) | 18867 | 370 | 0/0 |
| T9-s2-E0-LG-r1 | lg-pilot | fold | 2 (0) | pass | 2 | 3 (0) | 18641 | 356 | 0/0 |
| T9-s2-E0-r1 | lg-pilot | fold | 2 (0) | fail | 2 | 2 (0) | 18699 | 309 | 0/0 |
| T9-s2-E0-L-r1 | lg-pilot | fold | 3 (0) | fail | 2 | 3 (0) | 36067 | 487 | 0/0 |
| T9-s2-E0-G-r1 | lg-pilot | fold | 2 (0) | fail | 2 | 5 (0) | 19323 | 680 | 0/0 |
| T10-s1-E0-r1 | lg-pilot | fold | 8 (0) | fail | 10 | 8 (0) | 121989 | 969 | 0/0 |
| T10-s1-E0-L-r1 | lg-pilot | fold | 7 (0) | pass | 10 | 8 (0) | 140296 | 1083 | 0/0 |
| T10-s1-E0-G-r1 | lg-pilot | fold | 9 (0) | fail | 15 | 14 (0) | 100346 | 1626 | 0/0 |
| T10-s1-E0-LG-r1 | lg-pilot | fold | 4 (0) | pass | 3 | 4 (0) | 54618 | 631 | 0/0 |
| T10-s2-E0-L-r1 | lg-pilot | fold | 4 (0) | fail | 4 | 5 (0) | 37861 | 612 | 0/0 |
| T10-s2-E0-G-r1 | lg-pilot | fold | 7 (0) | pass | 11 | 12 (0) | 80731 | 1543 | 0/0 |
| T10-s2-E0-LG-r1 | lg-pilot | fold | 6 (0) | fail | 10 | 12 (0) | 60523 | 1826 | 0/0 |
| T10-s2-E0-r1 | lg-pilot | fold | 6 (0) | fail | 8 | 8 (0) | 56299 | 794 | 0/0 |

## What this table does not say

- The two seeds of a template are not two independent tasks; do not pool them into a population estimate.
- A checker failure is a task outcome, not an invalid measurement. Invalid cells are labelled separately.
- `inputTokens` is the provider's uncached input. Cache reads are reported in the JSON, not folded into this column.
- No cost in currency is claimed: this route has no verifiable per-token price.
