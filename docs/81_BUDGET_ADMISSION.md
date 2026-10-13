# 81 — Budget admission, verified dynamically; the pilot still did not start

Status: **BUDGET GATE BLOCKED — NO LIVE RUN.** 2026-10-14. Parent `81ec0bf`.

## 1. Audit answers, from the code

1. **`admit()` checks consumed budget, and the REQUEST check is strict.** It compares
   `requests >= limit` BEFORE incrementing, so `requests=1` admits exactly one. The TOKEN checks are
   *observed-consumption* limits: they compare what past responses reported, not what this request
   might cost.
2. **The request counter increments inside `admit()`**, which runs immediately before `fetchImpl`.
3. **Every 429 retry admits again**, because `admit()` is inside `requestWithRetry`'s loop.
4. **`record()`** adds DSH's disjoint counters (`inputTokens` + `cacheReadTokens` + `cacheWriteTokens`
   + `outputTokens`); with usage absent it charges the caller's conservative fallback; it is never
   called for a failed or cancelled request, which reports no usage.
5. **One budget per episode covers everything**, because it lives on the adapter and the task call,
   the summarization and the retries all pass through it.
6. **No bypass exists inside the adapter.** `scripts/check-route.mjs` is a separate preflight that
   does NOT go through the adapter, so its requests are outside the count — reported, not hidden.
7. **`budget-exhausted` keeps its identity** across the layers: adapter failure code
   `BUDGET_EXHAUSTED` -> bridge finish reason `budget-exhausted` -> `telemetry.lastFinishReason` ->
   agent termination. It is never an `error:`, so `providerFailures` does not move.
8. **`WALL_MS` is an ADMISSION check only.** There is no independent deadline on an in-flight
   request beyond the adapter's own `REQUEST_TIMEOUT_MS`. The external watchdog is therefore
   load-bearing, not decorative.

## 2. Two real defects the tests found

**The token caps were inert.** `record()` read `usage.promptTokens`, but `mapUsage` returns DSH's
disjoint counters — `inputTokens` (which EXCLUDES cached input), `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens` — and has no `promptTokens` at all. Every token limit silently recorded zero.
The admission test that expected 100 tokens and got 0 is what caught it. The prompt side is now the
SUM of its parts, deliberately: `inputTokens` alone would omit the cached re-reads that are the bulk
of a long episode's prompt traffic, and they must not be free merely because they are cheap.

**A set-but-invalid limit silently DISABLED the check.** `Number('')` is 0, `Number('abc')` is NaN,
and a negative number is itself; `admit()` tests `limit > 0`, so all three switched the budget off.
An experiment whose budget a stray space disabled would spend against a limit nobody could see.
`parseBudgetLimit` now treats UNSET as disabled (an ordinary lane keeps the old behaviour) and SET
BUT INVALID as an error, and `EF_LHTB_BUDGET_REQUIRED=1` refuses to start a run that asked for
enforcement and did not get all of it.

## 3. What the tests measured

`tests/live-budget-admission.spec.ts` (7, all passing) drives the REAL adapter against a counting
fake fetch. The count is the evidence.

| | measured |
|---|---|
| `requests=1`, two calls | fetch called **exactly once**; the second returns `BUDGET_EXHAUSTED` |
| `requests=1`, first attempt 429 | fetch called **once**; the retry is refused, and the failure is `BUDGET_EXHAUSTED`, **never** the 429 |
| `requests=2`, 429 then 200 | fetch called **twice**; succeeds; snapshot `requests=2` |
| `promptTokens=100`, response reports 100 | next request refused; fetch stays at 1 |
| 200 with NO usage | attempt counted; tokens charged the **conservative window**, not zero; request cap still holds |
| unset / empty / `abc` / `-5` / `1.5` | unset disables; the other four **throw** |

## 4. The $3 bound, now provable

Limits: 140 requests, 7,000,000 prompt, 100,000 output, 90 min. At the Peak non-cached reference
rate the brief supplies ($0.30/M in, $1.20/M out):

```
7.000M prompt x $0.30/M = $2.10
0.100M output x $1.20/M = $0.12
                          -----
                          $2.22
```

**One request may overshoot**, because the token checks are observed-consumption: the last admitted
request can add at most one window (131,072) and one reply budget. That is +$0.04, so ~$2.26. **Under
$3.** And with usage missing the fallback charges a full window per unmeasured response, so the
token cap still binds rather than lapsing. The bound holds on the un-cached rate, so it does not
depend on a cache hit.

**Actual billing remains unknown**: this is a reference-usage equivalent, not an invoice, and no
account-side debit record exists.

## 5. Gate decision — conditions NOT met

| # | condition | status |
|---|---|---|
| 1 | keyless request-count tests | **PASS** (7 tests) |
| 2 | 429 retry shares the budget | **PASS** — summarization sharing it: **BLOCKED**, needs the bridge fixture |
| 3 | token semantics clear, conservative bound | **PASS** |
| 4 | $3 upper bound | **PASS** (~$2.26) |
| 5 | 90-minute external watchdog tested | **BLOCKED** |
| 6 | Python termination on budget exhaustion | **BLOCKED** (implemented, not executed) |
| 7 | TaskRoot / Pruner / Window / Threshold in force | **BLOCKED** (not verified for this run) |
| 8 | provenance frozen | **BLOCKED** |
| 9 | no new failures | **PASS** |

Per the brief, any unmet condition stops the round at the keyless stage. Four are unmet, so the
episode was **not** started and **no provider request was made**.

## 6. Remaining work, in order

1. a bridge fixture for summarization: a fold whose summary consumes the last request, after which
   the next task call must be refused, with no partial bundle and no phantom turn;
2. the same fixture carried through to Python, asserting the termination is `budget-exhausted` and
   not a provider failure, an empty reply, or `model-reported-completion`;
3. a keyless long-hang fixture proving the external watchdog kills a real `_bridge.step()`;
4. provenance freeze (EF/LHTB/DSH revisions, dirty files, effective YAML hash, route, pruner,
   window 131072, threshold 65536, `taskRootMode=exact`);
5. the single episode, with 140 requests / 90 minutes / $3 armed via `EF_LHTB_BUDGET_REQUIRED=1`.
