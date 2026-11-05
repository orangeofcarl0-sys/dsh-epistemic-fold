# Evaluation — what was measured, and what was not

Everything below was produced on the machine and commit described in
`BASELINE.md`. Nothing here is a projection of expected behavior.

---

## 1. Commands

```bash
npx tsc --noEmit -p tsconfig.json          # typecheck
npm run build                              # lib/ (needed by preflight-lib tests)
npx vitest run --maxWorkers=4              # full suite (bounded pool: 93 workers
                                           # exhausts this Windows host)
npm run eval:semantic                      # the four new suites together
```

Individual suites:

```bash
npx vitest run tests/p0-regressions.spec.ts      # 9  tests — reproduced defects
npx vitest run tests/semantic-core.spec.ts       # 36 tests — protocol layer
npx vitest run tests/semantic-continuity.spec.ts # 21 tests — end-to-end folds
npx vitest run tests/eval-semantic.spec.ts       # 1  test  — 24 arm measurements
```

## 2. Result

```
npx tsc --noEmit -p tsconfig.json                          clean
npx vitest run --maxWorkers=4
  Test Files  91 passed | 12 skipped (103)
       Tests  1040 passed | 27 skipped (1067)

npm run eval:semantic
       Tests  67 passed (67)
```

Baseline was **972 passed / 1 failed** (see `BASELINE.md`), the failure being a
stale generated preset artifact. This round: **0 failed**, 67 new tests.

The 27 skips are the provider-gated suites (`EF_LIVE=1`). They did not run and
are not counted anywhere as a pass.

---

## 3. Control arms

`tests/eval-semantic.spec.ts` builds six scenarios and runs four arms on each:

| arm | configuration |
|---|---|
| **B0** | native Basic (no EF surface at all) |
| **B1** | EF, `semanticContinuity: 'off'` (explicit anchors only) |
| **S1** | EF + writer, `semanticContinuity: 'shadow'` |
| **S2** | EF + writer, `semanticContinuity: 'active'` |

Each arm performs the **same three folds**: two leaf folds, then a **root
rebase** at idle. The root rebase is essential to the measurement — a leaf fold
leaves earlier checkpoints on the surface, so a fact written into checkpoint 1
would still be visible after fold 2 even if nothing carried it. Consolidation is
where narrative that was not maintained as state disappears.

The oracle reads **the exact text every surface node contributes** — what the
provider adapter would receive — and looks for required and forbidden strings.

### 3.1 Measured matrix

```
scenario                        B0   B1   S1   S2   folds(B0/B1/S1/S2)   chars
unanchored-constraint          MISS MISS MISS  ok    3/3/3/3             1782/1843/1792/2028
negative-knowledge             MISS MISS MISS  ok    3/3/3/3             1782/1843/1792/2038
supersession                   MISS MISS MISS  ok    3/3/3/3             1782/1843/1792/1998
validation-boundary            MISS MISS MISS  ok    3/3/3/3             1782/1843/1792/1984
tool-output-injection           ok   ok   ok   ok    3/3/3/3             1782/1843/1792/1792
cross-phase-dependency         MISS MISS MISS  ok    3/3/3/3             1782/1843/1792/2028

resolved: B0=1/6  B1=1/6  S1=1/6  S2=6/6
```

`folds` counts committed `compaction/end` events per arm. The suite **asserts it
is non-zero**, so a scenario whose fold silently failed cannot be reported as a
measurement.

`chars` is the size of the model-visible surface in characters, not tokens, and
is not a cost claim. It is included because a mechanism that carries more state
must be visibly paying for it: S2's surface is 1.7–2.7% larger than B1's for
this corpus (80–159 characters), because the state anchors themselves cost
tokens.

### 3.2 Reading the matrix

- **Every differentiating scenario resolves only under S2.** The unanchored
  constraint, the rejected approach with its reason, the superseded value, the
  claim that must not be `verified`, and the cross-phase decision all survive
  consolidation only when the writer's validated deltas became durable anchors
  and were rendered back.
- **S1 equals B1 on every differentiating scenario.** That is asserted, not just
  observed: shadow mode must not project. It measures extraction without moving
  the surface.
- **`tool-output-injection` is `ok` in every arm** — including B0, which has no
  memory at all. This scenario is a **safety invariant**, not a differentiator:
  no arm may promote text found inside a tool result to a user requirement. The
  fact that it passes everywhere is the correct result, and it is asserted
  separately from the differentiating comparison.
- **`supersession` fails for B0/B1/S1 because the required value is absent**, not
  because the stale value is present. S2 satisfies both halves: the new value is
  visible and `never commit to main` is not, because the replacement occupies the
  same coordinate and the old anchor sits in `superseded`, which no renderer
  reads.

### 3.3 What the matrix does NOT show

**The writer is scripted.** The model's deltas are supplied by the test. So:

- It shows the **runtime** carries validated semantics into the model's context
  across folds and consolidation. That is the mechanism this round built.
- It does **not** show that a live model extracts the right deltas from a real
  conversation. Extraction quality is a model property and needs a live run
  (below). No claim is made about it.

This limitation is stated in the suite's own header, so a future reader of the
test cannot mistake the scope.

---

## 4. Semantic-quality measurements (keyless)

From `tests/semantic-core.spec.ts` and `tests/semantic-continuity.spec.ts`
(48 tests). Each row was a real assertion that had to pass.

| property | result |
|---|---|
| a constraint quoted from a tool result is refused | `authority-ungrounded` |
| a constraint quoted from assistant prose is refused | `authority-ungrounded` |
| a constraint quoted from a plugin-injected user message is refused | `no evidence` / `context-injection` named |
| a constraint quoted from a genuine user message is accepted as `normative` | accepted |
| `verified` from assistant prose is downgraded to `claimed`, `downgradedFrom` recorded, `(verified)` never rendered | downgraded |
| `verified` with an all-tool-result source is kept | kept |
| a normative claim asserted as `observed` is refused | `status-unsupported` |
| a quote found in two messages is refused | `evidence-ambiguous` |
| a quote found only in a checkpoint is refused | `evidence-derived` |
| a phrase that never occurred is refused | `evidence-not-found` |
| an already-committed delta is refused on a retried fold | `duplicate` |
| an `experience-candidate` never becomes an anchor | journal-only |
| a rejected approach renders its reason and what it rules out | `rejected: … (rules out: …)` |
| pinned constraints are all rendered even over budget, and overflow is reported | asserted |
| working items are budgeted; the remainder becomes a pointer | asserted |
| the delta section and the carried section never show the same anchor | asserted |
| old checkpoints carry a temporal heading, not `Current` | asserted |
| `off` mode performs exactly one model call and creates no journal directory | asserted |
| a failed writer call still publishes the bundle and lands a marker checkpoint | asserted |
| a journal write failure is reported as `partial`, the fold still commits its anchors | asserted |
| a journaled packet with no anchor is re-committed after a restart; a second reconcile is a no-op | asserted |
| 4 constraints + 24 decisions: off mode repeats all 28, active bounds the working set | off 28 lines, active ≤ 256 tokens + 4 pinned |
| a ROOT fold over 60 in-span decisions bounds its own delta section | 24 shown, remainder counted in `did not fit` |
| a writer failure leaves a durable `unavailable` health record with no packet | asserted |
| three revisions at one coordinate: a further fold revives nothing | head stays v3, 3 declares, `reconciled` 0 |
| a shadow packet is not treated as a crash gap on the next fold | 0 anchors after 2 folds |
| a corrupt journal packet is skipped, the fold still publishes | asserted |
| a delta whose evidence digest no longer matches is not repaired; health `stale` | asserted |
| a failed writer under `active` still renders the temporal body (no `Current`) | asserted |
| statements collapse to one line; non-ASCII subject keys are refused | asserted |
| the `ignorable` marker is on the write, not only on the probe | asserted |

## 4.1 Defects found by independent review of this round's own code

A separate review pass over the new subsystem found real defects, and the
regressions above are the result. Recording them is part of the evidence:

| finding | severity | disposition |
|---|---|---|
| reconciliation used the BOUNDED STATE as the committed-anchor oracle, so a twice-superseded value was re-declared and became current again | blocker | fixed: the oracle is the session log; pinned by the three-revision test |
| objective anchors never occupied their state coordinate, so objectives had no revision chain | high | fixed in the reducer |
| the duplicate oracle counted `accepted` (including shadow packets and failed declares), silently dropping a genuine re-proposal | high | fixed: an id counts only when its anchor is in the log |
| `stale` was computed and then overwritten by every fold, so the documented alert could never fire | high | fixed: reconciliation gaps outrank the fold's own verdict |
| a retried fold overwrote its own packet, erasing the acceptance record | medium | fixed: packets merge, never lose accepted deltas |
| same-packet `supersedes` was applied inside the declare loop and could retire nothing | medium | fixed: two-phase declare/retire, kind-aware resolution |
| repair planned deltas one at a time, dropping cross-coordinate retirements | medium | fixed: repair groups by packet |
| a model statement containing a newline could forge a runtime-shaped state line | medium | fixed: one-line normalization in the validator AND the renderer |
| a writer failure under `active` fell back to the legacy `Current` body | medium | fixed: the temporal shape is preserved |
| the probe checked the `ignorable` marker but the real writes never sent it | high | fixed: both call the same shape |
| corrupt journal entries were trusted through a cast | low | fixed: entry shapes are validated on read |
| repair order followed wall clock | low | fixed: ordered by fold position |
| journal-only kinds were reported as permanently missing | medium | fixed: skipped by contract |
| commit failures were labelled `authority-ungrounded`, hiding the host-capability message | low | fixed: `commit-failed` with the real text |

Two findings were accepted as limits rather than changed: `canonicalJson`'s
locale-dependent key ordering (mitigated for this layer by restricting
`subjectKey` to ASCII, but the pre-existing rule was not changed mid-round
because it would invalidate existing bundle digests), and the host
`ef/anchor` capability (documented in `SPEC.md` §7 and `HANDOFF.md` §5).

## 5. Cost and token accounting

| field | value |
|---|---|
| Main LLM input cache hit/miss | **unknown** — no live provider call in this round |
| Main LLM output | **unknown** |
| Semantic writer input/output | **unknown** — the scripted adapter reports no usage |
| Recall calls and tokens | not exercised at scale in this round |
| Fold count per scenario | 3 (2 leaf + 1 root), asserted non-zero |
| Working-state tokens | measured: 256-budget case reported 256 + pinned overhead (asserted ≤ 376) |
| Peak active context | not measured |
| Task success (live model) | **not executed** |

The writer's real call envelope (provider, model, `maxTokens`, `usage`,
`rawOutput`) is forwarded into `compaction/summary` exactly as the rationale call
always was, so a live deployment gets real billing through the existing path.
This round cannot report those numbers because it made no live call, and
`unknown` is reported rather than `0`.

### Why no live run

No provider credentials are present (`DEEPSEEK_*`, `*_API_KEY` unset) and
`EF_LIVE` is not set. The honest status is **not executed**, not "passed".

The exact command a keyed machine should run:

```bash
export EF_LIVE=1
export DSH_SEMANTIC_LIVE_MODEL=<provider>/<model>   # whatever the deployment routes
npx vitest run tests/eval-semantic.spec.ts          # currently keyless-only
npx vitest run tests/rc2a-live-real-task.spec.ts    # existing live real-task suite
```

A live variant of the control-arm evaluation is **not implemented** in this
round: it would need a second harness that drives a real adapter through the
same three folds and grades the model's answer. That is the next piece of
evaluation work, and it is named in `HANDOFF.md` rather than implied to exist.

---

## 6. Claims this round does and does not make

**Established, with reproducible tests:**

1. Two pre-existing defects were reproduced, fixed, and pinned by regression
   tests (failure-head divergence; role-based authority).
2. A validated semantic delta from an unanchored natural-language constraint
   becomes durable state and is rendered into the model's context.
3. A superseded value is replaced at its coordinate, stays traceable in
   `superseded`, is absent from the rendered body, and remains recoverable from
   the archive.
4. `verified` cannot be obtained from prose, and the downgrade is recorded.
5. A quote inside tool output cannot become a user requirement.
6. Shadow mode records extraction and changes neither the state nor the surface.
7. A journaled-but-uncommitted packet is repaired after a restart, using the
   session log alone, with no double commit.
8. Active-mode checkpoints bound the carried state instead of repeating the full
   table, and report pinned overflow instead of dropping a constraint.
9. Turning the feature off restores the previous behavior: one model call, no
   journal directory, the pre-existing checkpoint shape.

**Not established:**

1. That a live model extracts the right deltas. (Scripted writer.)
2. That task success improves under a live model. (No live run.)
3. Any cost saving or penalty under a live provider. (No usage numbers.)
4. That the model *uses* the working set correctly. The matrix shows the content
   is present and bounded; whether a given model acts on it is a separate
   behavioral question.
5. Statistical significance of anything. There are no paired live trials.
