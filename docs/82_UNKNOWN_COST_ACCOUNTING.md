# 82 — Unknown-cost requests are charged; the $3 bound now holds either way

Status: **BUDGET GATE BLOCKED — NO LIVE RUN.** 2026-10-14. Parent `8682fa7`.

## A. The defect found

`record()` ran only on the success path — after a 200 whose JSON parsed. Every other ending
charged **nothing**, while the provider may have processed and billed the request:

| ending | before |
|---|---|
| 200, full usage | measured |
| 200, no usage | conservative window (fallback) |
| 200, PARTIAL usage | **under-charged**: `mapUsage` fills absent fields with 0, so the object
  exists and the fallback never applied |
| 429, retries exhausted | **0** |
| 5xx | **0** |
| transport error | **0** |
| body unparseable | **0** |
| aborted by `AbortSignal` | **0** |

The `requests` counter still moved (it increments in `admit`), so the REQUEST cap held — but the
token caps were systematically optimistic, and a run that failed a third of its calls would have
been accounted as if it had not.

## B. The fix, and why it is one change rather than eight

**The reserve is charged at ADMISSION, not on success.** `admit()` adds a conservative per-request
reserve (a full context window plus `DEFAULT_OUTPUT_RESERVE`, 32,768); `record()` SETTLES that
reserve into the measurement rather than adding to it. A request that never reaches `record` keeps
its reserve.

So all eight endings above are covered **without touching a single failure path**, because the
charge happens before the request rather than after its outcome. `partial` is judged by the CALLER
from the raw wire record, since the mapped object cannot distinguish "reported zero" from "never
reported".

The reserve is **never presented as a measurement**. `snapshot()` publishes `observed*` (provider-
reported), `reserved*` (conservative, for requests whose true cost is unknown), `unknownUsageRequests`
and `partialUsageRequests` separately, and `promptTokens`/`outputTokens` are the CHARGED totals that
admission compares — explicitly documented as measured plus reserved.

**The output reserve is deliberately NOT the main model's reply budget**: the fold's summarization is
a different call site with its own `maxTokens`, so reserving the smaller of the two would
under-charge exactly the requests the reserve exists for.

## C. The conservative cost bound, re-derived

Admission now compares **charged** totals, so the token caps bind on conservative amounts:

```
charged prompt  <= 7,000,000 + one reserve (131,072)  = 7,131,072  x $0.30/M = $2.14
charged output  <=   100,000 + one reserve  (32,768)  =   132,768  x $1.20/M = $0.16
                                                                            -----
                                                                            $2.30
```

Under $3 **on the non-cached Peak rate, whether or not the provider reports usage** — which is the
property the earlier $2.26 did not have, because it silently assumed every request was measured.
No cache hit is required. Actual billing remains unknown: this is a reference-usage equivalent, not
an invoice.

## D. What is still BLOCKED

| gate | status |
|---|---|
| Request Admission | PASS |
| 429 Retry | PASS |
| TokenUsage accounting | PASS |
| Unknown Usage | **PASS** — reserved at admission, split published |
| Conservative Cost | **PASS** (~$2.30) |
| Summarization shares the budget | **BLOCKED** — needs the real-Bridge fixture |
| Python Termination end-to-end | **BLOCKED** |
| Task Root fail-closed | **BLOCKED** |
| Watchdog actually triggers | **BLOCKED** |
| Provenance freezable | **BLOCKED** |
| Regression | PASS |

Four remain, and none needs a provider request. The episode was **not** started; **no provider
request was made**.
