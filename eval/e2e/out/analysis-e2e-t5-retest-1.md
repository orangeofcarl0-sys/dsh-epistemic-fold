# EF-E2E core campaign — e2e-t5-retest-1

Status: **complete**. 8/8 cells executed.

| Arm | Cells | Pass | Rate | Folds | No-fold | Recall cells | Requests | Aux | Input | Output |
|---|---|---|---|---|---|---|---|---|---|---|
| B0 | 2 | 2 | 1 | 5 | 0 | 0 | 18 | 10 | 79623 | 9533 |
| E0 | 2 | 1 | 0.5 | 9 | 0 | 2 | 18 | 0 | 102233 | 1761 |
| E1 | 2 | 2 | 1 | 4 | 0 | 0 | 14 | 4 | 51563 | 2304 |
| S | 2 | 2 | 1 | 4 | 0 | 0 | 12 | 4 | 55003 | 2412 |

| Template | Arm | Pass | Rate | Mean folds | Mean requests | Aux requests | Mean input | Mean output |
|---|---|---|---|---|---|---|---|---|
| T5B | B0 | 2/2 | 1 | 2.5 | 9 | 10 | 39811.5 | 4766.5 |
| T5B | E0 | 1/2 | 0.5 | 4.5 | 9 | 0 | 51116.5 | 880.5 |
| T5B | E1 | 2/2 | 1 | 2 | 7 | 4 | 25781.5 | 1152 |
| T5B | S | 2/2 | 1 | 2 | 6 | 4 | 27501.5 | 1206 |

## Per-cell

| Cell | Block | Exposure | Folds (fail) | Check | Recall | Req (aux) | In | Out | Probes visible |
|---|---|---|---|---|---|---|---|---|---|
| T5B-s1-B0-r1 | retest | fold | 2 (3) | pass | 0 | 9 (5) | 39437 | 4770 | 2/2 |
| T5B-s1-E0-r1 | retest | fold | 3 (0) | pass | 3 | 8 (0) | 26476 | 558 | 1/2 |
| T5B-s1-E1-r1 | retest | fold | 2 (0) | pass | 0 | 6 (2) | 25273 | 972 | 2/2 |
| T5B-s1-S-r1 | retest | fold | 2 (0) | pass | 0 | 6 (2) | 26657 | 934 | 2/2 |
| T5B-s2-B0-r2 | retest | fold | 3 (2) | pass | 0 | 9 (5) | 40186 | 4763 | 2/2 |
| T5B-s2-E0-r2 | retest | fold | 6 (0) | fail | 7 | 10 (0) | 75757 | 1203 | 0/2 |
| T5B-s2-E1-r2 | retest | fold | 2 (0) | pass | 0 | 8 (2) | 26290 | 1332 | 2/2 |
| T5B-s2-S-r2 | retest | fold | 2 (0) | pass | 0 | 6 (2) | 28346 | 1478 | 2/2 |

## What this table does not say

- The two seeds of a template are not two independent tasks; do not pool them into a population estimate.
- A checker failure is a task outcome, not an invalid measurement. Invalid cells are labelled separately.
- `inputTokens` is the provider's uncached input. Cache reads are reported in the JSON, not folded into this column.
- No cost in currency is claimed: this route has no verifiable per-token price.
