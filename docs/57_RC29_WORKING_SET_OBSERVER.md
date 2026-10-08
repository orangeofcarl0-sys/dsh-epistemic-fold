# RC29 — the Thermal Working-Set Observer and the Shadow Folding Policy

This round adds an observer and a shadow policy. It adds **no** new automatic
folding: no temperature-driven root, no rewritten leaf or root transaction, no
change to any preset. Every claim below is measured on this machine, and the
places where the evidence is thin are stated as such.

Starting point: `main` at RC28 (`2f432cf`), **954 passed / 23 skipped / 0 failed**
after `npm run build`.
Ending point: **977 passed / 23 skipped / 0 failed**, three typecheck projects
clean. The round's commit SHA is reported alongside this document rather than
inside it, since a commit cannot contain its own hash.

One thing the gates caught that is worth recording: the canary test in §D
originally planted a credential-shaped literal in the test file, and
`release-hygiene.spec.ts` failed on both the tracked-file scan and the
history scan. The literal is now assembled at runtime, so the detector was not
weakened to accommodate a test — which is the point of having it.

---

## A. What changed, and what was reused

### New modules

| file | what it is |
|---|---|
| `src/working-set.ts` | `assessWorkingSet` — the three-way decomposition and both reclaim estimates |
| `src/thermal.ts` | `assessThermalResidency` — conservative residency over the deterministic state |
| `src/shadow-policy.ts` | `decideShadowFolding` — the shadow recommendation, reusing the production gate |
| `src/working-set-observer.ts` | the single entry point the engine calls; the only reader of the flag |

### Files modified

- `src/policy.ts` — the `workingSet: 'off' | 'observe'` config key (default `off`),
  added to `EF_OWNED_CONFIG_KEYS` so it never reaches Basic's strict validation.
- `src/engine.ts` — one private method and three call sites. No decision logic
  was touched.
- `src/plugin.ts` — the config key in the loader schema, or a deployment that set
  it would be rejected.
- `src/index.ts` — exports.

### Reused, not reimplemented

The observer composes existing policy rather than restating it. This is the part
that matters for correctness, because a second implementation of a policy is a
second answer:

| question | reused from |
|---|---|
| the frozen/open split | `pressureBreakdown` |
| which span a leaf would take | `selectLeafSpan` (both at the caller's retention and at 0) |
| which range a rebase would replace | `selectCompactableRange` |
| whether any fold can reach the threshold | `assessFoldReachability` |
| whether a leaf is worth taking | `admitLeafEconomically` — the PRODUCTION gate |
| the rebase break-even | `rootBreakEvenRequests` + `resolveProfile` |
| the anti-oscillation cooldown | `ROOT_REBASE_COOLDOWN` |
| the checkpoint body a fold would write | `renderStructuredCheckpoint` |

**Does this change any production compression decision? No.** The observer
returns a value the engine discards, and its call sites are statements with no
binding — so there is no value for a decision to branch on. That is checked
mechanically rather than promised; see §D.

---

## B. Real working-set decompositions

Every row below is measured output from the real engine path
(`compactIfNeeded` → observer), on a 32K window. `identity` is
`frozenCheckpointTokens + legalLeafSpanTokens + residualTokens === totalTokens`.

### S1 — normal growth, no frozen prefix yet

| field | value | basis |
|---|---|---|
| totalTokens | 17475 | measured |
| frozenCheckpointTokens | 0 (0 checkpoints) | measured |
| legalLeafSpanTokens | 12818 | measured |
| residualTokens | 4657 | derived |
| estimatedLeafReclaimTokens | 12798 | estimated (`rendered-state`) |
| estimatedRootReclaimTokens | 17033 | estimated (`rendered-state`) |
| leafReachable / rootReachable | true / true | — |
| identity | 0 + 12818 + 4657 = 17475 ✓ | |

Threshold 6400, retain 4464. Note that `legalLeafSpanTokens` (12818) is
**smaller** than the surface: the residual is the retained tail, and it is not
zero. This is the RC28 §0.1 distinction made numeric — the foldable part is not
`openTokens`.

### S2 — multi-checkpoint accumulation (3 folds committed)

| field | value | basis |
|---|---|---|
| totalTokens | 6099 | measured |
| frozenCheckpointTokens | 357 (3 checkpoints) | measured |
| legalLeafSpanTokens | 1072 | measured |
| residualTokens | 4670 | derived |
| estimatedLeafReclaimTokens | 1052 | estimated (`rendered-state`) |
| estimatedRootReclaimTokens | 5793 | estimated (`rendered-state`), root span 5813 |
| identity | 357 + 1072 + 4670 = 6099 ✓ | |

The root estimate reads the **real legal range** (5813 tokens), not the
checkpoint count and not the frozen prefix. A rebase reclaims 5793, which is
bounded by the range it replaces — the bound a test asserts.

### S3a — oversized last node, no pruner (the RC28 shape)

| field | value | basis |
|---|---|---|
| totalTokens | 60641 | measured |
| frozenCheckpointTokens | 119 (1 checkpoint) | measured |
| legalLeafSpanTokens | **0** | measured |
| residualTokens | 60522 | derived |
| estimatedLeafReclaimTokens | **unknown** | `unknown` |
| estimatedRootReclaimTokens | 99 | estimated (`rendered-state`), root span 119 |
| leafReachable / rootReachable | **false / false** | — |
| identity | 119 + 0 + 60522 = 60641 ✓ | |

This is the surface the whole feature exists to make readable. 60522 of 60641
tokens sit in the residual, **zero** are foldable, and a rebase would recover 99
of them. The observer reports `unknown` for the leaf reclaim rather than `0`,
because no legal span exists — the two are different statements.

Blockers emitted, verbatim:

```
no structurally legal span exists past the frontier, so no leaf fold can be taken
no fold can reach the threshold: the widest legal span is 0 tokens and 60641 would remain against a threshold of 16000
no leaf fold is admissible: no structurally legal span past the frontier
```

### S3b — the same surface with production's pruner mounted

| field | value | basis |
|---|---|---|
| totalTokens | **8595** | measured |
| frozenCheckpointTokens | 0 (0 checkpoints) | measured |
| legalLeafSpanTokens | 4223 | measured |
| residualTokens | 4372 | derived |
| estimatedLeafReclaimTokens | 4203 | estimated (`rendered-state`) |
| leafReachable | true | — |
| identity | 0 + 4223 + 4372 = 8595 ✓ | |

**67305 → 8595 tokens** on the identical fixture, the mount being the only
difference. This reproduces RC28 §0.4's synthetic finding through the observer,
and it is the clearest evidence in this round: the surface that looked
unfoldable was a property of the *configuration*, not of EF.

### A geometry finding worth recording

Whether an oversized node is unfoldable depends on whether it is **last**:

| shape | rebase range | verdict |
|---|---|---|
| oversized node LAST | `[0,15]` = 8168 tokens | 60008 retained → nothing reaches the threshold |
| oversized node FOLLOWED by a turn | `[0,18]` = 68813 tokens | the node is covered → a rebase DOES reach it |

Both are measured. The retention walk breaks on its first iteration at
`retainTokens = 0`, so the last node is always retained; one trailing message
changes what a rebase can reach. A test pins both directions, because reporting
only the first would overstate the problem.

---

## C. Shadow policy results

| scenario | action | executable | confidence | why |
|---|---|---|---|---|
| S1 growth | `leaf` | true | high | legal span 12818, gate admits, reclaim 12798. Over threshold → a **due** fold |
| S2 accumulation | `leaf` | true | high | legal span 1072, reclaim 1052. **Under** threshold → an **EARLY** fold the current policy does not take |
| S3a oversized | `none` | false | high | the only available rebase reclaims 99 of 60641 and leaves 60542 against a 16000 threshold |
| S3b with pruner | `leaf` | true | high | the pruner removed the obstacle; the fold is ordinary |

The recommendation is executable only when the engine could actually take it,
and that is enforced rather than asserted: the leaf branch requires **both** the
production gate's admission **and** a non-empty span from `selectLeafSpan` at
the retention in force. Those differ — the gate probes `retain 0`, the fold loop
folds at `spec.retainTokens` — and building the observer on the gate alone
produced a recommendation the engine could not execute. That defect was found
during this round and is pinned by a test.

Three refusals are worth naming, because each is a way an "early root" feature
goes wrong:

1. **No frozen prefix ⇒ no rebase.** A rebase collapses the frozen prefix; with
   nothing frozen there is nothing to collapse. The economics alone said `root`
   here (zero compaction cost ⇒ zero break-even), which is why the structural
   guard exists.
2. **A rebase must reach the threshold, not merely reclaim something.** On S3a a
   rebase reclaims 99 tokens and breaks even instantly. Recommending it would be
   RC28's silent non-convergence, restated as advice.
3. **The cooldown binds the shadow.** `ROOT_REBASE_COOLDOWN` is applied to the
   shadow exactly as to the engine, so a shadow cannot propose what the engine
   would refuse as thrashing.

A recommendation can also be correct *and* warn: a leaf that cannot converge is
still worth taking (the engine takes exactly one), so the leaf branch carries the
non-convergence blocker rather than clearing it.

---

## D. Regression and tests

```
tests passed / failed / skipped   977 passed / 0 failed / 23 skipped   (1000 total)
                                  baseline at 2f432cf: 954 / 0 / 23
typecheck (tsconfig.json)         clean
typecheck (tsconfig.client.json)  clean
typecheck (tsconfig.eval.json)    clean
build (npm run build)             51 modules -> lib/
keyless long-chain                44 passed (eval-core, eval-corpus, eval-longhorizon)
off-vs-observe equality           passes; 36 visible messages identical, 4 leaves / 0 roots
                                  / 0 emergencies / 0 intents / 4 writes on BOTH arms
```

Stability: the full suite was run three times with identical counts. The
`off`-vs-`observe` comparison normalizes only the identities that are random by
construction (checkpoint UUID, session id); counts, spans, checkpoint bodies and
the derived message list are compared as-is.

### Destructive checks

Each guard was removed and the suite re-run, so these tests are known to fail
when the behavior they pin is broken:

| guard removed | result |
|---|---|
| observer appends a session event | equivalence fails (36 → 97 messages) |
| `workingSet` gate deleted | "read exactly once" fails (0 ≠ 1) |
| observer result bound to a name | "must be discarded" fails |
| `isPinned` always false | "constraint and objective must both be pinned" fails (0 ≠ 2) |
| `legalLeafSpanTokens` replaced by `openTokens` | oversized-node tests fail (60522 ≰ 0) |

The first attempt at the first check used an `append` that the surface plan
ignored, and it passed — which was a real weakness in the check, not in the
code. It was replaced with a mutation that genuinely changes the surface.

---

## E. Risks and limits

**The thermal signals are the weakest part, and they are weak by design.**

- **Most long-task knowledge is invisible.** The reducer produces anchors only
  from explicit `ef/anchor` operations and failed tool results. An ordinary
  conversation declares nothing, so on every fixture in §B the thermal reading is
  `0 anchor(s)`. The observer reports residency for what the deterministic state
  holds and says nothing about the rest. **It is not a model of the working set
  of a conversation.**
- **`cold` is nearly unreachable, deliberately.** The only route to `cold` is an
  explicit supersession/retirement. No amount of elapsed work can produce it, so
  the age signal the round was framed around contributes nothing to a verdict —
  it can raise a classification to `warm` and no further. A deployment hoping
  for "this is cold, fold it early" will not get one.
- **Retrieval demand is coarse.** It counts `context_recall` / `context_search`
  calls in the last 200 events and cannot attribute one to a specific anchor, so
  its only effect is to annotate a `cold` verdict. The 200 is a parameter with
  no measurement behind it.
- **A reducer inconsistency was found and worked around, not fixed.** After
  `transitionFailure`, the same anchor is present twice with different
  `failureState` — `resolved` in `openFailures`, `open` in `stateHeads` (verified
  directly). The observer deduplicates by taking the most advanced copy. **The
  underlying reducer behavior is unchanged and out of this round's scope**; it is
  a latent defect for any other reader that deduplicates by id.
- **No cold judgment is proven safe to execute.** The shadow policy never reads
  the thermal report. Residency is reported and nothing acts on it, which is why
  no thermal misclassification can cause a fold.

**Estimates, not measurements.** Every reclaim figure is a prediction: it prices
a checkpoint that does not exist. `rendered-state` is the strongest basis and is
still an estimate. `unknown` is returned rather than a number when no basis
exists, and the root estimate is `unknown` without a mounted projection —
`framing-fallback` and `observed-average` would both understate a rebase
checkpoint, which condenses a whole range rather than a bounded span.

**A caveat inherited from `rootBreakEvenRequests`.** It assumes the tokens a
rebase removes were being served at the profile's warm rate. On S3a that
assumption is what makes the break-even read 0.0 for a 99-token reclaim. The
threshold-reachability guard is what refuses the recommendation; the horizon
alone would not.

**Not claimed:** no LHTB sweep was run and no arm ranking is offered. No live
provider call was made. The observer's behavior on a real long LHTB transcript
is **unmeasured** — §B is synthetic-but-deterministic keyless data, and
extracting real working-set figures from an existing transcript was not done.

---

## F. Where to invest next

**Recommendation: Working-Set Projection — with the thermal layer left where it
is.**

The evidence for that ordering:

1. **The decomposition is the part that works.** It produced a real,
   checkable answer in every scenario, including the one that mattered (S3a:
   60522 of 60641 residual, 0 foldable, correctly reported as unfoldable). It
   found a configuration defect worth 58710 tokens (S3a→S3b). Nothing else in
   this round produced a finding of that size.
2. **The thermal layer did not earn its keep, and the reason is structural, not
   tuning.** On every measured fixture it read `0 anchor(s)`, because the
   deterministic state is populated only by explicit anchor operations. More
   thermal signals cannot fix a state that does not exist; the input is missing,
   not the classifier. Investing here means first investing in anchor coverage,
   which is a larger and different change.
3. **Early Root is not justified by this evidence.** The one surface where a
   proactive root looked attractive (S2, under threshold, break-even within
   horizon) is also a surface where a leaf reclaims 1052 tokens at no rebase
   cost and no cache invalidation. The shadow preferred the leaf there, and
   nothing in §B shows a case where an early rebase beats a leaf on a surface
   the current policy is not already folding.
4. **Early Leaf is plausible but unproven.** S2 shows an executable early leaf
   with a 1052-token reclaim. Whether taking it early is *better* than taking it
   when the threshold is crossed is a question about downstream behavior, and
   this round produced no evidence on it — the observer deliberately changes
   nothing, so no comparison exists.

So the next round's most valuable step is to make the working-set numbers a
first-class surface a human can read per session (a projection or command view
over the same `assessWorkingSet` output), because that is the artifact this
round demonstrated is accurate and useful. Early Leaf should be evaluated only
after such a surface exists to measure it against, and the thermal layer should
wait until the deterministic state actually carries the knowledge it would
classify.
