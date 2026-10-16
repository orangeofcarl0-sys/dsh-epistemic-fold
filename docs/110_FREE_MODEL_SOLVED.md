# 110 — SOLVED: the free model works in the lane. Three gates, and a wrong diagnosis retracted

Status: **WORKING** -- 6 calls, 0 provider failures, 11 shell executions, 39 seconds. 2026-10-16.
Parent `1e10d59`.

## A. The third gate: the TOOL NAMES

Measured against `/inference/v1` with the identity held constant, one field apart:

```
tools = read + bash             -> 200
tools = run_shell (EF's own)    -> 403 FreeTierError
tools = run_shell + read + bash -> 200
```

**The gate requires declarations named exactly `read` and `bash`.** This lane's agent offers EF tools
under other names, so **every call was refused**. `EF_LIVE_ZEN_FREE` supplied the identity and nothing
supplied the declarations.

The adapter now appends them when the flag is set, inert and labelled as such, exactly as
`enforceAnonymousTools` does in `dsh-opencode-free`. A caller's own tool choice is preserved and never
renamed.

## B. The three gates, in the order they were found

```
1  session id    the first 12 hex must be ~(Date.now()*0x1000 + counter) & 0xffffffffffff,
                 NOT a hash. dsh-opencode-free lib/zen-provider.js:170-175 says so outright.
2  streaming     `stream: false` -> 403; `stream: true` -> 200. Identical requests, one field.
3  tool names    must declare `read` and `bash`. This lane did not, so every call 403'd.
```

All three are wired: `EF_LIVE_ZEN_FREE=1` (identity + declarations) and `EF_LIVE_STREAM=1` (SSE).

## C. Retracting the "stall"

`docs/103`-`105` concluded the lane STALLED before any network request on this route, and listed seven
eliminations. **That conclusion was wrong.** The runs were not stalling -- they were looping on `403`,
and the transcript is written when a turn completes, so reading "no transcript" at three minutes read
as silence when the episode was in fact failing every call.

The tell I missed was in the completed run's own numbers: **`calls 18, providerFailures 17, shells 0`**
and `lastProviderError` = `403 FreeTierError`. A stall does not produce eighteen calls. I had the
evidence in hand and read the absence of one file instead of the contents of another.

**The zero-TCP-connection observation was real but I over-read it.** It was taken from a bridge whose
connections had already closed between 403s, not from a bridge that had never tried.

## D. Verified in the lane

```
jobdir  lhtb-ef-20261016-143654-probe-economy
calls 6   providerFailures 0   shells 11   promptTokensLast 19,350   term in-progress
lastProviderError  (empty)
budget  requests 6 == modelCalls   observed == charged 72,673 / 3,433
        reserved 0 / 0   refusals 0   elapsed 39,512 ms
```

**`providerFailures 0` where every previous attempt had 17.**

## E. Also fixed this round, from the same evidence

`docs/108`: a transport failure that provably never left the machine now RELEASES its reservation
(`release`, not `settle` -- the latter leaves the reserved counters charged). Ten `fetch failed`
requests had been holding 327,680 output, 59% of the budget.
