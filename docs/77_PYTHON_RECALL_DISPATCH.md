# 77 — Python recall dispatch, and the orphan that never existed

Status: Python dispatch verified end-to-end; lifecycle gap attributed. 2026-10-14. Parent `34339f0`.

## 1. The orphan bridge was a SELF-MATCH artifact

`docs/76` recorded "one orphaned `bridge-host` node process (pid 71832) ... NOT successfully reaped"
and treated it as a cleanup gap. **That was wrong, and this round's first job was to check identity
rather than trust the PID.**

* PID 71832 no longer exists -- exactly the reuse trap the round warned about.
* A `bridge-host` filter matched "a process", but the filter's own command line CONTAINS the string
  `bridge-host`, so it matched itself.
* Re-checked with a signature the detector cannot contain: nodes launched with
  `--experimental-transform-types`, and a `cp:`/pattern built at runtime. Result:
  **zero** bridge processes, and the single `experimental-transform-types` match was the detector's
  OWN wrapper (`dsh-subprocess-local/lib/runner.js -- powershell.exe ...`).

So there was no orphan. The `Stop-Process` that "failed to reap it" was killing **my own tool
runner**, which is precisely why those two commands died with `Windows Job runner exited ... before
proving its managed range empty`. A cleanup gap was reported from a self-inflicted kill.

**There is no observed leftover bridge.** The claim in `docs/76` is retracted here.

## 2. Python recall dispatch: EXECUTED, end to end

`tests/fixtures/python-recall-dispatch.py` + `tests/python-recall-dispatch.spec.ts` run the
production agent loop: a fake provider scripts the model's tool calls, the Harbor environment is a
stub, and **everything else is real** -- `EFLhtbAgent`'s dispatch branch, `EpistemicFoldBridge`,
the Node bridge process, the plugin, the SessionStore, the fold transaction and the ToolRuntime.
No API key, no network beyond `127.0.0.1`.

Measured run:

```
providerCalls          11
toolsDispatched        [context_recall, context_search, run_shell]
search  -> outcome "partial", hit {checkpointId d14e661d-..., mode leaf,
                              text "[EF1 L cp:d14e661d-...]", matchedMessageIndex 3}
recall  -> the ARCHIVED bytes, original wording included
task root  {mode: exact, status: resident, sourceSeq: 2, digestVerified: true, surfacePosition: 0}
```

Each required link, and what proves it:

1. Python received the model tool call -- the agent's own `tool_calls` parse;
2. Python called the bridge -- `context_search` and `context_recall` appear in the transcript as
   EF tools, routed by `name`, not as shell commands (`ef_lhtb_agent.py:644-648`);
3. the Node ToolRuntime executed them -- the search result cites a real `checkpointId`, `mode:
   leaf` and a real `matchedMessageIndex`, which only the runtime can produce;
4. real archived bytes came back -- the recovered page contains the NONCE **and** its original
   wording. The nonce lives ONLY inside a folded TOOL RESULT, deliberately not in the task root,
   which is protected and never folded and therefore could not prove anything about the archive;
5. Python appended the result -- and the following provider request carried it, which is the
   evidence the append happened rather than being claimed.

Two calls in ONE reply are also exercised: the search phase emits `context_search` and `run_shell`
together, and `ef_lhtb_agent.py:611-615` appends every result before the next model call.

### 2.1 A miss is reported as a miss

`context_recall` with `cp:00000000-...` is dispatched after a successful recall; its output does not
contain the nonce and does not claim a hit. The tool does not fabricate a result for a reference
that cannot exist.

### 2.2 What this changes about the earlier rounds

`harness-recall-tools.spec.ts` proves the runtime executes `context_search`; `task-root-bridge.spec.ts`
proves the wire dispatch works. **Neither ran the agent loop in between**, which is the code that
decides whether a call is a shell command or an EF tool. It is now executed.

## 3. Lifecycle: what is guaranteed, and what is not

`EpistemicFoldBridge.close()` (`ef_bridge_client.py:366-388`) is **idempotent** (`_closed` guard),
bounded (`op:"close"` -> `terminate()` -> `wait(10)` -> `kill()`), swallows its own failures so
shutdown cannot mask a result, and closes the stderr file. `EFLhtbAgent.stop()` is the Harbor hook
and delegates to it.

**The gap, stated precisely:** `run()` calls `close()` on its NORMAL path
(`ef_lhtb_agent.py:675`); it does not wrap the loop in `try/finally`, so an exception raised inside
the loop relies on Harbor calling `stop()`. If Harbor does not, the bridge is left to exit on its
own -- which it does once its stdin closes, but that is the pipe's behaviour and not a guarantee
this code makes.

**FORCED-PARENT-TERMINATION CLEANUP NOT GUARANTEED.** If the Python process is killed
(`TerminateProcess`, a killed Job Object), no Python code runs: `atexit` does not cover it and
`finally` does not cover it. On Windows the bridge is then reaped only if it is inside the same Job
Object with kill-on-close, which nothing here establishes. Recorded as an OS-level boundary rather
than papered over; a Job-Object-based fix is a cross-platform process-management change and is
deliberately not attempted for one edge case.

Empirically, the one real abnormal exit available (killing `harbor` mid-episode) left **no** bridge
behind -- see section 1.

## 4. Cost

**New real provider requests: 0.** The entire verification runs against a local fake provider.
