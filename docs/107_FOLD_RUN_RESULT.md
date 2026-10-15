# 107 — The Fold run finished WORSE, and one of the three fixes was inert

Status: **budget-exhausted again, no fold, score = baseline.** 2026-10-16. Parent `628f86a`.

## A. The result

```
job        lhtb-ef-20261016-023258-probe-economy      elapsed 4,124,585 ms = 68.7 min
termination budget-exhausted        refusals 1
modelCalls 48    folds 0    promptTokensLast 39,991  = 61% of the 65,536 threshold
providerFailures 10 (!)         shells 47
taskRoot   resident, sourceSeq 2, digestVerified, position 0
budget     requests 47, charged prompt 2,636,223 / output 556,846
           observed 1,325,503 / 229,166
           reserved 1,310,720 / 327,680        <- TEN standing reservations
reward     raw_ungated 0.3678  ==  baseline_ungated 0.3678   stages 0   submits 0
```

## B. Compared with the run these fixes were meant to improve

```
                          previous (183321)     this run (023258)
modelCalls                75                    48
fold pressure             90.6%                 61%          WORSE
providerFailures          5                     10           WORSE
raw_ungated               0.8506                0.3678       == baseline
passed_stages             3                     0
output charged            404,321 / 400,000     556,846 / 550,000
```

**Every number that mattered moved the wrong way.** The fixes were aimed at the right mechanism and
did not deliver the outcome.

## C. The reply-max fix did NOT take effect

`EF_LHTB_REPLY_MAX_TOKENS=16384` was set to halve each failed request's reserve. Measured:

```
reservedOutput 327,680 / 10 failures = 32,768 each      <- unchanged from before the fix
```

**The reserve per failure is still 32,768.** Either the variable did not reach the agent, or reply
budget ESCALATION restored it -- the agent raises `maxTokens` on truncation, and a truncated reply
that then fails would reserve at the escalated value. I have not separated those two, so I am not
claiming which.

**What is certain: the intended halving did not happen.**

## D. The binding constraint is the same one, and it is now the majority

```
charged output 556,846
  of which failure reserves 327,680   = 59%
  of which observed usage   229,166   = 41%
```

**Ten failures consumed 59% of the output budget.** The budget did not run out because the task was
long; it ran out because failed requests hold reservations, and this run had twice as many failures.

## E. What I will not claim

* that the fixes caused the worse score -- the run also had twice the failures, and I have not
  separated cause from coincidence;
* that escalation is why the reserve stayed at 32,768 -- that is a hypothesis with a named rival;
* that this says anything about EF. `raw_ungated` equals the baseline exactly, on a run cut off at
  61% of the threshold with ten provider failures. It is a statement about this run.

## F. The honest read

**Three fixes, none of them produced a fold, and one is measurably inert.** The thing that actually
stops these runs is unchanged and now dominant: **failed requests reserve output budget that the task
never gets to use.** Until that is addressed -- by finding why the reply max did not apply, or by
making a failed request's reserve bounded by something other than a full reply -- raising the output
budget only buys more failures.
