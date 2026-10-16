# 115 — Located: the agent is suspended in `environment.exec`, and the 900s timeout never fired

Status: **localized to a specific await.** 2026-10-16. Parent `bf157e6`.

## A. The code says there is only one candidate

`ef_lhtb_agent.py` has exactly two awaits in the episode path:

```
340  async def run(...)              -> 360  await self._run_episode(...)
365  async def _run_episode(...)     -> 695  output = await self._exec(environment, command)
326  async def _exec(...)            -> 329  result = await environment.exec(command=command, timeout_sec=900)
```

Everything else in `_run_episode` is synchronous, including `self._bridge.step(...)`, whose wait is the
bounded `queue.get(timeout=...)` at `ef_bridge_client.py:181`.

## B. The stack says the task is SUSPENDED, not blocked

```
Thread 17520 (idle): MainThread
    _poll (asyncio\windows_events.py:775)
    _run_once ... run_forever ... run_until_complete
    run_async (utils.py:18)   start (jobs.py:1341)
Thread 34644 (idle): ef-bridge-stdout    pump (ef_bridge_client.py:168)
Thread 61968 (idle): Thread-5            rich\live.py:35
Thread 48152 (idle): asyncio_0           concurrent\futures\thread.py:90
```

**The event loop is idle inside `_poll`.** That means no coroutine is runnable -- the agent's task is
suspended at an await, and **no thread is executing it**. If it were inside a synchronous call such as
`bridge.step()`, the loop would be blocked IN that call, not polling.

**The only await it can be suspended at is `environment.exec`.**

## C. The correction that made this fit

`docs/114` ruled out a container command because there is no `docker.exe` on the host. **That inference
was wrong**: harbor talks to the Docker daemon through the Python SDK, not the CLI, so a tool execution
leaves no `docker.exe` behind. The measurement that corrects it:

```
agent process TCP connections:
  Bound        0.0.0.0:0
  Established  127.0.0.1:49432
  Established  127.0.0.1:49433
```

**Two live loopback connections on the agent process**, consistent with an in-flight environment call,
and invisible to a `docker.exe` search.

## D. The second finding: the timeout is not bounding it

`_exec` passes `timeout_sec=900`. The stall has run **well past 55 minutes**, so the 900-second bound
**did not fire**. That is independent of the localization and it corroborates an earlier observation:
in the deepseek run a single shell command ran **1,318 seconds** -- also past 900.

**Two separate runs, the same conclusion: `timeout_sec=900` is not enforced on this path.**

## E. What is established

```
agent suspended at an await, nothing running      PROVEN (idle event loop, no working thread)
that await is environment.exec                    PROVEN (the only await on the path)
it is a container call, not a bridge wait         PROVEN (loop would be blocked, not polling)
timeout_sec=900 does not bound it                 PROVEN (55+ min; and 1318s in the deepseek run)
WHY the await never resolves                      NOT ESTABLISHED
```

## F. Why this is the right place to stop guessing

Every previous guess in this thread pointed at the bridge, the route, the model or the budget.
**All four are now excluded by direct measurement, and the remaining question is one await inside
harbor's environment layer** -- a component this project does not own.
