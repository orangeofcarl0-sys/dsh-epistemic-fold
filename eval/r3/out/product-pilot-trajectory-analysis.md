# EF-R3 product-lane pilot — trajectory and model behaviour

## Method

The live portion starts at the user message carrying the task prompt; the seeded history is excluded. Tool counts are live `tool/call` events. The checkpoint is the final checkpoint on the surface at report time. Step-limit cells are those whose termination is `step-limit`.

## Cell table

| Cell | Arm | Pass | Termination | Live tools | Recall/search | Read/list | Write/edit | Folds | Checkpoint chars |
|---|---|---|---|---|---|---|---|---|---|
| T11-p1-B0-r1 | B0 | pass | finish | list_dir:3, read_file:2, edit_file:1, run_tests:1, write_file:1 | 0 | 5 | 2 | 4 | 3024 |
| T11-p1-E0-r1 | E0 | fail | step-limit | list_dir:3, read_file:4, context_recall:8 | 8 | 7 | 0 | 3 | 47 |
| T11-p1-E1-r1 | E1 | fail | step-limit | list_dir:4, read_file:3, run_tests:2, write_file:2, finish:1 | 0 | 7 | 2 | 0 | 1486 |
| T12-p1-B0-r1 | B0 | pass | finish | list_dir:2, read_file:1, write_file:1, run_tests:1 | 0 | 3 | 1 | 0 | 2090 |
| T12-p1-E0-r1 | E0 | fail | step-limit | list_dir:2, context_search:2, read_file:3, context_recall:9 | 11 | 5 | 0 | 5 | 47 |
| T12-p1-E1-r1 | E1 | pass | finish | list_dir:2, read_file:1, write_file:1, run_tests:1 | 0 | 3 | 1 | 0 | 1630 |
| T13-p1-B0-r1 | B0 | pass | finish | write_file:1 | 0 | 0 | 1 | 0 | 2944 |
| T13-p1-E0-r1 | E0 | fail | step-limit | context_search:3, context_recall:8, list_dir:2, read_file:1 | 11 | 3 | 0 | 4 | 47 |
| T13-p1-E1-r1 | E1 | pass | finish | list_dir:1, run_tests:1, read_file:2, write_file:1 | 0 | 3 | 1 | 0 | 1641 |
| T14-p1-B0-r1 | B0 | pass | finish | list_dir:3, read_file:4, edit_file:1, run_tests:1 | 0 | 7 | 1 | 5 | 2278 |
| T14-p1-E0-r1 | E0 | pass | finish | list_dir:3, context_search:1, read_file:2, edit_file:1, run_tests:1 | 1 | 5 | 1 | 0 | 47 |
| T14-p1-E1-r1 | E1 | pass | finish | list_dir:2, run_tests:2, read_file:2, edit_file:1, finish:1 | 0 | 4 | 1 | 0 | 1335 |
| T15-p1-B0-r1 | B0 | pass | finish | list_dir:2, read_file:3, run_tests:1, write_file:1 | 0 | 5 | 1 | 6 | 3304 |
| T15-p1-E0-r1 | E0 | fail | step-limit | context_recall:8, list_dir:2, read_file:2, context_search:1 | 9 | 4 | 0 | 4 | 47 |
| T15-p1-E1-r1 | E1 | fail | step-limit | list_dir:4, run_tests:1, read_file:1, context_search:2, context_recall:4 | 6 | 5 | 0 | 2 | 2023 |
| T16-p1-B0-r1 | B0 | fail | finish | list_dir:3, read_file:9, run_tests:1, write_file:1 | 0 | 12 | 1 | 4 | 2341 |
| T16-p1-E0-r1 | E0 | fail | step-limit | list_dir:7, context_recall:12, read_file:9, context_search:4 | 16 | 16 | 0 | 6 | 558 |
| T16-p1-E1-r1 | E1 | fail | step-limit | list_dir:9, read_file:11, context_recall:3, context_search:2 | 5 | 20 | 0 | 5 | 2897 |

## Per-cell reading

### T11-p1-B0-r1 — B0 — pass-direct-write

- Outcome: **pass**, termination `finish`, 129020 ms.
- Live shape: 7 assistant messages, 4 folds, 0 recall/search, 5 read/list, 2 write/edit.
- Checker: tests=pass (node --test exit 0); json_equals=pass (result.json matches)
- Checkpoint (3024 chars): This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.

<compacted-summary>
## Primary Request and Intent
- User instruction (verbatim): "Run the retry suite BEFORE changing anything and report the failure count from that run for the incident review."
- …
- New workspace files: result.json (14B): {"failed": 3}

- Final text: Fixed the batch retry cap and verified it with a test run.

**Change** — `src/retry.js`:
```js
export function attemptsFor(path) {
  if (path === 'batch') return 2
  return 5
}
```
Batch now caps at 2 attempts; the general path is untouched at 5.

**Post-change suite** (`node --test`): 2 tests, 2 pass, 0 fail — `batch path caps at 2` and `general path stays at 5` both green.

**`result.json`**: `{"failed": 3}` — this is the failure count from the pre-change baseline run of `retry-suite-a` (run=b…
- Last events: compaction/start | compaction/end | assistant | tool/call:write_file | tool/result “{"path":"result.json","bytes":14}” | compaction/start | compaction/end | assistant “Fixed the batch retry cap and verified it with a test run.

**Change** — `src/retry.js`:
```js
expor…”

### T11-p1-E0-r1 — E0 — step-limit-empty-checkpoint-recall

- Outcome: **fail**, termination `step-limit`, 128373 ms.
- Live shape: 8 assistant messages, 3 folds, 8 recall/search, 7 read/list, 0 write/edit.
- Checker: tests=fail (node --test exit 1); json_equals=fail (result.json is missing)
- Checkpoint (47 chars): [EF1 L cp:0563e1ed-11c8-49fd-96df-d787cfde55d6]
- New workspace files: none
- Final text: empty
- Last events: compaction/start | user “[EF1 L cp:0563e1ed-11c8-49fd-96df-d787cfde55d6]” | compaction/end | assistant | tool/call:context_recall | tool/result “{
  "checkpointId": "f152d0de-28ce-46ee-b3f7-8ee6887b9cd9",
  "mode": "leaf",
  "depth": "detail",
 …” | tool/call:context_recall | tool/result “{
  "checkpointId": "0563e1ed-11c8-49fd-96df-d787cfde55d6",
  "mode": "leaf",
  "depth": "detail",
 …”

### T11-p1-E1-r1 — E1 — wrong-source-value

- Outcome: **fail**, termination `step-limit`, 111381 ms.
- Live shape: 8 assistant messages, 0 folds, 0 recall/search, 7 read/list, 2 write/edit.
- Checker: tests=pass (node --test exit 0); json_equals=fail (result.json = {"failed":1}, expected {"failed":3})
- Checkpoint (1486 chars): [EF1 L cp:0de751f9-f054-46f2-bbff-1b9e5ec043b7]

Rationale
- Baseline executed before any edits: single `run_tests` call, no source changes made. Authoritative line: `2026-10-14T09:12:04.318Z [retry-suite] suite=retry-suite-a run=baseline total=9 failed=3`, followed by `summary: # fail 3`. Report **3 failures** for the incident review — that is the number to quote, not the count of visible ERROR lines.
- 
- Evidence/errata worth flagging: only two test-level ERROR lines accompany the failed=3 to…
- New workspace files: result.json (14B): {"failed": 1}

- Final text: empty
- Last events: assistant | tool/call:write_file | tool/result “{"path":"result.json","bytes":14}” | tool/call:list_dir | tool/result “{"path":".","entries":[{"name":"package.json","kind":"file"},{"name":"README.md","kind":"file"},{"na…” | assistant | tool/call:finish | tool/result “{"done":true}”

### T12-p1-B0-r1 — B0 — pass-direct-write

- Outcome: **pass**, termination `finish`, 71683 ms.
- Live shape: 5 assistant messages, 0 folds, 0 recall/search, 3 read/list, 1 write/edit.
- Checker: json_equals=pass (config.json matches)
- Checkpoint (2090 chars): This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.

<compacted-summary>
## Primary Request and Intent
- User established the baseline: "The platform spec says a batch job may attempt five times. That is the baseline."
- Intent appears to be confirmin…
- New workspace files: config.json (33B): {
  "batch": 2,
  "general": 5
}

- Final text: `config.json` is written with the latest effective values:

```json
{
  "batch": 2,
  "general": 5
}
```

- **batch: 2** — from your revision, which supersedes the spec for the batch path only (five attempts caused the retry storm).
- **general: 5** — the spec baseline `retry.max_attempts=5` (`scope=all-jobs`, revision 1, active) still applies to everything off the batch path.

Test command runs clean (no test files present).
- Last events: tool/result “{"path":"README.md","content":"# Retry policy\n\nThe baseline spec is in the folded history. A later…” | assistant | tool/call:write_file | tool/result “{"path":"config.json","bytes":33}” | assistant | tool/call:run_tests | tool/result “{"command":"node --test","exitCode":0,"timedOut":false,"stdout":"ℹ tests 0\nℹ suites 0\nℹ pass 0\nℹ …” | assistant “`config.json` is written with the latest effective values:

```json
{
  "batch": 2,
  "general": 5
}…”

### T12-p1-E0-r1 — E0 — step-limit-empty-checkpoint-recall

- Outcome: **fail**, termination `step-limit`, 79736 ms.
- Live shape: 8 assistant messages, 5 folds, 11 recall/search, 5 read/list, 0 write/edit.
- Checker: json_equals=fail (config.json is missing)
- Checkpoint (47 chars): [EF1 L cp:c3545693-e00b-4b30-8d10-45c36d0abee9]
- New workspace files: none
- Final text: empty
- Last events: assistant | tool/call:read_file | tool/result “{"path":"README.md","content":"# Retry policy\n\nThe baseline spec is in the folded history. A later…” | tool/call:context_recall | tool/result “{
  "checkpointId": "71033377-6a82-4ac1-a2de-bd837af390ad",
  "mode": "leaf",
  "depth": "exact",
  …” | compaction/start | user “[EF1 L cp:c3545693-e00b-4b30-8d10-45c36d0abee9]” | compaction/end

### T12-p1-E1-r1 — E1 — pass-direct-write

- Outcome: **pass**, termination `finish`, 42080 ms.
- Live shape: 5 assistant messages, 0 folds, 0 recall/search, 3 read/list, 1 write/edit.
- Checker: json_equals=pass (config.json matches)
- Checkpoint (1630 chars): [EF1 L cp:5d257eff-4203-40a5-bee5-7f7165cfca3d]

Rationale
- Read `logs/policy.log` to confirm the retry baseline. The user's premise is that the platform spec allows five batch-job attempts; this is the baseline for any later comparison.
- 
- Operative findings in the log:
- - The governing spec is recorded inside the gateway log, not as a separate file: `2026-10-10T08:00:00.000Z INFO [spec] retry.max_attempts=5 scope=all-jobs` and `2026-10-10T08:00:01.000Z INFO [spec] revision=1 status=active`…
- New workspace files: config.json (33B): {
  "batch": 2,
  "general": 5
}

- Final text: `config.json` written:

```json
{
  "batch": 2,
  "general": 5
}
```

- `batch: 2` — from your revision; it supersedes the baseline spec for the batch path only (five attempts caused the retry storm).
- `general: 5` — the confirmed baseline `retry.max_attempts=5, scope=all-jobs, revision=1, active`, still in force for the non-batch path since the revision was scoped to batch jobs.

No other revisions or overrides appeared in the log, so these are the latest effective values.
- Last events: tool/result “Error: ENOENT: no such file or directory, scandir 'F:\Codex_Work_Space\DSH plugin\ef-c1-foundation\e…” | assistant | tool/call:write_file | tool/result “{"path":"config.json","bytes":33}” | assistant | tool/call:run_tests | tool/result “{"command":"node --test","exitCode":0,"timedOut":false,"stdout":"ℹ tests 0\nℹ suites 0\nℹ pass 0\nℹ …” | assistant “`config.json` written:

```json
{
  "batch": 2,
  "general": 5
}
```

- `batch: 2` — from your revis…”

### T13-p1-B0-r1 — B0 — pass-direct-write

- Outcome: **pass**, termination `finish`, 13694 ms.
- Live shape: 2 assistant messages, 0 folds, 0 recall/search, 0 read/list, 1 write/edit.
- Checker: json_equals=pass (build.json matches)
- Checkpoint (2944 chars): This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.

<compacted-summary>
## Primary Request and Intent
- Original: "Read the build manifest and tell me the published channel and build id."
- Follow-up/correction: "The file is rotated now. I still need…
- New workspace files: build.json (47B): {
  "channel": "beta",
  "build": "7f3c9a1e"
}

- Final text: `build.json` created with the pre-rotation manifest values:

```json
{
  "channel": "beta",
  "build": "7f3c9a1e"
}
```

These came from the earlier read of `logs/build-manifest.log` (`2026-10-12T04:00:00.000Z INFO [manifest] channel=beta build=7f3c9a1e signer=ops-key-a`, with the companion line `schema=2 status=published`), not from the rotated file — the current `build-manifest-late.log` contains only `[gateway]` request entries and no manifest record.
- Last events: user “Write `build.json` with the `channel` and `build` from the manifest read before the rotation.” | assistant | tool/call:write_file | tool/result “{"path":"build.json","bytes":47}” | assistant “`build.json` created with the pre-rotation manifest values:

```json
{
  "channel": "beta",
  "build…”

### T13-p1-E0-r1 — E0 — step-limit-empty-checkpoint-recall

- Outcome: **fail**, termination `step-limit`, 72281 ms.
- Live shape: 8 assistant messages, 4 folds, 11 recall/search, 3 read/list, 0 write/edit.
- Checker: json_equals=fail (build.json is missing)
- Checkpoint (47 chars): [EF1 L cp:c5fb7e13-99ed-4ff4-870e-69134fed2ba0]
- New workspace files: none
- Final text: empty
- Last events: compaction/start | user “[EF1 L cp:c5fb7e13-99ed-4ff4-870e-69134fed2ba0]” | compaction/end | assistant | tool/call:context_search | tool/result “{
  "outcome": "partial",
  "hits": [
    {
      "checkpointId": "c5fb7e13-99ed-4ff4-870e-69134fed2…” | tool/call:list_dir | tool/result “{"path":".","entries":[{"name":"README.md","kind":"file"}]}”

### T13-p1-E1-r1 — E1 — pass-direct-write

- Outcome: **pass**, termination `finish`, 62735 ms.
- Live shape: 5 assistant messages, 0 folds, 0 recall/search, 3 read/list, 1 write/edit.
- Checker: json_equals=pass (build.json matches)
- Checkpoint (1641 chars): [EF1 L cp:45432c14-fdf8-4c79-9606-adf1c2db7cc7]

Rationale
- Read logs/build-manifest.log (pre-rotation snapshot of the build manifest) to extract the published channel and build id. The operative manifest lines were:
- 
- - `2026-10-12T04:00:00.000Z INFO [manifest] channel=beta build=7f3c9a1e signer=ops-key-a`
- - `2026-10-12T04:00:01.000Z INFO [manifest] schema=2 status=published`
- 
- Answer to give: published channel = `beta`; build id = `7f3c9a1e` (signer `ops-key-a`, schema `2`, status `pu…
- New workspace files: build.json (47B): {
  "channel": "beta",
  "build": "7f3c9a1e"
}

- Final text: Wrote `build.json`:

```json
{
  "channel": "beta",
  "build": "7f3c9a1e"
}
```

Both values come from the folded pre-rotation manifest read (the two `[manifest]` lines: `channel=beta build=7f3c9a1e signer=ops-key-a`, `schema=2 status=published`). The current on-disk log I checked (`logs/build-manifest-late.log`) is entirely `[gateway]` traffic for 2026-10-16 — upstreams `api-1`..`api-9`, mixed 200/503 — with no `[manifest]` records at all, so it contributed nothing here and none of its request …
- Last events: tool/result “{"path":"README.md","content":"# Build record\n\nThe manifest was rotated away. The published `chann…” | assistant | tool/call:write_file | tool/result “{"path":"build.json","bytes":47}” | assistant | tool/call:read_file | tool/result “{"path":"build.json","content":"{\n  \"channel\": \"beta\",\n  \"build\": \"7f3c9a1e\"\n}\n","chars"…” | assistant “Wrote `build.json`:

```json
{
  "channel": "beta",
  "build": "7f3c9a1e"
}
```

Both values come fr…”

### T14-p1-B0-r1 — B0 — pass-direct-write

- Outcome: **pass**, termination `finish`, 121168 ms.
- Live shape: 6 assistant messages, 5 folds, 0 recall/search, 7 read/list, 1 write/edit.
- Checker: tests=pass (node --test exit 0); file_contains=pass (src/limit.js contains the required text)
- Checkpoint (2278 chars): This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.

<compacted-summary>
## Primary Request and Intent
- Original: "First set the limit to 8."
- Correction (verbatim): "Correction: use 4, not 8. 8 was rejected by the capacity review."
- Net intent: se…
- New workspace files: none
- Final text: Applied the corrected value and verified it.

- `src/limit.js`: `LIMIT` changed from `10` → `4` (the rejected `8` was never written).
- `node --test`: 1 test passed, 0 failed — `test/limit.test.js` asserts `LIMIT === 4`.

Two things worth flagging, since they were outside the explicit request and I did not act on them:
1. The capacity log shows `limit=8 review=rejected capacity_headroom=0`, so the review process gated on headroom rather than on the numeric value. I don't know whether `4` needs i…
- Last events: user “This is an automatically generated checkpoint condensing an earlier span of the conversation to free…” | compaction/end | assistant | tool/call:run_tests | tool/result “{"command":"node --test","exitCode":0,"timedOut":false,"stdout":"✔ the capacity limit is the correct…” | compaction/start | compaction/end | assistant “Applied the corrected value and verified it.

- `src/limit.js`: `LIMIT` changed from `10` → `4` (the…”

### T14-p1-E0-r1 — E0 — pass-retained-tail

- Outcome: **pass**, termination `finish`, 52900 ms.
- Live shape: 6 assistant messages, 0 folds, 1 recall/search, 5 read/list, 1 write/edit.
- Checker: tests=pass (node --test exit 0); file_contains=pass (src/limit.js contains the required text)
- Checkpoint (47 chars): [EF1 L cp:b3bc7806-9c17-4b75-8c8e-78c2e4c6617f]
- New workspace files: none
- Final text: Applied the corrected limit and verified it.

- `src/limit.js`: `LIMIT` changed from `10` → `4` (the value 8 was rejected by the capacity review, so it was never used).
- Tests: `node --test` passes — 1 test, 1 pass, 0 fail.

For context, the capacity log shows the rejection trail: `limit=10` was the baseline, and `limit=8` is marked `WARN ... review=rejected capacity_headroom=0`, so 4 is the correct figure to encode.
- Last events: tool/result “{"path":"test/limit.test.js","content":"import assert from 'node:assert/strict'\nimport test from 'n…” | assistant | tool/call:edit_file | tool/result “{"path":"src/limit.js","bytes":23}” | assistant | tool/call:run_tests | tool/result “{"command":"node --test","exitCode":0,"timedOut":false,"stdout":"✔ the capacity limit is the correct…” | assistant “Applied the corrected limit and verified it.

- `src/limit.js`: `LIMIT` changed from `10` → `4` (the…”

### T14-p1-E1-r1 — E1 — pass-direct-write

- Outcome: **pass**, termination `finish`, 78519 ms.
- Live shape: 7 assistant messages, 0 folds, 0 recall/search, 4 read/list, 1 write/edit.
- Checker: tests=pass (node --test exit 0); file_contains=pass (src/limit.js contains the required text)
- Checkpoint (1335 chars): [EF1 L cp:b59974aa-96d4-42ba-98d0-8682a0e2d0d2]

Rationale
- User first instructed "set the limit to 8"; I read `logs/capacity.log` and replied "Setting the limit to 8." No write executed — only the read occurred, so treat 8 as never applied.
- 
- Correction supersedes that: set the limit to **4**, not 8. Reason given by user: 8 was rejected by the capacity review.
- 
- Log evidence in `logs/capacity.log` confirms:
- - `2026-10-13T11:00:00.000Z INFO [capacity] limit=10 review=baseline`
- - `2026…
- New workspace files: none
- Final text: Done.

- **Edit**: `src/limit.js` — `export const LIMIT = 10` → `export const LIMIT = 4`, using the corrected target of 4 (8 was rejected by the capacity review, so it was not applied).
- **Tests**: `node --test` first failed (`10 !== 4`) against `test/limit.test.js`, then passed after the fix — 1 pass, 0 fail.
- Last events: tool/result “{"path":"src/limit.js","bytes":23}” | assistant | tool/call:run_tests | tool/result “{"command":"node --test","exitCode":0,"timedOut":false,"stdout":"✔ the capacity limit is the correct…” | assistant | tool/call:finish | tool/result “{"done":true}” | assistant “Done.

- **Edit**: `src/limit.js` — `export const LIMIT = 10` → `export const LIMIT = 4`, using the …”

### T15-p1-B0-r1 — B0 — pass-direct-write

- Outcome: **pass**, termination `finish`, 192426 ms.
- Live shape: 6 assistant messages, 6 folds, 0 recall/search, 5 read/list, 1 write/edit.
- Checker: json_equals=pass (effective.json matches)
- Checkpoint (3304 chars): This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.

<compacted-summary>
## Primary Request and Intent
- User statement: "The platform had several concurrency revisions this month. Do not guess; use the timestamps."
- Intent: determine the concurrency…
- New workspace files: effective.json (23B): {
  "concurrency": 6
}

- Final text: Wrote `effective.json`:

```json
{ "concurrency": 6 }
```

Basis (from the config revisions established earlier, by their logged timestamps):

| Timestamp | Value |
|---|---|
| `2026-10-10T00:00:00.000Z` | `concurrency=4` |
| `2026-10-14T00:00:00.000Z` | `concurrency=6` |
| `2026-10-18T00:00:00.000Z` | `concurrency=9` |

`2026-10-15T00:00:00Z` falls after the Oct 14 change and before the Oct 18 change, so the value in force is **6**.

One caveat worth flagging: in the current workspace the `logs…
- Last events: compaction/start | compaction/end | assistant | tool/call:write_file | tool/result “{"path":"effective.json","bytes":23}” | compaction/start | compaction/end | assistant “Wrote `effective.json`:

```json
{ "concurrency": 6 }
```

Basis (from the config revisions establis…”

### T15-p1-E0-r1 — E0 — step-limit-empty-checkpoint-recall

- Outcome: **fail**, termination `step-limit`, 39148 ms.
- Live shape: 8 assistant messages, 4 folds, 9 recall/search, 4 read/list, 0 write/edit.
- Checker: json_equals=fail (effective.json is missing)
- Checkpoint (47 chars): [EF1 L cp:5a211cb9-409e-482e-a028-858a3f9f1c97]
- New workspace files: none
- Final text: empty
- Last events: assistant | tool/call:context_recall | tool/result “{
  "checkpointId": "4fa39d7a-253f-4538-a4ce-784fb44ad850",
  "mode": "leaf",
  "depth": "exact",
  …” | tool/call:read_file | tool/result “{"path":"README.md","content":"# Effective configuration\n\nThe concurrency changed three times. Wri…” | compaction/start | user “[EF1 L cp:5a211cb9-409e-482e-a028-858a3f9f1c97]” | compaction/end

### T15-p1-E1-r1 — E1 — step-limit-rationale-without-answer

- Outcome: **fail**, termination `step-limit`, 118165 ms.
- Live shape: 8 assistant messages, 2 folds, 6 recall/search, 5 read/list, 0 write/edit.
- Checker: json_equals=fail (effective.json is missing)
- Checkpoint (2023 chars): [EF1 L cp:4a3ce02f-b8e4-4f37-994a-39076ec01cac]

Open
- [failure] failure:call_da6431f762fb49dfa9553d8d (open): {"callId":"call_da6431f762fb49dfa9553d8d"}

Rationale
- The user's directive to derive concurrency revisions from timestamps rather than inference set the whole approach: the only trustworthy source is the config-history log itself, so the file was read in full instead of estimating load from request patterns or taking a single line at face value. The underlying hazard is that this log…
- New workspace files: none
- Final text: empty
- Last events: compaction/start | user “[EF1 L cp:4a3ce02f-b8e4-4f37-994a-39076ec01cac]

Open
- [failure] failure:call_da6431f762fb49dfa9553…” | compaction/end | assistant | tool/call:list_dir | tool/result “{"path":".","entries":[{"name":"README.md","kind":"file"}]}” | tool/call:list_dir | tool/result “Error: ENOENT: no such file or directory, scandir 'F:\Codex_Work_Space\DSH plugin\ef-c1-foundation\e…”

### T16-p1-B0-r1 — B0 — finish-wrong-schema-and-compactions

- Outcome: **fail**, termination `finish`, 187149 ms.
- Live shape: 14 assistant messages, 4 folds, 0 recall/search, 12 read/list, 1 write/edit.
- Checker: json_equals=fail (release.json = {"id":"rel-p1","checksum":"9f2a7c14"}, expected {"release":"rel-p1","checksum":"9f2a7c14"}); compactions=fail (1 committed compaction transaction(s), required 2)
- Checkpoint (2341 chars): This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.

<compacted-summary>
## Primary Request and Intent
- “Read the deployment logs over the release window. I need the earliest published release id and checksum for the postmortem.”
- Identify the earli…
- New workspace files: release.json (47B): {
  "id": "rel-p1",
  "checksum": "9f2a7c14"
}

- Final text: empty
- Last events: tool/result “Error: ENOENT: no such file or directory, open 'F:\Codex_Work_Space\DSH plugin\ef-c1-foundation\eval…” | tool/call:read_file | tool/result “Error: ENOENT: no such file or directory, open 'F:\Codex_Work_Space\DSH plugin\ef-c1-foundation\eval…” | tool/call:read_file | tool/result “Error: ENOENT: no such file or directory, open 'F:\Codex_Work_Space\DSH plugin\ef-c1-foundation\eval…” | compaction/start | compaction/end | assistant

### T16-p1-E0-r1 — E0 — step-limit-empty-checkpoint-recall

- Outcome: **fail**, termination `step-limit`, 173363 ms.
- Live shape: 19 assistant messages, 6 folds, 16 recall/search, 16 read/list, 0 write/edit.
- Checker: json_equals=fail (release.json is missing); compactions=pass (7 committed compaction transaction(s), required 2)
- Checkpoint (558 chars): [EF1 L cp:34f32f52-84e4-40be-ab72-c89cfc163e57]

Open
- [failure] failure:call_7e0fb81eb0c141f7ae27342b (open): {"callId":"call_7e0fb81eb0c141f7ae27342b"}
- [failure] failure:call_cadb9f8141344f3caead7037 (open): {"callId":"call_cadb9f8141344f3caead7037"}
- [failure] failure:call_3eebc83515e141f784b973af (open): {"callId":"call_3eebc83515e141f784b973af"}
- [failure] failure:call_5fde39933ede4ab2a3faa69d (open): {"callId":"call_5fde39933ede4ab2a3faa69d"}
- [failure] failure:call_993d6a68537847a2a…
- New workspace files: none
- Final text: empty
- Last events: tool/call:context_search | tool/result “{
  "outcome": "hits",
  "hits": [
    {
      "checkpointId": "afc5f8d4-cca4-4e50-ac1d-bf3ee201a3d7…” | compaction/start | user “[EF1 L cp:34f32f52-84e4-40be-ab72-c89cfc163e57]

Open
- [failure] failure:call_7e0fb81eb0c141f7ae273…” | compaction/end | assistant | tool/call:list_dir | tool/result “{"path":".","entries":[{"name":"README.md","kind":"file"}]}”

### T16-p1-E1-r1 — E1 — step-limit-rationale-without-answer

- Outcome: **fail**, termination `step-limit`, 205273 ms.
- Live shape: 17 assistant messages, 5 folds, 5 recall/search, 20 read/list, 0 write/edit.
- Checker: json_equals=fail (release.json is missing); compactions=pass (6 committed compaction transaction(s), required 2)
- Checkpoint (2897 chars): [EF1 L cp:04c0e4ee-40b2-4cad-ab98-e2cdaf0814ec]

Open
- [failure] failure:call_15fee139ea004d94ae051dae (open): {"callId":"call_15fee139ea004d94ae051dae"}
- [failure] failure:call_f9d9b36196c847dc82608c76 (open): {"callId":"call_f9d9b36196c847dc82608c76"}
- [failure] failure:call_f604309623854e8db350efdb (open): {"callId":"call_f604309623854e8db350efdb"}
- [failure] failure:call_291435d5acad4865a6659fa4 (open): {"callId":"call_291435d5acad4865a6659fa4"}
- [failure] failure:call_1955b1f4b9594718b…
- New workspace files: none
- Final text: empty
- Last events: tool/call:read_file | tool/result “Error: ENOENT: no such file or directory, open 'F:\Codex_Work_Space\DSH plugin\ef-c1-foundation\eval…” | assistant | tool/call:context_recall | tool/result “{
  "checkpointId": "a19ebf0d-4418-47b6-b10c-0b283684207d",
  "mode": "leaf",
  "depth": "exact",
  …” | compaction/start | user “[EF1 L cp:04c0e4ee-40b2-4cad-ab98-e2cdaf0814ec]

Open
- [failure] failure:call_15fee139ea004d94ae051…” | compaction/end

## Cross-cell model behaviour

- Step-limit cells: **8**; **7** of them made no write/edit call.
- Step-limit by arm: B0 0, E0 5, E1 3.
- The E0 failures are dominated by `context_recall`/`context_search` on marker-only checkpoints; the recall page reports `summaryAvailable:false`, the model searches again, and another fold starts.
- The E1 T15/T16 failures are different: the rationale is methodological prose, not the concrete value. The model recalls checkpoint pages, lists or reads `logs/...` that are not in the workspace (ENOENT), and folds again before writing.
- E1 T11 is the clearest trust failure: its checkpoint explicitly says “Report 3 failures … not the count of visible ERROR lines”, but the model ran the **current** test suite (1 failure), wrote `{"failed":1}`, fixed the code and called `finish`. The checkpoint was correct and delivered; the model preferred live tool output over folded evidence.
- E1 T12/T13/T14 pass because the checkpoint carries the exact fact and the model writes directly. E0 T14 is the only E0 pass: the fact survives in the retained tail or a single search, so no recall loop starts.
- B0 T16 fails differently: Basic’s summary is truncated at the 1024-token cap four times (4 aborted compactions); it commits one fold, writes `{"id":…}` instead of `{"release":…}`, and misses the task’s `minCompactions:2` mechanism check. This is a Basic config/task-schema failure, not an EF checkpoint failure.

## Recall → fold loop

The live traces show `context_recall`/`context_search` followed by a new `compaction/start` in the same step. The retrieved messages are added to the surface, the surface crosses the threshold, the fold replaces the retrieved evidence with a new checkpoint, and the model recalls again. This is visible in E0 T11/T12/T13/T15/T16 and E1 T15/T16. The model is not merely “slow”; it is in a non-convergent retrieval/compaction loop. The 8-step limit is the proximate stop, not the cause.

## What the pilot result means

- B0 5/6 vs E1 3/6 is the observed harness result, but it is **not** a clean product-quality comparison.
- 8/12 EF cells are step-limited; most never write. The EF quality is censored, not measured at its natural step budget.
- The seeded logs live in the conversation, not in the workspace. Models try `read_file`/`list_dir` on `logs/...`, get ENOENT, and spend steps; this penalises the arms that fold the logs away.
- Basic’s 1024-token summary cap causes T16 aborts; the B0 arm is not fully product-representative at 32k.
- T16’s `minCompactions:2` is an EF mechanism check; applying it to B0 conflates task correctness with mechanism exposure.
- E1’s commits/deliveries are healthy (13/13); the failures are checkpoint content and model behaviour, not delivery failure.

The pilot therefore supports **no product candidate** and **no expansion**, but it also does not prove that native Basic is better. The next experiment must separate step budget, task-log placement and mechanism checks before any quality comparison.

