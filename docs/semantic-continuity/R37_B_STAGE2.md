# R37-B — Stage 2 (Confirmatory)

## Status

```text
Stage 2                  complete
Replicates               6 per case/arm cell
Status                   confirmatory under R37_B_PREREGISTRATION_AMENDMENT A1
Stage 1                  separate; not pooled
Product decision          Active not supported; harm signal on contract success
```

## 1. Design

Stage 2 uses the same frozen P3e harness, A1-v2/D1-v2, and controlled
representation fixtures as Stage 1, with six replicates per cell and a separate
run root (`eval/r37/runs-b2`). Stage 1 rows are not included in any Stage 2
estimate.

```text
writer calls             72 (W0/W1 × 6 cases × 6 replicates)
end-to-end pairs         36 (6 cases × 6 replicates, B1/S)
representation rows      36 (B2 3 variants × 6, C1 3 variants × 6)
O2 rows                  36 (6 cases × 6)
```

## 2. Writer pilot

| metric | W0 | W1 |
|---|---:|---:|
| attempts | 36 | 36 |
| protocol parsed | 22 | 32 |
| accepted deltas | 54 | 72 |
| refused deltas | 14 | 8 |
| matched-fact recall | 0.500 | 0.722 |

W1 remains the better writer contract in a second, independent batch. The four
W1 protocol failures are envelope/format failures; they are not counted as fact
loss.

## 3. End-to-end B1/S

Primary outcome is contract success.

```text
valid pairs       36
contract          1 rescue / 9 damage / 17 both / 9 neither
task              2 rescue / 7 damage / 20 both / 7 neither
```

By case (contract / task):

| case | contract | task |
|---|---|---|
| A1-v2 | 0 rescue, 2 damage, 4 both | 0 / 2 / 4 |
| D1-v2 | 0 rescue, 2 damage, 4 both | 0 / 2 / 4 |
| B2 | 0 rescue, 2 damage, 3 both, 1 neither | 0 / 0 / 6 (all task-success) |
| C1 | 0 rescue, 1 damage, 5 neither | 1 / 1 / 4 |
| F1 | 0 rescue, 1 damage, 5 both | 0 / 1 / 5 |
| H1 | 1 rescue, 1 damage, 1 both, 3 neither | 1 / 1 / 1 / 3 |

S delivery:

```text
semantic-committed        31
full-history-fallback      4
semantic-committed-empty   1
```

All 36 S rows have a determined delivery class.

### Paired statistics

```text
contract   S 50.0% vs B1 72.2%; difference -22.2 pp
           exact McNemar: 1 rescue, 9 damage, p = 0.0215
           case-clustered bootstrap 95% CI: -30.6 to -11.1 pp
task       S 61.1% vs B1 75.0%; difference -13.9 pp
           exact McNemar: 2 rescue, 7 damage, p = 0.1797
           case-clustered bootstrap 95% CI: -25.0 to -2.8 pp
```

The contract result is a **harm signal**, not an Active benefit. The task
difference is in the same direction but does not reach the same paired
significance. The bootstrap resamples six cases, so it is descriptive.

## 4. Why the damage happened

| case | damage | observation |
|---|---:|---|
| A1-v2 | 2 | S fails object/string form; tests 0 or a zero-step finish. Implementation/process. |
| D1-v2 | 2 | S writes `verification.json` with an invalid claim or missing test evidence. Verification process. |
| B2 | 2 | S task succeeds but runs no test; contract fails only on process. |
| C1 | 1 | S writes a broken watcher (`module-load`) and runs no test. Implementation. |
| F1 | 1 | S fails `functionality.v2` and runs no test. Implementation. |
| H1 | 1 | S runs a test but fails `region.production`; the checkpoint contains `eu-west-2`. Action-inconsistent candidate. |

Eight of the nine contract damages are implementation/process failures: no test
was run, or the code was broken. They are not evidence that the semantic
checkpoint lost the fact. The H1 damage is the only fact-visible,
action-inconsistent case in Stage 2; H1 also produced the only Stage 2 rescue.
H1 is therefore variable, not a stable demonstration.

The B2 task row is important: all six S runs completed the task, but two did not
run a test, so the contract failed. The Stage 2 harm is therefore mainly a
process-compliance effect, not a task-capability effect.

## 5. Controlled representation

B2:

| representation | contract | task |
|---|---:|---:|
| F-P plain | 4/6 | 6/6 |
| F-S structured | 6/6 | 6/6 |
| F-N withheld | 3/6 | 5/6 |

C1:

| representation | contract | task |
|---|---:|---:|
| F-P plain | 0/6 | 0/6 |
| F-S structured | 1/6 | 1/6 |
| F-H full history | 1/6 | 1/6 |

Paired exact McNemar:

```text
B2 F-S vs F-P   2 wins / 0 losses / 4 ties, p = 0.50
B2 F-N vs F-P   1 win  / 2 losses / 3 ties, p = 1.00
C1 F-S vs F-P   1 win  / 0 losses / 5 ties, p = 1.00
C1 F-H vs F-P   1 win  / 0 losses / 5 ties, p = 1.00
```

The B2 structured context is 2/6 better than plain and never worse, but the
discordant count is too small to separate it from noise. C1 is not sensitive to
representation: structured and full history each gain one pair, and plain loses
none. The preregistered condition for a representation claim—same direction in
both B2 and C1 without a token-count explanation—is not met strongly enough to
claim a structured-representation effect. C1's full-history win also shows the
gain is not specific to the structured form.

## 6. O2 floor

Stage 2 O2 was run with six replicates:

```text
valid rows       36/36
contract         24/36  66.7%
task             26/36  72.2%
```

By case (contract):

```text
A1-v2  5/6
D1-v2  6/6
B2     4/6
C1     0/6
F1     5/6
H1     4/6
```

The floor is above the preregistered 4/6 threshold. C1 remains the hard case:
the gold fact is visible in every O2 row, but the model never completes the
visible behavior in six attempts. That is an implementation/benchmark-difficulty
result, not a memory-delivery result.

## 6b. Protocol and cost

```text
model turns             819
valid actions          1148
rejected actions        121
invalid-action rate      9.5%
unparsed-turn rate       4.5%   (37 truncated-invoke diagnostics / 819)
rejected reasons        missing-parameter 121
diagnostics             multiple-actions 228, duplicate-action 71, truncated-invoke 37
HTTP attempts          1088
input tokens          1,250,840
output tokens           235,317
cache read tokens       999,626
unknown-usage requests        1
invalid measurements         11
```

All 121 rejected actions are missing-parameter, overwhelmingly `write_file`
without `content`. P3e rejects them instead of writing an empty file. The
preregistered unparsed-turn threshold is met; the invalid-action rate is just
under 10% and is reported separately.

## 7. Gates

`eval/r37/out/gate-status-r37b-stage2.json` is authoritative for Stage 2.
Stage 1 remains at `eval/r37/out/gate-status-r37b.json`.

The Stage 2 decision is not a claim that EF is universally harmful. It is a
claim that, under this model, route, harness, and six-case instrument, the Active
pipeline produced more contract failures than the Off pipeline, and that the
failures are mostly process/implementation. That is sufficient to block a
product claim of benefit and to require a deployment hold pending mechanism
work; it is not sufficient to estimate a general population effect.

## 8. What remains open

- Whether the process-compliance harm is caused by the checkpoint, the prompt,
  or model variance. Stage 2 did not manipulate those factors.
- Whether H1's action inconsistency replicates outside this 6-pair sample.
- Whether a structured representation helps B2 beyond noise.
- Whether the Stage 2 harm persists on a different model or route.
- Whether a longer follow-up budget reduces the no-test/zero-step failures.
