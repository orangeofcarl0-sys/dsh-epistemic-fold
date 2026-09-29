# RC1 — Policy Normalization & Certified Economy Profile: Evaluation Report

**Branch:** `rc1-policy-normalization`
**Baseline:** `main@86f9dd9`
**Status:** normalization complete. The trigger is named, the reserve is measured,
parameters were searched by replay instead of by API, the RC0 outlier is
classified, and a **certified operating profile** exists for the measured route.
The corrected realized-cost gate is **OPEN** — the instrument is fixed, but the
verdict does not reproduce at n=8 (§6.5). The global default is **NOT** flipped —
by design, see §9.

---

## 1. What RC1 was for

RC0 ended with a precise and uncomfortable result. EF's architecture worked, and
economy typically looked cheaper — but the *shipped operating defaults were not
calibrated for it*, and one paired measurement was contaminated by provider
cache state. Two release blockers, both about **normalization** rather than
mechanism.

RC1's thesis was that neither blocker needs new compression machinery. They need
mature engineering:

```
mature rules for trigger/cache  +  offline replay for parameter calibration
+  a very small amount of live verification
```

The resource allocation that followed from that: **95% keyless/offline, 4% cache
microbench, 1% live smoke** — instead of another 24-turn × 3-workload ×
5-replicate × 100K-context soak.

Three results came out of it, and one of them invalidated earlier numbers.

---

## 2. RC1-A — the trigger is decomposed, and the reserve is measured

### 2.1 Who actually controls compaction

`resolveEfCompactSpec` computes `min(αW, W − O − H)` correctly but returns **one
number**. That hides which bound won, and the answer changes what the
configuration *means*:

```
Configured thresholdRatio: 0.80      <- what a deployment reads
Ratio-bound threshold:     104,857
Headroom-bound threshold:   65,024   <- what actually happens
Effective threshold:        65,024
Binding constraint:        headroom
Effective window fraction:  49.6%
```

A deployment reading `thresholdRatio: 0.8` believes it folds at 80% of the
window. On the routed 131,072-token window with the shipped 65,536-token
reserve, it folds at **49.6%**.

`src/trigger.ts` reports both bounds and names the binding constraint; the engine
logs it once per routed target, and the effective-config preflight carries it.
A tie is reported as `ratio`, because a tie means the reserve is *not* the
limiter — the label has to name what actually constrains.

### 2.2 The reserve, measured rather than inherited

`headroomTokens: 65536` predates every measurement in this project. The reserve
exists to absorb exactly three things (§5):

```
E+  token-meter UNDER-estimation (meter said X, provider billed X+E)
G   one-step growth between two pressure checks
M   a fixed engineering margin

H_safe = P99(E+) + P99(G) + M
```

Both terms were measured on the live route. The meter error is strongly
**shape-dependent in both directions**:

| Content shape | metered | provider | E | E/metered |
|---|---:|---:|---:|---:|
| english prose | 10,808 | 6,495 | −4,313 | **−39.9%** |
| CJK | 4,208 | 8,094 | +3,886 | **+92.3%** |
| dense JSON | 13,789 | 20,899 | +7,110 | **+51.6%** |
| source code | 17,697 | 17,694 | −3 | −0.0% |
| tool output | 26,787 | 34,894 | +8,107 | **+30.3%** |

Prose *over*-estimates by 40% (conservative — it folds earlier than needed);
CJK *under*-estimates by 92%. A fixed 4-chars-per-token heuristic cannot be
trusted across content shapes, which is precisely why the reserve must be
measured rather than assumed.

With the growth term taken from **real session trajectories** — the RC1-B
corpus, 116 observed steps across 4 traces — the result is:

```
P99 meter underestimation    8,017
P99 one-step growth            691
margin                       1,024
recommended reserve          9,733
shipped reserve             65,536   -> EXCESSIVE, 6.73x
```

**This is the first concrete answer to RC1 §39's question, and the answer is
that 65K is not necessary for this route.** RC1 §5 is explicit that the output is
a recommendation and not a new constant, so nothing was changed on this basis —
but the number now exists, with its evidence, instead of being inherited.

> **A defect found while measuring this.** The first version derived the growth
> term from the test's own payload ladder, which is not "growth between two
> pressure checks" — it is the difference between unrelated test payloads. It
> reported a P99 growth of ~19,500 tokens and inflated the recommendation to
> 28,580. The corrected source is the replay corpus, and the corrected figure is
> 691. A measurement whose input is the measuring instrument is not a
> measurement.

---

## 3. RC1-B — parameters searched by replay, at zero API cost

The rule:

```
SimPolicy == ProductionPolicy
```

the same rule R3 established as `BenchPath == ProductionPath`. The simulator
does **not** reimplement admission, break-even, or regime logic — it calls
`leafMarginalReclaim`, `compileContextPolicy` (and through it
`rootBreakEvenRequests`), and `resolveEfCompactSpec`, and owns only surface
state, growth, the fold outcome model, checkpoint cost, and cache accounting. A
test reads the module's own imports to pin that delegation structurally.

The scan's objective is deliberately **not** `argmin_α C(α)` (§16). It is a
**broad plateau**: a band of parameters within tolerance everywhere, with zero
overflow and stable fold cadence, from which the simplest mature value is
chosen.

| Candidate | Worst cost ratio | Mean cost ratio | Overflows | Longest fold run | Failed | Vacuous |
|---|---:|---:|---:|---:|---:|---:|
| alpha=0.5 | 0.935 | 0.795 | 0 | 1 | 0 | 0 |
| alpha=0.6 | 0.939 | 0.822 | 0 | 1 | 0 | 0 |
| alpha=0.7 | 0.938 | 0.852 | 0 | 1 | 0 | 0 |
| alpha=0.75 | 0.940 | 0.853 | 0 | 1 | 0 | 0 |
| alpha=0.8 | 0.931 | 0.848 | 0 | 1 | 0 | 1 |
| alpha=0.85 | 0.931 | 0.853 | 0 | 1 | 0 | 1 |
| headroom=0 | 0.931 | 0.848 | 0 | 1 | 0 | 1 |
| headroom=512 | 0.940 | 0.857 | 0 | 1 | 0 | 0 |
| headroom=1024 | 0.938 | 0.857 | 0 | 1 | 0 | 0 |
| retain=0 | 0.931 | 0.848 | 0 | 1 | 0 | 1 |
| retain=200 | 0.933 | 0.840 | 0 | 1 | 0 | 1 |
| retain=400 | 0.935 | 0.846 | 0 | 1 | 0 | 1 |

**Twelve of twelve candidates qualify**, and the recommendation is the value a
mature implementation would already have chosen — `alpha=0.8` — not a fitted
decimal. That is the robust operating region §15 asks for: the exact value does
not matter inside 0.5–0.85, so the parameter is safe to ship.

> **Three defects, each of which would have produced a comfortable answer the
> scan had not earned.**
>
> 1. At the first corpus window the traces never cycled, so both arms cost the
>    same and every candidate scored exactly **1.000**. Vacuity is now a
>    first-class gate condition and its own scan column, excluded from the mean;
>    `findPlateau` refuses to report a plateau built only on vacuous traces.
> 2. The simulator omitted `leafAvailable: false`, which the production idle
>    path sets. With a leaf available the pressure override returns `leaf`, so
>    the root question was never asked and no rebase could ever fire.
> 3. Traces begin from a seeded fixture, so replaying growth from zero never
>    reached the threshold. Traces now carry their own initial surface.

The observed traces' **measured checkpoint size is 20 tokens** — marker-only,
exactly the regime RC0 identified — which is why the state-rich synthetic regime
declares 600 and says so on the trace rather than borrowing a number.

---

## 4. RC1-C — the fixed budget is exonerated, by measurement

RC0 measured `0 roots` across 15 live runs. The tempting reading was "the budget
is blocking rebases"; the correct procedure is to ask the **production decision
function**, after every leaf and ignoring the budget gate, what it would do — and
then count how often the answer was yes while the gate said no. Nothing
executes.

Measured on the corpus:

```
samples=135  profitable=0  blocked=0  overridden=135  verdict=exonerated
```

**Zero of 135 shadow evaluations were economically profitable, and none was
suppressed.** Per RC1 §19, the 24,000-token budget is not hurting this regime
and the question is closed. A positive control (budget set above the observed
loads) proves the evaluator is not stuck on "no".

> **Two manufactured signals were found and removed while building this**, and
> both would have produced a confident wrong answer:
>
> 1. The first version counted the **action**, and reported "135 of 135
>    evaluations want a rebase". They did not — every one was a **pressure
>    override**, which is not a statement about economics at all. Profitability
>    is now read from the break-even horizon, and the override is reported
>    alongside as a separate fact.
> 2. With the shipped `compactionCost: 0` the break-even horizon is **0 for any
>    frozen load**, so the economics says "rebase" even for a 580-token prefix.
>    A suppression count computed from that is arithmetic about a free action.
>    The verdict is now three-valued and returns `inconclusive` rather than
>    indicting the budget on a degenerate cost model.

---

## 5. RC1-D — the cache contract, as a static test

Every rule here corresponds to a way the project could pay for a cache miss it
did not need, and none requires a provider call to check:

| Rule | What it prevents |
|---|---|
| prefix determinism | a timestamp, random id, or unordered iteration above the cache boundary |
| framing-section position | per-session content ahead of the constant EF section |
| recall-tool order | a session-state-dependent tool reorder invalidating the tool block |
| leaf-mutates-late | a fold rewriting messages before its own region |
| root rarity | roots rewriting the frozen prefix faster than leaves accumulate it |

The determinism check assembles the **real production path twice** and demands
byte equality of the stable portion. Every rule has a **negative control** that
injects the violation it is meant to catch, because a check that never fires is
worse than no check.

> **One finding.** The EF framing section sits at index 1, behind DSH's own
> `harness:identity` section — 50 characters in. That is *correct*: the identity
> preamble is itself constant. So the contract is "before any deployment-owned
> content", not "at index 0", and the check now compares the preceding **text**
> against the known constant preamble rather than a character offset, which would
> have encoded the section separator width as a magic number.

---

## 6. RC1-E — the cache microbench, and the adapter defect it exposed

### 6.1 The experiment

The microbench is the controlled experiment §21–§23 asks for: 4K–8K stable
prefix, a few hundred tokens of suffix, three structures, and two design choices
that remove the confound that produced RC0's outlier:

- **ABBA counterbalancing** — each arm runs first twice and second twice, so a
  systematic advantage from running second cancels instead of accumulating.
- **Independent namespaces** — each block's prefix begins with a unique token, so
  block *i* cannot hit block *i−1*'s cache. Both isolation modes are reported
  separately, because "each arm eats only its own cache" and "the real cross-run
  carryover" are different questions.

### 6.2 The finding that mattered more than the microbench

**This endpoint accepts a top-level `system` field, returns HTTP 200, and
silently ignores it.** A 240,003-character system prompt billed **13 prompt
tokens** — the size of the user message alone. Verified directly:

| Wire shape | reported prompt tokens |
|---|---:|
| top-level `system` field | **13** |
| `system`-role message | **12,007** |
| `developer`-role message | HTTP 503 (unsupported) |
| user message | 12,014 |

The system prompt must be sent as a **`system`-role message**. The consequence is
not cosmetic: **the R3 framing change earns its entire saving by moving the
checkpoint preamble *into the system prompt***, so every live measurement made
through a request that carried no system prompt was measuring the saving of a
change that never reached the model. RC0-C's full-wire numbers were taken through
exactly this path.

The adapter is fixed, a stub-fetch regression test pins the wire shape keylessly,
and the live microbench now asserts its own reported prompt is at least half the
prefix — the guard that would have caught this immediately.

### 6.3 The result

Re-run live with the fix, 144/144 requests priced, at identical prompt sizes
(4,110 / 4,110):

| Structure | Arm | Requests | Mean reuse (expected) | Mean reuse (cold) | E/B ratio |
|---|---|---:|---:|---:|---:|
| stable-append | E | 24 | 0.931 | 0.233 | |
| stable-append | B | 24 | 0.931 | 0.233 | **1.000** |
| leaf-append | E | 24 | 0.893 | 0.238 | |
| leaf-append | B | 24 | 0.893 | 0.238 | **1.000** |
| root-mutation | E | 24 | 0.933 | 0.236 | |
| root-mutation | B | 24 | 0.933 | 0.236 | **1.000** |

Two readings, both load-bearing:

1. **The RC0 `2.265` outlier classifies as PROVIDER CACHE STATE, not policy.**
   At comparable prompt sizes the two request shapes cache *identically*, so
   there is no structural difference for the ratio to be. RC1 §42's requirement
   is satisfied, and §26's rule is respected: the outlier is kept, with its
   classification and evidence, never dropped.
2. **A root mutation shows the expected cold shock** (0.236 cold vs 0.933 warm).
   That is the design, and it is now a priced quantity rather than an assumption.

`classifyAgainstBaseline` returns `policy` instead when the baseline itself shows
a deficit, so this is a measurement rather than a rubber stamp — and it stays
`unknown`, keeping the flip blocked, when the baseline is missing or
incomparable.

### 6.4 Re-running RC0-C exposed a second measurement defect

Fixing the adapter made RC0-C's full-wire numbers worth re-taking, and the
re-run found something the earlier one could not see. With the system prompt
finally arriving, the arms' **cache splits diverged sharply**:

```
E4 (economy)  m:3906/3906u  m:7517/3677u  m:11128/3704u  m:14739/3731u  ...
B1 (basic)    m:3824/240u   m:7435/139u   m:11046/166u   m:14657/193u   ...
```

The two arms issued **the same prompts and the same call counts**, yet Basic
reported ~200 uncached input tokens per request and EF ~3,600. **No policy can
cause that.** The internal control made it unambiguous: `FW-tool-heavy` folded
in *neither* arm, so its two arms issued byte-identical requests and its ratio
must be 1.000 by construction — and the run reported **1.606**.

Two design defects, both of which RC1 §22/§23 explicitly forbid and the
full-wire driver (built in RC0, before RC1) did not implement:

1. **The workloads are deterministic, so consecutive runs shared provider
   cache.** Every run of `FW-long-trajectory` produced a byte-identical prompt
   sequence, so run *n+1* inherited run *n*'s warm prefix. Fixed by giving each
   run a **cache namespace** as the first line of its seed.
2. **Arm order never changed.** Economy always ran first, so the arm that ran
   second systematically inherited the first arm's cache state. Fixed by
   **alternating the order per replicate**.

The corrected run also carries a **null-test guard**: when a workload folds in
neither arm, its ratio is asserted to be within ±10% of 1. A null test that is
not ~1 means every other ratio in the run rests on a broken instrument, and the
run now fails loudly instead of reporting them.

**This changes what the earlier RC0-C numbers mean, and it does not change the
release decision.** RC0's gate was OPEN at a CI upper bound of 1.366, measured
through a path that (a) never sent the system prompt and (b) let the arms share
cache in a fixed order — so those figures described the instrument rather than
the policy. Measured correctly, two runs of the same code give 0.965 and 1.104:
the gate is **OPEN**, for the same reason as before — dispersion — but now on a
sound instrument. §6.5 gives both runs and the correction; the RC0 report
carries a §4.4 addendum recording the finding from its own side.

### 6.5 The corrected full-wire result: the instrument is fixed, the verdict is NOT

Fixing the instrument produced a materially different first run — and then a
second run with the *same* instrument disagreed with it. Both are reported,
because the disagreement is itself the finding.

**Run 1** (4 replicates, namespaced + counterbalanced):

```
NOISE FLOOR: two identical Basic runs -> 1.004x spread
NULL TEST FW-tool-heavy: ratio 1.013   (identical requests; must be ~1)
| FW-long-trajectory | 96 | 104 | 0.11074 | 0.13659 | 0.811 |
| FW-tool-heavy      | 96 |  96 | 0.03952 | 0.03902 | 1.013 |  <- NULL
| FW-recall          | 96 | 106 | 0.08386 | 0.09028 | 0.929 |
paired ratios (n=8): 0.973, 0.973, 0.305, 0.898, 0.973, 0.896, 0.975, 0.953
mean 0.868; CI upper 0.965; wins/ties/losses 8/0/0 -> PASS
```

**Run 2** (same code, same parameters):

```
NOISE FLOOR: two identical Basic runs -> 1.005x spread
NULL TEST FW-tool-heavy: ratio 1.021
| FW-long-trajectory | 96 | 105 | 0.10514 | 0.09973 | 1.054 |
| FW-tool-heavy      | 96 |  96 | 0.01380 | 0.01352 | 1.021 |  <- NULL
| FW-recall          | 96 | 103 | 0.04765 | 0.05015 | 0.950 |
paired ratios (n=8): 0.960, 0.954, 1.351, 0.934, 0.964, 0.952, 0.944, 0.961
mean 1.002; CI upper 1.104; wins/ties/losses 7/0/1 -> OPEN
```

**What is now solid, and what is not.**

Solid, and consistent across both runs:

- **The instrument is sound.** The null test lands at 1.013 and 1.021 where the
  old driver reported 1.606, and the noise floor is ~1.005 in both. A workload
  where neither arm folds now measures ~1, as it must.
- **The economy trajectory is stable**: 12 folds and **0 rebases** across 12
  runs in both.
- **Seven of eight pairs are below 1 in both runs.** The distributions are
  tight — run 1 without its transport-failed pair: `0.973, 0.973, 0.898, 0.973,
  0.896, 0.975, 0.953`; run 2: `0.960, 0.954, 0.934, 0.964, 0.952, 0.944, 0.961`.

Not solid, and this is the honest headline:

- **The verdict does not reproduce.** 0.965 (PASS) versus 1.104 (OPEN) from
  identical code and parameters. The difference is one replicate: run 1 had a
  transport failure that depressed its mean, run 2 had `1.351` on
  `FW-long-trajectory` where run 1 had `0.811`.
- **The per-family direction flips.** `FW-long-trajectory` is 0.811 in run 1 and
  1.054 in run 2. That family is where the folds actually happen, so it is the
  family that matters — and it is not stable.
- **n=8 is too small for a verdict**, and RC0 §17's caveat applies unchanged:
  this is a deterministic paired bootstrap over the observed runs, not a
  large-sample interval. Two draws from it disagreeing by 0.14 is exactly what
  that caveat predicts.

**I over-claimed in an earlier draft of this section and am correcting it.** The
first corrected run was reported as "the gate PASSES"; a second run with the
same instrument does not reproduce it. The correct statement is:

> The instrument is fixed, the null test now behaves, and the typical pair is
> ~0.95 — but the aggregate verdict is **not determined** at this sample size.
> The gate is **OPEN**, for the same reason RC0's was: **dispersion**, not a
> typical run that is dearer.

The `0.305` in run 1 is excluded as an availability event (its economy arm
returned nothing for every request — a transport failure, not a 0.3× discount),
and the driver now excludes any pair where either arm loses more than a quarter
of its calls. Over run 1's seven valid pairs the mean is **0.949**; over run 2's
eight it is **1.002**. The exclusion is not load-bearing for the verdict — the
verdict is OPEN either way once both runs are considered — but it is
load-bearing for any single-run number.

**What would settle it.** RC0 §25's aggregate ratio (Σ C_economy / Σ C_basic) is
now reported alongside the mean-of-ratios, because it weights by spend and is
what a deployment actually pays. The path to a verdict is more replicates on the
fold-bearing family, not a longer trajectory: the disagreement is in
`FW-long-trajectory`, where 16 folds happen, and that is where the variance
lives.

---

## 7. RC1-F — two cheap live smokes

### 7.1 The fold boundary, at the real trigger

Constructed at the **shipped production configuration** (131,072 window, economy
preset), seeded to 61,370 tokens and grown past the 65,024-token threshold:

```
pre-trigger    61,370 tokens  (under threshold 65,024)
post-cross     67,379 tokens
after fold     21,359 tokens  -- folded
post-fold      cache reuse 0.000  (cold shock, as designed)
steady         cache reuse 0.986  (recovered)
0 root rebases -- reported, not required (RC1 §33)
```

§33's vacuity rule is implemented as stated: **at least one leaf** when the
trigger is crossed, and a root only when the policy says so — because at ~20
tokens per marker-only checkpoint, `0 roots` is the correct economic answer.

### 7.2 The quality smoke

Two leaf folds, and all three of §32's facts survive:

```
constraint(64)=true   supersession(90 not 30)=true   exact(PARSE-7741)=true
```

> **Three test-design defects, all of which would have produced a confident wrong
> conclusion:**
>
> 1. The provider was not registered for the engine's route, so every fold
>    **threw** `no adapter registered`. The smoke caught the exception and
>    reported `folded=false` — a harness defect reading as "the policy declined".
>    Thrown folds are now reported distinctly from refusals.
> 2. The seed was **one** 61,000-token message. `retainTokens` at the shipped
>    defaults is 20,889, so the retention walk kept the entire two-node surface
>    and `selectLeafSpan` returned null. The fold was refused by **span
>    selection**, not by admission — and a real session reaches 65,024 tokens
>    across many turns, which is what leaves a foldable prefix.
> 3. The quality smoke planted its facts as plain prose and expected them back.
>    Under `mode: economy` the preset sets `semanticMode: 'none'`, so checkpoints
>    are **marker-only**: state survives a fold because it was *declared as an
>    anchor*, not because a summary mentioned it. The smoke was testing a
>    mechanism the economy preset deliberately does not use. Facts are now
>    declared through the real authority gate, and the exact error code is
>    planted as a **tool result**, because `empirical` authority is correctly
>    refused when cited only to prose.

---

## 8. RC1-G — the certified operating profile

RC1 §34 is the stage's most important contraction. The live evidence comes from
**one** DeepSeek-compatible route, and cache economics are strongly
provider-dependent. So the deliverable is not "economy should be the global
default" — it is a **certified profile for the route that was actually measured**.

```
deepseek / deepseek-*flash*  (as of 2026-09-29)
  Certified: yes
  Trigger:   thresholdRatio 0.8, safety reserve 9,733 tokens
  Cache:     automatic, prefix deterministic (measured), reuse ratio 1.000
  Price:     structural baseline measured at comparable shape
  Quality:   non-inferior (inherited from R4-E and RC1-F)
```

Three rules make it a claim rather than a promotion:

1. **An uncertified route is not certified by omission.** `certifiedProfileFor`
   returns `undefined`, and `recommendedMode` answers `legacy` — never
   `economy` — for anything unmeasured. Guessing in the cheap direction is how a
   "cost saving" ships as a regression.
2. **Every claim cites its evidence**, and the evidence *kind* is typed:
   `measured` / `inherited` / `unevidenced`. Quality is `inherited` and labeled
   so, because RC1 changes *when* a fold happens, not what a checkpoint contains.
3. **The profile does not change behavior.** It is data. Production `src/` gained
   only the trigger diagnostic; `mode: economy` remains a user's explicit choice.

---

## 9. Release decision

RC1 §44 asks whether the conditions for certification are met. They are, for the
measured route:

| Component | Status | Evidence |
|---|---|---|
| Trigger named | **satisfied** | binding constraint reported; 49.6% vs 80% configured |
| Reserve measured | **satisfied** | 9,733 recommended vs 65,536 shipped (6.73×) |
| Parameter plateau | **satisfied** | 12/12 candidates qualify; `alpha=0.8` recommended |
| Budget exonerated | **satisfied** | 0 profitable-but-blocked of 135 evaluations |
| Cache contract | **satisfied** | determinism, position, tool order, fold geometry |
| Outlier classified | **satisfied** | provider cache state, at comparable shape, reuse ratio 1.000 |
| Fold boundary | **satisfied** | real trigger crossed; cold shock 0.000 → recovery 0.986 |
| Quality | **satisfied** | 2 folds, 3/3 facts, supersession included |
| Cost (realized) | **OPEN** | instrument fixed (null test 1.021, was 1.606); CI upper **1.104**, and a second run gives 0.965 — the verdict does not reproduce at n=8 (§6.5) |
| Certified profile | **satisfied** | `deepseek/deepseek-*flash*` |

**Per §45, the global default is NOT flipped.** The correct release posture is:

> **Economy is the recommended and certified mode for the validated route.**

A global automatic default waits for multi-provider certification. §36's future
`mode: auto` is therefore already specified by the code — `certified → economy`,
`unknown → legacy` — and deliberately not implemented yet.

Two open items are recorded rather than closed.

1. **The certified reserve (9,733) is 6.73× smaller than the shipped default
   (65,536), and the shipped default is what binds the trigger to 49.6% of the
   window.** Changing it would move the product into the regime R3/R4 measured,
   but it is a shipped-behavior change, so it belongs to a release decision, not
   to a normalization stage. The number and its evidence are in §2.2.
2. **The cost gate is OPEN, and the reason has changed.** It is no longer "the
   instrument is broken" — the null test now behaves (1.021 where the old driver
   said 1.606) and the noise floor is 1.005. It is **dispersion at n=8**: two
   runs of identical code give CI upper bounds of 0.965 and 1.104, and the
   per-family direction on the fold-bearing workload flips between them. §17's
   caveat applies unchanged — this is a deterministic paired bootstrap over the
   observed runs, not a large-sample interval. The way to settle it is more
   replicates on `FW-long-trajectory`, where the variance lives, and that is the
   natural next stage.

---

## 10. Frozen stages

Per §46, these are now **closed** and should not be re-litigated in future
reports. They reopen only on a new incident corpus producing corresponding
evidence.

```
M1           CLOSED / deferred by evidence
M3b          CLOSED / deferred
M4           CLOSED / deferred
M5           CLOSED / no measured need
RecallPrune  CLOSED / no measured problem
DeltaLeaf    REJECTED (R1-B gate)
```

---

## 11. Test inventory

| Suite | Tests | Live |
|---|---:|---|
| `rc1a-trigger-reserve.spec.ts` | 11 | no |
| `rc1b-policy-replay.spec.ts` | 10 | no |
| `rc1c-shadow-rebase.spec.ts` | 10 | no |
| `rc1d-cache-contract.spec.ts` | 9 | no |
| `rc1e-cache-microbench.spec.ts` | 20 | no |
| `rc1g-certified-profile.spec.ts` | 9 | no |
| `rc1a-live-reserve.spec.ts` | 1 | **yes** |
| `rc1e-live-cache.spec.ts` | 1 | **yes** |
| `rc1f-fold-smoke.spec.ts` | 2 | **yes** |

Scripts: `eval:rc1` (keyless) and `eval:rc1-live` (opt-in via `EF_LIVE=1`).
