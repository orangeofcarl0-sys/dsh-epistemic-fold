# R37-D — Operational Completion

## 1. Why a second metric

R37-B/R37-C `contractSuccess` is:

```text
functionalSuccess
&& historicalConstraintCompliance
&& processCompliance
```

`processCompliance` rejects only `testsExecuted === 0` and a false
verification claim. It does not require:

```text
the last test to pass
the last test to belong to the final source
the verification artifact to exist or be well formed
the run to terminate normally
```

So a run that executes a failing test, writes `claim: "not-verified"`, and
finishes is a legacy contract success. That is often the correct behaviour for
a diagnostic task, but it is not the same as "the work was verified and the
agent terminated cleanly".

R37-D adds a separate object. It never rewrites the legacy fields.

```text
operationalCompletion =
    artifactCorrectness
 && verificationCompleteness
 && acceptableTermination
```

## 2. The layers

### Artifact correctness

```text
functionalChecksPassed     checker executed, no agent error, no failed
                           `functionality.*` or `decision.*` check
historicalChecksPassed     no failed `constraint.*` or `state.*` check,
                           no obsolete revival, no rejected retrial
requiredArtifactsPresent   every artifact the task text requires exists
artifactSchemaValid        the artifact parses and its fields are well formed
```

### Verification completeness

```text
testsRequired
testsExecuted
lastTestPassed
lastTestFresh              the last test run's digest equals the final
                           test-input digest
freshPassingVerification   lastTestPassed && lastTestFresh
verificationEvidencePresent
verificationClaimSupported
verificationCompleteness
```

Verification completeness is **not** "the tests passed". A diagnostic task can
correctly discover that the tests fail and report `not-verified`; that is a
complete observation of the current state. The finish guard's criterion,
`freshPassingVerification`, is reported separately.

A `verified` claim is supported only by a fresh passing test. A `not-verified`
claim is never an overclaim. A missing or malformed claim fails the artifact
schema.

### Termination

```text
finishRequested
finishAccepted
stepLimitTermination
providerFailure
aborted
terminationReason      finish | step-limit | provider-failure | aborted | unknown
acceptableTermination
efficientTermination   finishAccepted
```

The termination contract is explicit per case:

```text
finish-optional   finish accepted, or a step limit after complete work.
                  Complete work at the step limit is acceptable but not
                  efficient; `efficientTermination` is false.
finish-required   only an accepted finish is acceptable.
```

The legacy cases use `finish-optional`. Their task text requires the visible
tests and, for D1/D2, `verification.json`; it does not require the finish tool.
A new benchmark that requires `finish` must say so in its contract.

## 3. C2 result

```text
rows                                      24
legacy contract successes                 19
operational completions                   16
operational + accepted finish             10
artifact correct                          22
verification complete                     16
acceptable termination                    24
```

First failing layer:

| layer | cells |
|---|---:|
| none | 16 |
| verification | 6 |
| artifact | 2 |

Legacy/new transition:

| legacy | operational | cells |
|---|---|---:|
| pass | pass | 16 |
| pass | fail | 3 |
| fail | pass | 0 |
| fail | fail | 5 |

The three legacy-pass/operational-fail cells are all stale verification:

```text
B2-S-G0-r1      test passed, source changed afterwards, step limit
B2-S-G1-r2      test passed, source changed afterwards, step limit
D1-v2-S-G1-r1   test ran, source changed afterwards, step limit
```

The two artifact failures are the D1 cells that never wrote `verification.json`
(`D1-v2-B1-G1-r3`, `D1-v2-S-G1-r3`); they were already legacy failures.

By condition:

| condition | legacy contract | operational | accepted finish |
|---|---:|---:|---:|
| B1/G0 | 5/6 | 5/6 | 4/6 |
| B1/G1 | 4/6 | 4/6 | 1/6 |
| S/G0 | 6/6 | 5/6 | 4/6 |
| S/G1 | 4/6 | 2/6 | 1/6 |

The exploratory Active difference under G0 disappears under the stricter
metric, and the guard difference under S grows. This does not turn the pilot
into a confirmatory result. It does show that the finish guard's cost is larger
when stale verification is counted.

## 4. R37-B Stage 2, descriptive only

The new metric is also applied to the 146 R37-B Stage 2 continuation rows. This
does not revise the preregistered R37-B result.

```text
rows                                      146
legacy contract successes                  83
operational completions                    74
operational + accepted finish              61
artifact correct                           95
verification complete                     104
acceptable termination                    144
```

First failing layer:

| layer | rows |
|---|---:|
| none | 74 |
| artifact | 51 |
| verification | 21 |

B1/S comparison:

| arm | rows | legacy contract | operational | accepted finish |
|---|---:|---:|---:|---:|
| B1 | 36 | 26 | 25 | 21 |
| S | 36 | 18 | 17 | 16 |

The direction and the eight-cell difference are unchanged. The new metric
removes one success from each arm, both stale verification. The Active harm
signal is therefore not an artifact of the old completion definition.

The other representation arms are reported in the artifact but are not part of
the confirmatory B1/S contrast.

## 5. Workspace digest views

`workspaceDigests(root)` returns three views:

```text
testInputDigest             source, tests, config; excludes verification.json
fullDigest                  every file, including the verification artifact
verificationArtifactDigest  the root verification.json, or null
```

`workspaceDigest(root)` remains the historical function and returns
`testInputDigest`. The values are identical to the pre-R37-D function.

Freshness uses `testInputDigest`:

```text
test passed -> source unchanged              fresh
test passed -> source modified               stale
test passed -> config modified               stale
test passed -> verification.json written     still fresh
test failed -> source unchanged              fresh observation of failure
no test                                       no verification evidence
```

The last row is why verification completeness cannot require a passing test.

## 6. What this does not establish

- The metric is descriptive. It is not a new confirmatory endpoint.
- The C2 pilot has three replicates per condition.
- The R37-B Stage 2 application is post hoc and does not change the R37-B
  decision.
- A step limit after complete work is acceptable in this contract. A benchmark
  that requires `finish` must use `finish-required` and will classify those
  runs as unacceptable termination.
- The artifact schema check is a shape check. The harness's `run_tests` records
  remain the only evidence that a test ran.

## 7. Artifacts

```text
eval/r37d/src/operational-completion.mjs
eval/r37d/operational-completion.mjs
eval/r37d/out/operational-completion.json
tests/r37d-operational.spec.ts
```
