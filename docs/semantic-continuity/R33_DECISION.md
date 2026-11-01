# R33 — Decision

**Question:** does reliable semantic continuity make a long-running agent more
correct, continuous and economic than history compression alone?

**Answer available this round:** under a scripted pipeline, **yes on the
pipeline-level cases**; under a real model, **insufficient evidence** because
the live run is blocked. The two must not be merged into one accuracy number.

---

## 1. Decision labels

| Label | Applies? | Evidence |
|---|---|---|
| **Positive behavioral benefit** | **Yes, scripted pipeline only.** | S 15/17 vs B1 7/17, 8 rescues, 0 damage; B0 identical to B1. |
| **Insufficient evidence (live model)** | **Yes.** | Live run `not-executed`; no request, no token, no score. |
| **Writer / coverage bottleneck** | **Yes.** | H1: S proposes 0; O1 (gold delta) passes. |
| **Validation / capacity bottleneck** | **Yes.** | F4: S and O1 accept 12/13; O2/OR/F pass; `limitExceeded: 1`. |
| **State delivery bottleneck** | **Not observed.** | S matches O1 on 15/17; direct visibility 0.928 on applicable cases. |
| **Retrieval trigger bottleneck** | **Possible; not observed as a model behavior.** | OR passes H1; the offline S agent cannot ask. |
| **Model / action bottleneck** | **Not observed.** | O2 and F pass 17/17. |
| **No demonstrated benefit** | **For long-horizon / natural pressure / real models.** | Not measured; do not claim otherwise. |

## 2. Why the scripted result is still useful

It is not a model result, but it isolates the pipeline:

* the baseline is strong (7/17), not a strawman;
* the null control fails 14/17;
* the task and the action are solvable (O2/F 17/17);
* the two S failures have different, localized causes;
* the fault arm is detected 8/8.

That is exactly what an instrument must show before spending model budget:
the pipeline can carry a fact, lose it, deliver it, and the grader can tell the
difference. The scripted writer and agent are frozen; only a live run can say
whether a model extracts and uses these facts.

## 3. What the evidence says about each mechanism

### Writer / coverage — the first real target

H1 is the cleanest failure: the region exists only in a tool record, the writer
proposes nothing, and the checkpoint says `protocol: parsed, coverage:
not-assessed`. The new R33-0 diagnostics make this visible instead of reporting
`ready`. O1 repairs the outcome, so the loss is upstream of validation.

H1 is a single case. It is evidence of a mechanism, not a measured omission
rate. A live pilot is needed to estimate how often a real writer does this.

### Validator capacity — the second target

F4 is not a writer failure. The writer proposed 13 valid rules; the validator's
per-fold limit accepted 12. The state is internally consistent and the agent
does exactly what the visible state says. O2/F prove the task is actionable with
13 facts. The product's limit is the cause.

This is a capacity question, not a correctness question. Any change must keep
the validator's authority, evidence and capacity accounting; simply raising 12
without pricing the whole checkpoint would move the failure into the body size.

### Delivery — not the bottleneck in this set

S matches O1 except H1, and direct visibility is 0.928 on the applicable cases.
The working set and checkpoint carry what was accepted. A delivery failure may
still exist under larger state or different scopes; this dataset did not expose
one.

### Retrieval trigger — the live question

OR is an upper bound: the same compressed state plus the evidence quotes passes
H1. The offline S agent cannot ask, so we cannot say whether a real agent would
notice the gap. The live runner gives every arm a `recall` tool and records
attempts and success. That is the right next measurement; building a prefetcher
now would be answering a question not yet asked.

### Authority and scope

F1/F2 show the validator refusing a constraint grounded in a tool result and
carrying the user constraint; the baseline obeys the tool text because its
summary is authority-blind. F3 shows two scoped facts with the same
`subjectKey` coexisting. The remaining risk is an unscoped claim from two tasks:
the dataset does not test that live, and R32 already documented it as a support
boundary.

## 4. R34: should it exist?

**Yes, but only as a small, evidence-driven round.** The minimal scope, in
order:

1. **Live pilot, 4–6 cases, S vs O2, explicit budget.** Cases: H1, F4, D1, C1,
   F1, A1. Measure real writer proposals, real agent actions, recall attempts,
   usage, and cost per successful task. Do not expand to 17 before the pilot's
   validity is checked.
2. **Fix F4's capacity limit with evidence.** Options: raise the per-fold delta
   limit with whole-checkpoint pricing, or split a large fold into multiple
   packets with explicit ordering. Do not silently trim pinned state; the R32
   capacity report already prices every section. Re-run F4 and the 30/100/300
   journal perf harness.
3. **Coverage gap handling for H1.** Either a budgeted coverage fallback (carry
   the unresolved action-critical quote in a bounded "coverage" section) or an
   explicit `coverage incomplete` notice. The R33 observation already exposes
   `coverage: not-assessed`; the product decision is whether to act on it.
4. **Retrieval-trigger instrumentation in a real agent loop.** Count whether the
   agent asks, which target it chooses, and whether the evidence changes the
   action. No prefetcher, no task-dependency graph before that measurement.
5. **Scope/task identity** remains open. F3 passes for explicit scopes; an
   unscoped collision from two tasks has no live case yet.

### What R34 should NOT do

* Do not add a second memory system, vector database, knowledge graph, or
  automatic prefetcher to “fix” a bottleneck that is currently a writer omission
  and a 12-delta limit.
* Do not rewrite the Writer prompt and compare the new writer to old results in
  the same run. Freeze a new dataset version and keep the old arms traceable.
* Do not convert the scripted 15/17 into a product claim. It is a pipeline
  result.

## 5. Bottom line

The mechanisms are integrity-closed and the pipeline, when given the right
facts, delivers them and changes behavior correctly. The two remaining failures
are concrete and different: a writer omission and a per-fold capacity limit. A
real-model benefit is plausible and unproven. The honest R33 conclusion is
**positive pipeline-level benefit, insufficient live evidence**, with R34
targeted at a small live pilot and those two failures.
