# R35 — Cost Report

## Status

```text
provider requests attempted:  16  (12 real writer calls over two runs + 4 route probes)
provider requests succeeded:  0
observed input tokens:        0
observed output tokens:       0
reserved input tokens:        12,582,912 (two runs, 6 x 131,072 each)
reserved output tokens:       196,608    (two runs, 6 x 16,384 each)
unknown-usage attempts:       12
retries:                      0
run wall clock:               6,929 ms (two runs)
currency:                     not reported (no trusted price profile)
```

All twelve real writer attempts and all four probes were refused at
authentication or transport. Because the provider reported no usage, the whole
per-request reserve remains charged and every writer attempt is counted as
unknown rather than free. A 401 consumed no billed tokens that this harness can
observe, but that is a property of the refusal, not a measured model cost.

The numbers in the mock-provider sections below verify the accounting
instrument. They are **not** provider cost and must not be presented as such.

## The authorized attempt

```text
authoritative run:       r35-writer-only-provider-auth-20261102
  HTTP attempts:         6
  HTTP retries:          0
  observed tokens:       0
  unknown-usage attempts: 6
  reserved input:        6 x 131,072 = 6,291,456
  reserved output:       6 x 16,384  =    98,304
  charged input/output:  6,291,456 / 98,304
  runElapsedMs:          3,257

superseded run:          r35-writer-only-provider-auth-20261101
  same 6 attempts, same charge; status misreported as executed-success
  runElapsedMs:          3,672

route probes:            4 attempts (3 OpenCode, 1 local proxy)
  observed tokens:       0
```

The adapter's retry telemetry and the ledger agree at zero retries in both runs
(`retryAccounting.consistent = true`). The 401 is a terminal response, not a
rate-limit condition, so no retry was attempted.

The charge above is an admission reserve, not a bill. A server that rejects the
key before inference may bill nothing; this harness cannot verify that from the
response, so it does not settle the reserve to zero.

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
