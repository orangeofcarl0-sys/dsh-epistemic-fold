# R32 — Handoff

**Round:** R32, Semantic Commit Integrity & Recovery Hardening
**Branch:** `rc32-semantic-integrity`
**Status:** implementation and local verification complete; branch pushed to
`origin/rc32-semantic-integrity` (commit `bef473d`).

---

## 1. Is Active mode usable?

**Active mode is integrity-closed and recovery-hardened, but it is not certified
for real-model semantic quality.** The distinction matters:

* Every applied semantic operation is now bound to a validated packet, receipt,
  proof, and runtime ops schema.
* An incomplete or unreadable journal blocks NEW semantic commits; it does not
  block history folds, archival, or exact recall.
* A missing receipt after a clean commit is still recoverable.
* Partial fork inheritance is completed and verified.
* The whole checkpoint's capacity is reported, and pinned state is never
  silently trimmed.
* The live-model behavioral evaluation is NOT executed. The scripted suite is
  not evidence of real-model semantic quality.

Gate status (R32):

| Gate | Result | Evidence |
|---|---|---|
| G1 Integrity | **PASS** | unified validator, 47 R32 tests; 169-test combined semantic/R32 group |
| G2 Fail-Closed | **PASS** | unreadable/invalid/orphan/rejected-receipt admission; blocked folds keep history |
| G3 Idempotent Recovery | **PASS** | repeated fork/reconcile, real-process fault matrix |
| G4 Proof & Budget | **PASS** | exact replacement fields; whole-checkpoint accounting |
| G5 Real-Host Regression | **PASS (with known drift)** | real JSONL restart/fault matrix; 1356 passed / 3 drift / 3 load timeouts; timeout files pass 19/19 alone |

R32 does not claim a semantic-quality improvement. That is R33.

## 2. Supported boundary

### Supported

* DSH `0.2.1-rc.3` installed line; declared peer range `>=0.2.0-rc.2`.
* Journal-authority Active mode with a durable `FileSemanticJournal`.
* Off, Shadow, Basic, Archive, Exact Recall, Root, Exit, and fork on the tested
  DSH line.
* Normal plugin installation under DSH `agent-loop`, whose resume path persists
  the constructor's local `session/end-seed` through `appendUnstoredSuffix`.
* Real JSONL restart, crash-with-missing-receipt recovery, fork inheritance, and
  exact recall after restart.

### Not supported / not claimed

* A session whose journal directory and every legacy witness are deleted. It is
  indistinguishable from a new session; this is a declared storage limitation.
* Unscoped semantic claims from different tasks sharing a subjectKey. Scope must
  be supplied to keep them distinct.
* A bare embedding that restores a `Session` without persisting the local
  `session/end-seed` marker. EF does not monkey-patch DSH for this; the host
  agent-loop is the supported extension point.
* R31-era v4 rows that preserved a v3 packet id. They fail the native v4
  identity check; their `.v3.json` archive remains available for a fresh
  verified migration.
* Live-model semantic quality, cross-machine semantic seed transfer, and
  300-commit real Root/Exit behavior.

## 3. Known limitations and their dispositions

| Limitation | Disposition |
|---|---|
| Vendor 0.1.7 vs installed/declared 0.2.x | Pre-existing drift; 3 tests fail at baseline and R32. Not fixed. |
| Journal loss with no witness | Unrecoverable by construction; documented, not guessed at. |
| Unscoped coordinate collision | Support boundary; scoped claims are fixed. Full task-identity protocol is R33+ work. |
| R31-migrated v4 ids | Fail closed; re-migrate from `.v3.json` with the R32 algorithm. |
| Blocked fold is larger than a normal checkpoint | It still archives and gives recall; the notice replaces semantic state. |
| Perf is N history scans per reconcile | Measured ~1.0 s at 300 commits; no index added because no measured need. |
| Live eval entry | Interface checked; live run not executed. |
| `session/end-seed` persistence | Host agent-loop responsibility; harness now mirrors it. |

## 4. Operational runbook

### When a fold says `SEMANTIC STATE INCOMPLETE`

The body names the reason. Do not delete receipts or edit packets to make it
disappear. Recovery is an INVESTIGATION, not a directory reset: the journal is
the sole authority for accepted semantic state, so clearing it does not repair
the state, it erases the evidence that the state existed.

1. Leave the journal in place. New semantic commits are already blocked; the
   fold still archives history and exact recall still works.
2. Take a complete, byte-identical copy of the session journal directory before
   changing anything. Record the copy's path and hash in the incident note.
3. Inspect the journal with the diagnostic view (`state`, `invalid`, `orphans`,
   `rejectedReceipts`) and name the exact condition:
   * **orphan receipt** — a receipt names a packet that is not present. Restore
     the packet it names if a backup exists; otherwise the receipt's decision is
     still history and must not be treated as a missing receipt.
   * **corrupt or unreadable packet** — compare it with the session log, the
     bundle for that checkpoint, and the receipt's `opsDigest`. A packet whose
     operations do not reproduce the bundle's `state.digest` was changed after
     the fold and is not recoverable as state.
   * **proof conflict / older session backup** — the log is history and the
     receipt is the decision. Preserve both; never "repair" by re-appending
     future state to an older log.
   * **partial fork seed** — restore the parent journal. The child re-runs the
     expected-set seed and completes only what the parent proves.
4. Unblock only after an explicit recovery decision: restore the missing file,
   accept the archived-only outcome in writing, or declare the affected
   semantic state lost. There is no supported step that turns a damaged
   journal into an empty one.
5. If, and only if, the session log and bundles cannot establish a consistent
   history, treat the journal as unrecoverable: keep the copy, start the session
   with semantic continuity off (or as a new session), and record which
   semantic state was lost. Do NOT move the directory aside and continue
   Active — the next fold would report `valid-empty`, which is a lie produced by
   the recovery procedure itself.

### What never to do

* Do not rewrite a receipt to change an outcome.
* Do not edit a packet after its receipt.
* Do not delete an orphan receipt and continue Active writing; investigate why
  the packet is gone.
* Do not use `git reset --hard`, `git clean -fd`, or a forced overwrite on a
  checkout that contains user work.
* Do not treat "journal file exists" as "fold succeeded": the proof and receipt
  decide.

## 5. R33 evaluation entry

Run the interface check first:

```bash
npm run eval:r32-live
```

Run a real evaluation only deliberately:

```bash
EF_R32_LIVE=1 node eval/r32/live-semantic-eval.mjs --run --out r32-live.json
```

The report records, per scenario:

* raw input;
* provider, model, route origin;
* the semantic writer's call envelope and usage;
* accepted and refused deltas;
* the visible checkpoint;
* a next-step probe answer and usage;
* a keyword smoke rubric.

The keyword rubric is deliberately labelled a smoke test. R33 should replace it
with real task outcomes: did the next agent step respect the constraint, avoid
the rejected approach, distinguish written/tested/verified, and use the phase-1
artifact?

## 6. Verification commands for the next round

```bash
npm run typecheck
npm run build
npm run preflight
npx vitest run
EF_R32_PERF=1 npx vitest run tests/r32-perf.spec.ts
npm run eval:r32-live
```

The three pre-existing drift failures remain:

```text
tests/bridge-loads.spec.ts
tests/rc3-plugin-packaging.spec.ts
tests/rc7-inplace-drift.spec.ts
```

Full-suite timeouts under load are a Vitest configuration/Windows issue, not an
EF assertion; re-run a timed-out file alone before treating it as a regression.

## 7. Review package

The external-review package is generated at:

```text
R32_REVIEW_PACKAGE/
  git-status.txt
  git-log.txt
  diff-stat.txt
  R31_to_R32.patch
  commits/*.patch
  test-results/
  docs/
```

It contains the actual source diff and the actual test outputs; it is not a
summary written by the agent. Sensitive values are checked before packaging.

## 8. Next round

R32 stops at closing the integrity and recovery gaps. It does not start a new
memory system, a general knowledge graph, a vector database, a second compaction
engine, or a semantic retrieval redesign.

R33 should focus on behavioral evaluation with a real model and real tasks:

* unanchored constraints;
* negative knowledge;
* written/tested/verified boundaries;
* cross-phase dependencies;
* retrieval on demand;
* cost and long-horizon task success.
