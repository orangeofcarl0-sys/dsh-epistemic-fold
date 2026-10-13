# 71 — Protected root transaction: the blocker was an analysis error

Status: implemented and verified (keyless), 2026-10-14. Parent `d994f2c`.

## 1. Correcting docs/70

docs/70 concluded `BLOCKED BY HOST / FRONTIER CONTRACT`, on the finding that
`BasicCompactionEngine.compactNow` selects its own range and calls `compactSurfaceRegion`
directly, so EF has no interception point. **The finding was right and the conclusion was
wrong.**

`compactSurfaceRegion` is **exported** from `src/basic/region.ts`, and its four dependencies are
all reachable from the subclass. EF can therefore supply the span itself and still run Basic's own
transaction. Nothing in `src/basic/` is modified by this round.

The earlier analysis stopped at "EF cannot intercept `compactNow`'s composition" without asking
whether the transaction underneath it was reachable. It was.

## 2. The design

`compactNow` now branches on the registration, once:

| state | path |
|---|---|
| `mode: basic` | `super.compactNow(...)` — unchanged |
| no registered root | the pre-existing root path — unchanged, byte for byte |
| registered, resident, prefix | **protected root fold** |
| registered, non-prefix | declined, `unsupported-nonprefix` |
| registered, absent (digest mismatch, off-surface, non-user) | declined, with the reason |

### 2.1 The protected fold

`protectedRootFold` mirrors Basic's `compactNow` structure and substitutes only the span:

* the real `agent.runMaintenance` idle bracket, with Basic's error mapping — an abort the agent
  itself requested is `cancelled`, anything else is `busy`;
* a FRESH `tokenMeter.measure`;
* `selectCompactableRange(session, measurement, 0)` then `avoidTaskRoot`, so the span starts after
  the task root and at a tool-pair balanced boundary;
* `createFoldCandidate({ mode: 'root', start, end })` — **explicit** start/end;
* `compactSurfaceRegion(deps, session, start, end, agent, { owner: null, stability:
  'selected-span', flush, sourceCommandId }, signal)`. Not a copy of the transaction: the region
  validation, the compaction lock, the `compaction/start`+`compaction/end` pair, the shrink check,
  the flush-failure path and cancellation precedence are Basic's.

`regionDependencies()` is private, so `rootRegionDependencies()` names the same four members
explicitly. Two of them are EF's OWN overrides — `summarize` and `frameCheckpoint` — so the
protected path keeps EF's summarization and EF's checkpoint framing rather than bypassing them.

### 2.2 Provenance, which was the P0

`currentSpanSeqs` has two branches: an explicit candidate span, and a fallback that assumes the
folded span is a PREFIX of the surface. A protected root is deliberately not a prefix — the task
root precedes it and was not folded — so the implicit branch would have produced a seq list that
does not identify the archive.

Passing explicit `start`/`end` selects the first branch, which slices the surface between them and
**throws when the span derives a different number of messages than the archive holds**. The test
asserts `bundle.source.orderedSurfaceSeqs` does not contain the root seq, that the archived
messages do not contain the instruction, and that exact recall returns exactly the archived
count.

### 2.3 One span rule for deciders and executors

`admitLeafEconomically` and `assessFoldReachability` each selected their own `selectLeafSpan`. Left
alone they would price a span containing the task root while the executor excluded it — a decision
made on one span and executed on another. Both now take `protectedPositions` and the engine passes
the same value it passes to the executors.

## 3. Lifecycle: session-lifetime, and NOT a cross-restart guarantee

The registry is in engine memory. After a restart it is empty, so the guard returns `none`, the
ordinary root path runs, and **a root fold would take the instruction silently** — nothing was
declared, so nothing is refused.

A host CAN re-register: the engine owns `ctx.compaction`, and `registerActiveTaskRoot` is public,
so a host that knows its instruction at episode setup can call it on resume. What does not exist
is persistence or automatic re-registration, and this round deliberately did not build either.

So the capability is **session-lifetime experimental**. The guarantee holds for as long as the
registration lives and for every fold EF selects. It is NOT a claim about a resumed session.

## 4. Verdict

**`PROTECTED ROOT IMPLEMENTED — LIFECYCLE LIMITED.`**

Leaf, emergency and root folds are all covered, and the root fold is a real commit through Basic's
own transaction with correct provenance. What is limited is the LIFETIME of the registration, not
the mechanism.
