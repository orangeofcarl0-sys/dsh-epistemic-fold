# R35 — Cost Report

## Status

```text
HTTP attempts, whole round:        612
  failed route attempts:           16  (12 writer + 4 probes, 0 tokens observed)
  successful probe:                1   (37 input / 12 output)
  writer runs:                     17  (5 + 6 + 6)
  continuation runs:               578 (162 + 209 + 207)
successful HTTP responses:         596
real writer rows scored:           16
observed input tokens:             466,125
observed output tokens:            151,484
cache read tokens:                 318,464
unknown-usage attempts:            12  (all in the failed route attempts)
retries:                           0
writer-run wall clock:             431,168 ms
continuation wall clock:           1,856,906 ms
currency:                          not reported (no trusted price profile)
```

The failed route attempts were refused at authentication; their charge is a
conservative admission reserve, not a bill. The successful runs report actual
provider usage, so their charged total equals observed usage.

## Continuation runs

| Measure | r1 | r2 (fallback defect) | r3 (authoritative) |
| --- | ---: | ---: | ---: |
| HTTP attempts | 162 | 209 | 207 |
| Valid rows | 18 | 24 | 24 |
| Observed input | 147,294 | 151,771 | 149,780 |
| Observed output | 36,333 | 39,639 | 34,671 |
| Cache read | 96,640 | 109,312 | 110,592 |
| Wall clock | 568,260 ms | 714,447 ms | 574,199 ms |
| Task successes | 7 | 10 | 4 |
| Contract successes | 3 | 6 | 0 |

The r2 fallback rows ran with an empty checkpoint, so its contract count is not
a valid full-history baseline. r3 is authoritative for the complete pairs.

## Live writer runs

| Measure | partial | r1 complete | r2 |
| --- | ---: | ---: | ---: |
| HTTP attempts | 5 | 6 | 6 |
| Successful responses | 5 | 6 | 6 |
| Rows with writer evidence | 4 | 6 | 6 |
| Observed input | 5,089 | 6,077 | 6,077 |
| Cache read | 0 | 0 | 1,920 |
| Observed output | 14,063 | 13,240 | 13,526 |
| Unknown-usage attempts | 0 | 0 | 0 |
| Reserved | 0 | 0 | 0 |
| Charged (observed + reserved) | 5,089 / 14,063 | 6,077 / 13,240 | 6,077 / 13,526 |
| Wall clock | 194,796 ms | 117,916 ms | 118,456 ms |
| Writer latency range | 12.0–30.6 s | 12.0–30.6 s | 9.7–32.6 s |

The partial run's fifth call returned a response whose handoff was larger than
the fold span. The pre-fix harness aborted before writing the row, so the row
count is four even though five calls were billed. The fix in this round records
that case as `fold-refused` and preserves its writer output.

Per-call averages in the two complete runs:

```text
r1: 1,013 input / 2,207 output per call; 19.7 s per call
r2: 1,013 input / 2,254 output per call; 19.7 s per call
```

No task succeeded in this stage, because no follow-up agent ran. Tokens per
successful task is therefore not defined.

## Failed route attempts (history)

Before the route was repaired, 16 requests were refused:

```text
2026-11-01 run      6 writer calls   HTTP 401 api_key_expired
2026-11-02 run      6 writer calls   HTTP 401 api_key_expired
route probes        4 calls          3 x 401, 1 x ECONNREFUSED
observed tokens     0
unknown usage       12 writer attempts
reserved            12,582,912 input / 196,608 output
```

The corrected status for that phase is `provider-unavailable` with 0/6 real
writer calls completed. It is retained as evidence of the route failure and of
the oracle-control reporting defect, not as a writer result.

The repaired-route probe succeeded with `max_tokens = 16,384`, returning 37
input and 12 output tokens and the text `ready`. That single request confirmed
the route and the output bound before the six-case runs.

## What the instrument separates

```text
observed   the provider reported it
reserved   admitted, true consumption unknown
charged    observed + reserved, what admission compares to the limit
```

A 429 or a response without usage keeps its conservative reserve. It is never
settled to zero. A 200 with a partial usage record keeps the unreported
dimension's reserve and is counted as a partial-usage request.

## Mock-provider observations

These verify the accounting instrument; they are not provider cost.

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
```

The final report's `retryAccounting.ledgerRetries` is 2, not 4.

### Writer HTTP 500 (writer-only, one case)

```text
HTTP attempts             1
observed tokens           0
unknown-usage attempts    1
reserved/charged input    131,072
reserved/charged output   16,384
```

The fold still produced a deterministic checkpoint; the task axis was not
assessed.

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

### Fold refusal (writer-only, one case)

```text
HTTP attempts             1
observed tokens           present
fold status               refused (summary not smaller than the span)
run status                executed-partial when another case is valid
```

The writer call was billed and its raw output is preserved; the fold refused to
commit a checkpoint larger than the span it replaced.

## Currency

No currency is reported. The provider route does not supply a trusted price
profile, and the harness will not invent one. Token counts, attempts, and wall
clock are the auditable cost facts.

## Preflight cost

`--preflight` makes **zero provider requests** and spends no tokens. It runs
real folds locally with a dry-run adapter; that CPU time is not provider cost.
