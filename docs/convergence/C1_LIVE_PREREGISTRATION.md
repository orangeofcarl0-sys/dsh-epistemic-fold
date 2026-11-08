# EF-C1 — Live Experiment Preregistration

Status: **not-authorized**. No provider was contacted in EF-C1.

Machine-readable companion: `eval/c1/out/live-readiness.json`
(`status: not-authorized`, `providerCalls: 0`).

This is a plan, not a result. It exists so the next round can execute a bounded
experiment without re-deriving the design, and so a future authorization can
name exactly what it approves.

## 1. What is being tested

The product question is not "does EF fold?" — the mechanism is certified. It is:

> Under a real model, on tasks that actually require compaction, does EF's
> preserved history produce better task outcomes than the host's Basic, at a
> cost that is worth paying?

That question has two parts that must be reported separately:

| Part | Metric family | What would falsify EF |
|---|---|---|
| Quality | operational completion, contract success, critical-constraint preservation, exact recall | EF is not better, or is worse, on tasks that force a fold |
| Cost | prompt/output tokens, cache read/write, latency | EF's quality gain does not cover its token cost |

A result that improves recall but not task completion is a context-correctness
result, not a product result. It will be reported as such.

## 2. Arms

| Arm | Configuration | Role |
|---|---|---|
| B0 | host native Basic | product baseline |
| E0 | EF `semanticMode: none`, `semanticContinuity: off` | EF minimal |
| E1 | EF `semanticMode: rationale`, `semanticContinuity: off` | EF + visible rationale |

Bv (EF `mode: basic`) is a **compatibility** arm, certified offline in
`tests/c1-basic-compatibility.spec.ts`. It does not repeat the full live matrix:
it exists to prove EF can stand aside, not to measure a product.

E1 is **not** Semantic Continuity Active. S0 (active continuity) is out of
scope until the decision-authority question in `C1_DECISION.md` is resolved.

## 3. Tasks

Six tasks, one per required family. Each must force at least one real fold; a
cell that never folds is `no-fold`, not a success.

| ID | Family | What it forces |
|---|---|---|
| T1 | long-horizon real fold | the task cannot finish inside one context window |
| T2 | exact historical recall | a fact from before the fold must be reproduced verbatim |
| T3 | decision revision | a later instruction supersedes an earlier one |
| T4 | tool-result dependency | a later step needs a tool result that the fold would summarize away |
| T5 | multi-fold continuation | two or more folds, with state carried across both |
| T6 | prefix / cache pressure | a stable prefix large enough that cache behavior matters |

The R37 six short tasks are **not** reused. They were designed to fit in a
single window and did not reach the regime where Basic's summary loses
information.

## 4. Design and power

```text
6 tasks x 3 arms x 1 replicate = 18 cells
```

One replicate is a **pilot**, not a confirmatory batch. It can detect a large
effect and cannot estimate a small one. The report will say so; no p-value will
be presented as a product claim. If the pilot shows a direction worth
confirming, a second round must preregister replicates and a stopping rule.

Pairing: each task is run under all three arms with the same seed content,
model, route and harness. Comparisons are paired by task.

## 5. Budget, derived rather than copied

The R38-M1 proposal reused R37-D's caps (240 requests / 300,000 input tokens).
Those caps described a **short-task pilot**, not a long-horizon experiment.
This plan derives its caps from the measured R37-D usage and the R1 per-step
prompt cost:

```text
R37-D pilot actuals (24 cells)
  requests        173   (7.2 per cell)
  input tokens    233,191   (9,716 per cell)
  output tokens    25,125   (1,047 per cell)
  wall clock      425,585 ms (17.7 s per cell)

R1 long-horizon measurement
  W1 EF total prompt tokens 106,443 over 64 steps = 1,663 per step
```

A long-horizon cell is estimated at 24 model calls and ~8,000 prompt tokens per
call (the window is 16k; folds and the retained tail share it):

```text
18 cells x 24 calls          = 432 requests
18 cells x 24 x 8,000        = 3,456,000 input tokens
18 cells x 24 x 400          = 172,800 output tokens
18 cells x 120 s             = 2,160 s wall clock
```

Proposed hard caps (round up, then stop):

| Cap | Value |
|---|---:|
| requests | 520 |
| input tokens | 3,600,000 |
| output tokens | 200,000 |
| wall clock | 7,200,000 ms (2 h) |

These are **provisional** until a zero-request preflight measures the real fold
path for the six tasks. The preflight may raise the per-call estimate; it may
not raise the caps without a new preregistration.

## 6. Metrics

Primary:

- operational completion (the task's own checker passes)
- contract success (the declared obligation is met)
- critical-constraint preservation (no constraint introduced before a fold is lost)

Secondary:

- exact recall accuracy (verbatim fact retrieval after a fold)
- total prompt tokens, output tokens
- cache read / cache write (when the route reports them)
- latency per turn and per fold
- provider failures, retries, fallbacks
- no-valid-action turns

Not a success metric on its own: semantic recall, fold count, checkpoint size.
A higher recall with a lower task completion is a failure of the product claim.

## 7. Stop rules and ITT

- Stop when any hard cap is reached; the cell in flight is recorded as
  `budget-exhausted`, not discarded.
- Stop if provider failures exceed 20% of attempted calls; the run is
  `provider-degraded`, and its quality numbers are not interpreted.
- Stop if more than 10% of cells are `no-fold` or `invalid-measurement`; the
  task set failed to reach the regime under test.
- Every attempted cell is counted. No cell is excluded after the fact for being
  slow, expensive or unflattering. A cell that fails its checker is a result.

## 8. Authorization checklist

A run may start only when ALL of these exist:

```text
[ ] eval/c1/live-manifest.json, frozen, with limits and a route (names, not secrets)
[ ] the manifest's SHA-256 recorded in an explicit authorization
[ ] C1_LIVE_AUTHORIZED_SHA256 equal to that hash
[ ] a provider/model route configured in the environment
[ ] a clean zero-request preflight over the real fold path
[ ] the exact cell count and arm list named in the authorization
```

`eval/c1/live-readiness.mjs` computes the status from those conditions. Today it
returns `not-authorized` with six blocking reasons. A code change cannot make it
say `ready`; only a manifest and an authorization can.

## 9. What this preregistration does not do

- It does not authorize execution.
- It does not reuse the R37-D authorization, which covered the 24 cells it
  named and nothing else.
- It does not claim a cost advantage. The historical 1/17 figure was measured on
  a different configuration and is not transferable to E0/E1.
- It does not include Semantic Continuity Active (S0).
