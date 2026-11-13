# EF-E2E core campaign — e2e-prompt-rerender-1

Status: **complete**. 8/8 cells executed.

| Arm | Cells | Pass | Rate | Folds | No-fold | Recall cells | Requests | Aux | Input | Output |
|---|---|---|---|---|---|---|---|---|---|---|
| B0 | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0 | 4 | 1 | 0.25 | 12 | 0 | 4 | 18 | 0 | 151262 | 2400 |
| E0a | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0i | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0ai | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0-L | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0-G | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0-LG | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0-P | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E1 | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| S | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Template | Arm | Pass | Rate | Mean folds | Mean requests | Aux requests | Mean input | Mean output |
|---|---|---|---|---|---|---|---|---|
| T10 | B0 | 0/0 | null | null | null | 0 | null | null |
| T10 | E0 | 0/2 | 0 | 2.5 | 4 | 0 | 26707.5 | 520 |
| T10 | E0a | 0/0 | null | null | null | 0 | null | null |
| T10 | E0i | 0/0 | null | null | null | 0 | null | null |
| T10 | E0ai | 0/0 | null | null | null | 0 | null | null |
| T10 | E0-L | 0/0 | null | null | null | 0 | null | null |
| T10 | E0-G | 0/0 | null | null | null | 0 | null | null |
| T10 | E0-LG | 0/0 | null | null | null | 0 | null | null |
| T10 | E0-P | 0/0 | null | null | null | 0 | null | null |
| T10 | E1 | 0/0 | null | null | null | 0 | null | null |
| T10 | S | 0/0 | null | null | null | 0 | null | null |
| T9 | B0 | 0/0 | null | null | null | 0 | null | null |
| T9 | E0 | 1/2 | 0.5 | 3.5 | 5 | 0 | 48923.5 | 680 |
| T9 | E0a | 0/0 | null | null | null | 0 | null | null |
| T9 | E0i | 0/0 | null | null | null | 0 | null | null |
| T9 | E0ai | 0/0 | null | null | null | 0 | null | null |
| T9 | E0-L | 0/0 | null | null | null | 0 | null | null |
| T9 | E0-G | 0/0 | null | null | null | 0 | null | null |
| T9 | E0-LG | 0/0 | null | null | null | 0 | null | null |
| T9 | E0-P | 0/0 | null | null | null | 0 | null | null |
| T9 | E1 | 0/0 | null | null | null | 0 | null | null |
| T9 | S | 0/0 | null | null | null | 0 | null | null |

## Per-cell

| Cell | Block | Exposure | Folds (fail) | Check | Recall | Req (aux) | In | Out | Probes visible |
|---|---|---|---|---|---|---|---|---|---|
| T9-s1-E0-r1 | prompt-rerender | fold | 2 (0) | fail | 2 | 2 (0) | 18978 | 254 | 0/0 |
| T9-s1-E0-R-r1 | prompt-rerender | fold | 2 (0) | pass | 3 | 4 (0) | 19909 | 413 | 0/0 |
| T9-s2-E0-r1 | prompt-rerender | fold | 5 (0) | pass | 10 | 8 (0) | 78869 | 1106 | 0/0 |
| T9-s2-E0-R-r1 | prompt-rerender | fold | 2 (0) | pass | 3 | 5 (0) | 19486 | 560 | 0/0 |
| T10-s1-E0-r1 | prompt-rerender | fold | 3 (0) | fail | 3 | 4 (0) | 35114 | 422 | 0/0 |
| T10-s1-E0-R-r1 | prompt-rerender | fold | 4 (0) | pass | 2 | 4 (0) | 52233 | 318 | 0/0 |
| T10-s2-E0-r1 | prompt-rerender | fold | 2 (0) | fail | 2 | 4 (0) | 18301 | 618 | 0/0 |
| T10-s2-E0-R-r1 | prompt-rerender | fold | 3 (0) | pass | 5 | 5 (0) | 36689 | 548 | 0/0 |

## What this table does not say

- The two seeds of a template are not two independent tasks; do not pool them into a population estimate.
- A checker failure is a task outcome, not an invalid measurement. Invalid cells are labelled separately.
- `inputTokens` is the provider's uncached input. Cache reads are reported in the JSON, not folded into this column.
- No cost in currency is claimed: this route has no verifiable per-token price.
