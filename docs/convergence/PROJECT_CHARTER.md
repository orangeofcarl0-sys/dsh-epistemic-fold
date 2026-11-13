# EF-C0 — Project Charter

Status: governing document, effective 2026-11-08.

This charter does not replace the RFC. It states which parts of the RFC are the
product, which are optional, and which remain research — and how a capability
moves between those states.

## 1. The vision this charter protects

```text
History ≠ Memory ≠ Context
```

- **History** is the durable record. It is the authority.
- **Memory** is what can be recovered from history or derived deterministically.
- **Context** is the working view a model needs for the next request.

EF exists because long-horizon compaction breaks four things:

```text
Summary Drift
Stale State
Unrecoverable Loss
Prefix Churn
```

The product claim is narrow and testable: a fold may reduce the surface only
after durable provenance exists, and what left the surface must remain
recoverable exactly.

EF is **not** token truncation. Semantic work — identifying decisions and
constraints, keeping negative knowledge, maintaining grounded state, handling
supersession, delivering relevant context — is part of the long-term research
program. This charter does not declare that research finished or pointless. It
separates the parts that are safe to ship from the parts that are still being
measured.

## 2. Three tracks

| Track | Name | What it is | Default |
|---|---|---|---|
| **A** | Compression Runtime | the folding contract: legality, archive-before-loss, frontier, leaf/root policy, checkpoint, bounded recall, deterministic state, prefix stability, cost accounting, fallback, observability | **product** |
| **B** | Semantic Continuity | semantic writer, evidence validator, authority, journal, commit proof, replay, supersession, working set | **optional**, default `off` |
| **C** | Context Intelligence | task-aware selection, archive recovery, cross-coordinate integrity audit, recent-tail reconciliation, task overlay | **research** |

Track A must work with Track B switched off. That is a tested contract, not an
aspiration (`tests/convergence-boundaries.spec.ts`).

Track B may become a product capability, but only per feature and only with its
own safety and benefit evidence. It is not promoted as a block.

Track C is allowed to remain more ambitious than the product. Its code lives
under `eval/`; it does not enter the runtime path by existing.

## 3. Ownership

EF owns the **folding contract** and its **derived state**. It does not own the
things DSH already owns.

| Domain | Canonical owner | EF's role |
|---|---|---|
| completion goal | DSH goal service | does not duplicate |
| plan / todo | DSH planning service | does not duplicate |
| project instructions | instruction loader / `AGENTS.md` | does not duplicate |
| tool execution | DSH `ToolRuntime` | does not duplicate |
| session events | DSH session | reads; never rewrites |
| fold transaction, bundles, frontier | **EF** | owns |
| deterministic projection of folded history | **EF** | owns |
| semantic journal and commit receipts | **EF** | owns, when enabled |
| task-aware selection / recovery | **EF research** | owns as research |

The DSH session remains the canonical truth for history. EF's semantic state is
a derived, evidence-bound projection; it may not rewrite the session, and it
may not become a second history.

## 4. Non-goals

### 4.1 Long-term non-goals

These are architectural, not temporary:

- rewriting the DSH Agent Loop;
- replacing DSH goal or planning services;
- taking over general tool execution;
- making EF's state the canonical session record.

### 4.2 Current product non-goals, open to research

These are not shipped as product defaults, but they are **not permanently
closed**:

- semantic dependency graph;
- advanced task-relevant retrieval;
- memory maintenance;
- cross-session knowledge;
- LLM-assisted semantic revision;
- learned compression policy;
- embedding / vector backends.

A capability in this list can become a product candidate only with independent
evidence. "We built it" is not evidence.

## 5. Promotion states

```text
Research
  ↓  deterministic fixture + mechanism evaluation
Mechanism Certified
  ↓  safety gate + bounded behavioral experiment under a frozen manifest
Product Candidate
  ↓  product-level evidence: quality, cost, reliability, compatibility
Stable
```

A capability may also be:

```text
Blocked       a gate cannot be verified
Deferred      not justified yet; may reopen with new failure evidence
Superseded    replaced by a later mechanism or measurement
```

Rules:

1. `Mechanism Certified` is never reported as `Product-level Evidence`.
2. A research result under a custom harness is not a product result.
3. A product promotion needs a frozen configuration and a cost ledger.
4. A safety failure blocks promotion regardless of benefit.
5. A capability that fails to show benefit is deferred, not deleted, so the
   evidence stays available.

## 6. Reconciliation with the historical "CLOSED" statement

`docs/00_README_EF.md` records M1, M3b, M4 and M5 as `CLOSED / deferred`, and
`DeltaLeaf` as `REJECTED`. That statement was correct **for the product
roadmap of its time**: none of those stages was a prerequisite for the M0–M3a
product, and none had evidence justifying the complexity.

It does **not** mean the research questions were answered. R33–R38 continued
semantic research under a separate program, and R38-M0 found a real
authorization defect in the semantic layer. Both facts are consistent with the
old statement once the scope is made explicit:

```text
CLOSED as a product prerequisite     yes
CLOSED as a research question        no
```

This charter adopts the second reading. M3b/M4/M5 remain **Deferred**, not
permanently closed, and may reopen only with new failure evidence and a new
preregistered experiment.

## 7. Change discipline

- A production change needs a failing reproduction or a stated contract, a
  minimal fix, and a regression test.
- A new LLM component may not replace a deterministic mechanism that already
  works. Adding a model call is a cost and a failure mode, not an upgrade by
  default.
- Feature flags are strict: a typo must not enable a feature.
- Off must mean no hidden semantic effect.
- Research code may not silently become a runtime default.
- A round that finds no benefit says so. A round that cannot verify a gate says
  `blocked` or `not-verifiable`, never `passed`.

## 8. What this charter does not decide

- It does not choose the next product feature.
- It does not authorize R38-M1 or any live experiment.
- It does not merge, rebase or re-tag any branch.
- It does not declare Track B or C finished.

Those are separate decisions with separate evidence, recorded in
`RESEARCH_ROADMAP.md` and `REPOSITORY_GOVERNANCE.md`.
