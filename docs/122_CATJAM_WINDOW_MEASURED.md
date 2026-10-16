# 122 — MEASURED: cat-jam-free's real window is 1,048,576, not the assumed 131,072

Status: measured. 2026-10-16. Parent `16047a1`.

## A. The measurement

Ladder against `/zen/go/v1`, reading the ACTUAL `prompt_tokens` from each response rather than
trusting the target size:

```
target   4000  -> 200   actual     4,563
target  32000  -> 200   actual    36,114
target  65536  -> 200   actual    73,902
target 131072  -> 200   actual   147,752
target 200000  -> 200   actual   225,422
target 262144  -> 200   actual   295,447
target 400000  -> 200   actual   450,787
target 524288  -> 200   actual   590,838
target 700000  -> 200   actual   788,836
target 900000  -> 200   actual 1,014,204
target 920000  -> 200   actual 1,036,739     <- accepted
target 935000  -> 400   context_length_exceeded
target 1100000 -> 400   context_length_exceeded
```

**The boundary lies between 1,036,739 and ~1,053,000, which brackets `1,048,576` -- 1 Mi tokens.**

## B. The assumption was 8x too small

```
assumed (runner, honestly labelled ASSUMED)   131,072
measured                                     1,048,576
ratio                                        8x
```

`scripts/run-lhtb.sh` printed `window: EF_TAU2_WINDOW=131072 ASSUMED for cat-jam-free (adapter
default, not measured on this route)`. **That label was honest and it was right to distrust it.**

## C. This INVERTS the question it was asked to answer

The question was whether the window is set too LONG, making the fold line hard for a terse model to
reach. **The window is set too SHORT -- and that is not what makes the fold hard to reach.**

The threshold is a FIXED FRACTION of the window (`compactBudget.thresholdTokens 65536` against
`contextWindow 131072` -- exactly 50%). So:

```
threshold 65,536 as a fraction of the ASSUMED window   50%
threshold 65,536 as a fraction of the MEASURED window  6.25%
```

**The fold is currently calibrated to fire at one-sixteenth of the model's real capacity.** And if the
window were corrected while keeping "threshold = 50% of window", the threshold would become 524,288 --
against a task whose natural context demand is 30,000-60,000 tokens (measured: cat-jam finished at
30,245 and 40,473; deepseek at 59,391). **The fold would then be unreachable, not merely hard.**

## D. What the numbers actually say

```
model            final tokens   calls   growth/call
cat-jam 204636       30,245      62       ~488
cat-jam 235047       40,473      72       ~562
deepseek 183321      59,391      75       ~792
```

* reaching 65,536 needs ~83 calls at deepseek's rate and **~134 at cat-jam's** -- against a request
  budget of 140;
* the task FINISHES at 62-75 calls, at 23-45% of the assumed window.

**So the difficulty is not the window's length. It is that the threshold is derived from the window at
all**, while the quantity that decides whether a fold is needed is the TASK's context demand. For this
task those two happen to sit near each other, which is exactly why folds are *nearly* reachable and
never reached -- a coincidence of a wrong number, not a calibration.

## E. Not done

The window was NOT changed anywhere. `EF_TAU2_WINDOW` is still 131,072 for cat-jam on this lane, and
the threshold is still 65,536. Both are the operator's to set; this document only measures.
