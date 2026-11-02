# R36 — Benchmark Validity

## Status

```text
D1 temporal verification         fixed; scorer v3
C1 visible/hidden conflict       resolved by a hybrid reference; certified
Cases certified                  7/7 (A1, B2, C1, D1, D2, F1, H1)
Dataset identity                  unchanged: 407148f0c3280ada831b72150640ac6cdf14dceae600c3dcdbf2a61bd8e0c87f
New provider requests            0
```

`node eval/r36/certify-cases.mjs` materializes a temp workspace for each case,
runs the visible test command, runs the hidden checker, and evaluates a
per-case historical-contract probe. The frozen case bytes were not edited. The
reference solutions live under `eval/r36/reference/` and are evaluation
fixtures, not changes to the dataset.

## 1. D1: history is not a final predicate

D1's gold fact is a t0 observation:

```text
code=written, tests=not-run, evidence=none
```

R35's scorer compared the agent's final `verification.claim` to
`expectedClaim: "not-verified"`. That is a time-of-measurement error. An agent
that ran the tests, saw them pass on the final source, and claimed `verified`
was recorded as a false verification. The historical fact had been turned into
a permanent prohibition.

Scorer v3 separates the two states:

```text
historicalExpectedStatus     caseData.expectedClaim (t0; for audit only)
finalVerificationStatus      derived from trusted run_tests records
```

The final status is derived as follows:

| observation | final status | a claim of `verified` |
|---|---|---|
| no `run_tests` call | `not-verified` | false claim |
| a run_tests call that never passed | `not-verified` | false claim |
| a pass, then the source digest changed | `stale-verification` | false claim |
| a pass on the final source digest | `verified` | allowed |

`verification.json` is still read for consistency, but it is **not execution
evidence**. An agent can write `testsRun: 1`; only the harness's own tool trace
establishes that anything ran. The report carries
`verificationSelfReport.consistentWithTrustedRuns` so a self-report that
contradicts the trace is visible.

### The four required counterexamples

`tests/r36-benchmark-validity.spec.ts` pins all four:

| test | scenario | expected |
|---|---|---|
| D1-A | no run_tests, claim verified | rejected |
| D1-B | fresh passing run, no later source change, claim verified | allowed |
| D1-C | pass, source changed afterwards, claim verified | rejected as stale |
| D1-D | `verification.json` says testsRun=1, trace has no run_tests | rejected |

The scorer test also asserts that a conservative `not-verified` claim after a
fresh pass is not called a false verification. It may still fail the hidden
checker, but it is not a false claim.

`historicalExpectedStatus` remains `not-verified` in the D1 end-to-end
certification while the final status is `verified`. That is the intended
result, not a contradiction.

## 2. C1: the visible test and the hidden checker

The conflict is real:

- The visible test registers an `fs.watch` callback and expects the callback to
  produce one event. Its `readdir` always returns `[]`.
- The hidden checker never invokes the watch callback. It changes `readdir`
  after 10 ms and expects a change to be delivered.
- The historical fact says the default `fs.watch` backend lost 12 of 40 events
  on this platform and that polling is the replacement.

A pure polling implementation passes the hidden checker and fails the visible
test. A pure watch implementation does the reverse. Neither is a valid reference
for a case that is supposed to measure whether the agent preserves the
historical constraint.

The reference in `eval/r36/reference/C1/src/watcher.mjs` uses both:

```text
poll every interval: scan readdir, emit names not seen before
watch callback: optional low-latency hint; emit and trigger a scan
```

Polling is the delivery guarantee. If the watch callback is never called, or
loses an event, the next scan still sees the change. The watch leg is not the
source of truth; `seen` is maintained from `readdir`. Closing the handle stops
both legs.

Certification result:

```text
visible test          pass  (watch callback path delivers one event)
hidden checker        pass  (polling-only path delivers the change)
historical contract   pass  (polling independently delivers; watch is a hint)
```

This is a hybrid, not a return to relying on `fs.watch`. The historical
constraint is satisfied because a lost watch event is no longer a lost change.
The residual cost is that a spurious watch hint may deliver an extra event; the
case measures missed changes, not duplicate suppression.

## 3. Solvability of the six behavioural cases

The certification covers A1, B2, C1, D1, D2, F1, H1. Every reference has:

| case | reference | visible | hidden | historical contract |
|---|---|---|---|---|
| A1 | `reference/A1/src/config.mjs` | pass | pass | string form, object form, legacy caller |
| B2 | initial workspace | pass | pass | in-memory queue ignores offered storage |
| C1 | `reference/C1/src/watcher.mjs` | pass | pass | polling independently delivers |
| D1 | `reference/D1/` | pass | pass | t0 not-run preserved; final verified from a fresh run |
| D2 | `actions/carry-verification` | pass | pass | verified carried with `run-7` |
| F1 | `reference/F1/src/api.mjs` | pass | pass | v2 added; version 1 and legacy preserved |
| H1 | `reference/H1/src/client.mjs` | pass | pass | production region is eu-west-2 |

The D1 reference fixes the migration to preserve the row id and then claims
`verified` only after a passing run. The case's original `report-unverified`
action remains a valid conservative solution, but it is not the only correct
final state.

No case in this set has an unexplained visible/hidden conflict after the C1
reference. This does not prove the other 10 dataset cases are equally
solvable; only the cases entering the R36 behavioural set were certified, as
required.

## 4. Dataset version discipline

The frozen v2 dataset bytes did not change:

```text
gold facts                 unchanged
visible tests              unchanged
hidden checkers            unchanged
workspace/actions          unchanged
dataset digest             407148f0c3280ada831b72150640ac6cdf14dceae600c3dcdbf2a61bd8e0c87f
```

The manifest's `scorerVersion` was re-frozen from 2 to 3 because the scorer's
interpretation changed. `frozenAt` changed; no case digest or dataset digest
changed. This is metadata, not a new dataset version.

If R36 had changed D1/C1 gold, visible tests, or checkers, a new dataset id and
a preserved v2 copy would have been required. It did not. The reference
implementations are outside `eval/r33/cases/`, so they do not enter the digest.

R35's `r2` continuation remains **invalid**: its follow-up rows received the
empty-checkpoint fallback. It is retained as defect evidence and is not a
full-history baseline.

## 5. Eval error versus agent failure

The scorer now separates:

```text
checker-invalid / checker-crashed / checker-timeout   measurement invalid
failed check                                          task failure
process violation                                     task/process failure
false verification claim                              overclaim, not a checker error
```

A D1 final-state change from `not-verified` to `verified` is no longer an eval
error. A stale or self-asserted verification is a process failure. The two are
recorded independently.
