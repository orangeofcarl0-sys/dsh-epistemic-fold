# Epistemic Fold — R0-C Evaluation Closure

> Status: execution specification  
> Target repository: `orangeofcarl0-sys/dsh-epistemic-fold`  
> Expected starting baseline: `8e34cd767b6b374ac7574d88884c8b4b05088873`  
> DSH pinned baseline: `477b4f420553e8a52c2fbccc464d7561b239c443`  
> Purpose: convert Epistemic Fold from “correctness-oriented implementation with microbenchmarks” into a context-compression runtime with reproducible behavioral and economic evidence.

---

# 1. Why R0-C exists

R0-A closed the main cross-layer correctness gaps:

- unified checkpoint marker protocol;
- hard Fold Frontier invariant;
- session-scoped recall;
- FoldCommitRecord;
- runtime authority gate;
- disjoint state renderer;
- rationale-only semantic compiler;
- real compaction audit metadata.

R0-B then added:

- native DSH plugin composition;
- projection + recall tools + anchor service composition;
- formal package manifest;
- restart/composition smoke;
- pinned DSH CI plus a master compatibility probe.

The remaining problem is now **evidence**, not architecture.

The existing paired baseline proves one narrow property:

> EF invalidates fewer previously cached prefix tokens than Basic in a small synthetic run.

It does **not** yet prove:

- lower total context cost;
- lower cache-adjusted provider cost;
- lower duplicate work;
- better long-horizon continuation;
- lower constraint violation;
- lower Context Regret;
- that rationale adds value over deterministic state-only checkpoints;
- that EF remains useful once Root folds and recall are included.

Therefore R0-C must answer:

\[
\boxed{
\text{Does EF preserve or improve agent behavior at an acceptable total context cost?}
}
\]

---

# 2. R0-C non-goals

Do **not** implement during this stage:

- M1 universal ingress reduction;
- M3b negative-knowledge extraction;
- M3b uncertainty classifier;
- M4 dependency graph;
- M5 generation hierarchy;
- adaptive learned compression policy;
- hard cross-session handoff;
- vector DB / embeddings.

If an evaluation exposes a failure that one of these mechanisms could solve, record the incident. Do not implement the mechanism inside R0-C.

---

# 3. Core testing philosophy

A context compressor is not judged primarily by what the compressed text says.

The gold standard is:

\[
\boxed{
\text{same pre-boundary state}
+
\text{different context representation}
+
\text{paired closed-loop continuation}
}
\]

Use five levels:

```text
L0 deterministic runtime invariants
L1 epistemic synthetic fixtures
L2 boundary-local paired continuation
L3 long-horizon multi-fold stress
L4 real-session shadow / incident mining
```

L0/L1 are keyless CI.
L2 has a keyless replay layer and an optional live-model layer.
L3 can run deterministic economics in CI/nightly and live-model behavior outside mandatory CI.
L4 is initially tooling/schema only; production deployment is not required in R0-C.

---

# 4. Reuse DSH snapshot/replay infrastructure

Do not invent a second Session serialization format.

DSH already provides:

- `@deepseek-ai/dsh-session-snapshot`
- `@deepseek-ai/dsh-llm-replay`
- recorded-session fixtures
- canonical Session normalization
- workspace setup/comparison
- record / replay / refresh modes
- profile-level subprocess launch

R0-C should use these as the base corpus layer.

EF adds only an **evaluation sidecar**, not a second copy of the Session history.

Recommended layout:

```text
eval/
  scenarios/
    <scenario-name>/
      snapshot.yml              # DSH-owned recorded-session manifest
      session.vN.jsonl          # DSH snapshot/replay input
      workspace/
      workspace.expected/
      ef-boundary.yml           # EF-specific evaluation metadata
      expected/
        verifier.json
  src/
    schema.ts
    boundary.ts
    actions.ts
    verifier.ts
    paired-runner.ts
    metrics.ts
    economics.ts
    incidents.ts
  live/
    provider-runner.ts
    repeated-run.ts
  reports/
```

---

# 5. R0-C0 — Measurement Integrity Closure

Before adding any new benchmark, fix the existing metric semantics.

## 5.1 Correct PMA

The original definition is:

\[
PMA=
\frac{
InvalidatedCachedTokens
}{
ReclaimedTokens
}
\]

The current report compares only absolute invalidated suffix tokens and labels the result “PMA”.

That must be corrected.

For every arm record separately:

```text
invalidatedSuffixTokensTotal
reclaimedTokensTotal
PMA = invalidated / reclaimed
```

Do not infer that lower absolute invalidation means lower PMA.

---

## 5.2 Remove / rename fake `stablePrefixBytes`

Current benchmark uses:

```text
stablePrefixBytes = unchangedNodeCount * 64
```

where 64 is SHA-256 hex length.

That is not byte-level prompt stability.

Replace with:

```text
sharedPrefixNodes
sharedPrefixTokens
firstMutationPosition
invalidatedSuffixTokens
```

`sharedPrefixTokens` is the sum of token-meter prices for unchanged leading nodes in the previous request.

---

## 5.3 Add context exposure metrics

Per request:

```text
promptTokens
sharedPrefixTokens
invalidatedSuffixTokens
checkpointTokens
rawTailTokens
```

Per run:

```text
totalPromptTokens
meanPromptTokens
peakPromptTokens
p95PromptTokens
totalInvalidatedSuffixTokens
totalReclaimedTokens
PMA
leafFoldCount
rootFoldCount
```

---

## 5.4 Add auxiliary-call accounting

For EF rationale and Basic summarization:

```text
compactionInputTokens
compactionOutputTokens
compactionCallCount
```

Use durable `compaction/summary` usage when available.

Do not estimate from character count when authoritative usage exists.

---

## 5.5 Add recall accounting

Record:

```text
recallCallCount
recallReturnedTokens
searchCallCount
rapidRecallTokens@1
rapidRecallTokens@3
rapidRecallTokens@5
```

Define:

\[
ContextRegret@k=
\frac{
tokens\ recalled\ within\ k\ post\text{-}fold\ actions
}{
tokens\ reclaimed\ by\ the\ fold
}
\]

---

# 6. R0-C1 — Keyless Boundary Corpus

Goal:

> create a reproducible corpus of compaction boundaries that can run without provider credentials.

The corpus should not ask a fake model to “be intelligent”.
It should provide deterministic structural/state/oracle checks around real DSH recorded sessions.

Each case consists of:

```text
recorded pre-boundary Session
workspace snapshot
fold boundary metadata
post-boundary continuation stimulus
machine-verifiable expected facts
optional exploratory behavior rubric
```

---

# 7. Initial hard-gate corpus

Create at least 12 hard-gate scenarios.

## B01 — explicit constraint

History:

```text
User: do not change the public API.
```

Later continuation tries to tempt the agent toward an API-changing shortcut.

Machine oracle:

```text
constraint remains current
no forbidden file/API signature changed
```

## B02 — superseded scalar state

History:

```text
timeout = 30
timeout = 60
```

Oracle:

```text
current = 60
30 remains historically recoverable
surface does not present 30 as current
```

## B03 — empirical failure vs narrative success

History:

```text
tool: 2 tests failed
assistant prose: probably fixed
```

Oracle:

```text
failure remains open / not verified
```

## B04 — failure resolution

History:

```text
failure OPEN
fix
validation evidence
failure VERIFIED
```

Oracle:

```text
failure absent from hot open state
historical provenance recoverable
```

## B05 — pending obligation

History:

```text
after edit, run integration test X
```

Boundary happens before X.

Oracle:

```text
obligation survives fold
```

## B06 — exact identifier

History includes:

```text
path
commit hash
artifact id
exact numeric parameter
```

Oracle:

```text
exact recall returns byte/logically identical identifier
```

## B07 — tool pairing boundary

Boundary sits near assistant tool-call / tool-result pair.

Oracle:

```text
no invalid split
```

## B08 — multiple leaf folds

At least 4 leaf folds.

Oracle:

```text
frozen prefix stays monotonic
old checkpoint markers survive
```

## B09 — root fold after leaf accumulation

Oracle:

```text
Root mode correct
CommitRecord exact
old leaf bundles remain recallable
```

## B10 — session isolation

Two sessions with two checkpoint IDs.

Oracle:

```text
A cannot recall B
```

## B11 — restart

Fold, dispose plugin/context, remount over same bundle root.

Oracle:

```text
exact recall still works
```

## B12 — zero-LLM state checkpoint

`semanticMode=none`.

Oracle:

```text
Current/Evidence/Open remain sufficient for all deterministic state gates
```

---

# 8. Exploratory corpus

These cases are diagnostic, not hard R0-C gates because M3b/M4 are intentionally absent.

Create at least 6:

```text
X01 rejected approach later tempting again
X02 unresolved hypothesis across many folds
X03 evidence conflict from multiple sources
X04 rationale needed much later
X05 old research/search result becomes relevant again
X06 child-agent result used much later by parent
```

If EF fails them, classify the failure.
Do not automatically add M3b/M4.

---

# 9. R0-C2 — Paired Continuation Harness

The paired runner must start all arms from the **same recorded pre-boundary state**.

Required arms:

```text
B1   DSH Basic
E3a0 EF state-only, semanticMode=none
E3aR EF state + rationale-only
```

Optional:

```text
B0 Full / no fold
```

only when the history fits the model window.

---

# 10. Paired run protocol

For one case \(i\):

```text
restore identical Session/workspace
↓
fork arm A / B / C
↓
apply arm-specific fold policy
↓
deliver identical continuation stimulus
↓
run 3–10 agent actions
↓
capture tool/actions/state/workspace
↓
machine verifier
↓
behavior metrics
```

If the provider supports deterministic seed, use the same seed.

If not, run:

\[
n \ge 3
\]

replicates per arm for important cases.

Do not compare two unrelated task samples.

Compare paired:

\[
\Delta_i=Score(EF_i)-Score(Basic_i)
\]

---

# 11. Machine-first outcome verification

Prefer deterministic oracles over LLM judges.

For coding/workspace tasks:

```text
file hashes
git diff
test exit codes
changed file set
forbidden file set
artifact existence
exact state values
```

For session behavior:

```text
tool calls
recall calls
search calls
failure lifecycle
active constraints
open obligations
```

LLM judge is allowed only for residual semantic quality such as “was rationale sufficient?”.

---

# 12. Action signatures

Every post-boundary tool action must be normalized into an `ActionSignature`.

Conceptual schema:

```ts
interface ActionSignature {
  family:
    | 'read'
    | 'search'
    | 'test'
    | 'edit'
    | 'build'
    | 'recall'
    | 'other'

  toolName: string
  target?: string
  normalizedArgsHash: string

  environmentVersion?: string
}
```

Examples:

```text
read:file:src/foo.ts@sha256(...)
search:web:"normalized query"
test:"pytest tests/test_x.py"@treeHash(...)
recall:cp:<id>:detail
```

---

# 13. Duplicate Work Rate

A repeated action is only counted as duplicate when its relevant environment did not change.

\[
DWR=
\frac{
avoidableRepeatedActions
}{
postBoundaryActions
}
\]

Do not mark a re-read as duplicate if the file changed in between.

Initial heuristics:

```text
read(path) duplicate if same path hash unchanged
search(query) duplicate if normalized query repeated with no time-sensitive flag
test(command) duplicate if relevant workspace/tree hash unchanged
recall(ref,page) duplicate if same page repeated
```

---

# 14. Fold-regret telemetry

Add:

```text
RAF@k = Read After Fold within k actions
SAF@k = Search After Fold within k actions
TAF@k = Test After Fold within k actions
Recall@k
```

These are signals, not automatic failures.

They become stronger when paired Basic/EF diverge.

---

# 15. Recall metrics

For cases where folded information becomes necessary:

\[
RecallTriggerRate=
\frac{
runs\ that\ correctly\ invoke\ recall
}{
runs\ where\ recall\ is\ required
}
\]

\[
RecallSuccessGivenTrigger=
\frac{
successful\ recoveries
}{
recall\ triggers
}
\]

Keep trigger and retrieval quality separate.

---

# 16. Compression incident attribution

A run pair where:

```text
Full/Basic succeeds
EF fails
```

becomes an `EfCompressionIncident`.

Required categories:

```text
authority_loss
state_stale
missing_obligation
missing_evidence
missing_rationale
recall_not_triggered
recall_failed
duplicate_work
wrong_target
reopened_resolved_branch
unknown
```

Store incident evidence, not just a label.

---

# 17. R0-C3 — Long-horizon economics

Existing 8-step benchmark is too short.

Add deterministic runs:

```text
32
64
128
```

growth steps.

The EF arm must include realistic maintenance:

```text
leaf folds
root-rebase advice
root fold when benchmark policy chooses to honor advice
continue leaf folds
```

Report leaf-only and maintained-root modes separately.

Do not silently auto-root production behavior just for the benchmark.

---

# 18. Context-window ladder

Run the same synthetic workload under:

```text
32K
64K
128K
262K
```

or the closest supported artificial capacities in the harness.

Measure:

```text
peak context
P95 context
total prompt exposure
fold count
root count
failure-to-compact rate
```

---

# 19. Cache-adjusted cost curve

Because provider cache pricing varies, do not hard-code one provider price.

Let:

\[
\rho=
\frac{
cache\ hit\ input\ unit\ cost
}{
cache\ miss\ input\ unit\ cost
}
\]

Evaluate:

\[
\rho \in \{0,0.1,0.2,0.5,1.0\}
\]

Approximate:

\[
Cost_\rho=
MissInputTokens+
\rho \cdot HitInputTokens+
AuxiliaryInputTokens+
\lambda_o AuxiliaryOutputTokens+
RecallTokens
\]

If actual provider cache metrics are available, report them separately and do not pretend architectural prefix estimates are provider truth.

---

# 20. R0-C4 — Shadow feedback pipeline

Do not modify production model behavior yet.

Build tooling that can take a real Session boundary and produce a shadow evaluation package:

```text
original Session ref
boundary metadata
candidate EF checkpoint
workspace/environment manifest
next real actions
```

Later this supports:

```text
actual full-context continuation
vs
offline compressed replay
```

Initial R0-C delivery only needs:

- schema;
- serializer/exporter;
- incident file format;
- one end-to-end demo from a local recorded session.

---

# 21. Required reports

Every benchmark execution should emit machine-readable JSON.

Example:

```json
{
  "runVersion": 1,
  "caseId": "B03-summary-poisoning",
  "arm": "E3a0",
  "model": "...",
  "replicate": 0,
  "success": true,
  "metrics": {
    "promptTokensTotal": 0,
    "peakPromptTokens": 0,
    "invalidatedSuffixTokens": 0,
    "reclaimedTokens": 0,
    "pma": 0,
    "duplicateWorkRate": 0,
    "recallCalls": 0
  },
  "violations": [],
  "actions": []
}
```

Human-readable Markdown report must be generated from JSON, not maintained independently.

---

# 22. Statistical reporting

For live paired runs report:

```text
paired mean delta
paired median delta
bootstrap 95% CI
catastrophic failure count
constraint violation count
```

Do not rely only on arithmetic mean.

For important cases with stochastic models, report per-case pass counts:

```text
Basic 4/5
EF-state 5/5
EF-rationale 5/5
```

---

# 23. R0-C hard gates

R0-C closes only when all of the following hold:

### Measurement integrity

```text
PMA computed by its actual ratio
no fake stablePrefixBytes metric
all benchmark reports machine-readable
```

### Corpus

```text
>=12 hard-gate boundary scenarios
>=6 exploratory scenarios
all keyless replayable
```

### Paired harness

```text
same boundary can execute Basic / EF-state / EF-rationale
same workspace state per arm
machine verifier operates independently of agent self-report
```

### Long horizon

```text
32/64/128-step economics runs complete
Leaf + Root maintenance represented
```

### Behavior

At minimum on the hard-gate live subset:

```text
EF task success non-inferior to Basic
critical constraint violations do not increase
DWR does not materially increase
```

Do not freeze a numeric “non-inferior margin” before first data; report raw paired distributions first.

---

# 24. Decision after R0-C

Use the incident corpus to choose the next architecture phase.

```text
raw tool output dominates cost
→ M1

rejected branches / uncertainty drift dominate
→ M3b

cross-checkpoint dependency loss dominates
→ M4

leaf/root economics dominate
→ M5 generations

session log/heap dominates
→ hard handoff/session segmentation

none dominate
→ stop architecture growth; productionize M3a
```

This decision must be evidence-driven.
