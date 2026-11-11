# EF-R4 — Continuation Integrity & Evidence Working-Set Dynamics

**Status:** offline stage complete; no live run authorized. Baseline `07540d0` on `chore/ef-c1-evaluation-foundation`. PR #5 remains open; no merge, release or deploy.

## 1. Why R4 exists

R3 established that EF can commit a checkpoint, deliver it, and keep an exact archive. It did not explain why the 18-cell product pilot still produced B0 5/6, E0 1/6, E1 3/6. The R3 trajectory analysis named a `step-limit + recall → fold` pattern, but it could not answer the decisive question:

> When the model recalls a historical fact, is that exact payload still visible at the next primary request — or does the next fold remove it, and does the task contract leave with it?

R4 answers that question from the R3 raw traces, without a new model call. It also repairs the R3 scorer, which mixed task correctness with the `minCompactions` mechanism requirement.

The most important prior observation is in the R3 reports already: `activeDelivery` records the exact task prompt as **absent** from later requests in the failing EF cells. R4 turns that observation into a per-seq, per-request audit.

## 2. Measurement repair (WP1)

R3 recorded one `checker.pass` that combined:

1. the workspace answer is correct (`task.checks`);
2. the cell actually committed the required number of folds (`requires.minCompactions`).

R4 separates four independent axes:

| Axis | Values | Source |
|---|---|---|
| `taskOutcome` | `correct`, `incorrect`, `incomplete` | task checks + whether `finish` was called |
| `mechanismExposure` | manifested, committed, delivered, required met | witnesses and `requires` |
| `termination` | kind, finish called, step-limit stage, steps used | runner and report |
| `cost` | `usageCompleteR3`, `usageCompleteR4`, unknown usage | request usage objects |

The precedence is explicit:

- all task checks pass → `correct` (even if the step limit later fired);
- a check fails and `finish` was called → `incorrect`;
- a check fails and the cell was censored → `incomplete`.

The harness now accepts `maxSteps` from the manifest/cell instead of the hardcoded 8, records the step limit **per stage**, writes real `finalFiles`, preserves `agentErrors`, and records a `contextTrace` per primary request for future token-snapshot measurement. The report schema is v2; R3 reports are untouched.

### Historical and rescored result

| Arm | Historical pass | Task correct | Incorrect | Incomplete | Mechanism met | Cost-valid R3 | Cost-valid R4 |
|---|---|---|---|---|---|---|---|
| B0 | 5/6 | 5/6 | 0 | 1 | 0 | 6 | 6 |
| E0 | 1/6 | 1/6 | 0 | 5 | 1 | 6 | 6 |
| E1 | 3/6 | 3/6 | 1 | 2 | 1 | 5 | 5 |

E1 vs B0 remains: both 3, neither 1, E1-only 0, B0-only 2 (exact McNemar p=0.5). The rescore does not change the historical benchmark; it separates the axes. T11-E1 is the only `incorrect` (it called `finish` with the wrong value); the E0 failures are `incomplete` (step-limited, no finish).

## 3. Evidence lifecycle (WP2)

Every recall/search result is identified by its `tool/result` event seq. Every fold is identified by `compaction/summary.shadowedSeqs`. The next request is the first primary request carrying that fold's checkpoint digest. Visibility is an exact `toolCallId` match; a substring in the checkpoint is only `equivalent-inferred`.

Across the 18 pilot cells:

| Measure | Count |
|---|---|
| Recall/search calls | 67 |
| Results shadowed by a later fold | 53 |
| Payload not carried verbatim into the next request | 51 |
| — marker-only checkpoint | 24 |
| — invisible after fold | 20 |
| — no following request | 12 |
| Visible | 9 |
| Equivalent inferred (exact quote) | 2 |
| Unknown | 4 (6.0%) |

The relation

```
resultSeq(R) ∈ shadowedSeqs(F)
```

is verified for every counted re-fold. The graph does not treat a paraphrase as identity; an unknown is reported as unknown.

The per-cell pattern is the useful part:

- **E0 (marker-only):** repeated recall followed by another fold, with a marker-only checkpoint. The model can re-read the archive, but the next fold replaces the retrieved messages with another marker.
- **E1 (rationale):** the checkpoint carries method and sometimes exact values, but the retrieved payload is not visible verbatim. T15/T16 then fail to write the deliverable.
- **B0:** no recall calls; the retained tail carries the fact. B0's failures are different (T16 schema and fold count).

## 4. Task continuity (WP3)

The exact task source is the first user event carrying the task prompt. A fold "loses" it only when the source seq is in that fold's `shadowedSeqs`; a guessed surface replay is not used.

| Arm | Cells | Exact task source lost | Shadowed by a fold | Lost and never wrote |
|---|---|---|---|---|
| B0 | 6 | 0 | 0 | 0 |
| E0 | 6 | 5 | 5 | 5 |
| E1 | 6 | 2 | 2 | 2 |

The overlap with failure is the R4 headline:

- **7 of the 8 failed EF cells** lose the exact task source and make **no write**.
- **0 of the 4 passing EF cells** lose it.
- The exception is **T11-E1**: no task loss, no recall, and it writes the *current* failure count `1` instead of the historical baseline `3`. That is an evidence-scope error (H2), not a working-set error.
- **T16-B0** is the control on the other side: it keeps the task source and still fails on the output key and the required fold count.

The required artifact path is a second, independent check. In E0 T11/T12/T13/T15 and E1 T15, the path is absent from the user/checkpoint bytes at the same request where the prompt is lost. T16 E1 loses `release.json` from the stage-B prompt at request 20. The audit does not count a directory listing as a contract.

Stage B is certified separately: all three T16 cells deliver `taskB` (first exact request 8 for E0, 9 for B0, 12 for E1), and the earlier task source is absent by then. The R4 evidence does not show that the system kept stage A as the only root; it shows that the stage-B prompt becomes the active visible contract and is later lost in the failures.

## 5. Working-set dynamics and failure projection (WP4)

### 5.1 Character-level context balance

R3 has no per-step TokenMeter snapshot, so R4 reports **characters**, not tokens:

| Arm | Net chars (recall + tool + checkpoint − reclaimed) | Repeated recall | Re-folded payloads | Task-source-lost requests |
|---|---|---|---|---|
| B0 | −89,947 | 0 | 0 | 0 |
| E0 | +826,954 | 14 | 42 | 31 |
| E1 | +35,166 | 2 | 9 | 14 |

E0's positive balance is the signature of a high-cost, low-net-progress loop: each recall and each new checkpoint costs more than the fold reclaims, while the task source is already gone. This is a research signal, not a billing result; chars are not provider tokens.

### 5.2 OPEN failure projection

The final T16 checkpoints are the clearest projection problem:

| Cell | Open failures | Duplicate signatures | Open share of checkpoint |
|---|---|---|---|
| T16 E0 | 5 | 2 | 91.2% |
| T16 E1 | 9 | 4 | 32.1% |

The anchors are rendered as opaque call ids:

```
- [failure] failure:call_15fee139... (open): {"callId":"call_15fee139..."}
```

The failing path and error class are not in the checkpoint; they are recoverable only by joining the callId back to the tool call and result. The duplicates are repeated `list_dir logs` / `read_file logs/deploy-1.log` ENOENT failures. R4 measures this; it does not retire a failure or change the canonical state.

Across all 18 cells: 15 open failures, 6 duplicate signatures, 3 cells with open failures, 2 cells with duplicates.

## 6. Candidate decision (WP5)

The rules were fixed before the numbers were read:

| Rule | Met | Actual |
|---|---|---|
| H1a task-source loss | yes | 7 failed EF cells with loss and no write; 0 passing EF cells with loss |
| H1b recall re-folding | yes | 51 / 53 shadowed payloads not visible verbatim |
| H2 evidence scope | yes (one case) | T11-E1: no loss, no recall, wrong historical value |
| Failure projection inflation | yes | T16 E0 91.2% / 2 duplicates; T16 E1 32.1% / 4 duplicates |

Precedence selects **`active-task-delivery`**: a bounded replay of the *original user event bytes* when the exact source is absent from a primary request. It is not a summary, not a new user instruction, and not a pin:

- `mutatesFold: false`
- `pinsSurface: false`
- `authority: replay-of-original-user-event`
- `maxRedeliveries: 2`

The offline simulation over the seven affected cells adds **1,238 prompt chars** in total (two deliveries per cell at most), against checkpoints of 47–2,897 chars. The candidate is a contract only; it is not wired into the plugin and no default changes.

The candidate is deliberately **not** a product candidate. It is selected because it is the first precondition for using any recovered evidence; the re-folding and failure-projection findings remain secondary and are not additional candidates.

## 7. Budget-sensitivity design (WP6)

The design is frozen at `eval/r4/out/budget-sensitivity-design.json`:

- 36 cells = 6 tasks × 3 arms × 2 budgets (8, 16);
- six blocks of six; each block has every task once, every arm twice, every budget three times;
- over six blocks, each task × arm × budget combination appears exactly once (validated: 36 unique combinations, balanced blocks);
- `maxSteps` is per agent loop; stage A and stage B each receive it and the report records total steps;
- the R3 8-step cells are **not** reused as strict pairs; this campaign has its own 8-step cells;
- `executionAuthorized: false`; no authorization SHA; no provider call.

The budget estimate from R3 is a proposal only. A live grant must bind the final manifest SHA and set the real envelope.

A separate `workspace-readable` task family is recorded as design-only. It is not generated and must not be pooled with the archive-only family: putting the logs in the workspace would turn a history-recovery task into a `read_file` task.

## 8. Gates

| Gate | Status | Detail |
|---|---|---|
| R4-G0 | pass | `07540d0`; 70/70 immutable R3 artifacts; worktree clean |
| R4-G1 | pass | scoring contract 8/8; historical and rescored B0 5/6, E0 1/6, E1 3/6; E1-B0 both 3 / neither 1 / E1-only 0 / B0-only 2 |
| R4-G2 | pass | evidence contract 11/11; 67 calls; 53 folded; 51 not visible; unknown 4 (6.0%) |
| R4-G3 | pass | 18 cells; 3 stage-B cells; 7 failed EF with task loss; 0 passing EF with loss |
| R4-G4 | pass | 18 cells; repeated 16; re-fold 51; task-lost 45 requests; 15 open failures; 6 duplicates |
| R4-G5 | pass | `active-task-delivery`, contract present, not wired |
| R4-G6 | incomplete | 36-cell campaign frozen; `executionAuthorized:false`; live-not-authorized |
| R4-G7 | pass | zero-live verified; claims 10; supported-lane CI `43051706660` passed (pinned DSH 0.2.0-rc.2). The master compatibility probe remains non-blocking and fails on the known vendored-tree drift. |
| R4-G8 | pass | no product candidate; Deployment Hold; no 72-cell expansion |

`incomplete` is not `fail`. R4-G6 can only become pass under a new explicit live authorization. The supported-lane CI run `43051706660` completed with the pinned job green; the master probe's type errors are the pre-existing `eval/real-task` / `src/state` drift, not R4 code.

## 9. What R4 does not prove

- **No causal effect.** The task-source loss correlates with failure in 18 cells from one model, one route and one machine. The candidate has no live test.
- **No complete evidence graph of every message.** The graph covers recall/search results, not every tool result or every checkpoint message.
- **No token accounting.** The context balance is in characters; R3 did not record per-step TokenMeter snapshots. A future run uses `report.contextTrace`.
- **No 16-step result.** The 8-step EF failures remain censored. The budget-sensitivity campaign is designed but not authorized.
- **No product claim.** The candidate adds exact prompt bytes; whether the model acts on them, and at what cost, is unmeasured.
- **Not every failure is explained.** T11-E1 is an evidence-scope error; T16-B0 is an output-schema and fold-count failure; the task-delivery candidate does not address either.

## 10. Reproduction

```bash
npm run build
node node_modules/vitest/vitest.mjs run \
  tests/r4-scoring.spec.ts tests/r4-task-continuity.spec.ts \
  tests/r4-working-set.spec.ts tests/r4-candidate.spec.ts
node eval/r4/contracts/scoring-contract.mjs
node eval/r4/rescore.mjs
node eval/r4/contracts/evidence-graph-contract.mjs
node eval/r4/evidence-graph.mjs
node eval/r4/task-continuity.mjs
node eval/r4/working-set.mjs
node eval/r4/candidate-decision.mjs
node eval/r4/freeze-budget-sensitivity.mjs
node eval/r4/product-decision.mjs
node eval/r4/zero-live-audit.mjs
node eval/r4/evidence-claims.mjs
node eval/r4/gates.mjs
```

Artifacts are under `eval/r4/out/`. The R3 artifacts under `eval/r3/out/` and every `eval/e2e` report/raw file are read-only.

## 11. Next step

The only defensible next experiment is the frozen **36-cell step-budget sensitivity** campaign: the same six archive-only tasks, all three arms, 8 and 16 steps, interleaved. It requires a new, explicit live authorization binding the final manifest SHA and budget. The 72-cell lane remains unauthorized; the old 54-cell stress confirm is not reopened.

If the 16-step cells still lose the task source and make no write, the next question is the candidate's live behavior, not a larger sample. If they complete, the cost and latency of the extra steps must be reported before any product claim.
