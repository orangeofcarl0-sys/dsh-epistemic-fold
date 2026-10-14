# 88 — Gate C: exact mode no longer degrades silently into Unpinned

Status: **P1 HOST GATES BLOCKED — NO LIVE RUN** (Gates D and E remain). 2026-10-15. Parent `9934390`.

## A. What the guard already covered, and what it did not

`src/engine.ts:907-931` `protectedRootGuard` is already fail-closed for the ROOT fold path: a
registered root whose source has gone missing returns `refused` with a specific reason
(`source-not-on-surface`, `not-a-user-message`, `digest-mismatch`), never a silent downgrade.

The gap is one level up. `ref === undefined` returns `{status: 'none'}` -- and **the engine cannot
tell "this arm runs `exact` and the host never registered" from "this arm runs `off`"**. Both are
an empty registry. So a host that forgot to flag the instruction would silently lose the protection
the arm was configured to provide, while telemetry still reported `exact`.

The MODE lives in the host, so the fail-closed check for that case belongs in the host.

## B. The fix

`eval/tau2/bridge-host.ts` refuses a model call when `taskRootMode === 'exact'`, the engine is EF,
and `taskRootStatus` is not `resident`. It is checked **before `drainIdleRebase()`**, so the refusal
precedes any fold or rebase that could commit against an unverified task state -- not merely the
provider call that follows. The finish reason is `task-root-contract`, its own identity: not an
`error:`, so `providerFailures` does not move.

`ef_lhtb_agent.py` terminates on it, beside the budget stop, for the same reason: retrying cannot
restore a protection the host never established, and continuing would fold an unverified task under
an arm that claims `exact`.

## C. Measured, through the real bridge

```
taskRootMode exact, instruction appended WITHOUT the flag
  provider.calls()   unchanged        no request left
  lastFinishReason   task-root-contract
  providerFailures   0
  folds              0                nothing folded against the unverified state
  taskRoot           {status: absent, reason: 'contract failure before the model call: unregistered'}

taskRootMode off, same setup
  provider.calls()   +1               the call went out, as before
  lastFinishReason   not task-root-contract
  taskRoot           undefined        nothing was declared, so nothing is reported
```

`off` is a legal configuration and is not blocked; that is asserted, not assumed.

## D. Scenarios B and C are not constructible through legal operations

The brief asks for a registered root that is no longer resident, and a digest/identity failure.
**Neither can be produced with supported Session operations** -- which is the protection working:
the root is excluded from every fold span, so nothing legal removes it from the surface, and the
source event is immutable, so nothing legal changes its digest. Manufacturing either would require
mutating an immutable event, and a test built that way would prove something about the test.

What IS verified for those cases is the code path itself: `protectedRootGuard` returns `refused`
with a distinct reason for each, and `docs/71`'s keyless suite exercises `unsupported-nonprefix` and
`digest-mismatch` refusals against the engine directly. The bridge-level, pre-fetch refusal for a
**missing** registration is what this round adds.

## E. Gates D and E remain BLOCKED

The external watchdog and the out-of-order/concurrent conservation cases were not executed. They are
reported as BLOCKED, not inferred.
