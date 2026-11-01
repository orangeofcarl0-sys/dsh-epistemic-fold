# R31 Evaluation

All results were produced in `ef-main-integration` on branch
`rc31-persistence-lifecycle`. Date: 2026-11-01. Platform: Windows 10
10.0.26200, Node 24.14.1, npm 11.11.0.

## 1. Environment

| Component | Version |
|---|---|
| Installed `@deepseek-ai/dsh-session` | 0.2.1-rc.3 |
| Installed `dsh-compaction`, `dsh-session-persistence`, `dsh-session-projection` | 0.2.1-rc.3 |
| Vendored `vendor/deepseek-harness` (Vitest alias) | 0.1.7-rc.2 |
| Real host used by the two-process test | installed 0.2.1-rc.3 packages |
| TypeScript / Vitest | 5.9.3 / 5.0.5 |

The vendor/installed split is pre-existing and is reported separately in §7.
It is not used to excuse any R31-specific result: the commit proof, journal,
and reconciler tests run through the vendored sources, while the 0.2.1 API and
the real JSONL restart run against the installed packages.

## 2. Commands

```bash
npm run build                     # 74 modules
npm run typecheck                 # src + client + eval: pass
npx vitest run --testTimeout=20000 --hookTimeout=20000
```

## 3. Final full-suite result

```text
Test Files  3 failed | 124 passed | 23 skipped (150)
Tests       3 failed | 1305 passed | 65 skipped (1373)
Duration    117.64s
```

The 65 skipped tests are the repository's pre-existing live/gated suites. They
were not enabled and must not be counted as passes.

### The three failures are pre-existing host/vendor drift

Verified by running the same three tests at the R30 baseline `77ab916` in a
separate worktree with the same `node_modules` and vendor junction:

| Test | Baseline 77ab916 | R31 |
|---|---|---|
| `bridge-loads` — runs on the SAME DSH line it typechecks against | FAIL: peer range `0.2.1-rc.3` vs vendor `0.1.7-rc.2` | FAIL, same values |
| `rc3-plugin-packaging` — `engines.dsh` matches vendored version | FAIL: `>=0.2.0-rc.2` vs `>=0.1.7-rc.2` | FAIL, same values |
| `rc7-inplace-drift` — preset rows match installed DSH | FAIL: generated 19 rows vs reference 22 | FAIL, same values |

Command used for the baseline check:

```bash
git worktree add --detach ../ef-r31-baseline 77ab916
# node_modules + vendor/deepseek-harness junctions to the integration worktree
npx vitest run tests/bridge-loads.spec.ts tests/rc3-plugin-packaging.spec.ts \
  tests/rc7-inplace-drift.spec.ts \
  -t "runs on the SAME DSH line|declares the DSH range|each preset differs"
# 3 failed | 32 skipped
```

No R31 test failed in the full run.

## 4. R31-specific suites

| Suite | Tests | Result |
|---|---:|---|
| `semantic-commit-proof` | 12 | pass |
| `semantic-journal-v4` | 8 | pass |
| `semantic-replay-order` | 4 | pass |
| `semantic-recovery` | 5 | pass |
| `semantic-concurrency` | 4 | pass |
| `semantic-process-restart` | 2 | pass |
| `semantic-lifecycle` | 1 | pass |
| `semantic-longrun-real` | 1 | pass |
| `semantic-fork` | 2 | pass |
| `semantic-continuity` | 5 | pass |
| `semantic-core` | 26 | pass |
| `checkpoint-residency` | 14 | pass |
| **Total semantic group** | **84** | **84 pass** |

Plus updated regression coverage in `p0-regressions` (10), `m3a-state` (19),
`semantic-host-0.2` (5), `semantic-longchain`, and `eval-semantic` (24 arm
measurements), all passing.

## 5. Test tiers

### Unit

- proof verdicts over real `Session` event transactions (12);
- journal immutability, ordering, legacy read, corrupt receipt (8);
- interleaved replay order and unplaced commits (4);
- reducer retirement counting and pinned selection.

### Integration (real engine + projection + Basic)

- active fold commit/carry across folds; shrink rejection → abort receipt;
  restart with a fresh Context; shadow byte-equality;
- fork inheritance and blocked fork;
- lifecycle: Leaf ×2, revision, Root, Leaf, Phase Exit, recall, restart, Leaf.

### Fault injection

- bundle/archive failure → no summary (pre-existing T06, still passing);
- shrink rejection → packet staged then aborted, never state;
- receipt-write failure → session committed / receipt missing, repaired in a
  second process;
- receipt committed / proof missing → conflict, no re-append, no state;
- corrupt receipt file → `invalid`, health partial;
- malformed retirement record → refused and counted;
- source content mismatch, span mismatch, missing start, retry with a different
  body → commit refused;
- pinned overflow and 30 pinned changed anchors → never silently dropped;
- concurrent reconcile / event feed overlap → one list at a time;
- missing parent journal on fork → Active writing withheld.

### Scripted

`eval-semantic.spec.ts` still reports the four-arm scripted matrix
`B0=1/6 B1=1/6 S1=1/6 S2=6/6`. This is a pipeline/representation measurement
with a scripted writer, not a model-quality result.

### Real LLM / real agent

**Not executed.** `EF_LIVE` was not set and no provider route is configured in
this environment. There are no real-model extraction-quality or real-agent
continuation numbers in this round. No value is inferred.

### Real host process

`tests/semantic-process-restart.spec.ts` spawns two OS processes. Each mounts
the real DSH runtime plus the JSONL persistence backend, and process B reopens
the artifact. Outcomes:

- clean restart: 17 stored events replayed; 1 receipt re-proved; second fold
  carried the first constraint; 2 committed receipts with commit order 15 and
  26; `context_recall` returned `Task phase 1` from the exact archive.
- injected receipt failure: process A produced a prepared packet with **no**
  receipt; process B re-proved the log, wrote the committed receipt
  (`activated: 1`), and carried the constraint. No semantic record was appended
  to the session log.

The JSONL harness needed one integration bridge: DSH's restored Session appends
a local `session/end-seed` during construction, before the store's publication
hooks exist, so the persistence handle's next-seq expectation is one behind.
The harness persists that event through the real `SessionHandle.append` before
any live append. This is documented as a host integration gap in
`R31_HANDOFF.md`; it is not an in-memory simulation.

## 6. Long-horizon measurements (real `TokenMeasurement`)

`tests/semantic-longrun-real.spec.ts` runs 10/30/100 real folds through the
production plugin. Every fold appends a closed turn, runs Basic compaction, and
commits a semantic packet with one revised pinned constraint and one new
decision.

| Folds | Surface tokens | Frozen checkpoint tokens | Frozen checkpoints | Working-set body | Omitted items | After root | After exit | Latest correct | Recall first | Recall retired |
|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| 10 | 1,269 | 1,269 | 10 | 80 | 0 | 396 | 215 | yes | yes | yes |
| 30 | 11,594 | 11,594 | 30 | 515 | 7 | 1,344 | 729 | yes | yes | yes |
| 100 | 60,805 | 60,805 | 100 | 516 | 77 | 1,347 | 730 | yes | yes | yes |

Interpretation:

- The single-checkpoint body saturates (~516 tokens at a 512 budget plus
  framing); it does not grow with fold count.
- The frozen checkpoint chain is **not** bounded by the compiler: 100 folds
  accumulate 60,805 surface tokens. Root and Exit are what reclaim it: 1,347
  and 730 respectively.
- The latest revised value is correct at all three lengths; the first value is
  not rendered after supersession.
- Pinned state is never omitted; omitted items are counted and retrievable.
- Exact recall works before and after retirement. Exact recall of the retired
  root returns a bounded page of the checkpoint chain it archived, not its own
  body; the page resolves and contains checkpoint markers.

`chars/4` was not used for these numbers.

## 7. Compatibility matrix

| Host line | Real status |
|---|---|
| Installed 0.2.1-rc.3 package set | Used by `semantic-host-0.2.spec.ts` (`createRequire`) and the two-process JSONL test. Passes. |
| Vendored 0.1.7-rc.2 source line | Used by the Vitest alias for all in-process engine tests. Passes for EF features; three pre-existing version-contract tests fail because `package.json` declares the 0.2.x line. |
| Repository declared minimum | `engines.dsh >=0.2.0-rc.2`. Not re-measured on 0.2.0; the installed 0.2.1 is the measured line. |

Do not read a green in-process suite as a 0.1.7 compatibility claim. The
journal/proof/restart behavior is exercised on 0.2.1 packages.

## 8. Not measured / unknown

- real LLM extraction quality and real-agent continuation (no provider);
- multi-process concurrent writers (deliberately refused, not coordinated);
- Windows process restart under a debugger or power loss (the crash test is a
  receipt-write failure plus process exit, not a torn disk);
- fork across machines with no shared `semanticRoot` (blocked, not repaired);
- migration of a v3 packet whose bundle has been deleted (reported
  `unrepairable`, not migrated);
- exact DSH 0.2.0 host behavior (not installed).
