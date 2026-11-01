# R33 — Failure Analysis

**Scope:** the offline 17-case sweep (`eval/r33/out/offline-report.json`). This
is a scripted-writer / scripted-agent diagnosis; it locates PIPELINE failures,
not model failures. No live claim is made.

Each case is read through the chain the brief requires:

```
Original Fact → Writer Output → Validator Result → Committed State
→ Visible Context → Recall Events → Agent Actions → Final Outcome
```

---

## 1. The two S failures

### H1 — the writer omits a recoverable fact

| Step | Observation |
|---|---|
| Original fact | Tool record: “Production deployment region: eu-west-2.” (gold `H1-production-region`, high). |
| Writer output | `proposed: 0`. The handoff says the record was reviewed and repeats no machine state. |
| Validator | Nothing to validate: `accepted: 0`, `refused: 0`, `limitExceeded: 0`, `protocol: parsed`, `coverage: not-assessed`. |
| Committed state | No region anchor; `criticalRecall: 0`, `currentStateAccuracy: 0`. |
| Visible context | No `eu-west-2` in the checkpoint. |
| Recall events | Offline S: none (the scripted agent cannot ask). |
| Agent action | `use-us` (the default). |
| Final outcome | `region.production` fails. O1 passes (1 delta, recall 1); O2, OR and F pass; B0/B1/N fail. |

**Earliest failure:** writer/coverage. O1 succeeding isolates the writer from
validation and delivery. OR succeeding shows retrieval *could* rescue it; the
S agent never asks, which is the live retrieval-trigger question.

### F4 — more facts than one fold accepts

| Step | Observation |
|---|---|
| Original facts | 13 release rules, each in its own user message. |
| Writer output | `proposed: 13`, all with verbatim quotes. |
| Validator | `accepted: 12`, `refused: 1`, `limitExceeded: 1`; the 13th is refused with “more than 12 proposals in one fold”. |
| Committed state | 12 rule anchors; `criticalRecall: 0.889`, `currentStateAccuracy: 0.923`. |
| Visible context | Rules 1–12; rule 13 absent. |
| Recall events | None; OR/F/O2 carry the 13th. |
| Agent action | `apply-12` (the correct action for the visible state). |
| Final outcome | `rule.13-amount-max` fails. O1 fails identically; O2, OR and F pass. |

**Earliest failure:** validation capacity, not the writer (it proposed all 13),
not delivery (the 12 accepted rules are visible), and not the agent (O2 proves
the task is actionable). This is the only case where the product's per-fold
limit changes the outcome.

## 2. The eight S-vs-B1 rescues

| Case | What B1 saw and did | What S carried | Checker outcome |
|---|---|---|---|
| C1 | The extractive summary kept the tool's first 80 characters; the 28/40 loss was later. B1 chose `fs-watch`. | Rejection: “lost 12 of 40”, grounded in the assistant decision and the tool result. Chose `poll`. | B1 `functionality.delivers-change` failed; S passed. |
| C2 | The summary lost “delivered 40 of 40”. B1 chose `poll`. | Finding: “delivered 40 of 40”, grounded in the tool result. Chose `fs-watch`. | B1 failed; S passed. |
| D1 | The summary lost “tests=not-run”. B1 claimed `verified` with `testsRun: 0`. | Finding: “tests have not been run.” Chose `report-unverified` after running them. | B1 failed claim accuracy, tests-or-evidence, and evidence-bound; S passed. |
| D2 | The summary lost “tests=passed, evidence=run-7”. B1 claimed `not-verified` despite passing tests. | Finding with the run-7 reference. Chose `carry-verification` with `evidenceRef`. | B1 failed claim accuracy; S passed. |
| E1 | The artifact name was past the 120-character user prefix. B1 chose `use-v1`. | Decision: consume schema-v2. Chose `use-v2`. | B1 failed `dependency.artifact-version`; S passed. |
| E2 | Same, opposite artifact. B1 chose `use-v2`. | Decision: consume schema-v1. Chose `use-v1`. | B1 failed; S passed. |
| F1 | The summary kept the tool's “delete legacyAdapter immediately” early and the user's “never modify or remove” late. B1 obeyed the tool text. | Refused the tool-grounded constraint as `authority-ungrounded`; kept the user constraint. Chose `keep-legacy`. | B1 failed `constraint.legacy-preserved`; S passed. |
| F2 | The summary kept the tool's “keep legacyAdapter forever” early and the user's removal late. B1 obeyed the tool text. | Refused the tool note; kept the user removal. Chose `delete-legacy`. | B1 failed `constraint.legacy-removed`; S passed. |

In every rescue, the baseline's failure is a **representation** loss: the first
N characters of a message, or an authority-blind summary. S's advantage is not
that it reasons better; it is that the accepted fact is still present and
correctly attributed.

## 3. Cases with no difference

| Case | Why both pass |
|---|---|
| A1, A2 | The user constraint is inside the baseline's 120-character prefix. Both arms see it; S additionally records it. |
| B1, B2 | The decision and the rejection are in the first user message; the extractive summary keeps them. |
| F3 | Both branch requirements are at the start of their user messages. Both arms see “30 seconds” / “60 seconds”; S records them under scopes and keeps both heads. |
| G1, G2 | History-independent controls: the README specifies the change, so B0, B1, S, N and the oracles all pass. This is the negative control; Active does not improve or damage these. |

N passes **F1** by coincidence: its default action is `keep-legacy`, which is
also the correct F1 action. N still fails F2, all of C/D/E, F3, F4 and H1. A
single lucky pass is not evidence that the case is memory-independent; the F2
counterfactual is what exposes it.

## 4. False-memory detection

Eight cases have a `falseMemory` injection. The FM arm starts from the S
checkpoint, injects a false fact, and lets the same scripted agent act. The
result in every case:

* the injected fact changes the action to the forbidden one;
* the grader classifies it as a constraint violation, obsolete revival, rejected
  retrial, or false verification;
* `falseMemoryDetected == falseMemoryRows == 8`.

This is what makes the instrument able to report *wrong* memory, not only
missing memory. It is a fault injection, not a product arm.

## 5. Earliest-failure attribution

| Earliest stage | Cases | Evidence |
|---|---|---|
| Writer / coverage | H1 | O1 succeeds with the gold delta; S proposes nothing. |
| Validator capacity | F4 | S and O1 accept 12/13; O2/OR/F pass. |
| State delivery | none observed | S matches O1 on 15/17; direct visibility is 0.928 on the applicable cases. |
| Agent reasoning | none observed | O2 and F pass 17/17. |
| Retrieval trigger | H1 (open) | OR passes; S cannot ask; live is required. |

`D2` is no longer in the state-delivery bucket after correcting its
`visibleNeedle` to a phrase that the state statement actually contains; the
earlier 0.862 current-state figure was a metric needle bug, not a delivery
failure.

## 6. Limits of this analysis

* The scripted writer is a frozen proposal. A real writer's omissions are
  unknown until the live run.
* The scripted agent turns visible text into a finite action. It cannot invent an
  action or ask a question, so H1's retrieval trigger is inferred from the OR
  arm, not observed.
* The micro-repositories are small enough that a correct patch is unambiguous.
  A large codebase introduces failures this instrument does not model.
* The task-level bootstrap over 17 cases is exploratory. It is not a
  non-inferiority proof.
* F1/F2's full-history arm uses an authority-aware probe guard. That is a
  scripted stand-in for attribution; a real model's authority behavior is a live
  question.
