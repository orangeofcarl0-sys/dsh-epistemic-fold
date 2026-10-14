# 87 — Gate B PASSES, and the defect that was blocking it

Status: **P1 HOST GATES BLOCKED — NO LIVE RUN** (Gates C and D remain). 2026-10-14. Parent `9e400dd`.

## A. The hang was a real defect, and it is fixed

`docs/86` reported the Gate B run hanging with two candidate causes and refused to pick one. The
run eventually finished (exit 0) and its output settled the question:

```
providerCalls 1        budgetRequests 1        budgetRefusals 125
turns 126              providerFailures 125    termination null
lastTurn {turn 2, anomaly: "provider failure", error: "episode budget exhausted"}
```

**Cause 1, confirmed.** The gate correctly stopped the traffic -- `providerCalls` stayed at 1 -- but
the agent classified the refusal as a PROVIDER FAILURE and retried: 126 turns, 125 recorded provider
failures, and **no termination recorded at all**. It was not a hang in the transport; it was an
unbounded retry loop against a gate that refused every request, exactly the failure mode the brief
named in advance.

The mechanism: the bridge reports a budget stop with its own finish reason AND an `error` string, and
`ef_lhtb_agent.py`'s provider-failure branch (`error = reply.get("error")`) caught it first. The
terminal check added earlier sat LATER in the loop and was therefore unreachable for this path.

**Fix**: the budget check now runs BEFORE the classification. Retrying is the one response that
cannot help -- the budget that refused will refuse again, and each retry burns wall clock.

| | before | after |
|---|---|---|
| `budgetRefusals` | 125 | **1** |
| `turns` | 126 | **1** |
| `providerFailures` | 125 | **0** |
| `termination` | `null` | **`budget-exhausted`** |
| `providerCalls` | 1 | 1 |

## B. Gate B: PASS

`tests/python-budget-termination.py` + `tests/python-budget-termination.spec.ts` (4) drive the
production `EFLhtbAgent.run()` against a real Node bridge, a real gate (`REQUIRED=1`, `REQUESTS=1`)
and a local fake provider. Measured:

```
providerCalls        1                    exactly the one request allowed
termination          budget-exhausted
providerFailures     0                    a spent budget is not infrastructure
budgetRequests       1     refusals 1
turns                1                    no retry storm
lastTurn             {turn 1, tool: run_shell}   a REAL tool turn, no fabricated assistant
taskRoot             resident, sourceSeq 2, digestVerified, position 0
bridgeClosed true    bridgeReaped true
```

A fixture defect found on the way: `StubContext.metadata` was a CLASS attribute while the agent
assigns to the INSTANCE, so every reading of the metadata was the empty class dict. That is why
earlier runs printed `termination: null` -- the fixture, not the product.

## C. Gates C and D remain BLOCKED

Task Root fail-closed and the external watchdog were still not executed, and the reverse-order
aggregate-conservation case was not added. They are reported as BLOCKED, not as inferred.

## D. Unchanged PASSes

Economy zero-auxiliary (`semanticMode: 'none'`); PREPARED provenance, still explicitly not a live
record; aggregated budget safety from `docs/85`. **Per-request settlement ATTRIBUTION remains
NOT established** -- the FIFO settles *some* reservation per response, not *that* response's.
