# EF-E2E core campaign — e2e-prompt-pilot-2

Status: **complete**. 8/8 cells executed.

| Arm | Cells | Pass | Rate | Folds | No-fold | Recall cells | Requests | Aux | Input | Output |
|---|---|---|---|---|---|---|---|---|---|---|
| B0 | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0 | 4 | 0 | 0 | 12 | 0 | 4 | 16 | 0 | 115618 | 2375 |
| E0a | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0i | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0ai | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0-L | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0-G | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0-LG | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0-P | 4 | 3 | 0.75 | 4 | 0 | 1 | 8 | 0 | 1587 | 966 |
| E1 | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| S | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Template | Arm | Pass | Rate | Mean folds | Mean requests | Aux requests | Mean input | Mean output |
|---|---|---|---|---|---|---|---|---|
| T10 | B0 | 0/0 | null | null | null | 0 | null | null |
| T10 | E0 | 0/2 | 0 | 4 | 6 | 0 | 39349 | 900.5 |
| T10 | E0a | 0/0 | null | null | null | 0 | null | null |
| T10 | E0i | 0/0 | null | null | null | 0 | null | null |
| T10 | E0ai | 0/0 | null | null | null | 0 | null | null |
| T10 | E0-L | 0/0 | null | null | null | 0 | null | null |
| T10 | E0-G | 0/0 | null | null | null | 0 | null | null |
| T10 | E0-LG | 0/0 | null | null | null | 0 | null | null |
| T10 | E0-P | 2/2 | 1 | 1 | 2 | 0 | 376.5 | 137.5 |
| T10 | E1 | 0/0 | null | null | null | 0 | null | null |
| T10 | S | 0/0 | null | null | null | 0 | null | null |
| T9 | B0 | 0/0 | null | null | null | 0 | null | null |
| T9 | E0 | 0/2 | 0 | 2 | 2 | 0 | 18460 | 287 |
| T9 | E0a | 0/0 | null | null | null | 0 | null | null |
| T9 | E0i | 0/0 | null | null | null | 0 | null | null |
| T9 | E0ai | 0/0 | null | null | null | 0 | null | null |
| T9 | E0-L | 0/0 | null | null | null | 0 | null | null |
| T9 | E0-G | 0/0 | null | null | null | 0 | null | null |
| T9 | E0-LG | 0/0 | null | null | null | 0 | null | null |
| T9 | E0-P | 1/2 | 0.5 | 1 | 2 | 0 | 417 | 345.5 |
| T9 | E1 | 0/0 | null | null | null | 0 | null | null |
| T9 | S | 0/0 | null | null | null | 0 | null | null |

## Per-cell

| Cell | Block | Exposure | Folds (fail) | Check | Recall | Req (aux) | In | Out | Probes visible |
|---|---|---|---|---|---|---|---|---|---|
| T9-s1-E0-r1 | prompt-repair | fold | 2 (0) | fail | 1 | 2 (0) | 18294 | 216 | 0/0 |
| T9-s1-E0-P-r1 | prompt-repair | fold | 1 (0) | fail | 2 | 2 (0) | 395 | 495 | — |
| T9-s2-E0-r1 | prompt-repair | fold | 2 (0) | fail | 2 | 2 (0) | 18626 | 358 | 0/0 |
| T9-s2-E0-P-r1 | prompt-repair | fold | 1 (0) | pass | 0 | 2 (0) | 439 | 196 | — |
| T10-s1-E0-r1 | prompt-repair | fold | 6 (0) | fail | 12 | 8 (0) | 59423 | 1311 | 0/0 |
| T10-s1-E0-P-r1 | prompt-repair | fold | 1 (0) | pass | 0 | 2 (0) | 402 | 135 | — |
| T10-s2-E0-r1 | prompt-repair | fold | 2 (0) | fail | 3 | 4 (0) | 19275 | 490 | 0/0 |
| T10-s2-E0-P-r1 | prompt-repair | fold | 1 (0) | pass | 0 | 2 (0) | 351 | 140 | — |

## What this table does not say

- The two seeds of a template are not two independent tasks; do not pool them into a population estimate.
- A checker failure is a task outcome, not an invalid measurement. Invalid cells are labelled separately.
- `inputTokens` is the provider's uncached input. Cache reads are reported in the JSON, not folded into this column.
- No cost in currency is claimed: this route has no verifiable per-token price.
