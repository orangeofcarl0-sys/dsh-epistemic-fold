# EF-C0 — Configuration Truth

Status: current implementation truth, 2026-11-08.

Authority order, when these disagree:

```text
1. resolveEfConfig / describeEffectiveConfig (the code)
2. this document
3. historical documents
```

Machine-readable companion: `docs/convergence/data/effective-config-matrix.json`
(25 scenarios, generated from the resolver). Runtime certification:
`tests/convergence-config.spec.ts` (13 tests).

## 1. The two switches are not the same switch

```text
semanticMode        none | rationale
                    whether a checkpoint asks the model for a rationale digest

semanticContinuity  off | shadow | active
                    whether a semantic writer runs, and whether what it
                    proposes may become state
```

They interact in exactly one place:

```text
semanticContinuity != off  REQUIRES  semanticMode == rationale
```

The reason is cost and honesty: the writer shares the rationale call, and
`semanticMode: none` is the zero-LLM profile. Enabling a writer under it would
upgrade that profile behind the deployment's back. Resolution throws rather than
discovering it at the first fold.

## 2. Tier truth table

| Tier | semanticMode | continuity default | rationale hint | retainRatio | framing | leaf admission | root policy | evidence status |
|---|---|---|---|---:|---:|---|---|---|
| `economy` | `rationale` | `off` | 400 | 0.16 (engine default) | `system-dedup` | `economic` | `economics` | measured (RC1.3) |
| `balanced` | `rationale` | `off` | 800 | 0.24 | `system-dedup` | `economic` | `economics` | hypothesis |
| `quality` | `rationale` | `off` | 1600 | 0.24 | `system-dedup` | `economic` | `economics` | hypothesis |

`legacy` is not a tier. Its resolved defaults are `semanticMode: rationale`,
`semanticContinuity: off`, hint 800, retain 0.16, framing `legacy`, leaf
`legacy`, root `legacy`.

`basic` is not a tier either. It delegates every fold to the vendored Basic
backend and mounts no EF surface.

## 3. Auxiliary calls: configured vs executed

A configuration field is not a call. This table is what the engine does on a
real fold, certified by the scripted-adapter tests.

| Configuration | Calls per fold | Which call |
|---|---:|---|
| `semanticMode: none`, continuity `off`, projection mounted | **0** | none |
| `semanticMode: rationale`, continuity `off`, projection mounted | **1** | visible rationale |
| continuity `shadow`, projection mounted | **2** | visible rationale + diagnostic writer |
| continuity `active`, projection mounted | **1** | combined handoff + deltas writer |
| any of the above, **no projection mounted** | **1** | Basic's full-checkpoint summary |
| `mode: basic` | **1** | Basic's full-checkpoint summary |
| `mode: basic` + continuity `active` | **1** | Basic's summary; the semantic layer is inert |

Two rows deserve emphasis:

1. **`semanticMode: rationale` without a projection does not call the rationale
   path.** With no machine state to render, the engine takes Basic's full
   summary. The field is configured; the call is not executed.
2. **`mode: basic` + `semanticContinuity: active` resolves but never writes.**
   The engine delegates every fold to Basic, so no writer runs and no journal
   file is created (tested by asserting the `semantic` directory does not
   exist). It is a contradictory configuration, but it is not a hidden state
   write.

`shadow` is the expensive measurement mode: it makes the visible rationale call
**and** a separate diagnostic writer call. A deployment that turns on shadow to
"measure without writing" pays two calls per fold, not one.

## 4. The documentation drift

`docs/ARCHITECTURE.md` §10 used to say:

```text
Economy   retain 0.16   semantic none
Balanced  retain 0.24   semantic none
Quality   retain 0.24   semantic rationale
```

That was true until **2026-10-18**, when commit `0376ca3`
("every tier carries the digest; the rungs differ by HINT BUDGET") changed all
three tiers to `semanticMode: 'rationale'`. The commit updated the preset, the
resolver, the plugin schema and nine test files; it did **not** update
`docs/ARCHITECTURE.md`.

Consequences, stated plainly:

- The historical table describes the pre-2026-10-18 configuration, not today's.
- The current architecture document now records the current truth and links
  here for the history.
- The preset was **not** changed back to match the old document. The change was
  deliberate: a checkpoint whose entire text was the marker left the model
  unable to tell what it was missing, so it could not decide to recall.
- The historical RC1.3 cost result (economy at `semanticMode: none`, about 17×
  cheaper than Basic on that probe) **does not transfer** to today's economy
  tier, which makes one rationale call per fold. It transfers only to the
  explicit zero-LLM profile.

This is the distinction the convergence documents must keep:

```text
Current implementation   every tier: rationale, differing hint budgets
Historical configuration economy/balanced: semantic none, before 2026-10-18
Experimental override    semanticMode: none, or continuity shadow/active
```

## 5. The true zero-LLM semantic baseline

```yaml
mode: economy            # or any tier; the tier only sets budgets
semanticMode: none
semanticContinuity: off
```

What this guarantees:

- no rationale call;
- no semantic writer call;
- no journal, no packet, no receipt;
- the checkpoint is rendered deterministically from state and the fold span.

What it does **not** guarantee: that the process makes no model call at all.
The fold itself is a compaction; Basic's transaction may still summarize when
no projection is mounted. "Zero-LLM semantic" means zero **auxiliary semantic**
calls, not zero calls in the system.

The `quality-zero-llm` matrix row is this configuration with the largest budget
tier, to show that a budget does not re-enable the face.

## 6. Is `basic` really "EF not mounted"?

Yes for surfaces, and the test asserts it on a mounted plugin:

```text
ctx.epistemicFold               absent
status projection               absent
context_search / context_recall absent
EF bundle                       absent
semantic writer calls           0
semantic journal directory      absent
checkpoint body                 Basic's, byte-identical
```

The engine still owns `ctx.compaction`; that is *how* it delegates. It reports
`basicMode: true` and `currentMode: 'basic'`.

Runtime switching in or out of `basic` is refused, because the surface is a
mount-time fact.

## 7. Explicit overrides

An explicit key always beats a tier. The fill is by omission, so the tier never
overwrites a value the deployment wrote.

Two subtleties the tests pin:

- `rationaleHintTokens: 1200` under `economy` is an **override**: the tier owns
  that key and proposed 400.
- `retainRatio: 0.3` under `economy` is **not** an override: `economy` never
  owned retention, so there is no preset value to disagree with. It still takes
  effect (0.3).

## 8. Invalid and unavailable configurations

| Configuration | Result | Why |
|---|---|---|
| unknown mode (typo) | throws at resolution | a named mode must not silently run `legacy` |
| `semanticMode: none` + continuity `shadow`/`active` | throws at resolution | would upgrade the zero-LLM profile |
| `system-dedup` without `ctx.systemPrompt` | throws at mount | refusing beats silently running costlier framing |
| continuity `active` with a null journal | throws at mount | a packet that can never commit is not staged |
| `basic` + continuity `active` | resolves; semantic layer inert | contradictory but harmless; tested |

## 9. Evidence

```text
eval/c0/config-matrix.mjs
docs/convergence/data/effective-config-matrix.json
eval/c0/out/config-matrix.json
tests/convergence-config.spec.ts    13/13
```

The matrix is generated by importing `resolveEfConfig` from `src/config/`. It
is not a transcription. A preset change changes the artifact on the next run.

## 10. Limits

- The matrix records resolution, not behavior. Section 3's call counts come
  from the tests, not from the matrix.
- The scripted adapter owns only the model text. Validation, planning, journal,
  commit and replay run for real.
- The tests use a fixture session, not a production long-horizon session.
- Cost per call is not measured here; R33–R37 hold the cost evidence.
