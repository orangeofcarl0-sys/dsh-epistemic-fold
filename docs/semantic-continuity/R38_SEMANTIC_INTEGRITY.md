# R38-M0 — Semantic Integrity Auditor

## 1. What it is

A read-only pass over committed semantic packets and the projected state. It
reconstructs a relation index and reports findings at three levels.

```ts
type IntegritySeverity = 'blocking' | 'requires-review' | 'informational'
```

It never writes a journal, retires an anchor, or proposes a repair. Conflict
detection must not acquire write authority: a lexical overlap is a reason to
look, not a reason to revoke a user constraint.

## 2. Inputs

```ts
auditSemanticIntegrity({
  sessionId,
  state,                 // projected state after every packet
  packets: [{ packet, stateBefore }],
  sourceSeqs?,           // seqs present in the log
  scope?,                // limit comparisons to one scope
  commitProblems?,       // problems already proved by validateSemanticCommit
})
```

`stateBefore` is supplied rather than guessed: resolving a historical relation
against the FINAL state is exactly the bounded-oracle mistake `planCommit`
avoided. The caller replays the journal in order and snapshots the state.

## 3. Relation index

For every accepted delta in every packet:

```text
anchorId, deltaId, packetId, kind, authority, statement, scope,
stateKeyText, supersedes, dependsOn, rulesOut, sourceSeqs
```

The index is in memory. No graph database, no schema migration, no embedding
backend.

## 4. Checks

| Code | Severity | Proved by |
|---|---|---|
| `commit-integrity` | blocking | `validateSemanticCommit` problems |
| `unauthorized-retirement` | blocking | a committed retire op whose declaring deltas all fail `mayRetire` |
| `missing-source-evidence` | blocking | an anchor citing a seq absent from the log |
| `orphaned-retirement` | informational | a retire op no accepted delta names |
| `unresolved-supersession` | requires-review | packet audit, or an unresolved target in a pre-audit packet |
| `refused-retirement` | requires-review | packet audit |
| `unresolved-dependency` | requires-review | a `dependsOn` target that does not resolve |
| `stale-negative-knowledge` | requires-review | a `rulesOut` phrase used by an active value in the same scope |
| `conflicting-active-anchors` | requires-review | opposite polarity at a shared subject, same scope |
| `cross-scope-conflict-candidate` | informational | the same, different scopes |

## 5. Deterministic vs reviewable

Deterministic (provable from ids, ops, digests, authority ranks):

- unauthorized retirement;
- missing source evidence;
- orphaned retirement;
- unresolved supersession/dependency.

Reviewable (a real candidate, not a verdict):

- stale negative knowledge — the phrase match is exact and normalized, but
  whether the new value really supersedes the rejection is a semantic question;
- conflicting active anchors — polarity + shared subject, not a truth judgment.

Informational:

- cross-scope candidates — the brief is explicit that opposite claims in
  different scopes are not necessarily conflicts;
- orphaned retirement — an operation with no visible author, which may be a
  legacy writer or a hand-edited packet.

## 6. False-positive guards

- Only ACTIVE anchors are compared. A retired or superseded claim cannot
  conflict with current state.
- `stale-negative-knowledge` requires an explicit `rulesOut` phrase of at least
  3 normalized characters. Shared keywords alone produce nothing.
- `conflicting-active-anchors` requires opposite polarity from a fixed pair
  list AND a shared non-stopword subject token. Two unrelated facts that share
  `scheduler` are not flagged.
- Different scopes downgrade a conflict to informational.
- Missing information is never reported as consistency: an absent dependency is
  `requires-review`, not silence.

## 7. N5 as a permanent regression

Case `n5-incomplete`:

```text
queue decision            active -> retired by the revision
rejected outbox           active (not superseded)
new outbox decision       active
```

Finding:

```text
stale-negative-knowledge  requires-review
  "durable outbox" is ruled out by <rejected> but used by <new decision>
```

Case `n5-complete`: the revision supersedes both coordinates; the rejected
anchor leaves hot state; no finding.

Both are in `eval/r38/integrity-audit.mjs` and asserted by
`tests/r38-integrity-auditor.spec.ts`.

## 8. Results

`eval/r38/out/integrity-audit.json` — 9/9 cases passed.

```text
n5-incomplete                       stale-negative-knowledge
n5-complete                         (none)
cross-scope-opposites               cross-scope-conflict-candidate
same-scope-opposites                conflicting-active-anchors
shared-keyword-only                 (none)
historical-unauthorized-retirement  unauthorized-retirement
unresolved-dependency               unresolved-dependency
withheld-revision                   unresolved-supersession
missing-source-evidence             missing-source-evidence
```

## 9. Limits

- The auditor does not decide whether a claim is TRUE. It decides whether the
  state is structurally consistent with the relations the writer declared.
- A pre-audit packet cannot distinguish "no retirement asked for" from
  "retirement silently dropped"; the auditor reports the unresolved target it
  can see and does not guess at the rest.
- `dependsOn` has no solver. An unresolved dependency is reported, never
  auto-resolved.
- The text rules are English-centric (ASCII tokens). CJK `rulesOut` phrases are
  matched by normalized substring; CJK polarity pairs are not implemented.

## 10. Evidence

```text
eval/r38/src/integrity-auditor.ts
eval/r38/integrity-audit.mjs
eval/r38/out/integrity-audit.json      9/9
tests/r38-integrity-auditor.spec.ts    8/8
```
```
