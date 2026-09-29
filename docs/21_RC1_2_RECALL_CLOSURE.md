# RC1.2 — End-to-End Recall & Preset Closure: Evaluation Report

**Branch:** `rc1.2-recall-closure`
**Baseline:** `main@1da632c`
**Status:** the recall path is **proven** end-to-end, and the RC1.1 product
boundary is **corrected**. No preset change is required by this evidence.
**The three-arm live comparison in §3 was retracted in RC1.2.1** — its "Basic" arm
was not Basic. See §11.

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

**The numbers first published here were invalid and are retracted.** The "Basic"
arm was not Basic: the smoke passed `plugin: true` unconditionally and spread
`{ engine: 'basic' }` for that arm, but `createHarness` returns early on
`plugin: true`, so the spread was **dead code**. The arm was really EF with the
default policy *plus the EF recall tools*, which is why it reported
`facts retrievable 2/5` — a metric that is undefined for real Basic, which has no
Bundle and no `context_search` / `context_recall`.

The corrected comparison is in §11. What survives from this section is the
mechanism finding, which never depended on the Basic arm, and the observation
that the answer score tracks whether a `context_recall` call returned content:

| Run | chars returned | answer score |
|---|---:|---:|
| none | 6,051 | 3/3 |
| none | 6,050 | 3/3 |
| none | 6,050 | 3/3 |
| none (earlier) | 48 | 0/3 |
| none (earlier) | 245 | 0/3 |

A 48-character return is a search that found nothing; 6,000+ characters is a
successful recall. **The mechanism works; the model's tool use varies.**

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

**So price does not rule `rationale` out — at the scalar.** That conclusion is
corrected in §11.5: priced from the span it actually summarizes, `rationale` is
above parity across the whole region. The mechanism argument in §2 already
settled the decision; §11.5 shows the price argument agrees.

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
show that happening (a `48`-character search return with no `context_recall`).
So the honest claim is that economy does not *lose* the information — it makes
the model responsible for retrieving it. Whether that trade is acceptable for a
given workload is a product judgement, and the certification scopes it instead of
asserting it away. §11 measures how often the model actually takes that path.

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
EF exact-recall mechanism is closed;
comparative end-to-end quality still needs the corrected sanity run.
```

| Question | Answer |
|---|---|
| Does a marker-only surface carry undeclared prose? | **No** (RC1.1, confirmed) |
| Can the product recover it deterministically? | **Yes** — keyless proof, both semantic modes |
| Does a tool return the facts in the live loop? | **Yes** — 5/5 economy runs (§11) |
| Does the MODEL then use them as reliably as Basic? | **No** — Basic 3.00/3 with zero tool calls vs economy 2.40/3 |
| Is `rationale` required? | **No** — it costs +6.4% and recovers no better than `none` |
| Is the cost gate settled? | **No** — still OPEN on dispersion |

So the mechanism question is **closed** and the comparative-quality question is
**open but characterized**: this is a retrieval-policy / model tool-use gap, not
a storage or mechanism defect (§11.3).

---

## 11. RC1.2.1 — harness correction, and the corrected comparison

### 11.1 The bug

`createHarness` returns early on `plugin: true`. The recall smoke passed
`plugin: true` **unconditionally** and then spread `{ engine: 'basic' }` for the
Basic arm, so that spread was **dead code** and all three arms were EF:

```text
"basic"     = EF plugin + default (legacy) policy + EF recall tools
none        = EF plugin + economy + semanticMode:none
rationale   = EF plugin + economy + semanticMode:rationale
```

That is why the retracted table reported `Basic facts retrievable 2/5` — a metric
that is **undefined** for real Basic, which has no Bundle and no
`context_search` / `context_recall`. A scan of every `createHarness` call site
confirmed this was the **only** affected suite; every other site uses a
mutually-exclusive ternary.

**The harness now refuses the combination outright.** `plugin: true` and
`engine: 'basic'` are contradictory by construction — Basic is a different
compaction engine, not a plugin configuration — so `createHarness` throws with a
message naming both options and the remedy, and four keyless tests pin it
(`rc121-harness-guard.spec.ts`). A runtime guard is deliberate in addition to the
type: the failure was invisible from the return value.

### 11.2 The corrected comparison

Three arms, mutually exclusive mounts, identical window/threshold/retention,
**3 replicates** (a 5-replicate confirmation follows below):

| Arm | Answer score | Tool-returned facts | Provider calls | Cost |
|---|---:|---:|---:|---:|
| **Basic** | **3.00/3** | n/a (no EF tools) | 29 | 0.0283 |
| economy-none | 3.00/3 | 2/3 | 3 | **0.0021** |
| economy-rationale | 2.33/3 | 2/3 | 6 | 0.0181 |

and the **5-replicate confirmation**, which is the number to quote:

| Arm | Answer score | Tool-returned facts | Notes |
|---|---:|---:|---|
| **Basic** | **3.00/3** | n/a | **zero tool calls** in every run |
| economy-none | 2.40/3 | **5/5 runs** | recovery is reliable |
| economy-rationale | 2.20/3 | 4/5 runs | no better than `none` |

Two things are now measurable that were not before:

1. **True Basic needs no tools at all.** It scores 3.00/3 with `search=0,
   recall=0` in every replicate, because its summary keeps the prose on the
   surface. That is what Basic is for, and the earlier harness could not see it.
2. **EF's retrieval is reliable; its USE is variable.** A tool returned the facts
   in **5/5** economy runs — the mechanism is not the problem. The answer score
   still lands below Basic, which is the user's **Outcome B**.

### 11.3 What the result means

This is **Outcome B**, and it is a narrower finding than "EF is worse":

```text
not a storage-correctness problem  (recall returns the facts 5/5)
not a mechanism problem            (keyless proof, both semantic modes)
but a retrieval-policy / model tool-use problem
```

A model that does not call the tools gets nothing, and the runs show that
happening. So the product contract is:

> **Declared state stays hot; undeclared history remains exactly recoverable by
> recall — but recovery is the model's responsibility, not the product's.**

Economy is therefore a **retrieval-dependent low-cost mode**, not a drop-in
replacement for Basic on undeclared narrative. The cost difference is real and
large in the other direction: **0.0021 vs 0.0283, about 13×** in the n=3 sample.

**No new mechanism is warranted by this**, and none is added. Retrieval-policy
ergonomics is a model/runtime question, not an M3/M5 question, and the evidence
does not support re-opening either.

### 11.4 Three further code defects, corrected together

1. **`providerCalls` counted stream chunks, not calls.** The counter incremented
   inside the `for await` over the stream, so the name lied. It now increments
   once per `ctx.llm.stream()`; `BillingRecorder.bill.length` remains the
   authoritative provider-call count.
2. **SystemPrompt assembly swallowed failures.** The smoke caught an assembly
   error and returned `{}`, which changes the **wire shape** of a live
   measurement. RC0 and RC1 each proved with a real incident that this must fail
   loud — the R3 framing change was once measured against a request that carried
   no system prompt at all. It now throws.
3. **A failed tool execution was reported as `isError: false`.** The model
   received failure *text* while the metadata said the tool succeeded — the worst
   of both, because the model may then treat the failure message as data. The
   real `result.isError` is propagated and a thrown execution sets it.

### 11.5 Rationale cost: derived from the span, not a constant

`7,383 input / 400 output` is a real measurement, but it is **an observation at
one scale, not a constant**: `rationaleOnly()` receives the folded span plus
`RATIONALE_INSTRUCTION`, so the input grows with the span. The simulator now
derives it:

```text
T_rationale ≈ FoldSpanTokens + InstructionOverhead
```

via `rationaleInputFor(foldSpanTokens)`, falling back to the scalar only when no
span is known.

**And deriving it changed the conclusion, which is the point.** At the production
window the foldable span is ~44,135 tokens, not the 6,000 the scalar was measured
at, so the rationale input is ~**45,518** — over six times the 7,383 constant:

```
RATIONALE INPUT at production: foldable 44135 -> input 45518
```

With the corrected input, `rationale` is **above parity across the entire robust
region**:

| Threshold | R=0.08 | R=0.16 | R=0.24 |
|---:|---:|---:|---:|
| 104,857 | 1.028 | 1.046 | 1.063 |
| 65,536 | 1.070 | 1.135 | 1.167 |
| 49,152 | 1.116 | 1.230 | 1.425 |

*(nominal realization; optimistic and pessimistic both above 1 as well.)*

So §5's earlier reading — "price does not rule `rationale` out" — **was an
artifact of the constant**. Priced from the span it actually summarizes,
`rationale` costs **more than Basic everywhere in the region**. That is a second,
independent reason the preset keeps `semanticMode: 'none'`, and it is a stronger
one than the mechanism argument alone: the option is not merely unnecessary, it
is **more expensive than the baseline it would be trying to beat**.

---

## 12. Test inventory

| Suite | Tests | Live |
|---|---:|---|
| `rc12a-recall-loop.spec.ts` (5 keyless scoring + 1 live) | 6 | mixed |
| `rc12b-recall-mechanism.spec.ts` | 2 | no |
| `rc11b-replay-correction.spec.ts` (incl. RC1.2-C tax) | 9 | no |
| `rc11a-certification-semantics.spec.ts` | 12 | no |

At this stage: 459 keyless tests pass, 19 skipped, typecheck clean. RC1.3 and
RC1.3.1 raised the totals to 528 passing, 20 skipped.

---

## 13. Superseded by RC1.3 (retrieval ergonomics)

RC1.3 re-ran this stage's comparison un-hinted, with a per-fact failure taxonomy,
and found that §11.2's `2.40/3` was **not** the policy's ceiling. Two defects sat
underneath it, and both are now fixed:

1. **The excerpt window manufactured a `search-miss`.** `context_search` returned
   a 240-character excerpt *centred* on the match. All three facts live in one
   230-character message, so a query for the error code cut the batch-size fact
   off the front: the model received an excerpt naming the timeout and the error
   code, saw no batch limit, and answered it `unknown`. Short messages now come
   back whole, and hits report `matchKind`, a verbatim excerpt, and the
   `context_recall` page holding the match.
2. **This suite's fixture satisfied its own matchers.** `filler()` numbered its
   units in decimal, so `unit 64`, `unit 90` and `unit 30` appeared in retained
   filler — the exact tokens the matchers search for. An answer could therefore
   score a point by reading a unit index rather than the fact, and the "facts left
   the surface" premise could never hold. The filler index is now base-26 letters.

With both fixed, and one measured addition to `FOLD_FRAMING_SECTION` (search the
folded history before answering or reporting something unknown), the corrected
figures are:

| arm | this stage (§11.2) | after RC1.3 |
| --- | --- | --- |
| economy-none | 2.40/3 | **3.00/3** |
| true Basic | 3.00/3 | 3.00/3 |

So the residual gap this document attributed to **model tool use** was in fact
**retrieval ergonomics** — a product-side return-shape defect plus an ambiguous
framing affordance, not a model limitation. The mechanism conclusion in §11.3 is
unchanged and was re-confirmed with the corrected excerpt and filler:
`semanticMode:none` recovers every fact through `context_search → context_recall`.

The numbers recorded in §11.2 remain a faithful record of what was measured then
and are **not** retracted as measurements — only the conclusion drawn from them is
superseded. The prohibition on publishing `none 3.00 vs Basic 2.40` as
Basic-vs-EF evidence stands, and is now moot: the corrected comparison is at equal
measured quality. See [RC1.3](22_RC1_3_RETRIEVAL_ERGONOMICS.md).
