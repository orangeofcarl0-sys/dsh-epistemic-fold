# R36 — Causal Comparison

## Status

```text
G4 real B1/S/O1/O2 comparison     BLOCKED (O2 execution floor)
R36 provider requests             419 (12 writer + 407 O2 calibration)
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
provider                zcode local proxy (provider c15ab109…)
route                   http://127.0.0.1:7866/v1
```

The direct `/zen/go/v1` keys answered HTTP 401 `api_key_expired`; the authorized
runs used the local ZCode proxy, which passed the production 16,384-token bound.
The live manifests are in `eval/r36/manifests/`. The Phase B/C manifests are
marked `executed` with their run IDs; `h-native-o2` and the B1/S draft remain
`blocked`.

## 2. Why G4 is blocked

Authorization is no longer the missing condition. The execution floor is:

1. **The writer intervention is measured.** W0-P0 vs W1-P0 on six cases:
   2/6 → 6/6 parsed, commit recall 0.167 → 0.917. That is a strong pilot, not a
   causal memory result.
2. **O2 does not form a stable upper bound.** The best condition (exploratory
   16 steps + finish guard) reaches 3/6 contract success. A1 and C1 fail on code;
   B2 never runs the required test and never requests finish. A1 passes under
   H-step and fails under the combined condition, so one replicate per cell is
   also visibly noisy.

A B1/S comparison now would be dominated by those execution failures. The brief
says not to expand B1/S to accumulate more double-failure results, so the B1/S
rows remain zero. The correct status is `Blocked` by the calibration floor, not
by lack of authorization.

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

1. ~~Explicit R36 authorization and a resolved route.~~ Done: the user granted
   spend on 2026-11-05; the local proxy passed the 16,384-token probe.
2. ~~A W1-P0 writer pilot with a same-time W0-P0 control.~~ Done: 6/6 vs 2/6
   parsed; commit recall 0.917 vs 0.167.
3. **Raise the O2 floor.** The best condition reaches 3/6 contract success.
   A1/C1 need code calibration, B2 needs test-process calibration, and the
   harness needs replicates before it can be treated as stable.
4. **Then freeze a B1/S harness and run it.** The B1/S manifest must not be
   marked `blocked`, and the analysis must report rescue/damage/both/neither
   plus invalid/incomplete pairs.

Until then, `eval/r36/out/gate-status.json` remains the authoritative status.
