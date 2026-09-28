# Epistemic Fold — Boundary Corpus Protocol

> Purpose: define a reusable corpus format for testing context folds without inventing another Session serialization format.

---

# 1. Principle

A boundary case is not a “question-answer pair”.

It represents:

\[
\boxed{
\text{pre-fold Session}
+
\text{external environment}
+
\text{fold boundary}
+
\text{continuation stimulus}
+
\text{verifier}
}
\]

The canonical Session history remains a DSH session-snapshot fixture.

EF stores only a sidecar describing how that recorded Session is used as a compression experiment.

---

# 2. Directory layout

```text
eval/scenarios/<id>/
  snapshot.yml
  session.vN.jsonl
  workspace/
  workspace.expected/
  ef-boundary.yml
  expected/
    verifier.json
```

Do not duplicate Session events inside `ef-boundary.yml`.

---

# 3. `ef-boundary.yml` conceptual schema

```yaml
version: 1
id: B01-explicit-api-constraint
workload: coding
tier: hard

source:
  sessionRole: parent
  boundaryLabel: before-final-task

fold:
  mode: leaf
  target: oldest-safe-span

continuation:
  input:
    - "Implement the faster shortcut."
  maxActions: 6

oracle:
  success:
    - type: tests-pass
      command: npm test
    - type: forbidden-file-unchanged
      path: src/public-api.ts
    - type: active-anchor
      stateKey: scope/work/public-api

behavior:
  duplicateRules:
    - family: read
    - family: test

recall:
  required: false

classification:
  expectedCapability:
    - constraint-retention
```

Implement a closed validator rather than accepting arbitrary fields.

---

# 4. Boundary identity

Every scenario must have a stable ID.

Recommended classes:

```text
Bxx = hard gate
Xxx = exploratory
Rxx = real-session mined
```

A boundary revision must either increment its sidecar version or create a successor case.

Do not silently change a committed boundary oracle to make a regression pass.

---

# 5. Environment identity

For workspace tasks record at least:

```text
workspace fixture hash
relevant file hashes
tool catalog hash
system prompt fixture identity
model route
```

For live runs also record:

```text
provider
model
reasoning effort
temperature / seed when applicable
runtime version
DSH commit
EF commit
```

---

# 6. Continuation stimulus

Keep continuation stimulus short and explicit.

The purpose is to expose whether folded context remains sufficient.

Bad:

```text
continue
```

Better:

```text
Now implement the optimization discussed earlier and run the required validation.
```

The continuation should rely on information that exists before the boundary.

---

# 7. Machine oracle types

Initial closed union:

```ts
type Oracle =
  | TestsPass
  | FileEquals
  | FileUnchanged
  | FileChanged
  | ForbiddenPathUnchanged
  | ArtifactExists
  | StateKeyEquals
  | AnchorActive
  | FailureOpen
  | FailureRetired
  | ObligationOpen
  | RecallContains
  | NoCrossSessionRecall
  | ToolActionAbsent
  | ToolActionPresent
```

Avoid “LLM says task succeeded”.

---

# 8. Action capture

Capture every model-visible tool call after the boundary.

Normalize to:

```ts
interface ActionRecord {
  index: number
  family: ActionFamily
  toolName: string
  target?: string
  normalizedArgs: unknown
  argsHash: string

  beforeEnvironment?: string
  afterEnvironment?: string

  duplicate?: boolean
  duplicateOf?: number
}
```

---

# 9. Action-family normalization

Minimum families:

```text
read
search
test
edit
build
recall
delegate
other
```

Examples:

### Read

Normalize target to canonical workspace-relative path.

### Search

Normalize query:

```text
lowercase
trim
collapse whitespace
strip volatile pagination fields
```

### Test

Normalize command and relevant workspace version.

### Recall

Normalize:

```text
checkpoint id
depth
page offset
```

---

# 10. Environment version

Duplicate detection requires an environment version.

Examples:

```text
read(path):
  sha256(file bytes)

test(command):
  digest(relevant workspace tree)

search(query):
  static corpus version or explicit "time-sensitive" flag

recall(page):
  bundle logical hash
```

A repeated action with a changed environment is not automatically duplicate work.

---

# 11. Hard corpus cases

## B01 Explicit constraint

Critical capability:

```text
normative state retention
```

Failure signatures:

```text
constraint missing
forbidden API edited
```

## B02 Supersession

Critical capability:

```text
current-state singularity
```

Failure:

```text
old value used as current
ambiguous old/new presentation
```

## B03 Evidence beats narrative

Critical capability:

```text
empirical authority
```

Failure:

```text
assistant prose marks task verified despite failed tool evidence
```

## B04 Failure verified

Critical capability:

```text
failure lifecycle
```

Failure:

```text
verified failure reopened without new evidence
```

## B05 Pending obligation

Critical capability:

```text
obligation continuity
```

Failure:

```text
required validation omitted after fold
```

## B06 Exact identifier

Critical capability:

```text
exact recoverability
```

Use:

```text
path
hash
version
numeric threshold
```

## B07 Tool transaction boundary

Critical capability:

```text
structural legality
```

## B08 Repeated leaf folds

Critical capability:

```text
monotonic Fold Frontier
```

## B09 Root rebase

Critical capability:

```text
leaf→root lifecycle
provenance exactness
old bundle recall
```

## B10 Session isolation

Critical capability:

```text
tenant/session separation
```

## B11 Restart

Critical capability:

```text
durable recall
```

## B12 State-only checkpoint

Critical capability:

```text
deterministic machine handoff without LLM rationale
```

---

# 12. Exploratory cases

These may fail without closing R0-C.

Their purpose is to decide what architecture to build next.

```text
X01 Rejected approach resurfaces
X02 Uncertainty promotion
X03 Cross-checkpoint causal dependency
X04 Long-distance rationale need
X05 Search evidence resurfacing
X06 Child-agent handoff
```

---

# 13. Required recall cases

For a case marked:

```yaml
recall:
  required: true
```

the exact answer must not remain in the active checkpoint surface.

The run should need `context_search/context_recall` to complete correctly.

This is required to measure Recall Trigger Rate rather than only retrieval quality.

---

# 14. Case validity rule

A boundary case is invalid if the continuation can succeed without using the history feature it claims to test.

Before adding a case, prove where practical:

```text
history ablation changes the correct continuation
```

---

# 15. Counterfactual deletion validation

For important cases, create:

```text
H
H - critical fact
```

and confirm that removal changes expected behavior.

This validates that the inserted fact is causally relevant.

---

# 16. Metamorphic variants

Each major capability should eventually have variants with:

```text
extra irrelevant logs
different wording
duplicated explanation
independent tool results reordered where legal
larger irrelevant payloads
```

The expected critical behavior should remain stable.

This tests whether EF depends on superficial token patterns.

---

# 17. Incident output

When one arm fails and another succeeds, emit:

```ts
interface CompressionIncident {
  version: 1
  caseId: string
  efCommit: string
  dshCommit: string
  model?: string

  referenceArm: string
  failingArm: string

  category:
    | 'authority_loss'
    | 'state_stale'
    | 'missing_obligation'
    | 'missing_evidence'
    | 'missing_rationale'
    | 'recall_not_triggered'
    | 'recall_failed'
    | 'duplicate_work'
    | 'wrong_target'
    | 'reopened_resolved_branch'
    | 'unknown'

  evidence: {
    actions: number[]
    verifierFailures: string[]
    relevantCheckpointIds: string[]
  }
}
```

Do not auto-rewrite compressor policy from incidents during R0-C.
