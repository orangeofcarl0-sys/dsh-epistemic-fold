# 112 — The cat-jam rerun: 13 calls in 22 seconds, then 13 minutes of silence

Status: **genuine stall observed, intermittent.** 2026-10-16. Parent `c9ab58d`.

## A. The run started perfectly

```
jobdir  lhtb-ef-20261016-145117-probe-economy
calls 13   folds 0   promptTokensLast 17,278   providerFailures 0   shells 13
budget  requests 13 == modelCalls   observed == charged 115,683 / 752
        reserved 0 / 0   refusals 0   elapsed 22,532 ms
taskRoot resident, sourceSeq 2, digestVerified
```

**Thirteen calls and thirteen shell executions in twenty-two seconds, with nothing stranded.** The
cleanest opening of any run this session.

## B. Then nothing, for thirteen minutes

```
transcript last written   14:51:50        now 15:05:03   -- no write in 13 minutes
every file in the job dir  oldest 14:51:18, newest 14:51:50
bridge pid 74316           cpu 0    TCP connections 0
container                  Up 13 minutes
actions.log                ABSENT
verifier/ artifacts/       ABSENT
```

Compare the completed cat-jam run, which has `artifacts/actions.log`, `verifier/scorecard.json` and
`verifier/reward.json`. **This run has none of them: the task never reached its verifier.**

## C. This is a real stall, and it is NOT the one I retracted

`docs/110` retracted a "stall" diagnosis because those runs were looping on `403` and I had read the
absence of a transcript instead of the contents. **That retraction stands for those runs.**

This one is different and the evidence is different in kind: the run **succeeded** thirteen times
first, then **stopped writing any file at all** for thirteen minutes while the bridge sits idle with
**zero TCP connections**. A 403 loop produces calls; this produces nothing.

**So there are two phenomena, not one:** the 403 loops (fixed by the tool gate) and an intermittent
stall after some number of successful calls. The previous cat-jam run, same configuration, completed
naturally in 31.8 minutes. **The same config stalls sometimes and not others**, which is why one
observation of either outcome is not a diagnosis.

## D. What I am not claiming

* not that the bridge is deadlocked -- `cpu 0` is equally consistent with waiting on a pipe;
* not the cause. Five guesses in this thread were each disproved by the next measurement.

## E. What would identify it

The bridge's stdin is owned by the agent's pipe, so the question is whether the AGENT is waiting on the
bridge or the bridge on the agent. A stack sample of either process at the moment of silence answers
it directly, and neither has been taken.
