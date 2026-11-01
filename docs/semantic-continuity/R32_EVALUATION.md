# R32 — Evaluation

**Rule:** every number below is from an executed command. Anything not run is
marked `not executed`. No scripted-writer result is presented as a live-model
result.

---

## 1. Environment

```text
worktree   F:\Codex_Work_Space\DSH plugin\ef-r32-integrity
branch     rc32-semantic-integrity
base       6607149c087a99a9392c7171263dc05624488b58
node       v24.14.1
npm        11.11.0
vitest     5.0.5 (win32-x64)
installed  DSH 0.2.1-rc.3
vendor     DSH 0.1.7-rc.2
os         Windows 10.0.26200 x64
```

Commands:

```bash
npm run typecheck        # src + client + eval
npm run build
npm run preflight
npx vitest run
EF_R32_PERF=1 npx vitest run tests/r32-perf.spec.ts
node eval/r32/live-semantic-eval.mjs --check
```

## 2. Baseline vs R32

### 2.1 R31 baseline reported by the previous round

```text
Full suite       1305 passed / 3 failed / 65 skipped
R31-specific     84 passed / 0 failed
```

The three failures were the DSH vendor/host drift set. They are not R32
regressions.

### 2.2 Baseline measured in the R32 worktree before changes

```text
1294 passed / 14 failed / 65 skipped
```

14 failures = 3 stable drift assertions + 11 five-second Vitest timeouts under
full-suite load. The timeout set is not stable: individual files pass when run
alone. The stable comparison is the three drift assertions:

```text
tests/bridge-loads.spec.ts
tests/rc3-plugin-packaging.spec.ts
tests/rc7-inplace-drift.spec.ts
```

### 2.3 R32 dedicated suites

```text
tests/r32-integrity.spec.ts              12 passed
tests/r32-recovery.spec.ts               12 passed
tests/r32-capacity.spec.ts                3 passed
tests/r32-scope.spec.ts                   5 passed
tests/r32-live-entry.spec.ts              2 passed
tests/r32-baseline-repro.spec.ts          7 passed
tests/r32-baseline-fork-repro.spec.ts     1 passed
tests/r32-process-faults.spec.ts          5 passed
                                         ----------
                                         47 passed / 0 failed
```

The semantic regression group (all `semantic-*.spec.ts`, `m3a-state`,
`checkpoint-residency`, `eval-semantic`, including the 10/30/100 real-fold
long-run) reported:

```text
16 files, 122 tests passed / 0 failed
```

`tests/r32-perf.spec.ts` is skipped unless `EF_R32_PERF=1`.

### 2.4 Full suite after R32

The first post-change full run (before restoring two test-generated docs files)
reported:

```text
1345 passed / 8 failed / 66 skipped
```

Of the 8 failures:

* 3 stable pre-existing drift assertions;
* 1 `docs-manifest` failure caused by test-generated churn in
  `docs/MANIFEST.json` (the file was truncated/corrupted by an earlier test
  run, not by R32 source). It was restored to `HEAD`.
* 4 five-second timeouts (`release-hygiene` history scan and three
  `task-root-bridge` process tests).

No R32 test failed. A final clean full-suite run is recorded in §7 after the
docs files were restored and the build was refreshed.

## 3. Baseline reproduction evidence

A temporary worktree at `6607149` ran the two baseline specs with no source
changes:

```text
tests/r32-baseline-repro.spec.ts       6 failed / 1 passed
tests/r32-baseline-fork-repro.spec.ts  1 failed

modified packet            receipts.size 1       expected 0
orphan receipt             receipts.size 1       expected 0
unreadable journal         state undefined       expected 'unreadable'
wrong replacement range    committed             expected aborted
wrong source order         committed             expected aborted
scoped collision           1 constraint          expected 2
partial fork               1 committed receipt   expected 2
```

The terminal-close/in-flight assertion passed on R31 (R31 already handled the
contiguous summary→end case), so it is hardening, not a demonstrated runtime
failure.

The temporary worktree was removed; `git worktree list` returned to the three
sanctioned trees.

## 4. Performance: measure before optimizing

Command:

```bash
EF_R32_PERF=1 npx vitest run tests/r32-perf.spec.ts
```

Synthetic but real `Session` objects and real `FileSemanticJournal` files; one
`reconcileSemantics` pass per size. Instrumentation counted `snapshotEvents`
(history scans), `deriveEventMessage` (source re-derivations), and journal bytes
on disk. Heap delta was measured without forced GC.

| commits | events | journal bytes | reconcile ms | proof calls | history scans | source re-derivations | heap delta |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 30 | 151 | 59,778 | 92.0 | 31 | 31 | 90 | +4,108,136 |
| 100 | 501 | 199,848 | 316.4 | 101 | 101 | 300 | +2,204,960 |
| 300 | 1,501 | 601,647 | 1,028.0 | 301 | 301 | 900 | −20,535,408 |

Observations:

* Proof calls = `N + 1`: one per active packet plus one `snapshotEvents` from
  the legacy-record reader in the same pass. History scans equal proof calls.
* Source re-derivations = `3N`: two source messages plus the replacement
  message per packet.
* Duration from 100 → 300 is ~3.25× for 3× commits and 3× events. The repeated
  history scan is `O(N²)` in principle, but at these sizes the per-pass cost is
  dominated by journal file I/O and stays ~1.0 s at 300 commits.
* Heap deltas are noisy and the 300-commit figure is negative because the
  runtime GC'd during the pass. No forced GC was used, so heap delta is reported
  as measured, not as a peak.
* **No shared history index was added.** The measurement does not show a
  pathological cost at the supported sizes, and the brief forbids optimizing
  without evidence.

## 5. Fault injection

### 5.1 Real process / real JSONL

`tests/r32-process-faults.spec.ts` spawns two OS processes per case; each process
mounts the real context, `SessionStore`, `SessionPersistence` JSONL backend,
projection registry, token meter, system prompt, tool runtime, and the real
plugin. The second process reopens the artifact.

| Case | Result |
|---|---|
| Clean restart + fold + exact recall | passed (`semantic-process-restart`) |
| Session committed, receipt missing | recovered, receipt written (`semantic-process-restart`) |
| Packet modified after receipt | `ops-digest` invalid, notice, no activation |
| Orphan receipt | orphan reported, notice, no activation |
| Receipt proof names another compaction | conflict, notice, no activation |
| Session log restored to older backup | conflict, notice, no re-grant |
| Partial fork inheritance (one packet+receipt lost) | restored, unique row, health ready |

### 5.2 Injected filesystem errors

`EACCES` and `EIO` are injected through a journal object, not through Windows
ACLs. The real filesystem case uses a directory-shaped file (`ENOTDIR`). They are
reported separately:

```text
ENOENT new session          valid-empty / absent
ENOTDIR / EACCES / EIO      unreadable / blocked / unavailable
malformed JSON              corrupt file + blocked
```

No test relies on unstable Windows permission behavior.

## 6. Live model evaluation

Status: **not executed**.

`eval/r32/live-semantic-eval.mjs` is the R33 entry point. It defines four
scenarios:

```text
unanchored-constraint
negative-knowledge
validation-boundary
cross-phase-dependency
```

`--check` validates the scenarios and the report fields without resolving
credentials. It was executed:

```text
status: interface-ok
scenarios: 4
report fields include provider, model, writer, accepted, refused,
                    checkpoint, probe, score
```

`--run` refuses unless `EF_R32_LIVE=1`. The refusal was tested:

```text
status: not-executed
reason: EF_R32_LIVE is not 1; refusing to spend provider credits
```

No model call was made in R32. The scripted 6/6 semantic control-arm result in
`tests/eval-semantic.spec.ts` remains a **scripted** result and is not evidence
of live-model semantic quality.

## 7. Final clean run

*(Updated after the final build/typecheck/preflight/suite runs. See the report
at the end of the round for the exact command output.)*

## 8. What these results do NOT establish

* No live-model semantic quality result. R32 certifies integrity and recovery,
  not that a real model preserves constraints better.
* No 300-commit real Root/Exit long-run. The 10/30/100 real-fold long-run is
  unchanged and passes; the 300-commit figure is a reconciliation measurement
  over synthetic sessions.
* The fork state-equivalence check is available only when the parent bundle
  recorded `state.digest`; otherwise inheritance is still proof-verified but the
  digest comparison is skipped.
* A journal-only session whose journal and all witnesses are deleted cannot be
  distinguished from a new session.
* Unscoped semantic claims from different tasks still share one coordinate; the
  fix requires a trustworthy scope.
* The three DSH vendor/host drift failures are not fixed by R32.
