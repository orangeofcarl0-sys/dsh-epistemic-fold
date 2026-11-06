# R37-D — Decision

## 1. Status

```text
R37-D work             complete
process pilot          complete (24/24)
provider calls         173
EF Active              deployment hold
```

The 24-cell process batch was authorized by the user (`均授权`) and executed
within the frozen caps. It is a fixed-context mechanism result, not a product
result.

## 2. Completion semantics

The legacy contract and the layered operational completion answer different
questions.

C2:

```text
legacy contract successes                 19 / 24
operational completions                   16 / 24
legacy pass, operational fail              3
operational pass, legacy fail              0
```

The three-cell gap is stale verification:

```text
B2-S-G0-r1      test passed, source changed afterwards
B2-S-G1-r2      test passed, source changed afterwards
D1-v2-S-G1-r1   test ran, source changed afterwards
```

Seven of the eight D1 cells that ran a failing test and wrote
`claim: "not-verified"` are operational completions. The eighth,
`D1-v2-S-G1-r1`, ran the test and then changed the source, so it is stale
verification. A fresh failed test plus an honest claim is a complete
verification of a diagnostic task. The finish guard's "fresh passing test" is a
different criterion and is reported separately.

Two D1 cells fail artifact correctness because they never wrote
`verification.json`:

```text
D1-v2-B1-G1-r3   three malformed write attempts, zero executed
D1-v2-S-G1-r3   no write attempt, budget spent on reads
```

R37-B Stage 2, descriptive only:

```text
continuation rows                         146
legacy contract successes                  83
operational completions                    74
B1 legacy / operational                26 / 25
S  legacy / operational                18 / 17
```

The Active direction and the eight-cell difference are unchanged. The new
metric removes one success from each arm, both stale verification. The R37-B
conclusion is not an artifact of the old completion definition.

## 3. Protocol and action budget

C2:

```text
model calls             163
no-valid-action calls    46  (28.22%)
rejected parsed actions  16
classes                  invalid-envelope 30, missing-parameter 13,
                         truncated-output 6, natural-language-only 2
```

B2 is the protocol-heavy case:

```text
B2 no-valid rate        40.70% (35/86)
D1 no-valid rate        14.29% (11/77)
```

B2's three contract failures never ran a test and never wrote code. They spent
eight steps on reads and malformed DSML. The parser rejected the malformed
requests correctly; tool capability is not the bottleneck. The immediate cause
is model output formatting, with a secondary planning cost and six max-tokens
turns.

D1's two missing artifacts have different causes:

```text
D1-v2-B1-G1-r3   the write was requested three times and rejected before
                 execution; the step budget ended
D1-v2-S-G1-r3   no write was requested; the step budget ended on repeated reads
```

Neither is an execution failure. Neither is a post-finish omission.

## 4. Finish guard

All five C2 contract failures never requested finish. The guard had zero
opportunity to cause or prevent them. The guard-triggered subset passed the
contract but three of four hit the step limit.

The intention-to-treat guard difference is not a guard mechanism effect in this
pilot. The guard is not the next process intervention.

## 5. Native runtime

```text
N3  five tool calls in one turn, ordered, write before test, duplicate read,
    thrown tool error persisted, loop continues
N4  TOOL_NOT_STARTED and TOOL_OUTCOME_UNKNOWN synthesized from real persisted
    interruption points
N5  two EF folds; the revision retires both stale coordinates; the journal
    replays to one active anchor; a native tool call runs on the final
    checkpoint
```

N5's first fold left the in-memory decision and the rejected-outbox anchor
active. The revision had to supersede both coordinates. Superseding only the
queue coordinate left a contradictory active rejection. The final journal state
has one active anchor: the durable outbox.

## Process pilot

The authorized 24-cell fixed-context batch executed completely:

```text
24/24 cells valid; 0 provider failures; 0 scorer failures; 0 retries
173 HTTP; 233,191 input; 25,125 output; 425,585 ms
legacy contract 17/24; operational 17/24; accepted finish 8/24
```

The legacy and operational counts agree cell-for-cell. The seven failures are
artifact/verification failures, not stale-verification cases.

| case | arm | P0 operational | P1 operational |
|---|---|---:|---:|
| B2 | B1 | 3/3 | 2/3 |
| B2 | S | 2/3 | 1/3 |
| D1-v2 | B1 | 1/3 | 3/3 |
| D1-v2 | S | 2/3 | 3/3 |

```text
P1-P0 under B1   +1/6 (+16.7 pp)
P1-P0 under S     0/6
interaction      -1/6 (-16.7 pp)
```

The prompt is not a uniform fix. It helps D1's artifact delivery (3/6 -> 6/6)
and does not help B2's protocol-heavy path (5/6 -> 3/6). B2's failures remain
no-test cells: the agent reads and never reaches `run_tests`. A sentence about
deliverables cannot repair an unclosed DSML envelope.

This is E2 mechanism evidence. It is not an EF Active product effect and does
not lift the hold.

## 6. Benchmark

H1-v2 passes an independent leakage audit. The new control is `us-west-2`:
it passes the visible test and fails the hidden checker. The visible test alone
cannot substitute for the history.

S1-v1 is authored and certified. It is an authority-scope case: the staging
timeout (5) is in the workspace and passes the visible test; the production
timeout (30) is only in the transcript. A plausible 10-second value also passes
visible and fails hidden.

The held-out plan has two certified cases and four specifications:

```text
certified   H1-v2 (retrieval-trigger), S1-v1 (authority-scope)
specified   decision-override, negative-knowledge, cross-phase-dependency,
            multi-fold-supersession
```

A specification is not a case.

## 7. Product decision

```text
EF Active: deployment hold
```

The hold is unchanged. R37-D found:

- no end-to-end Active benefit;
- the R37-B contract harm direction remains;
- the C2 guard did not act in any failing cell;
- the process prompt helps D1 and does not help B2; it is not a uniform fix.

The fixed-context process result is a mechanism result, not a product result.
It does not lift the hold by itself.

## 8. What would change the decision

A new authorized end-to-end batch with:

```text
a prespecified Active benefit criterion
no process or historical harm
an adequate sample and a case-clustered analysis
a delivered state that survives the metric corrections
```

Only that, or stronger evidence of the same kind, would change the hold. A
successful process prompt or a larger step budget is not enough.

## 9. Open questions

- Why the model emits unclosed DSML envelopes under a 1,024-token follow-up
  budget.
- Whether a larger output budget or a JSON-only protocol reduces the no-valid
  rate without changing the task.
- Whether a step budget of 12 improves B2's test rate; this is a separate
  experiment.
- Whether the native N3/N4/N5 lifecycle holds in the production harness, not
  only a manual host.
- Whether the four specified held-out cases can meet the alternative control.
