# 76 — Episode closure, model-work audit, and operational recall through the real ToolRuntime

Status: episode operator-censored; operational recall proven keyless. 2026-10-14. Parent `28e00c0`.

## 1. Episode lifecycle: OPERATOR-CENSORED

Harbor `0.7.0` has **no stop/cancel command**: `harbor job` offers only
`resume | summarize | share | download | start`. So the episode was ended by the operator, and the
actual method and result are recorded rather than dressed up as a supported cancel:

* transcript snapshot saved BEFORE stopping (`ef-phase7-logs/episode-snapshot/ef-transcript.snapshot.json`,
  27,102 bytes, sha256 `B766C161F8AC4E7D…`), because `lock.json` declares `environment.delete: true`;
* `harbor` pid 59416 stopped; trial `python` gone; container
  `unknown-config-semantics__unnas3j-main-1` stopped; `docker ps` empty;
* **one orphaned `bridge-host` node process (pid 71832) was found** -- killing the harbor parent does
  not reap the Node bridge. It has no driver left, so it blocks on stdin and issues **no** API calls,
  but it was NOT successfully reaped: `Stop-Process` and `taskkill /T` both collided with the tool's
  own Windows job object. Reported as **still present**, not as a clean sweep.

Final state of the archive: `termination = in-progress`, `modelCalls = 16`, `shell_calls = 20`,
`folds = 0`, `provider_failures = 0`, `promptTokensLast = 23909`. **No completion record was
fabricated.**

Classification: **operator-censored**. Nothing failed; the operator stopped it.

## 2. The 14/16 model calls: my previous `shell_calls = 1` was a MEASUREMENT ERROR

`shell_calls` is an `Int32`, not an array. `@($j.shell_calls).Count` therefore returned `1` for every
run. The real figure is **20**. Corrected audit of the stopped episode:

| | |
|---|---|
| model calls | 16 |
| shell executions (`run_shell`) | **20** |
| `context_search` calls | **0** |
| `context_recall` calls | **0** |
| any other tool | **0** |
| empty replies / truncations | 0 / 0 |
| provider failures | 0 |

**Why ~1.25 shell executions per model call:** the model batches -- e.g. `for i in 1 2 3; do cfg
sample; done` (turn 14) and `for i in $(seq 1 8); do cfg sample >> /tmp/w/samplesA.txt; done`
(turn 15). It is not looping on a failed tool.

**It never called a recall tool, and that is correct:** no fold had occurred, so there was no
archive. `context_search` would have answered `no-archive`. There is no ineffective-recall loop to
fix, and the previous round's suspicion that the model was "repeatedly recalling" was unfounded --
it was running the task.

### 2.1 Is there real work? Yes

The last turns sample the task's own `cfg` tool and accumulate evidence:

```
turn 14  cd /opt/cfg && for i in 1 2 3; do cfg sample; echo "-----"; done
         -> SAMPLE for stage A (1/45 of budget used): {"worker_count":16,"batch":128}
turn 15  ... for i in $(seq 1 8); do cfg sample >> /tmp/w/samplesA.txt; done
         -> SAMPLE for stage A (4/45 of budget used)
turn 16  ... for i in $(seq 1 10); do cfg sample >> /tmp/w/samplesA.txt; done; tail -40 ...
         -> SAMPLE for stage A (9/45 of budget used)
```

Stage A, budget counter advancing 1 -> 4 -> 9 of 45, evidence written to a file. **Substantive
progress, not a stall.**

## 3. Operational recall: proven through the real ToolRuntime, keyless

Coverage before this round: `tests/harness-recall-tools.spec.ts:146` executes `context_search`
through the real runtime, and exact-depth recall is exercised widely -- but at the LIBRARY level
(`recall(...)`) in `recall-reachability`, `m0-core`, `referential-archive`, `cross-session-recall`
and others. **Nothing executed either tool through the bridge's `op:"tool"` dispatch**, which is the
path the LHTB lane actually uses.

`tests/task-root-bridge.spec.ts` now closes it. Against the real `bridge-host.ts` process, the real
plugin, the real `SessionStore` and the real ToolRuntime:

1. the task root is registered and, being protected, is NOT folded -- so it cannot serve as the
   archived sentinel;
2. a SEPARATE message carries a nonce (`zqxjvbnonce`) that appears nowhere else;
3. a real leaf fold commits and archives real messages;
4. `{"op":"tool",name:"context_search"}` is dispatched and returns parseable JSON containing
   `cp:` references;
5. `{"op":"tool",name:"context_recall",arguments:{ref,depth:"exact",offset:0,limit:20}}` is
   dispatched for the surfaced references;
6. **the recovered page contains the nonce AND its original wording** -- the archived bytes came
   back, not a summary of them.

## 4. What is still NOT covered

The chain `model tool-call -> Python EFLhtbAgent -> bridge op:tool -> ToolRuntime -> Tool Result ->
Session` is proven for **the bridge half** (steps 3-6 above) and for the tool schemas. The **Python
dispatch branch** in `ef_lhtb_agent.py` -- routing a model tool call to `op:"tool"` and appending
the returned content -- was not executed this round, and the natural episode never exercised it
either (zero recall calls). It is **NOT ESTABLISHED**; a keyless stub-driven Python test would close
it without any provider traffic.

## 5. Provenance of the run configuration

`eval/lhtb/lhtb-ef-probe.yaml` and `scripts/rescore-lhtb-vectordb.py` were **dirty** (tracked, modified
in the worktree) before and after this round. They were **not** cleaned, reset or overwritten. The
episode's effective configuration is therefore **dirty-config provenance**, not the committed
revision, and the run must not be described as pinned to a clean tree. The generated harbor config
is in `lock.json` (`agent.env: {}`, so `EF_LHTB_TASK_ROOT_MODE` reached the agent by host-environment
inheritance -- and it did take effect, `task_root.status = resident`). No key, session-header value
or task text is recorded here.

## 6. Cost

**New real model requests this round: 0.** The episode's own totals at the snapshot: prompt 292,676 /
output 9,702 / cacheRead 222,976 tokens over 16 calls, 0 provider failures, 0 retries, 0 timeouts.
No cost figure is quoted: `costTotal` uses a proxy price profile, so it would be an estimate, not a
bill.
