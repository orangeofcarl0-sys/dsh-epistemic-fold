# R37-A — Benchmark Validity

## 1. Versioning rule

R37 does not edit A1 or D1. It adds `A1-v2` and `D1-v2` under `eval/r37/cases/`.
The old directories keep their bytes and their R36 scores. The v2 cases are not
pooled with the R36 pairs.

The old case digests are checked against
`eval/r37/out/baseline-manifest.json`:

```text
A1  digest unchanged
D1  digest unchanged
```

## 2. A1 — task/gold ambiguity

### What R36 did

```text
task             loadConfig({ path }) must return { source, retries: 2 }
visible test     object form only
hidden checker   object form AND legacy loadConfig('config.json')
                 both require retries: 2
```

The hidden string-form requirement was not stated in the task or exercised by
the visible test. The S checkpoint did contain the compatibility constraint, but
the agent kept the old string behavior. A1 r1 S/O1 failed
`constraint.legacy-string-api`; A1 r1 B1 passed.

This is a benchmark ambiguity, not evidence that the semantic checkpoint lost
the fact.

### What A1-v2 changes

```text
task             both the object form and the legacy string form must return
                 { source, retries: 2 }; run the visible tests
visible test     object form and string form both asserted
hidden checker   unchanged requirement
```

### Certification

```text
reference solution       visible pass, hidden pass
counterfactual           object correct, string drops retries
                         visible fail, hidden fail at constraint.legacy-string-api
old A1                   unchanged
```

## 3. D1 — artifact delivery and claim vocabulary

### What R36 did

R36 said the agent never wrote `verification.json`. The artifacts show two
different failures:

| run | artifact | claim | checker |
|---|---|---|---|
| r1 B1 | present | `failed` | `constraint.claim-known` fail |
| r1 S | present | `not verified` | `constraint.claim-known` fail |
| r2 B1 | absent | — | claim checks fail |
| r2 S | present, empty | — | claim checks fail |

The r1 files were written but used vocabulary the hidden checker does not
accept (`verified` / `not-verified`). The r2 S file was emptied because its DSML
write had no content parameter. R36's temporal scoring fix (historical t0 vs
final tool-derived status) is retained and not reimplemented.

### What D1-v2 changes

```text
task             run the visible tests
                 write verification.json with
                 { testsRun, testsPassed, claim, evidenceRef? }
                 claim is exactly verified or not-verified
                 use not-verified unless a passing run supports verified
```

The harness still does not run the tests for the agent and does not write the
artifact. The reference fixture does both.

### Certification

```text
reference solution       visible pass, hidden pass
counterfactual           broken migrate + claim verified + testsRun 0
                         hidden fail at constraint.claim-accuracy
old D1                   unchanged
```

## 4. Certification result

`node eval/r37/benchmark-validity.mjs` writes
`eval/r37/out/benchmark-validity.json`.

```text
A1-v2  visible 0, hidden 0, counterfactual visible 1 / hidden 1  certified
D1-v2  visible 0, hidden 0, counterfactual hidden 1               certified
old cases unchanged                                                true
status                                                             passed
```

The visible-test command is `node --test` with no path argument. `node --test
tests` is not a directory selector on the current Node line; it tries to load a
module named `tests` and fails. The v2 workspace scripts use the discovery form.
This is a workspace-script defect that R36's harness already avoided; the v2
package scripts no longer expose it to an agent.

## 5. What is still not certified

- No live model has seen A1-v2 or D1-v2. Certification uses a controlled
  reference, not a model result.
- The v2 cases are for R37-B; they do not retroactively change R36's scores.
- A1-v2 still requires the agent to run the visible test to discover that the
  string form returns `retries`. The rule is now stated, so a failure is an
  implementation or process failure, not a hidden-vocabulary failure.
- D1-v2 still requires the agent to choose the correct claim. The allowed
  vocabulary is now stated.
