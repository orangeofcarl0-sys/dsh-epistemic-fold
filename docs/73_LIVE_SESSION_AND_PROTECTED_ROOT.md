# 73 — A live session in the LHTB bridge, and the closed protected-root loop

Status: keyless verified (real bridge, real SessionStore). 2026-10-14. Parent `15188ed`.

## 1. The blocker, and the one-line cause

The bridge created its session with `Session.create(id)`. DSH distinguishes that from
`ctx.sessions.create(id)` (`node_modules/@deepseek-ai/dsh-session/lib/index.js`, runtime
`0.2.0-rc.2`; the vendored tree is the same version):

* `Session.create` — DETACHED. It appends and derives messages, but the store has never seen it.
* `ctx.sessions.create` = `prepare` + `enter` + `announce` (1653-1659) — STORE-MANAGED and live.
* `ctx.sessions.flush(session)` (1832-1849) calls `liveEntryFor` first, which THROWS
  `session "..." is not live in this store` (1853) for anything detached or merely prepared.

The automatic leaf path never calls `flush`, so a detached session was invisible to it. The
MANUAL path does: `compactNow` passes a durability barrier. That is why leaves folded through the
bridge for many rounds while a protected ROOT could never commit.

The fix is `session = ctx.sessions.create(SessionId(...))`. The session id, the per-episode
uniqueness and the append site are unchanged, so nothing downstream rekeys.

## 2. flush has three outcomes, and only one of them is an error

| session | listeners | result |
|---|---|---|
| detached / prepared | - | **throws** `not live in this store` |
| live | none | resolves **`false`** — not an error |
| live | one or more | **`true`**, or rethrows the first failure |

Measured, not assumed. The bridge uses case 2: the real `SessionStore` is mounted and no
persistence plugin is, so the manual root fold's barrier resolves `false` and the fold commits.

**`storeManaged = true`, `sessionLogDurability = not_verified`.** A resolving `flush` means the
barrier passed, NOT that a session log reached disk -- this harness writes none. The Bundle
FileStore is a SEPARATE persistence: EF's bundles are written under `EF_TAU2_BUNDLE_ROOT` and are
durable; the DSH session log is not. No listener was added to make `flush` return `true`.

Case 3 is not constructible here: the event is dispatched through the session carrier's scope, and
a participating listener belongs to a persistence plugin this harness does not mount. Recorded
rather than faked.

### 2.1 The two fixtures differ, and that hid the bug for a round

`tests/harness.ts:247-249` REPLACES `ctx.sessions.flush` with a spy that records the call and
returns `true`, with the comment "detached test sessions are not store-live". So the vitest
harness's manual root folds always passed while the bridge's could not. Anything about the manual
path that depends on session liveness must be checked through the BRIDGE.

## 3. Commit-then-flush: a failure there is AMBIGUOUS

`compactSurfaceRegion` (`src/basic/region.ts`) commits the surface first and runs the barrier
after: the body is committed at 247, `closed = true` at 250, `await options.flush()` at 267, and a
barrier failure is reported as `ManualCompactionError('persistence')` around 280.

So a flush failure leaves a fold that **HAPPENED**, with the caller-side bookkeeping absent:
`recordCommit`, the bundle, and the fold counter are only reached when the transaction RETURNS.
Reporting that as "the root did not run" would be false, and retrying it without re-reading the
surface would fold again. The distinction is recorded here; the ordering itself is the vendored
transaction's and this round does not change it.

## 4. The keyless long chain, through the real bridge

`tests/task-root-bridge.spec.ts` drives the real `bridge-host.ts` over its JSON-line protocol (real
plugin, real `SessionStore`, local fake provider):

```
init -> append_task_root(resident, digestVerified, seq) -> Leaf -> Leaf
     -> idle -> PROTECTED ROOT -> Leaf -> step (assembled request)
```

Asserted: the root's `sourceSeq` never changes and is the instruction's own event; the declared seq
equals the first appended seq; two leaves and the root all commit; `foldLineage` contains EXACTLY
one `root` and zero `emergency` entries; NONE of their shadowed seqs contain the root seq; the root
stays `resident` at surface position 0; a leaf AFTER the root still commits (which is the practical
proof the frontier is legal, since `compactRegion` refuses a leaf before `firstOpenPosition`); and
the assembled model request contains the task text EXACTLY once.

## 5. A lineage gap this closed

`rootCompact` called `compactNow` directly, bypassing `foldIfNeeded`, so a committed root moved
`rootFoldCount` while `foldLineage` recorded NOTHING -- exposure could not see a root, and a reader
checking the commit lineage would conclude no root had happened. The lineage push is now one
function (`recordFoldLineage`) that both paths call, and the mechanism is derived from the
engine's own counter deltas rather than the caller's intent.

## 6. Live run: the root committed, the model calls did not

Provider health preflight first: 2/2 HTTP 200 in ~1.7s with real content. So a controlled
post-fold continuation smoke was run through the same bridge against the real route
(`deepseek-v4.1-flash`, window 16384, one episode, no ranking):

```
taskRoot@append      {mode: exact, status: resident, sourceSeq: 2, digestVerified: true, surfacePosition: 0}
PRE-FOLD reply       ""            providerFailures: 1
leaf committed       0             folds: 0
taskRoot@afterLeaf   resident (same seq, digestVerified)
POST-FOLD reply      ""            providerFailures: 2
ROOT committed       1             refusal: none
ROOT lineage         ["leaf", "root"]
ROOT shadowed rootSeq: false
taskRoot@afterRoot   resident (same seq, digestVerified)
POST-ROOT reply      ""            providerFailures: 3
```

**What the live run establishes:** the protected ROOT transaction COMMITS against the real route --
`committed: 1`, no refusal, its lineage entry recorded, its span excluding the task root, and the
task root still resident and digest-verified afterwards. That is a transactional fact.

**What it does NOT establish:** any post-fold continuation. All three model calls returned an empty
reply and were counted as provider failures, so no turn completed and the forced leaf never
committed. Per the round's instructions this is reported rather than retried until it looks good.

**Live status: OPEN — PROVIDER BLOCKED.** The keyless root is verified; the live continuation is
not, and the two are not merged into "live root verified".