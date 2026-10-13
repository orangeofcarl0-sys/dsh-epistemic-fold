# 78 — The bridge child process: guaranteed close, and the measurements behind it

Status: normal and abnormal cleanup verified; forced termination measured. 2026-10-14. Parent `a404aca`.

## 0. What this round is

The brief for this round restated work already delivered in `a404aca` (Python recall dispatch) and
in `docs/77` (the orphan-bridge retraction). The part left undone there, because the budget ran out,
was §5/§6 of that brief: a REPRODUCIBLE cleanup gap, a minimal fix, and keyless fault injection.
This round does that part.

## 1. The defect

`EpistemicFoldBridge` is a CHILD PROCESS, so failing to close it leaks a live node process holding
a session -- not memory. `close()` itself was already correct: idempotent (`_closed` guard), bounded
(`op:"close"` -> `terminate()` -> `wait(10)` -> `kill()`), and it swallows its own failures so a
shutdown problem cannot mask the episode's result.

The gap was where it was CALLED. `run()` called `close()` on its normal path
(`ef_lhtb_agent.py:675`), so any exception raised inside the episode -- a `BridgeError` from a dead
host, a cancelled coroutine, a provider that never answers -- skipped it and left the bridge to exit
on its own, if it did. `stop()` exists as a Harbor hook, but a hook is not a guarantee.

## 2. The fix, and why it is this small

`run()` is now a wrapper:

```python
async def run(self, instruction, environment, context) -> None:
    try:
        await self._run_episode(instruction, environment, context)
    finally:
        if self._bridge is not None:
            self._bridge.close()
```

and the former body is `_run_episode`. A wrapper rather than a `try/finally` inside the body
because the body is 330 lines: re-indenting it would have buried a one-line guarantee in a
three-hundred-line diff. `close()` is idempotent, so the existing normal-path call is left alone and
the double close is harmless.

The `finally` covers everything Python can observe: normal return, a raised exception, and a
`CancelledError` delivered to this coroutine.

## 3. Keyless fault injection

`tests/fixtures/python-bridge-lifecycle.py` drives four endings with short-lived children and
reports whether the ONE `Popen` handle it created was reaped. It **never searches for `node.exe`**,
so a pass cannot be manufactured by killing an unrelated process and a leftover is attributed to the
fixture that made it. Measured:

```
normalClose             pid 18884   reaped true    second close idempotent true
closeIgnored            pid 70124   reaped true    elapsed 0.00s  (< 15s bound)
episodeRaises           pid 58800   reaped true    exception still propagated
forcedParentTermination pid 28536   survivedParentTermination false
```

* **normalClose** -- `op:"close"` is sent, the child is reaped, and a second `close()` is a no-op.
* **closeIgnored** -- the handshake is made unreachable (`_send` replaced, so the request never
  leaves) and the `terminate`/`kill` fallback **still** reaps the child, in 0.00s. The bound is real
  and it is not the 10s timeout that saves it.
* **episodeRaises** -- an exception injected inside the episode **propagates** AND the bridge is
  reaped. Both halves are asserted: a fix that reaped the child by swallowing the error would be
  worse than the leak. **This is the regression the fix closes**: before it, `close()` was never
  reached on this path and `reaped` was false.
* **forcedParentTermination** -- the parent Python is killed outright. Recorded, deliberately NOT
  asserted as a guarantee.

## 4. The OS boundary, now measured rather than asserted

`docs/77` said `FORCED-PARENT-TERMINATION CLEANUP NOT GUARANTEED`. That remains the correct
statement about what the CODE promises, and it is now also measured: killing the Python parent
**did not** orphan the bridge -- the child's stdin reaches EOF and the bridge exits. That is the
pipe's behaviour, not a promise `ef_lhtb_agent.py` can make, and on Windows it is additionally
deferred to whether the child shares a Job Object with kill-on-close, which nothing here
establishes.

So the operator boundary is:

* everything Python observes -- normal, exception, cancellation -- is guaranteed by `run()`;
* a hard kill is covered by pipe EOF in practice and by NOTHING in the code;
* the fixture cleans up any leftover it is responsible for by re-checking the single pid it
  recorded, never by a broad sweep.

A Job-Object-based guarantee would be a cross-platform process-management change for one edge case
that has never been observed to occur. Deliberately not built.

## 5. Scope

Changed: `eval/lhtb/ef_lhtb_agent.py` (the wrapper; `_run_episode` is the old body verbatim), plus
`tests/fixtures/python-bridge-lifecycle.py` and `tests/python-bridge-lifecycle.spec.ts`.

**Not** changed: the fold, root, emergency, frontier, bundle or recall implementations; the Basic
baseline; the presets; the dirty benchmark configs. No provider request was made -- the fixture
constructs a bridge, which starts the child, and never issues a model call.
