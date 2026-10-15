# 93 — The two failures were a TIMEOUT, and the rerun is clean

Status: **RERUN RUNNING**, no fold yet. 2026-10-15. Parent `fd5936a`.

## A. The unexplained failure, explained

`docs/92` reported two admission tests failing for a cause I could not establish. A standalone
reproduction of the same scenario printed the real snapshot instead of my prediction:

```
AFTER FAILURE  fetchCalls 4   code LIVE_HTTP
  requests 4   reserved 524,288 / 16,384   refusals 0
AFTER SECOND   fetchCalls 1   code none
  observed 10 / 5
```

4 attempts x 4,096 output = 16,384 and 4 x 131,072 prompt = 524,288 -- **exactly what the tests
asserted**. The per-request reserve was right all along.

The failures were a **5-second default timeout**: the 429 backoff makes those tests take ~7s, and
vitest killed them at 5017ms and 5002ms **mid-assertion**. A wrong expectation and an expired
deadline are indistinguishable in a bare `AssertionError`, which is why I could not tell them apart
from the output alone. Both now carry an explicit 60s budget, and the file is 17/17.

## B. The rerun, on the newly approved budget

```
job     lhtb-ef-20261015-180256-probe-economy
budget  REQUIRED=1  requests 140  prompt 7,000,000  output 400,000  wall 5,400,000
```

Snapshot while running:

```
modelCalls 11   folds 0   roots 0   providerFailures 0   shells 16   term in-progress
promptTokensLast 19,092   (29% of the 65,536 threshold)
taskRoot  resident, sourceSeq 2, digestVerified, position 0
budget    requests 11 == modelCalls
          charged prompt 168,602 / output 27,302
          observed == charged, reserved 0 / 0, unknown 0, partial 0, refusals 0
          limit {140, 7,000,000, 400,000, 5,400,000}
```

**The fix is visible in the numbers.** The failed run carried a standing `reservedOutput` of
131,072 and `refusals: 1` at this point; this one has `reserved 0 / 0` and `refusals 0`, because each
request now reserves its own `max_tokens` and settles it on the response. `requests` tracks
`modelCalls` exactly and `observed` equals the charged totals, so nothing is being estimated.

## C. Still open

No natural fold yet at 19,092 of 65,536 tokens. Post-fold continuation, Recall and the official
reward remain unknown because no fold has occurred. **The episode is still running** -- this is a
snapshot, not a verdict, and reporting `NO NATURAL FOLD` now would describe my clock rather than the
workload.
