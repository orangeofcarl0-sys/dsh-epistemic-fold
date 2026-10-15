# 105 — The flags are exonerated: the stall is intrinsic to /inference/v1 + that model

Status: diagnosis CLOSED on the decisive question. 2026-10-16. Parent `a97cb7b`.

## A. The run that settles it

`/inference/v1` + `deepseek-v4.1-flash-free` with **neither** `EF_LIVE_ZEN_FREE` nor `EF_LIVE_STREAM`:

```
job  lhtb-ef-20261016-022152-probe-economy
result: NO TRANSCRIPT -- stalled exactly as before
```

**My two code changes are exonerated.** If either had caused the hang, removing both would have
changed the outcome; it changed nothing.

## B. The full elimination table

```
the lane itself                  EXONERATED  control run reached the model, 7 calls in 3 min
the free tier / 403              EXONERATED  0 TCP connections -- it never reached the network
streaming and response.text()    EXONERATED  stream closes in 1.9s small, 2.9s at 20K tokens
EF_LIVE_API_KEY=public           EXONERATED  run-lhtb.sh:110 overrides it unconditionally
the trial configuration          EXONERATED  YAML differs on job_name and model_name only
EF_LIVE_ZEN_FREE / EF_LIVE_STREAM EXONERATED this run, with neither, stalls identically
resolveLiveRoute()               EXONERATED  returns the route, model and all 7 headers
```

**What remains is the pair `/inference/v1` + `deepseek-v4.1-flash-free`**, and the two cannot be
separated by configuration because the model exists only on the `/zen/v1` family while the route that
works for this lane is `/zen/go/v1`.

## C. What the stall is

```
bridge      parented by HARBOR, cpu 1, TCP connections 0
artifacts   no transcript, no actions.log, job.log 0 bytes, trial.log 0 bytes
process tree harbor.exe -> python -> python -> node(bridge-host)
```

**It stops before the first network request and harbor never writes its own job log.** That is not a
model refusal, not a budget stop and not a transport failure -- it is the trial failing to progress,
with the model name as the only configuration difference.

## D. Consequence for the experiment

**The free `deepseek-v4.1-flash-free` is not usable through this lane.** The invocation problem was
genuinely solved -- our own code gets `200` with real usage -- but the lane stalls before any request
when that model name is used, and no amount of header, streaming or credential work changes that
because none of it is reached.

For the EF experiment the usable choices remain the models already proven on `/zen/go/v1`:
`cat-jam-free` (72 calls, natural completion, cleanest accounting of any run), `step-5-preview-free`,
or the paid `deepseek-v4.1-flash` (75 calls, the best score so far).

## E. Not established

**Why** the trial stops progressing on that model name. It is reproducible, it is not my code, and it
is not the network. Naming a cause here would be a guess, and four earlier guesses in this thread
were each disproved by the next measurement.
