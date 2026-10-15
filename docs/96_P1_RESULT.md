# 96 — The P1 run: 0.7636 against a 0.3678 baseline, no fold by 9%

Status: **PILOT CENSORED — NO NATURAL FOLD** (budget), with a real quality signal. 2026-10-15.
Parent `62ff417`.

## A. The result

```
job          lhtb-ef-20261015-183321-probe-economy
termination  budget-exhausted          elapsed 11,487,696 ms = 191.5 min
modelCalls   75        folds 0   roots 0   emergencies 0
promptTokensLast 59,391  = 90.6% of the 65,536 threshold  (6,145 short)
providerFailures 5     shells 78
taskRoot     resident, sourceSeq 2, digestVerified, position 0   (throughout)
budget       requests 74, charged prompt 4,322,946 / output 404,321
             observed 3,667,586 / 240,481
             reserved 655,360 / 163,840      <- 5 outstanding, one per failure
             unknown 0, partial 0, refusals 1
```

## B. The quality signal — the first one this project has

```
official_reward     0.7456896551724138
reward              0.7636        submits 2      passed_stages 3
raw_ungated         0.8506        baseline_ungated 0.3678
best_correct_fields 592 / 696     total_cases 58    pass_threshold 1.0
```

**0.8506 against a 0.3678 baseline.** EF Economy + Exact Task Root, on a real LHTB episode, more
than doubled the ungated score, with 592 of 696 fields correct. This is n=1 and **not** a pinned-vs-
unpinned comparison -- there is no paired Off run -- so it is a signal, not an effect size.

## C. Why it stopped, and it is NOT a mystery this time

The output budget bound: `charged output 404,321 >= 400,000` -> `refusals 1` -> `budget-exhausted`.
**Five provider failures each left their own reservation standing** (5 x 32,768 = 163,840 output),
which is 41% of the 400,000 output budget spent on requests that never reported usage. The
reservation is correct -- those requests may have been billed -- but at 32,768 per failed request it
is expensive, and it is what pushed the run over.

**So the fold was 6,145 tokens (9.4%) away and the budget closed first.** That is a genuine
`Budget-Censored`, caused by conservative accounting doing its job, not by a parameter defect of the
kind that ended the earlier run at call 13.

The earlier `reserved 393,216 / 98,304` that I could not explain was the same thing seen mid-flight:
the transcript is written per turn, so `providerFailures` lagged the reservations it had already
created. **The correspondence is now exact -- 5 failures, 5 reservations, same counts.**

## D. What was and was not established

```
NATURAL FOLD                 NOT EXERCISED   (90.6% of the threshold)
OPERATIONAL RECALL           NOT EXERCISED   (no archive existed)
POST-FOLD CONTINUATION       NOT ESTABLISHED (no fold occurred)
TASK ROOT RESIDENCY          VERIFIED -- 75 calls, resident and digest-verified
BUDGET GATE                  EXECUTED, EFFECTIVE, and the reason it stopped
TASK QUALITY                 reward 0.7636 / official 0.7457 vs baseline 0.3678  (n=1)
INCREMENTAL BENEFIT          NOT ESTABLISHED -- no paired unpinned run
```

## E. What this changes for the next decision

The threshold is reachable -- 90.6% of it on the first run that was allowed to keep going -- so the
next run needs headroom in the OUTPUT budget rather than a different task. Two levers, both needing
approval: raise `EF_LHTB_BUDGET_OUTPUT_TOKENS` above 400,000 (the reference cost bound must be
re-derived), or reduce `EF_LHTB_REPLY_MAX_TOKENS` so a failed request reserves less.
