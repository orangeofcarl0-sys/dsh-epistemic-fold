# 80 — Budget gate for P1: built, NOT proven; the pilot did not start

Status: **BUDGET GATE BLOCKED — NO LIVE RUN.** 2026-10-14. Parent `be5985b`.

## 1. Why a turn cap is not a request cap

`EF_LHTB_MAX_TURNS` bounds the AGENT's turns. It does not bound provider requests:

* the fold's summarization goes through the same adapter and is invisible to the agent;
* `OpenAiCompatibleAdapter` retries a 429 up to three times (`MAX_RATE_LIMIT_RETRIES = 3`), and
  every retry is a real request;
* so `MAX_TURNS=140` can mean well over 140 requests.

Before this round there was **no pre-request admission gate anywhere**, so the authorized budget
($3 usage-equivalent, 140 requests, 7M prompt tokens) could not have been enforced. Starting the
pilot would have meant spending against a limit nobody could check.

## 2. What was built

`eval/live/request-budget.ts` — `RequestBudget.admit()` / `.record()` / `.snapshot()`, and
`BudgetExhaustedError` with `code = 'BUDGET_EXHAUSTED'`. Two properties are deliberate:

* **the check is BEFORE the request**, so an exhausted budget prevents traffic instead of
  describing it, and it counts the attempt even when the attempt fails;
* **a response with no usage leaves the totals alone.** Treating a missing measurement as zero is
  how a spent budget reports itself as unspent. `requests` still moves, so the request limit holds
  even when usage is absent.

`OpenAiCompatibleAdapter` gained an optional `budget` and calls `admit()` immediately before
`fetchImpl` — the ONE place every request passes, including the 429 retries — and `record(usage)`
where usage is already parsed. A refusal is yielded as a `finish` failure with code
`BUDGET_EXHAUSTED`, deliberately distinct from `LIVE_TRANSPORT`/`LIVE_HTTP`.

`bridge-host.ts` creates one budget per episode from `EF_LHTB_BUDGET_{REQUESTS,PROMPT_TOKENS,
OUTPUT_TOKENS,WALL_MS}` (0 disables a limit, so an unconfigured lane is unchanged), passes it to
the adapter, maps the refusal to the finish reason `budget-exhausted` instead of `error:`, and
exposes `telemetry.budget` as a raw snapshot for reconciliation against the provider's own log.
Because it is not an `error:`, `providerFailures` does not move — a spent budget cannot be reported
as a provider fault.

`ef_lhtb_agent.py` treats `budget-exhausted` as terminal, tested BEFORE the truncation test, and
terminates with its own reason. The ordering matters: the truncation remedy is *more room*, which is
the one thing that must not happen when the budget refused the request.

## 3. What was NOT done, and why the pilot did not start

The brief makes the keyless admission tests a PRECONDITION (§6: "若测试失败，不做 Live"), and §3 a
gate on the whole round ("如果无法给出可靠的总请求或费用上界：NO-GO").

Those tests were not written or run in this round, so the gate's boundary behaviour is
**implemented but unproven**: it compiles, the full suite is unchanged, and nothing about it has
been observed to refuse a request at a limit. Provenance was not frozen and the episode was not
launched. **No provider request was made.**

The remaining work, in order, is short and concrete:

1. keyless tests that a request at the cap is refused; that the FIRST request counts; that
   summarization and a 429 retry both count; that a token limit stops the next request; that
   completion / provider-failure / budget-exhausted produce three different terminations; that a
   budget stop is never reported as `model-reported-completion`; that `taskRoot=absent` refuses the
   next request; and that shutdown and evidence-saving still complete;
2. freeze provenance (EF/LHTB/DSH revisions, dirty files, effective YAML hash, route, pruner,
   window 131072, threshold 65536, `taskRootMode=exact`);
3. one episode under an external watchdog, with the 90-minute and 140-request ceilings armed.

## 4. Verdict

**BUDGET GATE BLOCKED — NO LIVE RUN.** The authorized episode was not started, because the budget
gate that would enforce its ceilings could not be proven inside this round, and an unproven gate is
exactly the condition the brief forbids running under.
