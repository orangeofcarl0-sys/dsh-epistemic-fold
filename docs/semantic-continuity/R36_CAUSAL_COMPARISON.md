# R36 — Causal Comparison

## Status

```text
G4 real B1/S/O1/O2 comparison     PARTIAL (exploratory, 2 replicates)
R36 provider requests             845 (12 writer + 833 continuation)
R36 B1/S rows                     12 (2 replicates x 6 cases)
R36 causal claims                 exploratory only
```

This document records the matched design and the actual exploratory result. It
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
H-protocol              JSON + both DSML forms; 8 steps / 1024 / no guard
H-native                not implemented
model                   deepseek-v4.1-flash
provider                zcode local proxy (provider c15ab109…)
route                   http://127.0.0.1:7866/v1
```

The direct `/zen/go/v1` keys answered HTTP 401 `api_key_expired`; the authorized
runs used the local ZCode proxy, which passed the production 16,384-token bound.
The live manifests are in `eval/r36/manifests/`. Phase B/C manifests and the
B1/S manifest are `executed` with their run IDs; only `h-native-o2` remains
`blocked`.

## 2. What was run, and why G4 is partial

Authorization is not the issue. The harness first had to be fixed: the model
was emitting DSML tool calls that H0 did not parse. After H-protocol (JSON +
DSML, including the short direct-attribute form), O2 reached **5/6 contract
success**; only D1 fails because the agent never writes `verification.json`.

That floor was sufficient to run the planned B1/S comparison: 6 cases, 2
replicates, H-protocol (8 steps / 1024 / no guard), one model and route. The
result is mixed, not a stable superiority or equivalence:

| outcome (contract) | pairs |
|---|---:|
| rescue | 1 |
| damage | 3 |
| both | 4 |
| neither | 4 |
| invalid | 0 |
| **total** | **12** |

Task-level: 1 rescue, 2 damage, 5 both, 4 neither.

By replicate:

```text
r1: 0 rescue, 2 damage, 2 both, 2 neither
r2: 1 rescue, 1 damage, 2 both, 2 neither
```

By case (contract):

```text
A1: 1 damage, 1 neither
B2: 2 damage
C1: 1 rescue, 1 neither
D1: 2 neither
F1: 2 both
H1: 2 both
```

The damage is not a clean memory-loss signal:

- **A1:** the S checkpoint contains the compatibility constraint, but the agent
  kept the old string return shape while the hidden checker requires
  `retries: 2` on both forms. The task text does not state that requirement;
  this is a task/gold ambiguity, not missing memory.
- **B2:** the S checkpoint contains the in-memory decision, but the S agent
  wrote a broken module in r1 and skipped tests in r2. B1 passed both times.
  This is the most interesting damage signal (2/2), but it is code/process, not
  a missing fact.
- **C1:** r1's S fold was refused, so the agent ran on full history and failed;
  r2's S fold committed and the agent reached contract success while B1 failed.
  The rescue depends on fold quality, not a uniform Active advantage.
- **D1:** both arms fail on the missing `verification.json`; no memory
  difference.
- **F1/H1:** both arms succeed; ceiling, no discrimination.

`eval/r36/out/causal-comparison.json` carries the per-pair rows and failed
checks. This is exploratory evidence, not a product-level causal claim.

The oracle arms were also not stable in the causal batch: O1 4/6 contract,
O2 1/6 (despite O2 reaching 5/6 in the isolated H-protocol calibration). That
order/run variance is another reason not to over-read the pair counts.

## 3. Matched comparison design used

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

## 6. What would upgrade G4 from partial to passed

1. ~~Authorization and a resolved route.~~ Done: the user granted spend on
   2026-11-05; the local proxy passed the 16,384-token probe.
2. ~~A W1-P0 writer pilot with a same-time W0-P0 control.~~ Done: 6/6 vs 2/6
   parsed; commit recall 0.917 vs 0.167.
3. ~~Raise the O2 floor.~~ Done: H-protocol reaches 5/6 contract success.
4. ~~Run the B1/S comparison.~~ Done: 12 pairs, 2 replicates, 1 rescue / 3
   damage / 4 both / 4 neither.
5. **Resolve the A1 task/gold ambiguity.** The hidden checker requires
   `retries: 2` on the string form; the task text does not state it. Until this
   is clarified, A1's damage is not a memory result.
6. **Fix the D1 verification artifact process.** The agent never writes
   `verification.json`; both arms fail for that reason.
7. **Replicate B2 and C1.** B2 damage is 2/2; C1 rescue is 1/2. Both need more
   runs before they are more than anecdotes.
8. **Implement H-native and increase the replicate count.** The current
   comparison is one model, one route, two replicates.

Until then, `eval/r36/out/gate-status.json` remains the authoritative status.
