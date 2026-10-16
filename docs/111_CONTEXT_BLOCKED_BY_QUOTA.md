# 111 — Real context length: NOT measured, blocked by quota. A lower bound IS measured

Status: **blocked on quota; lower bound measured.** 2026-10-16. Parent `c302ec8`.

## A. The measurement could not be made

```
auth anonymous  -> 429 {"type":"error","error":{"type":"FreeUsageLimitError",
                        "message":"Rate limit exceeded. Please try again later."}}
auth store key  -> 429 FreeUsageLimitError (identical)
```

**Both authentication modes are refused.** The plugin's own README warns why: *"Anonymous quota is
shared by callers behind the same egress IP."* Today's session made many requests through this IP, and
the bucket is empty.

**No ladder could run, so no context figure is offered.** The Zen catalogue publishes no metadata
either (every entry carries only `id`, `object`, `created`, `owned_by`), so there is no declared number
to fall back on. **A figure here would be invented.**

## B. What IS measured: a lower bound

The free-model lane run completed eleven real calls before the quota ran out:

```
jobdir  lhtb-ef-20261016-143654-probe-economy
calls 11   folds 0   shells 11   promptTokensLast 19,350
observed 72,673 prompt / 3,433 output        <- real usage, not reserved
taskRoot resident, sourceSeq 2, digestVerified
```

**`promptTokensLast = 19,350` means a real request carrying 19,350 prompt tokens was ACCEPTED.**
That is a measured LOWER bound on the usable context, and it is not the context length. It is the
largest prompt this model is known to have accepted here, which is a different statement.

## C. The invocation fix is confirmed by the same run

```
observed 72,673 prompt / 3,433 output over 11 calls, then 4x 429 FreeUsageLimitError
```

**Eleven calls succeeded where every previous attempt had 17 failures and zero shells.** The three
gates are solved; what ended this run is quota, not admission.

## D. Why the budget then ran out

```
requests 23, charged prompt 2,300,897 / output 560,489
reserved prompt 2,228,224 / output 557,056        <- SEVENTEEN standing reservations
refusals 1
```

The 429s are quota refusals, and `docs/108`'s release fix deliberately does NOT apply to them: a 429
means the request WAS sent and refused, so its cost is unknown and the reserve must stand. That is the
documented policy and it is behaving as written. **Quota exhaustion is not a pre-send failure.**

## E. What would unblock the measurement

1. wait for the per-IP anonymous bucket to refill, then run the ladder unchanged;
2. or use a Zen key whose own quota is not exhausted -- the store key produced the SAME 429, so it is
   either the same bucket or itself empty;
3. the ladder itself is written and ready (`ef-phase7-logs/.ladder3.mjs`), ascending 8K -> 1M with the
   exact working request shape, reporting the ACTUAL `prompt_tokens` from each response so the
   boundary is read rather than estimated.
