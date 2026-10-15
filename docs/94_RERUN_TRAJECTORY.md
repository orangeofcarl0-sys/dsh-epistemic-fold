# 94 — The rerun is heading for WALL-CLOCK censoring, arithmetically

Status: RERUN RUNNING, no fold. 2026-10-15. Parent `54818a5`.

## A. Current state

```
job        lhtb-ef-20261015-180256-probe-economy
calls 15   folds 0   promptTokensLast 23,556   providerFailures 0   term in-progress
elapsed    1,567,389 ms = 26.1 min of the 90-minute cap      container up 26 min
taskRoot   resident, sourceSeq 2, digestVerified, position 0
budget     requests 15 == modelCalls
           charged prompt 271,944 / output 42,710
           observed == charged, reserved 0 / 0, unknown 0, partial 0, refusals 0
```

**The budget fix holds**: `requests` tracks `modelCalls` exactly, `observed` equals the charged
totals, `reserved` is 0/0 and `refusals` is 0. Nothing is estimated, and nothing is stuck -- where
the failed run carried a standing 131,072 reserve and a refusal by this point.

## B. It cannot reach the threshold inside the remaining window

Measured over the last interval: 12 -> 15 calls in ~11 minutes (3.7 min/call) and 20,115 -> 23,556
tokens (~1,147 tokens/call).

```
tokens still needed      65,536 - 23,556 = 41,980
calls still needed       41,980 / 1,147  ~= 37 calls
time still needed        37 x 3.7 min    ~= 137 minutes
time still ALLOWED       90 - 26.1       =  64 minutes
```

**The 90-minute cap will end this run before a natural fold**, and the shortfall is not marginal: it
needs roughly twice the remaining window. No threshold change, no extra calls and no filler are
allowed, so the outcome is already determined.

## C. Why it is slower than the historical runs

The archived Economy runs on this task folded at ~65,600-66,000 tokens after **at most 114 calls**.
This one is at 15 calls in 26 minutes -- about 3.7 minutes per call against roughly half a minute in
those runs. The per-call token growth is comparable; the WALL CLOCK per call is not. That is the
variable that decides whether a natural fold fits, and it was not part of the earlier estimate,
which counted calls rather than minutes.

## D. The decision I am NOT making unilaterally

Stopping now would save ~64 minutes of provider spend and change nothing about the information: a
run that cannot fold in the window is censored either way. But stopping early reclassifies it from
**wall-clock censored** to **operator-censored**, and that is the operator's call, not mine. The
pre-registered cap is left to do its job unless told otherwise.

## E. Classification, whichever way it ends

```
BUDGET-CENSORED              NO -- the gate is healthy and has refused nothing
NATURAL FOLD                 will be NOT EXERCISED
POST-FOLD CONTINUATION       NOT ESTABLISHED
TASK COMPLETED               NO (no verifier result yet)
```
