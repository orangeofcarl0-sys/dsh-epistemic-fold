# R37-C — Bounded Process-Causal Pilot

## 1. Status

```text
authorization   R37-C brief plus the prior explicit live authorization
gate            R37C_LIVE=1 required
design          2 cases x 2 arms x 2 guards x 3 replicates = 24 cells
execution       see section 5; this file is updated from the run artifact
confirmatory    no
```

## 2. Question

R37-B's contract damage was mostly process/implementation: no test run, or
broken code. The pilot asks whether a **finish guard** — the one intervention
that rejects a finish request without a fresh passing test — changes contract
or task success under B1 and under S.

It does not ask whether EF is beneficial. It does not add a semantic component.

## 3. Design

Fixed:

```text
model              deepseek-v4.1-flash
route              local omnigate2api
protocol           P3s strict DSML
harness            H-protocol-s, 8 steps, 1024 output/turn
cases              B2, D1-v2
arms               B1, S
workspace reset    per cell
scorer             frozen R33 v3
```

Intervention:

```text
G0  finish guard disabled
G1  finish guard enabled
```

The guard only fires when the agent requests `finish`. It:

```text
rejects a finish without a fresh passing test on the current source
returns a message telling the agent to run the tests
never runs a test itself
never edits code
never writes verification.json
never extends the step or output budget
```

A cell that exhausts eight steps without requesting finish is a step-limit
outcome, not a guard success. A cell that never runs a test is a
test-not-requested outcome, not a guard failure.

## 4. Budget

Global hard caps, enforced on observed usage after every cell:

```text
HTTP attempts    <= 240
input tokens     <= 300,000
output tokens    <= 70,000
wall clock       <= 3,600,000 ms
```

Per-cell ledger: the adapter reserves the declared 131,072-token context
window per HTTP attempt, so a full 8-step cell needs admission headroom that
is larger than its observed input. The per-cell ledger therefore carries
`inputTokens: 1,100,000`, `outputTokens: 20,000`, and `requests: 36`; the
global caps above are checked on the **observed** counters, and the next cell
is refused once a cap is reached. This distinction is recorded in the result.

Transport retry: at most one retry per cell, only for a provider/transport
failure. Fold refusals are not retried.

Stop rules:

```text
global cap reached
three consecutive provider-invalid cells
preflight infeasible
```

## 5. Results

Executed 24/24 cells, no stop rule triggered.

```text
status            complete
HTTP attempts     187 / 240
input tokens      226,808 / 300,000
output tokens     29,980 / 70,000
wall clock        504,096 ms / 3,600,000 ms
outcomes          22 valid-task-success, 2 valid-task-failure
```

| arm | guard | cells | contract | task | tests run | finish requests / rejections | guard-assisted |
|---|---|---:|---:|---:|---:|---:|---:|
| B1 | G0 | 6 | 5/6 | 6/6 | 7 | 4 / 0 | 0 |
| B1 | G1 | 6 | 4/6 | 5/6 | 8 | 3 / 2 | 1 |
| S | G0 | 6 | 6/6 | 6/6 | 7 | 4 / 0 | 0 |
| S | G1 | 6 | 4/6 | 5/6 | 6 | 3 / 2 | 0 |

Effects (percentage points):

```text
guard under B1      contract -16.7, task -16.7
guard under S       contract -33.3, task -16.7
Active under G0     contract +16.7, task  0.0
Active under G1     contract   0.0, task  0.0
interaction         contract -16.7, task  0.0  (exploratory)
```

Paired B1/S outcomes:

```text
G0   contract: 1 rescue, 0 damage, 5 ties
G1   contract: 1 rescue, 1 damage, 4 ties
```

Assigned delivery:

```text
B1/G0   ef-off-basic-context 6
S/G0    semantic-committed 6
S/G1    semantic-committed 4, semantic-committed-empty 1, full-history-fallback 1
```

The guard fired only when the agent requested finish. It rejected 2 finishes
under B1 and 2 under S. It assisted one B1 completion and zero S completions.
Several no-test cells exhausted the eight-step limit without requesting finish;
the guard cannot help those cells by construction.

## 6. Analysis

The pilot does **not** show a guard benefit. In this small sample the guard is
associated with lower contract success under both arms, and the S/G1 arm has
two delivery confounds (one empty commit, one full-history fallback) that are
not present in S/G0.

The correct reading is:

```text
Guard effect: not beneficial in this pilot
Guard mechanism: rejects premature finish, but does not create a test run
Process harm: still present without the guard
Active effect: not established
Product decision: unchanged deployment hold
```

The pilot is not powered for significance. The interaction is exploratory and
must not be reported as a product-level finding.

## 7. What would change the next round

- If the guard reduces no-test finishes without weakening the contract, run a
  larger guard-only replication before changing the product arm.
- If the guard does nothing because the agent never requests finish, the
  process problem is step-limit/test-request behavior, not premature finish.
- If the guard helps only S, that is an interaction hypothesis, not a product
  result.
- If the guard harms B1, do not bundle it into the product arm.

## 8. What this pilot cannot answer

- Whether the R37-B harm replicates on another model or route.
- Whether a process prompt, more steps, or a higher output budget would help.
- Whether the guard is safe in production.
- Whether EF Active has a benefit.
