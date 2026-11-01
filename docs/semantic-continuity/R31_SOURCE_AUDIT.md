# R31 Source Audit

## 1. Git baseline and protection

| Item | Value |
|---|---|
| Prototype worktree | `F:/Codex_Work_Space/DSH plugin/dsh-epistemic-fold` |
| Prototype branch / HEAD | `rc29-working-set-observer` / `bd1131cc039c8addf1590973f7e6e406ed126e64` |
| Prototype dirty state | 18 tracked modified files + 15 untracked files (unchanged from R30) |
| Existing snapshot ref | `refs/heads/snapshot/pre-semantic-audit-v1` = `a22f464` |
| External snapshot | `../ef-audit-snapshot-20261101` |
| R31 backup | `../ef-r31-backup/prototype-tracked.patch` (sha256 `ef360078…b64be`), `prototype-untracked.tgz` (sha256 `3c32807c…0aa3d`) |
| Integration worktree | `F:/Codex_Work_Space/DSH plugin/ef-main-integration` |
| R30 integration baseline | `77ab916a791ecd22041d4162566d3bef10a1a0f3` on `rc30-semantic-continuity` |
| R31 branch | `rc31-persistence-lifecycle`, created at `77ab916` |
| `origin/main` at start | `93b6666913dab6e00ca67032de9660f1bc75c052` |
| Installed host | `@deepseek-ai/dsh-*` 0.2.1-rc.3 (session, compaction, persistence, projection) |
| Vendored host | `vendor/deepseek-harness` 0.1.7-rc.2 |
| `cordis.patch.yml` | clean at start, no generation drift |

No reset/clean/force operation was used. The prototype worktree was not
switched or edited. R31 work happens only in the integration worktree.

## 2. Confirmed defects and fixes

### A1 — retirement written through one transport, read through another

**Files:** `src/checkpoint/residency.ts`, `src/state/plugin-events.ts`

**Root cause.** `retireCheckpoint()` writes through `appendEfEvent()`. On DSH
0.2.1 that is `appendPluginRecord` and the event type is
`plugin:epistemic-fold/retire`. `deriveCheckpointResidency()` scanned raw events
for `event.type === 'ef/retire'`. The write succeeded and the checkpoint still
read as resident; Phase Exit then reported `written: true` and a residency that
did not move.

**Fix.** `readCheckpointRetirements(session)` is the single domain reader. It
uses `efPluginRecordOf`, so raw `ef/retire` (in-memory/legacy) and
`plugin:epistemic-fold/retire` (0.2.1) are one domain. The first valid record
per checkpoint wins. A payload that is not an object with a non-empty
`checkpointId` is refused and counted in `invalidRetirements`; it never invents
an id. No journal retirement is accepted as independent authority, because a
file cannot prove a surface operation.

**Tests:** `tests/checkpoint-residency.spec.ts`
`reads a retirement written through the 0.2.1 plugin-record transport`,
`treats the old raw and new plugin records as ONE domain`,
`REFUSES a malformed retirement record`, `does NOT call a removed node retired`.
Phase Exit's two operations (record, then surface tombstone) are exercised in
`tests/semantic-lifecycle.spec.ts`.

### A2 — one logical objective counted as two retirements

**File:** `src/state/state.ts`

**Root cause.** An objective with a `stateKey` is indexed in both
`state.objective` and `stateHeads[key]`. `retireAnchor()` removed the slot and
incremented `removed`, then found the head and incremented again. One anchor
retirement produced `retiredCount += 2`.

**Fix.** Count FOUND (one logical anchor), not index entries removed. The slot,
the face entry, and the matching head are all still cleared; the counter moves
once. A repeated retirement returns the identical state object. Retiring a
superseded objective cannot remove the replacement head because `removeFace`
checks the head id.

**Tests:** `tests/m3a-state.spec.ts` describe
`R31-A2: one logical anchor, one retirement` (three tests).

### A3 — the changed cap could drop still-binding pinned constraints

**Files:** `src/semantic/changes.ts`, `src/semantic/working-set-compiler.ts`,
`src/fold/engine.ts`

**Root cause.** `changedAnchors()` applied one global cap after sorting pinned
first. With 30 pinned changes and a cap of 24, six constraints were omitted.
The engine then excluded `changed.all` (all 30) from the carried working set, so
those six were neither in `Changed in this fold` nor in
`State from earlier folds`; only the generic "retrieve them" pointer remained.

**Fix.** The cap is a WORKING-anchor quota. Pinned changed anchors are never
capped; working anchors beyond the quota are reported through
`changedOverflowLine` and remain retrievable. The compiler already reports
`working-set-overflow` when pinned state alone exceeds its budget, so an
expensive pinned set is disclosed rather than trimmed.

**Tests:** `tests/semantic-core.spec.ts` (three R31-A3 tests, including 30
pinned changed anchors and 30 pinned + 30 working), plus the updated root case
in `tests/semantic-longchain.spec.ts`.

### A4 — two reconciliation entry points, one serialization chain

**File:** `src/fold/engine.ts`

**Root cause.** `scheduleSemanticActivation()` serialized the event-feed path
through `semanticChains`. `summarize()` called `reconcileSemantics()` directly,
outside that chain. Two passes could list the same staged packet and both
write a decision.

**Fix.** `runSemanticLocked(session, task)` is the one boundary.
`reconcileSemantics()` enters it; `reconcileSemanticsUnlocked()` is private and
must be called inside. The event feed only schedules the public method. The
stored chain value is a resolved tail, so a failed pass cannot poison the next.

**Tests:** `tests/semantic-concurrency.spec.ts` (concurrent calls, event feed +
direct call, retry after failure, mount-time null-journal refusal).

## 3. Additional defects found during the R31 audit

### B/C1 — commit evidence used current residency

**File:** `src/semantic/commit.ts` (pre-R31)

`surface.nodes.includes(replacementSeq)` proves the checkpoint is visible NOW,
not that the fold ever committed. A checkpoint folded away by a later fold made
its packet `archived-only`. Replaced by `src/semantic/proof.ts` (see
`R31_COMMIT_PROOF.md`).

### B/C2 — a summary without a replacement was not distinguished from a committed fold

Pre-R31 the classifier returned `archived-only`, which the journal treated as a
permanent non-activation. That part was right, but it conflated "bundle durable /
surface never committed" with "checkpoint no longer resident". The v4
classifier now has separate `archived-only`, `abandoned`, `pending`, `conflict`
verdicts backed by transaction evidence.

### C3 — replay ordered packets by wall time and appended them at the end

**Files:** `src/semantic/journal.ts` (pre-R31 `comparePackets`),
`src/fold/engine.ts` (pre-R31 `semanticStateOf`)

`activatedAt ?? createdAt` is not a historical order, and applying every packet
after the whole session lets an early fold overwrite a later raw event. v4 sorts
by the proof's `commitOrder` (replacement seq) and replays on the same timeline
as the session events (`src/semantic/replay.ts`).

### C4 — mutable status was the commit record; `setStatus` could return `undefined`

The v3 journal rewrote one packet file's `status`. A caller could ignore the
`undefined` return and count an activation that never landed. v4 separates the
immutable prepared packet from the immutable receipt, and `writeReceipt()`
throws when the packet does not exist or a different decision already exists.

### C5 — session-record recovery re-granted state from the journal alone

Pre-R31, if the journal said `activated` and the session log lacked the record,
the engine re-appended a semantic record. That injects future state into an
older session backup. v4 never re-appends: a receipt without proof is
`conflict`, and only the `session committed / receipt missing` direction is
repaired (by proving the log, then writing the receipt).

### C6 — the packet had no source-content identity

`spanDigest = canonicalHash(foldedSeqs)` is event-position identity. A log
restored with different events at the same seqs would satisfy it. v4 stores
`sourceDigest = archive.logicalHash`, re-derives the retired-source hash from
the log, and refuses a mismatch.

### C7 — a fork silently lost parent semantic state

`list(childId)` is empty after a DSH fork, because the child has a new id. The
engine now seeds verified parent commits before the inherited boundary and
blocks Active writing when the parent journal directory is absent
(`tests/semantic-fork.spec.ts`).

## 4. Files changed in R31

Production modules:

- `src/checkpoint/residency.ts` — unified retirement reader.
- `src/state/state.ts` — unique-anchor retirement counting.
- `src/semantic/changes.ts` — pinned-safe selection.
- `src/semantic/proof.ts` (new) — historical fold commit proof.
- `src/semantic/commit.ts` — verdict adapter and conflict-aware health.
- `src/semantic/journal.ts` — v4 immutable packet + receipt journal, commit order.
- `src/semantic/replay.ts` (new) — interleaved session/commit replay.
- `src/semantic/types.ts` — schema 4, source digest, receipts.
- `src/semantic/record.ts` — legacy v3/v4 record reader for migration.
- `src/state/projection.ts` — version 4, semantic records no longer folded,
  exported `reduceSessionEvent`.
- `src/fold/engine.ts` — journal authority, receipts, proof reconciliation,
  ordered replay, migration, fork seed, serialization.
- `src/index.ts` — new public exports.
- `README.md` — authority/commit/fork semantics.

Tests added:

- `tests/semantic-commit-proof.spec.ts` (12)
- `tests/semantic-journal-v4.spec.ts` (8)
- `tests/semantic-replay-order.spec.ts` (4)
- `tests/semantic-recovery.spec.ts` (5)
- `tests/semantic-concurrency.spec.ts` (4)
- `tests/semantic-process-restart.spec.ts` (2, two OS processes each)
- `tests/semantic-lifecycle.spec.ts` (1 long sequence)
- `tests/semantic-longrun-real.spec.ts` (1 test, three real runs)
- `tests/semantic-fork.spec.ts` (2)
- `eval/r31/lifecycle-host.mjs` — real JSONL process entry.
- Existing suites updated where the semantics changed (`checkpoint-residency`,
  `semantic-core`, `semantic-continuity`, `semantic-longchain`, `m3a-state`).

## 5. Residual risks

- The installed DSH packages are 0.2.1-rc.3 while `vendor/deepseek-harness` is
  0.1.7-rc.2. Vitest aliases resolve bare `@deepseek-ai/*` to the vendor; the
  real 0.2.1 API is tested through `createRequire` and the process harness.
  `tests/rc3-plugin-packaging.spec.ts` still fails on this pre-existing drift
  (`engines.dsh` says `>=0.2.0-rc.2`, vendor says 0.1.7-rc.2). See
  `R31_EVALUATION.md`.
- `rc7-inplace-drift.spec.ts` fails on the same host/vendor mismatch (generated
  preset row count 19 vs installed reference 22). It is not caused by R31.
- The JSONL process harness must persist DSH's local `session/end-seed` marker
  before the first live append; the installed packages ship no resume
  coordinator that does this. `eval/r31/lifecycle-host.mjs` performs the bridge
  through the real handle API and documents it. This is an integration gap, not
  a test workaround, and is recorded in `R31_HANDOFF.md`.
- A fork whose parent journal is absent is blocked, not repaired. There is no
  way to reconstruct parent receipts from an unavailable journal.
