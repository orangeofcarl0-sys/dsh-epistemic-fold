# R36 — Agent Harness Calibration

## Status

```text
H0 (custom text-JSON loop)       implemented; offline tests pass
H-step / H-output                manifest conditions; offline plumbing tested
H-finish                         implemented; offline tests pass
H-native                         declared; NOT implemented; blocked
Live O2 calibration              blocked: no R36 authorization
New provider requests            0
```

These results are plumbing and guard behaviour, not a model measurement. The
live manifests in `eval/r36/manifests/` are marked `blocked`; the gate report
does not present them as executed.

## 1. H0: the fixed baseline

```text
runtime                   custom text-JSON tool loop
max steps                 8
output tokens per turn    1024
tools                     read_file, write_file, list_dir, run_tests, recall, finish
tool results              ordinary user-role text
finish policy             none (H0)
```

H0 is not the production DSH Agent/Tool Runtime. `followUp` records its own
version (`H0-custom-json-loop`), tool list, step count, output bound, and
`runtimes`, so a report cannot silently change the harness.

## 2. H-step / H-output

These are single-factor manifest changes, not defaults:

| condition | steps | output tokens/turn | finish guard |
|---|---:|---:|---|
| H0 | 8 | 1024 | off |
| H-step | 16 | 1024 | off |
| H-output | 8 | 4096 | off |
| H-finish | 8 | 1024 | on |

`tests/r36-agent-calibration.spec.ts` runs a scripted continuation with the
H-step/H-output manifest and asserts the report carries 16/1024 and 8/4096 as
requested. The live versions remain blocked.

## 3. H-finish: the guard is intentionally small

When the task requires tests:

```text
agent requests finish
  -> is there a run_tests call?
  -> did it pass?
  -> does its source digest equal the final source digest?
  -> if yes: allow finish
  -> if no:  reject, explain which condition is unmet, return control
```

It does **not**:

- run the test automatically,
- edit or fix the code,
- write `verification.json`,
- mark a failing test as passing,
- hide the premature request.

The offline test drives the real loop with a local mock provider:

1. `finish` with no test → rejected;
2. `run_tests` → the model's own action, and the visible workspace passes;
3. `finish` → allowed because the passing digest equals the final digest.

Observed:

```text
finishRequests            2
prematureFinishRequests   1
finishRejections          1
testsExecuted             1   (the model's run, not the guard's)
assistedCompletion        true
stepLimitTermination      false
```

The unguarded H0 run records a process violation:

```text
finished                  true
testsExecuted             0
processViolation          true
processCompliance         false
contractSuccess           false
```

The two rows are reported separately by `runQuality.harnessCalibration`.
Guard-assisted completion is not counted as unguided process compliance.

## 4. Tool-protocol diagnostics

Every continuation row now records:

```text
modelCalls
validActions / invalidActions / unknownTools
toolCounts: read_file, write_file, list_dir, run_tests, recall, finish
finishReasonCounts
truncatedTurns
stepLimitTermination
providerFailure
finishGuard: enabled, policy, requiredTests, requests, premature, rejections,
             assistedCompletion, checks[]
verificationFreshness: currentDigest, lastModification, lastPassingTest,
                       sourceDigestAtLastTest, sourceDigestAtFinish, testRuns
```

This is enough to separate:

| category | evidence |
|---|---|
| strategy error | valid actions, tool counts, code/checker failure |
| tool protocol failure | invalid JSON, unknown tool, repeated correction |
| output budget failure | `finishReasonCounts.max-tokens`, `truncatedTurns` |
| step budget failure | `stepLimitTermination` with no finish |
| premature finish | `finishGuard.prematureFinishRequests` |
| test omission | `testsExecuted = 0`, `processViolation` |
| stale verification | `sourceDigestAtLastTest != sourceDigestAtFinish` |
| false verification | claim `verified` with no fresh tool pass |

The run does not infer "the model did not listen" from a failed task. It records
the earliest observable category.

## 5. Verification freshness

`verification.json` is self-reported. Final verification is derived from:

```text
actual run_tests call
test exit code
source digest at test
source digest at finish
```

A passing test followed by a source edit is `stale-verification`, not
`verified`. The D1 counterexamples are in
`tests/r36-benchmark-validity.spec.ts`; the harness supplies the tool trace,
not the agent's file.

## 6. H-native

The real DSH Agent/Tool Runtime is a different execution substrate. This harness
does not implement it. A manifest requesting `runtime: "dsh-agent"` is refused
before a provider request with:

```text
status: not-executed
condition: H-native
status: blocked
providerRequests: 0
```

The refusal is tested. This is a gap, not a negative result about the model or
the memory policy.

## 7. What the next calibration needs

Before any B1/S comparison, run O2 only on the certified cases and answer:

```text
Can the agent complete a task when the correct facts are directly visible?
If not: task infeasible, visible/hidden conflict, tool protocol, step budget,
        output budget, or coding failure?
If yes: with which of H0 / H-step / H-output / H-finish?
```

Do not expand B1/S to accumulate more double-failure results. The guard's
success is not evidence that unguided agents comply; it is evidence that the
execution environment can reach contract success when the process is enforced.
