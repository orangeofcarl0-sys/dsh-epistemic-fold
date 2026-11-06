# R38-M0 — Bounded Archive Recovery

## 1. The rule

```text
not present in semantic state
  ≠
historical fact does not exist
```

R37-C measured committed-fact recall near 0.514. A missing state value is common
and says nothing about the raw log. Recovery therefore reports one of five
statuses, and never collapses them:

```text
found-in-active-state      the selected context already contains it
found-in-archive-only      recovered from a verified checkpoint archive
coverage-not-assessed      a bound stopped the search before the answer
not-found-in-checked-scope every inspected checkpoint was searched, no hit
unavailable                the archive could not be read at all
```

`coverage-not-assessed` is the status that prevents the failure mode the brief
names: "I stopped looking" must not be reported as "it is not there".

## 2. Bounds

Frozen by the caller; recovery never loops until it finds a gold fact.

```text
maxArchiveDescriptors   8    checkpoints inspected
maxSearchOperations     8    detail reads
maxExactPages           6    exact pages opened
maxReturnedChars      1200   excerpt characters returned
maxReturnedTokens      300    excerpt tokens returned
```

Every result reports the cost actually paid and `truncated`.

## 3. Reuse, not a second archive

`recoverFromArchive` calls the existing `recall`:

```text
store.list()          → newest-first descriptors, bounded
recall(detail)        → bounded inventory; previews are matched against terms
recall(exact, offset) → one archived message per candidate
store.read()          → the ref seq for that offset
```

No embedding backend, no second database, no new index. The test asserts the
module imports `recall` and contains no embedding/vector import.

## 4. Three-arm ablation

```text
S0  production working set
S1  task-aware selection
S2  S1 + bounded archive recovery
```

The archive is written through the real `FileBundleStore` and read through the
real `recall`. The bundles are synthetic fixtures; the store, codec and recall
path are production code.

| Case | Status | S0 | S1 | S2 | Cost | Overhead |
|---|---|---|---:|---:|---:|---:|---:|
| h1-production-region | found-in-archive-only | ✗ | ✗ | ✓ | 3 | 25 |
| s1-production-timeout | found-in-archive-only | ✗ | ✗ | ✓ | 2 | 22 |
| archive-miss | not-found-in-checked-scope | ✗ | ✗ | ✗ | 1 | 0 |
| descriptor-budget | coverage-not-assessed | ✗ | ✗ | ✗ | 1 | 0 |
| scope-mismatch | found-in-archive-only | ✗ | ✗ | ✓ | 2 | 22 |

- **h1-production-region** — state holds a stale `us-east-1` decision; the
  correct `eu-west-2` fact was never extracted. S2 recovers the production
  message and not the staging one.
- **s1-production-timeout** — staging is in state; the production 30-second
  constraint is archive-only. S2 recovers it.
- **archive-miss** — the fact is in neither state nor archive. The status is
  `not-found-in-checked-scope`, not "does not exist".
- **descriptor-budget** — the bound inspects one checkpoint; the answer is in
  the skipped one. The status is `coverage-not-assessed`.
- **scope-mismatch** — the query names repository A; the repository B message
  is not returned. `falseRetrieval` is 0 and scope correctness is 1.

Checks: 8/8.

## 5. No gold in the query

Retrieval terms come from the task frame (`production`, `deployment`, `region`),
never from the answer (`eu-west-2`). The test asserts that no query term is a
substring of the critical fact. This is the difference between a mechanism and
a lookup table.

## 6. Authority

Recovered text is labelled `Recovered from archive` and is never applied to
semantic state. The ablation asserts:

```text
stateDigestUnchanged   true in every case
stateUnchanged         true in every case
recoveredIsArchive     every passage carries a checkpoint id
```

A recovery is a pointer into raw history, not a semantic commit. Promoting it
to state would be a new authority upgrade and is out of scope.

## 7. Limits

- The bundles are synthetic fixtures. The store and recall path are real, but
  the archive content was not produced by an engine fold. An engine-level
  recovery test is the next step, not this one.
- Descriptor order is `createdAt` descending. A fact in an older checkpoint
  beyond `maxArchiveDescriptors` is reported as `coverage-not-assessed`, which
  is honest but means a tight bound can miss a real fact.
- Matching is AND over normalized terms. No stemming, no synonyms, no semantic
  reranking.
- Recovery runs only when the selected context lacks the terms. It does not
  verify that the selected value is CURRENT; that is the integrity auditor's
  job.

## 8. Evidence

```text
eval/r38/src/archive-recovery.ts
eval/r38/archive-recovery-ablation.mjs
eval/r38/out/archive-recovery-ablation.json   8/8 checks
tests/r38-archive-recovery.spec.ts            8/8
```
