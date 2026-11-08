# EF-E2E core campaign — e2e-core-1

Status: **complete**. 39/39 cells executed.

| Arm | Cells | Pass | Rate | Folds | No-fold | Recall cells | Requests | Aux | Input | Output |
|---|---|---|---|---|---|---|---|---|---|---|
| B0 | 13 | 10 | 0.769 | 37 | 0 | 0 | 111 | 58 | 424442 | 47222 |
| E0 | 13 | 8 | 0.615 | 29 | 0 | 7 | 74 | 0 | 315536 | 7998 |
| E1 | 13 | 11 | 0.846 | 22 | 0 | 0 | 74 | 22 | 474602 | 13946 |

| Template | Arm | Pass | Rate | Mean folds | Mean requests | Aux requests | Mean input | Mean output |
|---|---|---|---|---|---|---|---|---|
| T1 | B0 | 2/3 | 0.667 | 4.333 | 9.333 | 14 | 29041 | 4433 |
| T1 | E0 | 3/3 | 1 | 2 | 7 | 0 | 16022.333 | 726.667 |
| T1 | E1 | 3/3 | 1 | 2 | 6.333 | 6 | 30035 | 1384.667 |
| T2 | B0 | 2/2 | 1 | 1.5 | 5 | 6 | 49143.5 | 1692.5 |
| T2 | E0 | 0/2 | 0 | 2 | 2 | 0 | 51255 | 488.5 |
| T2 | E1 | 2/2 | 1 | 1 | 3 | 2 | 47650.5 | 676.5 |
| T3 | B0 | 2/2 | 1 | 3.5 | 12 | 12 | 34801.5 | 5272.5 |
| T3 | E0 | 2/2 | 1 | 2 | 6.5 | 0 | 15978 | 819.5 |
| T3 | E1 | 2/2 | 1 | 2 | 8 | 4 | 37554 | 1469 |
| T4 | B0 | 2/2 | 1 | 2 | 5.5 | 7 | 23196.5 | 1638 |
| T4 | E0 | 0/2 | 0 | 2.5 | 4 | 0 | 22489.5 | 380.5 |
| T4 | E1 | 2/2 | 1 | 1 | 3 | 2 | 30438 | 431 |
| T5 | B0 | 0/2 | 0 | 2.5 | 7.5 | 8 | 40743 | 4136 |
| T5 | E0 | 1/2 | 0.5 | 3 | 7.5 | 0 | 27788.5 | 763 |
| T5 | E1 | 0/2 | 0 | 2 | 6 | 4 | 45287 | 961 |
| T6 | B0 | 2/2 | 1 | 2.5 | 11.5 | 11 | 20775 | 4222.5 |
| T6 | E0 | 2/2 | 1 | 2 | 6.5 | 0 | 16223.5 | 457.5 |
| T6 | E1 | 2/2 | 1 | 2 | 7.5 | 4 | 31319 | 1358.5 |

## Per-cell

| Cell | Block | Exposure | Folds (fail) | Check | Recall | Req (aux) | In | Out | Probes visible |
|---|---|---|---|---|---|---|---|---|---|
| T1-s1-B0-r0 | calibration | fold | 5 (0) | fail | 0 | 9 (5) | 33218 | 3995 | 0/0 |
| T1-s1-E0-r0 | calibration | fold | 2 (0) | pass | 0 | 7 (0) | 16970 | 718 | 0/0 |
| T1-s1-E1-r0 | calibration | fold | 2 (0) | pass | 0 | 6 (2) | 29152 | 1322 | 0/0 |
| T1-s1-E0-r1 | core | fold | 2 (0) | pass | 0 | 7 (0) | 15403 | 766 | 0/0 |
| T1-s1-E1-r1 | core | fold | 2 (0) | pass | 0 | 7 (2) | 16581 | 1604 | 0/0 |
| T1-s1-B0-r1 | core | fold | 5 (0) | pass | 0 | 11 (5) | 34991 | 5723 | 0/0 |
| T2-s1-E1-r1 | core | fold | 1 (0) | pass | 0 | 3 (1) | 78251 | 769 | 2/2 |
| T2-s1-B0-r1 | core | fold | 2 (1) | pass | 0 | 5 (3) | 18650 | 1746 | 2/2 |
| T2-s1-E0-r1 | core | fold | 1 (0) | fail | 0 | 1 (0) | 15970 | 407 | 0/2 |
| T3-s1-B0-r1 | core | fold | 4 (2) | pass | 0 | 12 (6) | 49535 | 5111 | 0/0 |
| T3-s1-E0-r1 | core | fold | 2 (0) | pass | 3 | 7 (0) | 16368 | 870 | 0/0 |
| T3-s1-E1-r1 | core | fold | 2 (0) | pass | 0 | 8 (2) | 29718 | 1398 | 0/0 |
| T4-s1-E0-r1 | core | fold | 2 (0) | fail | 2 | 2 (0) | 14795 | 223 | 1/2 |
| T4-s1-E1-r1 | core | fold | 1 (0) | pass | 0 | 3 (1) | 29964 | 426 | 2/2 |
| T4-s1-B0-r1 | core | fold | 3 (1) | pass | 0 | 6 (4) | 30325 | 2038 | 2/2 |
| T5-s1-E1-r1 | core | fold | 2 (0) | fail | 0 | 6 (2) | 53134 | 1063 | 2/2 |
| T5-s1-B0-r1 | core | fold | 4 (1) | fail | 0 | 9 (5) | 40733 | 4433 | 2/2 |
| T5-s1-E0-r1 | core | fold | 3 (0) | fail | 6 | 8 (0) | 28044 | 842 | 1/2 |
| T6-s1-B0-r1 | core | fold | 2 (3) | pass | 0 | 11 (5) | 21269 | 3934 | 2/2 |
| T6-s1-E0-r1 | core | fold | 2 (0) | pass | 0 | 6 (0) | 15843 | 398 | 0/2 |
| T6-s1-E1-r1 | core | fold | 2 (0) | pass | 0 | 8 (2) | 31453 | 1278 | 2/2 |
| T1-s2-E1-r2 | core | fold | 2 (0) | pass | 0 | 6 (2) | 44372 | 1228 | 0/0 |
| T1-s2-B0-r2 | core | fold | 3 (1) | pass | 0 | 8 (4) | 18914 | 3581 | 0/0 |
| T1-s2-E0-r2 | core | fold | 2 (0) | pass | 0 | 7 (0) | 15694 | 696 | 0/0 |
| T2-s2-B0-r2 | core | fold | 1 (2) | pass | 0 | 5 (3) | 79637 | 1639 | 2/2 |
| T2-s2-E0-r2 | core | fold | 3 (0) | fail | 3 | 3 (0) | 86540 | 570 | 0/2 |
| T2-s2-E1-r2 | core | fold | 1 (0) | pass | 0 | 3 (1) | 17050 | 584 | 2/2 |
| T3-s2-E0-r2 | core | fold | 2 (0) | pass | 2 | 6 (0) | 15588 | 769 | 0/0 |
| T3-s2-E1-r2 | core | fold | 2 (0) | pass | 0 | 8 (2) | 45390 | 1540 | 0/0 |
| T3-s2-B0-r2 | core | fold | 3 (3) | pass | 0 | 12 (6) | 20068 | 5434 | 0/0 |
| T4-s2-E1-r2 | core | fold | 1 (0) | pass | 0 | 3 (1) | 30912 | 436 | 2/2 |
| T4-s2-B0-r2 | core | fold | 1 (2) | pass | 0 | 5 (3) | 16068 | 1238 | 2/2 |
| T4-s2-E0-r2 | core | fold | 3 (0) | fail | 3 | 6 (0) | 30184 | 538 | 1/2 |
| T5-s2-B0-r2 | core | fold | 1 (2) | fail | 0 | 6 (3) | 40753 | 3839 | 2/2 |
| T5-s2-E0-r2 | core | fold | 3 (0) | pass | 6 | 7 (0) | 27533 | 684 | 2/2 |
| T5-s2-E1-r2 | core | fold | 2 (0) | fail | 0 | 6 (2) | 37440 | 859 | 2/2 |
| T6-s2-E0-r2 | core | fold | 2 (0) | pass | 0 | 7 (0) | 16604 | 517 | 0/2 |
| T6-s2-E1-r2 | core | fold | 2 (0) | pass | 0 | 7 (2) | 31185 | 1439 | 2/2 |
| T6-s2-B0-r2 | core | fold | 3 (3) | pass | 0 | 12 (6) | 20281 | 4511 | 1/2 |

## What this table does not say

- The two seeds of a template are not two independent tasks; do not pool them into a population estimate.
- A checker failure is a task outcome, not an invalid measurement. Invalid cells are labelled separately.
- `inputTokens` is the provider's uncached input. Cache reads are reported in the JSON, not folded into this column.
- No cost in currency is claimed: this route has no verifiable per-token price.
