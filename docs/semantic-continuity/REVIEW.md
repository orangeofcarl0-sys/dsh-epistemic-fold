# Semantic Continuity v1 — code review

Audit of the semantic layer as integrated into the restructured main line
(`origin/main` @ `93b6666`, branch `rc30-semantic-continuity`). Every finding
below was reproduced before it was fixed; the "pinned by" column names the test
that fails if the defect returns.

## Method

1. The prototype (`rc29-working-set-observer` worktree) was treated as an
   untrusted claim. Its source was re-read, then ported; the port is where the
   defects below were found.
2. Each defect was reproduced with a failing test or a host probe before the
   fix. No test expectation was changed to make a defect pass.
3. The real host (`@deepseek-ai/dsh` 0.2.1-rc.3) was probed directly for the
   persistence capability rather than inferred from a version number.

## Findings

| # | Severity | File / function | Original behavior | Fix | Pinned by |
|---|---|---|---|---|---|
| R1 | Blocker | `state/state.ts` `transitionFailure` | Advanced `openFailures` only; `stateHeads` kept the old `failureState`, so two views of one anchor disagreed | Advance the head too, only when it is the same anchor id | `p0-regressions` "open -> investigating -> resolved" |
| R2 | High | `state/state.ts` `indexAnchor`, `removeFace` | An objective with a `stateKey` never entered `stateHeads`; superseding one left the old objective in `state.objective` and the renderer emitted stale state | Index the objective's coordinate; clear the objective slot when that anchor is removed | `p0-regressions` objective case + `semantic-core` plan cases |
| R3 | Blocker | `state/authority.ts`, `state/anchor-service.ts` `citedKinds` | Authorized by `event.type` alone; a plugin-injected `user/message` (workspace context, checkpoint, notice) counted as the human user | `authoritativeKindOf(type, source.kind)`: role and producer must agree; refusals name the producer | `p0-regressions` plugin-injected user / tool-output cases |
| R4 | High | `semantic/validate.ts` `verifyClaim` | `verified` was granted whenever every cited event was a `tool/result`; `npm run lint: PASS` could verify "all concurrency bugs are fixed" | `verificationQuote` required, must resolve inside a cited tool result, and a generalization token in the statement must appear in the quote | `semantic-core` "narrower than the claim" |
| R5 | High | `fold/engine.ts` shadow branch | Shadow reused the rationale call with a different instruction, so the VISIBLE checkpoint differed from `off` | Shadow keeps the original rationale call; a separate, recorded diagnostic writer call produces the measurement; packet `ops: []` | `semantic-continuity` shadow byte-equality |
| R6 | Blocker | prototype `semantic/reconcile.ts` | Supersession re-resolved against the bounded current state; after two revisions the middle value vanished, so a third packet revived the FIRST value | Resolution happens once, against the full projected state, and the resolved declare/retire plan is stored in the packet; replay is mechanical | `semantic-continuity` "keeps the second value"; `semantic-core` plan cases |
| R7 | Blocker | prototype engine transaction | Semantic anchors were appended inside `summarize()`, i.e. before Basic's shrink/stability checks and surface replacement; a rejected fold still changed state | Packet is `staged`; activation requires the exact committed body digest AND its replacement message on the surface | `semantic-continuity` "shrink check" case |
| R8 | Blocker | `state/anchor-service.ts`, semantic sink | On the real 0.2.1 host, `Session.append` drops the `ignorable` option; every durable `ef/anchor` write was guaranteed to fail (or poison the log), so active mode could never persist | Use the sanctioned `appendPluginRecord` when present; otherwise the journal is the authority; no null-journal active mode | `semantic-host-0.2` 5 host cases; `semantic-continuity` restart |
| R9 | High | `checkpoint/residency.ts` `retireCheckpoint` | `ef/retire` was also a guaranteed-failing write on 0.2.1 (Phase Exit) | Same transport; raw `ef/retire` only on the explicitly in-memory face | `checkpoint-residency` (existing) + transport tests |
| R10 | Medium | `checkpoint/renderer.ts` `anchorLine` / `failureLine` | A value containing a newline could forge additional state lines, including the `(authority)` shape | Collapse whitespace before interpolation (`oneLine`) | `semantic-core` newline-collapse |
| R11 | Medium | `checkpoint/renderer.ts` `renderStructuredCheckpoint` | Hardcoded `mode: 'leaf'` for every structured body, including root/emergency | Accept the fold's real `FoldMode`; the engine passes `candidate.mode` | `m2-frontier` root marker + full suite |
| R12 | Medium | `state/projection.ts` | A persisted version-2 projection row cannot contain plugin-record anchors or semantic records | `stateVersion: 3`, documented as a re-fold boundary | `rc7-inplace-drift` / projection tests |
| R13 | Medium | `semantic/evidence.ts` | An ambiguous quote (same sentence in two messages) was resolved to the first match | Refuse `evidence-ambiguous`; the writer is told to quote a longer, unique span | `semantic-core` ambiguity |
| R14 | Medium | `semantic/journal.ts` (prototype) | `setStatus` could no-op silently; a crash between the fold and the status write left `staged` interpreted as intent | Write + read-back verification; `staged` is re-classified against the log on read, so the status write is a cache, not the truth | `semantic-continuity` restart |

## Per-file audit (what changed and why)

**`state/state.ts`** — R1, R2. The reducer remains the only state owner; the
semantic layer applies its resolved operations through `reduceEvent`, so no
second state model exists.

**`state/authority.ts`** — R3. Added `MessageProvenance`,
`authoritativeKindOf`, `provenanceOf`. The anchor service's `citedKinds` now
reads the derived message's producer. This is fail-closed: an unknown producer
grounds nothing.

**`state/anchor-service.ts`** — R3, R8. The capability probe delegates to the
transport; writes go through `appendEfEvent`. The refusal still happens BEFORE
the append.

**`state/plugin-events.ts`** (new) — the single transport decision:
`plugin-record` (0.2.1+), `append-options` (legacy probe), `none`. Readers accept
both faces, but a `plugin:`-typed event without `ignorable` is refused.

**`state/projection.ts`** — R12. Folds plugin-record anchors and semantic records
with the same reducer; version 3 forces a re-fold after upgrade.

**`checkpoint/renderer.ts`** — R10, R11, plus `renderTemporalCheckpoint`:
`Changed in this fold` / `State from earlier folds (later checkpoints supersede
it)` / `Rationale`.

**`checkpoint/residency.ts`** — R9. Retirement uses the transport; the raw event
remains the in-memory face.

**`semantic/types.ts`** — schema v3. Adds `status`, `authority`, `bodyDigest`,
`stagedAtSeq`, `ops`, `plannedOps`, `workingSet`, `activatedAt`,
`abandonReason`. `proposed` is honestly `unknown[]`.

**`semantic/evidence.ts`** — unchanged in substance; exact quotes, positional
pairing, ambiguity refusal, runtime digests.

**`semantic/validate.ts`** — R4 plus the new `verificationQuote` gate. Kind rules
are narrow: constraint/objective/obligation are normative only; finding is
empirical/procedural; a decision cannot become normative by citing the user.

**`semantic/plan.ts`** (new) — R6. Declares first, then failure transitions, then
retires. `previous` needs no retire (the declare displaces in place); a
cross-coordinate target does. Duplicate anchor ids are skipped. `applyOps`
reuses the reducer.

**`semantic/journal.ts`** — R14. One file per packet, atomic write and read-back,
status rewriting, strict v3 guard, deterministic order.

**`semantic/commit.ts`** (new) — R7. The commit point is the SURFACE: a summary
whose text digest matches the packet AND whose replacement message is on the
surface. Marker-only matches are `abandoned` (a retry won). Shorter log =
`pending`; longer with no match = `abandoned`; summary without surface =
`archived-only`.

**`semantic/record.ts`** (new) — the durable payload (`plugin:epistemic-fold/semantic`)
and the replay. Owner validation refuses malformed ops.

**`semantic/changes.ts`** (new) — provenance-scoped changed set, cap 24,
pinned-first, explicit overflow line.

**`semantic/working-set-compiler.ts`** — pinned never dropped (overflow reported),
working budgeted (omission becomes a `context_search` pointer), residency is not
validity.

**`fold/engine.ts`** — active/shadow acquisition, resolution, staging,
post-commit activation (microtask after `compaction/summary`/`compaction/end`),
reconciliation at fold start, journal-authority projection, diagnostics getters,
`setMode` refusal for semantic topology.

**`config/{policy,plugin-config,ef-keys}.ts`** — three keys, defaults, ranges,
and the conflict rule (`semanticContinuity` requires `semanticMode: rationale`).

**`status/{status,command}.ts`** — `/context` reports mode, health, accepted/
refused/committed counts, working-set tokens, and the detail line.

## Residual risks (not fixed, stated)

1. **Semantic inference quality.** The runtime checks attribution and scope; it
   cannot check whether a claim is TRUE. A model can cite a real user message and
   still draw a wrong conclusion. The live evaluation is the only test of this.
   Not executed (no route).
2. **Generalization beyond the quantifier list.** The scope guard catches
   "all/every/never/所有/全部…" but not subtler overreach ("the migration is
   safe"). A narrower claim can still be wrong.
3. **Ambiguous quotes can lose a real constraint.** Refusing ambiguity is the
   safe direction, but a repeated sentence means the model must quote more
   context; a lazy writer may drop the delta. Tracked in the packet's `refused`.
4. **Journal concurrency.** Two processes writing one session's packet use
   atomic rename, but there is no cross-process lock. The staged/activated
   states make a lost update visible, not silently wrong.
5. **Projection cached rows on upgrade.** Version 3 discards older rows; the
   first read after upgrade re-folds the whole log (cost, not correctness).
