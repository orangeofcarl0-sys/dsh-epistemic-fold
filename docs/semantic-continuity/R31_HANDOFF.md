# R31 Handoff

## 1. Verdict

**Active Semantic Continuity is technically ready for a controlled trial on the
measured host line (DSH 0.2.1-rc.3 packages), single writer per session.**

It is **not** the default and is not certified for:
- multi-process writers on one session;
- forks whose parent journal is not co-located;
- real-model extraction quality (not measured this round).

`off` remains the default. `shadow` remains the safe measurement mode. The
production authority is now the EF journal; the session log is history + fold
proof.

## 2. Gates

| Gate | Result | Evidence |
|---|---|---|
| A — Deterministic correctness | **PASS** | A1–A4 fixed with pre-fix reproductions and regression tests; 84-test semantic group |
| B — Historical commit proof | **PASS** | `semantic-commit-proof`; committed-then-unresident; partial commits; end-failure; source/span mismatch |
| C — Durable semantic state | **PASS** | v4 immutable packet+receipt; journal sole authority; ordered replay; migration; fail-closed conflict |
| D — Process recovery | **PASS (with host bridge note)** | Two OS processes, real JSONL, clean restart and injected missing-receipt crash |
| E — Lifecycle integration | **PASS** | Leaf/Leaf/revision/Root/Leaf/Exit/Recall/Restart/Leaf; 10/30/100 real folds; fork boundary |
| F — Git / regression | **PASS** | Full suite 1305 passed; 3 failures reproduce at baseline 77ab916 (vendor drift); typecheck/build clean |

## 3. Configuration

```yaml
- name: dsh-epistemic-fold
  config:
    mode: legacy                     # or a policy tier
    semanticMode: rationale
    semanticContinuity: active       # off (default) | shadow | active
    semanticWorkingSetTokens: 1024   # 128..8192
    bundleRoot: <profile persistence root>/epistemic-fold
    semanticRoot: <profile persistence root>/epistemic-fold/semantic
```

`semanticRoot` must be on durable storage shared by every process that opens
the session. A sync tool that copies only the session JSONL will leave the
journal behind; the next process sees a staged/absent state and reports
`partial`, not `ready`.

`active` requires `semanticMode: rationale`. A zero-LLM profile is never
upgraded.

## 4. First-run / migration checklist

1. Back up the session store and the EF bundle root.
2. Set `semanticContinuity: shadow` first. Confirm the visible checkpoints are
   byte-identical to `off` and inspect `semanticWriterStats` / `/context`.
3. Create `semanticRoot` on the same filesystem as the bundles, writable by the
   DSH profile.
4. Switch to `active`. The first active reconciliation migrates:
   - v3 journal packets → v4, only with a verified bundle and historical proof;
   - legacy `plugin:epistemic-fold/semantic` records → v4 receipts under the
     same rule.
   Old v3 files are moved to `<packetId>.v3.json`.
5. Check `/context`:
   - `semantic continuity: active (ready)`;
   - `committed` count grows after folds;
   - no `conflict` / `unrepairable` / `blocked` detail.
6. Do not enable multiple writers on one session.

## 5. Rollback

- Set `semanticContinuity: off`. Folds continue on the deterministic path; the
  journal is untouched.
- For a controlled comparison set `shadow`; the visible checkpoint stays
  byte-identical, and the diagnostic writer's packets are never journaled.
- The journal is append-only in practice: prepared packets and receipts are
  immutable. Deleting `semanticRoot` discards semantic state; it does not
  delete history or bundles. Restore the journal from backup rather than
  editing files.
- No session log rewrite is required to roll back.

## 6. Operational reading

| Health | Meaning |
|---|---|
| `ready` | every committed receipt re-proves, no unresolved packet |
| `partial` | unresolved stage, abort, conflict, invalid file, blocked fork, or failed receipt write; detail names it |
| `unavailable` | journal unreadable; active state is not being served |
| `archive-only` | no semantic state (off mode) |
| `stale` | reserved for a log/cross-store disagreement; R31 reports that case as `conflict` inside `partial` |

A `conflict` is a READING. Do not "fix" it by re-appending a record or deleting
the receipt. If the session log is an older backup, the journal is ahead; if the
journal is from another history, its proof will not match.

## 7. Known blockers and limitations

1. **Live semantic evaluation not executed.** No provider route/credentials in
   this environment. The scripted 6/6 matrix is not a model-quality claim.
2. **JSONL restore bridge.** The installed packages ship no resume coordinator
   that persists DSH's local `session/end-seed` event; the EF process harness
   does it through `SessionHandle.append`. A production host integration must
   provide the same barrier before the first live append, or the persistence
   backend rejects a batch that starts one seq late.
3. **Fork must share the journal.** A child with no parent journal directory is
   blocked (Active writing withheld, visible in the body and `/context`). It is
   not auto-repaired.
4. **Single writer.** Different packet/receipt bytes for the same id throw.
   That is deliberate; there is no distributed lock.
5. **Vendor/version drift.** `vendor/deepseek-harness` is 0.1.7-rc.2 while the
   package declares the 0.2.x line and installs 0.2.1-rc.3. Three pre-existing
   packaging tests fail on this. Resolve the vendor line before claiming a
   uniform compatibility matrix.
6. **Legacy migration needs the bundle.** A v3 packet or session record without
   a verified bundle is `unrepairable`; it is not converted on trust.
7. **`cordis.patch.yml`** was clean at start and was not regenerated. No
   generated assembly change is part of R31.

## 8. Useful commands

```bash
npm run build
npm run typecheck
npx vitest run --testTimeout=20000 --hookTimeout=20000
npx vitest run tests/semantic-commit-proof.spec.ts tests/semantic-journal-v4.spec.ts \
  tests/semantic-replay-order.spec.ts tests/semantic-recovery.spec.ts \
  tests/semantic-concurrency.spec.ts tests/semantic-process-restart.spec.ts \
  tests/semantic-lifecycle.spec.ts tests/semantic-longrun-real.spec.ts \
  tests/semantic-fork.spec.ts tests/semantic-continuity.spec.ts \
  tests/semantic-core.spec.ts tests/checkpoint-residency.spec.ts
node eval/r31/lifecycle-host.mjs write <root> <sessionId>
node eval/r31/lifecycle-host.mjs read  <root> <sessionId>
EF_NO_RECEIPT=1 node eval/r31/lifecycle-host.mjs write <root> <sessionId>  # crash case
```

## 9. Next work, in priority order

1. Real-provider semantic evaluation (`EF_LIVE`) with the same scenarios and a
   grader; separate extraction quality from agent continuation.
2. Add a host-level resume coordinator that durably appends the local
   `session/end-seed` marker before live writes.
3. Resolve the vendor line (0.1.7 vs 0.2.x) and settle the three packaging
   tests.
4. Decide whether Phase Exit ships as a product operation or remains an
   evaluation driver; today `retireCheckpoint` and the tombstone are the two
   operations and the driver chooses when.
5. If forks must work across machines, define a semantic-seed transfer that
   keeps the proof, not just the packets.
