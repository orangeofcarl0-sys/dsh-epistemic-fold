# EF-E2E core campaign — e2e-recall-1

Status: **complete**. 12/12 cells executed.

| Arm | Cells | Pass | Rate | Folds | No-fold | Recall cells | Requests | Aux | Input | Output |
|---|---|---|---|---|---|---|---|---|---|---|
| B0 | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0 | 6 | 2 | 0.333 | 19 | 0 | 4 | 30 | 0 | 178848 | 3486 |
| E0a | 6 | 1 | 0.167 | 13 | 0 | 4 | 21 | 0 | 131528 | 2932 |
| E1 | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| S | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Template | Arm | Pass | Rate | Mean folds | Mean requests | Aux requests | Mean input | Mean output |
|---|---|---|---|---|---|---|---|---|
| T2 | B0 | 0/0 | null | null | null | 0 | null | null |
| T2 | E0 | 0/2 | 0 | 1 | 1.5 | 0 | 16126 | 386.5 |
| T2 | E0a | 0/2 | 0 | 1 | 1.5 | 0 | 16139 | 312.5 |
| T2 | E1 | 0/0 | null | null | null | 0 | null | null |
| T2 | S | 0/0 | null | null | null | 0 | null | null |
| T4 | B0 | 0/0 | null | null | null | 0 | null | null |
| T4 | E0 | 2/2 | 1 | 3 | 5.5 | 0 | 24835 | 591.5 |
| T4 | E0a | 0/2 | 0 | 2.5 | 3 | 0 | 23479.5 | 488.5 |
| T4 | E1 | 0/0 | null | null | null | 0 | null | null |
| T4 | S | 0/0 | null | null | null | 0 | null | null |
| T5B | B0 | 0/0 | null | null | null | 0 | null | null |
| T5B | E0 | 0/2 | 0 | 5.5 | 8 | 0 | 48463 | 765 |
| T5B | E0a | 1/2 | 0.5 | 3 | 6 | 0 | 26145.5 | 665 |
| T5B | E1 | 0/0 | null | null | null | 0 | null | null |
| T5B | S | 0/0 | null | null | null | 0 | null | null |

## Per-cell

| Cell | Block | Exposure | Folds (fail) | Check | Recall | Req (aux) | In | Out | Probes visible |
|---|---|---|---|---|---|---|---|---|---|
| T2-s1-E0-r1 | recall | fold | 1 (0) | fail | 0 | 1 (0) | 15970 | 387 | 0/2 |
| T2-s1-E0a-r1 | recall | fold | 1 (0) | fail | 0 | 2 (0) | 16209 | 430 | 0/2 |
| T2-s2-E0-r2 | recall | fold | 1 (0) | fail | 0 | 2 (0) | 16282 | 386 | 0/2 |
| T2-s2-E0a-r2 | recall | fold | 1 (0) | fail | 0 | 1 (0) | 16069 | 195 | 0/2 |
| T4-s1-E0-r1 | recall | fold | 4 (0) | pass | 7 | 6 (0) | 33897 | 800 | 1/2 |
| T4-s1-E0a-r1 | recall | fold | 2 (0) | fail | 1 | 2 (0) | 14168 | 128 | 1/2 |
| T4-s2-E0-r2 | recall | fold | 2 (0) | pass | 3 | 5 (0) | 15773 | 383 | 1/2 |
| T4-s2-E0a-r2 | recall | fold | 3 (0) | fail | 2 | 4 (0) | 32791 | 849 | 1/2 |
| T5B-s1-E0-r1 | recall | fold | 8 (0) | fail | 10 | 10 (0) | 69718 | 1021 | 0/2 |
| T5B-s1-E0a-r1 | recall | fold | 3 (0) | fail | 3 | 5 (0) | 26513 | 577 | 2/2 |
| T5B-s2-E0-r2 | recall | fold | 3 (0) | fail | 3 | 6 (0) | 27208 | 509 | 1/2 |
| T5B-s2-E0a-r2 | recall | fold | 3 (0) | pass | 1 | 7 (0) | 25778 | 753 | 1/2 |

## What this table does not say

- The two seeds of a template are not two independent tasks; do not pool them into a population estimate.
- A checker failure is a task outcome, not an invalid measurement. Invalid cells are labelled separately.
- `inputTokens` is the provider's uncached input. Cache reads are reported in the JSON, not folded into this column.
- No cost in currency is claimed: this route has no verifiable per-token price.
