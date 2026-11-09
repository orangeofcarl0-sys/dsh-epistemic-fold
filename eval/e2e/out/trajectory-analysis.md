# EF-E2E — trajectory and variance attribution

Executed cells analysed: **72**. Ordered trajectories: **1**; the rest use request deltas + tool counts.

## Output-file tasks: what separates a pass from a failure

| Behaviour | Pass | Fail |
|---|---|---|
| wrote an output (write_file/edit_file) | 22 | 17 |
| wrote nothing | 0 | 8 |
| called recall | 5 | 11 |
| never called recall | 17 | 14 |

## Repeat-run flips (same task + seed + arm, different campaign)

### T1:1:B0

| Campaign | Outcome | Folds | Requests | Recall | Writes | Final claim |
|---|---|---|---|---|---|---|
| e2e-core-1 | fail (null) | 5 | 9 | 0 | 1 | Fixed `truncate` in `src/text.js`:

- Content is now budgeted to `max - 1` code units so the ellipsis counts toward `max`, and the result can never exceed it.
- |
| e2e-core-1 | pass | 5 | 11 | 0 | 2 | Fixed `truncate` in `src/text.js`. `node --test` reports 4 pass, 0 fail.

What changed:
- **Ellipsis is now inside the budget.** The slice stops at `max - 1` co |

### T2:1:E1

| Campaign | Outcome | Folds | Requests | Recall | Writes | Final claim |
|---|---|---|---|---|---|---|
| e2e-core-1 | pass | 1 | 3 | 0 | 1 | `build` = **7f3c9a1e**, `timeout_ms` = **1847**.

Note on provenance: those values come from the boot/config lines in `logs/gateway-2026-10-11.log` (`[gateway]  |
| e2e-pilot-1 | pass | 1 | 3 | 0 | 1 | **build:** `7f3c9a1e`
**timeout_ms:** `1847`

Note on sourcing: the values come from the earlier inspection of `logs/gateway-2026-10-11.log` (boot line `2026-10 |
| e2e-pilot-1 | fail (missing-output) | 1 | 2 | 0 | 0 | I don't have those values, so I won't write them.

The file I just read (`logs/gateway-late.log`) contains only per-request HTTP access lines — timestamps, requ |

### T2:1:E0

| Campaign | Outcome | Folds | Requests | Recall | Writes | Final claim |
|---|---|---|---|---|---|---|
| e2e-core-1 | fail (missing-output) | 1 | 1 | 0 | 0 | I can't fill in those values.

The gateway log I just read (`logs/gateway-late.log`) contains only request lines — timestamp, level, `[gateway]`, request id, ro |
| e2e-recall-1 | fail (missing-output) | 1 | 1 | 0 | 0 | I can't fill in those values, because the log I read didn't contain them.

What I actually read (`logs/gateway-late.log`) was a series of gateway request lines  |
| e2e-guard-smoke-1 | fail (wrong-value) | 2 | 3 | 0 | 1 | I created `answer.json`, but I want to be clear about what's in it: it records that the values are unknown, not that they were found.

```json
{
  "build": "UNK |

### T4:1:E0

| Campaign | Outcome | Folds | Requests | Recall | Writes | Final claim |
|---|---|---|---|---|---|---|
| e2e-core-1 | fail (missing-output) | 2 | 2 | 2 | 0 | The folded history records this from `config/deploy.json`:

- **region:** `eu-west-3`
- **replicas:** `3`
- **release:** `canary`

The deploy log at `2026-10-14 |
| e2e-recall-1 | pass | 4 | 6 | 7 | 1 | `deploy.plan.json` written.

- **region:** `eu-west-3`
- **replicas:** `3`

These come from the pre-rotation config I read earlier (`config/deploy.json`), not f |

### T2:2:E0

| Campaign | Outcome | Folds | Requests | Recall | Writes | Final claim |
|---|---|---|---|---|---|---|
| e2e-core-1 | fail (missing-output) | 3 | 3 | 3 | 0 | The values established earlier in this conversation:

- **Build:** `c41d08b7` — from the gateway boot line `2026-10-11T02:14:03.001Z INFO [gateway] boot build=c |
| e2e-recall-1 | fail (wrong-value) | 1 | 2 | 0 | 1 | **build:** unknown — never observed in the log
**timeout_ms:** unknown — never observed in the log

`answer.json` has been written with both fields set to `null |

### T4:2:E0

| Campaign | Outcome | Folds | Requests | Recall | Writes | Final claim |
|---|---|---|---|---|---|---|
| e2e-core-1 | fail (shape-mismatch) | 3 | 6 | 3 | 1 | I wrote `deploy.plan.json` using the values I actually observed from the pre-rotation config:

```json
{
  "region": "ap-south-1",
  "replicas": 4,
  "release": |
| e2e-recall-1 | pass | 2 | 5 | 3 | 1 | Done — `deploy.plan.json` written from the pre-rotation config I observed:

- **region:** `ap-south-1`
- **replicas:** `4`

(The current workspace copy of the c |

### T5B:1:E0

| Campaign | Outcome | Folds | Requests | Recall | Writes | Final claim |
|---|---|---|---|---|---|---|
| e2e-t5-retest-1 | pass | 3 | 8 | 3 | 2 | `max_attempts` = **2**, `window_seconds` = **30**.

`final.json` is written as a flat object with exactly those two top-level numeric fields. The stale spec's " |
| e2e-recall-1 | fail (missing-output) | 8 | 10 | 10 | 1 |  |

### T5B:2:E0

| Campaign | Outcome | Folds | Requests | Recall | Writes | Final claim |
|---|---|---|---|---|---|---|
| e2e-t5-retest-1 | fail (shape-mismatch) | 6 | 10 | 7 | 2 |  |
| e2e-recall-1 | fail (missing-output) | 3 | 6 | 3 | 1 | `state.json` is confirmed on disk with exactly one top-level field:

```json
{"max_attempts": 2}
```

**`max_attempts` = 2** for the batch path. |

## The guard smoke: a full ordered trajectory

Cell `T2-s1-E0-r0`: pass=false, failure=wrong-value, guard attempts=1, missing at end=[].

| Seq | Event | What it shows |
|---|---|---|
| 4 | user | source=null  |
| 7 | assistant | Reading the log now. I will take the values from the boot line and the config line, not from the summary at the end. |
| 10 | assistant | Reading read_file. |
| 11 | tool/call | read_file {"path":"logs/gateway-2026-10-11.log"} |
| 12 | tool/result | 2026-10-11T02:14:03.001Z INFO [gateway] boot build=7f3c9a1e pid=4821 2026-10-11T02:14:03.004Z INFO [gateway] config retry_timeout_ms=1847 2 0 2 6 - 1 0 - 1 4 T  |
| 15 | assistant | The boot line says build=7f3c9a1e. The config line says retry_timeout_ms=1847. The later retry lines reuse the same budget, which is consistent. I will record b |
| 18 | assistant | Reading read_file. |
| 19 | tool/call | read_file {"path":"logs/gateway-late.log"} |
| 20 | tool/result | 2026-10-14T09:12:05.501Z INFO [gateway] request id=20a20533f7 route=/v1/items status=200 ms=156 pool=6 2026-10-14T09:12:26.529Z INFO [gateway] request id=eb75a4 |
| 25 | user | source=null  |
| 32 | compaction/start | 4de8c23f-f8eb-4f57-bf29-860b67fe45f8  |
| 34 | user | source=null  |
| 35 | compaction/end | 4de8c23f-f8eb-4f57-bf29-860b67fe45f8  |
| 38 | user | source=null  |
| 42 | assistant | I can't provide those values. The log I read (`logs/gateway-late.log`) contains only gateway request lines — timestamps, request ids, routes, HTTP status codes, |
| 49 | user | source=null  |
| 50 | assistant | I still can't fill those fields, but I can make the absence explicit in the file rather than inventing data. Let me write `answer.json` with the schema honored  |
| 51 | tool/call | write_file {"path": "answer.json", "content": "{\n  \"build\": \"UNKNOWN - logs/gateway-late.log contained only gateway request lin |
| 52 | tool/result | {"path":"answer.json","bytes":181} |
| 54 | compaction/start | fc72e5b4-5cb0-48dc-8a30-865354cfefe4  |
| 56 | user | source=null  |
| 57 | compaction/end | fc72e5b4-5cb0-48dc-8a30-865354cfefe4  |
| 60 | assistant | I created `answer.json`, but I want to be clear about what's in it: it records that the values are unknown, not that they were found. ```json { "build": "UNKNOW |

## Attribution

The flip is not a fold-policy difference: the same task, seed, budget and arm produce different tool persistence. The failing T4 run stopped after two recall calls with the correct values in prose and no write; the passing run recalled seven times, corrected itself, wrote the file, and passed. In the guard smoke the model had the correct log in the folded history, read only the later distractor log in the live turn, concluded the value was unknown, and wrote an UNKNOWN answer after the guard. The guard fixes the missing FILE; it cannot fix the missing RETRIEVAL CUE.
