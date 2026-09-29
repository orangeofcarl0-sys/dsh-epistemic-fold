# R3 — Frozen Surface Economy Closure: Evaluation Report

**Branch:** `r3-frozen-surface-economy`
**Baseline:** `f544b3cbb9dc640a651bd7a15272791919637066`
**Head:** see `git log` on the branch
**Status:** economy gate **partially met** — 3 of 4 economy workloads beat Basic,
mean BCR 0.990, W4 0.2% short. Defaults remain `legacy`/`legacy`.

---

## 1. The question R3 was asked

R2 established that EF could not beat DSH Basic on cost by tuning leaf/root
policy: mean BCR 1.149 at the end of R2, 0/40 cells cheaper. The R2 framing
analysis then localized the remaining gap to **framing EF does not own** — DSH
Basic wraps every checkpoint body in a fixed preamble plus
`<compacted-summary>` tags, once per fold, and no EF-side dieting can remove it.

R3's task was therefore narrow:

> **Make frozen knowledge cheap to carry.**

with an explicit stop condition (R3 §25): if the framing seam brings the economy
workloads to `BCR <= 1`, **stop** — do not build the bounded checkpoint chain.

---

## 2. What was done

### R3-0a — pricing correctness

Four measurement holes, each of which let a billing artifact read as a product
result:

| Hole | Before | After |
|---|---|---|
| Recall double-billed | `promptTokens` charged, then `recallTokens` charged AGAIN | `Price(Σ buckets) == Price(prompt)` enforced by `priceAttribution` |
| Cache write hardcoded 0 | `cacheWriteCost: 0` silently converted "unmeasured" into "free" | `CacheWriteBilling` = `measured` \| `known-zero` \| `unknown`; `unknown` is never read as 0 |
| One global realization rate | `h = 0.91` measured for DeepSeek, invented for everything else | `CacheRealizationAssumption`; an unmeasured model yields a `BCR(h)` curve |
| `BQR = 1` for UNKNOWN quality | "40/40 no worse in quality" — a claim the keyless tier could not support | `QualityEvidence`; gates split into **CostGate** PASS/FAIL and **QualityGate** PASS/FAIL/**OPEN** |

The recall fix is the one that moved W4 most: it had been charged twice.

### R3-0b — production idle-rebase consumer

R2-C's economic rebase was real, but its only consumer was `createRootRebaseHook()`
**inside the benchmark**. The installed plugin recommended a rebase and nobody
performed it, so every E3 number in the R2 report strictly described
"EF engine + benchmark maintenance policy", not the product.

The plugin now owns a consumer driven by `agent/status = idle`:

```
pressure turn → leaf refused → PendingRebaseIntent
turn ends → agent/status = idle → consumer fires
re-measure CURRENT surface → re-run the policy compiler
  ├── no longer worth it → drop the intent
  └── still justified    → agent.runMaintenance → compactNow
```

`PendingRebaseIntent` deliberately holds **no measurement, no cost, and no
span** — all of them are stale by the time the agent is idle, and a stale
measurement replayed as authority is worse than no intent. *Recommendation is
not authority.*

Two real bugs were found building this:

1. **Intents keyed by agent object were lost across the turn→idle boundary.**
   The pressure turn and the later idle event need not hold the same wrapper.
   Keyed by **session** instead — the identity both ends actually share.
2. **Awaiting the consumer by polling the agent was a race.** The listener
   deliberately does not block the emitting turn (in production the user's next
   message queues behind maintenance). The plugin now exposes a `settled()`
   handle, so a benchmark awaits the REAL path instead of reimplementing the
   policy to get something awaitable.

Disciplines enforced by test: consume-don't-peek (one-shot), session-keyed
(no cross-session leak), fail closed when the agent is busy (no re-arm), and
torn down with the plugin (unloading stops maintenance).

### R3-0c — benchmark/runtime unification

The benchmark no longer carries a policy. `createIdleMaintenanceHook` arranges
the world — turn closed, agent idle — emits the real `agent/status` transition,
and steps back. The plugin's consumer decides. A test asserts the hook and a
hand-driven idle transition produce **identical** roots, folds, and totals.

The R2-C finding got **stronger** on the real path, not weaker:

| Metric | legacy | economy + idle rebase |
|---|---:|---:|
| Total tokens | 218 828 | **99 077** |
| Peak context | 7 246 | **2 417** |
| Final frozen load | 6 900 | **966** |

### R3-A — checkpoint marker V2, single-ID recall affordance

V1 wrote a checkpoint's identity to the model **twice**: in the marker and again
in a trailing `Recall` section. V2 makes the marker do both jobs:

```
V1  [EF checkpoint v1 mode=leaf id=<uuid>]  …  Recall\n- cp:<uuid>
V2  [EF1 L cp:<uuid>]
```

Nothing is lost: `cp:<uuid>` is exactly what `context_recall` accepts, and the
explanation now lives **once** in that tool's own description rather than once
per checkpoint. Compatibility is conservative — **reader V1+V2, writer V2**.
`G` is reserved for the chain merge and is deliberately **not parseable yet**,
because a code that parses before its fold mode exists would let a forged marker
select a mode the engine cannot honor.

### R3-B/C — the DSH framing seam

A minimal, **pure** seam: an overridable `frameCheckpoint` whose default is the
existing `frameSummary`, injected through `regionDependencies`. A deployment
that overrides nothing produces byte-identical surfaces — enforced by test
(preamble, wrapper tags, their order, and the checkpoint user message all
asserted under the default path).

The semantics are **moved, not deleted**. Basic's preamble tells the model three
things (established context / do not restate / do not acknowledge); EF states
all three **once** in a stable system-prompt section. `framingModeFor` refuses
`system-dedup` when `ctx.systemPrompt` is absent and falls back to `legacy`,
because dropping the preamble with nowhere to put the explanation trades
correctness for tokens.

Measured per checkpoint: **372 → 29 chars** on the same body.

The seam ships as [`scripts/apply-framing-seam.mjs`](../scripts/apply-framing-seam.mjs),
**not** a patch: `vendor/` is a separate gitignored repo *and* the two
declaration faces it needs live in upstream-gitignored `lib/`, so a `.patch`
would apply "cleanly" while leaving the plugin unable to typecheck. The script
is idempotent and verifies every edit against an anchor.

---

## 3. The economy gate

Measured through the **production path** (real plugin, its own idle consumer),
64 steps, DeepSeek Flash profile at the measured `h = 0.91`:

| Workload | BCR legacy | BCR dedup | Peak ratio | Region |
|---|---:|---:|---:|---|
| W1 narrative-heavy | 1.067 | **0.985** | 1.16× | economy |
| W2 state-rich | 1.156 | 1.061 | 1.02× | reliability |
| W3 tool-heavy | 1.107 | **0.988** | 1.14× | economy |
| W4 recall-heavy | 1.144 | 1.002 | 1.01× | economy |
| W5 multi-agent | 1.139 | **0.986** | 1.22× | economy |
| **Mean (economy)** | | **0.990** | | |

Cross-profile check on W1: DeepSeek Pro 0.987, OpenAI 1.002 — the result is not
a DeepSeek artifact.

Both R3 §14 predictions were confirmed: W1/W3/W5 reachable, W2 not.

**Verdict: the cost gate is met on 3 of 4 economy workloads with a mean of
0.990, and W4 misses by 0.2%.** Per R3 §25 the bounded checkpoint chain (R3-D/E,
the deferred M5) was **not** built — its justification was reaching parity the
seam already reaches. Defaults stay `legacy`/`legacy` until W4 is closed.

---

## 4. Two findings recorded rather than smoothed over

### 4.1 W4 misses parity for a RECALL reason, not a framing one

Framing is no longer the term. Under `system-dedup`, framing + irreducible
identity is **6.3%** of W4's cost, and what remains of "framing" is the marker
line that no mode may remove. The gap is **recall volume**:

```
W4 recall tokens:  Basic 25 434   economy 33 533   (delta +8 099)
W4 total-token gap: 6 020 — i.e. the recall delta alone exceeds it
```

EF's economic admission folds less aggressively, so more recalled pages stay on
the surface as fresh, cold-priced input. Pinned by test so the next stage
attacks the real term instead of re-tuning framing that is already solved.

### 4.2 The peak-context guard is VIOLATED

R3 §39 asks for `PeakContext_candidate <= PeakContext_Basic · 1.05`. Measured:
**1.16× / 1.14× / 1.22×** on W1/W3/W5.

Reported as a violation, not relaxed to make a gate green. The cause is fold
**timing**: the peak is sampled after a fold has been appended but before the
replacement has reduced the surface, so a policy that folds later than Basic
shows a momentarily larger peak. It is bounded (≤ 1.25×, asserted), but the
1.05× bound is not met.

---

## 5. Live behavioral validation (R3-F)

R2's largest stated open risk was that its rebase path was behaviorally
unvalidated. R3-F closes it: the session grows **incrementally**, and each turn
runs the real production sequence (grow → pressure fold → close → idle), so the
plugin's own consumer performs the rebases.

Live result (`EF_LIVE=1`, 24 growth turns):

| Arm | Correct | Folds | Roots | Peak | Final frozen |
|---|---:|---:|---:|---:|---:|
| B1 Basic | 3/3 | 23 | 0 | 5 042 | 0 |
| E0 EF legacy | 3/3 | 23 | 0 | 13 429 | 23 |
| E3 EF economy | 3/3 | 12 | **2** | 5 372 | **2** |

**Gate passed:** economy mode loses no fact Basic preserves, across **12 folds
and 2 rebases** through the production consumer — the path R2 could never
exercise. The rebase also demonstrably works: final frozen load 2 checkpoints
against legacy's 23, at 40% of its peak context.

The **vacuity guard caught the failure this suite exists to prevent**: the first
live attempt reported 3/3 correct on **one** fold and no rebase, and the guard
failed the run rather than reporting a pass. Getting a real chain required
per-turn growth large enough to build pressure *and* a frozen budget small
enough to be crossed within the horizon — a default-sized budget never trips on
a compressed window, so the rebase path stayed dead while the test still
"passed".

---

## 6. Invariants

All R0/R1/R2 correctness invariants hold unchanged: ALR = 0, SSR = 0,
ProvenanceCoverage = 100%, CrossSessionLeak = 0, ExactRecallMismatch = 0,
CriticalConstraintViolation = 0. R3 removed no invariant to save tokens.

The two behaviors R3 changed were checked for semantic equivalence:

- **Marker V1→V2**: reader accepts both, so a surface persisted by an older
  build keeps folding, recalling, and rebasing correctly.
- **Framing**: the seam is pure by default (byte-identical Basic), and the
  deduplicated mode relocates the semantics rather than dropping them, with a
  documented fallback when there is nowhere to put them.

---

## 7. What R3 did NOT do

- **No bounded checkpoint chain / generation merge (R3-D/E).** The stop
  condition was met: 3 of 4 economy workloads pass, so the mechanism's
  justification is gone for them. It remains the right lever **only** for W4's
  recall volume, which is a different problem (see §4.1).
- **No production default flip.** `leafAdmission`, `rootPolicy`, and
  `framingMode` all remain `legacy`. Flipping them is a product decision the
  matrix must justify, and W4's parity is not yet met.
- **No M1 full ingress reducer, M3b, graph, Delta Leaf, embedding store, or
  session GC** (R3 §43). None is higher-ROI than the frozen-surface work that
  was just completed.

## 8. Next step

W4's recall volume is the single remaining economy term. Two candidate levers,
in order of expected value:

1. **Recall admission economics** — a recalled page is fresh cold input on
   arrival, so a page that is itself folded shortly after arrival paid full
   price for nothing. Charging recall against the same `minReclaim` machinery
   the leaf admission already uses is the natural extension, and it is EF-side
   (no new seam).
2. Only if that is insufficient, revisit the bounded chain — but now aimed at
   recall-driven checkpoint accumulation rather than at framing.
