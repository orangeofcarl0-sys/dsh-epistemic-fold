# 86 — The three runtime gates: one reproduced hang, two not reached

Status: **P1 HOST GATES BLOCKED — NO LIVE RUN.** 2026-10-14. Parent `e501795`.

## A. Gate B is BLOCKED by a reproduced hang, not by a missing test

`tests/fixtures/python-budget-termination.py` drives the PRODUCTION `EFLhtbAgent.run()` against a
real Node bridge, a real budget gate armed with `EF_LHTB_BUDGET_REQUIRED=1` and `REQUESTS=1`, and a
local fake provider. Measured:

* the first invocation hit the tool's 600 s deadline with **no output at all**;
* with an in-process `asyncio.wait_for(..., 25)` added, the fixture **still produced nothing** -- the
  watchdog did not fire.

That second fact is the informative one. `asyncio.wait_for` cannot fire while the event loop is
blocked, and this client speaks over SYNCHRONOUS pipes: a `_bridge.step()` that never returns parks
the loop, and so does a `time.sleep` in the agent's own backoff. **A process-internal watchdog
cannot bound this path, which is precisely why Gate D's external one is load-bearing rather than
decorative.**

Two candidate causes, and I did not establish which:

1. the budget refusal is not reaching the agent's terminal branch and instead enters the
   provider-failure path -- `time.sleep` with backoff, retrying against a gate that refuses every
   request, up to `MAX_WASTED_ATTEMPTS` (1200). The brief names this exact risk: a budget stop being
   swallowed and retried without bound;
2. the bridge did not answer `init` at all, leaving the client in the 1200 s read timeout.

Cause 1 is the more likely: the same env is armed in `tests/task-root-bridge.spec.ts` and `init`
answers there, so the bridge is not the part that changed. **Not confirmed, and not claimed as
confirmed.**

## B. Gates C and D: not reached

Neither the Task Root fail-closed checks nor the external watchdog were executed. No Fake Fetch
count, no pre-fetch refusal, no process reclamation and no `watchdog-censored` record exist for this
round. Reporting them as anything but BLOCKED would be fabrication.

## C. Aggregate conservation: not measured

The out-of-order/failed-request conservation case was not added. `docs/85`'s FIFO change is argued
for the aggregate and tested for two requests settling in order; the reverse order and the
never-recorded case remain **unmeasured**.

## D. What IS established this round

* **Aggregated budget safety**: unchanged from `docs/85` -- reserves are charged before the fetch,
  settlement is per dimension, a FIFO keeps `reserved == (admitted - recorded) x reserve`.
* **Per-request settlement ATTRIBUTION is NOT established** and must not be claimed: the FIFO
  settles *some* reservation per response, not *that* response's. The aggregate is conservative; the
  attribution is not tracked.
* **Economy zero-auxiliary**: PASS, unchanged (`semanticMode: 'none'`).
* **PREPARED provenance**: still readable, unchanged, and still explicitly not a live record.

## E. The next step is a diagnosis, not more gates

The hang is the blocker. It needs the bridge's own stderr for the refused step and the agent's loop
position, which the fixture discards -- the same mistake `docs/74` records for the 400. Reproduce it
with the bridge's stderr captured, and read `lastFinishReason` and the agent's streak counters at the
point of the hang.
