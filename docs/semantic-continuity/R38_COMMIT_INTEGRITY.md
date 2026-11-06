# R38-M0 — Commit Integrity

## 1. Two identities, not one

`deltaIdentity` is:

```text
canonicalHash(kind, subjectKey, statement, status, evidenceSeqs, scope)
```

It deliberately excludes `supersedes`, `dependsOn` and `rulesOut`. Those fields
describe an **operation**, not the claim's content. Including them would change
historical anchor ids and break replay of existing journals.

The consequence is that two proposals can carry the same claim and different
relation plans:

```text
Proposal A: claim X, supersedes = [target-A]
Proposal B: claim X, supersedes = [target-B]
deltaId(A) == deltaId(B)
```

Before R38, `validateDeltas` refused the second as `duplicate` within one fold,
so its retirement was silently dropped. Across folds the planner skipped the
duplicate declare but still emitted the new retires, which was correct but
undocumented.

## 2. What changed

Claim identity is unchanged. A **revision identity** is added:

```text
canonicalHash(sorted supersedes, sorted dependsOn, sorted rulesOut)
```

`validateDeltas` now tracks `(deltaId, revisionId)` pairs:

- first claim → accepted normally;
- same claim, same revision → refused `duplicate` (idempotent repeat);
- same claim, new revision → accepted with `duplicateClaim: true`.

`planCommit` then:

- skips the declare for a `duplicateClaim` (the anchor id already exists or was
  already planned in this packet);
- still resolves and applies its authorized retirements;
- records a `valueConflicts` row when a repeated claim would render a different
  value (a `rejected-approach` whose `rulesOut` changed).

This is the answer to the brief's §4.4 question: **yes, revision operations need
an identity separate from the claim**, but the claim identity must not change.

## 3. Target resolution

`resolveTarget` is deliberately wider than `findTarget` was. It classifies:

```text
previous-absent       `previous` with no head; a first claim, benign
already-retired       the named anchor is in `state.superseded`; benign
resolved              one visible anchor matched
sibling               a delta in the same packet declares the target
cross-scope           only another scope matched; retirement refused
ambiguous             two same-scope coordinates matched; delta withheld
unknown               nothing matched; delta withheld
```

The three failure modes are not the same:

- **cross-scope** — the target exists; the declaring claim may not reach it.
  The claim is declared, the retirement is refused.
- **ambiguous** — a bare subject names more than one same-scope coordinate.
  Picking one would be arbitrary; the delta is withheld.
- **unknown** — a revision names a target that does not exist. Declaring the
  claim alone would leave the value it claimed to replace live next to the new
  claim. The delta is withheld.

Withheld deltas are recorded in `plan.withheld` and in the packet's
`retirement` audit. They contribute **no operations at all**, including
retirements.

## 4. Replay, restart, retry, fork

`eval/r38/out/revision-idempotency.json` — 7/7 checks passed.

| Check | Result |
|---|---|
| claim identity excludes relations | same `deltaId` for different targets |
| repeat with new plan applies operations | 1 declare, 2 retires, `duplicateClaim` |
| exact repeat refused | 1 accepted, 1 `duplicate` |
| replay once matches candidate | identical state digest |
| second apply detected | retirement counter changes; digest gate reports 1 mismatch |
| replay at cut matches fork | cut = first fold, whole = second |
| retry deterministic | same ids, same ops, same state |

### The idempotency boundary

The reducer is idempotent for **declares**: re-declaring the same anchor id does
not create a second supersession entry. It is **not** a set-based reducer for a
packet that declares an anchor and retires it in the same operation list: a
second application re-declares the anchor, retires it again, and increments
`retiredCount`.

That is why the commit gate, not the reducer, is the once-only boundary:

- `validateSemanticCommit` rejects a duplicate packet;
- `verifyCommitStateDigests` recomputes `canonicalHash(state)` after each commit
  and compares it with the bundle's `state.digest`. A double application
  produces a different digest and is reported as `ops-state-mismatch`.

The test asserts both halves: the visible values are stable, and the digest gate
detects the second application.

## 5. Unresolved dependency and `dependsOn`

`dependsOn` and `rulesOut` are still recorded, not resolved. R38-M0 does not
invent a dependency solver. The integrity auditor (WP2) reports an unresolved
`dependsOn` target as `requires-review`; it does not retire or block anything.

## 6. Compatibility

```text
deltaIdentity                 unchanged
anchor ids                    unchanged
packet id                     unchanged
replay of historical packets  unchanged (recorded ops)
opsDigest                     computed from actual ops
packet schema                 optional `retirement` field; ignored by old readers
```

## 7. Evidence

```text
src/semantic/validate.ts
src/semantic/plan.ts
src/semantic/types.ts
tests/r38-relation-authority.spec.ts                 19/19
eval/r38/revision-idempotency.mjs
eval/r38/out/revision-idempotency.json               7/7
```
