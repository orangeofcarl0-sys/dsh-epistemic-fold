# 91 — P1 ran, and the BUDGET GATE ended it at call 13

Status: **PILOT CENSORED — NO NATURAL FOLD**, censored by a budget-gate parameter defect.
2026-10-15. Parent `f932acd`.

## A. What happened

```
job          lhtb-ef-20261015-023235-probe-economy      runtime 26m 46s
termination  budget-exhausted
modelCalls   13        folds 0        roots 0        providerFailures 1
shells       16        promptTokensLast 20,374  (31% of the 65,536 threshold)
taskRoot     {mode: exact, status: resident, sourceSeq: 2, digestVerified: true, position: 0}
reward       official 0.0   raw_ungated 0.3678   pass_threshold 1.0   submits 0
```

## B. The gate stopped the run for a reason that has nothing to do with the workload

```
budget.requests            12        of a 140 limit
budget.observedOutput      30,014
budget.reservedOutput     131,072    <- one request that never reached `record`
budget.outputTokens       161,086    >= the 100,000 limit   -> refusals 1
budget.observedPrompt     179,855    of 7,000,000
budget.unknownUsage       0     partialUsage 0
```

The episode ended because **the per-request OUTPUT RESERVE (131,072) is larger than the entire
OUTPUT LIMIT (100,000)**. One request failed (`providerFailures: 1`) and therefore never reached
`record`, so its reserve stood -- correctly, that is what the reservation is for. But a single
standing reserve of 131,072 makes `consumedOutput()` exceed 100,000 **permanently**, so every
subsequent request is refused and the run can never continue.

**This is a parameter defect in my own gate, not a workload result.** The earlier cost arithmetic
computed `output <= 100,000 + 131,072 = 231,072` for the SPEND bound and never checked that a
reserve larger than the limit **deadlocks the gate**. It does.

## C. What the run DID establish

* **The gate works.** It admitted 12 requests, refused the 13th, reconciled exactly with the
  provider (`budget.requests` tracks `modelCalls`), and terminated the episode as
  `budget-exhausted` -- not as a provider failure, not as a completion.
* **Task Root held.** Registered, `resident`, `digestVerified`, position 0, for the whole run, with
  zero folds to disturb it.
* **Real work happened**: 16 shell executions over 13 model calls on the real Docker task.
* **No natural fold**, at 20,374 of 65,536 tokens.

## D. The fix, and what must be re-derived

The output reserve must be **strictly less than** the output limit, or the gate must treat a
standing reserve as bounded by what the limit allows. The defensible form is a reserve derived from
the limit rather than a constant: the reserve exists to bound an UNKNOWN request, so it cannot
exceed the whole budget it is charged against.

Any change to the reserve changes the cost bound, which must be re-derived and re-approved before
another run. **No second episode was started, and none will be without review.**

## E. Honest verdict

```
NATURAL FOLD                  NOT EXERCISED   (13 calls, 20,374 of 65,536 tokens)
OPERATIONAL RECALL            NOT EXERCISED   (no archive existed)
POST-FOLD CONTINUATION        NOT ESTABLISHED (no fold occurred)
LHTB EPISODE COMPLETED        NO -- official reward 0.0, censored at 13 of 140 calls
BUDGET GATE                   EXECUTED and EFFECTIVE, with a parameter defect
TASK ROOT                     RESIDENT and digest-verified throughout
```

The reward is recorded, not spun: `official_reward 0.0` with `raw_ungated 0.3678` against a
`pass_threshold` of 1.0, on a run the budget cut short at 9% of its request allowance. It is not
evidence about EF's quality, and it is not reported as such.
