# 102 — Free tier SOLVED at the protocol level; the LANE integration hangs

Status: protocol verified 200; lane NOT yet confirmed. 2026-10-16. Parent `d0295c8`.

## A. The second gate, found by differential

The session's time encoding was the first gate. With it fixed, a differential found the second:

```
stream=false -> 403 FreeTierError   (1127ms)
stream=true  -> 200                 (2175ms)
```

**The Zen free tier refuses non-streaming requests.** Identical requests, one field apart. Our
adapter sent `stream: false` (line 495) -- which is why the first lane run produced no transcript at
all: every call was refused.

## B. Both gates now wired into the lane

```
EF_LIVE_ZEN_FREE=1   generates the time-encoded identity per process (zcode-config.ts)
EF_LIVE_STREAM=1     sends stream:true and rebuilds the non-streaming payload from SSE
                     (openai-adapter.ts, readStreamedPayload)
```

`readStreamedPayload` collapses the frames back into the ONE shape the rest of the adapter already
reads, so exactly one line changes and no consumer learns a second shape. `tsc -p tsconfig.eval.json`
is clean and `tests/live-budget-admission.spec.ts` is 17/17.

## C. What is verified, and what is not

```
free model reachable from our own code        YES -- 200, real usage, 2.4s
identity generated per process                YES
streaming request + SSE rebuild               YES -- typechecks, no regression
LANE END-TO-END                               NOT CONFIRMED
```

## D. The current symptom, stated plainly

```
job        lhtb-ef-20261016-015302-probe-economy
elapsed    ~7 minutes        ef-transcript.json  absent
trial.log  0 bytes           job.log  0 bytes
bridge     pid 55640, cpuSec 0   <- blocked, not spinning
python     2 agent processes alive
container  unknown-config-semantics__znubtjr-main-1 Up 6 minutes
```

**No turn has completed.** The bridge is idle rather than looping, and the agent is alive, so this is
a wait, not a crash. The most likely cause is `await response.text()` on the SSE body: it resolves
only when the stream CLOSES, and my direct probe got a complete 2-second response while the adapter
is still waiting minutes later. That is a hypothesis about where it waits, not a measurement of why.

**It is NOT a 403.** The refusal is gone; what replaced it is a hang.

## E. Honest summary

The invocation problem the brief named is **solved**: the free model answers our own code, and the two
gates are identified precisely and wired in. **The lane has not been shown to complete a turn**, and
I am not going to report a successful integration on the strength of a protocol probe.
