# EF-C0 — Feature and Scope Matrix

Status: current scope truth, 2026-11-08.

Five states are used, and they are not synonyms:

```text
Core              part of the product baseline; must work without semantic active
Optional Semantic shipped behind a switch; off must be inert
Research-only     exists as evidence/fixtures; no production registration path
Deferred          not built or not shipped; may reopen with new evidence
Deprecated        superseded or rejected; kept for history, not for use
```

`Research-only` does **not** mean "delete it". `Deferred` does not mean
"forbidden forever".

## 1. Core — Compression Runtime (Track A)

| Capability | State | Where | Default | Evidence |
|---|---|---|---|---|
| Fold transaction, archive before loss | Core | `src/fold/engine.ts`, `src/checkpoint/bundle-store.ts` | always | deterministic transaction tests; bundle write precedes surface replacement |
| Fold Frontier, leaf legality | Core | `src/fold/frontier.ts`, `candidate.ts`, `leaf-policy.ts` | always | frontier and pairing tests |
| Leaf fold | Core | `src/fold/engine.ts` | automatic | R0/R1 suites |
| Root fold / idle rebase | Core | `src/fold/engine.ts`, `src/fold/idle-rebase.ts`, `src/policy/root-policy.ts` | economics policy | R2-C/R3-B |
| Emergency rebase and overflow recovery | Core | `src/fold/engine.ts` | always | overflow/recovery tests |
| Checkpoint bundle and exact archive | Core | `src/checkpoint/*` | always | bundle/hash tests |
| `context_search` / `context_recall` | Core | `src/recall/*` | when tools are mounted | recall suites |
| Deterministic state projection | Core | `src/state/state.ts`, `projection.ts` | when projections are mounted | state tests |
| Task-root protection | Core | `src/fold/task-root.ts` | when a host registers a root | task-root tests |
| `system-dedup` framing | Core (policy option) | `src/checkpoint/framing.ts`, `src/plugin.ts` | tier default | framing seam tests |
| Status, `/context`, Sidebar | Core | `src/status/*` | non-basic | status tests |
| `mode: basic` stand-down | Core | `src/plugin.ts`, `src/config/preset.ts` | opt-in | `rc7-basic-mode.spec.ts` |
| Provider economics profiles | Core | `src/policy/economics-profile.ts` | shipped list | economics tests |

## 2. Optional Semantic (Track B)

Every row here must be inert when `semanticContinuity: off` and
`semanticMode: none`.

| Capability | State | Where | Switch | Evidence |
|---|---|---|---|---|
| Rationale checkpoint digest | Optional Semantic | `src/checkpoint/rationale.ts`, `src/semantic/writer.ts` | `semanticMode: rationale` | RC1.2 / R33; default for tiers |
| Combined writer (handoff + deltas) | Optional Semantic | `src/semantic/writer.ts`, `engine.ts` | `semanticContinuity: active` | R33–R38 |
| Evidence validator | Optional Semantic | `src/semantic/evidence.ts`, `validate.ts` | follows the writer | R32/R38 |
| Authority / retirement rules | Optional Semantic | `src/semantic/retirement.ts`, `plan.ts` | follows the writer | R38, 19 tests |
| Semantic journal + commit proof + replay | Optional Semantic | `src/semantic/journal.ts`, `proof.ts`, `replay.ts` | `semanticContinuity != off` | R31/R32 |
| Semantic working set | Optional Semantic | `src/semantic/working-set-compiler.ts` | `active` | R31/R33 |
| Shadow measurement | Optional Semantic | `engine.ts` `runShadowWriter` | `semanticContinuity: shadow` | R33; makes a separate diagnostic call |
| Anchor service (`ef/anchor`) | Optional Semantic surface | `src/state/anchor-service.ts` | registered non-basic | authority-gated; durable write host-dependent |

Note on the writer: all three product tiers set `semanticMode: 'rationale'`, so
the digest call is **on by default for tiers**. `semanticMode: none` is the
explicit zero-LLM profile, and `semanticContinuity` refuses to run under it.

## 3. Research-only (Track C)

| Capability | State | Where | Production path? | Evidence |
|---|---|---|---|---|
| Task-aware context selector | Research-only | `eval/r38/src/task-aware-selector.ts` | no | R38 ablation 5/5; mechanism case certified |
| Bounded archive recovery | Research-only | `eval/r38/src/archive-recovery.ts` | no | R38 8/8; 2/5 fixtures recovered archive-only |
| Cross-coordinate integrity auditor | Research-only | `eval/r38/src/integrity-auditor.ts` | no | R38 9/9; read-only |
| Recent-tail consistency | Research-only | `eval/r38/src/recent-tail.ts` | no | R38 9/9 |
| Task-specific context overlay | Research-only | `eval/r38/src/context-overlay.ts` | no (native smoke only) | R38 6/6 |
| Thermal residency observer | Research-only | `src/state/thermal.ts` | **no import outside its own test** | `thermal-residency.spec.ts`; docs/142 |
| Referential archive | Research-only, flagged | `src/checkpoint/archive-refs.ts` | `referentialArchive` (default false) | experimental |
| Subagent recall | Research-only, flagged | `src/recall/subagent-recall.ts` | `subagentRecall` (default false) | docs/67 |
| Cross-session recall | Research-only, flagged | `src/recall/*`, `plugin.ts` | `allowCrossSessionRecall` (default false) | experimental |
| Memory-corpus experiments | Research-only | `eval/memory/*` | no | 41 MB tracked corpora |
| Tau2 bridge | Research-only | `eval/tau2/*` | no | external benchmark bridge |

The thermal observer deserves the explicit note: it lives under `src/` but has
no production registration path. It is research code in the source tree. Moving
it is a refactor this round does not perform; the matrix records the fact so a
later round does not mistake it for a shipped feature.

## 4. Deferred

| Capability | State | Why it is not shipped | Reopen condition |
|---|---|---|---|
| M1 ingress reduction (tool-output compression) | Deferred | measured benefit existed only where tool output existed, and the upper bound did not justify the seam | a new failure corpus where tool output dominates |
| Uncertainty modelling | Deferred | the writer records status, but no calibrated uncertainty mechanism exists | a measured case where claimed/observed/verified is insufficient |
| Semantic dependency graph | Deferred | no measurement justified it; RFC lists it as a non-goal for M0–M3 | a failure corpus that needs transitive dependency reasoning |
| Memory maintenance | Deferred | no owner, no measured need | long-session evidence of state decay |
| Cross-session knowledge | Deferred | cross-session recall exists as an experiment, not a product | an authorized experiment with scope controls |
| LLM-assisted semantic revision | Deferred | adds a second model call and a new failure mode | evidence that deterministic revision is insufficient |
| Learned compression planner | Deferred | RFC non-goal | a measured policy gap |
| Embedding / vector backend | Deferred | RFC non-goal; exact recall already works | a retrieval-quality failure exact search cannot fix |
| Multi-level generations | Deferred | summary-of-summary drift is the failure EF exists to prevent | not reopened |
| Universal tool ingress compressor | Deferred | RFC non-goal | not reopened |

## 5. Deprecated / rejected

| Capability | State | Reason |
|---|---|---|
| `DeltaLeaf` (production delta folding) | Rejected | R1-B gate: ROI upper bound 3.7–16.6%, insufficient |
| `plugin:epistemic-fold/semantic` session records as an authority | Deprecated | superseded by the semantic journal; kept only as a migration source |

## 6. Scope invariants

These are the rules a future change must not break:

```text
C1  Core works with semantic off.
C2  A semantic failure cannot corrupt the fold transaction.
C3  Semantic state cannot rewrite canonical history.
C4  Selection cannot mutate authoritative state.
C5  Feature off means no hidden semantic effect.
C6  Basic mode mounts no EF surface.
C7  Archive stays recoverable after a semantic refusal.
```

The tests that certify them are `tests/convergence-boundaries.spec.ts`.

## 7. What is intentionally absent

- No new semantic writer, memory graph, background agent, embedding backend,
  workflow engine, agent loop or recall backend was added in this round.
- No research module was promoted to a product default.
- No deferred item was deleted.
