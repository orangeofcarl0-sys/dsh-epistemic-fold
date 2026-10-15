# 106 — Fold run relaunched on the proven model, with all three fixes

Status: RUNNING. 2026-10-16. Parent `2766774`.

## A. Why this model and not the free one

`deepseek-v4.1-flash` is the run that came CLOSEST to a natural fold: **75 calls, 59,391 of 65,536
tokens (90.6%)**, stopped only because the output budget bound at 404,321 of 400,000. It is also the
best-scoring run so far (`raw_ungated 0.8506` against a `0.3678` baseline, 3 stages passed).

The free `deepseek-v4.1-flash-free` is not usable through this lane -- `docs/105` closed that: the
trial stops progressing before its first network request, and none of my flags cause it.

## B. The three fixes, each aimed at a specific cause of that stop

```
EF_LHTB_REPLY_MAX_TOKENS 32768 -> 16384   a failed request reserves HALF as much
EF_LHTB_BUDGET_OUTPUT_TOKENS 400000 -> 550000   +150,000 of headroom
model_request_timeout prefix match   a new model name is no longer silently dropped to 120s,
                                     which is what aborted the five calls whose reserves
                                     consumed 163,840 of the previous run's output budget
```

On the previous run's own numbers, those five failures would have cost 81,920 instead of 163,840 --
**about 82,000 saved against a 6,145-token shortfall.**

## C. Early state

```
jobdir  lhtb-ef-20261016-023258-probe-economy      elapsed 2.8 min
calls 7   folds 0   promptTokensLast 19,128   providerFailures 0   shells 13
budget  requests 7 == modelCalls        (no retries)
        observed == charged 86,532 / 17,615
        reserved 0 / 0   refusals 0   unknown 0   partial 0
        limit {140, 7,000,000, 550,000, 28,800,000}
taskRoot resident, sourceSeq 2, digestVerified, position 0
```

**`reserved 0 / 0` is the fix showing up in the accounting**: the previous run already carried standing
reservations by this point. Every request is settling against its own credential and nothing is
stranded.

## D. Not predicted

I am not projecting a fold time. Two earlier projections from a single early window were both wrong --
one too pessimistic by a factor of two, one too optimistic -- and the per-call rate here is not a
property of the model. The run is left to its own conclusion.
