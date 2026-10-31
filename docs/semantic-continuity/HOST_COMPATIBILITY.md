# Host compatibility

The claim this round had to establish: **can Active mode persist and recover on
the DSH host that actually runs this machine?** It was answered by probing the
installed packages, not by reading a version table.

## The two DSH lines in this repository

| Role | Version | Where |
|---|---|---|
| **Real host** | `@deepseek-ai/dsh` **0.2.1-rc.3** | global install: `%APPDATA%/npm/node_modules/@deepseek-ai/dsh` |
| **Test runtime (vendored)** | **0.1.7-rc.2** | `vendor/deepseek-harness` (git checkout, junctioned into the integration worktree) |
| **Test host packages** | **0.2.1-rc.3** | `node_modules`, pinned as devDependencies |

`vitest.config.ts` aliases every `@deepseek-ai/*` import to the vendored 0.1.7
sources. That is a pre-existing main-line choice, and it means the ordinary test
suite exercises the OLD host. The real host's API is therefore tested separately
by `tests/semantic-host-0.2.spec.ts`, which uses `createRequire` to bypass the
alias and load the installed 0.2.1 package.

## Measured capability (real 0.2.1-rc.3)

```
appendPluginRecord        function
pluginRecordOf            function
append(... {ignorable})   returns an event WITHOUT the marker
plugin record write       {type:"plugin:epistemic-fold/semantic", ignorable:true, ...}
validateStoredEvents      retains that record (no throw)
SESSION_FORMAT_VERSION    4
```

Consequences, all measured:

1. **Route A exists.** `appendPluginRecord` is the sanctioned writer; it sets
   `ignorable`, and the persistence read path retains the record. This is the
   durable transport for `ef/anchor` (as `plugin:epistemic-fold/anchor`),
   `ef/retire` (as `plugin:epistemic-fold/retire`), and semantic packets
   (`plugin:epistemic-fold/semantic`).
2. **The old probe was right to refuse.** `Session.append` still builds the
   envelope itself and drops an `ignorable` option on this build. A raw
   `ef/anchor` append would produce a log the read path refuses. The anchor
   service's fail-closed guard was correct; the capability it probed was simply
   not the one that became available.
3. **Active mode is no longer structurally blocked.** On 0.2.1 it uses session
   records; on 0.1.7 (no record writer) it uses the journal. The engine refuses
   to mount active with neither.

## Version floors

- Peer range remains `>=0.2.0-rc.2` (main's existing floor). The code compiles
  against 0.2.1-rc.3's types but feature-detects at runtime.
- `appendPluginRecord` first appears in **0.2.1-rc.1**. On 0.2.0 hosts the
  transport reports `none` and active falls back to the journal.
- `npm` resolves `>=0.2.0-rc.2` to exactly 0.2.0-rc.2 (prerelease ranges are
  tuple-scoped), which is why the test tree pins 0.2.1-rc.3 in devDependencies.

## What was NOT verified

| Claim | Status | Why |
|---|---|---|
| A full process restart (write JSONL → close → reopen) on the **real** host retains a semantic record | **not executed** | The JSONL backend needs the host's own cordis services; mixing them with the vendored test runtime is unsound. The record is accepted by the host's own `validateStoredEvents`, which is the read gate at all restore sites. |
| Fork / resume carries plugin records | **not executed here** | The host API documents it; this round did not construct a forked session on 0.2.1. |
| Concurrent multi-process journal writes | **not executed** | Atomic rename prevents torn files; there is no cross-process lock. |
| Windows permission bits on the journal | **implemented, not audited** | `writeFileAtomic(..., {mode:0o600, dirMode:0o700})`; Windows applies them partially. |

The one thing that IS verified end-to-end is the vendored 0.1.7 journal path:
stage → commit → activate → restart with a fresh Context → replay
(`semantic-continuity.spec.ts`, "replays activated packets after a restart").

## How to close the remaining gap

On a real 0.2.1 workspace with the JSONL backend mounted:

```bash
# 1. Write a session with one semantic record, flush, close the process.
# 2. Reopen, validate the log, project the state, fold again.
npx vitest run tests/persistence-compat.spec.ts   # portable + backend tiers
```

The repository's existing `persistence-compat` suite already drives the real
JSONL backend for native events and the ignorable-marker shape. Extending it to
a full engine restart on 0.2.1 is the next concrete task; it is not claimed here.
