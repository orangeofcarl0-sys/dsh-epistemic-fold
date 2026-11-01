# R35 — Cost Report

## Status

```text
provider requests:        0
observed input tokens:    0
observed output tokens:   0
reserved tokens:          0
charged tokens:           0
retries:                  0
wall clock (provider):    0 ms
currency:                 not reported (no trusted price profile)
```

No real-model cost exists in this round. The numbers below are from the local
mock-provider tests that verify the accounting instrument. They are **not**
provider cost and must not be presented as such.

## What the instrument now separates

```text
observed   the provider reported it
reserved   admitted, true consumption unknown
charged    observed + reserved, what admission compares to the limit
```

A 429 or a response without usage keeps its conservative reserve. It is never
settled to zero. A 200 with a partial usage record keeps the unreported
dimension's reserve and is counted as a partial-usage request.

## Mock-provider observations

### 429, 429, 200 (writer-only, one case)

```text
HTTP attempts             3
retries                   2
unknown-usage attempts    2
observed input            100
observed output           20
reserved input            262,144   (2 x 131,072 context-window reserve)
reserved output           32,768    (2 x 16,384 writer reserve)
charged input             262,244
charged output            32,788
caseDurationMs            ~400 ms   (local mock; not provider latency)
```

The final report's `retryAccounting.ledgerRetries` is 2, not 4. The two 429
attempts remain charged and are counted as unknown.

### Writer HTTP 500 (writer-only, one case)

```text
HTTP attempts             1
observed tokens           0
unknown-usage attempts    1
reserved/charged input    131,072
reserved/charged output   16,384
```

The fold still produced a deterministic checkpoint. The provider failure is
recorded on the provider axis; the task axis is not assessed.

### Budget refusal inside the writer (writer-only, one case)

```text
limits.requests           1
HTTP attempts             1
budget refusals           1
unknown-usage attempts    1
reserved/charged input    131,072
reserved/charged output   16,384
run status                budget-exhausted
```

The second attempt was refused before `fetch`. The run stopped; the first
attempt's charge is preserved.

### Normal run, all tasks fail the checker (one continuation case)

```text
writer request            succeeded
follow-up requests        1
observed tokens           present
status                    executed-failed
measurementValid          true
```

This is a valid negative result. The cost is not zero.

## What a live report will add

```text
main model input/output/cache
writer/rationale input/output
follow-up input/output
429 retries
recall calls
tool-loop steps
case and run wall clock
tokens and attempts per successful task
```

Currency remains unreported unless a trusted price profile is supplied. Oracle
arms (O1/O2) are mechanism diagnostics, not a zero-cost product alternative.

## Preflight cost

`--preflight` makes **zero provider requests** and spends no tokens. It runs
real folds locally with a dry-run adapter; that CPU time is not provider cost.
