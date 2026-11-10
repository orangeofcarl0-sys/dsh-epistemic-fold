# EF-R2 — active-task delivery

Coverage: 290 cells, 194 with full messages, 96 preview-only.

Legacy confirm: **44/120** lost by the preview metric (expected 44; reproduced true).

| Measure | Confirm cells |
|---|---|
| Original task message at last request | 75 |
| Original lost by last request (exact) | 45 |
| Checkpoint contains the request text | 5 |
| Checkpoint carries the task values only | 38 |
| Checkpoint present, neither request nor values | 2 |
| Nothing visible | 0 |
| Task values unavailable at the end | 2 |

## By arm

| Arm | End original | Checkpoint copy | Values only | Neither | Values unavailable |
|---|---|---|---|---|---|
| E0 | 12 | 0 | 12 | 0 | 0 |
| E0-G | 12 | 3 | 9 | 0 | 0 |
| E0-L | 15 | 1 | 7 | 1 | 1 |
| E0-LG | 14 | 1 | 8 | 1 | 1 |
| E1 | 22 | 0 | 2 | 0 | 0 |

## What this refines, and what it does not

The exact original is gone in **45/120** cells, but only **2/120** have neither the request text nor the task values at the end. 5 carry the request text in a checkpoint copy and 38 carry the task values without the wording.

A values-only delivery is not proof that the instruction survived: it proves the answer facts did. The two values-unavailable cells are the only ones where the earlier “prompt lost” label coincides with actual information absence.

## E1 covariate

- Legacy preview loss: lost 0/2 pass, visible 18/22 pass.
- Exact original loss: lost 0/2 pass, visible 18/22 pass.
- Task values unavailable: 0/0 pass, available 18/24 pass.

The two exact-loss E1 cells still carried the task values (values unavailable 0/24). Their 0/2 pass rate is therefore not explained by the facts disappearing; n=2, so it is a description, not an effect.

