# R37-D — Process Pilot

## 1. Status

```text
batch                  r37d-process
status                 complete
authorization          granted (user: 均授权)
provider calls         173
runner                 available
executed               24/24
stop reason            none
```

The batch was frozen, preflighted, authorized against the manifest SHA-256, and
executed. The pre-execution freeze remains in
`process-pilot-manifest.json` and `process-pilot-preflight.json`; the execution
record is `process-pilot-results.json` and `process-pilot-analysis.json`.

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

## Results

All 24 cells executed and were valid. No provider or scorer failure occurred.

```text
legacy contract successes        17/24
operational completions          17/24
operational + accepted finish     8/24
visible test runs                34
finish requests                  10
step-limit cells                 14
no-valid-action calls            51
```

The legacy and operational counts agree cell-for-cell in this batch. The seven
failures are artifact/verification failures, not stale-verification cases.

By condition:

| case | arm | prompt | legacy | operational | tests | finish | step-limit |
|---|---|---|---:|---:|---:|---:|---:|
| B2 | B1 | P0 | 3/3 | 3/3 | 7 | 0 | 3 |
| B2 | B1 | P1 | 2/3 | 2/3 | 4 | 1 | 2 |
| B2 | S | P0 | 2/3 | 2/3 | 2 | 0 | 3 |
| B2 | S | P1 | 1/3 | 1/3 | 4 | 0 | 3 |
| D1-v2 | B1 | P0 | 1/3 | 1/3 | 2 | 2 | 1 |
| D1-v2 | B1 | P1 | 3/3 | 3/3 | 6 | 2 | 1 |
| D1-v2 | S | P0 | 2/3 | 2/3 | 5 | 2 | 1 |
| D1-v2 | S | P1 | 3/3 | 3/3 | 4 | 3 | 0 |

Descriptive effects:

```text
P1-P0 operational under B1   +1/6   (+16.7 pp)
P1-P0 operational under S     0/6   (0 pp)
interaction                  -1/6   (-16.7 pp)
```

The aggregate hides a case-by-prompt interaction:

```text
B2  P1 is worse in both arms: B1 3/3 -> 2/3, S 2/3 -> 1/3
D1  P1 is better in both arms: B1 1/3 -> 3/3, S 2/3 -> 3/3
D1  P1: 6/6 operational, 5/6 accepted finish
B2  P1: 3/6 operational, 1/6 accepted finish
```

The prompt helps the artifact-delivery case and does not help the protocol-heavy
case. B2's failures remain no-test cells: the agent reads and never reaches
`run_tests`. The prompt cannot fix an unclosed DSML envelope.

The pilot is exploratory: three replicates per condition, one model, two cases,
one fixed context per case/arm. No significance claim is made.

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
authorization            pre-execution: not granted; execution: granted (均授权)
runner                   pre-execution: design-only; execution: available
```

## 7. Budget

```text
HTTP attempts     240
input tokens      300,000
output tokens      70,000
wall clock        3,600,000 ms
```

Observed:

```text
HTTP attempts     173 / 240
input tokens      233,191 / 300,000
output tokens      25,125 / 70,000
wall clock        425,585 ms / 3,600,000 ms
```

The per-cell admission ledger reserves the 131,072-token context window per
attempt. The global caps are enforced on observed usage after each cell. The
run did not stop early; no cap was reached.

## 8. Execution record

- A new authorization named manifest SHA-256 `6b762e4f90be…`, the 24 cells,
  the model, the route, and the caps.
- The live runner called `followUp` with the frozen context and the P0/P1 task.
- The budget ledger enforced observed usage after every cell.
- The route resolved without printing credentials.
- 24/24 cells executed; 0 provider failures; 0 scorer failures; 0 retries.

The raw per-cell reports, traces, and workspaces are local and gitignored under
`eval/r37d/runs-process/`. The aggregate results and analysis are committed.

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
