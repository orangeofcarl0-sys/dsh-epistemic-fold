# 90 — P1 LAUNCHED: the live episode, with the budget gate reconciling

Status: **RUNNING**, no natural fold yet at the snapshot. 2026-10-15. Parent `cef6791`.

## A. The launch checks, and the defect one of them found

**Task Root guard position.** `docs/88` put the fail-closed guard before `drainIdleRebase()` -- but
`foldIfNeeded()` runs EARLIER. Measured order: `modelTurn` (1292) -> `foldIfNeeded` (1295) -> guard
(1316) -> `drainIdleRebase` (1326). The guard refused the REQUEST while still allowing the FOLD it
exists to prevent. It is now the first thing `modelTurn` does (1313), ahead of `foldIfNeeded` (1323),
so the test asserting `folds === 0` verifies the ordering rather than merely passing.

**External watchdog.** `tests/fixtures/watchdog-hang.py` publishes the bridge pid it owns and blocks
SYNCHRONOUSLY on the bridge's stdout -- the shape `docs/86` recorded that `asyncio.wait_for` cannot
interrupt. Supervised by that recorded identity, never by process name. Measured: the trial does not
finish on its own, **`child.kill()` does NOT stop it** (still alive three seconds later), and
`taskkill /F /T /PID <trial pid>` stops the trial AND reaps the bridge it owned.

## B. The episode

```
job            lhtb-ef-20261015-023235-probe-economy
task           unknown-config-semantics        model  deepseek-v4.1-flash
arm            economy        taskRootMode exact        window 131072  threshold 65536
budget         REQUIRED=1  requests 140  prompt 7,000,000  output 100,000  wall 5,400,000
```

Snapshot while running:

```
modelCalls        7        folds 0        roots 0        providerFailures 0
promptTokensLast  18,070   (28% of the 65,536 threshold)
shell executions  12       transcript turns 12
taskRoot          {mode: exact, status: resident, sourceSeq: 2, digestVerified: true, position: 0}
budget            requests 7   observed 83,058 / 10,652   reserved 0   unknown 0   partial 0
                  refusals 0   limit {140, 7,000,000, 100,000, 5,400,000}
```

**The gate is live and reconciling**: `budget.requests` equals `modelCalls` exactly, `observed`
equals the charged totals (no reservation outstanding), and `unknownUsageRequests` and
`partialUsageRequests` are both 0 -- so this run's usage is fully reported rather than estimated.
`refusals` is 0. The task root is registered, resident, digest-verified, at position 0.

## C. No natural fold yet

18,070 of 65,536 tokens. The historical Economy runs on this task folded at ~65,600-66,000 tokens
after at most 114 calls; at this rate the threshold is roughly 18 further calls away. **The episode
is still running**, so this is a snapshot and not a verdict: reporting `NO NATURAL FOLD` now would
describe the operator's clock rather than the workload.

## D. Not established

Post-fold continuation, the official reward, and whether Recall was exercised are all unknown at
this point, because no fold has occurred.
