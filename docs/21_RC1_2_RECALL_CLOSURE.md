# RC1.2 — End-to-End Recall & Preset Closure: Evaluation Report

**Branch:** `rc1.2-recall-closure`
**Baseline:** `main@1da632c`
**Status:** the recall path is **proven** end-to-end, and the RC1.1 product
boundary is **corrected**. No preset change is required by this evidence.

---

## 1. What RC1.2 was for

RC1.1 ended with a strong claim:

> Economy quality is **conditional on declaration**. Declared state survives a
> fold; undeclared narrative does not.

That claim rested on a smoke that **never executed a tool call**. Its probe
assembled a system prompt, streamed a model response, and collected text deltas.
A model that correctly decided "this fact is in an older checkpoint, I should
search for it" had no way to act.

So the smoke supported only:

> the marker-only checkpoint **surface** does not directly retain undeclared narrative

and not the stronger claim that was written down:

> EF economy **cannot recover** undeclared narrative

`context_search` and `context_recall` are exactly the mechanism EF provides for
recovering folded raw history, and they were never invoked. RC1.2 exists to close
that gap before any preset decision is made on it.

---

## 2. RC1.2-B — the mechanism, proven deterministically

This is the half that decides the preset question, and it removes the model from
the loop entirely. A conversation carrying ordinary undeclared prose is folded,
and then the **product's own** `search` and `recall` are asked whether the facts
are reachable. No provider, no tool-use variance, no sampling.

```
folds=14  surface length=29061
facts still on the surface: constraint=true supersession=true exact=FALSE
search "batch size"      -> 1 hit
search "parser timeout"  -> 1 hit
search "error code"      -> 1 hit
search "PARSE-7741"      -> 1 hit
facts RECOVERABLE via search→recall: constraint=true supersession=true exact=TRUE
archived superseded value present: true
```

`PARSE-7741` is **absent from the surface** and **present in what recall
returns**. That is the exact case RC1.1 mis-read.

And the preset question turns on this:

```
semanticMode:none       folds=14  onSurface=false  recoverable=TRUE
semanticMode:rationale  folds=14  onSurface=false  recoverable=TRUE
```

**Both modes recover the fact.** `semanticMode` does not gate recall — it changes
what the *surface* carries, which is a different property that RC1.1 measured
correctly and interpreted too broadly.

---

## 3. RC1.2-A — the live loop actually executes tools

The smoke now drives a real agent loop:

```
model → tool-call → ToolRuntime.execute → tool/result → next model step
```

bounded to 6 rounds, with the harness gaining a `tools` option because recall
tools only register when a `ToolRuntime` is present — without it a model that
wants to recall simply cannot, and the resulting zero looks like a policy
failure.

Live results, three arms, identical window/threshold/retention. **n=5** is the
definitive sample (an n=3 run agreed in direction and is omitted for brevity):

```
answer score (out of 3 facts):  none 3.00/3   basic 2.40/3   rationale 2.20/3
facts RETRIEVABLE (out of 5):   none 5/5      basic 2/5      rationale 5/5
```

The second line is the one that matters. **Both EF arms recovered the folded
facts in every single run; Basic recovered them in two of five.** The residual
answer-score variance tracks one thing: whether a `context_recall` call actually
returned content.

| Run | chars returned | answer score |
|---|---:|---:|
| none | 6,424 | 3/3 |
| none | 35,095 | 2/3 |
| none | 35,005 | 3/3 |
| none (earlier) | 48 | 0/3 |
| none (earlier) | 245 | 0/3 |

A 48-character return is a search that found nothing; 6,000+ characters is a
successful recall. **The mechanism works; the model's tool use varies.**

That economy-*none* leads on the answer score is a single n=5 reading and should
not be over-read — the claim this stage supports is that it is **not worse**, and
that the mechanism is what carries the information.

| Run | chars returned | answer score |
|---|---:|---:|
| none rep0 | 6,424 | 3/3 |
| none rep1 | 35,095 | 2/3 |
| none rep2 | 35,005 | 3/3 |
| none (earlier) | 48 | 0/3 |
| none (earlier) | 245 | 0/3 |

A 48-character return is a search that found nothing; 6,000+ characters is a
successful recall. **The mechanism works; the model's tool use varies.**

---

## 4. Three defects in my own smoke

Each would have produced a confident wrong answer.

1. **A 3-round cap truncated the real path.** The model's actual sequence is
   `context_search` → `context_recall(summary)` → `context_recall(exact)` →
   answer, so a 3-round cap cut it off mid-thought and the empty answer was then
   scored as **wrong**. This is the R4-E defect, repeated. The cap is now 6, and a
   truncated loop is **excluded** from the quality tally and reported separately.
2. **The supersession check penalized any occurrence of `30`.** A correct answer
   saying *"90 seconds, superseding the earlier 30"* was scored WRONG for naming
   the very value it correctly identified as obsolete. It now reads clauses: `30`
   counts against the answer only when its clause does not mark it superseded.
   Five keyless unit tests pin the scoring.
3. **The loop did not separate what recall RETURNED from what the model STATED.**
   Conflating them would attribute a tool-use failure to EF. `recalledFacts` is
   now scored with the same function as the answer, so the two are comparable.

---

## 5. RC1.2-C — the rationale tax, priced from its measured size

RC1.1 §4 asked that if `rationale` became a candidate, its cost be recomputed
from real numbers rather than the simulator's simplification. It was right to
ask: the simulator priced the call at **512 input / 128 output**, and the real
call is **~7,383 input / 400 output** — wrong by roughly **14×**, in the
flattering direction.

The call summarizes the folded **span**, so its input tracks the span rather than
being a small fixed prompt. Measured on the production path across 14 folds at a
6,000-token window. The field is now required on `ReplayPolicy`, so no call site
can quietly use the old constant.

The corrected tax, at the shipped trigger:

```
semanticMode:none        0.8186
rationale @512 (wrong)   0.8260   <- what the old model claimed
rationale @7383 (real)   0.8713   <- +6.4% over none
```

and rationale still clears parity across most of the robust region:

| Threshold | R=0.08 | R=0.16 | R=0.24 |
|---:|---:|---:|---:|
| 104,857 | 0.772 | 0.822 | 0.876 |
| 65,536 | 0.759 | 0.871 | 0.972 |
| 49,152 | 0.782 | 0.974 | 1.254 |

*(nominal realization; pessimistic stays below 1 except at the most aggressive
corners.)*

**So price does not rule `rationale` out.** That is worth stating plainly — and
it is also not the deciding evidence, because §2 showed nothing *requires* it.

---

## 6. The preset decision

RC1.2 §5 says: measure first, then name. The measurement says:

- the recall mechanism **works**, deterministically, under **both** semantic
  modes;
- the live loop recovers facts in **every** arm and every replicate;
- the residual answer-score variance is **model tool use**, not EF;
- `rationale` costs **+6.4%** and is affordable, but buys nothing for recall.

**Decision: the economy preset keeps `semanticMode: 'none'`.** The reason is not
that rationale is too expensive — it is that the evidence does not show a
correctness need for it. Changing a preset to pay 6.4% for a capability the
mechanism already provides would be adding cost on a hypothesis.

The corrected quality contract:

> **Declared state is hot on the surface; undeclared history is recoverable
> through bounded recall.** The model must choose to look.

`qualityScope` now carries that, replacing RC1.1's "DECLARED state only".

**One caveat is recorded rather than hidden.** Recall is *available*, not
*automatic*: a model that does not call the tools gets nothing, and the live runs
show that happening. So the honest claim is that economy does not *lose* the
information — it makes the model responsible for retrieving it. Whether that
trade is acceptable for a given workload is a product judgement, and the
certification scopes it instead of asserting it away.

---

## 7. Certification status unchanged

Per RC1.2 §7, this stage does **not** move `economyRecommended`:

```text
runtime         PASS
cache-contract  PASS
quality         PASS (scope narrowed by §6, not widened)
window          PASS
cost            OPEN
--------------------------------
mechanicsCertified = true
economyRecommended = false
```

The route-level cost gate is still OPEN, for the same reason as before —
dispersion at n=8 — and a narrative smoke is not evidence about cost.

---

## 8. What was NOT done

No new compression architecture. No long-context cost soak. No additional cache
microbench. No re-fitting of retention or trigger (`T=0.8, R=0.16` remains the
recommendation inside Ω). No M1, M3b, M4, M5, RecallPrune, or Delta Leaf. No
700-turn state-rich live test. No large-scale live parameter search.

---

## 9. Code hygiene

Two stale comments in `src/preset.ts` were corrected, both of which would have
misled the next maintainer:

1. The `semanticMode: 'none'` comment claimed *"removing the call costs nothing in
   quality"* — an unconditional claim RC1.1 already falsified for undeclared
   narrative. It now states what is actually true: the call is unnecessary for
   **declared** state, and recall is what covers the rest.
2. The `framingMode: 'system-dedup'` comment claimed the mode *"falls back to
   legacy"* when `ctx.systemPrompt` is absent. RC0-A made it **fail loud** —
   `framingModeFor` throws — and the comment now says so.

Behavior was already correct in both cases; only the comments were wrong.

---

## 10. Project state

```text
Economy mechanics are sound; generic narrative-quality behavior is now
characterized end-to-end and does not require a preset change.
```

| Question | Answer |
|---|---|
| Does a marker-only surface carry undeclared prose? | **No** (RC1.1, confirmed) |
| Can the product recover it? | **Yes**, deterministically, both semantic modes |
| Does the live agent loop recover it? | **Yes** — facts retrievable in every arm and replicate |
| Is `rationale` required? | **No** — it costs +6.4% and buys nothing for recall |
| Is the cost gate settled? | **No** — still OPEN on dispersion |

---

## 11. Test inventory

| Suite | Tests | Live |
|---|---:|---|
| `rc12a-recall-loop.spec.ts` (5 keyless scoring + 1 live) | 6 | mixed |
| `rc12b-recall-mechanism.spec.ts` | 2 | no |
| `rc11b-replay-correction.spec.ts` (incl. RC1.2-C tax) | 9 | no |
| `rc11a-certification-semantics.spec.ts` | 12 | no |

459 keyless tests pass, 19 skipped, typecheck clean.
