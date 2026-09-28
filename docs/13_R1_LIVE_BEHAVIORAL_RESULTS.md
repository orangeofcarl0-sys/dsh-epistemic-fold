# R1 Live Behavioral Subset — Results

**Status: EXECUTED. The behavioral gate remains OPEN — the result is NULL.**

Baseline: R0-C `12a5842` · R1-A `ae37d44` · R1-B `7c2e21d` · R1-D/E `29eaca2`.
Run date: 2026-09-29. Route: this workspace's ZCode session model —
`deepseek-v4.1-flash` via provider `c15ab109-…` at `http://127.0.0.1:7866/v1`
(OpenAI-compatible). Reproduce with `EF_LIVE=1 npm run eval:r1-live`.

This closes the one item R0-C and R1 both left explicitly open: *does Epistemic
Fold preserve task success, not merely tokens?* The answer from this run is
**no difference was detected**, and that negative result is reported here in
full rather than deferred.

---

## 1. What was measured

A constraint is planted in early conversation, the history is folded, and the
model is then asked something whose correct answer depends on that constraint
having survived. Answers are scored by a machine check on the response text —
not by a human, not by another model.

Both arms run the **same** scenario, the **same** fold boundary, and the
**same** probe. The only difference is the checkpoint representation: EF's
structured machine-state handoff versus Basic's lossy narrative summary. The
EF arm additionally declares its facts as durable anchors through the real
authority gate, so its checkpoint genuinely carries machine state.

Four cases, 8 replicates each = 32 paired trials per arm:

| Case | Tests | EF | Basic |
|---|---|---:|---:|
| `timeout-supersession` | a superseded value must not be reused | 8/8 | 8/8 |
| `api-constraint` | a normative constraint must block a change | 8/8 | 8/8 |
| `open-failure` | an unresolved failure must be reported as open | 8/8 | 7/8 |
| `buried-value` | one exact value among 60 similar ones | 8/8 | 8/8 |
| **total** | | **32/32 (100%)** | **31/32 (97%)** |

Every run actually folded: token counts fell from ~3,400–4,400 to ~400–660, so
each probe was answered from a genuinely compacted surface, not from raw
history. That check is enforced in the harness and printed per run.

---

## 2. The honest reading

**A single miss out of 32 is not evidence of anything.** A one-trial difference
is consistent with noise; no confidence interval worth quoting separates these
arms. The correct conclusion is the null one:

> At this scale, on this model, Basic's lossy narrative summary retained every
> task-critical fact these four cases probed, and Epistemic Fold's structured
> handoff showed no measurable behavioral advantage.

This is uncomfortable for the project's premise and is stated plainly. The
entire justification for Epistemic Fold is that lossy summarization eventually
drops constraints, obligations, and verified failures that matter later. **This
run did not find that regime.** It does not show the premise is false — it
shows these four cases, at this compression ratio, on this model, do not reach
it.

What would plausibly reach it, and is not yet tested:

- **Much longer horizons.** A summary that keeps a fact after one fold may drop
  it after five; the live tier folds once.
- **Many concurrent obligations.** Four cases carry one fact each; real
  sessions carry dozens competing for summary budget.
- **Less capable or more aggressively prompted summarizers.** A strong model
  asked to summarize may simply be good at this.
- **Facts that are unremarkable at the time they appear.** Every planted fact
  here is explicitly flagged ("Hard constraint", "Note:"), which is close to
  the easiest case for a summarizer.

Until one of those is tested and shows a gap, **no production default may be
changed on the strength of EF's behavioral premise**, and R1's economic
findings must be read with that caveat attached.

---

## 3. Measured cache realization (a positive result)

Unlike the behavioral result, this one is decisive and confirms R1-A's core
correction. The provider's own accounting was read across repeated calls on an
identical stable prefix:

```
call 1: cache_miss=2813  cache_hit=0
call 2: cache_miss=253   cache_hit=2560
```

| Quantity | Value |
|---|---|
| ρ (headline hit/miss price ratio) | 0.020 |
| h (measured realization) | **0.910** |
| ρ_eff = h·ρ + (1−h) | **0.118** |
| architectural claim would have said | ρ_eff = 0.020 |

The prefix architecture called those tokens cache-warm; the provider actually
served 91% of them from cache, not 100%. **The realized effective ratio is
5.9× worse than the headline ratio.** This is exactly the error R1-A's
`effectiveRho` exists to prevent, now confirmed against a real provider rather
than argued from documentation.

It also confirms the disjoint-counter mapping matters: this endpoint folds
cache hits into `prompt_tokens`, so a naive adapter would have double-counted
the cached prefix and understated every cost.

---

## 4. A production bug found by this tier

The live behavioral subset found a real defect that no keyless test caught:

**Failure anchors rendered without their description.** `renderStructuredCheckpoint`
emitted `- [failure] live-parser-failure (open)` — an opaque id and a lifecycle
state, with the failure's `value` dropped. The model could see that *something*
was unresolved but not *what*, and on the first live run it answered "No" to
"is there a known unresolved failure in the parser module?" while the checkpoint
it was reading said otherwise.

The keyless tests did not catch this because they asserted on the anchor's
presence, not on whether the rendered line was informative. Fixed in
`src/renderer.ts` (`failureLine`), with a regression assertion in
`tests/m3a-state.spec.ts` requiring the description to appear. After the fix the
same case answered correctly.

This is the clearest argument for the live tier's existence: it found a defect
that is invisible to every deterministic check the project had.

---

## 5. Status of the gate

| Item | Status |
|---|---|
| Live route resolved from ZCode config | ✅ |
| Real provider calls, real usage accounting | ✅ |
| Cache realization `h` measured, not assumed | ✅ 0.910 |
| Behavioral comparison executed, machine-scored | ✅ 64 paired trials |
| **EF behavioral advantage demonstrated** | ❌ **NOT DEMONSTRATED (null result)** |
| Production default flip justified | ❌ **NO — blocked on a positive result** |
| Latency (TTFT, request/compaction/recall) | ⏸ not measured |

The behavioral gate stays **OPEN**, not closed and not passed. Closing it
requires finding the regime where lossy summarization demonstrably fails —
which is now the most valuable next experiment this project can run, ahead of
any further folding mechanism.
