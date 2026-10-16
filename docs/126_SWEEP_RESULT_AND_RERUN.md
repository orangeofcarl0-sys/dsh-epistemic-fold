# 126 — Four-arm sweep result, and the instability hypothesis to test

Status: recorded; re-run launched. 2026-10-16. Parent `984e9b7`.

## A. The result

```
arm       cell  calls  folds  tok      oracle  proseCmds  termination
balanced  A      95     0    60,836     26      20       model-reported-completion
balanced  B      62     0    43,062     19       7       in-progress
economy   A     135     0    57,246     64      11       budget-exhausted
economy   B      99     0    43,665     63       2       model-reported-completion
quality   A      42     0    28,248      0       7       model-reported-completion
quality   B      32     0    27,264      3       8       model-reported-completion
basic     A      68     0    40,143     20      14       model-reported-completion
basic     B     135     0    49,770     73       8       budget-exhausted
```

```
folds              0 / 8
closest to threshold  balanced A  60,836 / 65,536 = 93%
oracle 0-3 calls  -> raw_ungated 0.3678  (exactly the baseline)
oracle 19-73 calls -> raw_ungated 0.8132 - 0.8750
```

## B. Two candidates I raised, and one I withdrew

**Withdrawn -- "concurrency pressure"** (`docs/125`): measured, the eight concurrent cells run at
1,639-2,993 ms per call while single-run cells run at 3,056-4,428 ms. **The concurrent cells are
faster.** No penalty is visible.

**Withdrawn -- "prose-as-command is a quality-arm defect"**: I checked it rather than asserted it, by
counting commands that are multi-line prose. **Every arm does it**, 2-20 per cell, and quality is
mid-range (7, 8). Not a quality signature.

## C. What is left standing

**The oracle count is the only clean discriminator**, and it is a trajectory fact rather than a
statistic: quality used the oracle **0 and 3 times**, every other cell used it **19-73 times**, and the
score splits exactly along that line.

`quality` is also the only arm configured with `semanticMode: 'rationale'`; the other three are
`'none'`. **That is a correlation with one candidate mechanism, not a finding** -- and it is now the
only candidate that has survived being checked.

## D. The hypothesis to test: model instability

**The operator's read is that this may be the model being unstable run to run**, and the evidence is
consistent with it: the SAME model on the SAME task scored 0.8491 in a single economy run at 62 calls,
while the sweep's economy cells ran 99 and 135 calls for 0.8132; and quality's two cells both barely
touched the oracle.

**A re-run is the test, and it discriminates cleanly:**

* **if quality again uses the oracle ~0 times**, the behaviour is systematic to that configuration and
  instability is not the explanation;
* **if quality uses it like the others**, the first sweep caught an unstable run and the arm comparison
  from it means nothing.

Either answer is worth more than a third explanation offered without a measurement.

## E. What a re-run still will not give

n=2 per arm is two cells, not a distribution. **Two sweeps is four cells per arm, which is still not a
distribution** -- so arm-to-arm differences remain unreadable, and only the presence or absence of the
oracle behaviour changes.
