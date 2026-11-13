# EF-E2E core campaign — e2e-pilot-1

Status: **complete**. 12/12 cells executed.

| Arm | Cells | Pass | Rate | Folds | No-fold | Recall cells | Requests | Aux | Input | Output |
|---|---|---|---|---|---|---|---|---|---|---|
| B0 | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0 | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E1 | 6 | 3 | 0.5 | 10 | 0 | 0 | 33 | 10 | 116997 | 7013 |
| S | 6 | 4 | 0.667 | 12 | 0 | 1 | 44 | 12 | 163541 | 8942 |

| Template | Arm | Pass | Rate | Mean folds | Mean requests | Aux requests | Mean input | Mean output |
|---|---|---|---|---|---|---|---|---|
| T1 | B0 | 0/0 | null | null | null | 0 | null | null |
| T1 | E0 | 0/0 | null | null | null | 0 | null | null |
| T1 | E1 | 0/0 | null | null | null | 0 | null | null |
| T1 | S | 0/0 | null | null | null | 0 | null | null |
| T2 | B0 | 0/0 | null | null | null | 0 | null | null |
| T2 | E0 | 0/0 | null | null | null | 0 | null | null |
| T2 | E1 | 1/2 | 0.5 | 1 | 2.5 | 2 | 16639 | 771 |
| T2 | S | 2/2 | 1 | 1 | 3 | 2 | 16820 | 755.5 |
| T3 | B0 | 0/0 | null | null | null | 0 | null | null |
| T3 | E0 | 0/0 | null | null | null | 0 | null | null |
| T3 | E1 | 2/2 | 1 | 2 | 8 | 4 | 16477 | 1648.5 |
| T3 | S | 2/2 | 1 | 2 | 8 | 4 | 17785 | 1404.5 |
| T4 | B0 | 0/0 | null | null | null | 0 | null | null |
| T4 | E0 | 0/0 | null | null | null | 0 | null | null |
| T4 | E1 | 0/0 | null | null | null | 0 | null | null |
| T4 | S | 0/0 | null | null | null | 0 | null | null |
| T5 | B0 | 0/0 | null | null | null | 0 | null | null |
| T5 | E0 | 0/0 | null | null | null | 0 | null | null |
| T5 | E1 | 0/2 | 0 | 2 | 6 | 4 | 25382.5 | 1087 |
| T5 | S | 0/2 | 0 | 3 | 11 | 6 | 47165.5 | 2311 |
| T6 | B0 | 0/0 | null | null | null | 0 | null | null |
| T6 | E0 | 0/0 | null | null | null | 0 | null | null |
| T6 | E1 | 0/0 | null | null | null | 0 | null | null |
| T6 | S | 0/0 | null | null | null | 0 | null | null |

## Per-cell

| Cell | Block | Exposure | Folds (fail) | Check | Recall | Req (aux) | In | Out | Probes visible |
|---|---|---|---|---|---|---|---|---|---|
| T2-s1-E1-r1 | pilot | fold | 1 (0) | pass | 0 | 3 (1) | 16787 | 775 | 2/2 |
| T2-s1-S-r1 | pilot | fold | 1 (0) | pass | 0 | 3 (1) | 16795 | 683 | 2/2 |
| T2-s1-E1-r2 | pilot | fold | 1 (0) | fail | 0 | 2 (1) | 16491 | 767 | 2/2 |
| T2-s1-S-r2 | pilot | fold | 1 (0) | pass | 0 | 3 (1) | 16845 | 828 | 2/2 |
| T3-s1-E1-r1 | pilot | fold | 2 (0) | pass | 0 | 8 (2) | 16663 | 1726 | 0/0 |
| T3-s1-S-r1 | pilot | fold | 2 (0) | pass | 0 | 8 (2) | 18715 | 1358 | 0/0 |
| T3-s1-E1-r2 | pilot | fold | 2 (0) | pass | 0 | 8 (2) | 16291 | 1571 | 0/0 |
| T3-s1-S-r2 | pilot | fold | 2 (0) | pass | 0 | 8 (2) | 16855 | 1451 | 0/0 |
| T5-s1-E1-r1 | pilot | fold | 2 (0) | fail | 0 | 6 (2) | 25433 | 1146 | 2/2 |
| T5-s1-S-r1 | pilot | fold | 4 (0) | fail | 3 | 16 (4) | 67415 | 3109 | 2/2 |
| T5-s1-E1-r2 | pilot | fold | 2 (0) | fail | 0 | 6 (2) | 25332 | 1028 | 2/2 |
| T5-s1-S-r2 | pilot | fold | 2 (0) | fail | 0 | 6 (2) | 26916 | 1513 | 2/2 |

## What this table does not say

- The two seeds of a template are not two independent tasks; do not pool them into a population estimate.
- A checker failure is a task outcome, not an invalid measurement. Invalid cells are labelled separately.
- `inputTokens` is the provider's uncached input. Cache reads are reported in the JSON, not folded into this column.
- No cost in currency is claimed: this route has no verifiable per-token price.
