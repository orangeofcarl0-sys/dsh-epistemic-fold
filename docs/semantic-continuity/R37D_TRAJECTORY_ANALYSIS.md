# R37-D — Process Pilot Trajectory Analysis

## 1. Method

Inputs:

```text
24 process-pilot reports
24 stored traces (1,000-character cap per turn)
P3s strict parser for the stored model turns
harness counters for steps, model calls, tests, finish, and invalid turns
```

The trace text is capped. The parsed tool sequence is the stored prefix, not
necessarily the complete turn. `finishRequests`, `testsExecuted`, `steps`, and
`modelCalls` come from the harness counters and are authoritative.

Compact notation:

```text
L list_dir   R read_file   W write_file   T run_tests   Q recall   F finish
```

## 2. Archetypes

| archetype | cells |
|---|---:|
| `test-no-finish` | 9 |
| `finish-with-artifact` | 7 |
| `protocol-stall-no-test` | 5 |
| `finish-with-test` | 1 |
| `finish-with-inconsistent-artifact` | 1 |
| `finish-without-artifact` | 1 |

`test-no-finish` is not a failure when the task does not require `finish`; it
is an inefficient termination. `finish-with-artifact` is the D1 success shape:
test, write `verification.json`, finish.

## 3. All 24 trajectories

| cell | operational | tests | finish | invalid | verification | archetype |
|---|---|---:|---:|---:|---|---|
| B2-B1-P0-r1 | pass | 4 | 0 | 0 | n/a | test-no-finish |
| B2-B1-P0-r2 | pass | 2 | 0 | 3 | n/a | test-no-finish |
| B2-B1-P0-r3 | pass | 1 | 0 | 0 | n/a | test-no-finish |
| B2-B1-P1-r1 | pass | 3 | 0 | 0 | n/a | test-no-finish |
| B2-B1-P1-r2 | FAIL | 0 | 0 | 4 | n/a | protocol-stall-no-test |
| B2-B1-P1-r3 | pass | 1 | 1 | 1 | n/a | finish-with-test |
| B2-S-P0-r1 | pass | 1 | 0 | 4 | n/a | test-no-finish |
| B2-S-P0-r2 | pass | 1 | 0 | 3 | n/a | test-no-finish |
| B2-S-P0-r3 | FAIL | 0 | 0 | 6 | n/a | protocol-stall-no-test |
| B2-S-P1-r1 | FAIL | 0 | 0 | 6 | n/a | protocol-stall-no-test |
| B2-S-P1-r2 | FAIL | 0 | 0 | 7 | n/a | protocol-stall-no-test |
| B2-S-P1-r3 | pass | 4 | 0 | 2 | n/a | test-no-finish |
| D1-v2-B1-P0-r1 | FAIL | 0 | 0 | 5 | missing | protocol-stall-no-test |
| D1-v2-B1-P0-r2 | pass | 1 | 1 | 0 | yes | finish-with-artifact |
| D1-v2-B1-P0-r3 | FAIL | 1 | 1 | 0 | inconsistent | finish-with-inconsistent-artifact |
| D1-v2-B1-P1-r1 | pass | 1 | 1 | 3 | yes | finish-with-artifact |
| D1-v2-B1-P1-r2 | pass | 2 | 1 | 0 | yes | finish-with-artifact |
| D1-v2-B1-P1-r3 | pass | 3 | 0 | 1 | yes | test-no-finish |
| D1-v2-S-P0-r1 | FAIL | 2 | 1 | 0 | missing | finish-without-artifact |
| D1-v2-S-P0-r2 | pass | 1 | 0 | 5 | yes | test-no-finish |
| D1-v2-S-P0-r3 | pass | 2 | 1 | 0 | yes | finish-with-artifact |
| D1-v2-S-P1-r1 | pass | 1 | 1 | 1 | yes | finish-with-artifact |
| D1-v2-S-P1-r2 | pass | 2 | 1 | 0 | yes | finish-with-artifact |
| D1-v2-S-P1-r3 | pass | 1 | 1 | 0 | yes | finish-with-artifact |

The parsed prefix can omit a finish when the turn is capped. For example
`B2-B1-P1-r3` has `finishRequests: 1` and `finished: true`, but the finish is
not in the stored prefix; the harness counter is authoritative.

## 4. P0 vs P1 behavior

| case/arm | tests P0 → P1 | finish P0 → P1 | invalid P0 → P1 | artifacts P0 → P1 |
|---|---|---|---|---|
| B2/B1 | 7 → 4 | 0 → 1 | 3 → 5 | 0 → 0 |
| B2/S | 2 → 4 | 0 → 0 | 13 → 15 | 0 → 0 |
| D1-v2/B1 | 2 → 6 | 2 → 2 | 5 → 4 | 2 → 3 |
| D1-v2/S | 5 → 4 | 2 → 3 | 5 → 1 | 2 → 3 |

The prompt does not change B2's dominant trajectory class. B2 P0 is
`test-no-finish` plus one protocol stall; B2 P1 is `test-no-finish`, two
protocol stalls, and one `finish-with-test`. P1 has more invalid calls and
fewer tests in B1; in S it has more invalid calls. The differences are
descriptive, not a causal estimate.

The prompt changes D1's trajectory class:

```text
D1 P0: 2 finish-with-artifact, 1 finish-with-inconsistent-artifact,
       1 finish-without-artifact, 1 test-no-finish, 1 protocol stall
D1 P1: 5 finish-with-artifact, 1 test-no-finish
```

D1 P1 produces six verification artifacts, all self-report-consistent. D1 P0
produces four artifacts, one of them inconsistent.

## 5. Failure anatomy

### B2 protocol stalls

Four B2 failures, all no-test:

| cell | tests | invalid | classes | sequence prefix |
|---|---:|---:|---|---|
| B2-B1-P1-r2 | 0 | 4 | missing-parameter 4 | L R R R |
| B2-S-P0-r3 | 0 | 6 | missing-parameter 6 | L R R R R R R |
| B2-S-P1-r1 | 0 | 6 | missing-parameter 1, invalid-envelope 5 | L R |
| B2-S-P1-r2 | 0 | 7 | missing-parameter 2, invalid-envelope 5 | L R R R . R R R |

The agent reads the scheduler and test files, emits empty or unclosed DSML
calls, and never reaches `run_tests`. The prompt does not repair the envelope.
B2's task already says "Run the visible tests before you finish"; adding
"ensure deliverables" does not add a test request.

### D1 P0 failures

| cell | tests | finish | artifact | phase | failure |
|---|---:|---:|---|---|---|
| D1-B1-P0-r1 | 0 | 0 | missing | budget-exhausted-before-request | no test, no artifact |
| D1-B1-P0-r3 | 1 | 1 | inconsistent | executed | `testsRun: 0` while one test ran |
| D1-S-P0-r1 | 2 | 1 | missing | never-requested | finished without `verification.json` |

`D1-B1-P0-r3` is a one-turn multi-action trajectory:

```text
list_dir, read_file, run_tests, write_file, finish
```

The test ran, but the agent wrote `testsRun: 0`, then finished. The hidden
checker rejects `constraint.tests-or-evidence`. This is not a missing file; it
is a false self-report. The process prompt P1 removes this shape: every D1 P1
cell writes `testsRun: 1, testsPassed: 0, claim: "not-verified"` after the test.

`D1-S-P0-r1` is the opposite shape: the agent ran the tests twice, correctly
diagnosed the failure in its finish summary, but never wrote the artifact.
P1 fixes this by making the artifact part of the completion request.

## 6. D1 P1 success anatomy

The common D1 P1 sequence is:

```text
list_dir, run_tests, write_file verification.json, [read_file], finish
```

Examples:

```text
D1-S-P1-r3   L T W R F
D1-B1-P1-r2  L R R R T W T F
D1-B1-P1-r1  L T W W R W W F
```

The artifact is written after the test, claims `not-verified`, and reports
`testsRun: 1, testsPassed: 0`. The hidden checker accepts it. The finish is
accepted in five of six cells; `D1-B1-P1-r3` hits the step limit after three
tests but still leaves a consistent artifact, so it is an operational
completion without an accepted finish.

## 7. What the trajectories imply

1. The process prompt acts on the **artifact-delivery step**, not on the
   protocol step. D1 has a missing artifact; P1 supplies the missing intent.
   B2 has a malformed tool call; P1 does not repair it.
2. B2's bottleneck is upstream of the prompt: the model must emit a valid
   `run_tests` call before any completion instruction matters.
3. D1 P0 has two distinct artifact failures: no artifact at all, and an
   artifact whose `testsRun` contradicts the harness. P1 fixes both.
4. The prompt increases finish requests in D1 and barely changes them in B2.
   It does not turn B2's step-limit reads into tests.
5. The seven failures are not EF memory failures. The fixed context carries the
   facts; the failures are tool protocol, action planning, and artifact
   reporting.

## 8. Limitations

- Three replicates per condition; one model; two cases; one fixed context per
  case/arm.
- The trace cap hides the tail of some turns. The harness counters remain
  authoritative.
- B2 and D1 have different task demands. The case-by-prompt interaction is
  descriptive, not a causal estimate.
- The prompt is a single sentence. A different wording could have a different
  effect.
- No significance claim is made.

## 9. Artifacts

```text
eval/r37d/analyze-trajectories.mjs
eval/r37d/out/process-pilot-trajectories.json
tests/r37d-trajectories.spec.ts
```
