# RC1.1 — Evidence Reconciliation & Replay Correction: Evaluation Report

**Branch:** `rc1.1-evidence-reconciliation`
**Baseline:** `main@ecbdea6`
**Status:** evidence model corrected. **Mechanics certified; route-level cost
recommendation still open.** One RC1 conclusion is **withdrawn**, and one new
product boundary is **measured**.

---

## 1. What RC1.1 was for

RC1 normalized the policy and produced a certified profile. RC1.1 exists because
that profile, and two of the measurements behind it, did not survive audit:

| Defect | What it was | Fixed in |
|---|---|---|
| Certification semantics | `certified: true` and `recommendedMode() === 'economy'` while the cost gate was **OPEN** | §2 |
| Reserve conclusion | A ~30K-scale estimate reported as a production headroom | §3 |
| Replay confound 1 | The trigger and the retention were varied together | §4 |
| Replay confound 2 | One cache realization rate for every request | §5 |
| Product boundary | Quality was never checked on **undeclared** input | §7 |

The stage adds **no compression mechanism** and runs **no long-context soak**. It
is a correction stage, and its most important output is a withdrawal.

---

## 2. Certification is component-wise, and the two claims are separate

The defect was concrete. RC1's fixture fed the **cache** reuse ratio (`1.0`) into
`priceEffect.realizedRatio`, so a route whose cost gate was **OPEN** reported
`certified: true`. Those are measurements of different things, and one cannot
stand in for the other.

Certification is now per component, each with its own verdict:

```
runtime         PASS   the production seam carries the mechanism
cache-contract  PASS   prefix deterministic; reuse ratio 1.000 at comparable shape
quality         PASS   non-inferior on DECLARED state (see §7 for the scope)
window          PASS   worst-case request fits; zero overflows
cost            OPEN   point estimate below 1, interval upper 1.104
---------------------------------------------------------------
mechanicsCertified = true      economyRecommended = false
```

Three rules make the state representable rather than merely reported:

1. **`OPEN` is not `FAIL`.** Undecided and evidence-of-a-defect are different,
   and collapsing them would make "we have not measured this" read as "this is
   broken".
2. **An absent component is `OPEN`, never `PASS`.** Certification by omission was
   the other half of the same failure.
3. **`recommendedMode()` requires `economyRecommended`**, which requires a
   passing cost gate. A route that is mechanically certified and economically
   open now falls back to `legacy`.

`statusLine()` states the project's position in one line:

> **Economy mechanics certified; route-level cost recommendation still open.**

---

## 3. The safety reserve is an estimate at a stated scale

RC1 measured `H_safe ≈ 9,733` tokens against the shipped 65,536 and reported the
shipped value as "6.73× excessive". RC1.1 §2 narrows that to what the evidence
supports.

The same measurement found the meter's error is **strongly relative and
shape-dependent**:

| Shape | E / metered |
|---|---:|
| CJK | **+92%** |
| dense JSON | **+52%** |
| tool output | **+30%** |
| source code | −0.0% |
| english prose | **−40%** |

A **fixed absolute** reserve derived from a ~30K-token sample has not been shown
to extrapolate to a 65K-token prompt, where a 90% relative error would be an
order of magnitude larger. So the value is recorded as:

```text
safetyReserveEstimate:
  tokens:                9,733
  sampledAtPromptTokens: 30,000
  caveat:                relative meter error is shape-dependent; extrapolation unproven
```

and `effectiveThresholdFor()` takes the reserve as an **argument**, so the
estimate cannot be installed into the operating configuration by accident. **The
shipped 65,536 is left alone.**

---

## 4. Replay confound 1: the RC1-H conclusion is WITHDRAWN

RC1-H swept the trigger with `retainTokens = 0.16 × threshold`, reported that
cost falls monotonically as the effective threshold falls, and concluded that the
shipped reserve *helps* by lowering the trigger. Holding retention at its
production value **reverses the sign**:

| Threshold | Coupled (RC1-H) | Decoupled (corrected) |
|---:|---:|---:|
| 104,857 | 0.7801 | 0.8002 |
| 80,000 | 0.7420 | 0.8093 |
| 65,024 | 0.7098 | **0.8186** |
| 50,000 | 0.6794 | 0.8857 |
| 40,000 | 0.6488 | **0.9678** |

The two sweeps disagree about the **direction**, which makes the RC1-H result an
artifact rather than a nuance: the reported monotonicity was produced by moving
retention alongside the trigger. Both sweeps now run in one test so the
disagreement is visible, and `tests/rc1h-production-trigger.spec.ts` is removed.

---

## 5. Replay confound 2: the cache model is class-aware

A request following a fold arrives on a surface the provider has never seen.
RC1's simulator priced every request at one `h`, which made the cost of folding
invisible. Requests are now priced by class:

```
normal        steady state
after-leaf    the first request after a fold appended a checkpoint
after-root    the first request after a rebase rewrote the prefix
compaction    the auxiliary summarizer call, which shares no prefix
```

with three realization sets so the verdict is **sensitivity-checked** rather than
asserted at one point. At the shipped configuration on the production-shaped
trace:

```
optimistic   0.7443
nominal      0.8186
pessimistic  0.8789
```

All three are below parity, and the spread (0.135) is reported because a verdict
that survives only the optimistic scenario is not a verdict.

---

## 6. The region Ω, searched across every historical trace

RC1.1 §4 asks for a **region**, not an optimum. A cell qualifies only if it
clears **every** trace under **every** scenario — the observed W1–W4 traces
(replayed keylessly, no new spend), a state-rich synthetic regime, and a
production-shaped trace:

| Threshold | R=0.08 | R=0.16 | R=0.24 |
|---:|---:|---:|---:|
| 0.80 | **0.938** | **0.946** | **0.953** |
| 0.50 | **0.889** | **0.889** | 1.014 |
| 0.375 | **0.812** | 1.070 | 1.621 |
| 0.25 | **0.818** | — | — |

**10 robust cells, 7 below parity on the worst trace.** Two readings:

1. **The region is wide at the production setting.** At `T = 0.80` all three
   retentions qualify, with worst-case ratios of 0.938–0.953. The shipped
   parameters sit inside the widest band, which is what makes them safe to ship.
2. **Retention is the stronger lever, not the trigger.** The single best cell is
   `T = 0.375, R = 0.08` at 0.812, and it achieves that with the *smallest*
   retention. RC1-H attributed this effect to the trigger; §4 shows why.

The recommendation from inside the region is the **largest threshold with the
production retention** — the mature values, not a fitted decimal. RC1.1 §4's
"do not fit the fourth decimal" is satisfied by construction: the plateau is wide
enough that the exact value does not matter.

---

## 7. The product boundary, measured live

Every earlier quality check **declared its facts as anchors** through the
authority gate. Under `semanticMode: 'none'` a checkpoint is marker-only, so
those checks measured "declared state survives a fold" — the mechanism working.
They did **not** measure what happens to ordinary prose nobody anchored, which is
the case a user meets first.

Three replicates × three arms, all arms folding 14 times at **production**
retention:

| Arm | Scores | Mean |
|---|---|---:|
| economy (`semanticMode: none`) | `[0, 0, 0]` | **0.00/3** |
| basic | `[0, 2, 1]` | **1.00/3** |
| economy (`semanticMode: rationale`) | `[2, 3, 0]` | **1.67/3** |

**The economy preset is not non-inferior on undeclared prose, and it is not
close.** But the cause is localized: a **rationale** checkpoint recovers most of
it, so this is the preset's own `semanticMode` choice rather than an
architectural limit. The certification now carries a `qualityScope`, and an
unscoped claim reads `UNSCOPED` rather than implying universality.

The honest statement of the boundary:

> Economy quality is **conditional on declaration**. Declared state survives a
> fold; undeclared narrative does not. `semanticMode: 'none'` is a cost
> optimization that trades narrative recall for the absence of an auxiliary
> call, and a deployment that needs unanchored prose remembered should not use
> the preset.

### Three defects in my own smoke

Each would have produced a confident wrong answer, and all three are the same
class of error RC1.1 exists to remove:

1. **Only the economy arm was configured**, so Basic — whose shipped reserve
   exceeds a 6,000-token window — never folded (0 folds) and scored 3/3 by
   keeping everything verbatim. That read as "economy loses 3 facts" when it was
   "compacting versus not compacting". Both arms now share the window,
   reservation and trigger, and **every arm must fold in every replicate**.
2. **`retainTokens: 0`** discarded the entire tail at each fold, so the result
   was dominated by my own extreme setting: consecutive runs scored Basic 3/3,
   then 0/3. Production retention is now used.
3. **One replicate cannot answer this.** Three single runs of the same code
   scored Basic 3/3, 0/3, 1/3. Three replicates turn a point into a range, and
   the spread is reported (basic 2, economy 0, rationale 3 out of 3 facts). This
   is the same lesson RC1 learned about cost and had to correct in public.

### The corrected cost pair

One pair, corrected instrument, provider healthy:

```
economy 24 calls (0% failed), basic 28 calls (0% failed), 4 folds each
ratio 0.957  —  below parity, matching the keyless replay's direction
```

It carries **no verdict**: RC1 established that one run cannot. The run stops on
provider degradation above 25% failed calls, because a degraded provider measures
the provider.

---

## 8. Release decision

RC1.1 §6 allows exactly two outcomes. The evidence selects the second:

```text
mode=economy  →  available, recommended as explicit opt-in
default       →  legacy
```

The reason is the cost component. The region Ω is wide and the typical pair is
below parity, but the **verdict does not reproduce**: two runs of identical code
gave CI upper bounds of 0.965 and 1.104, and the per-family direction on the
fold-bearing workload flips between them. That is dispersion at n=8, and RC1.1
§5 forbids buying a verdict with more runs in an unhealthy window.

**No new architecture is added to flip a default.** The project state is:

> **Economy mechanics certified; route-level cost recommendation still open.**

| Component | State | Evidence |
|---|---|---|
| runtime | **PASS** | production seam carries the mechanism |
| cache-contract | **PASS** | prefix deterministic; reuse ratio 1.000 |
| quality | **PASS (scoped)** | non-inferior on declared state; undeclared prose is the boundary (§7) |
| window | **PASS** | zero overflows; peak inside the window |
| cost | **OPEN** | dispersion at n=8 (§8) |
| **mechanicsCertified** | **true** | |
| **economyRecommended** | **false** | the cost gate is undecided |

Two items remain open and are recorded rather than closed:

1. **The cost verdict needs a healthy provider window and more replicates on the
   fold-bearing family.** The keyless region says the parameters are safe; the
   live instrument now behaves; what is missing is a sample.
2. **`semanticMode: 'none'` is a recall-for-cost trade**, now measured rather
   than assumed. Whether a deployment wants it depends on whether its knowledge
   is declared, which is a product question RC1.1 answers with a boundary instead
   of a default.

---

## 8b. Post-publication correction (RC1.2)

**§7's boundary was too strong, and the reason is a defect in its smoke.** The
probe assembled a system prompt, streamed a response, and collected text deltas —
it never executed a tool call. So a model that correctly decided "this fact is in
an older checkpoint, I should search for it" had no way to act.

What §7 legitimately established:

> the marker-only checkpoint **surface** does not directly retain undeclared narrative

What it claimed but could not support:

> EF economy **cannot recover** undeclared narrative

`context_search` and `context_recall` are exactly the mechanism for recovering
folded raw history, and they were never invoked. RC1.2 closed that gap and the
claim does not survive: with a real agent loop and a deterministic keyless proof,
the facts are recovered in every arm and every replicate, under **both** semantic
modes, with `PARSE-7741` absent from the surface and present in what recall
returns. The corrected contract is **declared state is hot; undeclared history is
recoverable through bounded recall**, and `qualityScope` now says so.

The three-arm table in §7 also carried a second defect worth recording: only the
economy arm was configured in an earlier version, so Basic never folded and won
by keeping everything verbatim. That was fixed before publication, but it is the
same class of error — a comparison that was not comparing what it claimed.

See [docs/21](21_RC1_2_RECALL_CLOSURE.md).

---

## 9. Prohibitions observed

No M1, M3b, M4, M5, RecallPrune, or Delta Leaf. No new cache soak. No 700-turn
state-rich live test. No compression mechanism added.

---

## 10. Test inventory

| Suite | Tests | Live |
|---|---:|---|
| `rc11a-certification-semantics.spec.ts` | 12 | no |
| `rc11b-replay-correction.spec.ts` | 7 | no |
| `rc11c-live-smokes.spec.ts` | 2 | **yes** |
| `rc1h-production-trigger.spec.ts` | — | **removed** (§4) |
| `rc1g-certified-profile.spec.ts` | — | **removed** (superseded by §2) |

Scripts: `eval:rc1` (keyless) and `eval:rc1-live` (opt-in via `EF_LIVE=1`).
