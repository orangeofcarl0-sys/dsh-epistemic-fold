# EF-E2E core campaign — e2e-index-1

Status: **complete**. 24/24 cells executed.

| Arm | Cells | Pass | Rate | Folds | No-fold | Recall cells | Requests | Aux | Input | Output |
|---|---|---|---|---|---|---|---|---|---|---|
| B0 | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0 | 8 | 2 | 0.25 | 17 | 0 | 5 | 24 | 0 | 232191 | 5437 |
| E0a | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0i | 8 | 0 | 0 | 16 | 0 | 4 | 18 | 0 | 304954 | 3588 |
| E0ai | 8 | 1 | 0.125 | 22 | 0 | 5 | 26 | 0 | 323229 | 3403 |
| E1 | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| S | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Template | Arm | Pass | Rate | Mean folds | Mean requests | Aux requests | Mean input | Mean output |
|---|---|---|---|---|---|---|---|---|
| T2 | B0 | 0/0 | null | null | null | 0 | null | null |
| T2 | E0 | 0/4 | 0 | 1.5 | 1.75 | 0 | 33953.5 | 521.75 |
| T2 | E0a | 0/0 | null | null | null | 0 | null | null |
| T2 | E0i | 0/4 | 0 | 1.25 | 1.5 | 0 | 33589.25 | 403.25 |
| T2 | E0ai | 0/4 | 0 | 1.5 | 2 | 0 | 33768.75 | 290.75 |
| T2 | E1 | 0/0 | null | null | null | 0 | null | null |
| T2 | S | 0/0 | null | null | null | 0 | null | null |
| T4 | B0 | 0/0 | null | null | null | 0 | null | null |
| T4 | E0 | 2/4 | 0.5 | 2.75 | 4.25 | 0 | 24094.25 | 837.5 |
| T4 | E0a | 0/0 | null | null | null | 0 | null | null |
| T4 | E0i | 0/4 | 0 | 2.75 | 3 | 0 | 42649.25 | 493.75 |
| T4 | E0ai | 1/4 | 0.25 | 4 | 4.5 | 0 | 47038.5 | 560 |
| T4 | E1 | 0/0 | null | null | null | 0 | null | null |
| T4 | S | 0/0 | null | null | null | 0 | null | null |

## Per-cell

| Cell | Block | Exposure | Folds (fail) | Check | Recall | Req (aux) | In | Out | Probes visible |
|---|---|---|---|---|---|---|---|---|---|
| T2-s1-E0-r1 | index | fold | 3 (0) | fail | 3 | 3 (0) | 87526 | 864 | 0/2 |
| T2-s1-E0i-r1 | index | fold | 1 (0) | fail | 0 | 2 (0) | 16131 | 674 | 0/2 |
| T2-s1-E0ai-r1 | index | fold | 1 (0) | fail | 0 | 3 (0) | 16436 | 396 | 0/2 |
| T2-s2-E0-r1 | index | fold | 1 (0) | fail | 0 | 1 (0) | 16046 | 242 | 0/2 |
| T2-s2-E0i-r1 | index | fold | 1 (0) | fail | 0 | 1 (0) | 16062 | 168 | 0/2 |
| T2-s2-E0ai-r1 | index | fold | 3 (0) | fail | 2 | 3 (0) | 86544 | 338 | 0/2 |
| T4-s1-E0-r1 | index | fold | 2 (0) | fail | 1 | 3 (0) | 14653 | 842 | 1/2 |
| T4-s1-E0i-r1 | index | fold | 1 (0) | fail | 0 | 1 (0) | 13345 | 304 | 1/2 |
| T4-s1-E0ai-r1 | index | fold | 2 (0) | fail | 2 | 2 (0) | 31356 | 412 | 1/2 |
| T4-s2-E0-r1 | index | fold | 2 (0) | pass | 5 | 5 (0) | 16761 | 1101 | 1/2 |
| T4-s2-E0i-r1 | index | fold | 2 (0) | fail | 1 | 2 (0) | 31394 | 301 | 1/2 |
| T4-s2-E0ai-r1 | index | fold | 4 (0) | fail | 3 | 4 (0) | 63639 | 495 | 1/2 |
| T2-s1-E0-r2 | index | fold | 1 (0) | fail | 0 | 1 (0) | 15966 | 366 | 0/2 |
| T2-s1-E0i-r2 | index | fold | 2 (0) | fail | 1 | 2 (0) | 86102 | 511 | 0/2 |
| T2-s1-E0ai-r2 | index | fold | 1 (0) | fail | 0 | 1 (0) | 16010 | 198 | 0/2 |
| T2-s2-E0-r2 | index | fold | 1 (0) | fail | 0 | 2 (0) | 16276 | 615 | 0/2 |
| T2-s2-E0i-r2 | index | fold | 1 (0) | fail | 0 | 1 (0) | 16062 | 260 | 0/2 |
| T2-s2-E0ai-r2 | index | fold | 1 (0) | fail | 0 | 1 (0) | 16085 | 231 | 0/2 |
| T4-s1-E0-r2 | index | fold | 5 (0) | pass | 7 | 6 (0) | 49069 | 778 | 0/2 |
| T4-s1-E0i-r2 | index | fold | 4 (0) | fail | 4 | 5 (0) | 62181 | 700 | 1/2 |
| T4-s1-E0ai-r2 | index | fold | 6 (0) | fail | 9 | 8 (0) | 50114 | 1049 | 1/2 |
| T4-s2-E0-r2 | index | fold | 2 (0) | fail | 3 | 3 (0) | 15894 | 629 | 1/2 |
| T4-s2-E0i-r2 | index | fold | 4 (0) | fail | 3 | 4 (0) | 63677 | 670 | 1/2 |
| T4-s2-E0ai-r2 | index | fold | 4 (0) | pass | 2 | 4 (0) | 43045 | 284 | 1/2 |

## What this table does not say

- The two seeds of a template are not two independent tasks; do not pool them into a population estimate.
- A checker failure is a task outcome, not an invalid measurement. Invalid cells are labelled separately.
- `inputTokens` is the provider's uncached input. Cache reads are reported in the JSON, not folded into this column.
- No cost in currency is claimed: this route has no verifiable per-token price.
