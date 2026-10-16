# 119 — Agent-team investigation: root cause proven, two fixes landed

Status: root cause PROVEN; two fixes implemented. 2026-10-16. Parent `c9dc2e5`.

## A. The root cause, proven on the live stalled cell

Three teammates worked disjoint scopes; `engine-fold` proved the mechanism on the process tree that
was still stuck 3h10m in, and I verified it independently:

```
python.exe 64520  harbor agent
docker.exe 27144  <- GONE (already exited)
docker-compose.exe 39196  parent 27144  since 14:51:51  <- STILL ALIVE
container: root 791  grep -R cfgd_secret /              <- still running, 3h+
```

**Harbor shells out to `docker compose exec`** (`docker.py:556-585` ->
`asyncio.create_subprocess_exec`, `:326-332`). **On Windows `docker.exe` starts the
`docker-compose.exe` PLUGIN as a separate process and EXITS**, and the plugin inherits the stdout
pipe's write end. `communicate()` needs EOF, which needs every write handle closed, so
`stream.read()` never returns. `terminate()`/`kill()` (`:342`/`:348`) signal only the direct child's
PID -- already reaped -- so they are no-ops and the real pipe holder is never signalled.

## B. And a correction to my own docs/115

**The 900s bound DOES fire.** `docs/115` §D said it did not. The coroutine is PAST both timers,
stuck at `docker.py:349` -- a bare `await process.communicate()` inside `except asyncio.TimeoutError`.
Evidence: 39 archived results read `<exec error: RuntimeError: Command timed out after 900 seconds>`,
and the two recent ones carry the wall clock -- `toolMs=1318479` (1318s, **+418s past the bound**) and
`toolMs=941696` (942s). **The "1318s command" I cited in docs/115 and docs/117 is the HANDLER'S
OVERRUN, not a command that ran unbounded.**

## C. Fixes landed

**1. `_exec` now carries its own bound** (`ef_lhtb_agent.py`) -- `asyncio.wait`, **not** `wait_for`,
because `wait_for` cancels the inner await and then waits for the cancellation to complete, which is
the same hang one level up. On timeout the task is cancelled and **not awaited**. One
`EF_LHTB_TOOL_TIMEOUT_SEC` replaces the literal 900.

**2. `neverReachedProvider` now walks `AggregateError.errors`** (`openai-adapter.ts`). Measured by
`config-plugin`: undici reports one inner error per address and sets the aggregate's `code` to the
FIRST inner code, so the old version released a reservation when the first address was refused but a
later one was reset, and stranded one when the first merely timed out. **An aggregate is now judged by
ALL its members** -- one address that got a connection means the request may have been processed, so
the reservation must stand. `ETIMEDOUT` was also absent from the pre-send set.

Tests: `tests/live-budget-admission.spec.ts` **21/21** (was 19). Full suite **1201 passed / 2 failed**,
both pre-existing (`rc7-inplace-drift`, and the docs-manifest regeneration race).

## D. A documented mechanism that is FALSE

`scripts/run-lhtb.sh:366-371` claims opencode.ai has **nine A records, four refusing TCP 443**, and that
Node's fetch does not fall back as curl does. Measured by `config-plugin`:

* today it is **4 A records** (172.65.90.20-23, Cloudflare), **all four accept 443**;
* `undici` 7.28.0 never sets `autoSelectFamily`, so Node's default (true) applies and **it DOES walk
  the whole address set** -- proven five ways, including an injected `[dead, live]` lookup returning 200.

**So the ten `fetch failed` cannot be explained that way.** The proxy is in the bridge's path by
default, which delegates the address set to the proxy anyway. The comment is stale and should be
deleted rather than trusted -- **and the preflight should print the resolved address set and the proxy
decision instead of asserting a mechanism.**

## E. Also found, not yet fixed

* the episode loop has **no wall-clock deadline at all** -- `MAX_TURNS` and the outage window are
  counts, and the window resets on any success;
* `eval/lhtb/watchdog.ts` exists and does the right thing (`taskkill /F /T`), but is started only by
  four ad-hoc launchers, **not by `scripts/run-lhtb.sh`**;
* the wave's episode budget is **86400 x 3.0 = 72h**, while `lhtb-ef-sweep-ucs.yaml:71-74` claims it
  equals the task's 28800 -- **it is 9x that**;
* `lastProviderError` is still literally `fetch failed`; `docs/108` claimed the detail was preserved.
