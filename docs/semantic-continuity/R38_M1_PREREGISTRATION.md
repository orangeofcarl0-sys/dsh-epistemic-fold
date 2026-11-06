# R38-M1 — Preregistration (not executed)

## 1. Status

```text
status        specified, not authorized
live calls    0
purpose       a bounded behavioral comparison of task-aware delivery
```

R38-M0 is offline. This document specifies the smallest live experiment that
could test whether the R38 mechanisms change model behavior. It is not a
promise to run, and it does not reuse the R37-D authorization.

## 2. Arms

```text
B1  EF Off (the product control)
S0  EF Active, current working set
S1  EF Active + task-aware selection
S2  S1 + bounded archive recovery
```

The integrity auditor is a READ-ONLY measurement in every arm. It is not a
treatment and must not be bundled into S1/S2.

## 3. Model and route

```text
model       deepseek-v4.1-flash
provider    the R37-D route (R37D_BASE_URL / R37D_API_KEY, resolved by
            eval/live/dist/zcode-config.js)
harness     native DSH AgentLoop + the production EF engine
protocol    the strict P3s parser for the custom loop, or the native tool
            protocol where the native harness is used
```

No credential is stored in the manifest, the results, or the repository.

## 4. Cases

Frozen, certified cases only:

```text
H1-v2    production region (archive-only critical fact)
S1-v1    authority scope (staging vs production)
N5       cross-coordinate revision
B2       in-memory queue / rejected outbox
B2-v2    implementation-sensitive scheduler variant
D1-v2    verification artifact delivery
```

Each case must carry: gold, reference pass, counterfactual fail, no gold
leakage, independent source refs. A case that cannot certify is excluded before
the run, not after.

## 5. Context snapshots

```text
fixed checkpoint per case/arm, frozen before the run
task frame per case, frozen before the run
semantic state revision recorded
archive revision recorded
```

The frame is derived from the request and workspace, never from the case gold.

## 6. Versions

```text
SEMANTIC_SCHEMA_VERSION      4
retirement module            R38-M0 (insufficient-authority, cross-scope)
operational scorer           R37-D v3
DSH                         0.2.1-rc.3
EF commit                   the R38-M0 handoff commit
```

## 7. Budgets and caps

```text
step budget            8 (the R37-D value)
follow-up output       1,024 tokens
context reserve        131,072 tokens per attempt
HTTP attempt cap       240
input token cap        300,000
output token cap       70,000
wall clock cap         3,600,000 ms
```

The per-cell admission ledger reserves the context window before an attempt;
the global caps are enforced on observed usage after each cell.

## 8. Design

```text
2 stages:
  calibration   2 cases x 2 arms (B1, S1) x 2 replicates = 8 cells
  main          6 cases x 4 arms x 3 replicates = 72 cells
```

The calibration stage is a solvability and native-tool check, not a hypothesis
test. It must not be extended into the main stage by adding replicates after
seeing results.

Randomization: within each case, the arm order is randomized per replicate;
the process condition (if any) is held constant.

## 9. Analysis

```text
primary     operational completion, paired by case/replicate
secondary   critical-fact visibility, verification completeness, strict finish
test        exact McNemar for paired binary outcomes
interval    case-clustered bootstrap, descriptive only
robustness  leave-one-case-out
```

No significance threshold is redefined after seeing the data. A
case-clustered bootstrap is not a high-precision population interval.

## 10. Stopping rules

- Stop on a provider failure or a scorer failure; do not retry silently.
- Stop when a global cap is reached.
- No optional stopping: the planned cell count is fixed before the first call.
- No arm or case is added after seeing a result.
- A failed cell stays in the assigned-arm denominator (ITT).

## 11. Authorization

The run requires:

```text
a frozen manifest (cells, model, route, caps)
a manifest SHA-256
an explicit authorization naming that SHA and the cell count
a preflight that verifies the manifest, the route and the runner
```

Without all four, the batch stays `ready-for-authorization`. The R37-D
authorization covers only the executed 24-cell process pilot and does not
extend to this experiment.

## 12. Decision rule

```text
deployment hold is lifted only if
  S1 or S2 beats S0 on operational completion
  AND the safety blockers stay at zero
  AND the effect survives leave-one-case-out
  AND a second independent batch agrees
```

A single small batch is mechanism evidence, not a product result.
