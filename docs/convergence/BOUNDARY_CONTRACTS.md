# EF-C0 — Boundary Contracts

Status: certified 2026-11-08 by `tests/convergence-boundaries.spec.ts` (8/8).

A contract is a statement a future change must not break. Each one names the
mechanism that enforces it and the test that would fail.

## Summary

| ID | Contract | Enforced by | Test |
|---|---|---|---|
| C1 | Core works with semantic off | the fold transaction does not read semantic state | C1 |
| C2 | A semantic failure cannot corrupt the fold transaction | acquisition is caught; publish is outside every catch | C2 |
| C3 | Semantic state cannot rewrite canonical history | state is a replay over the log, never a log rewrite | C3 |
| C4 | Selection cannot mutate authoritative state | selector is a pure function over a readonly state | C4 |
| C5 | Feature off means no hidden semantic effect | null journal; no writer path | C5 |
| C6 | Basic mode mounts no EF surface | plugin early return | C6 |
| C7 | Archive stays recoverable after a semantic refusal | bundle write precedes/independent of semantic validation | C7 |

## C1 — Core works with semantic off

**Statement.** A fold with `semanticMode: none` and `semanticContinuity: off`
publishes a bundle and a non-empty checkpoint body.

**Mechanism.** With no projection-mounted semantic state, the engine takes the
deterministic rendering path. The semantic branch is not entered.

**Test.** A real fold through `compactRegion`; asserts `publishedBundle` is
defined, the rendered text is non-empty, and diagnostics report
`archive-only` / `off`.

**What it does not prove.** That the checkpoint is *good*; only that the core
transaction completes without the semantic layer.

## C2 — A semantic failure cannot corrupt the fold transaction

**Statement.** A writer call that fails leaves the bundle and the deterministic
checkpoint intact.

**Mechanism.** `semanticWriterCall` catches the error and returns `undefined`.
The fold then compiles a state-only body. The bundle write is outside that
catch, so an archive failure still aborts the transaction, while a semantic
failure does not.

**Test.** The scripted adapter fails the compaction call with a provider error.
Asserts the bundle exists, `semanticWriterStats.failures === 1`, no packet was
staged, and the body still carries the EF marker.

**What it does not prove.** That a *partially* written journal cannot corrupt a
later fold. That is R31/R32's recovery surface, not this contract.

## C3 — Semantic state cannot rewrite canonical history

**Statement.** A semantic claim that contradicts a user message leaves the raw
event byte-identical.

**Mechanism.** The semantic layer records claims in a journal and reconstructs
state by replaying committed packets over the session. It never appends,
edits or reorders a user/assistant event.

**Test.** The user says "The timeout is 60 seconds." The writer claims "The
timeout is 30 seconds." quoting the user text. After activation:

```text
packet.accepted[0].statement   "The timeout is 30 seconds."
receipt.outcome                committed
raw event text                 still "The timeout is 60 seconds."
```

**What it does not prove.** That a future *projection* bug cannot display the
claim as if it were history. The test covers the storage/authority boundary,
not every renderer.

## C4 — Selection cannot mutate authoritative state

**Statement.** Running the task-aware selector leaves the input state
byte-identical, and the selected/omitted sets partition the eligible anchors.

**Mechanism.** `selectTaskAwareContext` takes a `FoldCurrentState` and a task
frame and returns a new `ContextSelection`. It has no store, no journal and no
session handle. The structural test also asserts the source contains no
`writeFile`, `journal.write` or `.retire(` call.

**Test.** Snapshot `JSON.stringify(state)`, run the selector, assert equality.
Assert `selected ∪ omitted` equals all anchors and the sets are disjoint.

**What it does not prove.** That a future *caller* cannot write the selection
back into state. The selector itself is read-only by construction; the caller's
behavior is a separate review.

## C5 — Feature off means no hidden semantic effect

**Statement.** With continuity `off`, a fold creates no semantic journal
directory, no packet and no receipt.

**Mechanism.** The engine constructs a `NullSemanticJournal` when continuity is
`off`, and no writer path is entered.

**Test.** Fold once; assert the `semantic` directory does not exist and
`lastSemanticPacket` / `lastSemanticReceipt` are undefined.

**What it does not prove.** That no *other* feature is silently on. The
configuration matrix covers the auxiliary-call count separately.

## C6 — Basic mode mounts no EF surface

**Statement.** Under `mode: basic`, the plugin provides no anchor service, no
recall tools, no status projection and publishes no EF bundle.

**Mechanism.** `EpistemicFoldPlugin` returns immediately after constructing the
engine when `engine.basicMode` is true. The engine still owns
`ctx.compaction`; that is how it delegates.

**Test.** Mount the real plugin with tools and a projection; assert
`ctx.epistemicFold` is undefined, `plugin.anchors` is undefined, the tool list
contains no `context_search` / `context_recall`, and `publishedBundle` is
undefined after a fold.

**What it does not prove.** That a *host* cannot register an EF surface itself.
The plugin's own registrations are what the test controls.

## C7 — Archive stays recoverable after a semantic refusal

**Statement.** When the validator refuses every proposed delta, the folded span
is still recoverable exactly.

**Mechanism.** The bundle is built from the folded messages and written by the
publish path. Semantic validation happens before the write and affects only
whether a packet is staged; it does not remove the archive.

**Test.** The writer proposes a delta citing a phrase that does not exist. The
validator refuses it (`refused.length > 0`). `recall(..., depth: 'exact')`
returns the archived messages with `unavailable` absent and
`page.totalMessages === bundle.archive.messageCount`.

**What it does not prove.** That an *authority* refusal (a claim accepted but a
retirement refused) also preserves recall. The mechanism is the same, but this
test exercises the validation refusal. R38's relation-authority tests cover the
authority half.

## Adjacent contracts (already covered elsewhere)

| Contract | Where |
|---|---|
| Bundle durable before surface loss | transaction tests, `tests/ef-*` |
| Fold frontier monotonicity | `tests/frontier*` |
| Exact recall fidelity | `tests/recall*` |
| Replay correctness | `tests/semantic-replay-order.spec.ts` |
| Root/leaf legality | `tests/r2*` |
| Tool pairing | `tests/*pairing*` |
| Fallback | `tests/*fallback*` |
| Checkpoint source integrity | `tests/semantic-commit-proof.spec.ts` |

## Uncertified edges

These are not claims; they are gaps a future round should know about.

1. **C3 at the renderer.** A projection bug could display a semantic claim in a
   section a reader treats as raw history. The authority boundary is tested; the
   presentation boundary is not.
2. **C7 under an authority refusal.** Same mechanism, different refusal path;
   tested separately in R38, not in this file.
3. **Semantic failure during a ROOT fold.** The boundary tests use a leaf fold.
   The root path has its own transaction and is covered by R32 recovery tests.
4. **A crash between packet staging and bundle write.** The packet is staged
   first; a crash leaves a staged packet with no committed body. R31/R32's
   recovery tests cover abandonment, but this file does not.
