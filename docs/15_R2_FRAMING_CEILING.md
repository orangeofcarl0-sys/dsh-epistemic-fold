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

Composition of the checkpoint text, measured on a real run (4 checkpoints,
461 text tokens total):

| Component | Per checkpoint | Share of text | Owner |
|---|---:|---:|---|
| Handoff preamble (`frameSummary`) | 28.0 tok | 24% | **DSH Basic** |
| EF marker line (`[EF checkpoint v1 mode=leaf id=<uuid>]`) | 17.0 tok | 15% | EF |
| EF recall pointer (`Recall` + `cp:<uuid>`) | 17.5 tok | 15% | EF |
| State, rationale, residual | 52.8 tok | 46% | EF (content) |

Two conclusions follow, and they point in opposite directions.

### The DSH-inherited part needs a core seam

The 24% preamble is added by Basic's `frameSummary` **after** EF returns its
unframed body. EF cannot deduplicate it: the engine's `publish()` hands Basic
`{ summary: [{ type: 'text', text: renderedText }] }`, and `region.ts` wraps
that per checkpoint. Stating the instruction once per surface instead of once
per checkpoint requires either a DSH core change or EF taking over the
replacement-message construction entirely.

### The EF-owned part is small, and mostly correctness-bearing

EF's own fixed overhead is 34.5 tokens per checkpoint — 30% of the text. But it
is dominated by **two occurrences of the checkpoint UUID** (36 chars each):
once in the marker that the frontier parses to establish identity, and once in
the recall pointer that makes the archive reachable. Halving this overhead in
practice means either

- dropping the recall pointer — which removes the model's only affordance for
  recovering folded history, i.e. trades a correctness capability for tokens; or
- shortening checkpoint identity — which risks collisions in the frontier and
  bundle store.

Neither is a trade R2 permits. So the realistic EF-side saving is small: a few
tokens per checkpoint, moving BCR by roughly 0.02–0.05 — not enough to reach 1
on its own.

---

## 3. What this means for the next stage

Three paths, ranked by what the measurements support:

1. **Single-surface preamble (needs a DSH seam).** Worth the most: the
   framing-free ceiling shows the entire gap is here. This is R1's L3 and it is
   now the highest-value engineering target in the project.
2. **Bounded / merged checkpoint chain (EF-side).** Stops the per-step
   multiplication without making the prefix cold. This is the M5 generational
   fold R1 deferred — and R2's decomposition is the first evidence it targets
   the real bottleneck rather than a suspected one.
3. **EF-side line diet (EF-side, small).** Shaving the marker and recall lines
   is worth ~0.02–0.05 BCR and should not be attempted by weakening identity or
   recall.

Note what is **not** on this list: compressing more aggressively. EF's
cold-token overhead is already near zero (+905 to +4,470 against Basic's
tens of thousands). There is nothing left to win by folding harder — only by
carrying less fixed text.

---

## 4. Status

| Item | Status |
|---|---|
| Is BCR < 1 reachable? | ✅ yes — framing-free ceiling is 0.56–0.92 |
| Can EF reach it alone? | ❌ not with identity and recall intact |
| Highest-value next target | Single-surface preamble (DSH seam) |
| Second target | Bounded/merged checkpoint chain (EF-side, no seam) |
| Production default flip | ❌ still blocked on BCR < 1 |

Recorded as a finding, not a plan: no code was changed by this analysis, and
the defaults remain `legacy`/`legacy`.
