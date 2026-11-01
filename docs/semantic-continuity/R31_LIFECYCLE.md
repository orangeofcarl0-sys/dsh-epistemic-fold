# R31 Lifecycle

## 1. Five objects that must not be collapsed

| Object | Question | Authority |
|---|---|---|
| **Canonical history** | what events happened? | DSH session log |
| **Historical fold commit** | did this compaction replace the surface? | the log transaction + `HistoricalFoldProof` |
| **Semantic state commit** | did this packet's operations become state? | journal receipt with a committed proof |
| **Checkpoint residency** | is the checkpoint visible now? | surface nodes |
| **Current working state** | what is the effective state now? | replay of events + verified commits |

The four core inequalities:

```text
HistoricalCommit != CurrentResidency
SemanticCommit   != JournalFileExists
SemanticActivation != CheckpointStillVisible
CurrentState     != CompleteHistory
```

## 2. Semantic packet lifecycle

```text
prepared (packet file, status staged)
   |
   +-- proof committed      -> receipt committed    -> state (applied at commit seq)
   +-- proof aborted        -> receipt aborted / archived-only
   +-- proof unresolved     -> no receipt yet (still staged)
   +-- proof conflict       -> no activation (health partial/conflict)
   +-- committed receipt no longer provable -> conflict (not applied)
```

Only a receipt with `outcome: committed` and a currently verifiable proof
contributes operations. A receipt is immutable; a conflicting later decision
for the same packet is an error, not a last-writer-wins update.

## 3. Checkpoint lifecycle

```text
resident   marker on a current surface node
archived   marker not on the surface, because a later fold folded it away
retired    an explicit ef/retire record exists
```

`retired` and `archived` stay distinct. A retired checkpoint's content is not
carried by later folds; the archive is still recallable by `cp:<id>`. A retired
checkpoint that is still on the surface is a **conflict** and is counted; it
means the record exists and the removal did not happen.

Phase Exit is two operations with two outcomes:

1. write the retirement record (`retireCheckpoint`); and
2. replace the surface node with a tombstone that names `cp:<id>`
   (the eval driver's operation).

Neither alone is a completed exit. The record without removal is reported as a
conflict; removal without a valid record is `archived`, not `retired`.

## 4. Invariants and their tests

| ID | Invariant | Evidence |
|---|---|---|
| I1 | Archive before loss | `tests/m0-core.spec.ts` T06: archive write failure → no summary/replacement; bundle write precedes the Basic commit in `publish()` |
| I2 | Commit monotonicity | `tests/semantic-commit-proof.spec.ts`: proof unchanged after the checkpoint leaves the surface |
| I3 | No ghost activation | `semantic-commit-proof`: no summary → `aborted`/`unresolved`; `semantic-recovery`: receipt without proof → conflict |
| I4 | Deterministic replay | `semantic-replay-order` (same state from any commit array order; packet-id tie-break); `semantic-journal-v4` (commit-order sort independent of staging/wall time) |
| I5 | Exactly-once logical effects | `applyOps` idempotence tests; `semantic-journal-v4` immutable idempotent packet/receipt; `semantic-concurrency` one activation pass |
| I6 | Pinned integrity | `semantic-core` R31-A3 tests; `semantic-longchain` pinned overflow |
| I7 | Residency independence | `semantic-commit-proof` committed-then-folded-away |
| I8 | Source integrity | `semantic-commit-proof` different source bytes / different span / missing start |
| I9 | Fork boundary | `semantic-fork`: A+B inherited, C excluded; missing parent journal blocks |
| I10 | Fail-closed recovery | `semantic-recovery`; `semantic-process-restart` crash case; `semantic-fork` blocked child |

## 5. Ordering inside a fold

```text
1. reconcile (serialized; inherit fork seed / migrate legacy)
2. read committed semantic state, interleaved by commit seq
3. acquire one writer call (active) or rationale + diagnostic call (shadow)
4. validate proposals against the exact folded span
5. resolve declares/transitions/retires against the projected state
6. render the temporal checkpoint from the CANDIDATE state
7. build the bundle (archive hash is the source identity)
8. write the prepared packet (immutable) — no receipt yet
9. write the bundle (verified)
10. Basic appends summary + replacement (the commit)
11. reconcile: prove the log, write the committed receipt
12. replay for the next fold, at the recorded commit seq
```

`staged` at step 8 is not state. A crash between 8 and 10 leaves a prepared
packet that no proof can activate; a crash between 10 and 11 is repaired by
re-proving the log.

## 6. Root, Leaf, Exit, Restart

- **Leaf** folds only the open trajectory; the frozen prefix grows one
  checkpoint per fold. The chain is linear and is not reclaimed by Leaf.
- **Root** folds the whole surface (including the frozen prefix) into one
  checkpoint. It reduces the active surface; it does not change any packet's
  historical proof.
- **Exit** records a retirement and replaces the marker-bearing node with a
  tombstone. It reduces the active surface and keeps exact recall by `cp:<id>`.
- **Restart** reconstructs the same Session from stored events, re-proves
  receipts, replays commits at their historical positions, and continues.
- **Fork** inherits only receipts whose commit seq is before the fork boundary.

Measured on the real token meter (`tests/semantic-longrun-real.spec.ts`,
2026-11-01, DSH 0.2.1-rc.3 packages):

| Folds | Surface tokens | Frozen checkpoint tokens | Working-set body | Omitted items | After root | After exit |
|---:|---:|---:|---:|---:|---:|---:|
| 10 | 1,269 | 1,269 | 80 | 0 | 396 | 215 |
| 30 | 11,594 | 11,594 | 515 | 7 | 1,344 | 729 |
| 100 | 60,805 | 60,805 | 516 | 77 | 1,347 | 730 |

A single checkpoint body saturates around 516 tokens; the frozen chain does
not. Root and Exit are what reclaim the chain, and both preserve exact recall.

## 7. Failure semantics at the surface

- Health is `ready` only when every committed receipt still has a valid proof,
  no packet is unresolved, and no receipt is unreadable.
- `partial` names the count or the blocked reason; the fold still commits
  deterministically.
- A blocked fork renders a state-only body with
  `(semantic continuity withheld: …)`, never a checkpoint that implies the
  missing parent state was loaded.
- A conflict never silently edits the journal or the log. It is a reading.
