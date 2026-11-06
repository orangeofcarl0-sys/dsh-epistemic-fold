# R37-C — Next-Stage Preregistration

This document prepares R37-D. It does not run the second model and does not
change the R37-B/R37-C product decision.

## 1. Second-model replication

### 1.1 Question

Does the R37-B contract harm direction replicate on a second model and route
under the corrected protocol?

### 1.2 Candidate models

Primary candidate:

```text
glm-5.3-flash
```

Alternates:

```text
deepseek-v4-pro-0813
qwen3.5-plus
```

The model and route change together. A result is a replication of another
deployment configuration, not a separation of model and gateway effects.

### 1.3 Mandatory preflight before the confirmatory batch

```text
native/tool compatibility
O2 contract floor >= 4/6
P3s turn-level rejection <= 10%, or gate-not-verifiable with a reported bound
model/route fingerprint recorded
cost availability recorded
```

If the O2 floor is below 4/6, do not start the B1/S batch.

### 1.4 Design

```text
cases          A1-v2, D1-v2, B2, C1, F1, H1-v2
arms           B1, S
replicates     6 per case/arm
protocol       P3s strict
harness        H-protocol-s, 8 steps, 1024 output/turn, no guard
model          one new model
route          one route
cells          72 continuation cells
```

Stage 1 exploratory (2 replicates) is allowed only to estimate transport and
protocol rates; it is not pooled with the confirmatory batch.

### 1.5 Primary outcome and criterion

Primary: contract success, assigned-arm B1/S pairs.

A benefit claim requires all of:

```text
rescue > damage
exact McNemar p < 0.05
determined delivery >= 80% of S rows
case direction not driven by one case
```

A harm claim requires:

```text
damage > rescue
exact McNemar p < 0.05
case-level direction consistent in at least 5/6 cases
```

Otherwise the result is `insufficient-evidence`. No threshold is changed after
seeing the data.

### 1.6 Sensitivity

Reported alongside the primary:

```text
per-case effect
case-level sign test
leave-one-case-out
case-clustered bootstrap (descriptive)
exclude A1-v2/D1-v2
exclude C1 (implementation floor)
```

## 2. Benchmark roles

The six cases are not equally memory-sensitive. R37-D assigns roles before the
run:

| case | role | weight in a memory-benefit claim |
|---|---|---|
| A1-v2 | execution/compatibility control | excluded from memory benefit |
| D1-v2 | verification-process control | excluded from memory benefit |
| B2 | process/representation candidate | primary |
| C1 | implementation-floor diagnostic | secondary, limited |
| F1 | authority-boundary regression | secondary |
| H1-v2 | historical-fact operationalization | primary |

C1's O2 contract success was 0/6 in R37-B. It cannot carry the main
semantic-benefit weight.

## 3. H1-v2

H1's visible test checked only the type, so an agent could pass it while
shipping `us-east-1`. H1-v2 changes the visible test to:

```text
region is a string
region is not us-east-1
region matches /^[a-z]{2}-[a-z]+-\d$/
```

The visible test does **not** name `eu-west-2`. The hidden checker still
requires `eu-west-2`. Certification:

```text
gold grounded                         true
reference (use-eu) visible/hidden     0 / 0
stale default visible/hidden          1 / 1
counterfactual (use-us) visible/hidden 1 / 1
visible test names eu-west-2          false
historical memory necessary           true
```

H1 remains unchanged. H1-v2 is a separate versioned case and is not pooled with
R37-B H1.

## 4. New held-out cases

Before R37-D, freeze at least one case from each risk class that is not already
covered:

```text
decision override          (B2 is the existing candidate; add a new one)
negative knowledge         (a rejected approach must stay rejected)
scope/authority            (two scopes hold different values)
cross-phase dependency     (a later task depends on an earlier decision)
retrieval trigger          (the fact is present but not salient)
multi-fold supersession    (two revisions, only the latest is current)
```

Gold must be frozen before any model run. Do not tune a new case against the
old six and then use the same case to claim improvement.

## 5. Cost and stop rules

```text
max HTTP attempts        1,200
max input tokens         1,500,000
max output tokens        300,000
max wall clock           3 hours
transport retries        at most 2 per cell
```

Stop if:

```text
O2 floor < 4/6
three consecutive provider-invalid cells
global budget reached
a case's gold is absent from its transcript
the checker requires a rule absent from task and visible tests
```

Do not add replicates to reach a desired result.

## 6. What is not claimed

- No second-model call was made in R37-C.
- No new held-out case is executed in R37-C.
- H1-v2 is certified as a benchmark, not as a model result.
- The R37-B harm signal is not generalized to another model or route.
