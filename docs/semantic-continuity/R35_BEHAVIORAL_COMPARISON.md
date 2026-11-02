# R35 — Behavioural Comparison

## Status

```text
real B1 / S pairs:        0
real O1 / O2 pairs:       0
real agent tool loops:    0
real hidden checker runs: 0
provider requests:        6 attempted, 0 succeeded
verdict:                  blocked / not executed
```

No real-model behavioural comparison exists. The authorized writer-only pilot
was attempted, but every real writer call in both runs returned HTTP 401
`api_key_expired`, and no O1 oracle row is a substitute for an S row. Running
B1/S continuations on a dead route would only have spent more attempts to
produce the same non-result, so the continuation stage was not started.

The sections below state what the instrument will measure and why no number is
reported.

## What would be measured

For each frozen case and each arm, the runner records:

```text
fold validity and replacement seq
writer call, protocol, proposals, refusals, commit status
rendered checkpoint digest and length
working-set state digest and visible anchors
follow-up steps, tool calls, file reads/writes, visible test runs
hidden checker status, checks, and claims
functional success, historical constraint compliance, process compliance,
contract success
obsolete revival, rejected retrial, false verification
recall attempts, matches, and gold-grounded matches
provider usage, reserved/charged usage, retries, wall clock
```

B1 and S share the frozen transcript, fold boundary, initial workspace, task
text, route, parameters, tool permissions, and checker. They use separate
session, journal, bundle root, workspace, and trace.

## Why the R34 scripted numbers are not this result

R34's scripted pipeline succeeded S 15/17 vs B1 7/17, with 8 rescues and 0
damage. That is a delivery measurement: a deterministic decision rule reads the
arm's visible context. It is not a model accuracy, a model success rate, or a
real agent behaviour. It is retained as an offline control only.

The R35 report must not reuse those numbers as if they were model results, and
the holdout remains unexecuted.

## Pair accounting

The first live pilot will report:

```text
complete pair
incomplete pair
budget-censored
provider-failed
invalid measurement
```

A case where B1 ran and S did not is not an S failure. The primary quality
comparison uses only valid complete pairs; the full report retains every missing
row and the stop reason, and discusses selection bias. Paired differences are
cluster-aware by task family; a 4–6-case pilot is exploratory.

## Gate

R35 behavioural evidence is **blocked**. The required inputs are listed in
`R35_LIVE_PREFLIGHT.md`; the next command is the writer-only pilot, not a B1/S
comparison.

```bash
# AFTER explicit authorization, route resolution, and a positive budget:
R33_LIVE=1 node eval/r33/live.mjs --run \
  --stage writer-only \
  --cases A1,B2,C1,D1,F1,H1 \
  --manifest <authorized-manifest.json>
```

Only after the writer evidence is saved should the same cases run with
`--stage continuation` for B1/S/O1/O2.
