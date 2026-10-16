# 116 — Harbor's environment layer: why `environment.exec` never returns, and what the 900s bound really does

Status: **root cause established, and proven on the live stalled episode.** 2026-10-16. Parent `docs/115`,
revision `c9dc2e5`. This document **supersedes `docs/115` §C, §D and §E** and **resolves the fork left open in
`docs/117` §2** in favour of its option 1 (H2).

Method: read harbor's environment layer; enumerate the live host process tree of the stalled cell with
`Get-CimInstance Win32_Process`; one read-only `docker ps` / `docker top`; and read the CPython 3.13.13
stdlib that harbor runs on. **No episode was started, no model call was made, no file outside this one was
written.**

---

## A. Where `BaseEnvironment.exec` is implemented for a Docker task

```
base.py:471-491        @abstractmethod async def exec(...)      -- declared, no body
factory.py:30-34       EnvironmentType.DOCKER -> "harbor.environments.docker.docker:DockerEnvironment"
lhtb-ef-probe.yaml:57  environment: type: docker                 -- this is the selection
docker/docker.py:556   async def exec(self, command, cwd, env, timeout_sec, user) -> ExecResult
docker/docker.py:583   return await self._run_docker_compose_command(exec_command, check=False, timeout_sec=timeout_sec)
docker/docker.py:308   async def _run_docker_compose_command(self, command, check=True, timeout_sec=None)
```

`DockerEnvironment.exec` builds `["exec", "-w", cwd, "-u", user, "main", "bash", "-c", command]`
(`docker.py:567-581`; the shell wrapper is `docker_unix.py:60-63`) and `_run_docker_compose_command`
prefixes it into a **CLI invocation** — `docker compose --project-name <session> -f … exec …` — run with
`asyncio.create_subprocess_exec` (`docker.py:312-332`, `stdin=DEVNULL, stdout=PIPE, stderr=STDOUT`).

> Correction to `docs/115` §C: harbor does **not** talk to the daemon through the Python SDK. It shells out
> to `docker compose` (`docker.py:326-332`). The live process tree in §C below is the proof.

The harbor that ran is this source tree: `.venv/pyvenv.cfg` (CPython 3.13.13, Windows),
`harbor-0.7.0.dist-info/direct_url.json` = `{"editable": true}`, and `harbor.pth`.

## B. How `timeout_sec` is plumbed, and where it is enforced

```
eval/lhtb/ef_lhtb_agent.py:329   result = await environment.exec(command=command, timeout_sec=900)
harbor/.../docker/docker.py:584  -> _run_docker_compose_command(exec_command, check=False, timeout_sec=timeout_sec)
harbor/.../docker/docker.py:335  if timeout_sec:
harbor/.../docker/docker.py:336      stdout_bytes, stderr_bytes = await asyncio.wait_for(
harbor/.../docker/docker.py:337          process.communicate(), timeout=timeout_sec
```

**One enforcement site**, and it is a client-side asyncio timer on the `docker compose` **client**
subprocess. There is no container-side bound anywhere on this path — contrast harbor's own
`singularity/server.py:132` (`timeout --signal=TERM {req.timeout_sec} bash -c …`),
`daytona.py:1117-1118`, and `islo.py:806` (which passes `-T`). And there is no process group or job
object: `_WindowsSubprocessTransport` (`windows_events.py:876-888`) has no `terminate`/`kill` override, so
they reach exactly one PID — the direct child.

## C. Why the await never resolves

On Windows `docker` is a **dispatcher**: it starts the compose **plugin** `docker-compose.exe` as a
separate process and exits. The plugin inherits the stdout pipe's write end.

Live sample of the stalled cell, taken at 18:01 — **3h10m after the last transcript write, and the cell is
still in this state right now**:

```
python.exe            64520   harbor agent (trial)      since 14:51:17   live children: node 74316 only
docker.exe            27144   <-- GONE. Not in Win32_Process any more.
docker-compose.exe    39196   ParentProcessId 27144     since 14:51:51   <-- STILL ALIVE
container aaf7cbc91765        unknown-config-semantics__vuddhpq-main-1  "Up 3 hours"
  PID 781   ELAPSED 03:24:39  bash -c ls -la /opt/cfg/cfgd_secret.json …; grep -R "cfgd_secret" / …| head
  PID 791   ELAPSED 03:24:12  grep -R cfgd_secret /
  PID 792   ELAPSED 03:24:12  head
```

The chain, all of it observable:

1. The model's tool call is a whole-filesystem scan — `grep -R "cfgd_secret" /` — still running in the
   container (PID 791).
2. `docker-compose.exe` streams that command's stdout into the pipe created at `docker.py:330`.
3. The direct child `docker.exe` (the PID asyncio knows, `windows_events.py:887`) has **exited**; the pipe's
   write end is held by the **grandchild**.
4. `process.communicate()` is `tasks.gather(_read_stream(1), …)` then `await self.wait()`
   (CPython `asyncio/subprocess.py:188-203`); `_read_stream` is `await stream.read()` (`:171-186`). EOF is
   delivered only by `pipe_connection_lost(fd, None)` → `feed_eof()` (`:74-102`), which needs **every** write
   handle closed. The grandchild keeps one open, so `stream.read()` never returns.
5. `process.terminate()` (`docker.py:342`) and `process.kill()` (`docker.py:348`) signal the direct child's
   PID — already reaped — so both are **no-ops**, and the process that actually holds the pipe is never
   signalled. That is why `docker-compose.exe` 39196 is still alive.

Our own repo reached the same conclusion independently: `eval/lhtb/watchdog.ts:230-234` uses
`taskkill /F /T /PID` with the comment *"`/T` so the whole client tree goes: the CLI and the compose plugin
hold the same pipe, so killing only one of them leaves the agent waiting."*

**INFERRED (not run here):** on Linux the docker CLI `execve`s the plugin, so the plugin *is* the direct
child and `terminate()` reaches it. Windows `CreateProcess` cannot do that, so the plugin becomes a
distinct orphan. That asymmetry is why harbor's own CI does not hit this.

## D. Why the 900s bound produces no result — it *does* fire, and its handler is unbounded

The loop honours the timer: `_WindowsSelector.select` → `_poll(timeout)` → `ms = math.ceil(timeout * 1e3)`,
`GetQueuedCompletionStatus(self._iocp, ms)` (`windows_events.py:444-446`, `:762-778`). With the 900s
`wait_for` armed, `_run_once` passes a finite timeout, so `_poll` returns at 900s and the timer callback
runs.

The stack in `docs/114` §A / `docs/115` §B is `_poll` at `windows_events.py:775`. That call receives
`ms = INFINITE` **only when `timeout is None`** (`:763-764`), which `base_events._run_once` computes only
when **no callback is scheduled**. A sample parked there for three hours therefore proves that *no timer is
armed* — i.e. the coroutine is **past** both of harbor's timers. The only unbounded await past them is:

```
docker.py:341   except asyncio.TimeoutError:
docker.py:342       process.terminate()                     # no-op: direct child already gone
docker.py:344       stdout_bytes, stderr_bytes = await asyncio.wait_for(
docker.py:345           process.communicate(), timeout=5)
docker.py:348           process.kill()                      # no-op, same PID
docker.py:349       stdout_bytes, stderr_bytes = await process.communicate()   # NO TIMEOUT
docker.py:350   raise RuntimeError(f"Command timed out after {timeout_sec} seconds")
```

Line 349 re-enters the same never-EOF read with nothing left to wake it, and line 350 is never reached.

**Archived measurement that settles it.** The path is routine: **39** tool results in the archive are
`<exec error: RuntimeError: Command timed out after 900 seconds>`. The two recent ones record the wall clock
of `_exec` itself, and it is **larger than the bound**:

```
lhtb-ef-20261015-183321-probe-economy/unknown-config-semantics__XVVugPj/ef-transcript.json:1091-1092
  "output": "<exec error: RuntimeError: Command timed out after 900 seconds>",
  "toolMs": 1318479                     # 1318s  -> +418s of recovery past the 900s bound
same file :709    "toolMs": 941696      #  942s  ->  +42s of recovery past the 900s bound
```

Both returned the *timeout* error, so both **entered harbor's handler**; the overrun is the handler. It is
unbounded and variable: +42s, +418s, and in the stalled cell, forever.

What that costs the episode: `_exec` never returns ⇒ `except Exception` at `ef_lhtb_agent.py:330` never runs
⇒ the per-command transcript write at `:722` never happens (last write **14:51:50**) ⇒ the bridge stays
blocked on stdin ⇒ `termination` stays `in-progress`. Five cells in the archive never finalised:
`vUDDhPQ` (13 shell calls), `WEx2Qwz` (10), `MSSVyE6` (25), `UNNaS3J` (20), `gYjzBys` (7).

**Two corrections follow from this.**

- `docs/115` §D/§E's *"timeout_sec=900 does not bound it — PROVEN"* is an inference from the observable. The
  bound **is** applied to the await and it **does** fire; what is unbounded is the recovery branch that
  runs after it.
- The *"1318s command in the deepseek run"* (`docs/115` §D, `docs/117` §2) is the **same record** as the
  `toolMs: 1318479` above. It is the wall clock of `_exec` **including the recovery overrun**, not a command
  that ran 1318s unbounded. As the second pillar of "the bound never fires" it points the other way: it is
  direct evidence that the bound fired at 900s and the handler then took another 418s.

## E. Proven / inferred

```
exec is DockerEnvironment.exec, via a docker compose CLI subprocess     PROVEN  docker.py:556-585, 326-332; live tree §C
timeout_sec reaches asyncio.wait_for(communicate(), 900)                PROVEN  ef_lhtb_agent.py:329 -> docker.py:335-338
the 900s bound fires                                                    PROVEN  _poll uses a finite ms (windows_events.py:762-778);
                                                                                two archived results are 942s and 1318s AND carry the
                                                                                timeout error text -> the handler ran
the handler is unbounded and is what stalls                             PROVEN  docker.py:349 has no timeout; the live cell's
                                                                                loop has no timer armed and nothing was signalled
the pipe's write end is held by a grandchild whose parent is dead       PROVEN  Win32_Process: 39196 parent 27144; 27144 gone
the container command is still running (grep -R /)                      PROVEN  docker top, ELAPSED 03:24
terminate()/kill() are no-ops here                                      PROVEN by construction: one PID, already reaped
Linux would not orphan the plugin this way                              INFERRED  execve vs CreateProcess; not run here
```

## F. The fix

**In our lane (primary, S, no harbor edit, no vendored file):** `_exec` must own a bound on the **await**,
because harbor's `timeout_sec` demonstrably does not bound the *return*.

```python
# eval/lhtb/ef_lhtb_agent.py, _exec
TOOL_TIMEOUT_SEC = 900
TOOL_TIMEOUT_GRACE_SEC = 60
try:
    result = await asyncio.wait_for(
        environment.exec(command=command, timeout_sec=TOOL_TIMEOUT_SEC),
        timeout=TOOL_TIMEOUT_SEC + TOOL_TIMEOUT_GRACE_SEC,
    )
except asyncio.TimeoutError:
    return (f"<exec timeout: no result after "
            f"{TOOL_TIMEOUT_SEC + TOOL_TIMEOUT_GRACE_SEC}s; the command may still be running "
            f"in the container>")
```

`docs/117` §2 worried that *"a bound of ours that relies on cancelling it is not trustworthy"* because
`wait_for` waits for the cancellation to complete. **For this particular await that concern does not
apply**, and that is checkable rather than assumed: `StreamReader._wait_for_data` clears `self._waiter` in a
`finally` (`streams.py:537-541`), so CancelledError propagates out of `stream.read()`; and
`_ProactorBasePipeTransport.close()` / `_force_close()` cancel the pending overlapped read
(`proactor_events.py:103-112`, `:147-149`). CancelledError is a `BaseException`, so `except Exception` at
`ef_lhtb_agent.py:330` cannot swallow it. The outer `wait_for` therefore converts it to `TimeoutError`.

Residual, stated rather than hidden: our cancellation abandons harbor's client. The orphaned
`docker-compose.exe` and the in-container `grep -R /` keep running, so this fix must be paired with the
existing watchdog (which already reaps the client tree) and the orphan should be recorded in the
transcript.

**Hardening (optional, S):** also stop the *container-side* work, by wrapping the command the way harbor's
own singularity env does — `timeout -k 5 900 bash -c <cmd>` (`singularity/server.py:132`). Needs a check
that `timeout` exists in each image.

**In harbor (correct, upstream — not our file to change):** `docker/docker.py:341-350` should
(i) never end a timeout handler in an unbounded `await process.communicate()` — bound it, and on a second
expiry abandon the pipe and raise; and (ii) kill the **tree**, not one PID (`taskkill /T /F` on Windows;
`start_new_session=True` + `os.killpg` on POSIX). The deeper fix is to stop emulating `exec` with a CLI
subprocess and use the Docker API/SDK exec with its own timeout.

**Do not do:** raise our number to 900+n and wait longer. Nothing in our lane bounds the await today, and
the observed overrun is unbounded, not merely large.
