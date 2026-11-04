# R36 — Writer Ablation

## Status

```text
W0-P0 (frozen R35 outputs, strict parser)      complete; no model call
W0-P1 (frozen R35 outputs, bounded recovery)   complete; no model call
W0-P0 live control (same-time)                 executed: 6 cases, 1 replicate
W1-P0 live                                     executed: 6 cases, 1 replicate
```

The offline ablation is produced by
`node eval/r36/parser-ablation.mjs`. It reads the 16 scoreable raw writer
responses, applies P0 and P1, and passes every proposal through the real
`validateDeltas` with the real authority model and transcript. It does not run
the fold or the journal, so it reports validator acceptance, not durable commit.

The live pairs were produced by `eval/r36/run-authorized.mjs` on
`deepseek-v4.1-flash` through the local ZCode proxy. They used the same model,
route, dataset, limits, and six certified cases. The prompt was the only
intended difference: W0 (`1d13166d…`) vs W1 (`61f380ab…`).

## 1. What P1 may and may not repair

P1 accepts only an unambiguous envelope:

| input shape | P1 action |
|---|---|
| `["delta"]` | wrap as `{"deltas":["delta"]}` |
| `{delta}` | wrap as `{"deltas":[{delta}]}` |
| `{delta}{delta}` | wrap as `{"deltas":[{delta},{delta}]}` |
| missing envelope, complete JSON | wrap |
| unclosed envelope, complete JSON | wrap |
| invalid syntax (stray quote, trailing comma) | **unrecovered** |
| truncated JSON | **unrecovered** |
| any fact / kind / status / subject / evidence change | **not performed** |

The implementation is `eval/r36/writer-protocol.mjs`. It is an evaluation
ablation, not the production parser. The production `parseWriterOutput` is
unchanged.

## 2. Results

| measure | P0 | P1 |
|---|---:|---:|
| structurally available | 10/16 | 15/16 |
| already parsed | 10 | 10 |
| recovered from an envelope | 0 | 5 |
| unrecovered | 6 | 1 |
| proposed deltas | 37 | 57 |
| validator accepted | 30 | 50 |
| validator refused | 7 | 7 |
| accepted-fact recall (mean) | 0.5625 | 0.8750 |
| content changed by recovery | 0 | 0 |

Recovery kinds: 4 bare arrays, 1 concatenated object sequence.

The single unrecovered response is H1 r2's invalid JSON (`"quote":"Service:
cache-client.",""`). P1 does not repair syntax. It also does not repair a
truncated response. This is the intended boundary: a recovery that guesses at
damaged JSON would be a second, weaker parser pretending to be the first.

P0 reproduces R35 exactly: 30 accepted and 7 refused. That is a useful
cross-check — the replay transcript binding did not accidentally change the
validator's decision.

## 3. What the result means

P1 has a real, independent offline effect on the **envelope** failure mode. It
recovers 20 additional accepted deltas and lifts accepted-fact recall from
0.5625 to 0.875 on the same frozen outputs, without changing a single character
of any proposal. It therefore answers one question clearly:

> Is envelope tolerance independently valuable? Yes, for this failure set.

It does not answer the other questions:

- The 7 remaining refusals are still `verification-unscoped` (4) and
  `authority-ungrounded` (3). P1 cannot repair those; they are contract or
  authority errors, not wrapping errors.
- P1 does not improve H1's syntax-damaged attempt.
- P1 does not measure durable commit. A recovered proposal still has to pass
  the validator and then the real journal/fold transaction. The ablation
  deliberately reports no projected commit.
- P1 does not show that W1 improves model behaviour. W1-P0 needs a real call.

## 4. Live same-time W0 / W1 pilot

One replicate, six certified cases, both prompts on the same model, route,
dataset, and limits. The semantic rates use the documented funnel matcher, not
the exact-statement scorer (which reports 0 for both prompts because the writer
paraphrases).

| case | W0 protocol | W0 commit | W0 visible | W1 protocol | W1 commit | W1 visible |
|---|---|---|---:|---|---:|---:|
| A1 | bare array | no | 0 | parsed | yes | 1 |
| B2 | bare array | no | 0 | parsed | yes | 1 |
| C1 | bare array | no | 0 | parsed | yes | 0.5 |
| D1 | parsed | no (fold refused) | 0 | parsed | yes | 1 |
| F1 | bare array | no | 0 | parsed | yes | 1 |
| H1 | parsed | yes | 1 | parsed | yes | 1 |
| **summary** | **2/6 parsed** | **0.167 recall** | **0.333** | **6/6 parsed** | **0.917 recall** | **0.917** |

Counts:

```text
W0: 6 calls, 4 accepted, 0 refused, 4 bare arrays, 1 fold refusal
W1: 6 calls, 14 accepted, 1 refused (authority-ungrounded), 0 malformed
```

Observed tokens:

| prompt | calls | input | output | cache read |
|---|---:|---:|---:|---:|
| W0 | 6 | 5,977 | 2,658 | 2,304 |
| W1 | 6 | 10,057 | 2,404 | 0 |

W1's longer instruction raises input tokens; output is slightly lower. No
currency is reported.

### What the live pair shows

- The envelope effect is real and large on this set: 2/6 → 6/6 parsed, 4 → 14
  accepted deltas, commit recall 0.167 → 0.917.
- W1 still has one authority refusal: F1's tool-origin constraint remains
  `authority-ungrounded`. That is the validator doing its job, not a W1
  regression.
- W1 did not capture C1's rejected-approach as its own coordinate. It accepted
  the decision and the reliability constraint, but the negative fact is absent,
  so C1's visibility is 0.5 rather than 1.0. W1 fixed the envelope, not every
  semantic omission.
- One replicate is not a stable estimate. The O2 calibration below shows that
  agent behaviour itself varies across runs, so the W0/W1 difference should be
  read as a strong pilot signal, not a precise effect size.

## 5. Conditions and cost

| arm | prompt | parser | validator | model calls |
|---|---|---|---|---|
| W0-P0 replay | R35 W0 | P0 strict | unchanged | 0 (replay) |
| W0-P1 replay | R35 W0 | P1 bounded | unchanged | 0 (replay) |
| W0-P0 live control | W0 | P0 strict | unchanged | 6 |
| W1-P0 live | W1 | P0 strict | unchanged | 6 |

`eval/r36/out/parser-ablation.json` carries per-attempt rows:
raw digest/chars, P0 proposed/accepted/refused and fact recall, P1 status and
recovery kind, validator accepted/refused, content-preservation booleans, and
the actual R35 commit status. `projectedCommit` is always
`not-measured: P1 did not run the journal/fold transaction`.

`eval/r36/out/live-writer-analysis.json` carries the same funnel for the live
W0/W1 rows. No currency is reported. The offline arms made no provider request;
the live pair made 12.

## 6. Decision for the next run

The live pair already shows a large envelope effect, so the next writer
experiment should replicate W0/W1 at least three times on the same frozen
conditions, and only then consider adding P1 as a third arm. P1 remains an
evaluation ablation; it is not a production parser and it does not repair
authority or verification refusals.
