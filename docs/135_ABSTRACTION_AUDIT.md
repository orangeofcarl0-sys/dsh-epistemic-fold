# 135 — Abstraction audit: the config chain, the telemetry vocabulary, and the checkpoint-rendering cluster

Status: **ANALYSIS ONLY.** 2026-10-18. No source file was modified. Every count below was
re-measured on the current tree; the config chain is corroborated by the commit that performed it
(`0376ca3`), and the two failure modes were reproduced read-only with
`node --experimental-transform-types`.

Read first: `docs/68_STRUCTURAL_AUDIT_AND_PLAN.md` §4 (which refuted C2's consequence) and §5
(which declined C-1 on that basis).

---

## 1. The config chain, counted

### 1.1 One key, site by site

`rationaleHintTokens` was added by `0376ca3` ("every tier carries the digest; the rungs differ by
HINT BUDGET"). `src/` now holds **53 modules / 13,927 lines** (excluding `basic/`), and
`EF_OWNED_CONFIG_KEYS` holds **18 keys** (docs/68 counted 17).

| # | site | file:line | what it is |
|---|---|---|---|
| 1 | resolved interface | `src/policy.ts:70-71` | `ResolvedEpistemicFoldConfig.rationaleHintTokens` |
| 2 | default constant | `src/policy.ts:198-204` | `DEFAULT_RATIONALE_HINT_TOKENS = 800` (**not exported**) |
| 3 | input interface | `src/policy.ts:237-244` | `EpistemicFoldConfig.rationaleHintTokens?` |
| 4 | resolve + validate | `src/policy.ts:341-344` | `?? DEFAULT_RATIONALE_HINT_TOKENS` + the positive-integer throw |
| 5 | return object | `src/policy.ts:414` | the resolved field |
| 6 | **strip list** | `src/policy.ts:527` | `EF_OWNED_CONFIG_KEYS` |
| 7 | report list | `src/effective-config.ts:78` | `PRESET_OWNED` |
| 8 | report defaults | `src/effective-config.ts:88` | `ENGINE_DEFAULTS` — a **literal `800`**, not the constant |
| 9 | preset key list | `src/preset.ts:136` | `PRESET_KEYS` |
| 10-12 | three tiers | `src/preset.ts:234, 259, 299` | one `values` entry per rung |
| 13 | tier constants | `src/preset.ts:160-162` | `ECONOMY/BALANCED/QUALITY_RATIONALE_HINT_TOKENS` = 400/800/1600 |
| 14 | zod schema | `src/plugin-config.ts:60` | `rationaleHintTokens: z.any()` |
| 15 | consumer | `src/engine.ts:1917` | `hintTokens: this.efConfig.rationaleHintTokens` |
| 16 | scenario value | `eval/live/scenarios.ts:145` | `rationaleHintTokens: 400` |

**Count: 14 registration sites + 1 consumer = 15 code edits in 5 files** (16 edits / 6 files with the
eval scenario). sites 1-6 are one file, and 4 of the 6 are in the resolver.

### 1.2 What each omission actually does — measured

Reproduced read-only against the real modules:

```
schema pass-through bogusKey: 1 | rationaleHintTokens: 400     <- schemastery passes UNDECLARED keys
unstripped key -> BasicCompactionConfig: unknown key "bogusKey"
efOwned includes rationaleHintTokens: true
stripped object still has it: false
resolveConfig(stripped) -> OK
EXACT INCIDENT ERROR -> BasicCompactionConfig: unknown key "rationaleHintTokens"
```

The last line is the incident reproduced: strip every EF-owned key except the new one from
`resolvePreset('economy', {})` and `src/basic/config.ts:338` throws it.

| omitted site | consequence | caught by |
|---|---|---|
| 1, 2, 5 | compile error (missing property / use before declaration) | tsc |
| 3 | TS callers cannot set it; a loader/YAML config still passes it through | nothing for the YAML path |
| 4 | a negative or fractional hint reaches the prompt | **nothing** (`grep 'rationaleHintTokens must be' tests/` = 0) |
| 6 **strip list** | **HARD RUNTIME at mount**, for every config whose tier supplies the key (all three tiers do) | **nothing** |
| 7 `PRESET_OWNED` | the effective-config report silently omits the row | `rc0a-config-contract`, `rc2-tiers` |
| 8 `ENGINE_DEFAULTS` | report prints `undefined [engine-default]`; the literal `800` can drift from policy's private constant | **nothing** (no test compares the two) |
| 9 `PRESET_KEYS` | compile error if a tier sets it (`PresetKey` union) | tsc |
| 10-12 a tier entry | that rung silently inherits the engine default (economy reports 800, not 400) | `rc2-tiers` ordering tests |
| 14 zod schema | the B-5 set-equality test fails; **no runtime effect** (pass-through, re-verified) | `plugin-composition.spec.ts:243` |
| 15 consumer | **SILENT NO-OP** — the key resolves, validates, is reported, and does nothing | **nothing** |

**Correction to the incident's attribution.** The hard error comes from **site 6**
(`EF_OWNED_CONFIG_KEYS`, `policy.ts`), not from `plugin-config.ts`: schemastery passes an undeclared
key through (re-measured above), and only the strip list keeps an EF key out of Basic's strict
validator. The schema omission produces the *test* failure. Both were missed, which is the point —
but they are different mechanisms with different guards, and the guard that exists covers the wrong
one:

* `tests/plugin-composition.spec.ts:251` asserts `efOwnedConfigKeys() ⊆ schema.dict`. It cannot see
  a key that is **in the schema but missing from the strip list** — the hard direction.
* `tests/r2b-admission.spec.ts:74-83` asserts `toContain` for 8 hardcoded names. It cannot see a
  new key at all.
* Nothing enumerates the *interface* (erased at runtime); the only value-level list is the one under
  test.

The reported symptom ("two Python fixtures failed to load entirely") is fully explained by site 6:
no fixture has to name the key, because `resolvePreset` supplies it for every tier mode, so **every
economy/balanced/quality mount fails**. No Python file in the tree names the key (grep: 0), which is
consistent with that mechanism rather than with a fixture that sets it explicitly.

### 1.3 Was C-1's decline right? Does the incident change it?

docs/68 §4 measured the **schema** and found it descriptive: an omission there costs documentation,
not function. That measurement is correct and I re-confirmed it. §5's decline then generalized:
*"config drift whose functional impact I measured as zero"*. **That generalization is falsified** —
the schema was one site class, and the site class that bites is the strip list, where drift is a
mount failure.

The decline was still **right as written**: C-1 was scoped as an L-cost refactor of the config core,
and a full key table would derive the two interfaces and the bespoke resolver too. The resolver holds
**20 hand-written throws** with pinned messages (`tests/r2b-admission.spec.ts:66-68`), the interfaces
carry per-field measured JSDoc that docs/68 §6 protects, and `plugin-config.ts:52-57` explicitly
forbids moving which layer rejects a bad value. Deriving all of that changes error text and types —
a behaviour change dressed as a refactor, which is exactly what docs/68 A-2 refused to smuggle.

**So: reopen C-1, but scoped down (M, not L).** Derive only the four *lists* — strip list,
`PRESET_KEYS`, `PRESET_OWNED`, `ENGINE_DEFAULTS` — plus the schema's EF block, from one table of
`{name, default, presetOwned}`. Keep the interfaces and the resolver. §7's numeric revisit triggers
are *not* met (src is 13,927 lines, not ~20,000; three files exceed 600 lines, not five), so the
justification is the failure, not the size.

### 1.4 Cost comparison

| | (a) explicit-everywhere (today) | (b) one key table (scoped as above) |
|---|---|---|
| edits per new key | 15 in 5 files | 1 table entry (+1 validator, +1 tier value) |
| sites that are pure duplication | 4 lists + 1 literal (`PRESET_KEYS` ≡ `PRESET_OWNED`; `ENGINE_DEFAULTS.rationaleHintTokens` re-types a private constant) | 0 |
| worst failure mode | mount failure, unguarded (site 6) | impossible: a table key is in the strip list by construction |
| second-worst | silent no-op consumer; report literal drifting from the real default | unchanged (consumer and interfaces stay hand-written) |
| build cost | 0 | **M** — one table, four derivations, one schema block |
| risk | — | **low-med**: error messages, types and the `z.any()`-vs-typed distinction must be preserved; a set-equality test pins the derivation |
| what it does not fix | — | the consumer wiring (site 15) and per-field JSDoc remain manual |

A 3-line test would make today's design nearly as safe for site 8:
`describeEffectiveConfig({}).settings.find(k => k.key === 'rationaleHintTokens').value` must equal
`resolveEfConfig({}).rationaleHintTokens`. It fails today only by luck that both literals are 800.

---

## 2. Telemetry vocabulary: three sites, four ghost keys

| site | vocabulary | size |
|---|---|---|
| `src/fold-telemetry.ts:35-160` | `FoldTelemetry` — the engine's record | **18 fields** |
| `eval/tau2/bridge-host.ts:1931-1995` | the wire `Telemetry` object | **42 top-level keys** |
| `eval/memory/run_cell.py:510-518` | the artifact whitelist | **27 keys** |

The three are maintained by hand, in three languages/files, with no shared list and no test that
compares them. Four of the 27 whitelisted keys **do not exist on the wire**:

| key | in `FoldTelemetry`? | in the bridge object? | in the artifacts |
|---|---|---|---|
| `leafAdmission` | yes (`:123`) | **no** (0 occurrences in `bridge-host.ts`) | `null` in all 15 result files |
| `postLeafRegime` | yes (`:137`) | **no** | `null` |
| `foldReachability` | yes (`:157`) | **no** | `null` |
| `thresholdTokens` | yes (`:105`) | only nested inside `compactBudget` | `null` |

Evidence: `eval/memory/result_*.json` records `"postLeafRegime": null`, `"leafAdmission": null`,
`"foldReachability": null`, `"thresholdTokens": null` in **15 of 15** files (e.g.
`result_A_economy_logical.json:1760,1768,1777`). The whitelist's own comment
(`run_cell.py:498-509`) says it was widened on 2026-10-17 *because* it dropped the fields that
explain WHY something happened, and names `leafAdmission` as the specific fix — but that key is
`null`, so the widening did not achieve its stated purpose.

**Ownership.** `FoldTelemetry` is the model (one field per measured failure, with the failure
recorded beside it). The bridge is a **projection** and should be checked against the model, not
re-listed. The Python whitelist is a *reader* choice and must be checked against the projection.
Two concrete symptoms of the missing owner:

* The same insertion artifact appears twice: `src/fold-telemetry.ts:173` and
  `eval/tau2/bridge-host.ts:1968` both put two fields on one line
  (`rationaleChars: 0,    thresholdTokens: 0` / `rationaleChars: engine!.rationaleChars,    providerFailures,`)
  — the same new fields were added by hand in both places.
* The vocabulary is already stale in place: `src/fold-telemetry.ts:93` documents
  "`RATIONALE_MAX_TOKENS` is 400", a constant that no longer exists anywhere in `src/` (the output
  budget is now derived by `rationaleOutputFor`, `src/rationale.ts:121-123`, floor 16,384).

**Names for one thing, three ways:** the engine's record field is `leafAdmission`
(`LeafAdmissionVerdict`), the engine's getter is `lastLeafAdmission` (`engine.ts:447`), the wire key
is `lastLeafDecision` — and that one is a **different object**: a diagnostic STRING
(`engine.ts:1143`, e.g. `'below-threshold 1234<2000'`), not the verdict. Python asks for
`leafAdmission` and gets `None`; a reader who saw `lastLeafDecision` in the artifact would be
reading the string and believing it was the verdict.

---

## 3. The checkpoint-rendering cluster

Six modules, **2,211 lines = 16% of `src/`**: `state.ts` 361, `status.ts` 661,
`status-projection.ts` 528, `renderer.ts` 207, `compiler.ts` 199, `inventory.ts` 255.

| module | responsibility | plane |
|---|---|---|
| `state.ts` | anchor model + deterministic reducer + 2 quality metrics | data |
| `renderer.ts` | project state → presentation; render the structured body | text (model-visible) |
| `compiler.ts` | split summarization input; fallback/semantic text; framing preamble; **bundle assembly** | text + artifact |
| `status.ts` | the `/context status` model and its two renderings | text (human) |
| `status-projection.ts` | the Sidebar wire projection | wire (client) |
| `inventory.ts` | archived-item inventory, derived-answer sentinels and retirement | archive policy |

**The four functions are clearer than the module layout suggests.** Inside `renderer.ts` the relation
is clean and single-sourced: `projectForCheckpoint` (`:81`) is the one projection;
`machineAnchorCount` (`:75`) and `describeRenderedState` (`:160`) both derive from it;
`renderStructuredCheckpoint` (`:171`) renders it. The problem is the seam:

* `renderFallbackCheckpoint` (`compiler.ts:75`) renders the SAME checkpoint identity from a
  **different input type** (`FoldCandidate` vs `FoldCurrentState`), in a different module, and does
  not pass through `projectForCheckpoint`. `renderSemanticCheckpoint` (`compiler.ts:84`) is a third
  body shape. There is no `renderCheckpoint(kind)` dispatcher; the choice lives in `engine.ts`
  (`:1841` fallback, `:2061` structured). `compiler.ts` also owns `buildBundle`/`buildArchiveRefs`,
  which are not rendering at all.
* `describeRenderedState.anchors` (`renderer.ts:167`) re-derives the count that
  `machineAnchorCount` already exposes — the same number, two functions.
* Two JSDoc blocks document nothing: `renderer.ts:117-142` ("Render the machine-state handoff…",
  with `@param checkpointId`) now sits above `describeRenderedState`, and `compiler.ts:40-46`
  ("Deterministic checkpoint body…") sits above `fallbackCheckpointLines`. Both were orphaned by
  inserting a new declaration between a doc and its function.

A scan of `src/` (excluding `basic/`) for a JSDoc block immediately followed by another finds **11
sites; 3 are legitimate module docs, so 8 are orphaned** — 5 of them in `engine.ts` (e.g. `:107-126`
and `:127-147` are **two stacked docs for the same deleted `RATIONALE_MAX_TOKENS` constant**, with
no declaration between or after them), plus `compiler.ts:40`, `renderer.ts:117`, `preset.ts:143`
(the `BALANCED_RETAIN_RATIO` doc, detached by `0376ca3` inserting the hint constants).

**`status.ts` vs `status-projection.ts`** is the real overlap: 18 fields vs 17, of which ~11 are the
same quantities (mode, folds/roots/emergencies, checkpoints, recalls, searches, archived tokens,
cost, costProfileId, usage). They are **two independent derivations from different inputs** — live
engine state + bundle store vs the folded event log — and the divergence is documented as honest
(`status-projection.ts:30-34`). The cost is that a new status figure needs both, in two different
shapes, plus `ContextStatus`'s text renderer and the wire schema.

`inventory.ts` does **not** belong to this cluster: it is archive content policy (sentinel
recognition, derived-answer retirement), not rendering. It shares vocabulary ("inventory of the
checkpoint") and nothing else.

---

## 4. Misleading names

| name | the two meanings | evidence |
|---|---|---|
| `basic` | the vendored DSH Basic engine vs `mode: 'basic'` (EF stands aside) | `src/basic/` (5 files) vs `src/preset.ts:97` `BASIC_MODE`; `isBasicMode` vs `isTierMode` |
| `compiler` | `compiler.ts` (checkpoint text + bundle) vs `policy-compiler.ts` (rebase/policy decision) | `src/compiler.ts:75` vs `src/policy-compiler.ts:1-30`; both imported by `engine.ts` |
| `status` | `status.ts` (command text) vs `status-projection.ts` (client wire) | 2 modules, 2 planes, 11 shared figures |
| `state` vs `status` | the anchor state (data) vs the human status model | `state.ts:87` vs `status.ts:119` |
| `leafAdmission` / `lastLeafAdmission` / `lastLeafDecision` | a verdict object vs a verdict getter vs a diagnostic string | `fold-telemetry.ts:123`, `engine.ts:447`, `engine.ts:1143`; Python asks for the first and gets `null` |
| `PRESET_KEYS` / `PRESET_OWNED` | the same 6-key list, two names, two files | `preset.ts:132-139` ≡ `effective-config.ts:74-81` |
| `semanticMode: 'none'` | "no LLM call" (engine branch, `engine.ts:1945`) — but **no tier sets it any more**; `economy`/`balanced` are `'rationale'` | `preset.ts:228-233`: the comment still says *"No LLM call for a checkpoint"* directly above `semanticMode: 'rationale'` |
| `rationaleHintTokens` vs the real budget | the instruction's hint (400-1600) vs the derived output budget (floor 16,384) | `policy.ts:238-241`; `rationale.ts:101-123`; stale `RATIONALE_MAX_TOKENS` reference at `fold-telemetry.ts:93` |

The `preset.ts` pair is worth quoting because it is self-contradicting within 25 lines: `:228-232`
justifies `semanticMode: 'rationale'` with *"No LLM call for a checkpoint… an auxiliary call is not
needed"*, while `:253-255` says the rungs are *"Identical to economy on … the semantic face, so the
ONLY difference between the two rungs is retention"* — when the difference is now
`rationaleHintTokens` (400 vs 800), exactly as the new comment at `:151-159` states. `0376ca3`
flipped the values and left both comments behind.

---

## 5. The three highest-value abstraction changes

### 5.1 One table for the EF-owned key vocabulary — M, risk low-med

**What.** A single `EF_KEYS` table of `{name, default, presetOwned}` in `policy.ts`. Derive
`EF_OWNED_CONFIG_KEYS`, `PRESET_KEYS`, `PRESET_OWNED`, `ENGINE_DEFAULTS` and the schema's EF block
from it. Leave the interfaces, the resolver and its 19 messages alone.
**Why.** Four of the 14 sites are the same list written four times, and the one site whose omission
is a mount failure (site 6) becomes impossible. `ENGINE_DEFAULTS`' literal `800` is already a
latent drift from a private constant.
**Risk.** low-med: the derived schema block must keep `z.any()` where the typed declaration would
move which layer rejects a value (`plugin-config.ts:52-57`); pin the derivation with the set-equality
test that already exists.
**Makes cheaper:** every future config key (15 edits → 1-3), and every future *default* change, which
today must find a second literal in `effective-config.ts`.

### 5.2 One telemetry vocabulary owner, with the projection asserted — S/M, risk low

**What.** Make `FoldTelemetry` the model; add a test that every key the bridge's `Telemetry`
declares exists in `FoldTelemetry` (or is explicitly bridge-only), and a second that every key in
the Python whitelist exists in the bridge object. Neither test needs a running episode: both files
are parseable text.
**Why.** Four whitelisted keys are `null` in 15 of 15 artifacts, so a widened whitelist silently
records nothing; the `leafAdmission`/`lastLeafDecision` rename has already diverged across the
process boundary; and a new counter is currently a 2-file hand edit with a formatting artifact at
both ends.
**Risk.** low: test-only plus one documented list. The Python check can read the tuple with a regex
from the test, so the whitelist stays hand-written where it belongs (a reader's choice).
**Makes cheaper:** every new counter, and every cross-language field rename — which is the class of
edit that has already produced four null columns.

### 5.3 One checkpoint-text owner — S, risk low

**What.** Move `renderFallbackCheckpoint`, `renderSemanticCheckpoint`,
`fallbackCheckpointLines`/`isFallbackCheckpointLine` into `renderer.ts` beside
`renderStructuredCheckpoint`, expose one `renderCheckpoint(kind, …)` dispatcher, and leave bundle
assembly in a `bundle.ts` (renamed from `compiler.ts`). Re-attach the two orphaned JSDoc blocks.
**Why.** Three body shapes for one artifact identity live in two modules with two input types and no
dispatcher; the engine chooses between them at `:1841` and `:2061`; and the orphaned docs show the
seam has already confused its own authors. `describeRenderedState.anchors` should call
`machineAnchorCount` rather than re-derive it.
**Risk.** low: pure moves plus one new function; `src/index.ts` already re-exports the names, so
callers do not move.
**Makes cheaper:** every change to what a checkpoint says (one file, one dispatch point) and every
change to the fallback/boilerplate recogniser, which currently has to import across the seam.

**Not picked, deliberately.** Merging `status.ts` and `status-projection.ts` — their divergence is
documented as honest (two data sources, different quality), the shared model would have to serve
both planes, and the change is M/L with a real risk of collapsing a measured figure into an
estimated one. Do it only when a *third* status renderer appears. `inventory.ts` stays where it is:
archive content policy, not rendering.

---

## 6. Method and limits

* Counts are from the current tree and from `git show 0376ca3`; the failure modes were reproduced
  with the real modules (`resolveEfConfig`, `stripEfConfigKeys`, `resolvePreset`,
  `EpistemicFoldPluginConfig`, and Basic's `resolveConfig`), no episode and no model call.
* The incident itself is **not recorded in `docs/`** (`grep 'unknown key|rationaleHintTokens' docs/`
  finds only docs/68's schema note), so its reproduction above is the evidence rather than a citation.
* The two Python fixtures named in the brief could not be located: no `.py` file names
  `rationaleHintTokens`. That is consistent with the mechanism at site 6 — the tier supplies the
  key, so no fixture needs to.
* `engine.ts` has grown from 1,653 lines (docs/68 §8, after B-1) to **2,147** while `src/` went
  49 → 53 modules. Concentration is re-accumulating; that is a size signal, not a finding on its own.
