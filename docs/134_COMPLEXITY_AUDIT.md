# 134 — Complexity audit: god files, duplication, dead exports

Status: **analysis complete, nothing changed.** Extends `docs/68_STRUCTURAL_AUDIT_AND_PLAN.md`
(Tiers A and B DONE, C declined, D open) rather than repeating it. Every claim below carries a
`file:line` or a command that reproduces it.
2026-10-18, revision `7acc0dc` + dirty working tree.

Method: read-only. No source file was modified, no build and no test was run. Counts come from
three commands, all re-runnable:

```
# 1. per-file lines / exports / funcs / classes / methods / comment share
node -e '…walk src/ + eval/, split lines, count /^export/, /^function/, class bodies…'
# 2. vocabulary scans
grep -rn 'EF_OWNED_CONFIG_KEYS\|interface Telemetry\|FoldStatusState' src eval
# 3. dead-export scan (318 files indexed)
node -e '…for each src/ export name, test /\bNAME\b/ in every other indexed file…'
```

**What docs/68 already settled and this report does NOT re-open:** the A-1…A-5 drift sites, B-1…B-7
extractions, the C-2/C-4/C-5 declines, the four owner decisions (Tier D), and the §6 non-goals. The
two prior findings I re-measured rather than trusted are marked **VERIFIED-NOW** or corrected.

---

## 1. Hotspot table

`src/`: **58 files, 15,708 lines, 428 `export` statements, 259 top-level functions.**
`eval/` (.ts only): **48 files, 15,732 lines.** `methods` is reported only where a class body
exists; `src/basic/*` is VENDORED (docs/68 §1, C-5) and is listed for size only.

| lines | exports | funcs | class | methods | cmt% | file |
|---|---|---|---|---|---|---|
| 2147 | 3 | 2 | 1 | 59 | 45% | src/engine.ts |
| 1040 | 26 | 21 | — | — | 39% | src/recall.ts |
| 661 | 9 | 8 | — | — | 42% | src/status.ts |
| 613 | 3 | 15 | (vendored) | — | 21% | src/basic/region.ts |
| 556 | 16 | 7 | — | — | 44% | src/policy.ts |
| 528 | 7 | 5 | — | — | 43% | src/status-projection.ts |
| 484 | 3 | 3 | 1 | 8 | 21% | src/basic/index.ts |
| 442 | 25 | 10 | — | — | 54% | src/preset.ts |
| 439 | 21 | 14 | — | — | 27% | src/economics-profile.ts |
| 427 | 16 | 8 | — | — | 22% | src/recall-loop.ts |
| 399 | 9 | 5 | — | — | 41% | src/fold-economics.ts |
| 369 | 4 | 15 | (vendored) | — | 14% | src/basic/config.ts |
| 365 | 10 | 8 | 1 | 1 | 48% | src/plugin.ts |
| 361 | 13 | 12 | — | — | 27% | src/state.ts |
| 338 | 3 | 5 | — | — | 18% | src/tools.ts |
| 317 | 9 | 6 | — | — | 39% | src/command.ts |
| 296 | 12 | 6 | — | — | 50% | src/pressure.ts |
| 276 | 13 | 1 | — | — | 50% | src/types.ts |
| 255 | 11 | 10 | — | — | 44% | src/inventory.ts |
| 255 | 4 | 1 | — | — | 40% | src/policy-compiler.ts |
| 237 | 7 | 2 | — | — | 49% | src/idle-rebase.ts |
| 236 | 1 | 2 | 1 | 11 | 21% | src/bundle-store.ts |
| 229 | 4 | 3 | — | — | 31% | src/effective-config.ts |
| 228 | 4 | 4 | — | — | 23% | src/basic/summarizer.ts |
| 227 | 8 | 4 | — | — | 43% | src/archive-refs.ts |
| 224 | 3 | 4 | — | — | 42% | src/rationale.ts |
| 207 | 5 | 6 | — | — | 45% | src/renderer.ts |
| 199 | 9 | 8 | — | — | 36% | src/compiler.ts |
| 199 | 4 | 2 | — | — | 70% | src/fold-telemetry.ts |
| 190 | 5 | 3 | — | — | 32% | src/anchor-service.ts |
| 187 | 9 | 3 | — | — | 62% | src/rebase-intent.ts |
| 178 | 38 | 0 | — | — | 4% | src/index.ts |
| 178 | 8 | 3 | 1 | 3 | 54% | src/task-root.ts |
| 147 | 7 | 4 | — | — | 62% | src/summary-retry.ts |
| 141 | 7 | 5 | — | — | 55% | src/checkpoint-marker.ts |
| 141 | 6 | 3 | — | — | 65% | src/compat.ts |
| 141 | 5 | 3 | — | — | 59% | src/trigger.ts |
| 136 | 3 | 3 | — | — | 51% | src/preset-self-check.ts |
| 130 | 4 | 2 | — | — | 75% | src/framing.ts |
| 127 | 6 | 3 | — | — | 64% | src/bundle-codec.ts |
| 125 | 6 | 3 | — | — | 35% | src/frontier.ts |
| 121 | 6 | 3 | — | — | 40% | src/gate.ts |
| 113 | 6 | 1 | — | — | 54% | src/doctor.ts |
| 106 | 3 | 2 | — | — | 32% | src/leaf-policy.ts |
| 98 | 4 | 2 | — | — | 38% | src/projection.ts |
| 95 | 2 | 2 | — | — | 37% | src/recall-transport.ts |
| 87 | 7 | 0 | — | — | 38% | src/basic/types.ts |
| 82 | 2 | 0 | 1 | 2 | 55% | src/trigger-diagnostics.ts |
| 79 | 5 | 3 | — | — | 42% | src/authority.ts |
| 76 | 1 | 0 | — | — | 53% | src/plugin-config.ts |
| 71 | 3 | 1 | — | — | 51% | src/descriptors.ts |
| 71 | 4 | 6 | — | — | 48% | src/event-data.ts |
| 66 | 2 | 1 | 1 | 3 | 33% | src/candidate.ts |
| 65 | 3 | 1 | — | — | 37% | src/recall-telemetry.ts |
| 59 | 5 | 0 | — | — | 86% | src/subagent-recall.ts |
| 57 | 4 | 0 | — | — | 82% | src/entry.ts |
| 44 | 2 | 1 | — | — | 41% | src/root-policy.ts |
| 43 | 3 | 4 | — | — | 37% | src/hash.ts |

Largest `eval/` files:

| lines | exports | funcs | cmt% | file |
|---|---|---|---|---|
| 2244 | 1 | 24 | 56% | eval/tau2/bridge-host.ts |
| 791 | 3 | 8 | 39% | eval/live/openai-adapter.ts |
| 608 | 9 | 1 | 18% | eval/real-task/tasks.ts |
| 556 | 15 | 6 | 44% | eval/policy-replay/simulator.ts |
| 535 | 21 | 13 | 32% | eval/live/billing.ts |
| 515 | 16 | 7 | 35% | eval/src/certified-profile.ts |
| 498 | 16 | 10 | 39% | eval/cache/microbench.ts |
| 495 | 6 | 3 | 6% | eval/scenarios/index.ts |
| 467 | 0 | 11 | 40% | eval/lhtb/watchdog.ts |
| 444 | 10 | 5 | 22% | eval/real-task/driver.ts |

**Only 4 shipped files exceed 600 lines, and `src/` has not grown since docs/68** (12,999 → 15,708,
which is the +7 extracted modules from B-1…B-6 plus the recall work). docs/68 §7's revisit trigger
("a fifth file passing 600 lines") has NOT fired: the list is still `engine`, `recall`,
`status`, `region`.

---

## 2. God files: distinct responsibilities and split points

### 2a. `src/engine.ts` — 2147 lines, 1 class, 59 members (33 methods + 26 getters), 45% comments

| # | responsibility | implementation |
|---|---|---|
| 1 | mode dispatch (legacy/ef vs `basic`) | `isBasic` 241-294, `setMode` **346-555 (210 lines)**, `basicMode` 254 |
| 2 | spec / capacity resolution | `estimateSpanTokens` 157, `noContextCapacityMessage` 199, `resolveSpecFor` 605-640 |
| 3 | compaction-lock assertion | `assertNoActiveCompaction` 641-645 |
| 4 | idle-rebase POLICY | `triggerFor` 556, `recordRebaseIntent` 572-604, `rebaseDecisionAtIdle` 646, `safetyRebaseDecisionAtIdle` 682-749, `rebaseAfterLeafRefusal` 1663-1702, `recordRootRebaseAdvice` 1703-1747, `handOffFrozenBound` 1480-1524, `recoverFromOverflow` 1525-1613, `commitEmergencyRebase` 1614-1662 |
| 5 | task-root residency | `registerActiveTaskRoot` 750, `clearActiveTaskRoot` 759, `taskRootStatus` 770, `protectedPositions` 797, `avoidTaskRoot` 813-834 |
| 6 | fold commit orchestration | `compactRegion` 835-878, `recordCommit` 879-912, `compactNow` 913-989, `protectedRootGuard` 990, `rootRegionDependencies` 1025, `protectedRootFold` 1056-1145, `compactIfNeeded` **1146-1479 (334 lines)** |
| 7 | framing | `frameCheckpoint` 1748, `resolvedFramingMode` 1767 |
| 8 | summarization | `summarize` **1784-1999 (216 lines)**, `summarizeWithTruncationRetry` 2000-2043 |
| 9 | state projection for the status surface | `mountedState` 2044, `structuredStateText` 2055, `currentSpanSeqs` 2086-2147 |
| 10 | telemetry accessors | 26 getters at 217-543; `grep -c 'this\.telemetry\.' src/engine.ts` → **42** |

**Split point.** docs/68 B-1 moved the fourteen FIELDS into `FoldTelemetry` but left the 26 getters
in the class; the engine still knows every consumer's vocabulary. Proposed, in order:
(i) responsibility 4 → `rebase-policy.ts` (9 methods, ~430 lines) — it needs only `session`,
`efConfig` and the registry; (ii) responsibility 5 → `task-root.ts`, which ALREADY EXISTS at 178
lines and already owns `TaskRootFailure`/`TaskRootResolution`; (iii) responsibility 8 →
`summarize.ts` (260 lines); (iv) responsibility 9 → the status module. That would leave
`engine.ts` as the fold transaction plus its wiring, roughly 900 lines, with no behaviour change.

### 2b. `src/recall.ts` — 1040 lines, 26 exports, 21 functions, 39% comments

Grew from 528 lines in one commit: `git log --oneline -2 -- src/recall.ts` →
`fedf47d fix(recall): make a folded checkpoint reachable from the two main tools`.

| # | responsibility | implementation |
|---|---|---|
| 1 | depth dispatch + paging | `RecallDepth` 42, `recall` 158-215, `recallForeign` 216-271, `serveDepth` 272-384 |
| 2 | archive resolution (inline vs refs) | `archiveMessages` 385-408 |
| 3 | recency ordering | `sourceRangeOf` 451-475, `compareCheckpointRecencyDescending` 476-493 |
| 4 | search + its diagnosis | `search` 578-611, `scanBundles` 612, `hitOf` 636, `verifiedHits` 661, `browseCandidates` 843, `searchWithDiagnosis` 869-952 |
| 5 | lexical scoring | constants 675-701 (`SEARCH_BROWSE_CANDIDATES`, `MIN_TERM_CHARS`, `TERM_PREFIX_CHARS`, `MIN_MATCHED_TERMS`, `MIN_QUERY_TERMS`, `STOPWORDS`), `queryTerms` 703, `termMatches` 718, `locatePartial` 746, `partialHits` 768-842 |
| 6 | match location | `locate` 953-976, `locateInArchive` 977-1019 |
| 7 | detail view + inventory | `NO_SUMMARY_NOTE` 52, `DETAIL_NOTE` 58, `hasNoSemanticContent` 80-98, `RecallInventoryEntry` 125, `RecallDescriptorView` 136 |
| 8 | excerpts | `excerptAround` 1020-1035, `toolCallExcerpt` 1036-1040 |

**Split point.** Two modules on the natural seam: `recall-serve.ts` = responsibilities 1, 2, 3, 7, 8
(lines 20-493 and 930-1040, ~600 lines) and `recall-search.ts` = 4, 5, 6 (lines 494-929, ~440
lines). The search half has no dependency on the serve half except `archiveMessages`.

### 2c. `src/status.ts` — 661 lines, 9 exports, 8 functions

| # | responsibility | implementation |
|---|---|---|
| 1 | the data model | `FigureBasis` 58, `Figure` 61, `ContextLifecycle` 74, `FoldLifetimeCounts` 95, `ContextStatus` 119, `ContextStatusInput` 201 — **210 of 661 lines are interface declarations (32%)** |
| 2 | evidence gathering | `readLifecycle` 268, `countRecallCalls` 317, `archiveFigures` 337, `foldCountsFrom` 374 |
| 3 | assembly | `buildContextStatus` 430-534, `figure` 535 |
| 4 | rendering | `contextStatusToText` 549-647, `contextStatusToLine` 648-661 |

**Split point.** `status-model.ts` (58-267), `status-gather.ts` (268-429), and rendering
(549-661) → the command layer. Assembly stays.

### 2d. `src/status-projection.ts` — 528 lines, 7 exports, 5 functions

| # | responsibility | implementation |
|---|---|---|
| 1 | state vocabulary | `FoldStatusState` 71-149 (**19 fields**) |
| 2 | view vocabulary | `FoldStatusView` 150-193 (**17 fields**) |
| 3 | the same two vocabularies as schemas | `stateSchema` 194-214 (**19**), `viewSchema` 216-239 (**17**) |
| 4 | reducer | `reduceStatusEvent` 248-356 |
| 5 | pricing | `priceState` 359-371 |
| 6 | projection + registration | `epistemicFoldStatusProjection` 413-519, `registerEpistemicFoldStatus` 520-528 |

**Split point.** `fold-status-state.ts` (1+3+4) and `fold-status-view.ts` (2+5); registration stays.
This is docs/68 C-3's "derive the schemas from the types" — now with the counts (see D4).

### 2e. `src/policy.ts` — 556 lines, 16 exports, 7 functions

| # | responsibility | implementation |
|---|---|---|
| 1 | **routing helpers that are not policy** | `routedTarget` 23, `conversationTarget` 35, `reservedCompletionTokens` 49 |
| 2 | defaults | 194-229, fourteen `DEFAULT_*` consts |
| 3 | config interface | `EpistemicFoldConfig` 232-303 (72 lines) |
| 4 | resolution + validation | `resolveEfConfig` 304-435 (132 lines) |
| 5 | spec math | `resolveEfCompactSpec` 466-523 |
| 6 | key vocabulary | `EF_OWNED_CONFIG_KEYS` 524-545, `stripEfConfigKeys` 546, `efOwnedConfigKeys` 553 |

**Split point.** Responsibility 1 → `routing.ts` (three functions, no dependency on any default).
Responsibility 5 → `compact-spec.ts`. Responsibility 6 is the vocabulary of D3 and belongs beside
`plugin-config.ts`.

### 2f. `eval/tau2/bridge-host.ts` — 2244 lines, 1 export, 24 functions, 34 module-level `let`, 56% comments

| # | responsibility | implementation |
|---|---|---|
| 1 | protocol + type declarations | 192-566 (**375 lines**: `TauTool`, `ArmSpec`, `TauMessage`, `TauMultiTool`, `FoldEvent`, `CompactBudget`, `Telemetry`) |
| 2 | process-global mutable state | 567-680 — **34 module-level `let` bindings** |
| 3 | protocol I/O + stdin loop | `emit` 688, `emitError` 693, `main` 1999-2244 |
| 4 | tau2 message mapping + turn lifecycle | `appendIncoming` 727-793, `rotateTurn` 794, `openTurn` 801, `closeTurn` 813, `surface` 820 |
| 5 | fold driver + failure classification | `classifyCompactionFailure` 862-888, `foldIfNeeded` 890-1020, `recordFoldLineage` 1022, `drainIdleRebase` 1071, `foldCounters` 1136 |
| 6 | EF tool dispatch + schema forwarding | `callEfTool` 1161, `toolSchemas` 1212-1253, `captureToolsRuntime` 1268, `toolsRuntime` 1283 |
| 7 | the model call | `modelTurn` 1311-1532 |
| 8 | episode wiring | `init` 1533-1860 |
| 9 | task-root registration | `registerTaskRootFromAppend` 1862-1897 |
| 10 | telemetry assembly | `telemetry` 1899-1996 |

**Split point, and an argument that EXTENDS docs/68 C-2 rather than repeating it.** docs/68 declined
splitting this file because it is a harness, not shipped code. That judgement was about AUTHORING
cost. §3-D1 below shows the cost has since been PAID: this file's hand-copied `Telemetry` vocabulary
has drifted from what it emits, and no compiler can see it because `tsconfig.json` includes only
`["src/**/*.ts", "tests/**/*.ts"]`. The minimal change is therefore not the L split: it is to move
`Telemetry`/`CompactBudget`/`FoldEvent` (283-281, 249-269) into a module that `src/` and
`eval/` both import, and add `eval/**/*.ts` to the tsconfig `include`. That is S-to-M, not L.

---

## 3. Duplication: one vocabulary, N hand-maintained copies

### D1. The telemetry field vocabulary — SIX lists, and it has ALREADY DRIFTED

| # | list | site | size |
|---|---|---|---|
| 1 | `FoldTelemetry` interface | `src/fold-telemetry.ts:35-160` | 18 fields |
| 2 | `createFoldTelemetry` initializer | `src/fold-telemetry.ts:164-182` | 18 keys |
| 3 | `Telemetry` interface | `eval/tau2/bridge-host.ts:283-565` | 41 fields |
| 4 | the object `telemetry()` returns | `eval/tau2/bridge-host.ts:1931-1995` | 40 keys |
| 5 | the artifact whitelist | `eval/memory/run_cell.py:510-518` | 27 keys |
| 6 | the collector's optional list | `scripts/ef-collect.py` `OPTIONAL` | 4 keys |

**The drift is realised, not hypothetical.** Diffing list 3 against list 4 key-by-key:

```
interface Telemetry  (283-565) : 41 fields
telemetry() object   (1931-1995): 40 keys
EXCESS  (emitted, undeclared)  : lastLeafDecision
```

`lastLeafDecision` is emitted at `bridge-host.ts:1954` and declared nowhere in the interface —
`grep -n 'lastLeafDecision' eval/tau2/bridge-host.ts` returns only `:1954` and a comment at
`:2130`. (The two apparent omissions `budget` and `providerFailures` are false positives: both
ARE emitted, at `:1940` via spread and `:1968` as shorthand. `:1968` is also a two-properties-
on-one-line artefact — `rationaleChars: …,    providerFailures,` — which is why line-based tooling
miscounts both it and `fold-telemetry.ts:173`.)

**Why no compiler caught it:** `tsconfig.json` `include` is `["src/**/*.ts", "tests/**/*.ts"]`;
`eval/` is outside every tsconfig. So the `Promise<Telemetry>` return type is never checked, and an
excess property that TypeScript would normally reject is silently accepted.

**Cost of one new counter:** up to 4 code edits (`fold-telemetry.ts` ×2, `bridge-host.ts` ×2) plus
1-2 consumer lists, and only lists 1-2 are typechecked together. Lists 3-6 are hand-copied.

### D2. The fold-mechanism vocabulary (`"leaf" | "root" | "emergency"@) — 6 code sites

```
grep -rn '"leaf"\|'"'"'leaf'"'"'' src eval --include=*.ts --include=*.py | grep -E 'leaf.*root.*emergency|FoldKind'
```

| site | what it is |
|---|---|
| `src/fold-telemetry.ts:33` | `export type FoldKind` |
| `src/fold-telemetry.ts:196` | the `switch` that maps kind → counter |
| `src/types.ts:13` | the fold-mode literal union |
| `src/policy-compiler.ts:45` | the same three literals again |
| `eval/tau2/bridge-host.ts:251` | `FoldEvent.mechanism` |
| `eval/memory/run_cell.py:107,119,530` | `counts = {"leaf": 0, "root": 0, "emergency": 0}` and two more |

Plus `eval/memory/analyse.py:260`. Seven sites for a three-value vocabulary, none of which can be
checked against `FoldKind` from the Python side.

### D3. The config-key vocabulary — 5 lists, 18 EF-owned keys

| # | list | site | size | guarded? |
|---|---|---|---|---|
| 1 | `EpistemicFoldConfig` interface | `src/policy.ts:232-303` | 18 EF keys of 34 | no |
| 2 | `resolveEfConfig` (reads every key) | `src/policy.ts:304-435` | 18 | no |
| 3 | `EF_OWNED_CONFIG_KEYS` | `src/policy.ts:524-545` | 18 | **yes, vs 4** |
| 4 | `EpistemicFoldPluginConfig` | `src/plugin-config.ts:31-75` | 29 keys, all 18 EF ones | **yes, vs 3** |
| 5 | `src/effective-config.ts` | 229 lines | hand-mirrors keys and defaults | no |

docs/68 B-5 closed the (3,4) pair with `tests/plugin-composition.spec.ts` (cited at
`plugin-config.ts:16-17`). The unguarded pairs are (1,3) and (5,any): a key added to the interface
and the resolver but forgotten in `EF_OWNED_CONFIG_KEYS` is dropped by `stripEfConfigKeys` when the
config is handed to Basic, and nothing fails.

### D4. The status state/view vocabularies — 4 full lists + a partial third (docs/68 C6 VERIFIED-NOW)

| list | site | size |
|---|---|---|
| `FoldStatusState` | `src/status-projection.ts:71-149` | 19 fields |
| `stateSchema` | `:194-214` | 19 keys |
| `FoldStatusView` | `:150-193` | 17 fields |
| `viewSchema` | `:216-239` | 17 keys |

The reducer (`:248-356`) is a third, PARTIAL copy: it re-states field names inside spread returns
(`uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens` at `:325-329`;
`provider`, `model`, `resumed` at `:339-341`). No drift today — the counts match exactly —
but docs/68 C6 said "3x" without a number; the number is 19/19/17/17 and the guard is absent.

### D5. The recall-depth vocabulary — 4 sites

`src/recall.ts:42` (`RecallDepth`), `src/recall.ts:102,163,221,275` (the branch points),
`src/tools.ts:186` (the tool parameter `enum`), `src/recall-loop.ts:273` (the plan parser's
three-way test), plus the re-export at `src/index.ts:45`.

### D6. The fold-mode vocabulary (`legacy|basic|economy|balanced|quality`) — 6 sites with ≥4 distinct literals

`src/plugin-config.ts:42`, `src/preset.ts` (23 literals), `eval/bridge/ef_bridge_client.py:63-68`
(`ARM_SPECS`), `eval/real-task/driver.ts` (15 literals), `eval/tau2/run_tau2.py` (10),
`scripts/analyze-lhtb-round.py` (11). The Python arms table is the de-facto source of truth for
what a run can ask for, and it is not derived from `FoldModeName`.

### D7. The environment-variable vocabulary — 93 names, 311 occurrences

`grep -rho 'EF_[A-Z0-9_]*' src eval scripts | sort -u | wc -l` → **93**. Most-referenced:
`EF_ROOT` 20× in 5 files, `EF_LIVE_HEADERS` 17×/3, `EF_LIVE_MODEL` 17×/5, `EF_HOME` 16×/4,
`EF_TAU2_WINDOW` 16×/3, `EF_USE_PROXY` 13×/4, `EF_LHTB_ARM` 12×/5, `EF_MEMORY_WINDOW` 10×/3.
Two of those are the same CONCEPT (the context window) under two names read by two layers — see
`docs/131` — and `EF_OWNED_CONFIG_KEYS` appears in this scan as a false positive (it is a
constant, not a variable), which is itself a small warning about grepping for a vocabulary.

---

## 4. Dead and never-imported exports

Scan over 318 indexed files (`src/`, `eval/`, `tests/`, `scripts/`, root launchers): for every
`^export` name in `src/`, test `/\bNAME\b/` in every OTHER file.

- **68 exports are referenced nowhere outside their own file.**
- **37 more are referenced only by `src/index.ts`** (a barrel with 38 explicit `export` lines and
  zero `export *`), i.e. published API surface — NOT dead, listed separately.

20 of the 68 grep-confirmed, each with hits in exactly one file (its own):

| export | file | hits | where |
|---|---|---|---|
| `fallbackCheckpointLines` | src/compiler.ts | 2 | only `src/compiler.ts` |
| `queryTerms` | src/recall.ts | 2 | only `src/recall.ts` |
| `gatherStatus` | src/command.ts | 3 | only `src/command.ts` |
| `ContextCommandDeps` | src/command.ts | 5 | only `src/command.ts` |
| `DERIVED_RETIRED_SENTINEL` | src/inventory.ts | 3 | only `src/inventory.ts` |
| `DERIVED_RETIRED_TOMBSTONE` | src/inventory.ts | 2 | only `src/inventory.ts` |
| `BASIC_MODE` | src/preset.ts | 3 | only `src/preset.ts` |
| `SAFETY_REBASE_CAUSES` | src/rebase-intent.ts | 3 | only `src/rebase-intent.ts` |
| `BUNDLE_FILE_VERSION` | src/bundle-codec.ts | 2 | only `src/bundle-codec.ts` |
| `CHECK_DELAY_MS` | src/doctor.ts | 2 | only `src/doctor.ts` |
| `DoctorConfig` | src/doctor.ts | 2 | only `src/doctor.ts` |
| `DEFAULT_SUBAGENT_RECALL_THRESHOLD_CHARS` | src/policy.ts | 2 | only `src/policy.ts` |
| `registerAnchorSurface` | src/plugin.ts | 2 | only `src/plugin.ts` |
| `registerStatusSurface` | src/plugin.ts | 2 | only `src/plugin.ts` |
| `SummaryRetryStats` | src/summary-retry.ts | 2 | only `src/summary-retry.ts` |
| `TaskRootFailure` | src/task-root.ts | 2 | only `src/task-root.ts` |
| `PresetSubstitutionRow` | src/preset-self-check.ts | 3 | only `src/preset-self-check.ts` |
| `TriggerLogSink` | src/trigger-diagnostics.ts | 2 | only `src/trigger-diagnostics.ts` |
| `FrontierRef` | src/frontier.ts | 5 | src + 2 `docs/` (no code) |
| `FoldFrontier` | src/frontier.ts | 5 | src + 2 `docs/` (no code) |

The other 48, from the same scan: `archive-refs.ts: RefFailure`; `bundle-codec.ts:
BundleFileEnvelope`; `command.ts: CONTEXT_STATUS_SUBCOMMAND, CONTEXT_MODE_SUBCOMMAND`;
`compiler.ts: fallbackCheckpointLines`; `economics-profile.ts: pricingTierSchema,
economicsProfileSchema`; `effective-config.ts: EffectiveSetting`; `fold-telemetry.ts:
FoldKind`; `frontier.ts: FrozenCheckpoint`; `gate.ts: RecallBudgetVerdict`; `idle-rebase.ts:
IdleRebaseOutcome, IdleRebaseDeps`; `leaf-policy.ts: LeafSpan`; `plugin.ts:
registerStateProjectionSurface, registerStatusSurface, registerRecallSurface, registerCommandSurface,
IdleRebaseHandles, registerIdleRebaseSurface, registerFramingSurface`; `policy.ts:
RootPolicyMode, ResolvedEconomicsPolicy`; `preset.ts: ECONOMY_RATIONALE_HINT_TOKENS,
BALANCED_RATIONALE_HINT_TOKENS, QUALITY_RATIONALE_HINT_TOKENS`; `rationale.ts:
RationaleCallResult`; `rebase-intent.ts: SafetyRebaseCause, EconomicRebaseCause`;
`recall-loop.ts: SubagentFetchRequest, SubagentFetched, SubagentFurther, SubagentAnswer,
SubagentPlan, SUBAGENT_FETCH_BUDGET_CHARS, SUBAGENT_PLAN_MAX_TOKENS, SUBAGENT_ANSWER_MAX_TOKENS,
SubagentRecallOptions`; `recall-telemetry.ts: SubagentRecallStats`; `renderer.ts:
CheckpointPresentation`; `status-projection.ts: StatusProjectionOptions`; `status.ts: FigureBasis,
Figure, ContextLifecycle, FoldLifetimeCounts, ContextStatusInput`; `summary-retry.ts:
SummaryRetryPolicy`; `task-root.ts: TaskRootResolution`; `tools.ts: RecallToolOptions`.

**Read this as surface, not as garbage.** Most are TYPES that are internal to their module and were
exported out of habit — `plugin.ts`'s seven `register*Surface` functions are the B-4 extraction
and are exported so a test COULD reach them, but no test does. The two that look like real leftovers
are `src/recall.ts: queryTerms` (exported, called only two lines below its declaration) and
`src/compiler.ts: fallbackCheckpointLines` (never called at all, not even internally — 2 hits are
the declaration and the `export` on the same line region).

---

## 5. What NOT to touch (extends docs/68 §6, does not repeat it)

- **Comment share.** `bridge-host.ts` is 56% comments and `engine.ts` 45%. docs/68 §6 already
  ruled these load-bearing; the new number is that `subagent-recall.ts` is now an 86%-comment
  59-line barrel, which is the SAME judgement applied to a file that is already split. Leave it.
- **The 26 getters in `engine.ts`.** They are the public face of `FoldTelemetry` and every caller
  uses them; docs/68 B-1 deliberately kept them so no caller moved. Removing them is a rename
  project, not a simplification.
- **`src/basic/*` (1,781 lines vendored).** Regenerated by `scripts/vendor-basic.mjs`; docs/68
  C-5 declined unification. Its 32 "method-looking" lines in `region.ts` are continuation lines of
  free functions — there is no class there.
- **`src/index.ts`'s 38 explicit re-export lines.** The 37 barrel-only names are a deliberate
  published surface, not dead code.

---

## 6. Not established

- **Whether `lastLeafDecision` is an actual type error today.** `eval/` is outside
  `tsconfig.json` `include`, so no compiler in this repo sees `bridge-host.ts`; I did not run
  `tsc` (analysis only). If a separate eval tsconfig exists elsewhere I did not find it —
  `glob('**/tsconfig*.json')` was not run.
- **Whether the 68 dead exports are consumed outside this repo.** Only `src/`, `eval/`,
  `tests/`, `scripts/` and root launchers were indexed. A published package consumer would not
  appear.
- **Whether `EF_OWNED_CONFIG_KEYS` vs `EpistemicFoldConfig` has already drifted.** I counted both
  at 18 but did not diff them name-by-name.
- **The `methods` column for class-less files is not reported** — an earlier pass produced 34 for
  `recall.ts`, which has no class; those were indented call sites, not methods.
- **Line counts are a snapshot.** `src/` grew 12,999 → 15,708 between docs/68 and this audit.

---

## 7. Ranked by harm per unit of risk

1. **D1 — make the telemetry vocabulary single-source, or at least typecheck `eval/`** (S-M, low).
   The drift is already live (`lastLeafDecision`), the fix is a tsconfig `include` plus moving
   `Telemetry` out of the harness, and it makes lists 3-4 checked instead of hand-copied.
2. **D3 — extend the set-equality guard to `EpistemicFoldConfig` vs `EF_OWNED_CONFIG_KEYS`**
   (S, low). B-5 built the test harness for exactly this shape and stopped one pair short.
3. **2b — split `recall.ts` on the serve/search seam** (M, low). It doubled in one commit, the two
   halves share only `archiveMessages`, and the search half carries ~250 lines of lexical scoring
   that no recall-serve caller needs.
4. **2a(i) — extract `rebase-policy.ts` from `engine.ts`** (M, med). Nine methods, ~430 lines, the
   largest single concentration left; needs care because `safetyRebaseDecisionAtIdle` reads
   telemetry the class still owns.
5. **D4 — derive `stateSchema`/`viewSchema` from their types, or assert equality** (S, low). No
   drift today; it is the cheapest of the four vocabulary guards to add.
6. **§4 — delete the ~10 exports that are used by nothing at all** (S, low), starting with
   `compiler.ts: fallbackCheckpointLines` and `recall.ts: queryTerms`. Leave the type exports
   alone: they are internal-but-exported, and narrowing them is a separate judgement.
