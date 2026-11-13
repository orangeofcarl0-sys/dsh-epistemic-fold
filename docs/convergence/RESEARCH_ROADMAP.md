# EF-C0 — Research Roadmap

Status: current, 2026-11-08.

The convergence does not close semantic research. It separates it from the
product baseline so both can continue without pretending to be the same thing.

## 1. Research tracks

### S1 — Semantic State Integrity

Question: can EF commit a new fact without wrongly changing other valid state?

Open items, in priority order:

1. **User vs assistant decision authority.** The `decision` domain does not
   distinguish a user decision from an assistant decision. A user decision can
   be retired by an assistant decision at the same rank. This is the highest
   remaining safety question.
2. **Cross-coordinate supersession.** R38 fixed authorization and withholding;
   completeness across more than two coordinates is still fixture-sized.
3. **Revision idempotency at the storage boundary.** The reducer is idempotent
   for declares; the once-only boundary is the commit-state digest. A crash
   between staging and bundle write is R31/R32's surface, not R38's.
4. **Negative knowledge lifecycle.** `rejected-approach` is represented; how a
   rejection is retired when its reason disappears is not measured.
5. **Recent-tail consistency.** R38's assessment is a candidate detector, not a
   reconciliation mechanism. No auto-revision exists, deliberately.

State: `Mechanism Certified` for the R38 subset; the authority split is
`Research`.

### S2 — Semantic Acquisition Quality

Question: does the writer capture the facts that matter, at a cost that is
worth it?

Open items:

1. **Accepted vs committed fact recall.** R37-B's writer pilot showed W1
   better than W0, but accepted deltas are not committed facts.
2. **Writer omission.** A fact never proposed cannot be audited. This is the
   hardest measurement problem in the layer.
3. **Relation-aware delta proposal.** The writer proposes `supersedes` /
   `dependsOn` / `rulesOut`; R38 added the authorization rules, not a better
   proposal.
4. **Commit conversion rate.** How many accepted deltas become committed state,
   and why the rest are refused.
5. **Semantic false positives.** A plausible claim with a real quote that is
   nonetheless wrong.
6. **Cost per useful committed fact.** The rationale call is paid per fold; the
   useful-fact yield is not measured per route.

State: `Behavioral Observation` under custom harnesses; no product-level result.

### S3 — Context Relevance

Question: at the start of a task, can EF deliver the constraints, decisions and
negative knowledge that task needs, rather than what is merely recent?

Open items:

1. **Task-aware selection.** R38's selector is `Mechanism Certified` on
   fixtures. It is not wired to a Task Frame source.
2. **Archive-only recovery.** R38 recovers facts that never entered state, with
   honest coverage statuses. It is eval code; no engine-level path exists.
3. **Retrieval triggerability.** A delivered fact the model does not read is
   not delivered. This needs behavioral measurement.
4. **Scope applicability.** R38 records scope mismatches; a production scope
   resolver does not exist.
5. **Context budget.** The selector has a token budget; the production
   checkpoint budget is `semanticCheckpointTokens`, which is reported and not
   enforced by deleting pinned state.
6. **Prefix-cache impact.** An overlay that changes per task may break the
   stable prefix. R38's overlay is re-emitted only when text changes; the cost
   on a real route is not measured.

State: `Mechanism Certified` for selection/recovery; `Research` for production
wiring.

### S4 — Longer-term Memory Architecture

Question: does EF need anything beyond exact archive, deterministic state and a
bounded working set?

Candidate directions, none justified yet:

```text
temporal semantic relations
memory maintenance
cross-session knowledge
advanced retrieval
LLM-assisted reconciliation
```

These remain open. They are not forbidden, and they are not on the roadmap as
commitments. A direction enters S1–S3 only with a failure corpus that the
current mechanisms cannot handle.

## 2. Promotion states

| Capability | State | Next evidence needed |
|---|---|---|
| Relation authorization / withholding | Mechanism Certified | behavioral experiment |
| Revision identity | Mechanism Certified | crash-boundary test |
| Integrity auditor | Mechanism Certified | production packet volume |
| Task-aware selector | Mechanism Certified | Task Frame source + behavioral test |
| Archive recovery | Mechanism Certified | engine-level path + behavioral test |
| Recent-tail assessment | Mechanism Certified | reconciliation policy |
| Native overlay | Mechanism Certified | model behavior under the overlay |
| User/assistant decision authority | Research | a deterministic rule + fixtures |
| Writer acquisition quality | Behavioral Observation | a frozen acquisition metric |
| Track B as a product capability | Deployment hold | product-level evidence |

## 3. R38-M1 status

```text
status          historical research proposal
execution       on hold pending convergence
authorization   none
manifest        not frozen for execution
```

Why it is on hold:

1. It was written before the convergence separated Track A/B/C.
2. It mixes native runtime, S0/S1/S2, task-aware selection, archive recovery and
   multiple benchmarks in one ~80-cell batch. That is too many variables for one
   confirmatory experiment.
3. R37-B already showed a negative contract difference for Active under a
   custom harness. A new batch must explain why the next configuration would
   differ, not simply run more cells.

Conditions to resume:

```text
1. the convergence documents are the baseline (this round)
2. a new manifest is frozen and hashed
3. the cell count and budget are stated
4. a preflight passes without a provider call
5. the user authorizes that exact manifest SHA
6. the safety gate (G1-equivalent) passes first
```

The old preregistration file is not overwritten. A new manifest supersedes it
by name and SHA.

## 4. Product vs research boundary

A semantic capability becomes a product candidate only when it improves one of:

```text
compaction correctness
historical recovery
context continuity
long-task effectiveness
net cost
```

and the complexity and risk are acceptable. Offline coverage is not a product
benefit. A mechanism test is not a behavioral result.

## 5. What is deliberately not on the roadmap

- a new agent loop;
- a background memory agent;
- an embedding backend as a prerequisite;
- a graph database;
- replacing DSH goals/plans/tools.

These are not deferred with a date. They are outside EF's ownership.

## 6. Evidence

```text
docs/convergence/PROJECT_CHARTER.md
docs/convergence/BASELINE_EVIDENCE_REVIEW.md
docs/convergence/data/evidence-registry.json
docs/semantic-continuity/R38_M1_PREREGISTRATION.md   (historical, unchanged)
```
