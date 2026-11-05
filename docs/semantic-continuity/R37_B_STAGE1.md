# R37-B — Stage 1 (Exploratory)

## Status

```text
Stage 1                 complete
Replicates              4 per case/arm cell
Status                  exploratory, not confirmatory
Provider requests       777 HTTP attempts (including retries after the outage)
Product decision        insufficient evidence
Stage 2                 started separately; Stage 1 is not pooled
```

This document is the Stage 1 record under
`R37_B_PREREGISTRATION_AMENDMENT A1`. It is not a confirmatory result.

## 1. Provider incident

The local `omnigate2api` gateway stopped during the first O2 pass. The affected
O2 r3/r4 rows are `provider-transport-error` (`ECONNREFUSED`), not task
failures. The gateway was restarted from its own `start.sh`; the invalid cells
were rerun under new run IDs. Invalid rows remain in the cost ledger and are
excluded from the deduplicated outcome cells. The same rule was applied to one
representation cell and one end-to-end cell.

```text
invalid measurements in the raw archive   19
O2 transport-invalid retries             14 -> 12 valid retries
representation transport retry            1 -> 1 valid retry
end-to-end transport retry                1 -> 1 valid retry
```

## 2. Writer pilot

P3e harness; writer-only; six cases; four replicates; 24 calls per prompt.

| metric | W0 | W1 |
|---|---:|---:|
| attempts | 24 | 24 |
| protocol parsed | 10 | 23 |
| accepted deltas | 25 | 51 |
| refused deltas | 3 | 8 |
| matched-fact recall | 0.396 | 0.8125 |
| direct visibility | 0.250 | 0.729 |
| fold refusals | 2 | 2 |

W1 removes the writer envelope failure mode in this live pair. The two W1 fold
refusals are A1-v2 r3 and C1 r2 (`summary-not-smaller`); the writer parsed, but
the checkpoint did not pay for its span.

## 3. O2 floor under P3e

```text
valid rows       23/24
contract         17/23  73.9%
task             17/23  73.9%
```

By case:

| case | valid | contract | task |
|---|---:|---:|---:|
| A1-v2 | 4 | 3 | 3 |
| D1-v2 | 4 | 3 | 3 |
| B2 | 4 | 4 | 4 |
| C1 | 3 | 0 | 0 |
| F1 | 4 | 3 | 3 |
| H1 | 4 | 4 | 4 |

The floor is above the preregistered 4/6 threshold. C1 remains the hard case:
even with the gold fact visible, the model fails the visible behavior in all
three valid rows. That is an implementation/benchmark-difficulty result, not a
memory-delivery result.

## 4. Controlled representation

All contexts are the R37 fixtures, labelled
`controlled/oracle-facts intervention`; no EF writer is involved.

B2:

| representation | rows | valid | contract | task |
|---|---:|---:|---:|---:|
| F-P plain | 4 | 4 | 3 | 4 |
| F-S structured | 4 | 4 | 4 | 4 |
| F-N withheld | 4 | 4 | 2 | 4 |

C1:

| representation | rows | valid | contract | task |
|---|---:|---:|---:|---:|
| F-P plain | 4 | 4 | 1 | 1 |
| F-S structured | 4 | 4 | 0 | 0 |
| F-H full history | 4 | 4 | 0 | 0 |

B2 shows a small ordered difference (F-S 4/4, F-P 3/4, F-N 2/4), but the two
F-P/F-N contract failures are process violations: the agent completed the task
but did not run a test. C1 shows no structured advantage; full history also
fails. At n=4 this is a pilot signal, not a representation effect.

## 5. End-to-end B1/S

Assigned-arm pairs; S fallback and empty commits remain in the denominator.

```text
valid pairs       24
contract          3 rescue / 8 damage / 10 both / 3 neither
task              3 rescue / 6 damage / 12 both / 3 neither
```

By case (contract):

```text
A1-v2  1 rescue, 1 damage, 2 both
D1-v2  0 rescue, 0 damage, 4 both
B2     0 rescue, 2 damage, 2 both
C1     1 rescue, 1 damage, 2 neither
F1     1 rescue, 1 damage, 2 both
H1     0 rescue, 3 damage, 1 neither
```

S delivery:

```text
semantic-committed        17
semantic-committed-empty   4
full-history-fallback      3
```

The 8 damage pairs are not one mechanism:

| case | damage | delivery | sufficient observation |
|---|---|---|---|
| A1-v2 | 1 | semantic-committed | tests 0; object and string form both fail |
| B2 | 2 | semantic-committed | task succeeds, but tests 0 -> process violation |
| C1 | 1 | semantic-committed | tests 0; functionality fails |
| F1 | 1 | semantic-committed | tests 0; functionality.v2 fails |
| H1 | 3 | semantic-committed | tests 1 or 0; `region.production` fails although the checkpoint contains `eu-west-2` |

The H1 damage is the most interesting: the fact is in the committed anchors and
the rendered checkpoint, but the observable action still fails the production
region check. That is an operationalization candidate, not a missing-fact
result. B2's damage is a process violation, not a decision conflict. A1/C1/F1
damage is implementation/process.

The 3 rescues are also mixed:

```text
A1-v2 r3  semantic-committed
C1 r2     full-history-fallback  (not a semantic checkpoint)
F1 r3     semantic-committed
```

C1 r2 cannot be counted as a semantic-checkpoint rescue. The Stage 1 pair count
therefore does **not** establish an Active advantage or disadvantage.

## 6. Protocol

```text
model turns             569
valid actions           792
rejected actions         93
invalid-action rate      10.5%
unparsed-turn rate        5.1%   (29 truncated-invoke diagnostics / 569)
rejected reasons         missing-parameter 90, unknown-tool 4, path-escape 1
diagnostics              multiple-actions 138, duplicate-action 81, truncated-invoke 29
```

P3e correctly rejects a write without content instead of writing an empty file.
The 90 missing-parameter rejections are model protocol errors, not silent
harness corruption. The preregistered unparsed-turn threshold (10%) is met at
5.1%; the separate invalid-action rate is 10.5% and is reported, not hidden.

## 7. Stage 1 gates

`eval/r37/out/gate-status-r37b.json`:

```text
R37B-W   Writer Pilot                  passed
R37B-O2  O2 Floor Under P3e            passed
R37B-P   P3e Protocol                  passed
R37B-R   Controlled Representation     passed
R37B-E2E Assigned-Arm B1/S Pairs       passed (completeness, not outcome)
R37B-D   Delivery Determination        passed (20/24, 83.3%)
Stage 1                                complete
Stage 2                                ready
```

"Passed" on the E2E gate means the planned cells were measured; it does not
mean Active is better.

## 8. What Stage 1 changes

- P3e removes the R36 B2 r1 escape-corruption mode in live runs.
- A1-v2 and D1-v2 are executable by the model and the scorer.
- The O2 floor is usable (73.9% contract).
- B2 process compliance and H1 action consistency are the main residual gaps.
- There is no clean Active advantage in the 24 Stage 1 pairs.

Stage 2 is a separate six-replicate confirmatory batch. Its rows are not pooled
with these exploratory rows.
