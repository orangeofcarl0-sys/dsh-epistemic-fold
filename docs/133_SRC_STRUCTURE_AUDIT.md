# 133 - src/ structure audit: dependency graph, clusters, and a risk-ordered regrouping

Status: **ANALYSIS ONLY.** No file under src/ was created, modified, moved or deleted; this document is the
only write. 2026-10-18. Parent: docs/68 - whose Tier A/B work produced the file list this audit measures -
and whose Tier C (declined) and Tier D (owner decisions) conclusions are **not** reopened here.

Method: every relative import specifier in src/**/*.ts was extracted by text scan (from './x.ts',
import './x.ts', export ... from), resolved against the importing file's own directory, and kept only when
the target is a real file. External edges are the same extraction over tests/, eval/, bench/ and scripts/.
**No edge below is inferred from a filename.**

## 1. What is actually flat

| scope | files | lines |
|---|---|---|
| src/ total | 58 | 15627 |
| src/*.ts (flat) | 53 | 13851 |
| src/basic/* (vendored) | 5 | 1776 |

For contrast, eval/ holds 48 files in 10 subdirectories; src/ holds 53 of its 58 files in one.
(The brief's 58 / 53 / 15,708 and this audit's 58 / 53 / 15627
differ only in counting method - these are physical line counts.)

## 2. The graph, measured

- **225** relative import statements between shipped src modules (edges).
- **235** further import statements from tests/, eval/, bench/ and scripts/ reach into src/
  directly, over **40** distinct target modules. **None of them goes through the public barrel**:
  src/index.ts has 0 external importers, so tests and eval deep-import 40 different src files.
- 3 modules have fan-in 0 and are the entry points: entry.ts, index.ts, plugin.ts.
- 15 modules have fan-out 0 (no internal imports at all): basic/summarizer.ts, basic/types.ts, authority.ts, economics-profile.ts, event-data.ts, framing.ts, hash.ts, inventory.ts, preset-self-check.ts, rationale.ts, rebase-intent.ts, recall-telemetry.ts, recall-transport.ts, summary-retry.ts, types.ts.
- **Exactly one cycle: src/policy.ts <-> src/preset.ts** (policy.ts:19-20 imports preset; preset.ts:66
  imports policy). Every other edge is a DAG edge.

### Hubs - fan-in in import statements (>= 6)

| fan-in | fan-out | module | stated purpose (its own header) |
|---|---|---|---|
| 17 | 6 | policy.ts | EF policy face: config resolution + routed-model policy |
| 14 | 1 | preset.ts | Named configuration tiers (the three-mode surface) |
| 14 | 0 | economics-profile.ts | the versioned, data-driven cost model (pure data) |
| 14 | 0 | types.ts | M0 durable vocabulary: fold modes, candidates |
| 8 | 1 | checkpoint-marker.ts | checkpoint identity protocol, single owner |
| 8 | 1 | state.ts | deterministic current state: anchors, supersession |
| 7 | 2 | pressure.ts | pressure attribution: split total pressure in two |
| 7 | 2 | trigger.ts | who actually controls compaction |
| 7 | 0 | hash.ts | canonical JSON + SHA-256 for bundle integrity |
| 6 | 6 | recall.ts | bounded exact recall over checkpoint bundles |
| 6 | 2 | archive-refs.ts | resolving archive refs back into messages |
| 6 | 2 | policy-compiler.ts | measured economics -> a context policy |

### Leaves

- fan-in 1 (11 modules): bundle-codec.ts, command.ts, doctor.ts, gate.ts, plugin-config.ts, preset-self-check.ts, rationale.ts, recall-loop.ts, status-projection.ts, summary-retry.ts, trigger-diagnostics.ts.
- fan-in 0 (3): entry.ts, index.ts, plugin.ts.

## 3. The layering the graph actually shows

~~~
L0 vocabulary / infra (fan-out 0: depend on nothing internal)
     types  economics-profile  hash  authority  inventory  framing  rebase-intent
     event-data  recall-telemetry  recall-transport  summary-retry  rationale
     preset-self-check  compat(->basic)  basic/* (vendored)
L1 configuration
     policy  preset  effective-config  plugin-config  trigger  policy-compiler
L2 fold domain
     frontier  leaf-policy  pressure  root-policy  fold-economics  candidate
     checkpoint-marker  compiler  renderer  framing  bundle-store  bundle-codec
     archive-refs  inventory  state  projection  anchor-service  fold-telemetry
     task-root  idle-rebase  recall  descriptors  gate  subagent-recall
L3 application
     engine
L4 surface / adapters
     index  entry  plugin  doctor  command  status  status-projection  tools
     recall-loop  recall-transport
cross-cutting (imported from every layer): types, hash
~~~

Every edge runs downward except the policy <-> preset cycle. There is **no upward edge from src/basic into
EF** (section 8).

## 4. The clusters, with evidence

Each row is a proposed directory. The evidence cites the import statements that hold the group together;
the purposes are the files' own header lines, not guesses from their names.

| cluster | files | lines | import evidence |
|---|---|---|---|
| config/ | 5 | 1432 | policy <-> preset is the graph's only cycle; effective-config.ts:17-24 imports compat, preset, policy, trigger; plugin-config.ts:23 imports policy; doctor.ts:39 imports preset-self-check. Purposes: config resolution / named tiers / effective-config surface / plugin Config schema / preset self-check. |
| policy/ | 7 | 1648 | fold-economics.ts:23-32 imports economics-profile, leaf-policy, pressure x2, policy-compiler x2, policy x2, root-policy x2; policy-compiler.ts:41-42 imports economics-profile; trigger-diagnostics.ts:13-15 imports policy + trigger x2. Purposes: cost model / policy compiler / leaf-admission + rebase decisions / pressure attribution / root-fold policy / trigger breakdown. |
| fold/ | 8 | 3230 | engine.ts imports candidate(36), frontier(45), leaf-policy(46), task-root(47-48), fold-telemetry(95-96); pressure.ts:32-33 imports frontier + leaf-policy; root-policy.ts:13 imports leaf-policy; leaf-policy.ts:13 imports frontier; idle-rebase.ts:37-39 imports engine + rebase-intent x2. Purposes: the engine / pending candidate / frontier / leaf span / telemetry record / active task root / pending rebase intent / idle rebase consumer. |
| checkpoint/ | 11 | 1922 | compiler.ts:13-15 imports marker + hash + types; renderer.ts:11-14 imports marker + hash + state x2; bundle-store.ts:13-22 imports codec + hash + types; bundle-codec.ts:43-44 and archive-refs.ts:41-42 import hash + types; frontier.ts:16 imports marker; recall.ts:12-17 imports archive-refs x2 + marker + compiler + inventory + types. Purposes: identity protocol / compile hook / renderer / framing / rationale compiler / summary retry / file store / on-disk codec / archive refs / inventory / hash. |
| recall/ | 8 | 2208 | subagent-recall.ts:54-58 is a barrel over telemetry + gate + descriptors + loop + transport; recall-loop.ts:12-15 imports descriptors + recall + telemetry + transport; gate.ts:13-14 imports descriptors + telemetry; descriptors.ts:16-21 imports archive-refs + inventory x2 + recall + types; tools.ts:15-31 imports archive-refs x2 + types + marker + recall x2 + policy + subagent-recall x2. Purposes: bounded exact recall / subagent loop / model call / counters / descriptors / size gate / barrel / model-facing tools. |
| state/ | 4 | 722 | anchor-service.ts:15-17 imports authority x2 + state; state.ts:24 imports authority; projection.ts:18-19 imports state x2; renderer.ts:13-14 imports state x2; plugin.ts:32-33,40 imports anchor-service x2 + projection. Purposes: current state / projection / authority model / sanctioned anchor producer. |
| status/ | 4 | 1568 | status.ts:50-55 imports frontier + event-data + economics-profile x2 + preset x2; status-projection.ts:50-56 imports economics-profile x2 + marker + types + event-data + preset x2; command.ts:31-37 imports status x2 + policy + economics-profile + preset x2 + types; plugin.ts:41,44 imports status-projection + command. Purposes: /context status / sidebar projection / typed event readers / /context command. |
| (root, stays) | 6 | 1121 | index is the public barrel (38 import statements); entry/plugin are the DSH mount; types is the shared vocabulary; compat is the DSH compatibility contract; doctor is the always-mounted substitution doctor. |

## 5. Proposed tree

~~~
src/
  index.ts          (public barrel - STAYS, package.json:9,16)
  entry.ts          (package entry - STAYS, package.json:12)
  plugin.ts         (DSH mount - STAYS, package.json:20)
  doctor.ts         (published subpath - STAYS, package.json:29)
  types.ts          (shared vocabulary - STAYS, see section 9)
  compat.ts         (DSH compatibility contract - STAYS)
  basic/            (VENDORED - never touched, section 8)
  config/           policy  preset  effective-config  plugin-config  preset-self-check
  policy/           policy-compiler  fold-economics  economics-profile  pressure
                    root-policy  trigger  trigger-diagnostics
  fold/             engine  candidate  frontier  leaf-policy  fold-telemetry
                    task-root  rebase-intent  idle-rebase
  checkpoint/       checkpoint-marker  compiler  renderer  framing  rationale
                    summary-retry  bundle-store  bundle-codec  archive-refs
                    inventory  hash
  recall/           recall  recall-loop  recall-transport  recall-telemetry
                    descriptors  gate  subagent-recall  tools
  state/            state  projection  authority  anchor-service
  status/           status  status-projection  event-data  command
~~~

53 flat files become 6 root files plus 7 directories; src/basic/ is unchanged. Nothing is renamed, only
relocated, so no exported symbol changes and the public surface of index.ts is byte-identical.

## 6. Churn, quantified

**Churn** of a move = (internal import statements whose specifier must be rewritten) + (external import
statements in tests/eval/bench/scripts that name the moved file). Specifier rewrites are counted per
statement, not per file: an edge needs one edit if its two endpoints end up in different directories.

Whole migration, all 7 directories created together:

~~~
internal edges                                        225
  of which cross the new directory boundary           148
external import statements into shipped src/          235
  into files that stay at root (unchanged)            17
  into moved files                                    218
                                                      ------
TOTAL specifier edits for the whole migration         366
~~~

Per-cluster cost - the number of edits in a commit that moves exactly that cluster:

| cluster | files | boundary edges | external stmts | edits in that commit |
|---|---|---|---|---|
| status/ | 4 | 18 | 6 | 24 |
| recall/ | 8 | 20 | 19 | 39 |
| state/ | 4 | 14 | 33 | 47 |
| fold/ | 8 | 49 | 22 | 71 |
| checkpoint/ | 11 | 40 | 39 | 79 |
| config/ | 5 | 35 | 42 | 77 |
| policy/ | 7 | 42 | 55 | 97 |
| (root, not a move) | 6 | 71 | 17 | 88 |
| basic/ | 5 | 7 | 2 | 0 (never moves) |

Boundary edges are counted once per cluster, so an edge between two new clusters appears in both rows.
Summing the rows double-counts 71 edges; the unique total is 366.

### Per-file churn, all 58 files

| churn | cross-boundary edges | external stmts | fan-in | fan-out | lines | proposed dir | file |
|---|---|---|---|---|---|---|---|
| 43 | 11 | 32 | 14 | 0 | 438 | policy/ | economics-profile.ts |
| 39 | 17 | 22 | 17 | 6 | 554 | config/ | policy.ts |
| 38 | 32 | 6 | 4 | 38 | 2140 | fold/ | engine.ts |
| 37 | 37 | 0 | 0 | 38 | 177 | (root) | index.ts |
| 25 | 10 | 15 | 14 | 1 | 441 | config/ | preset.ts |
| 23 | 8 | 15 | 6 | 6 | 1039 | recall/ | recall.ts |
| 22 | 13 | 9 | 14 | 0 | 273 | (root) | types.ts |
| 20 | 16 | 4 | 0 | 16 | 363 | (root) | plugin.ts |
| 17 | 7 | 10 | 7 | 2 | 295 | policy/ | pressure.ts |
| 17 | 5 | 12 | 8 | 1 | 360 | state/ | state.ts |
| 15 | 4 | 11 | 4 | 3 | 188 | state/ | anchor-service.ts |
| 14 | 7 | 7 | 8 | 1 | 140 | checkpoint/ | checkpoint-marker.ts |
| 13 | 4 | 9 | 6 | 2 | 254 | policy/ | policy-compiler.ts |
| 13 | 2 | 11 | 7 | 0 | 42 | checkpoint/ | hash.ts |
| 12 | 3 | 9 | 3 | 2 | 97 | state/ | projection.ts |
| 11 | 7 | 4 | 1 | 7 | 524 | status/ | status-projection.ts |
| 11 | 3 | 8 | 2 | 3 | 235 | checkpoint/ | bundle-store.ts |
| 9 | 8 | 1 | 5 | 10 | 398 | policy/ | fold-economics.ts |
| 9 | 7 | 2 | 6 | 2 | 225 | checkpoint/ | archive-refs.ts |
| 9 | 7 | 2 | 7 | 2 | 139 | policy/ | trigger.ts |
| 9 | 6 | 3 | 2 | 8 | 228 | config/ | effective-config.ts |
| 8 | 4 | 4 | 4 | 0 | 129 | checkpoint/ | framing.ts |
| 8 | 4 | 4 | 4 | 2 | 124 | fold/ | frontier.ts |
| 8 | 4 | 4 | 2 | 4 | 206 | checkpoint/ | renderer.ts |
| 7 | 7 | 0 | 2 | 9 | 337 | recall/ | tools.ts |
| 7 | 6 | 1 | 1 | 7 | 314 | status/ | command.ts |
| 7 | 3 | 4 | 4 | 1 | 104 | fold/ | leaf-policy.ts |
| 6 | 5 | 1 | 2 | 5 | 198 | fold/ | fold-telemetry.ts |
| 6 | 5 | 1 | 2 | 6 | 660 | status/ | status.ts |
| 6 | 4 | 2 | 3 | 1 | 140 | (root) | compat.ts |
| 5 | 5 | 0 | 4 | 3 | 198 | checkpoint/ | compiler.ts |
| 5 | 5 | 0 | 5 | 0 | 253 | checkpoint/ | inventory.ts |
| 5 | 2 | 3 | 2 | 3 | 235 | fold/ | idle-rebase.ts |
| 5 | 1 | 4 | 3 | 5 | 58 | recall/ | subagent-recall.ts |
| 4 | 4 | 0 | 3 | 5 | 70 | recall/ | descriptors.ts |
| 4 | 3 | 1 | 4 | 1 | 43 | policy/ | root-policy.ts |
| 3 | 2 | 1 | 2 | 6 | 483 | basic/ | basic/index.ts |
| 3 | 2 | 1 | 5 | 0 | 77 | state/ | authority.ts |
| 3 | 1 | 2 | 1 | 0 | 135 | config/ | preset-self-check.ts |
| 3 | 1 | 2 | 1 | 0 | 146 | checkpoint/ | summary-retry.ts |
| 3 | 1 | 2 | 2 | 1 | 178 | fold/ | task-root.ts |
| 2 | 2 | 0 | 5 | 0 | 86 | basic/ | basic/types.ts |
| 2 | 2 | 0 | 2 | 1 | 65 | fold/ | candidate.ts |
| 2 | 2 | 0 | 1 | 3 | 81 | policy/ | trigger-diagnostics.ts |
| 2 | 1 | 1 | 2 | 2 | 612 | basic/ | basic/region.ts |
| 2 | 1 | 1 | 1 | 2 | 126 | checkpoint/ | bundle-codec.ts |
| 2 | 0 | 2 | 0 | 1 | 56 | (root) | entry.ts |
| 2 | 0 | 2 | 4 | 0 | 186 | fold/ | rebase-intent.ts |
| 1 | 1 | 0 | 2 | 1 | 368 | basic/ | basic/config.ts |
| 1 | 1 | 0 | 5 | 0 | 227 | basic/ | basic/summarizer.ts |
| 1 | 1 | 0 | 1 | 1 | 112 | (root) | doctor.ts |
| 1 | 1 | 0 | 1 | 1 | 74 | config/ | plugin-config.ts |
| 1 | 1 | 0 | 1 | 0 | 222 | checkpoint/ | rationale.ts |
| 0 | 0 | 0 | 2 | 0 | 70 | status/ | event-data.ts |
| 0 | 0 | 0 | 1 | 2 | 120 | recall/ | gate.ts |
| 0 | 0 | 0 | 1 | 4 | 426 | recall/ | recall-loop.ts |
| 0 | 0 | 0 | 3 | 0 | 64 | recall/ | recall-telemetry.ts |
| 0 | 0 | 0 | 2 | 0 | 94 | recall/ | recall-transport.ts |

**Churn is measured under the final tree, so it assumes the whole cluster moves in one commit.** A
zero-churn file (event-data, gate, rebase-intent, recall-loop, recall-telemetry, recall-transport) is not
independently movable - it is free *because* every file that references it moves with it. Moving such a
file alone costs its full degree.

Two structural facts make the edit mechanical rather than dangerous:

- tsconfig.json:305-306 includes src/**/*.ts by glob, so a new subdirectory needs **no tsconfig change**.
- scripts/build-plugin.mjs:51-59 walks src/ recursively, so a new subdirectory needs **no build change**.

## 7. Risk-ordered sequence

Order: leaves and cheap clusters first, hubs last. Cost is the section-6 per-cluster figure; the one
adjustment to strict cost order is that config/ is deferred past checkpoint/ because it holds the two
largest hubs (policy: 22 external statements and fan-in 17; preset: 15 external, fan-in 14) and the only cycle.

| # | move | edits | why here |
|---|---|---|---|
| 1 | status/ (4 files) | 24 | smallest boundary and only 6 external statements; nothing else imports status except plugin |
| 2 | recall/ (8 files) | 39 | 6 of its 8 files are leaves with fan-in <= 1; the cluster is already self-contained behind the subagent-recall barrel |
| 3 | state/ (4 files) | 47 | tight 4-node subgraph; costs anchor-service (11) and state (12) |
| 4 | fold/ (8 files) | 71 | engine.ts is the largest single unit: 38 out-edges, of which 29 cross the new boundary and only 9 stay inside fold/ even when the cluster moves as one commit |
| 5 | checkpoint/ (11 files) | 79 | largest cluster; hash (11 external) and bundle-store (8) are the cost |
| 6 | config/ (5 files) | 77 | holds two hubs and the only cycle: settle the shape before moving them |
| 7 | policy/ (7 files) | 97 | economics-profile has 32 external statements and fan-in 14; moving it last keeps the cost of every earlier step stable |

The 4 public entry points and types.ts never move (section 9), so the forced root churn is fixed at
71 internal edits (index 37, plugin 16, types 13, compat 4, doctor 1) and cannot be avoided by any regrouping that moves the files they import.

Gate: `npm run typecheck` after each step. With moduleResolution bundler and allowImportingTsExtensions,
every missed specifier is a compile error, so the typechecker is the whole safety net for this work.

## 8. src/basic: the vendored boundary

Read from code, not assumed:

- src/basic/*.ts imports **nothing** outside src/basic (0 edges out; verified).
- Exactly 3 files outside it import in: compat.ts:31 (basic/index), engine.ts:26,44,86,87,97 (all five
  vendored modules), policy.ts:15 (basic/types).
- engine.ts therefore reaches **past the vendored barrel** into 4 of the 5 internal vendored modules
  (region, config, summarizer, types) - the copy is not encapsulated behind basic/index.ts.
- tests/fold-reachability.spec.ts imports src/basic/region.ts directly (1 external statement).

Conclusion: the boundary is **clean and one-directional** - EF depends on the vendored base, nothing in
the base depends on EF. That is a normal downward dependency (engine extends BasicCompactionEngine), not a
layering inversion. Two consequences: (a) src/basic/ must not be moved or reorganized, because it is
regenerated by scripts/vendor-basic.mjs and pinned by tests/rc7-vendored-basic.spec.ts; (b) the deeper
coupling is engine.ts's 5 direct imports of vendored internals - a re-vendor of a different DSH build can
change basic/config.ts or basic/summarizer.ts signatures and break engine.ts without the barrel changing.

## 9. What must NOT move, and why

| path | why it must stay |
|---|---|
| src/basic/** | Vendored (region.ts:1-11 says do not edit; regenerated by scripts/vendor-basic.mjs). Referenced by THIRD_PARTY_NOTICES.md and by tests/rc7-vendored-basic.spec.ts; tests/fold-reachability.spec.ts deep-imports region.ts. |
| src/entry.ts, src/index.ts, src/plugin.ts, src/doctor.ts | Pinned as public type entries by package.json:9,12,16,20,29, and asserted by tests/rc3-plugin-packaging.spec.ts:36 (`exports['.']` must equal `{types: './src/entry.ts', ...}`). Moving them is a packaging change, not a folder change. |
| src/types.ts | The vocabulary hub: fan-in 14 internal + 9 external statements. Every layer imports it; moving it costs 22 edits for zero navigational gain. Keep it at root as the shared vocabulary, or move it dead last. |
| src/compat.ts | Imports the vendored barrel and is imported by the config layer and the engine; 3 in / 1 out. It is a mount-time contract, so it belongs with the root mount files rather than in any cluster. |
| src/hash.ts and src/economics-profile.ts (until last) | Both are pure leaves by fan-out (0) but load-bearing by fan-in (7 and 14) and by external use (11 and 32 statements in tests/eval). Move them with their cluster, last. |
| the file split of status.ts / recall.ts / engine.ts | This is a *folder* audit. Splitting a 660- or 1,039-line module is docs/68's territory (B-2 already split subagent-recall.ts; C-2 declined splitting bridge-host.ts). Do not bundle a module split into a move commit. |

## 10. Read from code vs inferred

**Read from code (measured, reproducible from the commands in the method line):**

- every count in sections 1, 2 and 6: file and line counts, 225 internal edges, 235 external
  statements over 40 targets, fan-in/fan-out per module, the single policy <-> preset cycle,
  the 148 cross-boundary edges, and the per-file churn table;
- the 3 external importers of src/basic/* and the absence of any edge out of src/basic;
- package.json:9,12,16,20,29 and tests/rc3-plugin-packaging.spec.ts:36 (the four pinned entry paths);
- tsconfig.json:305-306 and scripts/build-plugin.mjs:51-59 (glob include and recursive walk);
- every purpose quoted in the hubs table is that file's own header line.

**Inference (judgment, not measurement):**

- the *names* of the proposed directories and which cluster each file belongs to. The edges constrain the
  grouping; they do not uniquely determine it. `framing.ts` (checkpoint framing vs the framingMode config
  knob), `tools.ts` (recall surface vs plugin surface), `inventory.ts` (archive vs recall), `summary-retry.ts`
  and `rationale.ts` (compile side vs fold side) are the five genuinely two-sided placements.
- the *risk order* in section 7: the edit counts are measured, the weighting of hub-last over strict
  cost order is a judgment about review risk.
- the claim that this improves readability. Nothing here measures comprehension; it measures graph shape.
- the residual churn not counted: comment-level references such as eval/tau2/bridge-host.ts:110,122,2125
  (which cite `src/policy.ts:386-431` and `src/engine.ts:1099` by line) and tests/rc3-plugin-packaging.spec.ts:257,298
  (which name `src/economics-profile.ts` in prose). These do not break a build but go stale silently.

## 11. Scope: what this buys, and what it does not

docs/68 section 2 measured this codebase as *not* a big ball of mud, with duplication at ~54 lines and fan-in
concentrated in a normal config-vocabulary hub. Nothing in this audit contradicts that: the graph is a
near-DAG with one 2-node cycle, and the 53 flat files are not tangled with each other -
they are simply all at the same level. **So this is a navigability change, not a defect fix.**

- It buys: a directory tree where the layering in section 3 is visible in the filesystem, and where the
  import direction of a new file is obvious from where it is created.
- It costs: 366 specifier edits across 117 files - 28 inside src/, 89 in tests/, eval/, bench/ and scripts/.
  235 of the 366 statements are outside src/, so the external churn is 60% of the total and is the part that
  touches code this task does not own.
- It does not fix, and must not be bundled with: the concentration findings (engine.ts) or the drift sites
  that docs/68 Tier A/B already addressed, nor any Tier C refactor. One mechanical commit per cluster,
  typecheck green after each, is the whole risk profile.

**A lower-churn alternative worth recording:** directory-level barrels (each new dir gets an index.ts) would
cut src/index.ts from 38 re-export statements to 7, but it adds 7 files, hides which module owns a
symbol, and breaks the explicit named re-export style src/index.ts uses today. Not recommended, but it is
the only lever that reduces the 37-edit forced cost at the barrel.
