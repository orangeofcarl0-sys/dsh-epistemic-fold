# R36 — R35 Evidence Audit

## Status

```text
Method                  deterministic replay of the frozen R35 artifacts
New provider requests   0
Writer attempts         17
Scoreable rows          16
Lost rows               1 (F1, pre-fix runner)
Protocol parsed         10 of 16
Protocol non-parsed     6 of 16
Raw semantic mention    100% of gold facts in every scoreable response
```

The audit is generated from `eval/r36/evidence/r35/` by
`node eval/r36/audit-r35.mjs`. The R35 run directories were read-only; the R35
worktree and its review package were not modified.

The R35 reports do **not** contain a per-run git SHA. The audit records
`gitSha: null` for every attempt and names the R35 branch HEAD at which the
artifacts were audited (`914ed317ae022ac9c5fe39f098d406b7ce03c8da`). It does not
infer a producing commit from timestamps. This is an R35 instrumentation gap,
not a value to be guessed. The writer `finishReason` was likewise not recorded;
the report carries `finishReason: null` and `finishReasonRecorded: false`, while
the raw text shows whether the closing envelope was present.

## 1. The 17 calls and the 16 rows

The initial writer-only run stopped when the fold guard rejected F1's summary.
The pre-fix runner threw before writing the row, but the provider call is in the
ledger and its output tokens are in the cost total. The corrected row set is:

| run | case | protocol | category | proposed | accepted | refused | fold | commit | raw chars | HTTP |
|---|---|---|---|---:|---:|---:|---|---|---:|---:|
| r35 partial | A1 | parsed | parsed | 4 | 4 | 0 | fold-committed | committed | 2335 | 1 |
| r35 partial | B2 | malformed | bare-json-array | 0 | 0 | 0 | fold-committed | protocol-not-parsed | 2071 | 1 |
| r35 partial | C1 | parsed | parsed | 5 | 4 | 1 | fold-committed | committed | 2233 | 1 |
| r35 partial | D1 | malformed | bare-json-array | 0 | 0 | 0 | fold-committed | protocol-not-parsed | 2271 | 1 |
| r35 partial | F1 | unknown | unknown | unknown | unknown | unknown | harness-error | unknown-lost-row | lost | 1 |
| r35 complete | A1 | parsed | parsed | 3 | 3 | 0 | fold-committed | committed | 1562 | 1 |
| r35 complete | B2 | parsed | parsed | 5 | 4 | 1 | fold-committed | committed | 2250 | 1 |
| r35 complete | C1 | parsed | parsed | 5 | 3 | 2 | fold-committed | committed | 3013 | 1 |
| r35 complete | D1 | parsed | parsed | 3 | 3 | 0 | fold-committed | committed | 1888 | 1 |
| r35 complete | F1 | malformed | bare-json-object | 0 | 0 | 0 | fold-committed | protocol-not-parsed | 2572 | 1 |
| r35 complete | H1 | malformed | bare-json-array | 0 | 0 | 0 | fold-committed | protocol-not-parsed | 2529 | 1 |
| r35 r2 | A1 | parsed | parsed | 3 | 3 | 0 | fold-committed | committed | 1681 | 1 |
| r35 r2 | B2 | malformed | bare-json-array | 0 | 0 | 0 | fold-committed | protocol-not-parsed | 2382 | 1 |
| r35 r2 | C1 | parsed | parsed | 5 | 3 | 2 | fold-committed | committed | 2455 | 1 |
| r35 r2 | D1 | parsed | parsed | 2 | 2 | 0 | fold-committed | committed | 1430 | 1 |
| r35 r2 | F1 | parsed | parsed | 2 | 1 | 1 | fold-committed | committed | 2406 | 1 |
| r35 r2 | H1 | malformed | invalid-json-syntax | 0 | 0 | 0 | fold-committed | protocol-not-parsed | 2358 | 1 |

`fold-committed` means the fold transaction completed. It does not mean the
writer's proposals became state: the `commit` column is the semantic outcome.
F1 complete and H1 complete are the clearest case — the checkpoint folded, but
the writer's envelope did not parse, so no proposal reached the validator.

## 2. The six protocol failures are not one failure

| case / attempt | category | what the bytes actually were |
|---|---|---|
| B2 partial | `bare-json-array` | a valid JSON array, missing the `{"deltas":[...]}` wrapper |
| D1 partial | `bare-json-array` | a valid JSON array, same wrapper omission |
| F1 complete | `bare-json-object` | five complete delta objects concatenated, no array |
| H1 complete | `bare-json-array` | a valid JSON array, same wrapper omission |
| B2 r2 | `bare-json-array` | a pretty-printed valid JSON array |
| H1 r2 | `invalid-json-syntax` | a stray empty key (`"quote":"Service: cache-client.",""`) after an otherwise valid array |

No scoreable response had an absent or unclosed envelope, and none was
truncated. The aggregate field `protocolMalformed` in the R35 report therefore
mixed five recoverable envelope errors with one genuine syntax error. It did
not contain any "model wrote no deltas" case.

## 3. Fact × Attempt funnel

Levels: L0 raw mention → L1 structured proposal → L2 authority-valid accepted
delta → L3 durable semantic commit → L4 checkpoint visibility. Means are over
scoreable attempts, not the best replicate.

| case | attempts | scoreable | raw | proposal | accepted | commit | direct visibility |
|---|---:|---:|---:|---:|---:|---:|---:|
| A1 | 3 | 3 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| B2 | 3 | 3 | 1.000 | 0.333 | 0.333 | 0.333 | 0.667 |
| C1 | 3 | 3 | 1.000 | 0.833 | 0.667 | 0.667 | 0.667 |
| D1 | 3 | 3 | 1.000 | 0.667 | 0.667 | 0.667 | 0.667 |
| F1 | 3 | 2 | 1.000 | 0.500 | 0.500 | 0.500 | 0.500 |
| H1 | 2 | 2 | 1.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| **overall** | **17** | **16** | **1.000** | **0.594** | **0.563** | **0.563** | **0.625** |

The important result is not the aggregate. It is the shape:

- The writer mentioned every gold fact in every scoreable raw response. H1's
  production region and C1's rejected backend were both present in the text.
- The first loss is structural: six responses did not reach L1 because of the
  envelope.
- The second loss is authority/status: seven proposals were refused. Ten
  refusals were `verification-unscoped`; seven were `authority-ungrounded`.
- H1's fact never reached L1 at all in two attempts: one bare array and one
  syntax error. Its raw mention was 1.000 and its commit recall was 0.000.
- C1's rejected-approach was refused in the complete and r2 attempts because
  the writer cited only the tool result. The accepted `decision` delta carries
  the replacement backend, but the negative fact's own coordinate is absent.

`bestReplicateOnly` values are retained in the JSON solely to show the gap
between a best replicate and the mean. They are not used as the result. For
example, B2/F1/H1 each reach 1.0 proposal recall in their best attempt while
their means are 0.333/0.500/0.000.

## 4. Handoff exposure

Every refused delta was reconstructed by index from the raw response and checked
against the handoff, the checkpoint, and the machine-state anchors.

| stage | refused | in machine state | narrative only | not visible |
|---|---:|---:|---:|---:|
| writer-only | 7 | 0 | 2 | 5 |
| continuation | 10 | 0 | 2 | 8 |
| **total** | **17** | **0** | **4** | **13** |

The four narrative-only cases are real exposure, not machine state:

- C1 complete: the `verified` finding about fs.watch losing 28/40 events was
  refused for a missing `verificationQuote`, but the Rationale still describes
  the event loss.
- F1 r2: the tool-origin rejection was refused for `authority-ungrounded`, but
  the Rationale describes the override as adversarial.
- H1 r1: a rollout fact was refused for `verification-unscoped` and still
  appeared in the Rationale.
- D1 r2: a validation-evidence rejection was refused for
  `authority-ungrounded` and still appeared in the Rationale.

No refused claim appears in `state.anchors` or in the "Changed in this fold"
machine section. The deterministic test
`R36-A5: a refused tool-origin claim never becomes machine state` drives the
real fold and asserts exactly this: the refusal is recorded, the accepted
constraint is in the machine section, the refused constraint is absent from it,
and the model's prose may carry it only in the Rationale.

This measurement does not add a Handoff Validator. The exposure is narrative
and should be treated as a residual risk, not as a committed-state defect.

## 5. Reproduction

```bash
node eval/r36/audit-r35.mjs        # writes eval/r36/evidence/r35/writer-audit.json
node eval/r36/parser-ablation.mjs  # writes eval/r36/out/parser-ablation.json
npx vitest run tests/semantic-continuity.spec.ts tests/r36-writer-contract.spec.ts
```

The replayed P0 parser reproduces the R35 validator outcome exactly: 30 accepted
and 7 refused over the same 16 proposals. That exact match is the evidence that
the audit's synthetic transcript binding did not change the validator result.

## 6. Limitations

- No per-run git SHA or writer finish reason was recorded by R35.
- F1's lost raw output cannot be recovered. It is counted as an attempt and as
  unknown, never as zero or as a semantic failure.
- The funnel's semantic matcher is deliberately looser than the scorer. It
  requires a kind-family match and either a shared evidence quote, visible
  needle, subject, or substantially shared statement vocabulary. The scorer
  remains the strict exact-statement instrument.
- The 17 refusals come from both writer-only and continuation S rows. The r2
  continuation row is marked invalid because its follow-up context used the
  empty-checkpoint fallback defect; its writer/fold content is still measured.
