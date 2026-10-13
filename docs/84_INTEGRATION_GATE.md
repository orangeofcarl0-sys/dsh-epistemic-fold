# 84 — Integration gate: what the real bridge actually exercises

Status: **BUDGET GATE BLOCKED — NO LIVE RUN.** 2026-10-14. Parent `57ba3f5`.

## A. The measured blocker for Gate A

Gate A asks whether the fold's SUMMARIZATION shares the episode budget. The real-bridge fixture
cannot answer it, and the reason is a property of the fixture rather than of the gate:

```
fold committed            folds > 0
extra HTTP requests       0
summarizationAttempts     0
```

**A fold in this harness commits with ZERO provider requests**, because EF takes its fallback
checkpoint rather than a semantic summary. So there is no summarization call for the budget to
share, and a test asserting "the summary was counted" would have to invent one. That is recorded as
the blocker instead of being dressed up as a passing integration.

## B. What the fixture DOES prove, through the real bridge

`tests/task-root-bridge.spec.ts` now drives a real budget gate in the real bridge process:

```
requests = 1, REQUIRED = 1
  fold            -> commits, 0 requests (free)
  step #1         -> provider.calls() = 1   (admitted)
  step #2         -> provider.calls() = 1   (REFUSED before the fetch)
  lastFinishReason  budget-exhausted        (not an `error:`)
  providerFailures  0                       (a spent budget is not a provider fault)
  budget.refusals   > 0
  taskRoot          resident throughout
```

and that the gate's own count reconciles with the provider's log (`budget.requests ====
provider.calls()`). `EF_LHTB_BUDGET_REQUIRED=1` is armed in these tests, so a test cannot pass by
silently running with the budget switched off.

## C. Gates not completed

| gate | status |
|---|---|
| Adapter admission | **PASS** (13 unit + 7 bridge) |
| Shared summarization budget | **BLOCKED** — the fixture's folds are free (section A) |
| Python budget termination | **BLOCKED** — not executed this round |
| Task Root fail-closed | **BLOCKED** — not executed |
| Watchdog | **BLOCKED** — no controlled hang test run |
| Provenance | **BLOCKED** — no PREPARED snapshot produced |
| Cost bound | **PASS** — per-dimension settlement, reserves derived from the code |
| Regression | **PASS** |

## D. Cost bound, and what it still rests on

```
input  <= 7,000,000 + 131,072 = 7,131,072 x $0.30/M = $2.14
output <=   100,000 + 131,072 =   231,072 x $1.20/M = $0.28
                                                     -----
                                                     $2.42
```

Both reserves are derived from the code: the window (131,072) and `REPLY_MAX_TOKENS_CEILING`
(131,072, which the agent's escalation may reach). **One request in flight at a time** is still an
ASSUMPTION, not a measurement — no concurrency test was run, so the single-overshoot allowance is
not yet backed by evidence. That is a live caveat, not a settled fact.

## E. Not done, and not pretended

No provider request was made. No episode was started. The four blocked gates need a fixture whose
folds actually call the model (or a summarizer forced onto the model path), a Python-side budget
termination run, a Task Root invalidation test, a controlled hang with an external watchdog, and a
read-only provenance collector.
