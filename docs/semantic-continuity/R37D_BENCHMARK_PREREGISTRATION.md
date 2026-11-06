# R37-D — Benchmark Preregistration

## 1. What is certified

| case | category | status | reference | stale |
|---|---|---|---|---|
| H1-v2 | retrieval-trigger | certified (R37-C, re-audited R37-D) | `use-eu` | `use-us` |
| S1-v1 | authority-scope | certified (R37-D) | `use-production` | `use-staging` |

### H1-v2

The task, workspace, visible test, and writer handoff do not name `eu-west-2`.
The transcript does. The visible test forbids `us-east-1` and accepts any
AWS-shaped region.

R37-D adds a stronger control than the R37-C certificate:

```text
reference    eu-west-2   visible pass, hidden pass
stale        us-east-1   visible fail, hidden fail
alternative  us-west-2   visible pass, hidden fail
```

`us-west-2` is not in the case. It proves that the visible test alone cannot
substitute for the history: an agent can pass it with a plausible wrong region.

### S1-v1

The workspace ships the staging timeout (5). The transcript records the
production timeout (30) and says the staging value is not authoritative.

```text
reference    30   visible pass, hidden pass
stale         5   visible pass, hidden fail
alternative  10   visible pass, hidden fail
```

The visible test accepts any positive integer. It cannot distinguish staging
from production. The hidden checker requires 30. The authority-scope history is
necessary.

## 2. What is only specified

| case | category | status |
|---|---|---|
| D2-v1 | decision-override | specified-not-authored |
| N1-v1 | negative-knowledge | specified-not-authored |
| X1-v1 | cross-phase-dependency | specified-not-authored |
| M1-v1 | multi-fold-supersession | specified-not-authored |

A specification is not a case. Each one must be authored with a transcript,
gold, reference action, stale action, visible test, hidden checker, and a
certification artifact before a live batch can use it.

## 3. Freeze requirements

Every new case must satisfy all of:

```text
gold quote occurs verbatim in every sourceRef message
reference action passes visible and hidden
stale and a plausible alternative pass visible and fail hidden
gold absent from task, workspace, visible test, writer handoff
hidden checker outside the workspace and declares exact check names
certification artifact records every run and the case digests
no provider call during certification
```

A case that cannot meet the alternative control is not history-dependent in a
measurable way. It must be revised or dropped.

## 4. Next history-use batch

Recommended first batch after authorization:

```text
cases        H1-v2, S1-v1
context arms B1, S
replicates   3
cells        2 x 2 x 3 = 12
```

This is a history-use check, not an EF product-effect batch. The fixed context
must be frozen for each case/arm, as in WP3. The process prompt is not part of
this batch.

The four specified cases are phase A of the following batch:

```text
author + certify D2-v1, N1-v1, X1-v1, M1-v1 offline
then freeze a separate manifest
then authorize a separate live batch
```

Do not mix new cases into the P0/P1 process batch.

## 5. No live call in R37-D

```text
provider calls     0
new model runs     0
status             prepared
```

The H1-v2 and S1-v1 certifications run local Node tests and checkers only.

## 6. Artifacts

```text
eval/r37d/audit-h1-v2.mjs
eval/r37d/out/h1-v2-audit.json
eval/r37d/cases/S1-v1/
eval/r37d/certify-s1-v1.mjs
eval/r37d/out/s1-v1-validity.json
eval/r37d/held-out-plan.mjs
eval/r37d/out/held-out-plan.json
tests/r37d-benchmark.spec.ts
```
