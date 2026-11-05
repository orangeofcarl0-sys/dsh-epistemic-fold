# R37-B — Decision

## 1. Did the preregistered Stage 2 run?

Yes, under `R37_B_PREREGISTRATION_AMENDMENT A1`:

```text
Stage 1   exploratory, 4 replicates per cell, complete
Stage 2   confirmatory, 6 replicates per cell, complete
Stage 1 and Stage 2 are separate; no pooling
Model     deepseek-v4.1-flash via the local omnigate2api route
Harness   H-protocol-e / P3e
Cases     A1-v2, D1-v2, B2, C1, F1, H1
```

The local gateway stopped during the first Stage 1 O2 pass. Those rows are
provider-invalid, were retried under new run IDs, and remain in the cost ledger.
The final Stage 1 and Stage 2 cells are valid except for explicitly counted
transport-invalid attempts.

## 2. What is the confirmatory result?

Stage 2, 36 assigned-arm B1/S pairs:

```text
contract success
  S   50.0%
  B1  72.2%
  difference -22.2 percentage points
  exact McNemar: 1 rescue / 9 damage, p = 0.0215
  case-clustered bootstrap 95% CI: -30.6 to -11.1 pp

task success
  S   61.1%
  B1  75.0%
  difference -13.9 pp
  exact McNemar: 2 rescue / 7 damage, p = 0.1797
  case-clustered bootstrap 95% CI: -25.0 to -2.8 pp
```

The preregistered criterion for an Active **benefit** (rescue > damage,
McNemar p < 0.05, determined delivery in at least 80% of S rows) is not met.
The observed direction is the opposite: more contract damage than rescue, with
a paired p of 0.0215.

This is a confirmatory **harm signal on the primary outcome** under this model,
route, harness, and six-case instrument. It is not a population estimate.

## 3. What caused the damage?

| case | damage | observation |
|---|---:|---|
| A1-v2 | 2 | S fails the object/string form; tests 0 or a zero-step finish |
| D1-v2 | 2 | S writes an invalid `verification.json` claim or lacks test evidence |
| B2 | 2 | S completes the task but runs no test; contract fails on process only |
| C1 | 1 | S writes a broken watcher (`module-load`) and runs no test |
| F1 | 1 | S fails `functionality.v2` and runs no test |
| H1 | 1 | S runs a test but fails `region.production`; the checkpoint contains `eu-west-2` |

Eight of nine damages are implementation/process failures: no test run, or
broken code. They are **not** evidence that the semantic checkpoint lost a fact.

B2 is the clearest process effect: all six S runs succeeded on the task, but two
did not run a test, so the contract failed. The Stage 2 harm is therefore mostly
a process-compliance effect, not a task-capability effect.

H1 is the only fact-visible, action-inconsistent damage in Stage 2. The S
checkpoint contains `eu-west-2`, the test runs, and the final client still
returns `us-east-1`; the visible test passes because it only checks the type.
H1 also produced the only Stage 2 rescue, so it is variable rather than a stable
representation failure.

## 4. Did representation matter?

Stage 2, paired contract outcomes:

```text
B2 F-S vs F-P   2 wins / 0 losses / 4 ties, p = 0.50
B2 F-N vs F-P   1 win  / 2 losses / 3 ties, p = 1.00
C1 F-S vs F-P   1 win  / 0 losses / 5 ties, p = 1.00
C1 F-H vs F-P   1 win  / 0 losses / 5 ties, p = 1.00
```

B2 structured is 2/6 better than plain and never worse, but the discordant count
is too small to separate it from noise. C1 is not sensitive to representation:
structured and full history each gain one pair, and plain loses none. The
preregistered condition for a representation claim—same direction in both cases
without a token-count explanation—is not met strongly enough. The C1 full-history
win also shows the gain is not specific to the structured form.

The representation fixtures were controlled oracle-facts interventions, not EF
writer output. No result here is a natural-writer result.

## 5. Did the writer contract hold?

```text
W0  22/36 parsed, 54 accepted, 14 refused, matched-fact recall 0.500
W1  32/36 parsed, 72 accepted,  8 refused, matched-fact recall 0.722
```

W1 is better in a second independent batch. The four W1 protocol failures are
envelope/format failures; they are not counted as fact loss.

## 6. Did P3e hold?

```text
model turns          819
valid actions       1148
rejected actions     121
invalid-action rate    9.5%
unparsed-turn rate     4.5%  (37 truncated-invoke / 819)
rejected reasons     missing-parameter 121
```

P3e rejects `write_file` without `content` instead of writing an empty file.
The preregistered unparsed-turn threshold is met. The invalid-action rate is
just under 10%; it is reported separately and is not hidden inside the task
score.

## 7. Does this change the EF Active product decision?

Yes, in the narrow sense that the previous `insufficient evidence` decision
cannot be maintained as if Stage 2 had not run.

```text
Previous: insufficient evidence for Active vs Off
Current:  Active not supported; confirmatory harm signal on contract success
```

The correct deployment posture is a **hold**, not a rollout:

- there is no evidence of Active benefit;
- the primary contract outcome is worse under Active;
- most of the harm is process/implementation, not fact loss;
- one case (H1) shows the operationalization gap the project cares about, but it
  is not stable.

This is not a claim that EF is harmful for every model, route, or task. It is a
claim that this preregistered instrument, under this model and harness, does not
support Active deployment, and the direction is negative.

## 8. What would change the decision?

1. Replicate Stage 2 on a second model and route.
2. Reduce the no-test/zero-step failures without weakening the contract; if the
   harm disappears, the current result is harness/model-specific.
3. Test a finish guard or a process prompt as a separate intervention; do not
   bundle it into Active.
4. Replicate the H1 action-inconsistency with a visible test that actually
   checks the region, or treat H1 as a benchmark limitation.
5. Run the controlled representation experiment on more cases; the current B2
   F-S signal is too small.

## 9. What remains unknown

- Whether the process-compliance harm is caused by the checkpoint, the prompt,
  or model variance.
- Whether H1's action inconsistency replicates outside one pair.
- Whether a structured representation helps beyond noise.
- Whether the harm persists on another model/route.
- Whether a real DSH native runtime changes the floor. H-native remains blocked.

## 10. Bottom line

R37-B did what it was designed to do: it separated semantic preservation,
delivery, and operationalization, and it produced a confirmatory assigned-arm
result rather than another exploratory table.

The result is negative for Active deployment:

```text
Active benefit: not supported
Contract harm signal: present
Task harm: directionally present, not significant
Mechanism: mostly process/implementation, one H1 operationalization candidate
Representation effect: not confirmed
```

The next round should not add another semantic component. It should first
determine whether the process harm is a checkpoint effect or a model/harness
effect, and it should fix the H1 visible-test/checker gap before using H1 as a
memory case.
