# R36 — Writer Ablation

## Status

```text
W0-P0 (frozen R35 outputs, strict parser)      complete; no model call
W0-P1 (frozen R35 outputs, bounded recovery)   complete; no model call
W1-P0 (new prompt, real model)                 blocked: no R36 authorization
New provider requests                          0
```

The offline ablation is produced by
`node eval/r36/parser-ablation.mjs`. It reads the 16 scoreable raw writer
responses, applies P0 and P1, and passes every proposal through the real
`validateDeltas` with the real authority model and transcript. It does not run
the fold or the journal, so it reports validator acceptance, not durable commit.

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

## 4. Conditions and cost

| arm | prompt | parser | validator | model calls |
|---|---|---|---|---|
| W0-P0 | R35 W0 | P0 strict | unchanged | 0 (replay) |
| W0-P1 | R35 W0 | P1 bounded | unchanged | 0 (replay) |
| W1-P0 | W1 | P0 strict | unchanged | blocked |

`eval/r36/out/parser-ablation.json` carries per-attempt rows:
raw digest/chars, P0 proposed/accepted/refused and fact recall, P1 status and
recovery kind, validator accepted/refused, content-preservation booleans, and
the actual R35 commit status. `projectedCommit` is always
`not-measured: P1 did not run the journal/fold transaction`.

No currency is reported. R36 made no provider request.

## 5. Decision for the next run

The next writer experiment should be a paired W0-P0 / W1-P0 pilot on the same
model, route, dataset, and limits. P1 can be added as a third arm only after
the strict-parser comparison is frozen, because its effect is independent of
the prompt and would otherwise confound the prompt comparison.
