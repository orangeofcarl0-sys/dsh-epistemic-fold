# R38-M0 — Task-Aware Selection

## 1. What the current working set does

`compileWorkingSet` has three jobs and does them correctly:

```text
Pinned    every still-binding objective / constraint / obligation / open failure
Working   active facts, newest provenance first, until the budget is reached
Omitted   a count plus a context_search affordance
```

It answers "what is still effective?". It does not answer "what does this task
need?". A recent unrelated finding therefore outranks an older decision the
current task directly depends on.

The selector also uses `break` when one candidate does not fit:

```ts
if (tokens + separator + estimate(candidate) > budget) break
```

Everything after the first oversized candidate is dropped, including items that
would have fit.

## 2. What this work package adds

A shadow selector (`eval/r38/src/task-aware-selector.ts`) and an ablation. No
production module imports it; `compileWorkingSet` is unchanged.

### Task frame

```ts
interface TaskFrame {
  sessionId: string
  taskId?: string
  phase?: 'planning' | 'editing' | 'verifying' | 'handoff'
  workspace?: string
  branch?: string
  files: string[]
  symbols: string[]
  operation?: string
  currentRequest: string
  semanticStateRevision: string
  sessionEventWatermark: number
}
```

The frame is built from the request and the workspace, never from a case's gold
label. The test asserts the selector source contains no `gold`, `benchmark`,
`criticalIds`, `negativeKnowledgeIds` or `unrelatedIds`.

### Deterministic features

```text
scope applicability      workspace / branch / file / symbol
file and symbol overlap  frame files and symbols against anchor text
subject-key overlap      request tokens against the coordinate and value
task dependency          obligations and open failures
authority relevance      normative, decision
negative knowledge       rejected approaches and their rulesOut phrases
recency                  tie-breaker only
```

Scores are additive and recorded per anchor. A scope mismatch disqualifies the
anchor and is recorded in `unresolvedCoverage` as `scope-mismatch:<id>`. An
anchor with no scope under a framed task is not silently excluded; it is scored
low and recorded as `scope-unknown:<id>`.

### Selection invariants

- Pinned state is never budgeted. If it alone exceeds the budget, it is
  rendered and `pinnedOverflow` is reported.
- A candidate that does not fit is skipped, not treated as a stop signal.
- `selected ∩ omitted = ∅` and `selected ∪ omitted = every eligible working
  candidate`. Both sets are maintained directly.
- Every selected anchor's `sourceRefs` are returned in `sourceRefs`.
- Same state + frame + budget → same `selectionDigest`.

## 3. Ablation

`eval/r38/out/working-set-ablation.json` — 5/5 checks passed.

Both selectors run on the same state, budget and frame.

| Case | S0 critical | S1 critical | S0 tokens | S1 content |
|---|---:|---:|---:|---:|
| n5-budget-pressure | 0/1 | 1/1 | 115 | 99 |
| scope-separation | 1/1 | 1/1 | 122 | 76 |
| greedy-skip | 0/1 | 1/1 | 64 | 61 |
| pinned-overflow | 1/1 | 1/1 | 135 | 71 (overflow by design) |

- **n5-budget-pressure** — eight newer unrelated findings fill the production
  budget; the older rejected outbox, which the task directly depends on, is
  omitted. S1 ranks it first (scope match, subject overlap, `rules out:
  durable outbox`) and selects it.
- **scope-separation** — both decisions are working anchors. S0 selects repo-a
  and repo-b; S1 selects repo-a only and records
  `scope-mismatch:semantic-decision-repo-b`. Unrelated tokens fall to 0.
- **greedy-skip** — the production selector breaks at B and drops C. S1 skips B
  and keeps C. This is the direct `break` → `continue` fix, with the sets
  maintained explicitly.
- **pinned-overflow** — a contract larger than the budget is still rendered in
  full by both; S1 reports `pinnedOverflow`.

### Honest budget note

`contentTokens` is the pinned + working sections. `tokenEstimate` includes the
`Not shown` notice, so the complete body can exceed the budget by the notice
size (for example 130 against 120). The production compiler has the same
behaviour. The ablation reports both numbers instead of claiming the body is
always within budget.

## 4. Stability and determinism

The selector sorts by score, then recency, then id, so input insertion order
does not change the result. The test rebuilds each case with the anchors in
reverse order and asserts the same `selectionDigest`.

## 5. What this does NOT show

- The ablation is offline and deterministic. It is not a model-behaviour result
  and says nothing about whether a model will use the selected facts better.
- The case set is synthetic and small (four cases). Critical-fact labels are
  used only for scoring.
- The selector is not wired into the engine. A production integration would
  need a frozen Task Frame source and a cache-stable rendering path (WP6).
- No significance claim is made. The differences are mechanism demonstrations.

## 6. Evidence

```text
eval/r38/src/task-aware-selector.ts
eval/r38/working-set-ablation.mjs
eval/r38/out/working-set-ablation.json     5/5 checks
tests/r38-task-aware.spec.ts               9/9
```
