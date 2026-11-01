# R32 — Source Audit

**Round:** R32, Semantic Commit Integrity & Recovery Hardening
**R31 final commit:** `6607149c087a99a9392c7171263dc05624488b58`
**R31 branch:** `rc31-persistence-lifecycle`
**R32 branch:** `rc32-semantic-integrity`
**R32 worktree:** `F:\Codex_Work_Space\DSH plugin\ef-r32-integrity`

---

## 1. Starting state

The audit began from the real Git tree, not from R31's summary.

```text
Primary checkout   F:\Codex_Work_Space\DSH plugin\dsh-epistemic-fold
  branch           rc29-working-set-observer
  HEAD             bd1131cc039c8addf1590973f7e6e406ed126e64
  status           18 modified files + 15 untracked R30 files (USER WORK)
  action           NOT touched, NOT reset, NOT cleaned, NOT used to build R32

R31 worktree       F:\Codex_Work_Space\DSH plugin\ef-main-integration
  branch           rc31-persistence-lifecycle
  HEAD             6607149c087a99a9392c7171263dc05624488b58
  status           clean except an ignored/untracked watchdog heartbeat
  action           preserved unchanged

R32 worktree       F:\Codex_Work_Space\DSH plugin\ef-r32-integrity
  branch           rc32-semantic-integrity (created from 6607149)
  node_modules     junction to the R31 worktree's installed dependencies
  vendor           junction to the primary checkout's vendor/deepseek-harness

origin/main        93b6666913dab6e00ca67032de9660f1bc75c052 (untouched)
R30 parent         77ab916a791ecd22041d4162566d3bef10a1a0f3
snapshot ref       snapshot/pre-semantic-audit-v1 -> a22f464 (preserved)
stash              empty
```

No destructive Git operation was used. The R31 worktree, snapshot ref, and the
primary checkout remain as they were.

### Environment

| Component | Version / value |
|---|---|
| Node | v24.14.1 |
| npm | 11.11.0 |
| Vitest | 5.0.5 (win32-x64) |
| Installed DSH packages | `0.2.1-rc.3` |
| Vendored DSH tree | `0.1.7-rc.2` |
| Installed `@deepseek-ai/cordis` | 4.0.5 |

The `package.json` engine range declares `>=0.2.0-rc.2`; the vendored source is
older. This is the known vendor/host drift recorded by R31, and it is the cause
of the three stable pre-existing suite failures below — not an R32 regression.

### Baseline full suite in the R32 worktree

The exact same worktree, dependencies, and commands as the rest of R32:

```text
1305 expected (R31 report)
1294 passed
  14 failed
  65 skipped
```

Of the 14 failures, 11 were 5-second Vitest timeouts (`task-root-bridge`,
`release-hygiene`, `bridge-loads`, `ef-collect`, `memory-filler-source`,
`rc3-plugin-packaging`), all amplified by the full-suite load. The three stable
assertion failures are the drift set:

```text
tests/bridge-loads.spec.ts        expected DSH 0.1.7-rc.2, installed line 0.2.0-rc.2
tests/rc3-plugin-packaging.spec.ts expected engines.dsh >=0.1.7-rc.2, has >=0.2.0-rc.2
tests/rc7-inplace-drift.spec.ts   preset row count 19 vs reference 22
```

They also fail at `6607149` without any R32 change. They are reported as
pre-existing drift, not fixed, not skipped, and not counted as R32 regressions.

---

## 2. Confirmed defects and contract gaps

Each entry names the real source location, the R31 reproduction, the R32 fix,
and the regression test.

### A1 — `opsDigest` was written but never enforced

**Class:** Confirmed Defect.

`SemanticReceipt.opsDigest` existed, but no state-application path compared it
with the packet's current `ops`. A packet edited after its receipt kept a valid
historical proof and was replayed with the edited operations.

* **R31 source:** `src/semantic/journal.ts` (`list`), `src/fold/engine.ts`
  (`semanticStateOf`, `reconcileSemanticsUnlocked`).
* **R31 reproduction:** `tests/r32-baseline-repro.spec.ts` →
  `does not count a receipt whose opsDigest disagrees with the packet`
  failed with `expected 0 to be 1` for `read.receipts.size`.
* **R32 fix:** the unified validator (`src/semantic/integrity.ts`) recomputes
  `canonicalHash(packet.ops)` and compares it to the receipt; `journal.list`
  rejects the pairing and reports `rejectedReceipts`; the engine never treats a
  rejected receipt as a missing one.
* **Regression:** same spec (passing), `tests/r32-integrity.spec.ts`
  (`rejects a packet modified after its receipt`), and the real-process
  `r32-process-faults.spec.ts` case.

### A2 — Native v4 packet identity was not checked

**Class:** Confirmed Defect.

A v4 file could declare any `packetId` and still be read; ordering and receipt
bindings then rested on a name the file itself chose.

* **R31 source:** `isSemanticPacket` checked only field presence.
* **R32 fix:** `packetIdOf` is recomputed from `(sessionId, checkpointId,
  foldedSeqs, bodyDigest)`; `journal.write` and `journal.list` refuse a mismatch.
  Legacy v3 ids are exempt and are re-derived only during verified migration.
* **Regression:** `tests/r32-integrity.spec.ts` (`rejects a packet id that is
  not the v4 identity of its body`) and
  `tests/semantic-journal-v4.spec.ts` (`refuses a packet whose id is not its v4
  identity`).

### A3 — File identity, receipt identity, and orphans were not associated

**Class:** Confirmed Defect.

`list` read packets and receipts independently. A receipt file with no packet,
a receipt bound to another checkpoint, or a payload id different from its file
name could still contribute to `receipts` and to health.

* **R31 reproduction:** `reports an orphan receipt…` expected
  `read.receipts.size === 0`, R31 returned 1;
  `rejects an unreadable journal directory…` expected `state === 'unreadable'`,
  R31 returned `undefined`.
* **R32 fix:** `JournalRead` now carries `orphans`, `rejectedReceipts`,
  `invalid[].code`, and `state`. `list` validates file stem, payload id,
  session/checkpoint binding, `opsDigest`, and proof body/span before a receipt
  enters `receipts`.
* **Regression:** `tests/r32-integrity.spec.ts` (orphan, receipt stem, packet
  stem), `tests/r32-process-faults.spec.ts` (orphan on the real JSONL host).

### A4 — No runtime schema for resolved operations

**Class:** Confirmed Defect.

`isSemanticPacket` accepted any array as `ops`. `[null]`, a declare without a
state key, an unknown lifecycle, a transition with no target, or a retire with
no id passed the reader and then silently did nothing in the reducer.

* **R32 fix:** `src/semantic/ops.ts` is the one runtime validator, used by the
  journal writer/reader, the integrity gate, and the legacy-record reader.
* **Regression:** `tests/r32-integrity.spec.ts` (`refuses a null operation`,
  `refuses malformed declare, transition, and retire operations`,
  `accepts the three legal operation shapes`).

### B1 — Journal read failures collapsed to "no journal"

**Class:** Confirmed Defect.

`FileSemanticJournal.list` caught every error and returned an empty journal.
`hasSession` did the same for every error. An `EACCES`, `EIO`, or `ENOTDIR`
looked exactly like a brand-new session, so Active mode continued to write.

* **R31 reproduction:** `distinguishes an unreadable journal directory…`
  expected `state === 'unreadable'`, R31 had no such field.
* **R32 fix:** `list` returns `ok | valid-empty | unreadable`; file read errors
  and JSON parse errors are distinguished (`io`/`unreadable` vs `corrupt`);
  `sessionState` is three-valued. Engine admission maps `unreadable` to
  `blocked`/`unavailable`, and no new packet is staged.
* **Regression:** `tests/r32-recovery.spec.ts` (ENOENT, ENOTDIR, injected
  EACCES/EIO, corrupt packet), `tests/r32-process-faults.spec.ts` (real host).

### B2 — Historical replacement fields were checked by containment only

**Class:** Confirmed Defect.

R31's `isReplacementFor` required the replacement to cite the start and summary
with `includes`. It did not require the surface range to equal the summary's
range, the citations to be in order, or the checkpoint source to name the same
compaction.

* **R31 reproduction:** `rejects a replacement whose range is not the summary
  range` and `…whose source citations are out of order` both expected
  `aborted`, R31 returned `committed`.
* **R32 fix:** `proof.ts` compares the exact `surfaceOp` range, requires the
  summary's `shadowedRange` to equal its first/last shadowed seq, requires the
  source's `compactionId` to match, and compares `sourceEventSeqs` exactly and
  in order.
* **Regression:** `tests/r32-recovery.spec.ts` and
  `tests/r32-baseline-repro.spec.ts`.

### B3 — A stale in-flight marker could outlive its transaction

**Class:** Contract Gap (the contiguous Basic path already settled it; a
non-contiguous close had no test).

R31 checked the in-process `inFlight` marker before looking for a terminal
`compaction/end`, so a summary with no replacement stayed `unresolved` while the
marker lived.

* **R32 fix:** a terminal close is checked first; a summary with no replacement
  and a close is `archived-only`; an open compaction with no close is
  `compaction-crashed-open` after a restart (and only `unresolved` while the
  same process is executing it).
* **Regression:** `tests/r32-recovery.spec.ts` (terminal close with
  `inFlight: true`, crashed-open).
* **Honesty note:** the exact summary-then-end sequence already returned
  `aborted` on R31, so the baseline reproduction for this item PASSES on both
  trees. It is recorded as hardening, not as a demonstrated runtime failure.

### C1 — Partial fork inheritance returned early

**Class:** Confirmed Defect.

`inheritForkSemantics` contained:

```ts
if (alreadyHere.length > 0) {
  return { wrote: 0, existing: alreadyHere.length }
}
```

One surviving child receipt proved "some inheritance happened", not "all
commits before the boundary were inherited".

* **R31 reproduction:** `tests/r32-baseline-fork-repro.spec.ts` deleted the
  second of two inherited packet/receipt pairs, reconciled again, and expected
  2 committed receipts. R31 left 1; R32 restored 2.
* **R32 fix:** expected set = every parent commit proven inside the child
  prefix; actual = validated child receipts; missing = expected − actual; each
  missing row is idempotently written; the expected set is re-read and verified;
  state at each inherited commit is compared to the parent bundle's recorded
  state digest when available.
* **Regression:** `tests/semantic-fork.spec.ts` (R32-C block, five tests) and
  `tests/r32-process-faults.spec.ts` (real process boundary).

### C2 — Semantic coordinates ignored task scope

**Class:** Confirmed Defect.

`semanticStateKey(kind, subjectKey)` had no scope. Two tasks that both named
`timeout` occupied one coordinate and silently superseded each other.

* **R31 reproduction:** two accepted constraints with different `scope`
  workspaces produced one surviving constraint (`expected 2, got 1`) and
  `retiredCount === 1`.
* **R32 fix:** scope joins the coordinate as `kind#<canonicalHash(scope)>`, the
  anchor stores `scope`, the delta id includes it, and bare supersede targets
  resolve only within the proposal's scope. Unscoped claims keep the pre-R32
  coordinate; that boundary is asserted, not hidden.
* **Regression:** `tests/r32-scope.spec.ts` (five tests).

### C3 — Working-set overflow was not whole-checkpoint overflow

**Class:** Contract Gap.

`compileWorkingSet().overflow` bounded only carried state. Changed anchors,
rationale, marker, and framing were outside every measured budget, so
`overflow: false` did not mean "the checkpoint fits".

* **R32 fix:** `measureCheckpointCapacity` prices the exact renderer sections
  (`changed`, `carried`, `rationale`, `framing`, `notice`) and the joined body;
  `SemanticWorkingSetReport` carries all of them; the body renders an explicit
  `checkpoint-over-budget` line when the whole body exceeds
  `semanticCheckpointTokens`. Pinned state is never trimmed.
* **Regression:** `tests/r32-capacity.spec.ts` (direct compiler and engine
  fold).

---

## 3. Files changed

Source:

```text
src/semantic/ops.ts                 NEW  runtime operation schema + identity
src/semantic/integrity.ts           NEW  one ValidatedSemanticCommit gate
src/semantic/admission.ts           NEW  active / archive-only / blocked
src/semantic/journal.ts             packet/receipt association, rejected receipts,
                                    corruption vs unreadability, sessionState
src/semantic/proof.ts               exact replacement fields, terminal close,
                                    crashed-open
src/semantic/commit.ts              abort mapping
src/semantic/replay.ts              consumes ValidatedSemanticCommit; bounded replay
src/semantic/record.ts              shares the runtime op validator
src/semantic/types.ts               rejected-receipt/legacy provenance, capacity
src/semantic/plan.ts                scope-aware target resolution
src/semantic/validate.ts            scope in state coordinate and delta id
src/semantic/working-set-compiler.ts whole-checkpoint capacity
src/state/state.ts                  Anchor.scope
src/fold/engine.ts                  admission, reconciliation, fork, migration,
                                    capacity, blocked fold body
src/checkpoint/renderer.ts          temporal sections + visible notice
src/config/{ef-keys,plugin-config,policy}.ts  semanticCheckpointTokens
src/index.ts                        public R32 surface
eval/r31/lifecycle-host.mjs         official resume shape, fork mode, fault output
eval/r32/live-semantic-eval.mjs     NEW  R33 live entry (interface only)
package.json                        eval:r32-live entries
```

Tests:

```text
tests/r32-integrity.spec.ts
tests/r32-recovery.spec.ts
tests/r32-capacity.spec.ts
tests/r32-scope.spec.ts
tests/r32-process-faults.spec.ts
tests/r32-live-entry.spec.ts
tests/r32-perf.spec.ts              skipped unless EF_R32_PERF=1
tests/r32-baseline-repro.spec.ts
tests/r32-baseline-fork-repro.spec.ts
tests/r32-fixtures.ts
tests/semantic-{concurrency,fork,journal-v4,recovery,replay-order}.spec.ts
```

## 4. Git commits

The implementation is one interlocking source commit because the runtime
validator, journal reader, replay signature, and engine admission must change
together to preserve a single buildable authority; tests and docs are separate
commits.

```text
<filled by the commit step — see R32_HANDOFF / review package>
```

## 5. Baseline reproduction evidence

A temporary worktree at `6607149` (dependencies and vendor junctioned, no source
edits) ran the two baseline specs:

```text
tests/r32-baseline-repro.spec.ts       6 failed / 1 passed
tests/r32-baseline-fork-repro.spec.ts  1 failed

Failures on R31:
  modified packet      receipts.size 1 (expected 0)
  orphan receipt       receipts.size 1 (expected 0)
  unreadable journal   state undefined (expected 'unreadable')
  wrong replacement range   status committed (expected aborted)
  wrong source order        status committed (expected aborted)
  scoped collision         1 constraint (expected 2)
  partial fork             1 receipt (expected 2)

Passed on R31:
  terminal close + inFlight  (already aborted; hardening not a runtime regression)
```

The temporary worktree was removed and `git worktree list` is back to the three
sanctioned trees. The primary checkout was never modified.
