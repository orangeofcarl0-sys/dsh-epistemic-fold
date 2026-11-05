# Handoff — Semantic Continuity v1

Read `SPEC.md` first for the architecture, `EVALUATION.md` for what was measured.
This file is the practical one: what exists, how to turn it on, and what to do
next.

---

## 1. What was implemented

### New subsystem: `src/semantic/`

| module | responsibility |
|---|---|
| `types.ts` | the protocol: `SemanticKind`, `EpistemicStatus`, `SemanticLifecycle`, `SemanticResidency`, `ProposedDelta`, `AcceptedDelta`, `SemanticPacket`, `SemanticHealth`, schema version |
| `writer.ts` | the prompt and the parser for the one combined call (`<handoff>` + `<deltas>`) |
| `evidence.ts` | quote → `{seq, messageDigest}` resolution, restricted to the folded span and to non-derived producers |
| `validate.ts` | shape, evidence, authority and status checks; delta identity; `anchorIdOf` |
| `journal.ts` | atomic per-packet files, commit/health sidecars, replay and reconciliation |
| `reconcile.ts` | accepted deltas → a commit plan over the existing anchor state; provenance-scoped "changed in this fold" |
| `working-set-compiler.ts` | the bounded Pinned/Working/Archived rendering with explicit overflow |

### Modified modules

| module | change |
|---|---|
| `state.ts` | `transitionFailure` advances the `stateHeads` copy as well as the face (P0 defect) |
| `authority.ts` | `authoritativeKindOf` / `provenanceOf`: authority by role **and** producer |
| `anchor-service.ts` | cites through the new classifier; error messages name the refused producer |
| `projection.ts` | `stateVersion` 2 → 3 (the failure-head semantics changed) |
| `renderer.ts` | exports `renderAnchorLine` / `renderFailureLine`; adds `renderTemporalCheckpoint`; `renderStructuredCheckpoint` takes the fold mode so a root checkpoint's marker says `R` |
| `rationale.ts` | optional `instruction` (one LLM path, not two) |
| `engine.ts` | the semantic face: writer call, validation, journal, commit, re-read, compile, render; `lastSemanticPacket`, `lastWorkingSet`, `semanticDiagnostics`, `reconcileSemantics`; `options.anchors` / `options.semanticJournal` |
| `policy.ts` | `semanticContinuity`, `semanticWorkingSetTokens`, `semanticRoot`; the zero-LLM conflict is refused |
| `plugin.ts` | constructs the anchor service **before** the engine and hands it over; loader schema keys; `/context` semantic callback |
| `command.ts` / `status.ts` | `/context status` and `/context line` report semantic health, counts and working-set size |
| `framing.ts` | the constant `system-dedup` section now states that a later checkpoint is authoritative where two disagree |
| `index.ts` | public exports for the new modules |
| `thermal.ts` | comment corrected: the dedupe is no longer compensating for a reducer defect |

### Tests

| file | count | purpose |
|---|---|---|
| `tests/p0-regressions.spec.ts` | 9 | the reproduced defects plus the write-side capability marker |
| `tests/semantic-core.spec.ts` | 36 | writer parsing, evidence resolution, validation, compiler, journal, `/context` health, injection hardening |
| `tests/semantic-continuity.spec.ts` | 21 | end-to-end folds: unanchored constraint, counterfactual pair, negative knowledge, validation boundary, supersession, no-revival, cross-phase dependency, retrieval, injection, recovery, journal damage, bounded growth, shadow |
| `tests/eval-semantic.spec.ts` | 1 (24 arm measurements) | B0/B1/S1/S2 control arms |

---

## 2. Running it

```bash
npm install                 # runs build + preset generation
npm run build
npx tsc --noEmit -p tsconfig.json
npx vitest run --maxWorkers=4      # bounded pool: 93 forks exhausts Windows
npm run eval:semantic              # the four new suites
```

Enable in a DSH profile:

```yaml
- name: dsh-epistemic-fold
  config:
    bundleRoot: <persistence root>/epistemic-fold
    mode: economy
    semanticMode: rationale
    semanticContinuity: shadow        # measure first
    semanticWorkingSetTokens: 1024
```

Then `/context status` shows a `semantic continuity:` block. Move to
`semanticContinuity: active` once the shadow counters look sane on your traffic.

---

## 3. Migration and rollback

**No migration is required.** The semantic layer is additive:

- `semanticContinuity` defaults to `off`; an existing config behaves byte for
  byte as before, creates no journal directory, and issues no extra call.
- Every semantic value is an ordinary `ef/anchor` event, so an old build reads a
  new session's log without knowing the layer exists (the anchors are just
  anchors).
- The projection `stateVersion` bump from 2 to 3 makes a persisted v2 row be
  discarded and re-folded from the log. That is a cache invalidation, not data
  loss — the log is authoritative.

**Rollback** is the switch itself. A runtime `setMode` that would change
`semanticContinuity` is REFUSED (the journal is constructed once, so a runtime
change would commit without an intent record); restart to change it.


- `active` → `shadow`: state stops being written; existing anchors remain and
  keep rendering. The previously written anchors are still valid state, so the
  rollback does not strand them.
- `shadow`/`active` → `off`: one model call per fold (the old rationale), the
  old checkpoint shape, no journal reads or writes. Existing semantic anchors
  keep working through the pre-existing renderer.

If the journal must be discarded: delete `<semanticRoot>/`. The cost is the
idempotency oracle (a retried fold could re-commit a delta, which the reducer
absorbs at the same coordinate) and the audit trail. State is unaffected.

---

## 4. Operational notes

**Health states worth alerting on**

| health | meaning | action |
|---|---|---|
| `unavailable` | the writer call failed | usually a provider/route problem; folds still archive correctly |
| `partial` | proposals refused or a write failed | read the log line's reason counts; `authority-ungrounded` on many deltas usually means the writer is inventing evidence |
| `stale` | journal has accepted deltas the log lacks | reconciliation could not recompute them; inspect the source events |
| `archive-only` | layer off | expected under `off` |

**Log lines.** One per fold: `semantic (<mode>): health=… proposed=… accepted=…
refused=… committed=… parse=…`, plus `semantic working set: pinned N, working M,
omitted K, T/B tokens [basis]`. Counts and verdicts only — no statement, quote
or message text.

**Where the state lives.** `ef/anchor` events in the DSH session log (authoritative)
plus `<semanticRoot>/<sessionId>/packet-*.json` (intent/audit) and
`commit-*.json` (what landed). The journal is safe to lose.

---

## 5. Current limitations

1. **Extraction quality is unmeasured live.** The control-arm evaluation scripts
   the writer. The runtime path is proven; the model's judgment is not.
2. **No live control-arm variant.** `tests/eval-semantic.spec.ts` is keyless.
   A live version needs a real adapter through the same three folds.
3. **`subjectKey` stability is the model's responsibility.** Two names for one
   thing become two coordinates instead of a supersession.
4. **Cross-coordinate `supersedes` only resolves inside one packet.**
5. **An `active` fold can be larger than an `off` fold** when pinned state is
   dense. The budget reports overflow rather than dropping a constraint, so a
   state with dozens of hard constraints can exceed its span and be refused by
   Basic's shrink check. The guard is the budget: pinned constraints should be
   few and genuinely global.
6. **No automatic root rebase on semantic grounds.** Consolidation is still
   driven by the existing pressure/root policy; the layer does not fold anything.
7. **`experience-candidate` has no consumer yet.** It is journaled and never
   rendered, by design.
8. **The durable-write capability is a host property, and it gates `active`.**
   `ef/anchor` needs the envelope's `ignorable` marker to survive a reopen. EF
   probes for it and REFUSES every anchor write when the host lacks it, so on
   such a build `active` commits nothing and each fold reports `partial` with a
   `commit-failed` detail. Prove the capability first:
   `npx vitest run tests/persistence-compat.spec.ts` — the test
   `refuses ef/anchor exactly when the host cannot mark it ignorable` states
   which branch your build takes. The in-process suites here use the default
   anchor service, which allows writes; that is why they can measure the commit
   path on a host whose durable log would refuse it.

---

## 6. The most valuable next work

In order, and each with a concrete reason:

1. **A live control-arm run.** The single highest-value item: it is the only way
   to move "the runtime carries the state" to "a model uses it better". Needs
   `EF_LIVE=1`, a real adapter, and a grader. Expect to also need a **task**, not
   a question — the existing `rc2a-live-real-task` suite is the right base.
2. **Measure extraction precision/recall against a labelled corpus.** The
   validator can tell you a quote is real; only a labelled set tells you whether
   the claim is *the* important one. This is the natural place for the
   `experience-candidate` kind to earn its keep.
3. **A delta-level evaluator for subject-key stability.** Collect writer output
   over several folds of one task and report how many coordinates were touched
   twice — the concrete number behind limitation 3.
4. **A live check that `active` is not net-negative on cost.** The bounded
   working set should reduce repetition; that must be measured against real
   provider cache accounting, not assumed.
5. **Root-fold consolidation trigger from semantic staleness** — only if (1)
   shows the stale-snapshot problem matters in practice. It is deliberately not
   built before there is evidence.
