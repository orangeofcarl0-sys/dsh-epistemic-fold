# RC1.3 — Retrieval Ergonomics Closure

Baseline: `main@45e0ed8` (RC1.2.1 merged).
Scope: retrieval ergonomics ONLY. No compression-architecture change.

> **One-line result.** The economy preset's residual end-to-end gap was **not**
> information loss and **not** a model that refuses to retrieve: it was two
> retrieval-ergonomics defects, both now fixed. The un-hinted baseline moved from
> **2.33/3 to 3.00/3**, matching Basic, and two independent n=9 confirmations
> reproduced it. `semanticMode` stays `none`, the cost gate stays OPEN, and the
> default stays `legacy`.

---

## 1. What RC1.3 set out to do

RC1.2.1 closed the *mechanism* question — a folded fact IS reachable through
`context_search → context_recall` — and left the *quality* question open: the
model scored 2.40/3 where Basic scored 3.00/3. RC1.3's target was to close that
gap using retrieval ergonomics only, and it named four steps:

1. Establish an **un-hinted** baseline (no "use context_search" in the probe), so
   autonomous retrieval is what gets measured.
2. Classify every failure into a taxonomy, to find where the chain actually breaks.
3. Improve `context_search`'s return shape first — the priority change.
4. Only add a stable retrieval instruction if `no-search` still dominates.

Then re-verify on a small sample and stop. The rule throughout: **make one change
at a time, so the effect stays attributable.**

---

## 2. What was built

### 2.1 `context_search` now says where it matched

`SearchHit` gained four fields (`src/recall.ts`):

| field | meaning |
| --- | --- |
| `matchKind` | `id` \| `checkpoint-text` \| `message-text` \| `tool-name` |
| `matchedMessageIndex` | index of the matching archived message |
| `excerpt` | bounded verbatim text around the match |
| `exactPageOffset` | the `context_recall` page that holds the match — **superseded in RC1.3.1**, see below |
| `archiveMessages` | how many messages the checkpoint archived |

The old hit said only "this checkpoint matched", leaving the model to guess
whether the query hit the checkpoint *summary* (already on the surface — recall
would be wasted) or the raw *archive* (folded away — a targeted recall is
required). Those call for opposite actions, so the hit now says which one it was,
and `exactPageOffset` turns a recall into a direct page fetch instead of paging
from zero. The tool description was updated to match.

> **RC1.3.1 correction.** `exactPageOffset` was page-aligned for the default page
> size, so it was only ever "a page *containing* the match", and only for a caller
> that happened to use that size. `matchedMessageIndex` replaces it and is valid at
> every page size: the page BEGINS at the match. See
> [RC1.3.1](23_RC1_3_1_TEMPORAL_RETRIEVAL_GUARD.md).

### 2.2 The failure taxonomy

`eval/src/retrieval-taxonomy.ts` labels each fact by the **first link of the chain
that failed**:

```
decide to search → search hits → decide to recall → recall returns it → use it
```

Labels: `pass`, `no-search`, `search-miss`, `search-hit-no-recall`, `recall-miss`,
`recall-returned-fact-but-answer-missed`.

Two deliberate design decisions, both of which changed a conclusion:

- **`recall-miss` is a separate label and outranks every model-side failure.** It
  is the only label that would be a *product* defect rather than a model-tool-use
  outcome, so burying it under a majority of model-side labels would hide the one
  result that matters most.
- **`searchHitRelevant` and `recallRelevant` are measured from the two tools'
  separate outputs.** Collapsing them into one flag would make `recall-miss`
  unreachable, because a search hit would always satisfy the union.

`recommendedAction()` maps the dominant failure to exactly one change, so the
report cannot pick a flattering remedy after the fact.

### 2.3 The shared loop

The real agent loop moved to `tests/recall-loop.ts`, and both live suites now
drive it. RC1.2 and RC1.3 differ **only** in probe text and analysis, so a
difference between their results is attributable to the probe rather than to two
subtly different harnesses.

---

## 3. The un-hinted baseline, and the two defects it exposed

Three arms, production retention, identical window/threshold/retain:

| arm | probe | framing |
| --- | --- | --- |
| `unhinted` | states the questions only | shipped `system-dedup` |
| `hinted` | RC1.2's control, names the tools | shipped `system-dedup` |
| `unhinted-legacy` | same as `unhinted` | `legacy` (no framing section) |

The third arm exists because the shipped framing section **already names
`context_recall`**. Without it, a good un-hinted score could not distinguish "the
model retrieves on its own" from "the shipped system prompt told it to", and the
§4 decision would rest on an unmeasured premise. A keyless test pins that premise
in both directions.

### 3.1 Defect one: the excerpt window manufactured a `search-miss`

First baseline (n=5, before any fix): un-hinted **2.40/3**, and the taxonomy
reported `search-miss` on the batch-size fact in 2 runs.

A keyless diagnostic found the cause exactly. All three facts live in ONE
230-character message. A query for `error code` matched it — and the 240-character
window, *centred on the match*, cut the batch-size fact off the front. The model
received an excerpt naming the timeout and the error code, saw no batch limit, and
answered it `unknown`.

**The excerpt was manufacturing a `search-miss` out of a hit that had found the
right message.** The fix is in `excerptAround`: a message short enough to return
whole (`SEARCH_WHOLE_MESSAGE_CHARS = 600`) is returned whole, and the window
budget rose to 400. Truncating a 230-character message to a 240-character window
lost information while saving nothing.

A keyless test now pins the end-to-end case: searching for one fact must not hide
the message's other facts.

### 3.2 Defect two: the fixture was satisfying its own matchers

The premise check — "did the facts actually leave the surface?" — fired with one
fact visible in **every** run of **every** arm, including `legacy`.

The cause was mine: `filler()` numbered its units in decimal, so a 250-unit block
contained `unit 64`, `unit 90` and `unit 30` — the exact tokens the fact matchers
search for. A retained tail of filler made `\b64\b` match the surface. Two
consequences: the premise could never hold, and an answer could score a point by
reading a unit index rather than the fact. The filler's index is now base-26
letters, and a keyless test asserts filler can never satisfy a fact matcher.

This is worth recording because the same filler is used by RC1.2's suite: the
confound was present there too, and the premise check is what caught it.

### 3.3 The corrected baseline

With both defects fixed, n=9:

| arm | mean | search calls | primary failures |
| --- | --- | --- | --- |
| `unhinted` | **2.33/3** | 3,3,3,3,3,0,6,0,3 | `no-search` ×2 |
| `hinted` | **3.00/3** | 3 per run | none |
| `unhinted-legacy` | **0.00/3** | 0 per run | `no-search` ×9 |

Two findings, both decisive:

- **`no-search` is the ONLY failure mode.** Every run that searched answered every
  fact. There is no `recall-miss` anywhere — no product-side retrieval defect.
- **The framing section is the affordance that drives searching.** 7/9 runs
  searched with it, 0/9 without it. This is reported as a *bound* rather than an
  isolation: `legacy` also changes per-checkpoint framing and folds a different
  number of times (8 vs 14), so the two arms differ in more than the section.

The taxonomy's own rule then applied: a majority of failures were `no-search`, so
**add a stable retrieval instruction** — and nothing else.

---

## 4. The change

One change, in `FOLD_FRAMING_SECTION` (`src/framing.ts`):

> When the current surface does not carry information you need — an earlier
> decision, value, or detail that is not visible above — search the folded history
> with context_search before answering, and before reporting that something is
> unknown.

It states the behavior the model was **already mostly following** (7/9), making
the existing affordance explicit. It stays a single constant, so it remains in the
cacheable prefix: a rule that varied per request would cost more than it saves,
which is the entire point of `system-dedup` framing. It deliberately does **not**
restate "you have tools" — the tool schemas already say that, and duplicating them
would stop this being the minimal change the taxonomy called for.

### 4.1 Measured effect

| measurement | before | after |
| --- | --- | --- |
| un-hinted, n=9, run A | 2.33/3 | **3.00/3** (search 9/9) |
| un-hinted, n=9, run B (independent) | — | **3.00/3** (search 9/9) |
| hinted, n=9 | 3.00/3 | 3.00/3 (delta 0.00) |
| RC1.2 economy-none, n=5 | 2.40/3 | **3.00/3** |
| RC1.2 true Basic, n=5 | 3.00/3 | 3.00/3 |

Economy-none now **matches Basic** on this probe. The hint is worth **0.00** —
with the rule in place, the un-hinted probe is indistinguishable from the hinted
one, which is the desired end state: a deployment does not need to tell the agent
how to use its own tools.

Cost on the n=5 RC1.2 sample: economy-none **0.00166** vs Basic **0.02778** per
run — still roughly **17×** cheaper, now at equal measured quality.

---

## 5. What this does and does not establish

**Establishes.** On this workload and route, the economy preset's end-to-end
narrative quality is **not** lower than Basic's, once the model actually searches.
The residual gap in RC1.2.1 was a retrieval-ergonomics problem with two causes,
both fixed and both pinned keylessly.

**Does not establish.** Three limits, stated plainly:

1. **n is small and the probe is one shape.** Three facts in one message, one
   window, one route. The 2.33 → 3.00 step rests on 2 runs out of 9, which is
   within noise; the honest reading is "the failure mode is closed and no failure
   mode remains", not "a precise effect size was measured".
2. **Basic's arm is not quality-equivalent in general.** Basic answers from a
   lossy summary it keeps verbatim; economy answers by retrieving. They match on
   *this* probe because this probe's facts survive Basic's summary. RC1 §46's
   comparison limits still apply.
3. **The cost gate is still OPEN.** Nothing here touched it.

**Product positioning, per RC1.3 §4.** Economy is best described as a
**retrieval-dependent low-cost mode** — one that, after RC1.3, is no longer
measurably behind Basic on this probe. It is still not promoted to a generic
default replacement: the cost recommendation remains open and the default remains
`legacy`.

---

## 6. State after RC1.3

```
semanticMode            = none            (unchanged; nothing required rationale)
M1 / M3b / M4 / M5      = CLOSED          (untouched)
compression architecture= UNCHANGED
cost gate               = OPEN            (dispersion, n=8)
mechanicsCertified      = true
economyRecommended      = false
default                 = legacy
retrieval quality       = CLOSED          (this stage)
```

---

## 7. Files

| file | change |
| --- | --- |
| `src/recall.ts` | `SearchHit` gains `matchKind` / `matchedMessageIndex` / `excerpt` / `exactPageOffset` / `archiveMessages`; `excerptAround` returns short messages whole (`exactPageOffset` later replaced by RC1.3.1) |
| `src/tools.ts` | `context_search` description documents the hit as a pointer to recall |
| `src/framing.ts` | `FOLD_FRAMING_SECTION` gains the retrieval rule |
| `eval/src/retrieval-taxonomy.ts` | NEW — the five-link classifier and the one-change remedy map |
| `tests/recall-loop.ts` | NEW — the shared real agent loop, facts, matchers, and digit-free filler |
| `tests/rc13-retrieval-ergonomics.spec.ts` | NEW — 28 keyless tests |
| `tests/rc13a-live-retrieval.spec.ts` | NEW — the un-hinted baseline, attribution control, and taxonomy report |
| `tests/rc12a-recall-loop.spec.ts` | now drives the shared loop; filler confound removed |

---

## 7b. Test inventory

| Suite | Tests | Live |
| --- | ---: | --- |
| `rc13-retrieval-ergonomics.spec.ts` (hit shape, excerpt, taxonomy, sibling facts) | 28 keyless | no |
| `rc13a-live-retrieval.spec.ts` (probe hygiene, matcher guards, framing premise, retrieval rule) | 16 keyless + 1 live | mixed |
| `rc12a-recall-loop.spec.ts` (scoring pins, live three-arm) | 6 keyless + 1 live | mixed |
| `recall-loop.ts` (shared loop, facts, matchers, filler) | — | — |

At this stage: 508 keyless tests pass, 20 skipped, typecheck clean. RC1.3.1 raised
the totals to 528 passing (its 20-test temporal guard).

---

## 8. Corrections to earlier stages

- **RC1.2's `2.40/3` is superseded by `3.00/3`.** The earlier figure was measured
  before the excerpt fix, and its fixture carried the filler-digit confound.
  `docs/21` §11's numbers remain a faithful record of what was measured then; this
  document supersedes the *conclusion* drawn from them.
- **RC1.2.1's framing stands.** True Basic is 3.00/3 with zero tool calls; the
  `none 3.00 vs Basic 2.40` figures were never published as Basic-vs-EF evidence,
  and the corrected comparison here is at equal measured quality. The prohibition
  against publishing the old numbers as evidence remains in force.
- **The mechanism conclusion is unchanged.** `semanticMode:none` still recovers
  every fact through `context_search → context_recall`, now confirmed with the
  corrected excerpt and filler.
