# 114 — Agent stack: four threads, none of them running the episode

Status: **localized to the agent's await, precisely.** 2026-10-16. Parent `5b83b8f`.

## A. The sample

`uvx py-spy dump --pid 64520` -- the agent runs inside harbor's process, so this is the whole tree:

```
Thread 17520 (idle): MainThread
    _poll (asyncio\windows_events.py:775)
    select (asyncio\windows_events.py:446)
    _run_once (asyncio\base_events.py:2023)
    run_forever ... run_until_complete ... run_async ... start (jobs.py:1341)
Thread 61968 (idle): Thread-5        rich\live.py:35
Thread 48152 (idle): asyncio_0       concurrent\futures\thread.py:90
Thread 34644 (idle): ef-bridge-stdout
    pump (ef_bridge_client.py:168)
```

## B. What each thread says

**`ef-bridge-stdout` is at `for line in self._proc.stdout:`** -- blocked reading the bridge's stdout.
That is NORMAL and by design: `ef_bridge_client.py:150-161` explains that the thread exists precisely
so the pipe read is observable, and the agent's own wait is `queue.get(timeout=...)` at line 181.
**A pump thread sitting on the pipe is the mechanism working, not the fault.**

**`MainThread` is idle inside `_poll` in harbor's asyncio event loop.** That is the load-bearing
observation: **the event loop has no runnable task.** The agent's coroutine is awaiting a Future that
nothing will resolve.

## C. What this rules out, and why it is not the earlier guess

```
the bridge                    ruled out -- only stdin/stdout handles, no network, no timer, no
                              in-flight request (docs/113, live CDP sample)
a container command           ruled out -- no docker.exe on the host, no child processes
a blocking pipe read          ruled out as the fault -- the design makes that read bounded, and
                              the pump thread is where it should be
the provider                  ruled out -- no socket is open at either end
```

**The agent is not waiting on the bridge in the way that would produce a timeout.** If it were inside
`_readline`, the bounded `queue.get` would raise `queue.Empty` and the hang would already have become a
recorded provider failure. It is somewhere else.

## D. What is established

```
block is on the agent side of the pipe            PROVEN (docs/113)
not a tool execution, not the bridge, not the net PROVEN
agent's coroutine awaits a Future nothing resolves PROVEN by the idle event loop
WHICH await, and why it is never resolved         NOT ESTABLISHED
```

**The last line is the whole remaining question**, and it is now a question about one coroutine rather
than about a route, a model, a budget or a pipe -- which is where every previous guess in this thread
was pointed.

## E. Method

`uvx py-spy dump --pid <pid>` -- no install into the restricted venv was needed (`pip install` into the
harbor venv silently failed; `uvx` runs the tool from its own environment). Combined with
`process._debugProcess` for the Node side (`docs/113`), **both ends of the pipe were sampled on the
live, stalled episode without restarting it.**
