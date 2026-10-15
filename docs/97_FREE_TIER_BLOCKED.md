# 97 — The free tier refuses this harness: HTTP 403 FreeTierError

Status: **NOT A VALID EXPERIMENT — INFRASTRUCTURE REJECTION.** 2026-10-15. Parent `c3c1b0a`.

## A. What the provider said

```
live provider HTTP 403:
  {"type":"error","error":{"type":"FreeTierError",
   "message":"OpenCode's free tier can only be used from within OpenCode.
              Download it at https://opencode.ai and keep building."}}
```

**The free tier is gated on the client, not on the credential.** Every request this harness makes is
rejected before the model is reached. It is not a model-quality result, not a rate limit, and not
something a retry or a different budget would change.

## B. The run

```
job        lhtb-ef-20261015-220245-probe-economy      runtime 9m 31s
termination budget-exhausted
modelCalls 14   folds 0   promptTokensLast 1,444   providerFailures 13   shells 0
budget     requests 13, charged prompt 1,703,936 / output 425,984
           observed 0 / 0, reserved 1,703,936 / 425,984, refusals 1
reward     0.0   best_correct_fields 256 / 696   passed_stages 0
```

**Zero shell executions and 1,444 prompt tokens**: the model never produced a usable turn. The
score is the untouched starting position, not a measurement of EF.

## C. It confirms how the reservations behave under repeated failure

13 rejected requests each left a full reservation (13 x 131,072 prompt and 13 x 32,768 output), and
the output limit bound at 425,984 -- the **same mechanism** that ended the previous run at 404,321
with 5 failures. `observed` is 0/0 because a 403 carries no usage, so **the entire charge is
conservative reservation**, which is the designed behaviour for a request whose cost is unknown.

The difference from the previous run is the cause of the failures: there, 5 calls were most likely
**aborted by the 120s deadline** the runner silently applies to any model name other than the paid
`deepseek-v4.1-flash`; here, 13 calls were **rejected outright**. Both leave reservations; only the
second is a hard stop.

## D. Cost

A 403 is refused before the model runs, so nothing was billed. The reference-usage equivalent for
this run is therefore **$0**, even though the gate charged 1,703,936 prompt / 425,984 output in
reserves. **A reserve is not a charge, and this run is the clearest illustration of why the two are
reported separately.**

## E. What this means for the free-model idea

`deepseek-v4.1-flash-free` exists only on `/zen/v1`, and that route's free tier is closed to
non-OpenCode clients. The paid `deepseek-v4.1-flash` on `/zen/go/v1` remains the only usable route
for this harness. **No amount of budget, timeout or model-name tuning changes that.**
