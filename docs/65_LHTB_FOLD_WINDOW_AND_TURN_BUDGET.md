# 65 — The fold window was smaller than the task, and the turn cap was smaller than the budget

Status: root cause measured and reproduced, fix applied, probe not yet run. This document is the
record of a DIAGNOSTIC round, not a result: see §11 for the cohort boundary.

## 1. What the round produced

Four arms x n=3 on `deepseek-v4.1-flash`, one task (`unknown-config-semantics`), patched task
harness (`ccefd69`, docs/64). Ten cells finished; every one scored 0.

| arm | calls | folds | folds/call | surface at end | evicted over the episode | reward |
|---|---|---|---|---|---|---|
| economy | 401-409 | 50-65 | 0.124-0.159 | 12,490-15,573 | 543K-713K | 0 |
| balanced | 401-412 | 61-80 | 0.148-0.200 | 13,858-15,394 | 489K-666K | 0 |
| quality | 401-409 | 79-109 | 0.193-0.267 | 11,470-14,510 | 644K-803K | 0 |
| **basic** (control) | 121-146 | **0** | 0 | 13,106-13,703 | 0 | in progress |

Eight of the eight finished cells archived an `engine.py` **byte-identical to the shipped buggy
file** (4839 bytes, sha256 `744cfbdf5ec4`). Ten of eleven cells with a transcript never attempted a
write to `/opt/cfg/engine.py`; the one that did is a `basic` cell, and it reached `A:15/21`.

`termination` was `turn-budget-exhausted` for all ten. Cost: $6.79 for eleven cells.

## 2. The root cause: a 16,000-token threshold against a 16,471-token working set

`eval/tau2/bridge-host.ts` decides the budget:

```
:101   TAU2_WINDOW    = EF_TAU2_WINDOW ?? 32_000
:1400  thresholdRatio = EF_TAU2_THRESHOLD ?? 0.5
:1401  headroomTokens = 0
:1328  adapter <- contextWindow: TAU2_WINDOW      // overrides the adapter's own 131_072
```

`resolveEfCompactSpec` (`src/policy.ts:386-431`) then computes
`thresholdTokens = floor(min(W x alpha, W - reserve - headroom))`. The reserve is 0 in this lane
(§9 F6), so **the fold threshold was 16,000 tokens**.

The task's own working set:

| file | ~tokens |
|---|---|
| instruction.md | 1,625 |
| spec.md | 1,160 |
| cfg_daemon.py | **7,831** |
| cfg_cli.py | 1,904 |
| engine.py | 1,344 |
| engine_runner.py | 688 |
| cfgd_public.json | 1,920 |
| **total** | **16,471** |

**The threshold was 471 tokens smaller than the material the task requires.** And the verbatim
retain budget was smaller still: `32_000 x 0.16 = 5,120` (economy/basic) and `32_000 x 0.24 =
7,680` (balanced/quality, `src/preset.ts:150`) -- both below `cfg_daemon.py` alone.

Measured consequence: every EF cell's surface ended pinned just under the threshold
(11,470 / 12,490 / 13,858 / 14,510 / 14,773 / 14,827 / 15,120 / 15,394 / 15,573), because the
agent could never hold the working set and the fold kept evicting what it had just read.

## 3. What one fold costs

**The first fold fires at +181 seconds** and shadows the task instruction itself. Archive
`56aee82f-654a-4c4f-acc7-be79bb912da1`:

```
mode: leaf,  createdAt = 181 s after the session opened
source.orderedSurfaceSeqs: [2,6,10,11,17,48,50,28,52,54]
shadowedMessages[0] = { role: "user",
    text: "You must RECOVER THE TRUE SEMANTICS of an undocumented job-config format and..." }
rendered.text = "[EF1 L cp:56aee82f-654a-4c4f-acc7-be79bb912da1]"     <- a marker, not a summary
```

`summarizationAttempts` is **0** on every EF arm: an EF leaf fold is a deterministic marker fold
with no LLM call, so the replacement is an opaque pointer. `context_recall(depth="summary")` and
`depth="detail"` return that same pointer; only `depth="exact"` returns content. Each cell
recovered the instruction once.

`shadowedSeq2` appears in exactly **1 of N** folds per cell (N = 50..109): the instruction is folded
once, by the first fold, and thereafter exists only in the archive.

The cost per fold, from `foldLineage.tokensBefore - tokensAfter`:

| cell | folds | first fold | evicted/fold | total evicted | = working sets |
|---|---|---|---|---|---|
| 9zeBtpL | 50 | 16,179 -> 7,216 | 11,010 | 550,496 | 33.4 |
| kdLBQcH | 65 | 17,043 -> 5,518 | 10,973 | 713,252 | 43.3 |
| jHueNNH | 80 | 17,885 -> 8,017 | 8,321 | 665,688 | 40.4 |
| FKwpBdb | 109 | 17,158 -> 8,512 | 7,371 | 803,470 | 48.8 |

**Each fold evicted 7-11K tokens of material the agent had just paid a turn to read; the episode
evicted the whole working set 30-49 times.**

## 4. The treadmill

| arm | folds | `cfg_daemon.py` re-reads | `engine.py` re-reads |
|---|---|---|---|
| basic (folds 0) | 0 | **26-27** | **5-8** |
| economy | 50-65 | 127-150 | 48-58 |
| balanced | 61-80 | 125-138 | 44-67 |
| quality | 79-109 | 101-168 | 35-56 |

A fold removes the material; the agent re-reads it; re-reading adds surface nodes; the next fold
arrives sooner. The commands are dominated by re-reading, by hunting for the hidden oracle
(`/proc/8/mem`, `find / -name '*secret*'`), and by mining the agent's own transcript.

## 5. The control, inside the same round

Same model, same task, same budget, same patched harness -- only the arm differs:

| | basic (folds 0) | the three EF arms |
|---|---|---|
| engine.py | **MODIFIED** (6,986 B) | byte-identical to shipped |
| stage A | **15/21** | 0/21 |
| `cfg probe` calls | 22 | 0-1 |
| submissions | (in progress) | 0 |

That isolates folding, not capability, as the cause for this model.

## 6. Why step-5 differed, and why the premise is half wrong

**step-5 folded the instruction away too.** The fold frontier always takes the oldest nodes and the
instruction is seq 2 in every session, so any fold shadows it. step-5's transcripts predate the
`foldLineage` field and its bundles have been cleaned from the temp root, so this is inferred from
the structure rather than displayed -- but nothing about it is model-dependent.

What differed is **how much was thrown away, and how often**:

| | step-5 (scored cells) | 4.1F |
|---|---|---|
| folds | 2 / 10 / 17 | 50-109 |
| folds per call | 0.030-0.041 | 0.124-0.267 |
| surface at end | 8,550 / 14,917 / 11,248 | 11,470-15,573 |
| surface nodes at end | 24 / 44 / 67 | 85-129 |
| tool calls per turn | 1.00-1.08 | 1.15-1.64 |
| calls | 57-266, finished | 401-412, budget exhausted |
| reward | 0.5432 / 0.6 / 0.7977 | 0 |

**And step-5 proves the instruction itself is not the binding thing**: the balanced cell scored
**0.7977 with ZERO `context_recall`/`context_search` calls** -- it never reconstructed the goal from
the archive and never needed to. What it needed was the *working material*, and it kept that inside
8.5K tokens by working in fewer, larger steps (67 calls, 1.00 tool calls per turn). 4.1F issued
1.15-1.64 tool calls per turn, ended holding 1.2-1.9x more nodes, and ran the full 400 turns
continuously at the ceiling, so the eviction happened 50-109 times instead of 2-17.

Three explanations that are tempting and measured FALSE:

* "step-5's folds summarised, 4.1F's only left markers" -- both cohorts report
  `summarizationAttempts: 0` on EF arms; leaf folds are marker folds in both.
* "4.1F writes longer replies" -- output per call: 4.1F 536-716, step-5 204-764.
* "step-5 kept the instruction in context" -- it made zero recall calls and still scored 0.80.

## 7. The turn cap

`eval/lhtb/ef_lhtb_agent.py:59` defaults `EF_LHTB_MAX_TURNS` to 400 and nothing ever raised it.
Every EF cell ended `turn-budget-exhausted` at 401-412 calls, about **2h31m into a task whose own
agent budget is 28800s (8h)** and whose Harbor override is 86400. 5.5 hours went unused and the
cells were ended by our cap rather than by the task -- the same defect this repository already
fixed once for `override_timeout_sec`; the time budget was raised 14400 -> 28800 and this cap was
not raised with it.

## 8. The transcript was readable inside the task container

`ef_lhtb_agent.py` writes `ef-transcript.json` into `logs_dir` after every step, and Harbor mounts
`logs_dir` into the task container at `/logs/agent`. Measured: **18-137 commands per cell** were
spent dumping, pickling and grepping it, and **38 commands across the round read `arm`,
`provenance`, `telemetry` or `termination` out of it** -- the payload carries `"arm": "economy"`,
`efToolsOffered`, `pressureRegime` and `costTotal`. A cell whose model can see which arm it is is
not a clean observation of that arm, and `efToolsOffered` is the field the `basic` baseline is
audited on. That is a measurement-integrity leak, not only a budget cost.

## 9. The fix

| | change | where |
|---|---|---|
| F1 | fold window from the MODEL, not a lane constant: `EF_TAU2_WINDOW` resolved from `EF_LIVE_MODEL` (131,072 for `deepseek-v4.1-flash`, the adapter default otherwise, and the log says which) | `scripts/run-lhtb.sh` |
| F2 | publish the budget: `compactBudget` = window, threshold, hard capacity, retain and reserve, read off the engine that acted on them (`engine.lastCompactSpec`) | `src/engine.ts`, `eval/tau2/bridge-host.ts` |
| F3 | `EF_LHTB_MAX_TURNS` 400 -> **1200**, derived from the protocol's ~185-gated-turn floor and step-5's 57-583 calls | `scripts/run-lhtb.sh` |
| F4 | write the transcript one level up, to `<cell>/ef-transcript.json`, which is NOT mounted into the container; readers accept BOTH paths so the existing corpus stays readable | `eval/lhtb/ef_lhtb_agent.py`, `scripts/analyze-lhtb-round.py`, `eval/lhtb/watchdog.ts`, `tests/ef-collect.spec.ts` |
| F5 | (not applied) pin the first user message so a leaf fold cannot shadow it -- a product-level change affecting every lane | -- |
| F6 | recorded, not changed: `reservedCompletionTokens` is 0 because the adapter publishes no `defaultMaxTokens`, so a 32,768-token completion is requested against a 32,000-token window with no reservation | `eval/tau2/bridge-host.ts` |

F1 deliberately does **not** change `bridge-host.ts`'s 32_000 default: that is the tau2 lane's
recorded choice and RC9's null result was measured at it. The escape hatch existed and was never
used -- `EF_TAU2_WINDOW` appeared exactly once in this repository, at its own default.

The window is measured where it can be. The route's `/models` publishes no context length
(`id/object/created/owned_by` only), so for `deepseek-v4.1-flash` it was measured directly: a
**~250K-token prompt was accepted with HTTP 200**, which makes 131,072 conservative rather than a
guess. Any other model takes the adapter default and the launcher SAYS SO, so a reader can tell a
measured window from an assumed one.

Expected arithmetic after F1 (`alpha = 0.5`, reserve 0):

| | before | after |
|---|---|---|
| window | 32,000 | 131,072 |
| threshold | 16,000 | **65,536** |
| hard capacity | 32,000 | 131,072 |
| retain (economy/basic 0.16) | 5,120 | 20,971 |
| retain (balanced/quality 0.24) | 7,680 | 31,457 |

## 10. Verification, and what would falsify the diagnosis

A single probe cell must satisfy ALL THREE, or the 12-cell wave is not worth buying:

1. `folds/call` falls from 0.124-0.267 to **<= 0.06**;
2. the surface stops being pinned: some request reports `promptTokensLast >= 25,000`;
3. the cell writes `/opt/cfg/engine.py` and runs at least one `cfg probe`.

F2 exists so that (1) and (2) can be read straight out of the archive instead of being
reconstructed from a decompressed bundle, which is what this round required.

## 11. Cohort boundary

This round ran with `EF_TAU2_WINDOW = 32_000` and `EF_LHTB_MAX_TURNS = 400`. It is a DIAGNOSTIC
round: it may be reported as evidence about the harness, and it must not be pooled with the
step-5 corpus (different task revision, different model) or with any post-F1 wave (different
window and turn cap).

`step-5-preview-free` is still listed by `/models` but returns HTTP 429 `Upstream request failed:
Endpoint is unavailable.` on 8 of 8 attempts, so that cohort cannot be extended; comparisons stay
cohort-to-cohort.
