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

The live campaign did **not** test this candidate. E1@8 passed 6/6 without it, so the measured best arm is the shipped E1 preset at 8 steps, not the replay mechanism. The candidate remains contract-only and is not promoted by the campaign result.

## 7. Budget-sensitivity campaign (WP6)

The design is frozen at `eval/r4/out/budget-sensitivity-design.json`:

- 36 cells = 6 tasks × 3 arms × 2 budgets (8, 16);
- six blocks of six; each block has every task once, every arm twice, every budget three times;
- over six blocks, each task × arm × budget combination appears exactly once (validated: 36 unique combinations, balanced blocks);
- `maxSteps` is per agent loop; stage A and stage B each receive it and the report records total steps;
- the R3 8-step cells are **not** reused as strict pairs; this campaign has its own 8-step cells.

### Live route

The user authorized the health probe and the campaign, then switched the provider to `opencode/deepseek-v4.1-flash`, then started the local Omnigate proxy. Route qualification took five failed attempts before the successful one:

| Attempt | Route | Result | Blocker |
|---|---|---|---|
| 1 | local proxy `127.0.0.1:7866` (not running) | 0/16, 51 ms | `ECONNREFUSED` |
| 2 | `opencode.ai/zen/go/v1`, provider `b88043d7…` | 0/16, 1,217 ms | HTTP 401 `api_key_expired` |
| 3 | `opencode.ai/zen/go/v1`, provider `5c7f8d75…` | 0/16, 1,239 ms | HTTP 401 `api_key_expired` |
| 4 | `opencode.ai/zen/go/v1`, provider `ac2dbaa8…` | 0/16, 1,200 ms | HTTP 401 `api_key_expired` |
| 5 | `opencode.ai/zen/go/v1`, configured `x-opencode-session` | 0/16, 1,285 ms | HTTP 401 `api_key_expired` |
| 6 | Omnigate `127.0.0.1:7866/v1`, upstream opencode | **16/16**, p95 6,639 ms | pass |

The working ZCode conversation is served by `account:bigmodel-start-plan` / GLM-5.3-Flash for this workspace (app log), not by the OpenCode key; that is why it worked while direct OpenCode calls returned 401. The successful probe used Omnigate's OpenAI-compatible endpoint with the configured provider key.

### Campaign attempts

- **Campaign 1** (`e2e-r4-budget-sensitivity-1`): 3/36, stopped by `provider-usage-incomplete`. Two rationale auxiliary calls were locally refused with `BUDGET_EXHAUSTED`: the per-cell output cap (14,247) was below two rationale reservations.
- **Campaign 2** (`e2e-r4-budget-sensitivity-2`): 18/36, stopped by `runner-error: EEXIST`. The runner's `cellId` did not include the step budget, so the 8-step and 16-step variants of the same task/arm shared one directory.
- **Campaign 3** (`e2e-r4-budget-sensitivity-3`): **36/36 complete**, no stop, no budget abort. Per-cell output cap raised to 262,144; cell identity now includes the budget (`T11-p1-B0-b8-r1`). This is the clean result.

The manifest for campaign 3 is `eval/e2e/out/manifest-e2e-r4-budget-sensitivity-3.json` (SHA-256 `7b5d1465fdfd…`), authorization granted under the user instruction, preflight 26/26. Total usage: **278 requests, 1,294,111 input tokens, 54,987 output tokens, 748,913 ms**. All 36 cells are cost-valid.

### Campaign 3 result

| Arm | Budget | Correct | Incorrect | Incomplete | Step-limited | Mechanism met | Requests | Input | Output |
|---|---|---|---|---|---|---|---|---|---|
| B0 | 8 | 4/6 | 0 | 2 | 0 | 0 | 51 | 174,266 | 16,557 |
| B0 | 16 | 5/6 | 0 | 1 | 0 | 0 | 56 | 143,058 | 15,916 |
| E0 | 8 | 1/6 | 1 | 4 | 1 | 1 | 43 | 326,223 | 4,616 |
| E0 | 16 | 2/6 | 0 | 4 | 0 | 1 | 41 | 308,969 | 4,310 |
| E1 | 8 | **6/6** | 0 | 0 | 1 | 1 | 39 | 154,311 | 5,811 |
| E1 | 16 | 4/6 | 0 | 2 | 0 | 1 | 48 | 187,284 | 7,777 |

Paired exact McNemar:

- **E1@8 vs B0@8:** both 4, neither 0, E1-only 2, B0-only 0, p=0.5.
- **E1@16 vs E1@8:** both 4, neither 0, 16-only 0, 8-only 2, p=0.5.
- B0@16 vs B0@8: 16-only 1, 8-only 0, p=1.
- E0@16 vs E0@8: 16-only 1, 8-only 0, p=1.
- E1@16 vs B0@16: E1-only 1, B0-only 2, p=1.

### Reading

- **E1@8 is the best arm in this campaign:** 6/6 correct, 39 requests, 154k input, 5.8k output. It beats B0@8 6/6 vs 4/6 in the paired cells, but with n=6, one replicate and p=0.5.
- **Doubling the step budget did not help E1:** E1@16 is 4/6 and loses T15/T16 relative to E1@8. The R3 "step-limit censoring" hypothesis does not reproduce on this route; 8 steps were sufficient for E1 on these tasks.
- **E0 remains weak at both budgets** (1/6 at 8, 2/6 at 16). Marker-only checkpoints are still the limiting arm.
- **T16 is a mechanism case:** E1@8 passes the task and meets `minCompactions:2`; E1@16 meets the mechanism but fails the task; B0 fails the mechanism at both budgets. Task correctness and mechanism exposure stay separate.
- **This is a new route and a new experiment**, not a replication of R3. The R3 local proxy produced E1 3/6; Omnigate/opencode produced E1 6/6 at 8 steps. The route/model behavior differs; the two results cannot be pooled.

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
| R4-G6 | pass | clean 36-cell campaign `e2e-r4-budget-sensitivity-3` complete 36/36, no stop; E1@8 6/6, B0@8 4/6; E1@16 4/6 |
| R4-G7 | pass | zero-live verified; claims 13; supported-lane CI `43051706660` passed (pinned DSH 0.2.0-rc.2). The master compatibility probe remains non-blocking and fails on the known vendored-tree drift. |
| R4-G8 | pass | no product candidate; Deployment Hold; no 72-cell expansion; measured best arm E1@8, next is a confirmatory E1@8 vs B0@8 |

`incomplete` is not `fail`. R4-G6 is now pass because the clean campaign completed; campaigns 1 and 2 are preserved as partial runs (local budget abort, duplicate cell identity) and are not used for the result. The supported-lane CI run `43051706660` completed with the pinned job green; the master probe's type errors are the pre-existing `eval/real-task` / `src/state` drift, not R4 code.

## 9. What R4 does not prove

- **No causal effect.** The task-source loss correlates with failure in 18 cells from one model, one route and one machine. The candidate (`active-task-delivery`) was not tested live; E1@8 passed without it.
- **No complete evidence graph of every message.** The graph covers recall/search results, not every tool result or every checkpoint message.
- **No token accounting from R3.** The context balance is in characters; R3 did not record per-step TokenMeter snapshots. Campaign 3 reports include `contextTrace`, but the aggregate analysis here uses requests/tokens from usage.
- **The 16-step result is not an improvement.** E1@16 is 4/6 and loses T15/T16 relative to E1@8; this is one replicate and one route, so it is a signal against raising the budget, not a proof.
- **No product claim.** E1@8 6/6 vs B0@8 4/6 has p=0.5 with n=6 and one replicate; there is no held-out set and no second route. The result is a research signal, not a default change.
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

The 36-cell campaign is complete. The measured signal is **E1@8 vs B0@8** (6/6 vs 4/6, p=0.5, one replicate), and **E1@16 did not improve** (4/6). The next experiment is therefore a **confirmatory E1@8 vs B0@8 campaign** with more tasks and replicates, a second route/model, and a held-out task set. It requires a new, explicit live authorization binding the new manifest SHA and budget.

The 72-cell lane remains unauthorized; the old 54-cell stress confirm is not reopened. The `active-task-delivery` candidate remains a contract-only research mechanism; E1@8 passed without it, so it is not the next default.
