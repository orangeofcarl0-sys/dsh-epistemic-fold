# 70 — Active Task Root residency: what is implemented, and what is blocked

Status: measured and partly implemented, 2026-10-13. Parent commit `fedf47d`.

## 1. The problem, restated from the measurement

A real LHTB cell folded its own task instruction away in the FIRST leaf fold. The instruction
was a user message at surface seq 2, and `shadowedSeqs` began `[2, 6, 10, 11, 17, ...]`. The
content was archived verbatim at message index 0 of the checkpoint, and the model was told that
exact history was recoverable -- but the only copy was then behind a tool call. The model made
that call twice and recovered zero characters (docs/69).

`fedf47d` fixed the retrieval interface. That makes the loss REPAIRABLE; it does not make it
UNDONE. The one node whose loss cannot be repaired by reasoning about the rest of the
conversation has to stay where the model can see it.

## 2. Feasibility: where a fold's span comes from

There are four places a span or range is chosen, and EF owns only two of them.

| fold kind | selector | call site | EF controls it? |
|---|---|---|---|
| leaf (pressure) | `selectLeafSpan` (EF) | `src/engine.ts:898` | **yes** |
| leaf (overflow) | `selectLeafSpan` (EF) | `src/engine.ts:1097` | **yes** |
| emergency rebase | `selectCompactableRange` (Basic), called from **EF's own code** | `src/engine.ts:1160` | **yes, at the call site** |
| root (`compactNow`) | `selectCompactableRange` (Basic), inside Basic | `src/basic/index.js:306` | **no** |

### 2.1 Root is the blocker, and the reason is one line of composition

`BasicCompactionEngine.compactNow` (vendored, `lib/types/index.js:299-330`):

    const range = selectCompactableRange(agent.session, this.ctx.tokenMeter.measure(agent.session), 0);
    if (range === null) return null;
    return await compactSurfaceRegion(this.regionDependencies(), agent.session, range.start, range.end, ...);

It selects its own range and calls **`compactSurfaceRegion` directly, not `this.compactRegion`**.
EF's `compactRegion` override is therefore never entered, so neither the `leaf_before_frontier`
guard nor any exclusion EF adds can see a root fold. The source comment already said as much
(`src/engine.ts:13-16`: "the inherited manual path never routes through `compactRegion`").

`selectCompactableRange` itself (`src/basic/region.ts:143`) starts at
`systemHead(session, surfaceNodes[0]) === undefined ? 0 : 1` -- it skips a `system` message at
node 0 and nothing else. A registered root is a `user` message and is always inside the range.

**Closing that gap requires changing vendored Basic** (either its selector or `compactNow`'s
composition), which this round forbids and the vendoring policy pins. That is the blocker.

### 2.2 What the frontier does and does not forbid

`frozenPrefixContiguous` (`src/frontier.ts:96-102`) checks only that the EF checkpoints are
adjacent to each other and end at `firstOpenPosition - 1`:

    checkpoint.position === firstOpenPosition - frozen.length + index

It does not inspect what sits BEFORE the first checkpoint. So a raw node resident there leaves
the invariant true -- and `frozenPrefixContiguous` is recomputed from the surface every plan, so
a resident node cannot desynchronise it. The doc comment's "none before the first one (system
head excepted)" is the contract this round widens to "system head and the resident active task
root excepted", which is exactly what the system head already does at position 0.

## 3. What is implemented

A host declares a root; EF then keeps that node out of every span it selects.

    registerActiveTaskRoot({ sessionId, sourceSeq, sourceDigest, generation })

* **`src/task-root.ts`** — `ActiveTaskRootRef`, `ActiveTaskRootRegistry`, `taskRootDigest`,
  `resolveActiveTaskRoot`, `protectedTaskRootPosition`.
* **`src/leaf-policy.ts`** — `selectLeafSpan` takes `protectedPositions` and raises `firstIdx`
  past them, exactly as it already raises it past the system head at position 0.
* **`src/engine.ts`** — the registry, `registerActiveTaskRoot`, `clearActiveTaskRoot`,
  `taskRootStatus`, `protectedPositions`, and `avoidTaskRoot`, which re-anchors the one
  Basic-selected range EF is allowed to adjust (the emergency rebase).

### 3.1 The content is the ORIGINAL event, so there is no copy and no summary

The resident node IS the user's own message node. Nothing is appended, re-stated, or generated,
so: authority stays the user's (never promoted to a system instruction), `TokenMeter` prices it
because it is an ordinary surface node, and repeated folds cannot accumulate copies because no
copy is ever made.

### 3.2 Explicit only

Nothing inspects a conversation for an objective. A session with no `register` call behaves
exactly as before, and `protectedPositions` returns empty. Re-registering the same source is
`unchanged` -- a host that re-announces its objective every turn must not inflate `generation`,
or every turn would read as a new task. A DIFFERENT source is `replaced` and the old root stops
being current. Nothing infers a replacement from prose.

### 3.3 Failure is reported, not absorbed

`resolveActiveTaskRoot` verifies the source is on the surface, derives a `user` message, and
matches `taskRootDigest(message)`. A mismatch is `absent` with an explicit reason
(`source-not-on-surface` / `digest-mismatch` / `not-a-user-message` / `no-message`), and
`taskRootStatus` distinguishes `unregistered` from `absent` -- a session with no task root and a
session whose task root was LOST must not read the same in a report.

## 4. What is NOT implemented, and the minimal design that would

**Root folds still take the root.** A test PINS this (`tests/task-root-residency.spec.ts`,
"PINNED: a ROOT fold still takes the root"), so the gap cannot be forgotten and a future fix
will fail that test rather than pass silently.

The minimal viable design, if the Basic change is ever permitted: pass the protected positions
into Basic's range selection, or have `compactNow` route through `this.compactRegion` so EF's
existing guard applies. **Not attempted here**, because either changes the vendored engine's
transaction composition, and the round's instructions are explicit that stopping is the correct
outcome in that case.

A weaker EF-only alternative exists and was REJECTED rather than implemented: re-append a
verbatim copy after a root fold. It needs a model-visible user message that the user did not
send, which either fabricates a user turn in the durable log or requires a new session event
type and source kind in DSH core. It also re-copies once per root fold, which the requirement
rules out. Recording it here is the point: it is not a locator, and it is not implemented as one.

## 5. Cost

Measured from the fixture (a ~5.9K-character instruction, the same order as the real 5,741):

| | tokens | note |
|---|---|---|
| retained verbatim | **> 1,000** (~1.9K at the real 5,741 chars) | paid on EVERY request, for the life of the session |
| the checkpoint marker it replaces | ~40 characters | what the model has without this |
| a bounded locator (rejected) | ~200 | cheaper, but only tells the model where to look |

The cost is real and is not hidden: the test asserts the root is a priced surface node with a
non-zero, non-trivial cost, so a caller weighs it knowingly.

## 6. Verdict

**`BLOCKED BY HOST / FRONTIER CONTRACT.`**

Exact residency of the ORIGINAL user event is implemented and verified for LEAF and EMERGENCY
folds, which is the fold kind that caused the measured failure. It is NOT implementable for ROOT
folds without modifying vendored Basic, so the full guarantee the round asked for is not met, and
this document does not claim otherwise.
