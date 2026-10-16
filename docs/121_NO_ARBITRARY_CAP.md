# 121 — Withdrawn: the episode wall-clock cap. Monitoring belongs to the watchdog

Status: `EPISODE_WALL_SEC` removed. 2026-10-16. Parent `fef5f3c`.

## A. What I added, and why it was wrong

`docs/119` added `EPISODE_WALL_SEC = 14400` to the episode loop, on the reasoning that "every other
bound here is a COUNT, so a merely slow episode has no deadline".

**That reasoning produced exactly the wrong instrument.** A wall clock is an ARBITRARY number. An
episode that is slow is not an episode that is broken, and capping it would:

* end productive runs at a number that has no relation to the work;
* file the result under a reason (`episode-wall-clock-exceeded`) that says nothing about whether the
  task was progressing -- **a censored cell with no meaning in it.**

## B. The distinction the cap failed to make

**A wedged episode and a slow episode differ in PROGRESS, not in elapsed time.** That is already what
`eval/lhtb/watchdog.ts` measures, and its thresholds are not arbitrary -- each is derived from the
system's own contract (`watchdog-policy.ts:65-71`):

```
toolTimeoutSec   900   the tool's OWN declared timeout
slackSec         300   the grace beyond it
silenceSec       300   "silence beyond one plausible model call, but not yet alarming"
stuckSec        1800   "silence with nothing running at all: a call that will never return"
```

Silence **plus what is still running inside the container** is a statement about the episode; elapsed
time is a statement about the clock. **So the monitoring is the watchdog's job, and the cap is gone.**

## C. What was kept, and why it is a different kind of bound

**`_exec` still stops waiting** once the call has outlived the timeout it declared for itself
(`timeout_sec=900`, plus a grace for the handler's measured +418s overrun). That is not a budget and
not a threshold chosen here: **a component overrunning its own declared contract is a defect by
definition.** The distinction is contract-versus-arbitrary, not short-versus-long.

**The user-approved budgets are untouched**: requests 140, prompt 7,000,000, output 550,000, wall
28,800,000 -- all set by the operator, none by me.

## D. Verified

```
EPISODE_WALL_SEC assignment in the module      ABSENT (only the comment explaining its removal)
episode_started_at / the loop check            ABSENT
agent syntax                                   OK
```
