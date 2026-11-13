# EF-E2E core campaign — e2e-t10-retest-1

Status: **complete**. 10/10 cells executed.

| Arm | Cells | Pass | Rate | Folds | No-fold | Recall cells | Requests | Aux | Input | Output |
|---|---|---|---|---|---|---|---|---|---|---|
| B0 | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0 | 2 | 0 | 0 | 10 | 0 | 2 | 16 | 0 | 100238 | 1685 |
| E0a | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0i | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0ai | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0-L | 2 | 0 | 0 | 5 | 0 | 2 | 7 | 0 | 54092 | 1057 |
| E0-G | 2 | 2 | 1 | 10 | 0 | 2 | 15 | 0 | 133871 | 1877 |
| E0-LG | 2 | 1 | 0.5 | 6 | 0 | 2 | 15 | 0 | 74038 | 1760 |
| E1 | 2 | 2 | 1 | 0 | 2 | 0 | 8 | 4 | 35544 | 1921 |
| S | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Template | Arm | Pass | Rate | Mean folds | Mean requests | Aux requests | Mean input | Mean output |
|---|---|---|---|---|---|---|---|---|
| T10 | B0 | 0/0 | null | null | null | 0 | null | null |
| T10 | E0 | 0/2 | 0 | 5 | 8 | 0 | 50119 | 842.5 |
| T10 | E0a | 0/0 | null | null | null | 0 | null | null |
| T10 | E0i | 0/0 | null | null | null | 0 | null | null |
| T10 | E0ai | 0/0 | null | null | null | 0 | null | null |
| T10 | E0-L | 0/2 | 0 | 2.5 | 3.5 | 0 | 27046 | 528.5 |
| T10 | E0-G | 2/2 | 1 | 5 | 7.5 | 0 | 66935.5 | 938.5 |
| T10 | E0-LG | 1/2 | 0.5 | 3 | 7.5 | 0 | 37019 | 880 |
| T10 | E1 | 2/2 | 1 | 0 | 4 | 4 | 17772 | 960.5 |
| T10 | S | 0/0 | null | null | null | 0 | null | null |

## Per-cell

| Cell | Block | Exposure | Folds (fail) | Check | Recall | Req (aux) | In | Out | Probes visible |
|---|---|---|---|---|---|---|---|---|---|
| T10-s1-E0-L-r1 | t10-retest | fold | 3 (0) | fail | 4 | 5 (0) | 35949 | 614 | 0/0 |
| T10-s1-E0-G-r1 | t10-retest | fold | 5 (0) | pass | 8 | 8 (0) | 78172 | 974 | 0/0 |
| T10-s1-E0-LG-r1 | t10-retest | fold | 3 (0) | fail | 5 | 8 (0) | 37556 | 1218 | 0/0 |
| T10-s1-E1-r1 | t10-retest | fold | 0 (2) | pass | 0 | 4 (2) | 17828 | 906 | — |
| T10-s1-E0-r1 | t10-retest | fold | 6 (0) | fail | 8 | 8 (0) | 58369 | 847 | 0/0 |
| T10-s2-E0-G-r1 | t10-retest | fold | 5 (0) | pass | 7 | 7 (0) | 55699 | 903 | 0/0 |
| T10-s2-E0-LG-r1 | t10-retest | fold | 3 (0) | pass | 3 | 7 (0) | 36482 | 542 | 0/0 |
| T10-s2-E1-r1 | t10-retest | fold | 0 (2) | pass | 0 | 4 (2) | 17716 | 1015 | — |
| T10-s2-E0-r1 | t10-retest | fold | 4 (0) | fail | 9 | 8 (0) | 41869 | 838 | 0/0 |
| T10-s2-E0-L-r1 | t10-retest | fold | 2 (0) | fail | 3 | 2 (0) | 18143 | 443 | 0/0 |

## What this table does not say

- The two seeds of a template are not two independent tasks; do not pool them into a population estimate.
- A checker failure is a task outcome, not an invalid measurement. Invalid cells are labelled separately.
- `inputTokens` is the provider's uncached input. Cache reads are reported in the JSON, not folded into this column.
- No cost in currency is claimed: this route has no verifiable per-token price.
