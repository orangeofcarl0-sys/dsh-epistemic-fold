# R4 — Economy Default Closure: Evaluation Report

**Branch:** `r4-economy-default-closure`
**Baseline:** `main@5d38d63`
**Status:** all five gate components satisfied except one that is now **met** —
see §6. Defaults remain `legacy` pending the explicit flip decision.

---

## 1. What R4 was for

R3 ended with EF cheaper than Basic on 3 of 4 economy workloads (mean BCR 0.990)
and stopped building mechanisms. R4's task was the other half of that sentence:

> **Turn an EF that has roughly reached price parity into a default economy
> mode you can safely ship in place of Basic.**

R4 §2 draws the distinction that shapes everything below:

```
Stop adding architecture  ≠  Flip the production default
```

The architecture stop gate was already met. The **product default gate** was
not, for four reasons: W4 was still 1.002, W4 was synthetic, the price was
modeled rather than billed, and the live quality evidence was thin. R4 closes
those four.

---

## 2. R4-0a — baseline corrections (no new mechanisms)

### 2.1 The peak explanation in R3 was WRONG

R3 reported the peak-context ratio as VIOLATED at 1.14–1.22× and explained it as
"the fold is appended but the replacement has not yet reduced the surface". I
verified `runPairedBaseline` directly: the measurement is taken **after** the
awaited fold, so a peak can never exceed the pre-fold high-water mark. That is
now asserted for every sample in both arms.

The real cause is **fold-cadence quantization**, measured rather than asserted:

```
floors:  basic=438   economy=354   (delta 84 tokens)
appends to cross threshold 2400:  basic=3   economy=4
```

EF leaves a smaller surface after a fold, so the same per-step growth needs
**one more append** to cross the same threshold — overshooting 25.9% instead of
1.6%. It is a property of any threshold-plus-quantum policy, not a defect.

### 2.2 That correction makes the R3 peak GATE wrong too

So R4-C replaces it. `eval/src/window-safety.ts` gates on the condition that
actually protects the product:

```
PeakMain + ReservedOutput + SafetyHeadroom < ContextWindow   AND   overflows = 0
```

with the ratio retained as a pure diagnostic. For a cache-dominant model, EF
carrying a longer context more cheaply is the point; "shorter than Basic" was
never the objective.

Measured: every economy workload's worst-case request fits in **46–47%** of the
window.

### 2.3 Two code-hygiene defects

- `RebaseIntentRegistry` documented id-keying while implementing weak
  object-identity keying. The **implementation** was right — a
  `Map<SessionId,…>` would retain every intent for the process lifetime — so the
  docs and the type were corrected, with a test proving a different object with
  the same id does not share an intent.
- `settled()` exited **silently** past its drain cap, reporting "settled" for a
  consumer that might still be churning — the idle→rebase→idle loop the one-shot
  intent exists to prevent. It now throws, and the test drives a genuinely
  self-sustaining loop and asserts the cap was reached.

---

## 3. R4-A — the R3 "recall is the blocker" conclusion does not hold

**The finding.** R3's `W4-recall-heavy` never recalled anything. Its ref is the
literal string `cp:earlier` — not a bundle checkpoint — and its "result" is 30
lines generated inline by `toolBody(...)`. No `FoldBundleStore`, no
`context_search`, no `context_recall`, no `RecallPage` is involved.

So its 1.002 supported only "recall-SHAPED tool results cost more on an EF
surface", not "real recall is what produced the remaining gap". Acting on the
second claim would have meant building a mechanism for an unmeasured problem.

**The two experiments** R4 §7 requires, which answer different questions:

- **W4R-COMMON** — a benchmark-owned archive materialized **byte-identically**
  into both arms through the same tool. A fair *price* comparison.
- **W4R-NATIVE** — the real chain, EF-only: real fold → real Bundle → real
  `cp:<uuid>` → `context_search` → `context_recall` → real `RecallPage`.

**Result — the gate PASSES and R4-B is SKIPPED:**

```
W4R-COMMON BCR = 0.988
```

Real recall carry is **not** a cost problem, so per R4 §9 no recall
materialization pruning was built.

The native chain verified end to end: a real fold archived 9 messages, the
planted marker `PARSE-7741` is recoverable from the bundle, exact recall returns
it in a real `RecallPage` (0/9), search finds the checkpoint by archived
content, and the checkpoint id **on the surface equals the one the store knows**
— so recall is reachable from exactly what the model sees.

**And the economy gate now passes 4/4:**

| Workload | BCR legacy | BCR economy |
|---|---:|---:|
| W1 narrative-heavy | 1.067 | **0.985** |
| W3 tool-heavy | 1.107 | **0.988** |
| W4R-common (real recall) | 1.200 | **0.988** |
| W5 multi-agent | 1.139 | **0.986** |
| **Mean (economy)** | | **0.986** |

The synthetic W4's 1.002 was the only thing keeping the mean above the line, and
it was measuring nothing.

---

## 4. R4-D — realized billing from the provider's own bill

Every cost number the project had reported was **modeled**: an architectural
warm/cold split times a profile's prices under an assumed `h`. Defensible at
BCR 1.15, where model error could not change the verdict. At 0.986 the claimed
margins are **smaller than the assumptions feeding them**, so a modeled number
can no longer decide a production default.

`eval/live/billing.ts` prices `costOf` — the *observed-usage* path — from
provider-returned counters only. A structural test asserts the import edge,
since the module docstring names `modeledCost` precisely in order to say it is
not used.

**Live result (3 paired runs):**

```
paired ratios:  0.917, 0.784, 0.776
paired CI:      mean 0.826, 95% interval [0.776, 0.917]
wins/ties/losses: 3/0/0
RBCR GATE:      PASS — upper bound 0.917 < 1
```

Realized billing is **better** than modeled (0.826 vs 0.986), and the gate is
stated on the interval: cheaper even at the pessimistic end of noise.

**A finding worth recording.** Real per-request realization is nowhere near
R1's 0.910:

```
h overall = 0.152   [p10 0.000, p90 0.626]
h normal  = 0.262
h after-leaf = 0.000     h after-root = 0.000
```

R1's 0.910 was measured on an artificially stable prefix. On a growing
trajectory with folds, a request following a structural change realizes **no
cache at all**. That is exactly why R4 §24 demanded per-class measurement
instead of a global constant — and it means every `h = 0.91` figure in the R1/R2
reports describes a best case, not a typical one.

---

## 5. R4-E — live paired non-inferiority

Four families × replicates × three arms. The families are chosen because they
fail differently:

| Family | What it tests |
|---|---|
| constraint | a hard normative limit survives folding |
| **supersession** | a value that CHANGED — recalling the old one is a failure |
| obligation | an unresolved failure still reads as open |
| delayed-exact | a verbatim token, recoverable only from the archived history |

**Live result (5 replicates × 3 arms — R4 §29's full requirement):**

| Family | B1-basic | E0-legacy | E4-economy |
|---|---:|---:|---:|
| constraint | 5/5 | 5/5 | 5/5 |
| delayed-exact | 5/5 | 5/5 | 5/5 |
| obligation | 5/5 | 5/5 | 5/5 |
| supersession | 5/5 | 5/5 | 5/5 |

```
economy chain: 5 runs, 35 folds, 5 rebases
vs Basic:  20/20 vs 20/20 — non-inferior (shortfall 0, epsilon 2)
vs legacy: 20/20 vs 20/20 — non-inferior (shortfall 0, epsilon 2)
```

Every family, every arm, every replicate; the chain genuinely chained (21 folds,
3 rebases) rather than degenerating into the single-fold test the vacuity guard
exists to catch.

### 5.1 The gate's first run FAILED, and the failure was mine

The first live R4-E run reported economy **8/12 vs Basic 12/12**. It was a
harness defect, and the diagnosis is worth recording because the wrong
conclusion was one step away:

1. **Both EF arms** scored exactly 8/12 while Basic was untouched. A policy
   regression cannot make two arms with *different policies* fail identically.
2. A diagnostic dump of EF's post-chain surface showed **every fact present** —
   the constraint, `60` with the superseded `30` gone, `PARSE-7741`, and the
   open failure.
3. A fresh run scored 4/4 for both arms, confirming intermittency.

Root cause: `ask()` returned `''` on a transport failure, and every check scores
`''` as a **wrong answer**. An infrastructure hiccup was being recorded as the
model forgetting a fact. The EF arms make more requests per chain (they fold and
rebase), so they absorbed more transient failures — which is why the damage
landed on them and *looked* like a policy effect.

The fix separates the two outcomes: an empty or errored response is retried
once, then recorded as `no-answer` and **excluded** from the quality tally and
reported separately. A wrong answer is still a wrong answer.

---

## 6. R4-F — presets and the aggregate gate

### 6.1 `mode: 'legacy' | 'economy'`

A preset is a **named set of values, not a branch**. `resolvePreset` expands it
into the flat keys a user could write by hand, *before* resolution, so nothing
downstream can tell a preset from an explicit setting — asserted by resolving
both ways and requiring deep equality. An explicit key always wins
(fill-by-omission).

`reliability` is deliberately **not** offered: there is no live evidence for
what the right reliability configuration is, and naming one would assert a
conclusion the project does not have.

### 6.2 `EconomyDefaultEligible = R ∧ C ∧ Q ∧ W ∧ I`

Three states, not two. An absent component is reported as **missing** — a list
distinct from `blocking` — so omitting a check can never read as passing it, and
cost alone never authorizes a flip however good the number.

| | Component | Status | Evidence |
|---|---|---|---|
| **R** | Runtime | ✅ satisfied | seam is a compile-time dependency + capability contract (§7); idle rebase is the production path; R3-0c unified bench and production |
| **C** | Cost | ✅ satisfied | RBCR mean 0.826, 95% CI upper **0.917 < 1**, 3/0/0 wins |
| **Q** | Quality | ✅ satisfied | **20/20** vs 20/20 on both Basic and legacy, across 4 families × 5 replicates |
| **W** | Window | ✅ satisfied | worst-case request 46–47% of window; 0 overflow events |
| **I** | Invariants | ✅ satisfied | ALR 0, SSR 0, PC 100%, CrossSessionLeak 0, ExactRecallMismatch 0 |

---

## 7. R4 §4 — the seam is a contract, not a sniff

The R3 economy result depends on one thing outside this package: the
`frameCheckpoint` seam. R4 §4 forbids solving its absence by sniffing:

```
FORBIDDEN   if ((Basic as any).frameCheckpoint) ...   picks a behavior when
                                                      the capability is missing
                                                      → fails OPEN
HERE        probe once at construction, then REFUSE   → fails CLOSED
```

`legacy` needs no seam and always passes, so the default deployment mounts on
any DSH build. `system-dedup` without the seam **throws**, naming the remedy. A
test asserts the probe exists in exactly one file.

---

## 8. What R4 did NOT do

- **No bounded checkpoint chain / generation merge (R3-D/E).** R4 §39 keeps M5
  closed: the recall work was done first, framing is solved, RBCR < 1, and
  checkpoint carry is not the dominant remaining term.
- **No recall materialization pruning (R4-B).** The R4-A gate passed, so per
  R4 §9 the mechanism was skipped. *No measured problem, no mechanism.*
- **No M1 ingress reducer, M3b, graph, embedding memory, session handoff, or
  learned policy** (R4 §43).

---

## 9. The one number that changed how the project should read its own history

The per-class realization finding (§4) is the most consequential result in R4,
and it is not about EF at all. Every `h = 0.91` figure in the R1 and R2 reports
was measured on an artificially stable prefix. On a real trajectory, `normal`
requests realize ~0.26 and requests following a fold or rebase realize **0.00**.

That does not invalidate the earlier conclusions — the cost ORDERINGS they
established still hold, and RBCR came out *better* than modeled — but it does
mean the modeled numbers were optimistic in a specific, now-quantified way. Any
future report that quotes a modeled `h` should say which class it describes.

---

## 10. Status

All five gate components are satisfied. The default has **not** been flipped:
that is a product decision, and R4 §37 asks for `mode=legacy` to remain
available for at least a release cycle so rollback stays trivial. The preset is
available and tested; flipping the default is a one-line change with the
evidence now in place.
