# R32 — Recovery Admission, Fork Completeness, and Real-Host Resume

**Principle:** an incomplete recovery may still archive history, but it may not
pretend to be a complete current state and may not accept new authoritative
semantic operations.

---

## 1. Journal presence is three-valued

`FileSemanticJournal` distinguishes:

| Condition | `list().state` | `sessionState()` | Meaning |
|---|---|---|---|
| session directory absent (`ENOENT`) | `valid-empty` | `absent` | a genuinely new session, OR a lost journal |
| directory readable | `ok` | `present` | rows are knowable; per-file problems are `invalid` |
| directory/file I/O failure (`EACCES`, `EIO`, `ENOTDIR`, …) | `unreadable` | `unreadable` | the journal's contents are UNKNOWN |

A JSON parse failure is **corrupt**, not unreadable: the directory and the other
files are still knowable, so `state` stays `ok`, the file is `invalid`, and the
engine blocks because an authoritative row is missing.

Injected errno tests (`EACCES`, `EIO`) are reported separately from the real
filesystem test (`ENOTDIR` on a file where a directory is expected). No test
depends on Windows ACL behavior.

### Lost journal vs a new session

A lost directory and a new session both list `valid-empty`. A witness can
distinguish the cases that are recoverable:

* a legacy `plugin:epistemic-fold/semantic` record in the session log;
* a v3 packet file (migration candidate);
* a `.v3.json` archive not yet represented by a v4 row.

The reconciler runs `migrateLegacy` before deciding: if every witness converts
with a verified bundle and proof, the journal is rebuilt and Active may continue.
If any witness cannot verify, it is a blocker.

**Declared limitation:** a journal-only session (no legacy record) whose journal
directory is deleted is indistinguishable from a new session. Once both the
journal and every witness are gone, the semantic state cannot be recovered. The
system does not claim otherwise.

## 2. Admission

`ContinuityAdmission` answers three independent questions:

```ts
type ContinuityAdmission =
  | { mode: 'active'; state: FoldCurrentState }
  | { mode: 'archive-only'; reason: string }
  | { mode: 'blocked'; reason: string }
```

| Condition | Read state? | New semantic commit? | History fold? |
|---|---|---|---|
| mode off | no semantic layer | no | yes |
| journal valid, no contradictions | yes | yes | yes |
| journal valid, benign historical abort/pending | yes (committed only) | yes | yes |
| journal unreadable / invalid / orphan / rejected receipt | no | **no** | yes |
| committed receipt proof conflict | no | **no** | yes |
| fork seed incomplete or parent unreachable | no (base only) | **no** | yes |
| migration required but unverifiable | no | **no** | yes |

`reconcileSemantics` sets or clears the per-session block. `semanticAdmissionOf`
honors a current block; `summarize` always reconciles before asking, so a
repaired journal unblocks on the next fold.

### What a blocked fold still does

* It archives the exact shadowed messages and writes the bundle.
* It emits a deterministic temporal checkpoint.
* It stages **no** semantic packet and calls no writer.
* The body starts with:

```text
Semantic status
- SEMANTIC STATE INCOMPLETE — <reason>. No new semantic operations were
  committed; the deterministic history below is intact and recall still works.
```

* Exact recall continues to work through the real ToolRuntime (tested on the
  plugin path).

A benign historical abort (a fold rejected by the shrink check, its packet
marked `abandoned`, original history intact) is **not** a blocker. It may make
diagnostic health `partial`, but the next fold may still commit.

## 3. Historical proof hardening

The replacement must be the exact event Basic's `commitCompactionBody` writes:

```text
surfaceOp:       { op: 'replace', startSeq: summary.shadowedRange.start,
                                    endSeq:   summary.shadowedRange.end }
source:          { kind: 'compact-checkpoint', compactionId: summary.compactionId }
sourceEventSeqs: [startSeq, summarySeq, ...shadowedSeqs]  (exact, ordered)
```

The summary's `shadowedRange` must equal its first/last `shadowedSeqs`. A
replacement that cites the right events but covers another range, cites them in
another order, or names another compaction is not the required replacement.

`compaction/end` is closure, not commit. A replacement that landed stays
committed if the close is missing or records an error. A summary with no
replacement is:

* `unresolved` while the same process is executing the compaction;
* `archived-only` when a terminal close exists;
* `archived-only` after a restart (the synchronous commit block cannot resume);
* `compaction-crashed-open` → `abandoned` when the process that opened it is
  gone and no close exists.

## 4. Fork completeness

The algorithm is expected-set subtraction, not "is any child row present":

```text
expected = every parent commit re-proven inside the child prefix
actual   = validated child committed receipts
missing  = expected - actual
write missing packet/receipt idempotently
verify expected set complete
compare state at each inherited commit to the parent bundle's state digest
```

Rules:

* Only parent commits with `commitOrder < inheritedEventCount` are inherited.
* A parent packet whose receipt is missing but whose fold is proven against the
  child log is still inherited (cross-store crash).
* A parent receipt that is aborted/archived-only is excluded.
* A parent row that contradicts its own receipt blocks the fork.
* A child committed row below the boundary that the parent does not prove blocks
  the fork.
* A child packet file with different ops than the parent blocks the fork.
* If the parent journal directory is absent or unreadable, the child is blocked;
  a non-empty child journal is never taken as proof of complete inheritance.
* The parent journal must have no integrity problems and no unmigrated v3 rows.
* After writing, the child journal is re-read; every expected id must be a
  committed receipt.
* When the parent bundle recorded `state.digest`, the child replay at that
  commit must reproduce the same digest. Missing bundle state is not a
  contradiction, but a mismatch is.

Repeated runs are idempotent: no new files, no duplicate packet identities, and
the same replayed state.

## 5. Real-host resume

R31's process harness manually persisted `session/end-seed`. R32 investigated the
official lifecycle and found the extension point in DSH's agent loop:

* `agent-loop` `resumeWith` opens the stored session for write, reads the log,
  appends interrupted-turn closers, constructs the Session with
  `seed` + `meta` + `inheritedEventCount`, and calls `appendUnstoredSuffix` to
  persist the constructor's local `session/end-seed`.
* The harness now mirrors that exact shape. It does **not** monkey-patch DSH.
* A normal plugin install that runs under `agent-loop` therefore gets the
  resume bridge from the host; a bare harness that constructs a Session itself
  must do what `agent-loop` does (the process test does).

No EF source change was needed for resume. The EF support boundary is: persisting
host sessions are supported through the DSH agent-loop resume path; an embedding
that restores a `Session` without persisting the local seed marker is outside
the plugin's control.

## 6. Cross-store matrix

| Store A | Store B | Verdict | Result |
|---|---|---|---|
| session committed | receipt missing | valid, missing receipt | re-prove, write receipt, apply once |
| session committed | receipt valid | valid | replay |
| session aborted/closed | receipt missing | aborted/pending | final non-activation receipt |
| session older backup | committed receipt | conflict | block, no re-append |
| session newer/different | receipt committed | conflict | block |
| packet modified after receipt | receipt valid | conflict (`ops-digest`) | block, reject receipt |
| orphan receipt | no packet | invalid | block |
| receipt/citation range wrong | packet valid | aborted/conflict | block or archive-only |
| child prefix | partial parent seed | incomplete | fill missing, verify, unblock |

## 7. Concurrency

All reconciliation for one session enters through `reconcileSemantics`, which
uses a per-session promise tail. The fold's pre-write pass and the post-commit
event feed share it. No two passes can read the same staged packet and both
write a decision. The write path itself is compare-then-write with byte
read-back; a second, different decision is a hard error, not an overwrite.

## 8. Fault matrix (real processes)

`tests/r32-process-faults.spec.ts` runs two OS processes per case against the
real JSONL backend:

| Fault introduced between processes | Observed on restart |
|---|---|
| packet modified after receipt | `ops-digest` invalid, blocked notice, no activation |
| packet deleted, receipt kept | orphan reported, blocked notice |
| receipt proof compaction rewritten | proof conflict, blocked notice |
| session log restored to an older backup | conflict, blocked notice, no re-grant |
| one inherited fork packet+receipt deleted | missing commit restored, health ready, unique row |

The clean restart and missing-receipt crash cases remain in
`tests/semantic-process-restart.spec.ts` and pass unchanged.
