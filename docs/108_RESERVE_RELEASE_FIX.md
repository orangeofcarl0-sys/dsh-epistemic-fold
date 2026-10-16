# 108 — Fixed: a request that never left the machine was charged for a reply it could not send

Status: **fixed and verified.** 2026-10-16. Parent `1e41787`.

## A. The problem, located

`telemetry.lastProviderError = "fetch failed"` on all ten failures, with `summarizationAttempts 0`
and `compactionFailures 0` -- so they were **transport failures**, not model or budget events. Each
held a 32,768-token output reservation, and ten of them consumed **327,680 of 556,846 charged
output, 59% of the budget**, ending the run at 61% of the fold threshold.

A reservation is held because a failed request's cost is UNKNOWN. That is right for a request that
may have been processed. **It is wrong for one that provably was not**: DNS failure, connection
refused, or a connect timeout mean the provider was never reached, so the true consumption is zero.
Holding a full `max_tokens` reserve there is not conservatism -- it is accounting for spend that
cannot exist.

## B. Why the reply-max fix looked inert

`ef_lhtb_agent.py:417-431` doubles the reply budget on truncation:

```python
current = reply_budget if reply_budget is not None else REPLY_MAX_TOKENS
return min(current * 2, max(REPLY_MAX_TOKENS_CEILING, REPLY_MAX_TOKENS))
```

**16,384 x 2 = 32,768.** The change DID apply; the failing calls were escalated ones, so the reserve
was the doubled value. `docs/107` reported this as unexplained between two candidates, and this is
which one it was.

## C. Two bugs, and the second was mine

**1. The credential did not survive the throw.** `stream()` receives the reservation only on the
success path, so an error leaving `requestWithRetry` took the credential with it and the reserve could
never be settled. Fixed by riding it out on the error object.

**2. `settle()` does not give budget back.** It removes the entry from `outstanding` but leaves
`reservedPrompt`/`reservedOutput` inflated, because only `record()` adjusts those. **The first
version of this fix called `settle` and released nothing** -- measured, the snapshot still showed
4,096 reserved. A `release()` that does both is now the only correct way to hand budget back.

## D. Verified

```
failure code = LIVE_TRANSPORT
snapshot = {requests: 1,                     <- the attempt is STILL COUNTED
            promptTokens: 0, outputTokens: 0,
            reservedPromptTokens: 0, reservedOutputTokens: 0}
```

`tests/live-budget-admission.spec.ts` is **19/19** (was 17), including:

* a pre-send failure (`ENOTFOUND`) releases both dimensions while still counting the attempt;
* `ECONNRESET` **keeps** its reserve -- a socket was open, so the request could have been processed
  and billed, and releasing there would understate spend.

The set is deliberately narrow: `ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`,
`ERR_INVALID_URL`, `ENETUNREACH`, `EHOSTUNREACH`. `ECONNRESET` and `UND_ERR_SOCKET` are excluded on
purpose.

## E. What this does NOT do

* it does not retry transport failures -- they remain provider failures;
* it does not release a reserve for a failure that may have been processed;
* it does not change `admit`'s refusal policy or any limit.

## F. Expected effect on the next run

On the 2026-10-16 numbers, ten `fetch failed` requests held 327,680. **If they were pre-send failures
that becomes 0**, and the same run would have had the headroom to continue past 61% toward the fold.
**If they were mid-flight failures it changes nothing**, and the next run will say which -- the error
detail is now preserved in `lastProviderError` rather than flattened to `fetch failed`.
