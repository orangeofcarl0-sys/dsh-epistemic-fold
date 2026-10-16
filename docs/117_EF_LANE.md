# 117 — The EF lane's own waits: every one, its bound, and which bounds do not hold

Status: **audit complete; four gaps are ours to fix.** 2026-10-16.
Repo revision `c9dc2e5` (working tree dirty: `scripts/run-lhtb.sh`, `eval/lhtb/lhtb-ef-probe.yaml`,
`scripts/rescore-lhtb-vectordb.py` are modified). Line numbers are from the working tree as read.

Method: read-only. I read `eval/bridge/ef_bridge_client.py`, `eval/lhtb/ef_lhtb_agent.py`,
`eval/tau2/bridge-host.ts`, `scripts/run-lhtb.sh`, plus `eval/live/openai-adapter.ts`,
`scripts/check-route.mjs`, `eval/lhtb/watchdog.ts`, `eval/lhtb/watchdog-policy.ts`, the LHTB configs
and `task.toml`, and (read-only, outside the repo) Harbor's `trial/trial.py` and
`environments/docker/docker.py`. **No episode was started, no model call was made, no test was run.**

This builds on docs/113-115. It does not re-derive the localization: the agent is suspended at
`environment.exec` and the episode never ends. It audits every *other* wait in our lane for the same
defect class, and separates what is ours from what is Harbor's.

---

## (a) Every place this lane can wait, and its bound

`bound` is what actually stops the wait. `enforced` is whether that bound has been observed to hold.

### A. The agent — `eval/lhtb/ef_lhtb_agent.py`

| # | site | waits for | bound | enforced |
|---|------|-----------|-------|----------|
| A1 | `:329` `await environment.exec(command=command, timeout_sec=900)` | one shell command in the container | **900s, a hardcoded literal** | **NO** — see §2 |
| A2 | `:447`, `:548`, `:621`, `:655`, `:723` `self._bridge.step(...)` | next model reply | 1200s (`EF_BRIDGE_READ_TIMEOUT_SEC`, `ef_bridge_client.py:81`, `:213`) | yes — and it **returns** a synthetic provider-failure dict (`ef_bridge_client.py:214-226`) rather than raising |
| A3 | `:384` `self._bridge.init(...)` | host mounted the session | 1200s | yes |
| A4 | `:403`, `:605`, `:645`, `:713` `self._bridge.append(...)` | append ack | 1200s | yes |
| A5 | `:706` `self._bridge.call_tool(...)` | EF recall tool result | 1200s | yes |
| A6 | `:363`, `:733`, `:821` `self._bridge.close()` | close handshake, then child exit | 5s handshake (`ef_bridge_client.py:93`, `:388`) + terminate + 10s wait (`:393`) | yes |
| A7 | `:536` `time.sleep(min(2**min(n,6), PROVIDER_BACKOFF_MAX_SEC))` | provider backoff | ≤60s (`:163`) | yes |
| A8 | `:465` `while turn < MAX_TURNS` | the whole episode | **no wall-clock bound at all.** `MAX_TURNS` is a count (400 default `:59`; 1200 from `scripts/run-lhtb.sh:363`); `PROVIDER_OUTAGE_MAX_SEC` (`:148`) only accumulates while failures are *consecutive* and resets on any success (`:551-552`); `MAX_WASTED_ATTEMPTS` (`:176`) is a count | n/a — there is no episode deadline in this file |

### B. The bridge client — `eval/bridge/ef_bridge_client.py`

| # | site | waits for | bound | enforced |
|---|------|-----------|-------|----------|
| B1 | `:210-211` `self._proc.stdin.write(...)` + `flush()` | the host to accept a request | **NONE.** Blocks once the OS pipe buffer fills and the host is not reading | not observed to bite (requests are small); it is unbounded in principle |
| B2 | `:168` `for line in self._proc.stdout:` (pump thread) | the host to write | **NONE, by design** — this thread is *why* B3 can be bounded; daemon, and never joined by `close()` | n/a (see docs/114 §B: the pump sitting on the pipe is the mechanism working) |
| B3 | `:181` `self._lines.get(timeout=timeout)` via `:213` | one response line | 1200s default; 5s for the close op (`:388`) | yes |
| B4 | `:193` `(self._proc.stderr.read() or "")` | host stderr EOF | **NONE** on the `subprocess.PIPE` branch, reached only when `EF_BRIDGE_STDERR` is unset (`:126`) | **not reachable in this lane**: `scripts/run-lhtb.sh:301` always sets `EF_BRIDGE_STDERR`, so the file branch (`:187`) is used |
| B5 | `:388` `self._send({"op": "close"}, timeout=self._close_timeout_sec)` | close ack | 5s | yes |
| B6 | `:393` `self._proc.wait(timeout=10)` | child exit | 10s, then `kill()` (`:396`) — but **no `wait()` after the kill**, so `close()` can return with the child not yet reaped | yes (bounded) |
| B7 | `:147` `atexit.register(self.close)` | interpreter shutdown | 5s + 10s | yes |

### C. The Node host — `eval/tau2/bridge-host.ts`

| # | site | waits for | bound | enforced |
|---|------|-----------|-------|----------|
| C1 | `:1961` `for await (const chunk of process.stdin)` | the next request from the agent | **NONE — no timer, no heartbeat, no inactivity check** | **this is the sampled state** (docs/113): the host is healthy and idle, waiting for an agent that will never send |
| C2 | `:1343` arms, `:1354` passes `signal: deadline.signal` | one main model call | 900s (`EF_TAU2_STEP_TIMEOUT_MS`, `:174`; 0 disables) | yes |
| C3 | `:915` arms, `:960` `compactIfNeeded(agent,'pressure',deadline.signal)` | one pressure fold + its summarization | 600s (`EF_TAU2_FOLD_TIMEOUT_MS`, `:150`; 0 disables) | yes |
| C4 | `:1101` arms, `:1104` `task(deadline.signal)` | one idle rebase | 600s | yes |
| C5 | `:1117` `await mounted.idleRebase?.settled()` | the idle consumer's in-flight promise | **no deadline of its own.** It inherits C4's abort only if the maintenance task honours the signal; `settled()` itself is an unbounded `await inFlight` (`src/idle-rebase.ts:217-223`) | bounded only indirectly |
| C6 | `:2098` arms, `:2100` `engine.compactNow(..., deadline.signal)` | one forced root fold (`rootCompact` op) | 600s | yes (the LHTB lane never sends this op) |
| C7 | `:1656` `await captureToolsRuntime()` → `ctx.inject(['tools'], cb)` (`:1249-1256`) | the `tools` service to exist | **no deadline of its own** | settles in this lane: `init` mounts the ToolRuntime before this call |
| C8 | `:1979` `await init(...)` | context construction, lazy pruner `import`, adapter registration | local work, no external wait | n/a |

### D. The provider adapter — `eval/live/openai-adapter.ts` (the innermost bound)

| # | site | waits for | bound | enforced |
|---|------|-----------|-------|----------|
| D1 | `:325` `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` combined with the caller signal at `:328` | one HTTP attempt | `EF_LIVE_REQUEST_TIMEOUT_MS`: 120s default (`:203`), **300s for `deepseek-v4.1-flash*`** (`scripts/run-lhtb.sh:176`, `:180`) | yes |
| D2 | `:369-375` retry loop | a 429 to clear | ≤3 retries (`:173`) with ≤30s waits (`:215`, `:391-394`) | yes — but see §6 |

### E. The runner — `scripts/run-lhtb.sh`

| # | site | waits for | bound | enforced |
|---|------|-----------|-------|----------|
| E1 | `:377-384` `node check-route.mjs` | route preflight | 30s (`scripts/check-route.mjs:109`) | yes |
| E2 | — | — | the runner does **not** set `EF_TAU2_STEP_TIMEOUT_MS`, `EF_TAU2_FOLD_TIMEOUT_MS`, `EF_BRIDGE_READ_TIMEOUT_SEC` or `EF_BRIDGE_CLOSE_TIMEOUT_SEC`; all four take code defaults | n/a |
| E3 | — | — | the runner does **not** start `eval/lhtb/watchdog.ts`. Only four ad-hoc launchers do: `ef-ucs.sh:64`, `ef-step5.sh:42`, `ef-sweep2.sh:45`, `ef-probe-foldwindow.sh:21` | **gap** — see §4 |

### H. Harbor, for context only (read-only, outside the repo)

| # | site | waits for | bound | enforced |
|---|------|-----------|-------|----------|
| H1 | `harbor/src/harbor/environments/docker/docker.py:336` | one `docker compose exec` | `asyncio.wait_for(process.communicate(), timeout=timeout_sec)` — our 900s arrives here via `docker.py:556-585` | arms; outcome disputed, §2 |
| H2 | `docker.py:349` `stdout_bytes, stderr_bytes = await process.communicate()` | the pipe to reach EOF after `terminate()`+`kill()` | **NONE** | **this is the documented post-timeout hang** (`eval/lhtb/watchdog.ts:192-197`) |
| H3 | `harbor/src/harbor/trial/trial.py:961-968` | the whole episode | `asyncio.wait_for(self._agent.run(...), timeout=remaining)`, `remaining = _agent_timeout_sec` | see §3 |

---

## 2. The one wait that is not bounded in practice: `environment.exec`

Our `_exec` (`ef_lhtb_agent.py:326-338`) passes `timeout_sec=900` and has **no bound of its own**. It
relies entirely on Harbor honouring that argument. It did not hold: 55+ minutes on the stalled cell
(docs/115 §D) and a 1318s command in the deepseek run.

Two in-repo accounts of *why* exist, and they are not the same:

1. **The bound fired and the timeout handler itself hung.** `watchdog.ts:192-197` is a *measured*
   account: "On expiry it calls `process.terminate()`, waits, then `process.kill()` — all on the LOCAL
   compose client — and then awaits `communicate()` with no timeout. Measured: six of those clients sat
   on the host for 37-59 minutes, and the agent was waiting the whole time." That is `docker.py:341-350`:
   the `except asyncio.TimeoutError` branch ends at `:349` with an **unbounded** `await process.communicate()`.
2. **The bound never fired.** docs/115 §D, from the live sample and the 1318s command.

Both are consistent with everything measured: the event loop idle in `_poll` (docs/114 §B), the pump
thread idle on the bridge's stdout, no runnable task, no error recorded. They differ only in which line
is stuck. **I am not resolving the fork by guessing** — it needs a local reproduction of
`wait_for(process.communicate())` with a pipe held open by a grandchild, which I did not run.

What the fork *does* settle is the shape of the fix. Under (1) the coroutine is stuck in Harbor's own
post-kill `communicate()`; under (2) it is stuck in the original `communicate()`. In **both** cases the
inner await is inside Harbor, and a bound of ours that relies on *cancelling* it is not trustworthy:

- `asyncio.wait_for(environment.exec(...), timeout=T)` cancels the inner coroutine on expiry and then
  **waits for the cancellation to complete**. If the stuck await does not complete its cancellation, the
  outer bound hangs exactly as the inner one did — the same trap, one layer out.
- `asyncio.wait({task}, timeout=T)` **returns `(done, pending)` without cancelling** anything. That
  returns control to us regardless of what Harbor's coroutine does.

That is the difference between a fix and a second copy of the bug, and it is why §5 F1 is written with
`asyncio.wait`.

---

## 3. (b) Is there ANY host-side deadline that would end a wedged episode?

**In our lane: no. Plainly, none.** There is no inactivity timer, no heartbeat, no wall-clock deadline
in `ef_lhtb_agent.py`, `ef_bridge_client.py`, `bridge-host.ts` or `scripts/run-lhtb.sh`. Every bound we
have (A2-A7, B3, B5-B7, C2-C4, C6, D1-D2, E1) arms only while a model call, a fold or a request is
already in flight. When the agent is suspended in `environment.exec`, the host is at C1 (unbounded
stdin read) and no timer in our lane exists to notice. This is why the host sampled as healthy.

**The only host-side deadline is Harbor's episode budget**, and in the current wave it is not a
practical bound:

| where | value | source |
|---|---|---|
| task's own agent budget | 28800s | `tasks/unknown-config-semantics/task.toml:67` `[agent] timeout_sec = 28800.0` |
| config override | 86400s | `eval/lhtb/lhtb-ef-sweep-ucs.yaml:75` `override_timeout_sec: 86400` |
| multiplier | ×3.0 | `eval/lhtb/lhtb-ef-sweep-ucs.yaml:51` `timeout_multiplier: 3.0` (no `agent_timeout_multiplier` is set) |
| **effective agent timeout** | **259200s = 72h** | `trial.py:381-393` `min(override, max_timeout_sec) * multiplier`; then `trial.py:961` `wait_for(agent.run(), timeout=remaining)` |

Two consequences:

- The comment at `lhtb-ef-sweep-ucs.yaml:71-74` says the override "is deliberately the same number" as
  the task's 28800. It is 86400 × 3.0 = **259200**, nine times the number the comment claims. The comment
  is stale, and it hides how long a wedged cell can sit.
- Even that 72h deadline is subject to the same hazard as §2: `asyncio.wait_for` at `trial.py:961` waits
  for the cancellation to complete, so a coroutine stuck in an uncancellable await may never reach
  `AgentTimeoutError` at all. I could not observe this on a live cell and do not claim it; I claim only
  that the deadline is not *guaranteed* to fire, which is the property that matters.

The only mechanism that has ever ended one of these wedges is the **external watchdog**, and only when a
launcher starts it (§4).

---

## 4. (c) Can the lane detect a stalled episode?

**Externally, yes — and it is already built. Inside the episode, no.**

Detection exists in `eval/lhtb/watchdog.ts` + `watchdog-policy.ts`, sampling every 60s
(`watchdog.ts:58`):

| signal | how it is read | thresholds |
|---|---|---|
| seconds since the transcript last changed | transcript mtime (`watchdog.ts:136-139`) | `silenceSec: 300`, `stuckSec: 1800` (`watchdog-policy.ts:69-70`) |
| container process table | `docker top <c> -eo pid,etimes,args` (`watchdog.ts:170`) | orphan = age > `toolTimeoutSec + slackSec` = 900+300 (`watchdog-policy.ts:66-67`, `:123`) |
| verdict | `classifyCell` (`watchdog-policy.ts:144-155`) | `wedged` / `leaking` / `stuck` / `quiet` / `active` |
| action | `reapStuckClients` kills the HOST-side compose client tree with `taskkill /F /T` (`watchdog.ts:209-240`) | **Windows only** (`watchdog.ts:212`) |

Three gaps make this weaker than it reads:

1. **It is not on the shipped path.** `scripts/run-lhtb.sh` never starts it (§E3). A run driven by the
   shipped runner has no reaper at all; only the four ad-hoc root launchers do.
2. **A cell wedged on its FIRST command is invisible.** The transcript is written only *after* a tool
   call completes (`ef_lhtb_agent.py:722`), and never before the first one — the only other write is
   after the loop (`:734`). `watchdog.ts:139` skips any cell with no transcript. So a stall on the
   first `run_shell` produces no file for the watchdog to age.
3. **The lane already measures the quantity that would reveal a stall, but only on recovery.**
   `bridge-host.ts:1294` computes `gapMs = turnStartedAt - lastCallEndedAt` — the gap between calls — and
   publishes `gapMsLast`/`gapMsMax` in telemetry (`:1399-1403`, `:1936-1938`). It is computed when the
   *next* call starts, so a wedge that never produces a next call reports nothing. The instrument exists
   and is aimed at the wrong moment.

What the agent itself can observe but does not use: `time.monotonic()` at tool start
(`ef_lhtb_agent.py:694`) and at the top of the loop. Nothing compares either against a budget; the only
uses of `monotonic` are the provider-outage window (`:511`, `:527`) and tool timing (`:694-696`,
`:705-707`).

---

## 5. (d) Which gaps are ours, and the minimal fix for each

Ordered by harm per unit of risk. All are in `eval/` or `scripts/`; none touches `src/basic/` or the EF
core. **None of these was executed or tested** — they are code-level proposals from this audit.

**F1 (P0) — bound `environment.exec` independently of Harbor's cancellability.**
In `_exec` (`ef_lhtb_agent.py:326-338`), run the call as a task and wait with `asyncio.wait`, not
`wait_for`:

```python
task = asyncio.ensure_future(environment.exec(command=command, timeout_sec=TOOL_TIMEOUT_SEC))
done, pending = await asyncio.wait({task}, timeout=TOOL_TIMEOUT_SEC + TOOL_TIMEOUT_SLACK_SEC)
if task in pending:
    task.cancel()                    # best effort; we do not wait for it
    raise ToolStalled(command)       # -> termination "tool-timeout-exceeded", bridge closed
```

On `ToolStalled` the loop must **terminate the episode** (record the reason, close the bridge, return),
not retry: the abandoned task still holds the subprocess, so a retry would overlap executions. This
covers both accounts in §2, because it does not depend on the inner await completing its cancellation.
Cost **S**, risk **low**. This is the one fix that converts a 55-minute silent wedge into a recorded
termination.

**F2 (P0) — make the wedging command recoverable from the archive.**
Write the transcript **before** awaiting `_exec` (a `{"turn", "tool", "command", "status": "started"}`
record), not only after it returns (`ef_lhtb_agent.py:694-701`, `:722`). Two effects: the last record in
`ef-transcript.json` names the command that wedged, and a cell that wedges on its *first* command gets a
transcript file, so §4 gap 2 closes. Cost **S**, risk **low**.

**F3 (P1) — stop hardcoding the tool timeout, and stop letting it drift.**
`ef_lhtb_agent.py:329` hardcodes `900`; `watchdog-policy.ts:66-67` independently hardcodes
`toolTimeoutSec: 900, slackSec: 300` and derives its orphan threshold from them (`:123`). One number, two
files, no shared source. Read it from `EF_LHTB_TOOL_TIMEOUT_SEC` (default 900) in the agent and pass it
to `exec`; have `scripts/run-lhtb.sh` export it once. Cost **S**, risk **low**.

**F4 (P1) — add an episode-level no-progress deadline.**
A1-A8 shows the loop has no wall-clock bound: `MAX_TURNS` is a count, and every time-based terminator
is about *provider* failure, not progress. Add `EF_LHTB_EPISODE_MAX_SEC` (default: the Harbor agent
budget minus slack, and never more than the task's own 28800) checked at the top of `while` (`:465`),
and terminate with `episode-deadline`. This is the backstop for any stall that is *not* in `exec`.
Cost **S**, risk **low**.

**F5 (P1) — put the watchdog on the shipped path.**
Start `eval/lhtb/watchdog.ts` from `scripts/run-lhtb.sh` (with `EF_WATCH_JOBS`/`EF_WATCH_LOG` set the
way `ef-ucs.sh:62-65` does), so the runner that ships cannot be run without its reaper. State the
platform limitation (`watchdog.ts:212`) in the runner's output rather than in a source comment.
Cost **S**, risk **low**.

**F6 (P2) — reconcile the nested bounds (see §6).** Either raise the outer bounds above the adapter's
worst case, or cap the adapter's retry budget per call. Cost **S**, risk **med** (it changes when a
call is declared failed).

**F7 (P2) — declare the lane's bounds in one place, and fix the stale comment.**
`scripts/run-lhtb.sh` exports the model budget and turn cap but leaves step/fold/read/close timeouts to
code defaults (§E2). Export them explicitly so a run's own log states every bound it ran under. Also
correct `lhtb-ef-sweep-ucs.yaml:71-74`, which claims the agent budget equals the task's 28800 while the
effective value is 259200 (§3). Cost **S**, risk **low**.

---

## 6. Bounds that disagree with each other

| outer bound | inner worst case | verdict |
|---|---|---|
| C2 `STEP_TIMEOUT_MS` = 900s | D1+D2: 4 attempts × 300s + 3 × 30s = **1290s** on `deepseek-v4.1-flash*` (570s on the 120s default) | the outer deadline can abort a call that is still legitimately inside the adapter's own retry budget |
| C3/C4/C6 `FOLD_TIMEOUT_MS` = 600s | same 1290s: a summarization goes through the same adapter | same disagreement, on the fold path |
| B3 `_READ_TIMEOUT_SEC` = 1200s | C2 900s | **consistent by design** — the comment at `ef_bridge_client.py:78-80` says the client must outlast the host's own step deadline, and it does |
| A1 `timeout_sec=900` | H1 the same 900s | the same number twice, one of them a literal, and §2 shows it does not hold |
| watchdog orphan threshold 1200s | A1 900s | consistent today, but only by two independent literals (F3) |

---

## 7. What is not established, and what I did not do

- **The mechanism of the exec hang is not established** (docs/115 §E already says so). §2 states the two
  in-repo accounts and refuses to pick one. I did not run a reproduction.
- **I did not execute anything.** No episode, no model call, no test, no build. The fix proposals in §5
  are read from the code and are untested.
- **I did not edit any repo source.** The only file written is this document. `eval/lhtb/lhtb-ef-probe.yaml`
  and `scripts/rescore-lhtb-vectordb.py` are modified in the working tree by someone else and were not
  touched.
- **One conflict to flag for the lead:** docs/115 §C states Harbor "talks to the Docker daemon through the
  Python SDK, not the CLI, so a tool execution leaves no `docker.exe` behind". That is not what the code
  read here shows for `environment: type: docker` (`lhtb-ef-sweep-ucs.yaml:53-54`): Harbor's
  `DockerEnvironment.exec` builds `docker compose … exec main …` and spawns it with
  `asyncio.create_subprocess_exec` (`docker.py:308-332`, `:556-585`), and `watchdog.ts:213-217` queries
  for exactly those `docker-compose.exe`/`docker.exe` clients by `--project-name … exec`. §C's
  correction may itself need correcting; it matters because the watchdog's reap targets the CLI tree.
