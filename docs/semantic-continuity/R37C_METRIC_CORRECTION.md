# R37-C — Semantic Funnel Metric Correction

## 1. The defect

R37-B reported `commitRecall` as:

```js
accepted.some(delta => deltaMatchesFact(delta, fact) !== undefined)
```

That is **accepted-fact matching**, not committed-fact recall. It does not
check:

```text
the fold committed
a receipt exists and is committed
the packet identity and ops digest are valid
the accepted delta has an active anchor
the anchor value is the accepted statement
the rendered checkpoint contains the fact
```

A fold-refused writer row can therefore count as if its facts were committed.

## 2. The corrected stages

The R37-C funnel keeps six stages separate:

| stage | definition |
|---|---|
| `rawMention` | the fact quote/needle/statement appears in the writer's raw output |
| `proposed` | a proposed delta matches the fact |
| `accepted` | an accepted delta matches the fact |
| `committed` | the accepted delta's state key has an **active** anchor, the anchor value equals the accepted statement, and the journal receipt is committed with a valid packet/ops digest |
| `activeState` | a current fact is committed and not superseded |
| `rendered` | the checkpoint text lexically contains the fact |

`rendered` is lexical by construction. A checkpoint is prose, so
`renderedSemantic` is `null` with an explicit reason; the audit does not claim
to prove semantic validity from text.

A missing journal is `null`, not zero. A missing writer field is `null`, not
zero. A fold refusal is a real zero committed, because the journal exists and
the receipt is aborted.

## 3. Stage 2 writer results

```text
W0 (36 rows)
  old accepted-fact recall        0.5000
  committed-fact recall           0.4444
  rendered lexical coverage       0.8333
  commit status                   committed 18, fold-refused 3,
                                  protocol-not-parsed 14, nothing-accepted 1

W1 (36 rows)
  old accepted-fact recall        0.7222
  committed-fact recall           0.5139
  rendered lexical coverage       0.8472
  commit status                   committed 24, fold-refused 6,
                                  protocol-not-parsed 4, nothing-accepted 2
```

The old W1 number overstates committed recall by 20.8 percentage points. The
gap is not a model regression; it is the metric counting accepted facts from
fold-refused rows.

Sensitivity:

```text
W1 accepted recall, valid rows only       0.7167
W1 committed recall, valid rows only      0.6167
W1 fold-refused rows                      6
W1 fold-refused accepted recall           0.5000 (accepted, never committed)
```

Even among valid rows, accepted matching overstates committed recall because a
proposal can be accepted and then not survive as the active anchor.

## 4. Accepted but not committed

14 writer rows have at least one accepted fact that is not committed:

| prompt | case / replicate | commit status | reason |
|---|---|---|---|
| W0 | C1 r4, r5, r6 | fold-refused | no active anchor |
| W1 | B2 r2, r5 | fold-refused | no active anchor |
| W1 | C1 r2, r4, r6 | fold-refused | no active anchor |
| W1 | F1 r1 | fold-refused | no active anchor |
| W1 | B2 r1, r3, r4, r6 | committed | anchor value differs |
| W1 | H1 r6 | committed | anchor value differs |

`anchor-value-differs` is not automatically a defect: when two accepted
deltas occupy the same state coordinate, only the later one can be the active
anchor. The earlier accepted statement is still not a committed current fact,
so it is not counted as one.

No accepted-but-not-committed row is counted as a committed fact.

## 5. Strict critical recall

R37-B reported `strictCriticalRecall = 0` for every writer prompt. The audit
checked whether that was a missing field silently imputed as zero:

```text
field present                 72/72
missing                        0
null value                    18 (protocol-not-parsed rows)
zero value                    54 (parsed rows)
non-zero value                 0
```

`criticalRecall` is exact-statement weighted recall, not accepted matching. The
audit independently recomputed it from accepted deltas:

```text
rows with a discrepancy        0
```

So the zero is a true exact-statement zero for parsed rows. The 18 nulls are
malformed protocol rows, not zeros. R37-B's `?? 0` aggregation hid that
distinction; the corrected report reports `null` separately.

## 6. Deterministic regression coverage

`tests/r37c-semantic-funnel.spec.ts` covers:

```text
accepted but fold-refused
committed but not rendered
committed but superseded
anchor value differs
missing journal -> null
missing writer -> null
rendered lexical but semantic validity unavailable
aggregation excludes unmeasured rows
```

The tests do not read a committed summary to decide whether the code works.

## 7. What changes in the product reading

The R37-B W1 writer number should be cited as:

```text
accepted-fact recall 0.722
committed-fact recall 0.514
rendered lexical coverage 0.847
```

not as "72% commit recall". The qualitative conclusion — the writer proposes
many facts, the fold commits fewer, and some committed facts are still not
rendered — survives. The specific number does not.
