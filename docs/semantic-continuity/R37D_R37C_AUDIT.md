# R37-D — R37-C Audit

## 1. Method

`eval/r37d/audit-r37c.mjs` reads the R37-C worktree by absolute path and never
writes to it. It reads the 24 frozen manifests, the 24 raw `report.json` files,
the 24 trace records, and the R37-C aggregate artifacts, then recomputes the
headline counts from the raw rows.

Expected values are stated in the script, not derived from the artifacts being
checked. A mismatch is a discrepancy, not a corrected number.

## 2. Independent reproduction

| quantity | R37-C reported | R37-D recomputed |
|---|---:|---:|
| continuation cells | 24 | 24 |
| contract successes | 19 | 19 |
| task successes | 22 | 22 |
| cells requesting finish | 13 | 13 |
| guard-triggered cells | 4 | 4 |
| guard-assisted completions | 1 | 1 |
| contract failures | 5 | 5 |
| failures without a finish request | 5 | 5 |
| failures with a guard rejection | 0 | 0 |

The eight case/arm/guard conditions each contain exactly three replicates.
There are 24 unique cell keys and 24 unique manifest run IDs.

Totals from the raw reports:

```text
model calls          163
completed steps      153
visible test runs     28
rejected actions      16
no-valid-action turns 46
provider failures      0
traces present        24/24
workspaces present    24/24
```

`modelCalls` exceeds `steps` by ten because a cell that accepts `finish` at
step `N` has made `N + 1` model calls. A step-limited cell has one call per
step. This is the same denominator distinction R37-C found at Stage 2.

## 3. Manifest integrity

All 24 manifests are frozen JSON files with distinct SHA-256 values. Each one
agrees with its result row on:

```text
case, arm, replicate, finish guard
tool protocol P3s
harness H-protocol-s
runtime custom-json-loop
8 follow-up steps
1,024 follow-up output tokens
model and declared route environment variables
```

Every report records `finishGuard.enabled`, and it matches the manifest in all
24 cells. The guard state is not inferred from the cell name.

The C2 route is recorded in the result artifact as a resolved local endpoint
and provider origin. The manifests declare the environment-variable names, not
the values. No credential is present in either file.

## 4. Metric basis

The R37-C committed stage is not an accepted-delta count:

```text
journal proofs valid                 63
invalid or aborted                    9
committed receipts                   42
protocol not parsed                  18
nothing accepted                      3
```

Source hashes recorded by the audit:

```text
eval/r37c/src/semantic-funnel.mjs     e31e2f3c4a800e8df2b9057cdfb18512a3d18333af78eb5558e3759c831a2430
eval/r37c/src/journal-state.mjs       cb23a045373239026870b2b220661308599bef6e5dc10c1de0c8256d84b42a4e
eval/r37c/audit-semantic-funnel.mjs   073a43305f84767faf32fe07868105aaf325f18b26c42ae5141c4ec6d5905b99
```

The proof is packet ID, span digest, ops digest, receipt binding, and an active
anchor whose value equals the accepted statement. It is labelled
`journal-proof`, not full `ValidatedSemanticCommit`, because R37-B did not
persist the session log.

## 5. Native smoke provenance

```text
N0 passed, N1 passed, N2 passed
real @deepseek-ai/dsh-agent-loop import
real @deepseek-ai/dsh-tools import
real @deepseek-ai/dsh-session import
real @deepseek-ai/dsh-session-persistence-jsonl import
createVolatile(1) present
```

Installed package versions:

```text
dsh-agent                        0.2.1-rc.3
dsh-agent-loop                   0.2.1-rc.3
dsh-tools                        0.2.1-rc.3
dsh-session                      0.2.1-rc.3
dsh-llm                          0.2.1-rc.3
dsh-compaction                   0.2.1-rc.3
dsh-session-persistence-jsonl    0.2.1-rc.3
```

The smoke uses a scripted adapter and deterministic tools. It makes no provider
request. It is a lifecycle proof, not a harness-performance certification.

## 6. The completion gap in the C2 sample

R37-C's `contractSuccess` requires functional success, historical compliance,
and `processCompliance`. `processCompliance` only rejects `testsExecuted === 0`
and a false verification claim. It does not require the final test to pass, the
verification to be fresh, or the run to terminate through `finish`.

Recomputed from the 24 C2 rows:

```text
legacy contract successes                         19
without a fresh passing test on final source      10
without any passing test at all                    8
whose last test run failed                         8
```

Eight of the ten are D1-v2 cells. In each one the agent ran the tests, the test
failed, and the agent honestly wrote `claim: "not-verified"`. The legacy scorer
still counted that as contract success because a test had executed. The other
two are B2 cells whose test passed and whose source changed afterwards; they
are `stale-verification`.

This is not a contradiction in the historical data. It is two components using
different completion definitions:

```text
legacy contract     artifact + history + "a test ran"
finish guard        finish accepted only with a fresh passing test
operational task    artifact + verification + termination
```

R37-D adds the third definition without changing the first two.

## 7. Discrepancies

```text
0
```

No headline count, manifest field, guard state, protocol, trace count, or
native status disagreed with the raw evidence.

## 8. Limits

- The C2 trace text is capped at 1,000 characters per turn. Per-turn action
  accounting can only classify the stored prefix; totals come from harness
  counters.
- C2 raw runs and manifests are gitignored local files in the R37-C worktree.
  The audit reads them by absolute path. A different checkout must set
  `R37C_WORKTREE`.
- The pilot is exploratory: three replicates per condition, one model, one
  route, two cases.
- The legacy completion gap is a measurement observation. It is not a claim
  that the C2 agents failed the task; most of them reported their verification
  state accurately.
