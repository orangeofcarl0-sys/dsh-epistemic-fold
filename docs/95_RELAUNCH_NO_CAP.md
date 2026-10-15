# 95 — Cap cancelled, relaunched, and the rate is 13x the previous run's

Status: RUNNING with the task's own ceiling as the only time bound. 2026-10-15. Parent `585d1fe`.

## A. Why a restart was the only way to honour "cancel the cap"

The 90-minute bound is `EF_LHTB_BUDGET_WALL_MS`, and the budget object is built once at `init`.
**It cannot be changed inside a running bridge process.** And the running episode was already
proven unable to fold in its remaining window (~137 minutes needed against 64 available), so
letting it continue would have produced a wall-clock-censored result after another hour of spend.

Stopped cleanly (`harbor` 0, containers 0, `bridge-host` 0 -- verified by a signature the detector
cannot self-match) and relaunched.

## B. The new bound

`EF_LHTB_BUDGET_REQUIRED=1` refuses a limit that is 0, so the cap was not disabled by setting 0.
It is set to **28,800,000 ms -- the task's OWN `override_timeout_sec: 28800`**. That is the natural
boundary rather than an arbitrary one of mine, and it keeps the required-budget guarantee armed:

```
REQUIRED=1  requests 140  prompt 7,000,000  output 400,000  wall 28,800,000
```

The request and token limits still bind, and the fold needs far less than any of them.

## C. The rate is nothing like the previous run's

```
jobdir   lhtb-ef-20261015-183321-probe-economy
calls 9   folds 0   promptTokensLast 24,835   providerFailures 0   term in-progress
elapsed  150,527 ms = 2.5 minutes            ~17 s per call
budget   requests 9 == modelCalls, observed == charged, reserved 0 / 0, refusals 0
taskRoot resident, sourceSeq 2, digestVerified, position 0
```

**~17 seconds per call against the previous run's ~3.7 minutes.** At this rate the threshold is
roughly 18 calls away -- about five minutes -- where the earlier arithmetic projected 137.

That arithmetic was not wrong about the numbers it measured; it was wrong to treat them as the
workload's steady state. The previous episode was the first against that container image
(`force_build: true`), and its early phase was slow for reasons that have nothing to do with folding.
**This is the correction: the per-call rate is not a property of the task, and a censoring estimate
built on one early sample is not an estimate.**

## D. What is still open

No fold yet. Post-fold continuation, Recall and the official reward remain unknown. The run is left
to reach its own conclusion under the task's own ceiling.
