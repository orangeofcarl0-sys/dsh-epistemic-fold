# R37-C — R37-B Audit

This document audits R37-B without rewriting it. The original files and their
hashes remain authoritative; the corrections are separate R37-C artifacts.

## 1. What was observed in R37-B

Stage 2, 36 assigned-arm B1/S pairs, contract success:

```text
S    50.0%
B1   72.2%
difference -22.2 percentage points
exact McNemar 1 rescue / 9 damage, p = 0.0215
case-clustered bootstrap 95% CI -30.6 to -11.1 pp
```

Task success:

```text
S    61.1%
B1   75.0%
difference -13.9 pp
exact McNemar 2 / 7, p = 0.1797
case-clustered bootstrap 95% CI -25.0 to -2.8 pp
```

Per-case contract direction:

```text
A1-v2  -2
D1-v2  -2
B2     -2
C1     -1
F1     -1
H1      0
```

Five of six cases are negative; H1 is flat (one rescue, one damage). The
two-sided case-level sign test is p = 0.0625. This is a sensitivity analysis,
not a replacement for the preregistered McNemar test.

## 2. What was reconstructed

- Every Stage 2 report, trace, workspace, journal, and manifest is present.
- The expected cell matrix is complete: 360 unique cells, 0 missing, 0
  unexpected, 0 model/protocol/dataset/scorer drift.
- The 11 invalid rows are 2 provider/transport failures and 9 fold refusals.
- The Stage 2 writer's old `commitRecall` is accepted-fact matching, not
  committed-fact recall.
- The Stage 2 `modelTurns = 819` is `behaviourDetail.steps`, not model calls.
  The traces contain 903 model turns.
- Stage 1's admission gate checked `unparsedTurnRate`, not the preregistered
  turn-level rejection rate.

## 3. What was wrong

### 3.1 Writer recall

R37-B W1 reported `commitRecall = 0.722`. The corrected committed-fact recall
is **0.514**. The difference is accepted facts from fold-refused rows and
accepted facts that did not remain the active anchor.

### 3.2 Invalid measurements

R37-B counted 11 invalid measurements. Nine are fold refusals: observable
pipeline outcomes, not censored provider measurements. Only two are true
transport-invalid rows. The assigned-arm denominator must keep the fold
refusals; R37-C does.

### 3.3 Protocol admission

The preregistration says `P3e turn-level protocol rejection rate <= 10%`. The
Stage 1 gate checked `unparsedTurnRate = 29/569 = 5.10%`. Those are different
metrics. The action-level rejection rate was `93/885 = 10.51%`; the
turn-level rate cannot be reconstructed exactly from the 1,000-character
trace. The Stage 1 admission is therefore **gate-not-verifiable**, not passed.

### 3.4 Model turns

The Stage 2 protocol table used 819 completed steps as "model turns". The
traces contain 903 model calls. Using 903:

```text
stored no-valid-action rate   216/903 = 23.92%  (not 26.37%)
stored unparsed-turn rate      37/903 =  4.10%  (not  4.52%)
```

The direction is unchanged; the denominator is corrected.

### 3.5 Product decision

The old gate script accepted `R37B_PRODUCT_DECISION` as the product decision.
The R37-C gate path separates:

```text
machine outcome     computed from the paired result and delivery rate
researcher decision optional, recorded separately
```

An environment variable can no longer silently become the computed result.

## 4. What still holds

- The contract direction is negative under this model, route, harness, and
  six-case instrument.
- Five of six cases are negative; the sixth is flat.
- Eight of nine contract damages are implementation/process failures: no test
  run or broken code, not a lost fact.
- H1 is the only fact-visible, action-inconsistent damage; it also produced the
  only rescue, so it is variable.
- The representation contrast is not confirmed. B2 F-S is 2 wins / 0 losses /
  4 ties (p = 0.50); C1 F-S and F-H are each 1 win / 0 losses / 5 ties
  (p = 1.00).
- The deployment hold remains correct.

## 5. What does not hold

- "72% of writer facts were committed" is false; the committed figure is 51%.
- "11 invalid measurements" as a single category is false; 9 are fold refusals.
- "The Stage 1 protocol gate passed" is not verifiable from the stored
  evidence and used the wrong metric.
- "819 model turns" is the completed-step count, not the model-call count.
- "EF caused the agent to forget" is not supported. Most damage is process,
  and H1's checkpoint contains the fact.

## 6. Evidence labels

```text
Observed        raw report/trace/journal fields and final workspaces
Reconstructed   cell matrix, committed anchors, recomputed rates
Inferred        first observable failure classification
Hypothesized    checkpoint/prompt/model-variance causes of process harm
Unavailable     full model output beyond 1,000 characters; full session log
                for a complete validateSemanticCommit proof
```

## 7. Decision

```text
EF Active deployment: hold
Reason: no benefit signal; confirmatory contract harm direction;
        mechanism mostly process/implementation, not fact loss.
```

R37-C does not change this hold. It makes the evidence behind it more honest.
