# R37-D — Action Budget Forensics

## 1. What is measured

For every C2 cell:

```text
firstWriteStep              first step whose valid actions include write_file
firstTestStep               first step whose valid actions include run_tests
modelCallsBeforeFirstTest   calls spent before that step
invalidCallsBeforeFirstTest no-valid-action turns before that step
remainingBudgetAtFirstTest  8 - firstTestStep - 1
modelCallsAfterLastWrite    calls after the last valid write
modelCallsUntilTermination  authoritative model-call count
```

The trace is a stored prefix. A position is `null` when the prefix contains no
such action; that means "not observed", not "never happened". The counters
remain authoritative for totals.

## 2. B2: the agent never reaches the test

| cell | tests | first test step | calls before test | invalid before test | budget left at test | no-valid classes |
|---|---:|---:|---:|---:|---:|---|
| B2-B1-G0-r3 | 3 | 0 | 0 | 0 | 7 | invalid-envelope 1 |
| B2-S-G0-r2 | 2 | 1 | 1 | 0 | 6 | invalid-envelope 2 |
| B2-B1-G1-r1 | 2 | 2 | 2 | 0 | 5 | invalid-envelope 3 |
| B2-B1-G0-r1 | 1 | 3 | 3 | 1 | 4 | missing-param 1, truncated 2 |
| B2-S-G1-r3 | 1 | 4 | 4 | 0 | 3 | none |
| B2-S-G1-r2 | 1 | 4 | 4 | 1 | 3 | truncated 2, invalid-envelope 2 |
| B2-S-G0-r1 | 1 | 6 | 6 | 2 | 1 | natural-language 1, invalid-envelope 2 |
| B2-S-G0-r3 | 1 | 6 | 6 | 3 | 1 | invalid-envelope 3, truncated 1 |
| B2-B1-G1-r2 | 1 | 7 | 7 | 3 | 0 | invalid-envelope 3 |
| B2-B1-G0-r2 | 0 | — | — | — | — | missing-param 1, invalid-envelope 4, truncated 1 |
| B2-B1-G1-r3 | 0 | — | — | — | — | missing-parameter 7 |
| B2-S-G1-r1 | 0 | — | — | — | — | missing-parameter 4 |

Three cells never ran a test. All three failed the contract. Every cell that
ran a test passed the task checks.

The three failures are not "wrote code and forgot to test":

```text
cells that wrote code but did not test   0
```

They never wrote code either. The initial B2 workspace already satisfies the
functional checks; the task is a process contract, and the agent spends its
eight steps reading and emitting malformed calls.

Two cells re-read `src/scheduler.mjs` twice. One `list_dir` is normal; repeated
reads are not the dominant cost. The dominant cost is the 35 no-valid-action
calls, mostly malformed DSML and missing parameters.

### What this says about B2

```text
parser false negative       no evidence
tool capability             not the bottleneck; valid calls execute
model output formatting     primary immediate cause
output budget               six max-tokens turns
action planning             secondary; reads consume the remaining steps
```

A process prompt that says "run the required verification before finishing"
does not fix an unclosed `invoke` tag. A larger output budget or a simpler
protocol could.

## 3. D1: the artifact is missing for two different reasons

| cell | tests | first test | verification write mentions | valid writes | artifact | phase |
|---|---:|---:|---:|---:|---|---|
| D1-v2-S-G0-r1 | 1 | 1 | 1 | 1 | yes | executed |
| D1-v2-B1-G0-r1 | 1 | 0 | 1 | 1 | yes | executed |
| D1-v2-B1-G0-r2 | 1 | 1 | 1 | 1 | yes | executed |
| D1-v2-B1-G0-r3 | 1 | 0 | 1 | 1 | yes | executed |
| D1-v2-S-G0-r2 | 1 | 3 | 1 | 1 | yes | executed |
| D1-v2-S-G0-r3 | 1 | 4 | 1 | 1 | yes | executed |
| D1-v2-S-G1-r1 | 1 | 3 | 1 | 1 | yes | executed |
| D1-v2-B1-G1-r1 | 2 | 3 | 1 | 1 | yes | executed |
| D1-v2-B1-G1-r2 | 2 | 2 | 2 | 2 | yes | executed |
| D1-v2-S-G1-r2 | 2 | 2 | 2 | 2 | yes | executed |
| **D1-v2-B1-G1-r3** | 1 | 2 | **3** | **0** | **no** | **tool-request-rejected** |
| **D1-v2-S-G1-r3** | 1 | 1 | **0** | **0** | **no** | **budget-exhausted-before-request** |

### D1-v2-B1-G1-r3: the write was requested and rejected

The agent ran the tests at step 2, saw them fail, and tried to write
`verification.json` at steps 3, 5, and 7. All three attempts were malformed
DSML: the `content` parameter was never closed. The parser rejected each
attempt before execution. No `write_file` reached the workspace. The eighth
step was the last.

```text
tests executed              1
test result received        1
verification write attempts 3
valid verification writes   0
artifact present            no
termination                 step limit
failure phase               tool-request-rejected
```

The artifact is missing because the tool request never became a valid action,
not because the agent forgot, and not because the write executed and failed.

### D1-v2-S-G1-r3: the write was never requested

The agent ran the tests at step 1 and then spent steps 2–7 reading
`src/migrate.mjs` and `tests/migrate.test.mjs`. Six of those turns were
malformed short-form reads. It never requested `write_file`.

```text
tests executed              1
test result received        1
verification write attempts 0
artifact present            no
termination                 step limit
failure phase               budget-exhausted-before-request
```

This is a planning failure. The agent had the test result and enough
information to write the artifact, but spent the budget re-reading.

## 4. The five contract failures

| cell | task | tests | no-valid calls | verification artifact | failure |
|---|---|---:|---:|---|---|
| B2-B1-G0-r2 | pass | 0 | 6 | n/a | no test; malformed DSML |
| B2-B1-G1-r3 | pass | 0 | 7 | n/a | no test; missing parameters |
| B2-S-G1-r1 | pass | 0 | 4 | n/a | no test; missing parameters |
| D1-v2-B1-G1-r3 | fail | 1 | 3 | missing | rejected writes |
| D1-v2-S-G1-r3 | fail | 1 | 6 | missing | never requested |

None requested finish. The finish guard had no opportunity in any of them.

The B2 failures are process-contract failures with a passing workspace. The D1
failures are artifact-delivery failures with a completed test observation.

## 5. Answer to the brief's question E

> Where did D1's missing `verification.json` happen: before the tool request,
> during execution, or after the budget was exhausted?

Both D1 failures are before execution, for different reasons:

```text
D1-v2-B1-G1-r3   the request was emitted three times and rejected by the
                 protocol validator; no write executed
D1-v2-S-G1-r3    no request was emitted; the step budget was exhausted on
                 repeated reads
```

Neither is an execution failure. The workspace never received a valid write.

## 6. Implications for the process pilot

- A generic "ensure required deliverables are written" prompt can address
  `budget-exhausted-before-request`. It cannot fix a malformed `content`
  parameter.
- A step-budget increase is a separate intervention. It must not be mixed into
  the process-prompt batch.
- An output-budget increase is also separate. The 1,024-token follow-up budget
  is a plausible contributor to the six max-tokens turns, but most malformed
  turns ended with `stop`, so the budget is not the whole story.
- The finish guard is not the right instrument for either D1 failure: neither
  cell requested finish.

## 7. Limits

- Eight steps, one model, one route, two cases, three replicates per condition.
- The trace prefix cannot prove an action that was never stored.
- `verificationWriteMentions` is a text marker (`verification.json` and
  `write_file` in the same turn). It is evidence of an attempt, not proof that
  the model intended a valid call.
- The B2/D1 contrast is confounded with task content and context arm. It is a
  mechanism description, not an EF effect.
