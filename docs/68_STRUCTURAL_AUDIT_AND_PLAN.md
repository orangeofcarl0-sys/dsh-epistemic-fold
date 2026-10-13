# 68 — Structural audit and the optimisation plan

Status: ANALYSIS COMPLETE, plan judged, nothing implemented. Four read-only analysts worked
disjoint scopes in parallel with the Lead's own measurement; every finding below carries a
verification verdict, and **two of the four reports contained a claim that measurement
contradicted** (§4).

## 1. The measurement

| layer | files | lines | note |
|---|---|---|---|
| `src/` (shipped) | 49 | 12,999 | of which `src/basic/*` is VENDORED: 5 files, 1,781 |
| `tests/` | 129 | 29,361 | 120 specs + 8 helpers |
| `eval/` (code) | 46 | 17,292 | plus **156,093 lines of checked-in JSON/txt** |
| root `ef-*.sh` + `scripts/` | 31 | ~2,700 | 27 root launchers |
| `vendor/deepseek-harness/` | — | — | 2.1 GB, git-ignored, untracked |

**Size distribution of `src/`** — this is the load-bearing number:

```
<100 lines   10 files      600-999 lines   3 files  (basic/region.ts, status.ts, subagent-recall.ts)
100-299      23 files      1000+           1 file   (engine.ts, 1,700)
300-599      12 files
```

**Only 4 of 49 shipped files exceed 600 lines.**

**Duplication in `src/`, measured strictly** (identical 6-line windows containing at least four
substantive lines): **9 windows, ~54 redundant lines.** A looser filter reports ~306, but it is
counting closing braces; the strict number is the honest one.

**Change spread**: recent commits touch 5–12 files across 3–5 layers (`src`+`tests`+`eval`+`docs`).

## 2. The verdict

**This is not a big ball of mud. It is a well-factored codebase with four oversized units and an
expensive registration path.** The distinction decides the whole plan:

* Duplication is NOT the problem (~54 lines). Any plan built on "deduplicate `src`" is fixing
  something that is not broken.
* Tangling is NOT the problem either — `types.ts`/`policy.ts`/`preset.ts` carry the highest fan-in
  (16/15/14), which is normal for a config vocabulary hub.
* The problems are **concentration** (`engine.ts` 1,700 lines / 21 getters / 10 overrides;
  `plugin.ts` one 187-line constructor; `subagent-recall.ts` 841 lines I wrote this session) and
  **cost-per-change** (a new config key = 5 sites in 4 files; a new recall mode = ~60 lines of
  hand-written tool definition plus wiring in 3 files).
* The largest *quantity* problem is the eval layer: **46,653 lines of eval+test scaffolding against
  12,999 shipped lines**, plus 156,093 lines of committed corpus. That is a policy question, not a
  refactor (see §5, Tier D).

## 3. Findings, with a verification verdict on each

`VERIFIED` = I reproduced the count or read both sites myself. `UNVERIFIED` = the analyst gave
specific line references but I did not re-check them; treat as a lead, not a fact.

### Engine (1,700 lines)

| # | finding | verdict |
|---|---|---|
| A1 | `EpistemicFoldEngine` carries fold orchestration, rebase policy, rendering AND a telemetry bus: **15 of 19 mutable fields are one-to-one with a getter** (of 21 public getters) | **VERIFIED** — I counted the same 15 `*Value` fields |
| A2 | `compactIfNeeded` is a 250-line method with 13 exit paths; `pressureBreakdown` is recomputed rather than carried | **VERIFIED** — 9 call sites (615, 858, 941, 1047, 1120, 1137, 1154), and **1163 + 1164 are the identical call twice in one string concatenation** |
| A3 | `leaf-policy.ts` mirrors ~16 lines of the vendored `basic/region.ts` | UNVERIFIED (plausible; both files exist and the rule is known to be duplicated) |
| A4 | The compaction-lock invariant is enforced at 4 sites over 3 implementations | **VERIFIED** — `hasActiveCompaction` (frontier) at engine 793/1097, `assertCompactionInactive` (vendored) at region 197/341, and the message copy-pasted at engine 794, engine 1099, region 330 |
| A5 | Model-capacity/spec resolution copy-pasted 4x, plus the error string twice | **VERIFIED** — `resolveEfCompactSpec` at engine 567, 609, 803, 1113; the message at 798 and 1109 |
| A6 | 5 `isBasic()` branches held together by a test rather than a type | UNVERIFIED |

### Recall surface

| # | finding | verdict |
|---|---|---|
| B1 | `subagent-recall.ts` is five modules in one file: telemetry, gate, descriptors, loop, transport (841 lines, 37 exports) | **VERIFIED** — I wrote it this session in exactly those five parts |
| B2 | `recall.ts` duplicates depth dispatch, paging and corruption handling between the direct and foreign paths (~40 of 528 lines), and they have already diverged | UNVERIFIED (line refs are specific) |
| B3 | `estimateRenderedChars` is re-implemented next to `tools.ts`, and the span is byte-identical to `sourceRangeOf` — which the file already imports from | **VERIFIED** — `recall.ts:269-275` vs `subagent-recall.ts:335-338` are the same computation |
| B4 | `tools.ts` holds 5 responsibilities, and the gate DECISION is separated from its verdict function | **VERIFIED** — I wrote the split |
| B5 | The store/archive funnel is reached through at 3 layers | PARTIAL — `store.verify`/`store.read` are called from both `recall.ts` and `tools.ts` |
| B6 | A third recall mode has no extension point | **VERIFIED** by construction |

### Config and plugin

| # | finding | verdict |
|---|---|---|
| C1 | EF owns 17 keys; a new one costs 5-11 registration sites in 4 files | **VERIFIED** — 17 keys at `policy.ts:504-522`; my own `subagentRecall` touched 4 shipped files |
| C2 | The drift guard does not guard: the plugin Config schema declares 19 keys and omits 9 of the 17 EF-owned ones, with no test referencing `EpistemicFoldPlugin.Config` | count **VERIFIED** (19 vs 17, 9 omitted), **inferred harm REFUTED — see §4** |
| C3 | `plugin.ts` is one 187-line constructor doing ~12 jobs | **VERIFIED** — 1 `provide`, 3 `inject`, 1 `plugin`, 5 `register*`, 1 `systemPrompt.section` in one function |
| C4 | Enums are validated twice (schema + resolver) and ranges once, invisibly | PARTIAL — the schema declares bare `z.number()` for the sizes; `policy.ts` validates the ranges |
| C5 | `effective-config.ts` resolves the config a third time and hand-mirrors keys and defaults | UNVERIFIED |
| C6 | `status-projection.ts` writes its 19-field state 3x and its 17-field view 3x | UNVERIFIED (528 lines makes it plausible) |

### Eval and harness

| # | finding | verdict |
|---|---|---|
| D1 | 27 root launchers; 24 hardcode the same `EF_HOME`; 9 repeat the sweep-wave body; `EF_USE_PROXY` defaults 0 in one launcher and 1 in three | **VERIFIED for the divergence** (`run-tau2.sh:93` `:-0` vs `run-lhtb.sh:218` `:-1`) — but docs/50 and docs/52 record the per-host rationale, so it is duplication with a documented intent, not a plain bug |
| D2 | The runtime mount sequence is hand-wired in 4 places, and `tests/harness.ts` mounts the pruner as `{}` while production uses `{thresholdChars: 8192, ...}` | **VERIFIED** — `tests/harness.ts:242` vs `eval/tau2/bridge-host.ts:1388` |
| D3 | The two Python lanes duplicate argument parsing, bundle-root resolution, and use two env names for one concept | UNVERIFIED |
| D4 | Tests assert on eval SOURCE TEXT rather than exercising it | UNVERIFIED, but it matches a rule the repo already states in its own words (`lhtb-runner-dispatch.spec.ts:26`) |
| D5 | eval is 3.6x the shipped code; `bridge-host.ts` (1,678 lines) is the largest file in the repo; `probes.json` is byte-identical to `answer_key.json` and "read by nothing" | identity **VERIFIED** (both `6d603a92c5299d0a`); **"read by nothing" REFUTED — see §4** |
| D6 | Shipped `src/` carries two process-global reset hooks whose only callers are the eval bridge and tests | **VERIFIED** — zero callers inside `src/` |

## 4. The two claims measurement contradicted

Both were the analyst's own TOP-3 pick, and both were a real COUNT attached to a wrong
CONSEQUENCE. This is why the count is not the finding.

**C2 — "a loader deployment setting `referentialArchive` is dropped or rejected at mount."**

I ran the plugin's own schema function on a config carrying the keys it supposedly omits:

```
P.Config({ bundleRoot, mode, referentialArchive: true, allowCrossSessionRecall: true,
           leafAdmission: "economic", subagentRecall: true, bogusKey: 1 })
  -> ACCEPTED. referentialArchive survived: true
     allowCrossSessionRecall survived: true   leafAdmission survived: "economic"
     subagentRecall survived: true            bogusKey survived: 1
```

schemastery here **passes unknown keys through**. The schema is a union of EF and Basic keys and
is descriptive, not restrictive. So the 9-key omission costs *documentation and range checking*
— `z.number()` accepts `-1` — and nothing functional. C2 drops from "live defect, fix first" to
"cheap completeness check, do it in Tier B".

**D5 — "`probes.json` is read by nothing, so delete it."**

The identity is real: `answer_key.json` and `probes.json` both hash to `6d603a92c5299d0a`. But
`probes.json` has **22 reader references**, including `eval/memory/score_probes.py:162-163`,
`run_cell.py:292-293`, `build_corpus.py:888-891`, `analyse.py:110,141` and four test files. It is
a duplicate that IS read, so the real finding is "two names for one artifact" — and deleting it
would break the memory scorer. It becomes a repointing task, not a deletion.

## 5. The plan

### Tier A — do now (S cost, low risk, verified site counts)

| # | change | removes |
|---|---|---|
| A-1 | One `resolveSpecFor(agent)` helper | 4 copies of spec resolution + 2 copies of the error string (engine 567/609/803/1113, 798/1109) |
| A-2 | One compaction-lock assert, reused by the engine | a 3-way divergence: `frontier.hasActiveCompaction` vs vendored `assertCompactionInactive` vs 2 inline re-throws, and 3 copies of the message |
| A-3 | Compute `pressureBreakdown` once per iteration and pass it | 9 call sites, including the identical call twice in one concatenation (1163/1164) |
| A-4 | Import `sourceRangeOf`; one shared `jsonChars` | the byte-identical span computation and the second payload-size definition |
| A-5 | One `serveDepth(bundle, depth, offset, limit, resolve)` | the duplicated depth dispatch, paging and corruption handling in the two recall paths |

Every item is mechanical, each removes a site where two implementations can disagree, and each is
covered by the existing suite. **A-1 through A-3 are the whole justification for doing anything at
all in `engine.ts`** — they are the drift sites, not the line count.

### Tier B — do when that area is next touched (M)

| # | change | why this rank |
|---|---|---|
| B-1 | Extract `FoldTelemetry` from `engine.ts` (15 mutable fields <-> 15 getters) | the largest reduction of public surface per unit of risk; mechanical and separately testable |
| B-2 | Split `subagent-recall.ts` into gate / descriptors / loop / transport behind a barrel | 841 lines and 37 exports that I wrote this session; cheapest while the design is fresh |
| B-3 | Move the gate and its refusal payload out of `tools.ts` into the recall module | policy that cannot currently be tested without registering tools |
| B-4 | Split the 187-line plugin constructor into per-surface `register*` functions | makes projection/status/tools/command independently testable |
| B-5 | Assert set-equality of the owned-key list, the Config schema and the config interface; add one loader-path test | the cheap version of C2 — no functional impact today, but it is the guard the code already claims to have |
| B-6 | One `mountRuntime(ctx, opts)` for the four harness mounts | **harm already realised**: the divergent pruner config invalidated a measurement round |
| B-7 | One parameterised wave launcher + one `live-env.sh` | 24 hardcoded machine paths and 9 copies of the sweep body |

### Tier C — declined, with the reason

* **C-1 the key-table refactor (L, C1)** — its entire purpose is to prevent config drift whose
  functional impact I measured as zero (§4). An L-cost refactor of the config core to prevent a
  documentation gap is not a trade worth making. Do B-5 instead.
* **C-2 splitting `bridge-host.ts` (L, D5)** — it is a harness, not shipped code. High cost, and the
  benefit is confined to people authoring harnesses.
* **C-3 deriving the status schemas from their types (M, C6)** — correct, but do it opportunistically
  the next time a status field is added rather than as a project.
* **C-4 a `RecallMode` interface for a hypothetical third mode (L, B6)** — build it when the third
  mode exists. Two modes do not justify a framework, and the abstraction would be guessed.
* **C-5 unifying `src/basic/*` with `leaf-policy.ts`** — vendored by explicit rule and regenerated by
  `scripts/vendor-basic.mjs`. The cheap correct move is A-2 plus a test that the mirror still
  matches, never a merge.

### Tier D — decisions for the owner, not refactors

| # | question | the numbers |
|---|---|---|
| D-1 | Commit the generated memory corpus, or only the builder + provenance? | `eval/memory` holds 152,714 of the eval layer's 170,505 lines: `filler_source.txt` 139,387 lines / 7.2 MB (a FETCHED source, with a provenance file) and `documents.json` 2.2 MB (regenerated by `build_corpus.py`) |
| D-2 | Keep or delete `vendor/deepseek-harness/`? | 2.1 GB, git-ignored, untracked — costs disk only |
| D-3 | Promote or delete the untracked leftovers? | 158 untracked entries: root `ef-*.sh`, `ef-phase7-logs/*`, `.sweep-check.mjs`, `.trace.py` |
| D-4 | Keep both names for the probe artifact? | `probes.json` == `answer_key.json` (same hash), 22 readers |

## 6. Non-goals — do not touch

Four independent analysts each nominated one thing that looks like debt and is not. I agree with
all four:

* **`purpose: "compaction"` on the subagent calls** — the union is closed (`"compaction" |
  "session-title"`); no correct value exists, the counters already make the calls attributable, and
  "fixing" it needs an upstream type change for zero runtime gain.
* **The comment density in `engine.ts`** (773 of 1,699 lines) — each block records a MEASURED
  failure that justifies the guard it sits above. Deleting them removes the only evidence for why
  the guards exist.
* **`scripts/run-lhtb.sh`'s 285 comment lines of 434** — same reason, per constant.
* **The `mode: basic` early return in the plugin** — it reads as a constructor abandoning its job,
  but it is the RC4-A requirement that no EF surface exists under basic.

## 7. What would make me revisit Tier C

* `src/` passing ~20,000 lines, or a fifth file passing 600 lines.
* A third recall mode or a fourth experimental flag — that is when C-1 and C-4 stop being
  speculative.
* A second deployment target (a loader/YAML path that a programmatic mount does not exercise) —
  that is when C2's omitted keys stop being harmless.
