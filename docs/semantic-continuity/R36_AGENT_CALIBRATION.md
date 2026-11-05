# R36 — Agent Harness Calibration

## Status

```text
H0 (custom text-JSON loop)       implemented; offline tests pass
H-step / H-output                executed as single-factor O2 conditions
H-finish                         implemented and executed
H-native                         declared; NOT implemented; blocked
Live O2 calibration              executed: 6 cases per condition
New provider requests            845 total for the round (12 writer + 833 continuation)
```

The live results below are model measurements. The offline guard tests remain
the deterministic proof that the guard rejects a premature finish without
running tests or editing code.

## 0. Live O2 calibration

One replicate per condition, six certified cases, `deepseek-v4.1-flash` through
the local ZCode proxy. Every row is O2 (correct facts directly visible), so the
only intended differences are the step budget, output budget, and finish guard.

| condition | valid | task success | contract success | tests run | step-limit stops | invalid actions | guard rejections |
|---|---:|---:|---:|---:|---:|---:|---:|
| H0 (8 / 1024 / no guard) | 6 | 2 | 1 | 2 | 4 | 28 | 0 |
| H-step (16 / 1024 / no guard) | 6 | 3 | 2 | 6 | 4 | 47 | 0 |
| H-output (8 / 4096 / no guard) | 6 | 2 | 1 | 2 | 4 | 23 | 0 |
| H-finish (8 / 1024 / guard) | 6 | 2 | 1 | 3 | 4 | 16 | 1 |
| H-protocol (8 / 1024 / DSML+JSON parser) | 6 | **5** | **5** | 10 | 2 | 2 | 0 |
| H-combined (16 / 1024 / guard) | 6 | 4 | 3 | 7 | 3 | 32 | 0 |

Per case (`task/contract`):

| case | H0 | H-step | H-output | H-finish | H-protocol | H-combined | earliest observed problem |
|---|---|---|---|---|---|---|---|
| A1 | fail/fail | **pass/pass** | fail/fail | fail/fail | **pass/pass** | fail/fail | code; H-protocol/DSML removes most failures |
| B2 | pass/fail | pass/fail | pass/fail | pass/fail | **pass/pass** | pass/fail | test/process omission until protocol fix |
| C1 | fail/fail | fail/fail | fail/fail | fail/fail | **pass/pass** | fail/fail | code; read failures under H0, pass under H-protocol |
| D1 | fail/fail | fail/fail | fail/fail | fail/fail | fail/fail | **pass/pass** | never writes `verification.json`; guard cannot invent it |
| F1 | **pass/pass** | fail/fail | **pass/pass** | **pass/pass** | **pass/pass** | **pass/pass** | stochastic; code succeeds in most runs |
| H1 | fail/fail | **pass/pass** | fail/fail | fail/fail | **pass/pass** | **pass/pass** | code/steps; succeeds when it reaches the edit |

The dominant harness defect was the **tool protocol**, not the step budget:
the model emitted `<｜｜DSML｜｜ invoke ...>` blocks with two parameter
syntaxes, and H0 parsed neither. After both forms were parsed, invalid actions
fell from 28 to 2 and contract success rose from 1/6 to **5/6**.

The best condition reaches **5/6 contract success**. The remaining D1 failure
is a specific process gap: the agent runs tests and finishes but never writes
`verification.json`, so the hidden checker has no claim to read. The guard
cannot write it for the agent. That is a task-process failure, not a memory
failure.

A B1/S comparison was therefore run under H-protocol. See
`R36_CAUSAL_COMPARISON.md`; it remains exploratory (two replicates, six cases).

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

## 7. What the next round needs

H-protocol answers the calibration question: with both tool protocols parsed,
the agent reaches 5/6 contract success with correct facts visible. The remaining
work is narrower:

1. **D1 verification artifact.** The agent runs tests but never writes
   `verification.json`. This is a task-process gap; a finish condition that
   requires the artifact, or a clearer instruction, is the next single factor.
2. **A1 task/gold ambiguity.** The S checkpoint contains the compatibility
   constraint, but the agent keeps the old string return shape while the hidden
   checker requires `retries: 2` on both forms. The task text does not state
   that requirement. Decide whether to clarify the task or relax the checker;
   do not attribute the A1 damage to memory until this is resolved.
3. **B2 stability.** B1 succeeded twice while S failed twice under H-protocol.
   The S checkpoint contains the in-memory decision, so inspect whether the
   extra context induces over-editing; this is the most interesting damage
   signal, but n=2.
4. **Replicates and H-native.** The causal run has two replicates. A larger
   writer/causal replicate set and the real DSH Agent/Tool Runtime are still
   needed before a product-level claim.

The guard's success is not evidence that unguided agents comply; it is evidence
that the execution environment can reach contract success when the process is
enforced.
