# 120 — The watchdog bug: a misconfiguration that spun forever

Status: fixed and verified. 2026-10-16. Parent `ae04bc8`.

## A. What was wrong

`eval/lhtb/watchdog.ts` already had the right SHAPE -- it self-terminates when no cell is running
(`IDLE_ROUNDS_BEFORE_EXIT = 3`), and `reapStuckClients` is scoped by `--project-name`, so it cannot
kill another project's processes. **My earlier claim that a stale watchdog was a `taskkill` hazard was
overstated and is withdrawn.**

The defect was narrower and worse:

```ts
const JOBS_ROOT = process.env.EF_WATCH_JOBS ?? ''
...
if (JOBS_ROOT === '') throw new Error('watchdog: EF_WATCH_JOBS is not set')   // inside round()
```

`round()` throwing is counted by `main` as `live = 1` -- deliberately, so a transient docker failure
never looks like "all cells finished". **Both rules are right in isolation and lethal together:** a
watchdog started WITHOUT `EF_WATCH_JOBS` throws every round, never accumulates the idle rounds that
would let it exit, and **spins every 60 seconds forever**.

**And the runner I had just wired was one of the things starting them without it.** Measured: eleven
such processes alive at once.

## B. The fixes

**1. A configuration error is now FATAL AT STARTUP** (`watchdog.ts`): the empty-`JOBS_ROOT` check
moved to the top of `main()`, records `watchdog-misconfigured` and exits with code 2. **A
misconfiguration is not a transient fault**, so it must not be routed through the transient-fault path.

**2. The runner supplies the env** (`scripts/run-lhtb.sh`): `EF_WATCH_JOBS`, `EF_WATCH_LOG` and
`EF_WATCH_HEARTBEAT`, exactly as the ad-hoc launchers did -- which is why THEY never leaked.

**3. The runner stops what it started**: `trap cleanup_watchdog EXIT INT TERM` kills the pid it
recorded. Previously nothing did.

## C. Verified

```
watchdog started with NO EF_WATCH_JOBS   ->  exits code 2 in 0.2s   (was: spun forever)
eleven stale watchdog processes          ->  0 after cleanup
bash -n scripts/run-lhtb.sh              ->  clean
```

## D. Not fixed

An ad-hoc launcher that exports the right env still relies on the idle-exit path, which is correct.
The `trap` covers the runner's own watchdog only -- a watchdog started by a launcher that is itself
killed with `/F` will still be orphaned, and the startup guard does not help there because its
configuration is valid. That is a smaller version of the same class and is left open rather than
half-fixed.
