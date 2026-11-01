# R33 — Semantic Continuity Behavioral Evaluation: Specification

**Round:** R33
**Branch:** `rc33-semantic-behavior` (worktree `ef-r33-behavior`)
**Baseline:** R32 `bef473dc77f18a07980031cf110b253fe0288cb1` (`rc32-semantic-integrity`)
**Status:** offline instrument and arms complete; **live model evaluation not executed** (see `R33_LIVE_EVALUATION.md`).

---

## 1. What R33 is asking

R29–R32 built and hardened the mechanisms: archive, fold proof, semantic writer,
validator, journal, replay, working set, root/exit/fork, integrity and recovery.
R33 does not add a memory mechanism. It asks whether those mechanisms change what
a long-running agent *does*:

| Question | Operational form |
|---|---|
| **Q1 Extraction** | From an undifferentiated history, does the writer find the action-critical facts? |
| **Q2 Grounding** | Are the accepted claims supported by the cited user/tool evidence, and are false normative claims refused? |
| **Q3 Delivery** | Does an accepted fact reach the next agent's visible context and state? |
| **Q4 Behavioral utility** | Does the next agent violate fewer constraints, revive fewer obsolete decisions, retry fewer rejected approaches, and make fewer false verification claims? |
| **Q5 Economics** | What do those changes cost in requests, tokens, and wall clock? |

The evaluation is allowed to conclude **no benefit**, **insufficient evidence**,
**Active is worse**, or **benefit limited to a risk class**. Nothing in the
instrument assumes Active wins.

## 2. Execution rules

1. **Freeze before running.** Case manifest, transcript, gold, evidence refs,
   expected/forbidden behavior, checker, fold boundary, seed, and digest are
   written before any arm runs. Gold is never injected into an ordinary arm's
   workspace or prompt.
2. **No fabricated results.** A live run that did not happen is
   `not executed`, never a zero or a guess.
3. **No post-hoc selection.** All frozen cases are reported, including failures.
   A case may be corrected only by a new dataset version that keeps the original.
4. **Production changes require R33 failure evidence.** Only R33-0's diagnostic
   and recovery fixes touch `src/`; no semantic strategy is rewritten while
   comparing it to its own old results.
5. **One global live budget.** A request must satisfy `R33_LIVE=1`, a resolved
   route, positive request/input/output limits, and a positive wall-clock limit
   before it is sent. Zero never means unlimited.

## 3. Arms

| Arm | What it is | What it isolates |
|---|---|---|
| **B0** | Native Basic compaction. | The product's existing baseline. |
| **B1** | EF archive + rationale, semantic continuity **off**. | EF without semantic state. |
| **S** | EF Semantic Active: real writer path, validator, journal, working set. | The treatment. |
| **O1** | Oracle semantic delta: frozen gold deltas go through the **real** validator, plan, journal and renderer. | Delivery/representation, with writer error removed. |
| **O2** | Oracle visible context: the correct minimal facts are placed in the follow-up prompt. | The behavioral upper bound when the agent knows the right facts. |
| **OR** | Oracle retrieval: the compressed state plus the correct **evidence quotes**, not the claims. | Whether retrieval could rescue a delivery gap. |
| **F** | Full history in the follow-up prompt. | Whether the task is solvable with no compression. |
| **N** | Null memory: the task alone. | Whether a case genuinely depends on history. |
| **FM** | Fault arm: the S context plus an injected false fact. | Whether the grader detects wrong memory. |

B0 and B1 are not semantic arms: their extraction metrics are `null`, and the
report asserts that.

`O1` is a **normal-path** oracle: every delta passes the production validator,
including its authority and per-fold limit rules. It is not a bypass. If a
future run needs to bypass a validator, it must be a separate arm named
`oracle-bypass` and must not be reported as product behavior.

## 4. Shared initial state

For a given case, every arm gets:

* the same frozen transcript and fold boundary;
* the same initial workspace files;
* the same follow-up task text;
* its own session, bundle root, semantic root, and workspace.

Counterfactual pairs additionally share the workspace and task **byte for
byte**; only the decisive historical fact differs. This is asserted in
`tests/r33-dataset.spec.ts`.

## 5. Fold validity

A run counts only if a real compaction transaction happened:

* `compaction/start`;
* `compaction/summary`;
* a `compact-checkpoint` replacement;
* `compaction/end` (recorded when present);
* an EF bundle whose rendered body is the checkpoint the surface shows.

A case with no fold is `no-fold` / invalid, never a semantic success. The arms
suite fails if any row is invalid.

## 6. Measurement

### Extraction

* `criticalRecall` — criticality-weighted gold facts matched by an accepted delta.
* `groundedPrecision` — accepted deltas matched to a gold coordinate/statement.
* `falseNormativeRate` — accepted normative deltas with no gold coordinate.
  Denominator reported; `null`, not 0, when no normative delta was accepted.
* `currentStateAccuracy` — current facts visible, superseded facts absent.
* `directVisibility` — current gold facts whose needle is in the checkpoint body.

These are **gold-relative** metrics over a closed-world dataset. They are not a
general truth judgment, and a fabricated quote that happens to match a gold
coordinate would still need the validator's evidence check to pass.

### Behavior

The follow-up agent's action is applied to the workspace and an independent
hidden checker runs **outside** the workspace. It reports named checks plus
`verification.json` claims. The grader records:

* task success;
* constraint violation;
* obsolete-decision revival;
* rejected-approach retrial;
* false verification claim;
* tool calls, tests executed, recall attempts/success.

A model that merely avoids a forbidden word is not counted as successful.

### Cost

Every live request is recorded in one `BudgetLedger`: requests, uncached input,
cache read/write, output, retries, unknown usage, and wall clock. A reservation
for unknown usage is not refunded. Money is not reported unless pricing is
verified; offline runs report wall clock only.

## 7. Statistics

Comparison is **task-level and paired**. Repeated runs of one case are not
independent tasks. The report shows `success / damage / rescue /
no-difference / invalid / not-executed` counts and per-case rows. A deterministic
task-level bootstrap is provided for small samples and is labelled exploratory;
it is not a non-inferiority proof.

## 8. Controls against a rigged evaluation

* **Null control** — N must fail the memory-dependent cases; the report shows it
  does, including where it passes by luck (F1's default action).
* **Full-history control** — F is the compression-free upper bound.
* **No-fold guard** — invalid, not a result.
* **No-gold leakage** — schema checks every history-dependent workspace for the
  gold quote and needle; the hidden checker is written outside the workspace.
* **No-evasive pass** — task success requires the checker; forbidding a word is
  not enough.
* **No post-hoc selection** — all 17 frozen cases are reported.
* **Fault detection** — the FM arm must be detected 8/8; the arms suite fails
  otherwise.

## 9. What this round does not measure

* Real-model extraction quality or real-model action quality. The offline writer
  and agent are scripted; the live path is implemented and gated, not run.
* Natural-pressure folding in a live context window. R33 uses controlled
  boundaries.
* Long-horizon multi-fold, root-rebase, phase-exit behavior with a live model.
* Cross-machine semantic seed transfer.
* Monetary cost (no verified price table was used).

## 10. Deliverables

```
eval/r33/
  README.md        how to run
  cases/           frozen case directories (transcript, gold, workspace, actions, checker)
  manifest.json    dataset id + per-case digests
  freeze.mjs       freeze / verify
  live.mjs         opt-in live runner, --check, --self-test
  src/             dataset, schema, context, workspace, grade, budget
  out/             generated reports (offline, self-test, live status)
tests/r33-*.spec.ts
docs/semantic-continuity/R33_*.md
```
