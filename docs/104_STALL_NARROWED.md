# 104 — Diagnosis: the lane works, the YAML differs only by model name, two flags remain

Status: narrowed to two variables. 2026-10-16. Parent `48ce83c`.

## A. The control run settles the biggest question

Re-running the **known-good cat-jam config** on the same machine, minutes after the stalls:

```
job  lhtb-ef-20261016-020624-probe-economy
calls 7   providerFailures 0   shells 7   term in-progress      <- reached the model in under 3 min
```

**The lane is not broken.** The stall is specific to the free-model configuration.

## B. The harness configuration is NOT the difference

The runner writes a per-run trial YAML, and the two runs differ on exactly two lines:

```
L49  job_name:    ...020952...      vs  ...020624...
L70  model_name:  openai/deepseek-v4.1-flash-free  vs  openai/cat-jam-free
```

Agent command, budgets, window, everything else is **byte-identical**. So the stall is not a
misconfigured trial -- it is either the model name or something in the process environment.

## C. One variable eliminated by reading the runner

`scripts/run-lhtb.sh:110` does:

```bash
export EF_LIVE_API_KEY="$KEY"        # the store's real key, unconditionally
```

**My `EF_LIVE_API_KEY=public` never took effect.** That is why removing it changed nothing: it was
never a variable. It also means the request would carry the store's credential, not `public`.

## D. What the stall actually looks like

```
bridge   pid 54584, parented by HARBOR (not by a separate agent process)
         cpu 1, TCP connections 0        <- it never reached the network
artifacts  ef-transcript.json ABSENT   actions.log ABSENT   job.log 0 bytes   trial.log 0 bytes
process tree  harbor.exe -> python -> python -> node(bridge-host)
```

There is **no separate `ef_lhtb_agent` process**: the agent runs inside the harbor process tree and
spawns the bridge. Harbor writes **nothing** to `job.log` where a working run writes 118 bytes, so the
trial is not progressing at the harbor level either.

**Zero TCP connections is the load-bearing fact**: whatever it is waiting on, it is not the network,
so it is not the free tier and not a 403.

## E. Two variables left, and the one run that separates them

```
EF_LIVE_ZEN_FREE=1   generates the identity (my code)
EF_LIVE_STREAM=1     streams + rebuilds the payload (my code)
```

**The test**: run `/inference/v1` + the free model with **neither** flag. Without the identity the
request should be REFUSED, so the expected result is **visible 403 failures in a transcript**, not a
stall. That single run decides it:

* a transcript full of 403s -> the flags are exonerated and the stall is intrinsic to route+model;
* another stall -> one of the two flags I added is the cause, and it is mine to fix.

## F. Honest state

The invocation problem is **solved** (200 from our own code, two gates identified). The lane
**integration is unproven**, and the blocker is now isolated to a stall that is **not** the free tier,
**not** the API key, and **not** the trial configuration.
