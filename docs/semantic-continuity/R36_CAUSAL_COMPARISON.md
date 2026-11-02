# R36 — Causal Comparison

## Status

```text
G4 real B1/S/O1/O2 comparison     BLOCKED
R36 provider requests             0
R36 B1/S rows                     0
R36 causal claims                 none
```

This document records the frozen design and why no causal result exists. It
does not present R35's continuation rows as R36 evidence.

## 1. What is frozen

`node eval/r36/conditions.mjs` writes `eval/r36/out/conditions.json`:

```text
dataset                 r33-semantic-continuity-v2
dataset digest          407148f0c3280ada831b72150640ac6cdf14dceae600c3dcdbf2a61bd8e0c87f
scorer                  v3
W0 digest               1d13166dfaba145986af0d183d1739ed2835aca76668774dada15f0aaf937abc
W1 digest               61f380abc4fc2e98a02a55891a9a06c8e41040fbaf845f276ca6bbeadab3b5a3
parser P0               production strict parser
parser P1               eval ablation, not production
validator               source digest recorded
authority               source digest recorded
H0                      custom loop, 8 steps, 1024 tokens/turn, no guard
H-step                  16 steps
H-output                4096 tokens/turn
H-finish                guard enabled
H-native                not implemented
model                   deepseek-v4.1-flash
provider                opencode
```

The live manifests are in `eval/r36/manifests/`. Every live manifest is marked
`blocked` and carries a reason. They validate against the manifest schema but
have not run.

## 2. Why G4 is blocked

Two independent prerequisites are missing:

1. **No R36 spend authorization.** The R35 authorization does not automatically
   extend to a new round. `R36_LIVE_AUTHORIZED` is not set, and the live
   manifests are blocked.
2. **The interventions are not independently measured.** W1-P0 has no live
   result, and the harness has only offline guard/diagnostic evidence. Running
   B1/S now would repeat R35's behavioral floor without knowing whether the
   writer or the harness changed it.

The correct status is `Blocked`, not `Insufficient Evidence` pretending a run
occurred.

## 3. Matched comparison design (for the later run)

Use all of:

```text
caseId, runId, replicateId, arm, gitSha
```

Pair within the same replicate; then aggregate by task and family. Do not take
the first row per case and discard the other replicates.

Primary comparison:

```text
B1  real EF off
S   real EF active
```

Same case, transcript, initial workspace, task, model, provider, tool set,
budgets, hidden checker, and process requirements. The compression result may
differ; it is the object of study.

Oracle arms are attribution tools only:

```text
O1  gold deltas through the real validator/journal/working set
O2  correct facts directly visible
```

Record the O1 basis (`frozen-dataset` or `s-conditional`). Do not interpret the
two as the same intervention.

## 4. Outcomes and exclusions

Report each pair as:

```text
rescue
damage
both
neither
provider failed
budget censored
invalid measurement
incomplete pair
```

Also record per arm:

```text
fold-committed / fold-refused / safe-degraded / provider-failed
checkpoint-context / full-history-fallback
```

If both arms refuse the fold and receive the full history, the case mainly
reflects agent execution. It can count toward the full deployment policy but is
not direct evidence about compressed-context delivery.

`fullHistory()` flattens roles into text. A fold-refused fallback is therefore
not equivalent to continuing in a native DSH session. Reports must say so.

## 5. Sample size and claims

The development set has six behavioural cases (A1, B2, C1, D1, F1, H1). Even
with several replicates, this supports exploratory statements only. A
`0 rescue / 0 damage` result is not equivalence: R35's own floor effect showed
why. The report should give the pair counts and the confidence interval, and
should not convert a small-n null into "Active has no value".

Do not pool R35 r1, r2, r3 with any R36 run. R35 r2 is invalid by construction;
r1 has 18 valid rows and r3 has 24. They were produced under a different
harness and a different writer contract.

## 6. What would unblock G4

1. An explicit R36 model-spend authorization with model, route, request limit,
   input/output budgets, wall clock, per-request output bound, and approved
   scope.
2. A completed W1-P0 writer pilot with a same-time W0-P0 control.
3. An O2 harness calibration that shows at least some certified cases can reach
   contract success, with the remaining failures attributed to code, protocol,
   budget, or task feasibility.
4. A final conditions freeze after 2 and 3, and a new manifest that is no longer
   marked `blocked`.

Until then, `eval/r36/out/gate-status.json` remains the authoritative status.
