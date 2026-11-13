# EF-C0 — Next Milestones

Status: proposal, 2026-11-08. None of these is authorized.

Each milestone names the question it answers, the artifact it must produce, and
the gate it must pass. A milestone without a falsifiable question is not listed.

## M1 — Track A baseline: what does `economy` actually cost and preserve?

**Question.** On a frozen long-horizon task set, does `economy` (with its
current rationale call) preserve the facts Basic preserves, at a lower total
cost?

**Why now.** The RC1.3 17× figure belongs to the zero-LLM profile. Today's
economy tier makes one rationale call per fold, and no frozen cost ledger exists
for it.

**Deliverable.**

```text
frozen task set + manifest (model, route, config, scorer)
B0 vs E0 vs E1, n per cell stated before the run
cost ledger per arm (input, output, cache read, auxiliary)
fact-preservation metric independent of summary similarity
```

**Gate.** A deterministic preflight plus a cost/quality report. A live run
needs a separate authorization naming the manifest SHA.

**Status.** Not authorized. This is the cheapest path to a product-level claim.

## M2 — S1.1: split user decision authority from assistant decision authority

**Question.** Can a deterministic rule distinguish a decision made by the user
from one made by the assistant, so that an assistant decision cannot retire a
user decision?

**Why now.** This is the documented remaining safety hole from R38. The
`decision` domain currently has one rank.

**Deliverable.**

```text
a rule grounded in event source (user message vs model message)
fixtures for: user decision, assistant decision, tool finding
the minimal planner change, if the rule is sound
a regression test that fails before the change
```

**Gate.** A deterministic relation-authority suite; no live call.

**Status.** Research. A rule that infers intent from text would be worse than
the current limitation; the rule must come from event provenance.

## M3 — S2.1: acquisition audit — what does the writer never propose?

**Question.** Of the facts a case is known to require, how many did the writer
never propose, and can that omission be measured without a gold-fed writer?

**Why now.** R37-B measured accepted deltas; it did not measure omission. The
writer cannot be improved until omission is visible.

**Deliverable.**

```text
a per-case fact inventory derived from the raw transcript, not the writer output
accepted / committed / omitted / refused counts
a writer prompt or validator change only if the omission is attributable
```

**Gate.** A frozen acquisition metric on held-out cases; no gold leakage into
the writer input.

**Status.** Research. This is the hardest measurement problem in the layer.

## M4 — S3.1: make the task-aware selector a product candidate

**Question.** Does a task-aware working set improve long-task effectiveness
without breaking the stable prefix?

**Why now.** R38 certified the selector on fixtures. It has no Task Frame
source and no production registration path.

**Deliverable.**

```text
a Task Frame source (session events + host-declared task root)
a per-agent context registration
a prefix-stability test: the stable prefix is byte-identical across steps
a behavioral comparison against recency-only selection
```

**Gate.** C1–C7 plus a prefix-digest test. A behavioral claim needs M1's
harness discipline.

**Status.** Research, not wired.

## M5 — R38-M1 re-preregistration

**Question.** Which single semantic variable is worth a confirmatory live
batch, given R37-B's negative Active result?

**Why now.** The existing R38-M1 proposal is on hold: too many variables, no
manifest freeze, no authorization.

**Deliverable.**

```text
one variable (e.g. user/assistant authority, or selector delivery)
a frozen manifest with SHA-256
cell count, budget, stop rules
a preflight that passes without a provider call
```

**Gate.** G1-equivalent safety gate first, then a bounded batch.

**Status.** On hold. A new manifest supersedes the old preregistration by name
and SHA; the old file is not edited.

## Ordering

```text
M1  Track A baseline        cheapest product evidence, protects the core
M2  authority split         highest remaining safety question
M3  acquisition audit       prerequisite for writer improvement
M4  selector candidate      depends on a Task Frame source
M5  re-preregistration      only after M1-M3 narrow the question
```

M1 is first because the product line needs a real cost/quality baseline before
any semantic feature can be judged against it. M2 is second because a safety
hole outranks a benefit claim.

## What none of these milestones authorize

```text
a live model call
a push
a merge
a new dependency
a new agent loop
a production default change
```

Each needs its own decision.

## Evidence

```text
docs/convergence/RESEARCH_ROADMAP.md
docs/convergence/BASELINE_EVIDENCE_REVIEW.md
docs/convergence/CI_AND_RELEASE_GATES.md
```
