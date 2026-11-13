# EF-C0 — Architecture Baseline

Status: current implementation, verified 2026-11-08.

This document describes the code that exists, not the code that should exist.
Line counts are from the R38 baseline.

## 1. Entry points

```text
src/entry.ts        package entry
src/index.ts        library surface
src/plugin.ts       DSH plugin composition root
src/fold/engine.ts  the compaction engine (extends the vendored Basic engine)
```

`EpistemicFoldPlugin` is a composition root and nothing else. Its constructor:

```text
describeEffectiveConfig(config)          // report before constructing
new EpistemicFoldEngine(ctx, config)     // owns ctx.compaction
if (engine.basicMode) return             // NO EF surface under basic
registerAnchorSurface(ctx)               // ctx.epistemicFold
registerStateProjectionSurface(ctx)      // deterministic state
registerStatusSurface(ctx, ...)          // Sidebar / status
registerRecallSurface(ctx, ...)          // context_search / context_recall
registerCommandSurface(ctx, ...)         // /context
registerIdleRebaseSurface(ctx, ...)      // idle maintenance
registerFramingSurface(ctx, ...)         // system-dedup section
```

The `basic` early return is the single point that decides whether EF has a
surface at all. It is a mount-time fact, not a policy knob.

## 2. The fold transaction (Core)

```text
compactIfNeeded / compactRegion / compactNow
        │
        ├─ isBasic() ? delegate to super (Basic) and return
        │
        ▼
locateFoldFrontier            frozen prefix must be contiguous
        │
        ▼
createFoldCandidate           legal span, leaf or root
        │
        ▼
super.compactRegion           Basic's transaction
        │
        ├─ summarize(...)     EF override: checkpoint body
        ├─ frameCheckpoint    EF override: framing mode
        │
        ▼
verify shadowed span == candidate span
        │
        ▼
recordCommit                  provenance / telemetry
```

Inside `summarize` (EF's override), the archive path is:

```text
retire derived retrieval answers (tombstones, not dropped messages)
        │
        ▼
orderedSurfaceSeqs             archive's own span identity
        │
        ▼
buildBundle                    rendered text + shadowed messages + digests
        │
        ▼
[optional semantic staging]    packet written BEFORE the bundle
        │
        ▼
bundles.write(bundle)          durable archive
        │
        ▼
return summary to Basic        Basic replaces the surface
```

The ordering is load-bearing: the bundle is written before the lossy surface
replacement commits. A bundle write failure aborts the transaction; a semantic
failure does not.

## 3. Semantic acquisition (Optional)

The branch is entered only when a state projection is mounted AND continuity is
not `off`. It has four shapes:

```text
continuity active   → reconcile → semanticAdmissionOf → ONE combined writer
                      → validate → plan → candidate state → compile → stage
continuity shadow   → visible rationale call → separate diagnostic writer
                      → packet with no ops
continuity off      → visible rationale call (if semanticMode rationale)
                      → no packet
no projection       → Basic's full-checkpoint summary (regardless of mode)
```

The semantic state is reconstructed by replaying committed packets over the
session (`replayWithSemanticCommits`), not by mutating the session.

## 4. Call graph (production)

```text
EpistemicFoldPlugin
 ├─ EpistemicFoldEngine ──extends── BasicCompactionEngine (vendored src/basic)
 │    ├─ FoldBundleStore          src/checkpoint/bundle-store.ts
 │    ├─ SemanticJournal          src/semantic/journal.ts   (off → Null)
 │    ├─ replay / proof / plan    src/semantic/*
 │    └─ ctx.on('session/event')   activation feed (active only)
 ├─ AnchorService                 src/state/anchor-service.ts
 ├─ state projection              src/state/projection.ts
 ├─ status projection             src/status/status-projection.ts
 ├─ recall tools                  src/recall/tools.ts
 ├─ /context command              src/status/command.ts
 ├─ idle rebase consumer          src/fold/idle-rebase.ts
 └─ framing section               src/checkpoint/framing.ts
```

## 5. Core vs optional, by module

| Module | Lines | Track | Loaded when |
|---|---:|---|---|
| `src/fold/engine.ts` | 3,716 | Core + optional branches | always |
| `src/fold/frontier.ts` | 124 | Core | always |
| `src/fold/candidate.ts` | 65 | Core | always |
| `src/fold/leaf-policy.ts` | 105 | Core | always |
| `src/checkpoint/bundle-store.ts` | 235 | Core | always |
| `src/checkpoint/compiler.ts` | 198 | Core | always |
| `src/checkpoint/renderer.ts` | 332 | Core | always |
| `src/recall/recall.ts` | 1,039 | Core | always (tools mounted on demand) |
| `src/recall/tools.ts` | 337 | Core | when `ctx.tools` exists |
| `src/state/state.ts` | 409 | Core | always |
| `src/state/projection.ts` | 132 | Core | non-basic |
| `src/semantic/*` | 4,859 | Optional | continuity != off (journal), writer paths only on a fold |
| `src/state/thermal.ts` | 414 | Research | **no production import** |

`src/semantic/*` is optional as a layer, but its modules are statically
imported by the engine. "Optional" here means *not executed*, not *not
loaded*. That is a bundle-size distinction, not a correctness one.

## 6. Coupling assessment

The engine is one class with four extension points. The boundary is enforced by
early returns, not by separate classes:

```text
compactRegion      isBasic() → super
compactIfNeeded    isBasic() → super
compactNow         isBasic() → super
summarize          isBasic() → Basic summary
frameCheckpoint    isBasic() → Basic framing
```

This is enough to test the boundary deterministically, and the tests do:

- `mode: basic` produces Basic's checkpoint and no EF surface;
- `semanticContinuity: off` produces no semantic call and no journal;
- a writer failure leaves the bundle intact;
- a refused delta leaves exact recall working.

### Technical debt, recorded not fixed

1. **`engine.ts` is 3,716 lines.** The fold transaction, semantic acquisition,
   replay, migration, fork inheritance, and telemetry all live in one class.
   The semantic branch is ~1,000 lines of the file.
2. **Semantic code is interleaved with the transaction.** The acquisition block
   sits inside `summarize`, between the archive build and the publish closure.
   It is guarded, but it is not a separate module boundary.
3. **A full split is not justified yet.** The brief's rule applies: extract
   only when the existing interface cannot maintain test isolation. The tests
   above show it can. A split would move ~1,000 lines and create a new
   transaction seam without a failing test to drive it.
4. **The thermal observer is research code in `src/`.** It has no production
   import; only `tests/thermal-residency.spec.ts` uses it. It should move to
   `eval/` or be wired, and that is a separate decision.

## 7. What has no production registration path

```text
src/state/thermal.ts                 no import outside its test
eval/r38/src/task-aware-selector.ts  eval only
eval/r38/src/archive-recovery.ts     eval only
eval/r38/src/integrity-auditor.ts    eval only
eval/r38/src/recent-tail.ts          eval only
eval/r38/src/context-overlay.ts      eval only (native smoke)
eval/memory/*                        eval only
eval/tau2/*                          eval only
```

A module existing under `src/` is not evidence that it ships. The matrix in
`FEATURE_AND_SCOPE_MATRIX.md` records this per capability.

## 8. Evidence

```text
tests/convergence-boundaries.spec.ts    8/8
tests/convergence-config.spec.ts       13/13
tests/rc7-basic-mode.spec.ts            (existing Basic parity)
tests/semantic-continuity.spec.ts       (existing semantic transaction)
```

The boundary tests drive the real transaction with a scripted adapter. The
scripted adapter owns only the model's text; validation, planning, journal,
commit and replay run for real.
