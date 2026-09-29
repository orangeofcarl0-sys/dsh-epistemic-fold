# RC2.1 — Status Correctness, Baseline Naming, and the Retention A/B

Baseline: `main@97eb0bb` (RC2 merged).
Scope: corrections to RC2. No new architecture, no parameter sweep.

> **RC3 CORRECTION.** The A/B below ran in the same hand-built harness as RC2,
> not in DSH. The measurements stand; the host did not. See
> [RC3](26_RC3_REAL_DSH_PLUGINIZATION.md).
>
> **One-line result.** Four correctness defects in `/context status` are fixed
> (including one fabricated measurement and one heuristic labelled as measured);
> the RC2 `legacy` arm is renamed to what it was — **EF legacy, not Basic** — with
> a real Basic arm added; the ladder is reordered to **retention first**; and the
> one critical A/B found **no measurable steadiness gain** from retention
> (0.90 → 0.90) at a **+0.003** cost. The tier's benefit stays a HYPOTHESIS.

---

## 1. Status correctness

RC2's `/context status` had four defects. Two of them were the exact class of
error this project has corrected before, so they are listed first.

### 1.1 `unknown` was being reported as a measured `0`

`buildContextStatus` returned `{ value: 0, basis: 'measured' }` when no token
meter reading existed — **a fabricated measurement asserting the context was
empty**. A session before its first provider report has an *unestablished*
pressure, and `0` is the opposite of the truth. Occupancy was then computed from
that zero, reporting `0.0%` for an unmeasured session.

**Fixed.** `currentContext` is absent when there is no reading, and `occupancy`
requires **both** halves — a ratio with a missing numerator is not a ratio. The
renderer prints `pressure unknown`, and the one-line form prints `ctx=unknown`.
A genuine reading of `0` is still reported as a measured zero, and a test pins
both directions.

### 1.2 Archived tokens were a heuristic labelled `measured`

The archived **message count** is a real count. The archived **token** figure is
`characters / 4` — the token meter's own fixed density heuristic, which
systematically misprices CJK text and JSON. RC2 reported it as `measured`, which
is RC1.1's error repeating: the *input* was real, but the *conversion to tokens*
was not a measurement.

**Fixed.** `archivedTokens.basis` is `estimated`, and the rendered line marks it
`~100 (estimated)`. The count stays `measured`.

### 1.3 Usage was hand-rolled instead of read from DSH

RC2 summed usage by scanning `compaction/summary` events — which **missed every
ordinary assistant turn**, since those events only exist for folds. The figure
was therefore structurally wrong, not merely imprecise.

**Fixed.** The status now reads DSH's own `tokenUsage` projection
(`@deepseek-ai/dsh-token-meter`), which is accumulated over the whole durable log
and accounts for retries via `llm/retry-started`. The four buckets it exposes
(`uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`)
are exactly what the cost model needs, and they are reported in the output so the
basis of the estimate is visible. `undefined` when the projection is unmounted or
no provider has reported — in which case cost is UNKNOWN, not zero.

### 1.4 Current checkpoints and lifetime folds were the same number

RC2 derived leaf/root counts from the **surface frontier** and put them on the
lifecycle object as if they were lifetime totals. A session that folded 40 times
and then rebased to a single checkpoint would have reported `leaves = 1`.

**Fixed.** The two are now separate fields with names that say which is which:

| field | meaning | source |
| --- | --- | --- |
| `checkpoints` | EF checkpoints frozen on the surface **right now** | the surface frontier |
| `folds.leaves` / `folds.roots` | folds this session has **ever committed** | the bundles the store holds |

Bundles are written once and never removed in production, so the bundle list is a
lifetime record — which is what makes this split computable. `folds.complete`
is `false` when the store was not consulted, and the report says the counts are
**minimums, not totals** rather than presenting a lower bound as a total. The
renderer names them `checkpoints now` and `folds (lifetime)`.

---

## 2. Baseline naming

**RC2's `legacy` arm was not Basic.** Every arm in that run was EF: the `legacy`
arm mounted the EF *plugin* with the legacy *policy*, while the report described
it as "Basic's own policy". EF-legacy still folds through the EF engine, still
writes Bundles, still exposes the recall tools and the EF framing section. A real
DSH Basic session has none of that.

So the arm model now names the **engine** explicitly:

```ts
{ engine: 'ef',    mode: 'legacy',  label: 'ef-legacy' }
{ engine: 'basic', mode: 'legacy',  label: 'basic'     }   // real BasicCompactionEngine
```

`BASIC_ARM` is included in the default arm set so a report can say "versus DSH
Basic" and mean it, and `EF_ARMS` is exported separately so a ladder-only run can
exclude the baseline. Tests assert that the EF ladder contains no Basic arm — a
Basic arm inside it would double-count the baseline in any pooled per-mode figure.

**The RC2 numbers are unchanged; only what they are called is corrected.**
`docs/24` carries the correction in place, and its row is now labelled `EF legacy`.

---

## 3. Ladder reorder: retention first

RC2 ordered the ladder `economy → balanced (rationale) → quality (+retention)`.
RC2.1 reverses the two levers:

| rung | lever | value |
| --- | --- | --- |
| `economy` | — | `retainRatio` = engine default 0.16, `semanticMode: none` |
| `balanced` | **retention** | `retainRatio` = 0.24, `semanticMode: none` |
| `quality` | **+ rationale** | `retainRatio` = 0.24, `semanticMode: rationale` |

Two reasons, both about which mechanism is stronger and cheaper to justify:

1. **Retention is the stronger mechanism.** A fact inside the retained tail never
   leaves the surface, so it depends on neither the checkpoint nor the model
   choosing to retrieve. A rationale checkpoint still has to be *read*, and RC1.3
   measured that the marker-only economy preset already reaches parity without it.
2. **Retention is the cheaper first step.** It costs context on every request but
   adds no auxiliary call and no provider round trip per fold.

So the cheap rung buys the stronger mechanism. The top rung does **not** raise
retention further, so the difference between `balanced` and `quality` remains
exactly one lever. `balanced` sets `semanticMode: 'none'` **explicitly** — the
engine's own default for that key is `rationale`, so omitting it would silently
buy the auxiliary call the rung is defined not to make.

This ordering is a **design decision, not a measurement**, and each tier's
`evidence` field still says so.

---

## 4. The one critical A/B

### The question, isolated

`balanced` claims a larger verbatim tail buys steadiness. The A/B varies exactly
one thing:

```
economy    retainRatio = 0.16
balanced   retainRatio = 0.24
```

Both arms are EF, both `semanticMode: none`, same window, threshold, tasks and
probes. The arm specs are declared **inside the A/B suite** rather than taken
from the ladder, so the isolation is explicit at the point of use.

### The tasks were made harder

RC2's tasks were solved in every mode, so TaskQuality saturated at 1.00 and no
metric could separate anything. A task that needs nothing it forgot cannot
measure forgetting. The A/B tasks keep the same kind but raise the **dose**: 12–13
stated facts, **two** revisions each, 4–5 work steps, and a final artifact that
must agree with all of them at once — plus a new `facts-consolidated` probe that
catches a session which wrote the corrected value but *reported* the old one.

### The result

12 runs, **0 of 249 provider calls lost**.

```
RC2.1 RETENTION A/B (economy 0.16 vs balanced 0.24, all else identical)
  economy   runs=6 cost=0.006004 quality=0.92 steady=0.90 [4,5,4,5,4,5]/5
  balanced  runs=6 cost=0.009012 quality=0.92 steady=0.90 [4,5,4,5,4,5]/5

  steadiness 0.90 -> 0.90 (delta +0.00)
  cost       0.006004 -> 0.009012 (delta +0.003008)
```

**Retention bought no measurable steadiness improvement, and cost 50% more.**

The per-run scores are **identical, run for run** — `[4,5,4,5,4,5]` in both arms
— and both arms lost the **same probe** (`facts-consolidated`, 3 of 6 runs each).
So the loss is not retention-dependent: the larger tail neither prevented it nor
caused it.

### What this does and does not mean

**Does mean.** On this instrument, a 1.5× retention raise is not visibly buying
steadiness, while it measurably raises cost. A deployment choosing `balanced` for
steadiness alone has no evidence for the choice.

**Does not mean retention is useless.** The tasks got harder but still scored
0.92 quality and 0.90 steadiness in BOTH arms, so the instrument remains close to
its ceiling — a probe that fires in half the runs in both arms is the only signal
available, and it is one probe. The honest reading is **"this instrument could not
see the benefit"**, not "the benefit is absent". The tier's status stays
`HYPOTHESIS`, which is what that word is for.

**What would settle it.** A task where the facts are far enough behind the
frontier that a 1.5× tail difference changes whether they are on the surface at
all — i.e. a longer session, not a harder artifact. That is a new stage's
decision, and RC2.1's directive was to stop after one A/B.

---

## 5. State after RC2.1

```
Compression architecture  CLOSED
Recall correctness        CLOSED
Retrieval ergonomics      CLOSED
Product surface           SHIPPED   (three tiers + /context status)
Status correctness        FIXED     (unknown!=0, estimated basis, DSH projection, current vs lifetime)
Tier steadiness benefit   HYPOTHESIS — the retention A/B measured no gain
route-level cost gate     OPEN
default                   legacy
```

---

## 6. Files

| file | change |
| --- | --- |
| `src/status.ts` | `currentContext`/`occupancy` optional; `archivedTokens` estimated; `usage` from the DSH projection; `checkpoints` vs `folds` split; `FoldLifetimeCounts` |
| `src/command.ts` | reads the `tokenUsage` projection; `readObservedUsage` deleted |
| `src/preset.ts` | retention-first ladder; `BALANCED_RETAIN_RATIO` / `QUALITY_RETAIN_RATIO` |
| `eval/real-task/driver.ts` | `ArmSpec.engine`; `BASIC_ARM` / `EF_ARMS`; real Basic mount |
| `eval/real-task/tasks.ts` | `LONG_CODING_TASK`, `LONG_RESEARCH_TASK`, `RETENTION_AB_TASKS` |
| `tests/rc2-status.spec.ts` | 13 new tests for the four corrections |
| `tests/rc2-tiers.spec.ts` | the ordering tests inverted to pin retention-first |
| `tests/rc2-real-task.spec.ts` | discriminating-power tests; arm-label tests |
| `tests/rc2b-live-retention-ab.spec.ts` | NEW — the single critical A/B |
| `docs/24_RC2_PRODUCT_INTEGRATION.md` | the `legacy`-vs-Basic correction, in place |

620 keyless tests pass, 22 skipped, typecheck clean.
