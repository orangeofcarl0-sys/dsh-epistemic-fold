# 103 — Diagnosis: the stall is BEFORE the first model call, and it is route-specific

Status: cause narrowed, not closed. 2026-10-16. Parent `4818301`.

## A. The free tier is NOT the cause

**The bridge has zero TCP connections.** It never reached the network, so no request was made and no
403 was possible. Everything I suspected about streaming and `response.text()` is eliminated:

```
small(200tok)  status=200  firstByte 1681ms  total 1934ms  streamClosed=true
large(20Ktok)  status=200  firstByte 2800ms  total 2913ms  streamClosed=true
```

The stream closes promptly at both sizes, so `await response.text()` is not where it waits.

## B. What IS verified working

```
resolveLiveRoute() -> baseUrl https://opencode.ai/inference/v1
                      model   deepseek-v4.1-flash-free
                      headers authorization, user-agent, x-opencode-client,
                              x-opencode-project, x-opencode-session,
                              x-client-request-id, x-opencode-request
free model direct    -> 200 with real usage in 2.4s
adapter streaming     -> tsc clean, admission tests 17/17
```

**Every piece I control is correct.** The stall is in the harness path around it.

## C. The stall, measured

```
job        lhtb-ef-20261016-015302-probe-economy    ~11 minutes
bridge     pid 55640  cpuSec 0  threads 14  TCP connections 0
harbor     alive, n_running_trials 1, finished_at null
container  unknown-config-semantics__znubtjr-main-1  running since 01:53:08
artifacts  ef-transcript.json ABSENT   actions.log ABSENT   trial.log 0 bytes   job.log 0 bytes
```

Compare a run that worked (cat-jam, same lane, same day):

```
job.log 118   trial.log 118   actions.log 3391      <- the agent had started acting
```

**No agent action was ever recorded.** The bridge is idle rather than looping, so this is a wait.

## D. The discriminator I can name

Two runs stalled and both used `EF_LIVE_BASE_URL=https://opencode.ai/inference/v1`. The earlier
`step-5-preview-free` run used `/zen/go/v1` and **did** produce calls. So "free models stall" is
false, and the difference tracks the ROUTE. I have not established the mechanism, and I am not going
to guess one: the config resolves correctly for `/inference/v1`, which is the obvious suspect, so the
obvious suspect is eliminated rather than confirmed.

## E. Not established

* why no agent action is recorded;
* whether the agent is blocked on `bridge.init` (the bridge is alive, so it did not exit);
* whether the agent process exists somewhere this filter cannot see -- `ef_lhtb_agent` was not found
  among python processes, and the bridge's parent is `harbor.exe`, not an agent.

The honest statement: **the invocation problem is solved and the integration is unproven**, and the
two are now separated by a stall that has nothing to do with the free tier.
