# RC2 — DSH Product Integration & Mode Tuning

Baseline: `main@dc9bff7` (RC1.3.1 merged; the core-research freeze).
Scope: the product surface. No context or retrieval research.

> **One-line result.** The three-tier mode surface ships, `/context status` ships
> against the real DSH command registry, and a real-task comparison ran 24 times
> across the four modes with a clean transport. **The comparison did not
> discriminate the modes**: TaskQuality saturated at 1.00 for every arm, and the
> single steadiness loss was not reproducible. That is a finding about the TASK
> SET, and it is reported as such rather than dressed up as a tier ranking.

---

## 1. What this stage was asked to do

Three things, and nothing else:

1. **Land the three-mode prototype** — `Economy`, `Balanced`, `Quality` — by
   composing capabilities the engine already has.
2. **Validate on real DSH tasks** rather than synthetic benchmarks, recording
   `Cost`, `TaskQuality`, and `EpistemicSteady` per mode, read as a timeline.
3. **Begin the user-interaction design**: expose only the three mode names, plus
   a `/context status` diagnostic, with internal parameters staying in advanced
   config.

`dc9bff7` is the frozen core-research baseline. Architecture research reopens
only on a real incident.

---

## 2. The three tiers

`src/preset.ts` now defines a ladder of three tiers. `legacy` is still a MODE —
the engine's own default and the frozen research baseline — but it is deliberately
NOT a tier: the product surface offers the ladder, and a deployment that
configured nothing is reported as `legacy`.

| tier | values it sets | claim | evidence |
| --- | --- | --- | --- |
| `economy` | economic admission, economic rebasing, `semanticMode: none`, `system-dedup` framing | lowest cost, quality at parity | **MEASURED** (RC1.3) |
| `balanced` | the same, with `semanticMode: rationale` | a small premium for narrative checkpoints | **HYPOTHESIS** |
| `quality` | the same, with `retainRatio: 0.24` | a larger premium for a larger verbatim tail | **HYPOTHESIS** |

Two rules keep the ladder honest, and both are enforced by tests:

**A tier is a named set of values, not a branch.** `resolveEfConfig({mode: 'quality'})`
is byte-identical to writing the keys by hand. There is no `if (mode === …)`
anywhere in the engine, so a tier can only choose among settings the engine
already supports and can never become a second source of truth for policy.

**A tier declares what is measured and what is a hypothesis.** `economy` cites
RC1.3. `balanced` and `quality` state plainly that their benefit is **unmeasured**,
and every surface that describes them says so — the effective-config report, the
`/context` command, and the tier ladder text all print the status. This is the
same rule that keeps OPEN distinct from PASS everywhere else in this project.

### The ladder varies one lever per rung

- `economy` → `balanced`: the semantic face only (`none` → `rationale`).
- `balanced` → `quality`: retention only (default → `0.24`).

Everything else is held identical, so a difference between adjacent rungs is
attributable to the one lever that changed. Tests assert this directly, and also
assert the negative: **no tier relaxes a safety lever to buy steadiness** — all
three keep economic admission, economic rebasing, and deduplicated framing,
because trading a measured gate for an unmeasured benefit is the wrong direction.

### Every rung actually resolves

A retention rung that exceeds its own fold threshold makes the engine THROW at
startup, so the tier suite resolves all three tiers against every window the
project ships an economics profile for, at two completion reservations, and
asserts retention stays strictly below the threshold. `0.24` is a checked value,
not a plausible one.

---

## 3. `/context status`

`src/status.ts` builds the model (pure, separately tested); `src/command.ts`
registers it.

The command registers through `ctx.inject(['commands'], …)`, because
`ctx.commands` is provided by `@deepseek-ai/dsh-commands`, which a compaction-only
deployment need not mount. Without a registry the command simply does not exist
and the plugin still mounts — the same rule the recall tools follow for
`ctx.tools`. A test mounts the plugin with no registry and asserts exactly that.

It reports every field the directive names:

```
context mode: economy
current context:  pressure, window, occupancy, fold threshold
archived history: archived tokens, archived messages, checkpoints
retrieval:        recalls, searches
folds:            leaf folds, root rebases, compactions, route, model changes
cost:             estimated/realized
```

### The rule that shapes every field

**A figure is reported as MEASURED or as ESTIMATED, never as a bare number.**
Token counts and counters come from the real meter and the real session log and
are `measured`; money is `estimated`, because the provider's bill is
authoritative and the projection applies published prices to the observed split.

When a figure cannot be established it is `undefined` and the renderer prints
`unknown` — **never a zero**. A session with no priced calls has an UNKNOWN cost,
and printing `0.00` would read as "this mode is free". Tests pin this in both
directions: an empty archive reports `0` (we looked, there is nothing), while an
unconsulted archive reports `unknown` (we did not look).

Two smaller honesty decisions: the cost line names the PROFILE it was priced
with rather than a currency, because the pricing schema declares no currency and
printing `USD` would assert something the data does not say; and the command is
registered on the COMMAND plane, not the tool plane, so it costs zero model
tokens — a diagnostic a user runs at any time must not consume the context it
reports on.

---

## 4. The real-task comparison

### The harness

Real tools over a real temporary directory: `write_file`, `read_file`,
`list_files`, `run_node`. Every path is resolved and confined to the workspace,
so a model emitting `../../etc/passwd` gets an error rather than a file. `run_node`
spawns a real Node process with a minimal environment — it does not inherit this
process's credentials — and bounds its output.

Three tasks, one per kind the directive names:

| task | kind | what it does |
| --- | --- | --- |
| `coding-paginate` | coding | write a paginating module, test it, run it |
| `research-retry-policy` | research | encode a retry policy as JSON, write a checker, run it |
| `tool-heavy-manifest` | tool-heavy | generate a schema, a sample, and a validator |

**Every task revises one of its own facts mid-task** — `pageSize` 10→25, timeout
1500→3000, score max 100→10 — and the facts are folded away BEFORE the work
begins. This is what makes `EpistemicSteady` measurable rather than decorative:
by the time the task needs them, the facts are inside checkpoints, and only what
the mode preserved can still be used.

`EpistemicSteady` is four **checkable probes**, not a rating: `constraint-retained`,
`revision-honoured`, `no-resurrection`, `interface-honoured`. A probe that cannot
be evaluated counts as FAILED, never as absent — an agent that produced nothing
has not demonstrated steadiness.

The driver mounts the real `EpistemicFoldPlugin`, so folds come from the
production policy; bills every call through the real recorder; and runs the
lifecycle scenarios the directive lists by appending what the runtime actually
records (`request/header` reason `resume`; the durable model-change notice).

### The result

24 runs, 4 modes × 3 tasks × 2 scenarios for two modes. **Transport was clean:
0 of 261 provider calls returned nothing.**

```
RC2 BY MODE (plain scenario, all tasks pooled)
  legacy    cost=0.001971  quality=1.00  steady=1.00
  economy   cost=0.003824  quality=1.00  steady=0.92
  balanced  cost=0.002083  quality=1.00  steady=1.00
  quality   cost=0.001927  quality=1.00  steady=0.92
```

> **RC2.1 CORRECTION — the `legacy` arm was mislabelled.** Every arm in this run
> was **EF**: the `legacy` arm mounted the EF *plugin* with the legacy *policy*,
> and this report described it as "Basic's own policy". Those are different
> things. EF-legacy still folds through the EF engine, still writes Bundles, still
> exposes the recall tools and the EF framing section; a real DSH Basic session
> has none of that. So the row above is **EF legacy**, not Basic, and the phrase
> "versus Basic" was not supported by it. RC2.1 made the engine an explicit arm
> field and added a real `basic` arm (`BasicCompactionEngine`, no Bundle, no
> recall tools) for runs that want that baseline. The numbers themselves are
> unchanged — only what they are called.

**The task set did not discriminate the modes.** Three observations, in order of
importance:

1. **TaskQuality saturated at 1.00 for every arm on every task.** These tasks are
   too easy: the model solved them regardless of mode. A quality metric that
   cannot fail tells us nothing about quality.
2. **The single steadiness loss was not reproducible.** `economy` and `quality`
   each lost `no-resurrection` once, on `research-retry-policy`. Re-running that
   exact cell produced **4/4** for both. At n=1 the loss is model variance, not a
   mode property — and I am reporting it as variance rather than as a tier
   difference, because the diagnostic re-run is the evidence and it disagrees.
3. **The pooled cost ordering is an artifact of one outlier.** `economy`'s pooled
   cost is inflated by a single `tool-heavy` run that made 22 tool calls where the
   others made 9–15 (cost 0.0082 vs 0.0016–0.0032). Per task, `economy` was the
   CHEAPEST arm on `coding-paginate`. Pooling n=1 across tasks with different call
   counts produces an ordering that no per-task reading supports.

### What the ladder claim got

The tiers claim a steadiness benefit for a cost premium. **This sample neither
confirms nor refutes it**: no rung measured higher than `economy` on steadiness
in a way that survived re-running, and no rung cost more. The honest reading is
that the measurement was underpowered for the question — which is exactly what
`evidence: 'hypothesis'` says, and the tiers keep that status.

### The lifecycle scenarios

| scenario | arm | cost | quality | steady |
| --- | --- | --- | --- | --- |
| restart | legacy | 0.002301 | 1.00 | 1.00 |
| restart | economy | 0.002802 | 1.00 | 0.92 |
| model-switch | legacy | 0.003905 | 1.00 | 0.92 |
| model-switch | economy | 0.003763 | 1.00 | 0.92 |

No scenario produced a mode-dependent failure. A session that folded, restarted,
and continued still produced the artifact to the corrected spec in every run —
which is a real positive result for the fold/recall contract under restart, even
though it does not separate the modes.

---

## 5. What would have to change to answer the ladder question

Recorded so a later stage does not repeat this run expecting a different answer:

1. **Harder tasks.** Quality must be able to FAIL. A task the model solves in
   every mode cannot rank modes. The natural fix is length: more work after the
   facts are folded, so the session must actually depend on what it kept.
2. **More replicates per cell.** n=1 cannot separate a mode effect from model
   variance, and this run proved that empirically — the same cell gave 0.75 and
   1.00 on consecutive attempts.
3. **A steadiness probe that can be lost by a mode, not only by a mistake.** All
   four current probes are satisfied by any competent run, so they measure "did
   the model do the job" more than "did the mode preserve the fact".

None of these is a code defect. They are properties of the instrument, and
changing them is a new stage's decision, not this one's.

---

## 6. State after RC2

```
Compression architecture  CLOSED
Recall correctness        CLOSED
Retrieval ergonomics      CLOSED
Product surface           SHIPPED   (three tiers + /context status)
Tier steadiness benefit   HYPOTHESIS — not confirmed by this sample
route-level cost gate     OPEN
semanticMode              none for economy; rationale for the upper tiers
default                   legacy
```

The three tiers are available to select. `economy` is the only one with measured
end-to-end evidence behind it. `balanced` and `quality` are shipped as declared
hypotheses, marked as such on every surface that describes them.

---

## 7. Files

| file | change |
| --- | --- |
| `src/preset.ts` | the three-tier ladder, `TierDefinition`, evidence status, `tierLadder` |
| `src/policy.ts` | `mode` widened to `FoldModeName`; `DEFAULT_RETAIN_RATIO` exported |
| `src/effective-config.ts` | generalized to any tier; reports the tier's claim and evidence |
| `src/status.ts` | NEW — the pure status model, `measured` vs `estimated`, `unknown` never zero |
| `src/command.ts` | NEW — `/context status`, registered through the real `ctx.commands` |
| `src/plugin.ts` | registers the command via `ctx.inject(['commands'], …)` |
| `eval/real-task/workspace-tools.ts` | NEW — real confined filesystem/exec tools |
| `eval/real-task/metrics.ts` | NEW — the three metrics; `assertsValueAsCurrent` |
| `eval/real-task/tasks.ts` | NEW — three real tasks, each with a mid-task revision |
| `eval/real-task/driver.ts` | NEW — mounts the real plugin, runs one task per arm |
| `tests/rc2-tiers.spec.ts` | NEW — 26 keyless tests |
| `tests/rc2-status.spec.ts` | NEW — 22 keyless tests |
| `tests/rc2-real-task.spec.ts` | NEW — 22 keyless tests |
| `tests/rc2a-live-real-task.spec.ts` | NEW — the live comparison |
| `tests/harness.ts` | `commands` mount; `efConfig` now uses the real config type |

598 keyless tests pass, 21 skipped, typecheck clean.

---

## 8. Two defects the work surfaced

Both were in MY instrument, and both would have manufactured a mode difference:

1. **The `named-export` quality check rejected correct work.** It accepted only
   ESM syntax, so a live run that used `module.exports = { paginate }` — a
   perfectly good named export — was scored as a failure. Fixed to accept both
   module systems, and pinned by a keyless test.
2. **The `no-resurrection` probe was a substring test.** A correct answer that
   NAMES the superseded value ("25, superseding the earlier 10") would have been
   scored as a resurrection. Replaced with `assertsValueAsCurrent`, which splits
   into clauses and only counts a clause that asserts the value as current with
   no obsolescence marker — the same reasoning RC1.3's `assertsSupersession` used.

A third, smaller one: a Python heredoc silently converted `\b` escapes into
literal backspace characters in a probe regex, which would have made that probe
pass vacuously. Caught by the test that asserts the probe can FAIL.
