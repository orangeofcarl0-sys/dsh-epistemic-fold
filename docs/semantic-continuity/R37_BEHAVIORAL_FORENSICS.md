# R37-A — Behavioral Forensics

## 1. Method

The unit is one assigned arm in one case replicate. The evidence is the report
row, the saved trace, the final workspace bytes, the journal, and the hidden
checker. The report separates:

```text
fact available in source
fact rendered in the actual context
observable action (file read, file written, test requested/executed)
verified outcome (checker)
earliest observable divergence
sufficient cause
unresolved hypothesis
```

It never records "the agent understood" or "the agent forgot". Visibility is a
precondition, not a mental-state claim.

## 2. B2

### r1 S — harness-protocol failure

| evidence | value |
|---|---|
| actual delivery | `semantic-committed` |
| committed anchors | in-memory queue; rejected durable outbox |
| rendered fact | present (`in-memory queue` in checkpoint) |
| files read | `src/scheduler.mjs`, `tests/scheduler.test.mjs`, `package.json` |
| file modified | `src/scheduler.mjs` |
| tests requested / observed | 1 / 1 |
| final code | keeps `mode: 'memory'`, no storage dependency |
| earliest confirmed divergence | final file retains `\`` and `\${` |
| sufficient cause | `tool-parameter-corruption` |
| checker on stored file | `module-load` fail, functionality/decision fail |
| checker after unescaping | `functionality.fifo` pass, `decision.in-memory` pass |

The model's code is consistent with the in-memory decision. The failure is in
the DSML attribute decoder, not in the checkpoint. Step 5 of the saved trace is
a truncated write prefix with no content; it is recorded as an unresolved
`unclosed-invoke-prefix`, not as a model parse error. Step 7's content is the
confirmed corrupted write.

### r2 S — no implementation, no test

| evidence | value |
|---|---|
| actual delivery | `semantic-committed` |
| rendered fact | present |
| files read | 7 |
| file modified | none |
| tests requested / observed | 0 / 0 |
| final workspace | byte-identical to initial |
| earliest divergence | no write or test during 8 steps |
| sufficient cause | `implementation-failure` |
| decision consistency | `no-observed-action` |

There is no observable action that contradicts the decision. There is also no
observable action that applies it. This is a process/implementation stop, not a
memory failure.

## 3. C1

### r1 S — fold refusal plus implementation failure

| evidence | value |
|---|---|
| assigned arm | S |
| actual delivery | `full-history-fallback` |
| fold | invalid; packet status `aborted` |
| rendered fact | present in the full-history fallback |
| files read | 5 |
| file modified | none |
| tests requested / observed | at least 1 / 3 |
| checker | `functionality.delivers-change` fail |
| earliest divergence | fold refusal |
| sufficient cause | implementation failure after fallback |

The fallback is not a semantic checkpoint. The fact was visible, but the agent
did not write a working watcher. This run must not be pooled with the 11
committed S runs.

### r2 S — committed checkpoint, polling implementation

| evidence | value |
|---|---|
| actual delivery | `semantic-committed` |
| committed anchors | includes `rejected: fs.watch` and 12/40 lost events |
| file modified | `src/watcher.mjs` |
| implementation | directory polling |
| tests observed | 2 |
| checker | pass |
| B1 | failed without a write |
| decision consistency | `action-consistent` |

This is the only candidate memory signal in the two cases. It is n=1. It is not
a product effect and does not override the A1/B2/D1 confounds.

## 4. Comparison table

| case | replicate | delivery | workspace changed | tests | first failure | sufficient cause | classification |
|---|---|---|---:|---:|---|---|---|
| B2 | r1 | semantic-committed | yes | 1 | tool-parameter-corruption | tool-parameter-corruption | harness-protocol |
| B2 | r2 | semantic-committed | no | 0 | implementation-failure | implementation-failure | implementation-correctness |
| C1 | r1 | full-history-fallback | no | 3 | validation-refusal | implementation-failure | fold-refusal-then-implementation |
| C1 | r2 | semantic-committed | yes | 2 | none | none | contract-success |

## 5. Controlled representation fixtures

The fixtures are in `eval/r37/fixtures/` and indexed by
`eval/r37/out/representation-fixtures.json`. Every fixture is labelled
`controlled/oracle-facts intervention` and states that it is not an EF writer
output.

| case | fixture | representation | token estimate | semantic equivalence |
|---|---|---|---:|---|
| B2 | F-P | plain-language facts | deterministic chars/4 | with F-S: true |
| B2 | F-S | structured facts | deterministic chars/4 | with F-P: true |
| B2 | F-N | critical facts withheld | deterministic chars/4 | false by design |
| C1 | F-H | full history | deterministic chars/4 | contains both critical facts |
| C1 | F-P | plain-language facts | deterministic chars/4 | with F-S: true |
| C1 | F-S | structured facts | deterministic chars/4 | with F-P: true |

The token figure is an estimate (`ceil(chars/4)`), not a provider token count.
The context digest is SHA-256 of the exact fixture text. The facts use only
original transcript indices; no constraint was invented.

## 6. What is confirmed and what is still a hypothesis

Confirmed from bytes:

- B2 r1's stored file fails only because of the two escape forms; decoding them
  makes the checker pass.
- B2 r2 made no workspace change and ran no test.
- C1 r1 was a refused fold with a full-history fallback; C1 r2 committed and
  passed with polling.
- D1's artifacts had two distinct problems: invalid claim vocabulary in r1 and
  missing/empty artifacts in r2.

Still hypotheses:

- why B2 r2 stopped reading without writing;
- whether P3e improves live behavior after the first corrupted write;
- whether the C1 r2 rescue generalizes beyond one pair;
- whether a plain vs structured representation changes action choice.
