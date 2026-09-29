# R2 Framing Ceiling — Is BCR < 1 Reachable?

**Question.** R2 ended at mean BCR 1.149 with the objective (BCR < 1) unmet.
The report attributed the gap to warm-token accumulation. This document answers
the next question: *is the gap closable at all, and by whom?*

Measured keylessly, 64 steps, window 16,000, DeepSeek Flash profile,
realization h = 0.910.

---

## 1. The ceiling: yes, the gap is closable

Pricing each run as if its checkpoint framing cost **zero** — every other token
unchanged:

| Workload | BCR now | BCR framing-free | Framing tokens |
|---|---:|---:|---:|
| W1 narrative-heavy | 1.090 | **0.639** | 41,976 |
| W2 state-rich | 1.174 | **0.917** | 22,385 |
| W3 tool-heavy | 1.123 | **0.559** | 85,140 |
| W4 recall-heavy | 1.185 | **0.710** | 40,524 |
| W5 multi-agent | 1.151 | **0.586** | 68,112 |

**Every workload lands below 1.** So R2's failure is not structural to the
Epistemic Fold idea — it is concentrated in one cost: the fixed text every
checkpoint carries, multiplied by the number of checkpoints on the surface and
by the number of steps each is carried for.

That makes framing the single highest-value target in the project, ahead of
M5, M1, and Delta Leaf.

---

## 2. But most of that framing is not EF's to remove

Composition of the checkpoint text, measured on a real run (13 checkpoints):

| Component | Per checkpoint | Share of text | Owner |
|---|---:|---:|---|
| Handoff preamble (`frameSummary`) | 28.0 tok | 24.3% | **DSH Basic** |
| EF marker line (`[EF checkpoint v1 mode=leaf id=<uuid>]`) | 17.0 tok | 14.8% | EF |
| EF recall pointer (`Recall` + `cp:<uuid>`) | 17.5 tok | ~15% | EF |
| State, rationale, residual | 52.8 tok | ~46% | EF (content) |

Two conclusions follow, and they point in opposite directions.

### The DSH-inherited part needs a core seam

The 24.3% preamble is added by Basic's `frameSummary` **after** EF returns its
unframed body. EF cannot deduplicate it: the engine's `publish()` hands Basic
`{ summary: [{ type: 'text', text: renderedText }] }`, and `region.ts` wraps
that per checkpoint. Stating the instruction once per surface instead of once
per checkpoint requires either a DSH core change or EF taking over the
replacement-message construction entirely.

### The EF-owned part is small, and mostly correctness-bearing

EF's own fixed overhead is ~30% of the text, and it is dominated by **two
occurrences of the checkpoint UUID** (36 chars each): once in the marker the
frontier parses to establish identity, and once in the recall pointer that
makes the archive reachable. Halving this in practice means either

- dropping the recall pointer — which removes the model's only affordance for
  recovering folded history, i.e. trades a correctness capability for tokens; or
- shortening checkpoint identity — which risks collisions in the frontier and
  bundle store.

Neither is a trade R2 permits. **Realistic EF-only saving: ~15% of framing**
(halving the marker and recall lines), moving BCR by roughly 0.06–0.11.

---

## 2b. How much framing removal each workload actually needs

Solving for the removal fraction that brings BCR to exactly 1:

| Workload | Framing removal required | Reachable without seam (~15%) | Reachable with seam (~39%) |
|---|---:|---|---|
| W1 narrative-heavy | **20.0%** | ❌ just short | ✅ |
| W2 state-rich | **67.9%** | ❌ | ❌ **unreachable** |
| W3 tool-heavy | **21.8%** | ❌ | ✅ |
| W4 recall-heavy | **39.0%** | ❌ | ✅ (borderline) |
| W5 multi-agent | **26.8%** | ❌ | ✅ |

**This corrects the optimistic reading of §1.** The framing-free ceiling is the
theoretical maximum, not a plan, and W2's ceiling is only 0.917 — it has almost
no margin. Concretely:

- **Without a DSH seam, EF cannot reach BCR < 1 on any workload.** The
  reachable ~15% is below every required value (minimum 20.0%).
- **With the seam, 4 of 5 workloads reach parity** — but W2 does not, needing
  67.7% against a reachable ~39%.

W2 is the state-rich workload, where the checkpoints carry real machine state
and the raw history is small. Its problem is not framing volume but that EF's
absolute token count is high relative to a Basic run that barely folds at all
(5 folds). No amount of framing reduction fixes a workload where the
comparison is dominated by content.

**So the honest conclusion is narrower than §1 suggests:** framing reduction is
necessary but not sufficient. It is required to reach parity on four workloads,
and it cannot deliver parity on the fifth.

---

## 3. What this means for the next stage

The measurements support a specific, bounded conclusion rather than a general
"reduce framing" instruction:

1. **Single-surface preamble (needs a DSH seam).** Necessary for parity on W1,
   W3, W4 and W5. Without it, EF cannot reach BCR < 1 on *any* workload, since
   the best EF-side reduction (~15%) is below the smallest requirement (20.0%).
2. **Bounded / merged checkpoint chain (EF-side).** Reduces the *number* of
   checkpoints, which reduces framing proportionally without needing the seam.
   This is the one lever that could push past ~39%, and it is the M5
   generational fold R1 deferred. Given §2b it is no longer optional if W2 is
   to reach parity.
3. **W2 may be unwinnable on price, and that is acceptable.** Its comparison is
   dominated by content, not framing: Basic folds 5 times where EF folds 6, and
   EF carries more absolute tokens by construction. The R1 directive already
   anticipated this by defining a `reliability` mode alongside `economy`
   (docs/11 §26). The honest position is that state-rich workloads are where EF
   *should* cost more, because that is where it is doing something Basic is
   not — carrying machine state.

Note what is **not** on this list: compressing more aggressively. EF's
cold-token overhead is already near zero (+905 to +4,470 against Basic's tens
of thousands). There is nothing left to win by folding harder — only by
carrying less fixed text, and only on the workloads where text is the problem.

---

## 4. Status

| Item | Status |
|---|---|
| Is BCR < 1 reachable at all? | ✅ yes on 4 of 5 workloads (ceiling 0.56–0.92) |
| Is it reachable by EF alone? | ❌ no — best EF-side reduction (~15%) < smallest requirement (19.9%) |
| Reachable with a DSH seam? | ✅ 4 of 5 workloads |
| W2 state-rich reachable? | ❌ needs 67.9% framing removal; ~39% is achievable |
| Highest-value next target | Single-surface preamble (DSH seam) + bounded chain |
| Production default flip | ❌ still blocked on BCR < 1 |

Recorded as a finding, not a plan: no production behavior was changed by this
analysis, and the defaults remain `legacy`/`legacy`.

---

## 5. R3 outcome — what actually happened (added after R3)

This document is R2's record and is left as written. R3 then executed the plan
above; the results are in [docs/16](16_R3_EVALUATION_REPORT.md), and three of
this document's conclusions need correcting.

### 5.1 The "~15% EF-only" ceiling was too pessimistic

§1/§2b assumed the checkpoint UUID must appear **twice** — once in the marker
and once in the recall pointer — and that halving it meant "dropping the recall
pointer … trades a correctness capability for tokens, or shortening checkpoint
identity … risks collisions".

Both horns were false. **R3-A made the marker carry both jobs at once**:

```
V1  [EF checkpoint v1 mode=leaf id=<uuid>]  …  Recall\n- cp:<uuid>
V2  [EF1 L cp:<uuid>]
```

`cp:<uuid>` is already exactly the reference `context_recall` accepts, so the
`Recall` section was duplication, not an affordance. Nothing was traded and
nothing was shortened. Measured effect on the required removal:

| Workload | §2b required | After R3-A |
|---|---:|---:|
| W1 narrative-heavy | 20.0% | **15.5%** |
| W2 state-rich | 67.9% | 73.3% |
| W3 tool-heavy | 21.8% | **19.4%** |
| W4 recall-heavy | 39.0% | **34.2%** |
| W5 multi-agent | 26.8% | **24.7%** |

W1/W3/W4/W5 all improved, and W1's requirement moved **inside** the range
§3 called EF-achievable. W2 moved the wrong way, for the reason §2b already
gave: its cost is machine state, not framing, so removing framing removes less
of its total.

### 5.2 The seam worked, and the predicted split was right

R3-B/C implemented the single-surface preamble via a minimal DSH seam and
measured BCR through the production path:

```
W1 1.067 → 0.985   W2 1.156 → 1.061   W3 1.107 → 0.988
W4 1.144 → 1.002   W5 1.139 → 0.986   Mean (economy) 0.990
```

§2b's prediction — "with the seam, 4 of 5 workloads reach parity, but W2 does
not" — was confirmed essentially exactly (three clear passes, one borderline
miss, W2 short).

### 5.3 The bounded chain was NOT built, and should not be

§3 listed the bounded/merged checkpoint chain as "no longer optional if W2 is
to reach parity", and §4 repeated it as the highest-value next target.

R3 §25 made that conditional on the seam falling short, and it did not: the
stop condition was met on 3 of 4 economy workloads. Building a generational
merge to chase W2 would mean optimizing the workload this document itself
identifies as the **reliability** region — deleting machine state to win a price
comparison on the one workload where carrying that state is the product.

W4's remaining 0.2% is likewise **not** a framing problem. Measured: framing +
irreducible identity is 6.3% of its cost, and the gap is **recall volume**
(Basic 25 434 tokens vs EF 33 533). That is a different mechanism, and
[docs/16 §8](16_R3_EVALUATION_REPORT.md) names the right lever for it.

### 5.4 One prediction this document did not make

The peak-context bound. R3 §39 asked for `Peak <= Basic · 1.05`; the R3 economy
run measured **1.16× / 1.14× / 1.22×** on W1/W3/W5, from fold timing rather
than framing. It is recorded as a violation in docs/16 §4.2 rather than
relaxed.

