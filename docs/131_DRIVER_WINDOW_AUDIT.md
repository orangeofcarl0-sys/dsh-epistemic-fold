# 131 — Memory-bench driver and window wiring, audited end to end

Status: **audit complete. The window wiring WORKS; the bench measures nothing for a different
reason, and that reason is on the driver's own surface.**
2026-10-17, repo revision + dirty working tree (see Method).

Method: read-only. No bench run, no model call, no file under `eval/memory/` or the fold core
modified. The only file written is this document. Every number is given with the command or the
line that produced it. Artifacts read: `eval/memory/result_{A,B,C,N}_quality_logical.json`
(11:43:28–11:45:18 local), `eval/memory/last_score.json`, `ef-phase7-logs/memory-bridge-stderr.log`
(11:43:38), and `git status`/`git diff` for `eval/memory/run_cell.py` (**clean** — no local edit).

---

## Headline, ordered by what actually blocks the measurement

1. **The probe turn is rendered and never sent.** `run_cell.py:396` builds it,
   `run_cell.py:397` records its length, and **no `bridge.append` call ever carries it**
   (the 5 append sites are `:254, :328, :365, :391, :393` — documents and errata only).
   `bridge.step()` sends `{"op":"step"}`, and `bridge-host.ts:2013-2025` appends nothing.
   So the model is asked no question, on any arm, in any window. This alone produces
   `accuracy None (unparsed 204)`.
2. **The bench offers the model tools while telling itself it offers none.** `run_cell.py:250,298`
   pass `[]`, but `bridge-host.ts:1208-1221` forwards `ctx.tools.schemas()` to the provider
   *unconditionally*. The EF recall tools are therefore offered, the model calls them, and the
   driver never answers them — which is the source of the `2 unanswered tool_call(s)` the lead
   observed. **The malformed history is the memory bench's, not LHTB's.**
3. **The window wiring is correct and the export DOES reach the engine.** `EF_TAU2_WINDOW` is read
   at `bridge-host.ts:131` (module scope) but in the **child** process, which is spawned *after*
   the export, so import-time and call-time coincide. The re-run's fold landed at **65,192 tokens**,
   which is `retainTokens = 0.24 x 258,048 = 61,931` plus one node — the 32,000 default predicts
   ~7,680. The export worked. The identical score is not a wiring symptom.
4. **The artifact cannot prove any of this**, because the driver drops the one field that would
   (`telemetry.compactBudget`, `bridge-host.ts:1894-1911`, omitted by the whitelist at
   `run_cell.py:440-443`).

---

## 1. `EF_TAU2_WINDOW`: every place it is read or defaulted

`run-memory.sh:24-34` exports six variables — `EF_ROOT`, `EF_LIVE_BASE_URL`, `EF_LIVE_API_KEY`,
`EF_LIVE_MODEL`, `EF_LIVE_HEADERS`, `EF_BRIDGE_STDERR`. **Neither window variable is among
them** (`grep -n 'EF_TAU2_WINDOW\|EF_MEMORY_WINDOW' eval/memory/*.sh eval/memory/*.py` → 0 hits).
`run-memory.sh:54` is a plain `exec "$HARBOR_PY" .../run_cell.py "$@"` — no `env -i`, no scrub —
so a value inherited from the operator's shell survives.

| # | site | what it does |
|---|---|---|
| 1 | `run-memory.sh:24-34` | does **not** set or default either window |
| 2 | `run-memory.sh:54` | `exec`; environment inherited intact |
| 3 | `ef_bridge_client.py:113` | `env = dict(os.environ)` — **full copy**, nothing filtered |
| 4 | `ef_bridge_client.py:132-146` | `subprocess.Popen([... bridge-host.ts], env=env, cwd=EF_ROOT)` — the only process boundary |
| 5 | `bridge-host.ts:131` | `const TAU2_WINDOW = Number(process.env.EF_TAU2_WINDOW ?? 32_000)` — read at module load |
| 6 | `bridge-host.ts:1673` | `promptTokens: TAU2_WINDOW` (RequestBudget unknown-cost reserve) |
| 7 | `bridge-host.ts:1680` | `contextWindow: TAU2_WINDOW` (adapter) |
| 8 | `engine.ts:535-537` | `info.context.contextWindow` → `resolveEfCompactSpec(this.efConfig, info.context.contextWindow, reserved)` |
| 9 | `policy.ts:454` | `messageBudgetTokens = contextWindow - reservedCompletionTokens` |
| 10 | `policy.ts:469-472` | `thresholdTokens = floor(min(contextWindow x thresholdRatio, pressureBudgetTokens))` |
| 11 | `policy.ts:473-474` | `retainTokens = floor(messageBudgetTokens x retainRatio)` |
| 12 | `bridge-host.ts:1894-1900, 1911` | published as `telemetry.compactBudget` |
| 13 | `run_cell.py:440-443` | **dropped** — the whitelist keeps 9 keys, `compactBudget` is not one |

`EF_MEMORY_WINDOW` is read in exactly two places and neither touches the engine:
`run_cell.py:262` (the calibration **target**) and `build_corpus.py:362` (corpus generation).

**Verdict: a value set in `run-memory.sh`'s environment reaches the engine.** The chain has no
filter and no re-default. `docs/129` §2 is right that `run-memory.sh` sets neither, and right
that `EF_MEMORY_WINDOW` alone does not raise the engine window; the inference that the export is
then *lost* does not hold, and §4 below shows the re-run's own fold lineage contradicting it.

## 2. Import time or call time?

**Import time — and here that is equivalent to call time.** `bridge-host.ts:131` is a top-level
`const`, evaluated when the node process boots. But `ef_bridge_client.py:132` spawns **one host
per episode** (`EpistemicFoldBridge.__init__`), and the env dict is built at `:113` *before* that
spawn, from a parent that already has the export. The reader therefore starts after the value
exists. The "looks like it worked" failure mode the lead asked about would need the reader to be a
*long-lived* process that outlived the export; it is not.

Two residual hazards, both real but neither the observed defect:

- `bridge-host.ts:1560` records that the process "can outlive one episode only by accident of how
  Harbor runs it". A second episode in the same process keeps the first episode's window. Nothing
  re-reads the env per episode.
- `Number(...)` at `:131` has no validation. `EF_TAU2_WINDOW=abc` yields `NaN`, which reaches
  `resolveEfCompactSpec` and throws `contextWindow (NaN) must be a positive integer`
  (`policy.ts:451-453`) — at the **first fold**, not at startup.

## 3. Which artifact field would prove which window was used

One exists and is discarded. `CompactBudget` is declared at `bridge-host.ts:270-281` with
`contextWindow`, `thresholdTokens`, `hardCapacityTokens`, `retainTokens`,
`reservedCompletionTokens`, built off `engine.lastCompactSpec` at `:1894-1900`, and emitted at
`:1911` — the header comment at `:357-373` says it exists precisely so an archive can answer
"what budget did this run have?".

`run_cell.py:440-443` writes only:

    "telemetry": {k: telemetry.get(k) for k in
                  ("folds", "roots", "emergencies", "compactionFailures",
                   "compactionFailureKinds", "promptTokensLast", "surfaceNodesLast",
                   "costTotal", "providerFailures")},

`compactBudget` is absent. So is `efToolsOffered` (`bridge-host.ts:1943`) — the field that
would have answered the lead's tool question without this audit — and `pressureRegime`, `budget`,
`modelCalls`, `bundleWrites`, `pendingIntents`, `timing`.

**That is the defect.** The engine publishes the budget, the adapter counts the repairs, the host
records whether EF tools were offered, and the driver's whitelist drops all three. The window has
to be inferred from `foldLineage`, which is what §4 does. `run_cell.py:279` does record a
`window` key — but only in the calibration path, and it is `EF_MEMORY_WINDOW`, the *target's*
window, not the engine's.

## 4. Reachability arithmetic, and which window the observed surface implies

Constants as the run resolves them: `thresholdRatio = 0.5` (`bridge-host.ts:1764`),
`headroomTokens = 0` (`:1765`), quality `retainRatio = 0.24` (`preset.ts:150,160,286`),
`reservedCompletionTokens = 0` (`policy.ts:49-51` reads `requestHeader().config.maxTokens`,
which `bridge-host.ts:1804-1807` never writes, then `defaultMaxTokens`, which the adapter does
not publish — noted at `:120-129`).

At **W = 258,048**:

    messageBudgetTokens = 258048 - 0                       = 258048
    thresholdTokens     = floor(min(258048 x 0.5, 258048)) = 129024
    retainTokens        = floor(258048 x 0.24)             = 61931
    target (0.30W)      = int(258048 x 0.30)               = 77414
    invariant retain < threshold: 61931 < 129024           OK

**Is 77,414 reachable as a state? Yes.** `retainTokens` is the floor a fold cannot go below, and
`61931 < 77414 < 129024`: any post-fold surface in `(61931, 77414]` satisfies the target, and
one that low does not even trigger a fold. Retention does not block the target at this window.

At the **32,000 default** it is unreachable, for a different reason than retention:
`thresholdTokens = 16000`, `retainTokens = 7680`, so the target (77,414) is **4.8x the threshold
and 2.4x the window itself** — a surface at the target would fold immediately.

**What a depth-1 fold predicts, and what was observed.** The retention walk accumulates from the
tail and stops at `retainTokens` (`src/basic/region.ts:151`), so a fold lands at
`retainTokens + the overshooting node + the summary`.

| run | W_engine | predicted landing | observed |
|---|---|---|---|
| 11:30 calibration (docs/129 §2, before overwrite) | 32,000 | ~7,680 + node | **11,074** — consistent |
| 11:43 `result_A` `foldLineage[0]` (leaf, before 1,086,457, shadowed 1,021,285) | 258,048 | 61,931 + node | **65,192** — consistent (node + summary = 3,261) |

The 11:43 landing is **6.5x** the 32,000 prediction. It also bounds the window: `after >= retain`
gives `W_engine <= 65192 / 0.24 = 271,633`, and no window near 32,000 can retain 65K tokens. So
`W_engine` in the re-run was in `(32,000, 271,633]`, consistent with the 258,048 the invocation
asked for, and **not** the default. The export reached the engine; the unchanged
`accuracy None (unparsed 204)` is a measurement failure, not a wiring failure.

(Read `telemetry.promptTokensLast = 65,252` alongside it — same fold, same order of magnitude.)

## 5. The tool surface on `append`/`step`, and where the unanswered `tool_call` comes from

Asked directly by the lead, and the answer is the opposite of what the `[]` suggests.

**Does the bench offer tools?** `run_cell.py:250` and `:298` call `bridge.init(SYSTEM_PUSH, [])`;
`bridge-host.ts:1518` stores `tools = request.tools`. So the *benchmark's* tool list is empty.
But the list actually sent is built by `toolSchemas()` (`bridge-host.ts:1208-1221`):

    const efTools = (runtime?.schemas() ?? []).map(...)
    return [...benchmarkTools, ...efTools]

and it is sent on every call at `bridge-host.ts:1353` (`tools: toolSchemas()`). The EF plugin
registers `context_search` / `context_recall` because `mountRuntime(ctx, { tools: true })` runs
at `:1579`, the runtime is captured at `:1656`, and the plugin is constructed at `:1793-1798`.
`:514-515` states the property in the source: "`toolSchemas()` forwards `ctx.tools.schemas()`
to the provider UNCONDITIONALLY — it has no notion of the arm".

**So the memory bench DOES offer the two EF recall tools, on every call, silently.** The host
records it as `efToolsOffered` (`:1943`); `run_cell.py:440-443` drops it.

**Can this path produce an unanswered tool_call? Yes, and it did.**

1. The model calls a tool. The host appends `tool/call` events (`:1482-1486`) and returns
   `content: null` with `tool_calls` (`:1487-1491`).
2. `run_cell.py:400` reads **only** `reply.get("content")` → `""`. `reply["tool_calls"]` is
   never inspected, and no `tool/result` is ever appended.
3. `call_tool` exists at `ef_bridge_client.py:355` and is called from exactly one place in the
   repository: `eval/lhtb/ef_lhtb_agent.py:766`. **Zero call sites in `eval/memory`.**
4. The next request's history therefore holds an unanswered `tool_call`; the adapter synthesises a
   placeholder result and counts it (`openai-adapter.ts:462-499`).

Evidence, `ef-phase7-logs/memory-bridge-stderr.log` (mtime **11:43:38**, i.e. inside the A run that
wrote its result at 11:43:40): 99 lines, **37** of them `repaired an invalid tool shape`, each
reporting **2** unanswered `tool_call(s)` (one reporting 1). Only `run-memory.sh:34` points
`EF_BRIDGE_STDERR` at this file; `run-lhtb.sh:301` uses a different path — so the log is the
memory lane's. Corroboration: `result_A` `probe_provider_failures = 17` of 20 batches,
`telemetry.providerFailures = 17`, `probe_seconds = 23.5` (~1.2s per rejected batch), and
`reply_head = "(no response)"` — the host's own placeholder (`bridge-host.ts:184`).

**Conclusion for the lead: the malformed history is produced by the memory bench itself. LHTB is
not the more likely source, and does not need to be investigated for this symptom.** The bench both
offers tools it believes it is not offering and has no code path to answer them.

## 6. Every place the driver can silently succeed

| # | site | the silent success |
|---|---|---|
| 1 | `run_cell.py:396-398` | the probe turn is rendered (23,123 chars recorded in `probe_turn_chars`, `:430`) but never appended; `turn` is consumed only by `len(turn)` at `:397`. No question is asked, the cell is scored anyway, exit 0 |
| 2 | `run_cell.py:493` + `:462` | `--calibrate` and mode A share `result_{mode}_{arm}_{order}.json`, and `--mode` defaults to `"A"`. **Already observed**: docs/129 read this file at 11:30 as a calibration (`window: 262144`, `sweep`, `depth_to_target: 1`, `reached: true`); it is now (11:43:40) a mode-A cell result with no `sweep`/`window`/`reached` keys. The re-run destroyed the calibration record |
| 3 | `run_cell.py:273, 276, 284` | `committed and tokens <= target` accepts **any** surface at or below the target as `reached`, a collapse included; `reached: bool(reached)` reports it as success |
| 4 | `run_cell.py:486-507` | both branches print `wrote {path}` and return 0. There is no non-zero exit for an unreached calibration or an all-unparsed cell — confirmed by all four artifacts (`scored: 0`, `accuracy: null`) |
| 5 | `run_cell.py:400` | a tool-call reply (`content: null`, `bridge-host.ts:1490`) becomes `""` and is counted as `unparsed`, indistinguishable from a model that answered nothing |
| 6 | `run_cell.py:440-443` | the whitelist discards `compactBudget`, `efToolsOffered`, `pressureRegime`, `budget`, `modelCalls`, `timing` — the fields that would have made this audit a read instead of an inference |
| 7 | `run_cell.py:351` | `int(bridge.last_telemetry.get("folds") or 0)` collapses `None` to 0; and appends never fold (the host folds only inside `foldIfNeeded`, `:886`, called before a model call), so `folds_natural` is always 0 while the comment at `:339-347` asserts "ingestion alone forces folds" |

For contrast, `last_score.json` (02:26, **not** written by `run_cell.py` — it is written by
`score_probes.py:168` in its own `main`) has `scored: 204, unparsed: 0, accuracy: 0.6078`. A
204-probe scored record exists, so the probe turn has been delivered at some point; the current
driver does not deliver it.

## 7. Not established

- **The exact tool names the model called.** The stderr line counts calls, not names, and neither
  `foldLineage` nor the telemetry whitelist records `reply.tool_calls`. The mechanism (EF tools
  offered → called → unanswered) is established; that the calls were specifically
  `context_search` / `context_recall` is inferred from the offered set, not read.
- **Why the provider still rejected 17–21 requests** after the adapter repaired the shape.
  `openai-adapter.ts:485-491` **appends** the placeholder result to the end of the message list
  rather than inserting it after the assistant message that called it, which may not satisfy the
  provider's ordering rule. Out of this audit's scope and not diagnosed here.
- **Which window the 11:30 calibration used, as a read.** That artifact was overwritten (row 2
  above); the 11,074 figure comes from docs/129 §2, and the 32,000 attribution is an inference from
  retention, consistent but not recorded.
- **Whether the probe-turn append was ever present and removed.** `git diff --
  eval/memory/run_cell.py` is empty and `git log` shows five commits touching it; nothing in the
  working tree differs from HEAD. `last_score.json` shows a scored run existed, but its driver
  invocation was not observed, so whether an append was deleted or never written is not established.
- **Whether 258,048 rather than 262,144 was the engine window in the re-run.** Both are inside the
  `(32,000, 271,633]` bound the fold lineage gives; the artifact cannot separate them.

## 8. Minimal fixes (ours; none applied)

1. **Send the probe turn.** One line at `run_cell.py:397`:
   `bridge.append({"role": "user", "content": turn})` before `step_with_retry`. Without this
   every other number in the artifact is void.
2. **Stop offering EF tools to the memory bench, or answer them.** Pass a flag through `init` and
   honour it in `toolSchemas()` (`bridge-host.ts:1208-1221`), since `[]` is not enough; and if
   the bench is meant to exercise recall, add the `call_tool` loop the LHTB agent has
   (`ef_lhtb_agent.py:766`).
3. **Widen the telemetry whitelist** (`run_cell.py:440-443`) to pass `compactBudget` and
   `efToolsOffered` through verbatim — the engine already computes both.
4. **Give `--calibrate` its own filename** and refuse an all-unparsed cell with a non-zero exit,
   so a run that measured nothing cannot be archived as a result.
5. **Keep the `EF_TAU2_WINDOW` export** (`run-memory.sh:24-34`) even though it already works: it
   is the only thing distinguishing the two windows, and record it as docs/129 §6.1 proposed.
