# R37-D — Process Pilot

## 1. Status

```text
batch                  r37d-process
status                 ready-for-authorization
authorization          not granted
provider calls         0
runner                 design-only
```

The R37-C authorization covered the 24-cell C2 batch. It does not cover this
new batch. `node eval/r37d/process-pilot.mjs --run` exits with code 2 and makes
no request.

## 2. Design

```text
cases                 B2, D1-v2
context arms          B1, S
process conditions    P0 (frozen task), P1 (frozen task + one process sentence)
replicates            3 per condition
cells                 2 x 2 x 2 x 3 = 24
finish guard          off in every cell
step budget           8
follow-up output      1,024 tokens
model                 deepseek-v4.1-flash
tool protocol         P3s
runtime               custom-json-loop
scorer version        3
```

The fixed context is the G0 r1 checkpoint frozen in WP3. P0 and P1 use the same
context; only the process sentence changes.

```text
P0  ""
P1  "Before completing the task, execute the required verification steps and
     ensure the required deliverables have been written."
```

P1 is appended to the task at the same position in both context arms. It
contains no gold fact. The prompt files and their SHA-256 digests are in the
manifest.

## 3. Why guard off

The C2 pilot showed the finish guard never fired in any contract failure. The
first process batch isolates the prompt. The guard is not bundled into P1.

The step budget is also held at 8. A separate 8-vs-12 experiment is
preregistered below and must not be mixed into this batch.

## 4. Estimand

```text
E2 controlled process effect
```

P1-P0 under B1 and P1-P0 under S are mechanism comparisons on a fixed context.
They are not an EF Active product effect. The interaction is exploratory.

## 5. Observed metrics

Per cell:

```text
artifactCorrectness
verificationCompleteness
operationalCompletion
legacyTaskSuccess
legacyContractSuccess
testsExecuted
freshPassingVerification
finishRequested
finishAccepted
stepLimitTermination
noValidActionCalls
rejectedActions
toolCalls
modelCalls
```

The primary descriptive comparison is the operational-completion rate by
condition. The legacy contract rate is reported alongside it so the two
completion definitions remain visible.

## 6. Preflight

```text
workspace B2             passed
workspace D1-v2          passed
fixture B2/B1            passed
fixture B2/S             passed
fixture D1-v2/B1         passed
fixture D1-v2/S          passed
matrix 24 unique         passed
3 replicates per cell    passed
P0/P1 prompt digests     passed
no gold phrase in P1     passed
guard off                passed
budget caps              passed
model/protocol/steps     passed
no provider client       passed
authorization            partial (not granted)
runner                   partial (design-only)
```

## 7. Budget

```text
HTTP attempts     240
input tokens      300,000
output tokens      70,000
wall clock        3,600,000 ms
```

These are planning caps, not an authorization. A new authorization must name
the manifest digest, the 24 cells, the model, the route, and these limits.

## 8. What remains before execution

- A new frozen authorization naming this batch.
- A live adapter path that calls `followUp` with the frozen context and the
  P0/P1 task. The current preflight only proves the inputs are frozen.
- A budget ledger with the same observed-usage enforcement used by C2.
- A preflight that resolves the route without printing credentials.

Until those exist, the batch stays `ready-for-authorization`.

## 9. Step-budget experiment

```text
id        r37d-step-budget
status    not-executed
design    2 cases x 2 arms x 2 budgets (8, 12) x 3 replicates = 24 cells
```

It must be preregistered and authorized separately. It must not be added to
this batch after seeing the P0/P1 results.

## 10. Artifacts

```text
eval/r37d/prompts/P0.txt
eval/r37d/prompts/P1.txt
eval/r37d/process-pilot.mjs
eval/r37d/out/process-pilot-manifest.json
eval/r37d/out/process-pilot-preflight.json
tests/r37d-pilot.spec.ts
```
