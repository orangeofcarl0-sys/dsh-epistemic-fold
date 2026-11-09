# EF-E2E core campaign — e2e-guard-smoke-1

Status: **complete**. 1/1 cells executed.

| Arm | Cells | Pass | Rate | Folds | No-fold | Recall cells | Requests | Aux | Input | Output |
|---|---|---|---|---|---|---|---|---|---|---|
| B0 | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0 | 1 | 0 | 0 | 2 | 0 | 0 | 3 | 0 | 16903 | 590 |
| E0a | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E1 | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| S | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Template | Arm | Pass | Rate | Mean folds | Mean requests | Aux requests | Mean input | Mean output |
|---|---|---|---|---|---|---|---|---|
| T2 | B0 | 0/0 | null | null | null | 0 | null | null |
| T2 | E0 | 0/1 | 0 | 2 | 3 | 0 | 16903 | 590 |
| T2 | E0a | 0/0 | null | null | null | 0 | null | null |
| T2 | E1 | 0/0 | null | null | null | 0 | null | null |
| T2 | S | 0/0 | null | null | null | 0 | null | null |

## Per-cell

| Cell | Block | Exposure | Folds (fail) | Check | Recall | Req (aux) | In | Out | Probes visible |
|---|---|---|---|---|---|---|---|---|---|
| T2-s1-E0-r0 | guard-smoke | fold | 2 (0) | fail | 0 | 3 (0) | 16903 | 590 | 0/2 |

## What this table does not say

- The two seeds of a template are not two independent tasks; do not pool them into a population estimate.
- A checker failure is a task outcome, not an invalid measurement. Invalid cells are labelled separately.
- `inputTokens` is the provider's uncached input. Cache reads are reported in the JSON, not folded into this column.
- No cost in currency is claimed: this route has no verifiable per-token price.
