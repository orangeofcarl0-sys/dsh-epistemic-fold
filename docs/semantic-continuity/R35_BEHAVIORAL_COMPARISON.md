# R35 — Behavioural Comparison

## Status

```text
continuation runs:         3 (r1, r2, r3)
valid rows:                r1 18/24, r2 24/24, r3 24/24
task success:              r1 7/18, r2 10/24, r3 4/24
contract success:          r1 3/18, r2 6/24, r3 0/24
process violations:        r1 12/18, r2 13/24, r3 22/24
false verification claims: r1 3, r2 4, r3 4
valid complete pairs:      r1 3, r3 6 (r2 excluded: fallback defect)
paired B1 vs S:            0 rescue, 0 damage, 0 both, 9 neither
verdict:                   no stable Active benefit; agent process dominates
```

The B1/S comparison ran on the real model with the evaluation's custom
text-JSON tool loop and hidden checkers. It is **not** the production DSH agent
loop. Three replicates show large variance and no stable Active benefit.

## What happened to r2

r2 introduced a full-history fallback for fold-refused rows, but the fallback
passed an empty checkpoint to the follow-up. Every r2 B1/S pair involves such a
row, so the r2 pairs are excluded from the paired quality count. r3 fixes the
fallback to the uncompressed transcript and is the authoritative complete-pair
run. r1 is the pre-fallback run; its three missing B1/O2 rows are fold-refused,
not task failures, and its other three pairs are valid.

## Runs

| Run | Valid | Task | Contract | Process violations | False verification | Requests | Input / output | Cache read | Wall clock |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| r1 | 18/24 | 7 | 3 | 12 | 3 | 162 | 147,294 / 36,333 | 96,640 | 568,260 ms |
| r2 (fallback defect) | 24/24 | 10 | 6 | 13 | 4 | 209 | 151,771 / 39,639 | 109,312 | 714,447 ms |
| r3 (authoritative) | 24/24 | 4 | 0 | 22 | 4 | 207 | 149,780 / 34,671 | 110,592 | 574,199 ms |

`taskSuccess` is the hidden functional checker. `contractSuccess` also requires
no historical-constraint violation, no process violation, and no critical false
verification claim. The gap between task and contract success is the agent's
process behaviour.

## Per-arm totals, r3

| Arm | Valid | Functional | Contract | Requests | Input / output |
| --- | ---: | ---: | ---: | ---: | ---: |
| B1 — EF Off | 6 | 1 | 0 | 53 | 40,912 / 9,318 |
| S — EF Active | 6 | 1 | 0 | 53 | 42,120 / 13,571 |
| O1 — oracle deltas | 6 | 1 | 0 | 48 | 38,639 / 3,976 |
| O2 — oracle facts | 6 | 1 | 0 | 53 | 28,109 / 7,806 |

All four arms have the same functional count (1/6) and zero contract successes.
O1, the oracle-delta control, does not rescue the run. This is the strongest
evidence that the bottleneck in r3 is not semantic memory delivery.

## Per-case results, r3

`F` = functional success, `C` = contract success, `P` = process violation.
All six B1/S pairs are `neither` on contract.

| Case | B1 | S | O1 | O2 | Pair |
| --- | --- | --- | --- | --- | --- |
| A1 | F–, C–, P | F–, C–, P | F–, C–, P | F–, C–, P | neither |
| B2 | F+, C–, P | F+, C–, P | F+, C–, P | F+, C–, P | neither (process) |
| C1 | F–, C–, P | F–, C–, P | F–, C–, P | F–, C–, P | neither |
| D1 | F–, C–, P, false verify | F–, C–, P, false verify | F–, C–, false verify | F–, C–, false verify | neither |
| F1 | F–, C–, P | F–, C–, P | F–, C–, P | F–, C–, P | neither |
| H1 | F–, C–, P | F–, C–, P | F–, C–, P | F–, C–, P | neither |

## What the valid replicates say

### No rescue and no damage in the valid pairs

Across the 9 valid complete B1/S pairs (r1 3, r3 6), every pair is `neither`:
both arms fail the contract. There is no rescue and no damage. The r2 H1
difference is excluded because its S fallback used an empty checkpoint; it is a
harness artifact, not a behavioural result.

### H1's writer failure is real but does not create a valid pair difference

- r1 H1: S committed only the objective; the region was refused as `verified`
  without `verificationQuote`; the S checkpoint lacked `eu-west-2`; the agent
  failed `region.production`. B1 also failed, so the pair is `neither`.
- r2 H1: the r2 fallback defect makes the pair invalid.
- r3 H1: S's writer protocol was malformed; B1, S, O1, and O2 all failed
  `region.production`.

The writer's fact delivery is a real risk, but the valid B1/S pairs do not show
a contract difference because B1 fails as well.

### Process compliance dominates

- B2: every arm passes the functional checker and every arm fails the contract
  because no visible test was run, in all three runs.
- C1: every arm fails `functionality.delivers-change` in all three runs,
  including O1 with the oracle fact.
- D1: every arm fails, and three of four arms make a false verification claim.
- A1/H1/F1: the agent often finishes without running tests, producing process
  violations.

The contract metric is doing what it was added for: it separates a functional
pass from a process-compliant pass. The low contract rate is caused by the
agent's behaviour, not by the semantic layer.

### Oracle arms do not provide a stable upper bound

O1 had the best r2 contract count (3/6), but in r3 it has 0/6, the same as every
other arm. O2 has 0/6 in r3. If even oracle semantic state cannot produce
contract success under this agent loop, the loop is the binding constraint on
this dataset.

## Pair accounting

```text
valid complete pairs  r1 3, r3 6
excluded r2 pairs     6 (fallback checkpoint defect)
incomplete pairs      r1 3 (B1 fold-refused)
budget-censored       0
provider-failed       0
invalid measurement   r1 3, r2 6 (excluded), r3 0
```

The r1 missing rows are not task failures. The r2 fallback rows are not a
full-history baseline. Both are retained in the run reports and excluded from
the paired quality count.

## Writer protocol in the continuation

| Run | Parsed | Malformed |
| --- | ---: | ---: |
| r1 | 3/6 | 3/6 |
| r2 | 3/6 | 3/6 |
| r3 | 2/6 | 4/6 |

The malformed cases differ between runs. The writer's envelope is not stable
under the continuation prompt. Its status/kind choices also refuse tool-proven
facts (H1/C1). This is a real risk, but the oracle arms show that fixing the
writer alone would not fix the agent's process failures.

## Cost

Continuation total over three runs:

```text
requests          578
observed input    448,845
observed output   110,643
cache read        316,544
wall clock        1,856,906 ms (~31 minutes)
```

No currency is reported: no trusted price profile was supplied. Oracle arms are
mechanism diagnostics, not a zero-cost product alternative.

## What this establishes

- No behavioural benefit from EF Active on this six-case set: 0 rescues in 9
  valid complete pairs.
- No behavioural damage either: 0 damages; all 9 valid pairs are `neither`.
- The dominant measured bottleneck is the custom agent's process compliance, not
  semantic memory delivery. This is a harness result, not a production result.
- The writer protocol/status failures are real and measured, but they are not
  the only reason tasks fail.

## What this does not establish

- A production DSH agent loop result.
- A statistically supported Active advantage or disadvantage.
- A retrieval-trigger result; `recall` searches the frozen transcript, not
  production `context_search`.
- A Handoff-Only/Delta-Only ablation; those have not run.

The next step is not a new memory subsystem. It is a writer-contract experiment
(envelope, `verified` + `verificationQuote`, `rejected-approach` authority) and
a process-compliance fix in the agent loop, followed by a larger paired run.
