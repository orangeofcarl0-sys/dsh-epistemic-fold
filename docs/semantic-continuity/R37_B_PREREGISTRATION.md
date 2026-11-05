# R37-B — Preregistration

## Status

```text
Live experiments                  not executed
Provider requests                 0
Authorization for R37-B           not granted
R37-A boundary                    offline reconstruction, attribution, fixtures only
H-native                          blocked unless a real DSH Agent/Tool Runtime is wired
```

This document freezes the next stage **before** any R37-B provider request. It
does not convert the R37-A exploratory evidence into a result. R37-B needs a new
explicit spend authorization; R37-A's authorization, if any, does not carry
over.

## 1. Two estimands, kept separate

### E1 — End-to-end product effect

```text
B1  EF off pipeline
S   EF active pipeline, assigned arm
```

Every assigned S run stays in the analysis, including a fold refusal and a
full-history fallback. Writer failure, fold rejection, fallback, and retrieval
are part of the deployed policy, not noise to be filtered out. This is the only
estimand that can support a product decision.

### E2 — Controlled representation effect

```text
same verified facts
different context representation
same continuation harness
```

B2:

```text
F-P  plain-language facts
F-S  structured semantic facts
F-N  critical facts withheld
```

C1:

```text
F-H  full historical context
F-P  plain-language fact representation
F-S  structured semantic representation
```

All six contexts are in `eval/r37/fixtures/` and are labelled
`controlled/oracle-facts intervention`. They are not EF writer output. E2 can
identify a representation mechanism; it cannot be extrapolated to the product
effect without E1.

## 2. Hypotheses and disconfirming observations

| id | hypothesis | predicted observation | disconfirming observation |
|---|---|---|---|
| H1 | The R36 DSML defect, not memory, caused the B2 r1 damage | With P3e attribute decoding, the B2 S module loads and the checker passes; the B1/S difference disappears or reverses | B2 S still fails with a valid decoded module and a fact-visible checkpoint |
| H2 | A committed semantic checkpoint improves action consistency when the fact is rendered | On C1/B2, S contract success exceeds B1 in pairs where S delivery is `semantic-committed` and the fact is rendered | No S advantage after excluding fallbacks and protocol-confounded runs |
| H3 | C1 r1's failure is a fallback-plus-implementation failure, not missing delivery | The full-history fallback contains the fs.watch fact; removing fallback runs changes the mechanism estimate but not the assigned-arm policy | The fallback context lacks the fact, or fallback runs behave like semantic-checkpoint runs |
| H4 | The v2 benchmark repairs remove the A1/D1 confounds | A1-v2/D1-v2 reference solutions pass; failures are implementation, process, or verification rather than hidden-vocabulary ambiguity | A1-v2/D1-v2 still fail for a rule absent from task and visible tests |

H1 does not imply EF is effective. A harness repair is a precondition for
measuring EF, not evidence for it.

## 3. Fixed conditions

Before the first R37-B request, freeze and record:

```text
dataset/case versions    A1-v2, D1-v2, B2, C1, F1, H1 (old A1/D1 preserved)
harness                  H-protocol-e: 8 steps, 1024 output tokens/turn, no guard
tool protocol            P3e: JSON + complete DSML + short attributes + multi-action
                         + attribute unescaping; validation diagnostics on
writer                   W1 production contract (W0 only for a repeated pilot)
validator/authority      source digests recorded by eval/r36/conditions.mjs
model/provider/route     one model and one resolved route, recorded
scorer                   v3 or its successor, recorded before the run
```

P4 raw-body content is **not** in the confirmatory harness. It is an ablation
only. The B2 r1 step-5 prefix was truncated in the saved trace, so accepting a
raw body would be a guess; it must not become production behavior without a
separate decision.

H-native remains blocked until the real DSH Agent/Tool Runtime is implemented
and a smoke test proves tool calls travel through it. A custom JSON loop must
not be relabelled as native.

## 4. Design

```text
case-level grouping
within-case repeated trials
paired B1/S within each trial block
randomized or interleaved arm order inside each block
no post-hoc arm selection
no silent case editing
```

Planned minimum, subject to the authorized budget:

| phase | cells | replicates | pairs/rows |
|---|---|---:|---:|
| writer W0/W1 pilot | 6 cases × 2 prompts | 3 | 36 writer calls |
| O2 floor | 6 cases | 2 | 12 rows |
| B2 representation | 3 representations × B2 | 8 | 24 rows |
| C1 representation | 3 representations × C1 | 8 | 24 rows |
| end-to-end B1/S | 6 cases × 2 arms | 8 | 48 pairs |

If the budget cannot fund eight replicates, the run may use six, but the number
must be frozen before the first request. It must not be increased after seeing
the pair counts. The 12 R36 pairs are six cases × two replicates, not 12
independent tasks; the analysis must cluster by case.

### Randomization and seeds

Randomize arm order per `case × replicate` block with a recorded seed. If the
provider exposes a deterministic sampling seed, pair B1/S on it; if it does not,
record that the sampling factor is not reproducible and do not claim seed
pairing.

## 5. Outcomes

Primary:

```text
contract success = functional success + historical constraint compliance
                   + process compliance
```

Secondary:

```text
task success
rescue / damage / both / neither
fold committed / fold refused / full-history fallback
actual delivery status
fact visible in the rendered context
observable action consistency
verification artifact present and valid
```

Failure records keep `first_observable_failure`, `sufficient_cause`,
`contributing_factors[]`, `unresolved_hypotheses[]`, and evidence references.
No field says "the agent forgot" or "the agent understood".

## 6. Validity and exclusions

A row is **invalid measurement**, not task failure, when any of these holds:

```text
provider transport failure without a model result
budget/ledger censoring
checker did not execute
actual delivery cannot be determined
unknown usage makes the cost accounting indeterminate
```

Transport retry cap: at most 2 resends per case. Further attempts are recorded
and the row is invalid; do not retry until a success appears.

Stop or pause rules:

1. If P3e leaves more than 10% of tool turns unparsed, stop and fix the harness
   before spending on endpoints.
2. If the O2 floor is below 4/6 contract success, stop end-to-end expansion.
3. If a gold fact is absent from the frozen transcript, or the checker requires
   a rule absent from task and visible tests, stop that case.
4. If the actual delivered context cannot be classified for a run, exclude it
   from mechanism analysis and report it as unknown.
5. If H-native is unavailable, mark it blocked; do not substitute the custom
   loop.

A1-v2 and D1-v2 must pass `node eval/r37/benchmark-validity.mjs` before they are
used. The old A1/D1 remain at their R36 bytes and scores and must not be pooled
with the v2 cases.

## 7. Budget and accounting

Freeze in each manifest before the run:

```text
HTTP attempt cap
input-token cap
output-token cap
wall-clock cap
transport retry cap
unknown-usage treatment
```

Rules retained from R33–R36:

- observed usage is what the provider reported; unknown is not zero;
- a retry is a new admission and a new attempt;
- provider/budget failures are reported separately from task failures;
- no currency claim without a trusted price profile;
- the key is read at runtime and never written to a report or log.

## 8. Analysis plan

1. Report every assigned run, including fallback and invalid measurement.
2. Recompute the pair table with the frozen scorer; do not reuse R36 counts.
3. For contract success and task success, report rescue/damage/both/neither.
4. Use an exact McNemar test on discordant pairs for the paired B1/S contrast.
5. Because cases are the sampling unit, report a case-clustered bootstrap
   (10,000 resamples over cases) and a 95% interval; do not present 48 rows as
   48 independent tasks.
6. For E2, report F-P/F-S/F-N and F-H/F-P/F-S per case, with token estimates and
   context digests. A representation claim requires the same direction in both
   B2 and C1 and no token-count explanation.
7. Report commit success, actual delivery, fact visibility, first failure, and
   sufficient cause beside every outcome.
8. A product claim requires all of:
   - rescue > damage;
   - exact McNemar p < 0.05;
   - at least 80% of assigned S runs with a determined delivery status;
   - no case whose damage is explained by a benchmark or harness confound.
   Otherwise the decision is `insufficient evidence`.

## 9. What would change the current decision

Current R37-A decision: **insufficient evidence** for Active vs Off. R37-B may
change it only under the rule in §8. A representation effect alone changes the
mechanism understanding, not the product decision. A harness repair alone
changes the measurement floor, not the product decision.

## 10. Artifacts and commands

```text
docs/semantic-continuity/R37_B_PREREGISTRATION.md   this document
eval/r37/fixtures/                                  controlled contexts
eval/r37/out/representation-fixtures.json           fixture index
eval/r37/out/benchmark-validity.json                v2 certification
eval/r37/out/r36-evidence-reconstruction.json      run-level R36 evidence
eval/r37/out/protocol-ablation.json                layer attribution
eval/r37/out/forensics.json                        B2/C1 timelines
```

R37-B must add its own manifests, run IDs, cost record, and gate report. It must
not overwrite the R37-A artifacts above.
