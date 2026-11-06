# R37-C — C2 Trajectory Analysis

## 1. Method

Inputs:

```text
24 C2 continuation cells
24 report.json files
24 trace/record.json files
P3s strict parser for the stored model turns
stored harness counters for totals
```

The trace text is capped at 1,000 characters. The tool sequence below is the
**parsed prefix**, not necessarily the complete sequence. `finishRequests`,
`testsExecuted`, `steps`, and `toolCounts` come from the harness counters and
are authoritative.

Compact notation:

```text
L list_dir   R read_file   W write_file   T run_tests   Q recall   F finish
```

## 2. Aggregate

```text
cells                 24
contract success      19/24
task success          22/24
finish requested      13/24
never requested       11/24
guard triggered        4/24
guard assisted         1/24
contract failures      5/24
```

Trajectory archetypes:

| archetype | cells | contract |
|---|---:|---:|
| `finish-with-test` | 9 | 9/9 |
| `test-no-finish` | 8 | 6/8 |
| `guard-rejected-recovered-finish` | 1 | 1/1 |
| `guard-rejected-recovered-test` | 2 | 2/2 |
| `guard-rejected-stalled` | 1 | 1/1 |
| `protocol-stall-no-test` | 3 | 0/3 |

## 3. All 24 trajectories

| cell | contract | task | tests | steps | finish req/rej | invalid turns | parsed prefix | archetype |
|---|---|---:|---:|---:|---:|---:|---|---|
| D1-v2-S-G0-r1 | pass | pass | 1 | 4 | 1/0 | 0 | LTWRF | finish-with-test |
| B2-B1-G1-r2 | pass | pass | 1 | 8 | 0/0 | 3 | LRRRT | test-no-finish |
| B2-S-G0-r1 | pass | pass | 1 | 8 | 0/0 | 2 | LRRQT | test-no-finish |
| D1-v2-S-G1-r1 | pass | pass | 1 | 8 | 1/1 | 0 | LRRTWFRW | guard-rejected-stalled |
| B2-B1-G1-r3 | FAIL | pass | 0 | 8 | 0/0 | 7 | L | protocol-stall-no-test |
| D1-v2-B1-G1-r3 | FAIL | FAIL | 1 | 8 | 0/0 | 3 | LRRRTRR | test-no-finish |
| B2-B1-G0-r2 | FAIL | pass | 0 | 8 | 0/0 | 6 | LR | protocol-stall-no-test |
| D1-v2-S-G1-r3 | FAIL | FAIL | 1 | 8 | 0/0 | 6 | LT | test-no-finish |
| D1-v2-B1-G0-r3 | pass | pass | 1 | 2 | 1/0 | 0 | TWF | finish-with-test |
| B2-S-G1-r1 | FAIL | pass | 0 | 8 | 0/0 | 4 | LRRR | protocol-stall-no-test |
| D1-v2-B1-G0-r2 | pass | pass | 1 | 3 | 1/0 | 0 | LRRRTWF | finish-with-test |
| B2-B1-G0-r3 | pass | pass | 3 | 3 | 1/0 | 0 | LRTQQRLTRRF | finish-with-test |
| D1-v2-S-G0-r3 | pass | pass | 1 | 7 | 1/0 | 0 | LRRRRTRWF | finish-with-test |
| B2-S-G0-r3 | pass | pass | 1 | 8 | 0/0 | 4 | LRRRT | test-no-finish |
| B2-S-G0-r2 | pass | pass | 2 | 3 | 1/0 | 0 | LQRRRT | finish-with-test |
| B2-S-G1-r2 | pass | pass | 1 | 8 | 0/0 | 3 | LRRT | test-no-finish |
| D1-v2-B1-G1-r2 | pass | pass | 2 | 5 | 2/1 | 0 | LRRRTWFWTWF | guard-rejected-recovered-finish |
| D1-v2-S-G0-r2 | pass | pass | 1 | 7 | 1/0 | 1 | LRTRRWRF | finish-with-test |
| B2-S-G1-r3 | pass | pass | 1 | 5 | 1/0 | 0 | LRRLRWWTF | finish-with-test |
| B2-B1-G1-r1 | pass | pass | 2 | 8 | 0/0 | 3 | LRRRTWT | test-no-finish |
| D1-v2-B1-G1-r1 | pass | pass | 2 | 8 | 1/1 | 1 | LRRRTWFT | guard-rejected-recovered-test |
| B2-B1-G0-r1 | pass | pass | 1 | 8 | 0/0 | 3 | LRRRTQQ | test-no-finish |
| D1-v2-S-G1-r2 | pass | pass | 2 | 8 | 1/1 | 0 | LRRRTWFWTW | guard-rejected-recovered-test |
| D1-v2-B1-G0-r1 | pass | pass | 1 | 2 | 1/0 | 0 | LRTRRW | finish-with-test |

The parsed prefix can omit a final `F` when the turn was capped. For example
`B2-S-G0-r2` has `finishRequests: 1` even though the parsed prefix ends at `T`.

## 4. The five contract failures

All five never requested finish. The guard therefore had **zero opportunity**
to cause or prevent any of them.

| cell | arm/guard | tests | invalid turns | parsed prefix | failure |
|---|---|---:|---:|---|---|
| B2-B1-G0-r2 | B1/G0 | 0 | 6 | LR | no test; protocol stall |
| B2-B1-G1-r3 | B1/G1 | 0 | 7 | L | no test; protocol stall |
| B2-S-G1-r1 | S/G1 | 0 | 4 | LRRR | no test; protocol stall |
| D1-v2-B1-G1-r3 | B1/G1 | 1 | 3 | LRRRTRR | no `verification.json` |
| D1-v2-S-G1-r3 | S/G1 | 1 | 6 | LT | no `verification.json` |

The first three are **protocol/step-limit trajectories**: the agent spends its
eight steps on reads or invalid actions and never reaches `run_tests`. The last
two are **verification-artifact trajectories**: the agent runs tests but never
writes `verification.json`, so the hidden checks
`constraint.claim-known` and `constraint.tests-or-evidence` fail.

Neither failure type is a memory failure. In the D1 cases the tests ran; the
artifact was missing. In the B2 cases the task behavior passed but the process
contract failed.

## 5. Guard-triggered trajectories

Only four cells requested a finish without a fresh passing test:

| cell | rejection step | tests at rejection | final tests | second finish | outcome | archetype |
|---|---:|---:|---:|---|---|---|
| D1-B1-G1-r1 | 6 | 1 | 2 | no | contract pass, step limit | recovered-test |
| D1-B1-G1-r2 | 3 | 1 | 2 | yes | contract pass, assisted finish | recovered-finish |
| D1-S-G1-r1 | 5 | 1 | 1 | no | contract pass, step limit | stalled |
| D1-S-G1-r2 | 4 | 1 | 2 | no | contract pass, step limit | recovered-test |

The guard fired only in D1, never in B2. In B2 the agent either did not request
finish or requested it after a passing test.

The guard's observed effect is therefore:

```text
4 rejections
1 assisted finish
2 post-rejection test runs without a finish
1 no recovery
4/4 contract pass
3/4 ended at the step limit
```

It did not improve contract success in these four cells; they already passed.
It did add steps, and in three of four it consumed the remaining budget without
a final finish.

## 6. Why the intention-to-treat guard difference is not causal

The ITT table is:

```text
B1/G0  5/6 contract
B1/G1  4/6
S/G0   6/6
S/G1   4/6
```

But the trajectories show:

```text
contract failures                 5
failures with finish request      0
failures with guard rejection     0
```

A guard cannot cause a failure in a cell where it never fired. The ITT
difference is a difference in the sampled trajectories, not a guard mechanism
effect. The correct causal statement is:

```text
The guard was not given the opportunity to act in any failing cell.
The guard-triggered subset passed the contract but often exhausted the step limit.
```

## 7. B2 vs D1

| case | cells | contract | task | finish requested | guard triggered | failure type |
|---|---:|---:|---:|---:|---:|---|
| B2 | 12 | 9 | 12 | 3 | 0 | no test / protocol stall |
| D1-v2 | 12 | 10 | 10 | 10 | 4 | missing verification artifact |

B2 agents tend to keep reading and never request finish; D1 agents request
finish and are the only ones the guard can affect. This is a case-behavior
interaction, not a property of EF.

## 8. S delivery

```text
S/G0   semantic-committed 6
S/G1   semantic-committed 4
       semantic-committed-empty 1
       full-history-fallback 1
```

The two S/G1 contract failures were both `semantic-committed`; neither was a
fallback or empty commit. The delivery degradation in S/G1 is therefore not the
cause of the S/G1 contract difference.

## 9. What the trajectories imply

1. The R37-B process harm is not fixed by the finish guard. Most failing cells
   never request finish.
2. The next process intervention should target **test request / step budget**,
   not finish alone.
3. A process prompt that requires a test before finish, or a step policy that
   reserves a step for testing, is a better candidate than another guard.
4. The guard should not be bundled into the product arm. In this pilot it adds
   steps and rarely produces a second finish.
5. The C2 pilot does not replicate the R37-B harm magnitude: S/G0 is 6/6 here.
   The difference may be P3s, the two-case subset, or model variance. It is not
   evidence that EF improved.

## 10. Limitations

- Six cells per arm/guard; no significance claim.
- One model, one route, two cases.
- The trace cap means the parsed tool sequence is a prefix, not a complete
  transcript.
- The guard's per-protocol subset is selected by the agent's own finish
  behavior; it is not randomized.
- B2 and D1 have different process demands; the case mix affects the guard
  opportunity rate.
