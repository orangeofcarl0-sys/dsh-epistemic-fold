# EF-R1 — 120-cell L×G analysis

Campaign `e2e-lg-confirm-1`, 100 cells, 514 requests, 3703265 input, 72960 output.

| Arm | Pass | Rate | Requests | Input | Output |
|---|---|---|---|---|---|
| E0 | 9/20 | 0.45 | 56 | 454136 | 6687 |
| E0-L | 14/20 | 0.7 | 56 | 637929 | 7199 |
| E0-G | 13/20 | 0.65 | 86 | 494477 | 11648 |
| E0-LG | 15/20 | 0.75 | 69 | 679448 | 8960 |
| E1 | 17/20 | 0.85 | 77 | 256343 | 12645 |

## Paired comparisons (same task instance + replicate)

| Left | Right | Left only | Right only | McNemar p | Risk difference | Instances L/R/tied |
|---|---|---|---|---|---|---|
| E0-L | E0 | 7 | 2 | 0.1797 | 0.25 | 5/1/4 |
| E0-G | E0 | 7 | 3 | 0.3438 | 0.2 | 5/2/3 |
| E0-LG | E0 | 7 | 1 | 0.0703 | 0.3 | 6/1/3 |
| E0-LG | E0-L | 3 | 2 | 1 | 0.05 | 3/2/5 |
| E0-LG | E0-G | 5 | 3 | 0.7266 | 0.1 | 4/2/4 |
| E1 | E0 | 11 | 3 | 0.0574 | 0.4 | 7/1/2 |

## Task-prompt covariate

The active task prompt was folded in 27 of 100 cells. This is not an exclusion: it is a separate failure mode.

| Arm | Pass (prompt lost) | Pass (prompt visible) |
|---|---|---|
| E0 | 2/8 | 7/12 |
| E0-L | 1/5 | 13/15 |
| E0-G | 2/7 | 11/13 |
| E0-LG | 2/6 | 13/14 |
| E1 | 0/1 | 17/19 |

## Failure stages by arm

| Arm | Stages |
|---|---|
| E0 | produce 4, write 4, verify 3 |
| E0-L | write 4, produce 2 |
| E0-G | verify 5, schema 2 |
| E0-LG | schema 2, produce 2, verify 1 |
| E1 | verify 1, write 2 |

## Per template

| Template | E0 | E0-L | E0-G | E0-LG | E1 |
|---|---|---|---|---|---|
| T2 | 0/4 | 1/4 | 2/4 | 0/4 | 4/4 |
| T4 | 1/4 | 4/4 | 1/4 | 4/4 | 4/4 |
| T7 | 2/4 | 3/4 | 4/4 | 4/4 | 3/4 |
| T8 | 3/4 | 4/4 | 4/4 | 3/4 | 4/4 |
| T9 | 3/4 | 2/4 | 2/4 | 4/4 | 2/4 |
