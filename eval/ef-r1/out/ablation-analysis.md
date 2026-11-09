# EF-R1 — 120-cell L×G analysis

Campaign `e2e-lg-confirm-1`, 120 cells, 514 requests, 3703265 input, 72960 output.

| Arm | Pass | Rate | Requests | Input | Output |
|---|---|---|---|---|---|
| E0 | 9/24 | 0.375 | 83 | 678175 | 10569 |
| E0-L | 15/24 | 0.625 | 77 | 842370 | 9963 |
| E0-G | 15/24 | 0.625 | 145 | 919738 | 19764 |
| E0-LG | 16/24 | 0.667 | 113 | 967562 | 15937 |
| E1 | 18/24 | 0.75 | 96 | 295420 | 16727 |

## Paired comparisons (same task instance + replicate)

| Left | Right | Left only | Right only | McNemar p | Risk difference | Instances L/R/tied |
|---|---|---|---|---|---|---|
| E0-L | E0 | 8 | 2 | 0.1094 | 0.25 | 6/1/5 |
| E0-G | E0 | 9 | 3 | 0.146 | 0.25 | 7/2/3 |
| E0-LG | E0 | 8 | 1 | 0.0391 | 0.292 | 7/1/4 |
| E0-LG | E0-L | 4 | 3 | 1 | 0.042 | 4/3/5 |
| E0-LG | E0-G | 5 | 4 | 1 | 0.042 | 4/3/5 |
| E1 | E0 | 12 | 3 | 0.0352 | 0.375 | 8/1/3 |

## Task-prompt covariate

The active task prompt was folded in 44 of 120 cells. This is not an exclusion: it is a separate failure mode.

| Arm | Pass (prompt lost) | Pass (prompt visible) |
|---|---|---|
| E0 | 2/12 | 7/12 |
| E0-L | 2/9 | 13/15 |
| E0-G | 4/11 | 11/13 |
| E0-LG | 3/10 | 13/14 |
| E1 | 0/2 | 18/22 |

## Failure stages by arm

| Arm | Stages |
|---|---|
| E0 | produce 8, write 4, verify 3 |
| E0-L | write 4, produce 4, verify 1 |
| E0-G | verify 6, schema 3 |
| E0-LG | schema 2, produce 2, verify 4 |
| E1 | verify 3, write 2, produce 1 |

## Per template

| Template | E0 | E0-L | E0-G | E0-LG | E1 |
|---|---|---|---|---|---|
| T10 | 0/4 | 1/4 | 2/4 | 1/4 | 1/4 |
| T2 | 0/4 | 1/4 | 2/4 | 0/4 | 4/4 |
| T4 | 1/4 | 4/4 | 1/4 | 4/4 | 4/4 |
| T7 | 2/4 | 3/4 | 4/4 | 4/4 | 3/4 |
| T8 | 3/4 | 4/4 | 4/4 | 3/4 | 4/4 |
| T9 | 3/4 | 2/4 | 2/4 | 4/4 | 2/4 |
