# 83 — Per-dimension settlement, the real output reserve, and where the gate still stands

Status: **BUDGET GATE BLOCKED — NO LIVE RUN.** 2026-10-14. Parent `84e0ea4`.

## A. The P0 defect: an unreported dimension released its reserve

`record()` settled the WHOLE reserve and then added the measurement. `mapUsage` reports 0 for an
absent field, so a provider answering `{usage: {prompt_tokens: 12000}}` freed the entire OUTPUT
reserve as if the reply had been free. The unknown dimension was not merely unmeasured; it was
declared cheap.

**Settlement is now per dimension.** The adapter reports, from the RAW wire record, which dimensions
were reliably reported; a dimension that is absent -- or present but not a sane non-negative finite
number -- keeps its conservative reserve. `partialUsageRequests` counts the requests where at least
one dimension was not settled.

| provider says | input | output |
|---|---|---|
| `{prompt_tokens: 12000}` | settles to 12,000 | **keeps 131,072 reserved** |
| `{completion_tokens: 400}` | **keeps 131,072 reserved** | settles to 400 |
| `{prompt_tokens: -1, completion_tokens: 400}` | **keeps the reserve** (a negative is not a measurement) | settles to 400 |
| nothing | keeps both reserves, counted in `unknownUsageRequests` | same |

## B. The output reserve was NOT conservative, and is now

`EF_LHTB_REPLY_MAX_TOKENS_CEILING` defaults to **131,072**, and `escalate_reply_budget()` may raise a
reply to that ceiling -- so a LEGITIMATE main-model request can use far more than the summarization's
32,768. The reserve was 32,768. **It is now 131,072**, derived from the code rather than chosen.

This is the check the brief demanded and it failed on the first pass: the old figure would have
under-charged exactly the requests the reserve exists to cover.

## C. The cost bound, re-derived with the corrected reserve

```
input  <= 7,000,000 + 131,072 = 7,131,072 x $0.30/M = $2.14
output <=   100,000 + 131,072 =   231,072 x $1.20/M = $0.28
                                                     -----
                                                     $2.42
```

Under the $3 ceiling on the non-cached Peak rate, with one request in flight at a time (so one
overshoot), **whether or not the provider reports usage**. No cache hit is required. Actual billing
remains unknown: this is a reference-usage equivalent, not an invoice.

## D. Where the gate stands

| gate | status |
|---|---|
| Adapter admission | **PASS** |
| Retry | **PASS** |
| Unknown / partial usage | **PASS** — per-dimension, and the reserve is now large enough |
| Conservative cost | **PASS** (~$2.42) |
| Summarization shares the budget | **BLOCKED** — needs the real-Bridge fixture |
| Python termination end-to-end | **BLOCKED** |
| Task Root fail-closed | **BLOCKED** |
| Watchdog | **BLOCKED** |
| Provenance | **BLOCKED** |
| Regression | **PASS** |

Four remain. None needs a provider request, and the episode was not started: **no provider request
was made this round.**
