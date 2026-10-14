# 89 — Launch checks, and the P1 episode

Status: P1 LAUNCHED. 2026-10-15. Parent `d925df6`.

## A. The Task Root guard was in the WRONG place

`docs/88` put the fail-closed guard before `drainIdleRebase()` -- but `foldIfNeeded()` runs EARLIER
in `modelTurn`. Measured order before the fix:

```
1292  modelTurn()
1295  await foldIfNeeded()          <- a fold could commit against the unverified state
1316  task-root-contract guard
1326  await drainIdleRebase()
```

So the guard refused the REQUEST while still allowing the FOLD it was supposed to prevent. It is now
the first thing `modelTurn` does (`:1313`), ahead of `foldIfNeeded` (`:1323`), and the existing test
that asserts `folds === 0` now genuinely verifies the ordering rather than merely passing.

## B. The external watchdog, and what it took to stop a blocked trial

`tests/fixtures/watchdog-hang.py` publishes the bridge pid it owns and then blocks SYNCHRONOUSLY on
the bridge's stdout -- the shape `docs/86` recorded that `asyncio.wait_for` cannot interrupt.
`tests/external-watchdog.spec.ts` supervises it by that recorded identity, never by process name.

Measured:

* the trial does NOT finish on its own (still alive at the deadline);
* **`child.kill()` does NOT stop it** -- three seconds later the trial was still running. That is a
  real platform finding, and it is why the supervisor stops the TREE;
* `taskkill /F /T /PID <trial pid>` stops the trial AND reaps the bridge it owned;
* liveness is checked against the ONE pid the fixture published.

For the P1 run the supervisor is `scripts/run-lhtb.sh`'s own process tree, rooted at the pid the
background job owns, with `EF_LHTB_BUDGET_WALL_MS=5400000` as the in-band deadline and the tree stop
as the out-of-band one.
