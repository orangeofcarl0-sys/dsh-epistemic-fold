# EF-R3 product-lane pilot — 18 cells at 32k

Coverage: **18/18 executed**, 18 valid. Cost-valid cells: **17/18**.

| Arm | Pass | Committed | Delivered | Step-limited | Requests | Uncached input | Output | Cost-valid |
|---|---|---|---|---|---|---|---|---|
| B0 | 5/6 | 10 | 8 | 0 | 62 | 769063 | 31094 | 6/6 |
| E0 | 1/6 | 28 | 26 | 5 | 54 | 1108609 | 12301 | 6/6 |
| E1 | 3/6 | 13 | 13 | 3 | 61 | 928410 | 19587 | 5/6 |

## Paired E1 − B0

Pairs: **6**. Both pass 3, neither 1, E1 only 0, B0 only 2; exact McNemar p=0.5.

Recorded deltas: pass -2, requests -1, input 159347, cache read -43904, output -11507.

Cost-valid pairs: **5**; input 87881, output -9745.

## Per template

| Template | B0 | E0 | E1 |
|---|---|---|---|
| T11 | 1/1 (step 0) | 0/1 (step 1) | 0/1 (step 1) |
| T12 | 1/1 (step 0) | 0/1 (step 1) | 1/1 (step 0) |
| T13 | 1/1 (step 0) | 0/1 (step 1) | 1/1 (step 0) |
| T14 | 1/1 (step 0) | 1/1 (step 0) | 1/1 (step 0) |
| T15 | 1/1 (step 0) | 0/1 (step 1) | 0/1 (step 1) |
| T16 | 0/1 (step 0) | 0/1 (step 1) | 0/1 (step 1) |

## Exact-span probe

| Arm | Cells with probe | Widest median | Executed median | Gap median | Actual checkpoint median | Actual reclaim median | Reconciled | False admissions |
|---|---|---|---|---|---|---|---|---|
| B0 | 0 | — | — | — | — | — | 0 | 0 |
| E0 | 6 | 15649 | 15757 | 0 | 20 | 15737 | 4 | 2 |
| E1 | 6 | 10055 | 12802 | 0 | 576 | 12226 | 2 | 4 |

## Health probe

16/16 transport/usage successes; p95 82290 ms; over 60s: 1. The p95 bound was not met; this is a recorded latency caveat.

## Decision

**No product candidate; Deployment Hold remains. Do not expand to the 72-cell lane.**

- B0 passed 5/6, E1 passed 3/6, E0 passed 1/6; E1 has 0 E1-only pass(es) against B0, B0 has 2 B0-only pass(es).
- The EF arms hit step-limit in 5/6 E0 cells and 3/6 E1 cells; B0 hit step-limit in 0/6. The pilot therefore does not give a clean quality comparison.
- E1 uses more uncached input than B0 in the recorded pairs (159347 tokens), and the cost-valid subset is smaller (5/6 pairs).
- One E1 cell (T16-p1-E1-r1) reported one unknown usage; strictUsage stopped the campaign after all 18 cells. Cost-valid cells: 17/18.
- The representative health probe passed transport/usage 16/16 but one 82s request exceeded the pre-registered 60s p95 bound. Latency is a recorded caveat.
- The pilot is n=6 per arm and is not confirmatory; it is not pooled with the R2 pilot or confirm.

Next: Do not expand to the 72-cell lane. Diagnose the EF step-limit/quality gap under the shipped preset: a step-limit sensitivity campaign (same tasks, maxSteps 12/16, all arms) or an offline step-budget analysis. A new live authorization is required.

This is a pilot, not a confirmatory result. The main finding is the EF step-limit/quality gap under the shipped preset, not a confirmed E1 advantage.

