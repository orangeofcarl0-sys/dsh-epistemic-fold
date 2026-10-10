# RC30 — the reply budget, and a watchdog that knows what NOT to kill

Status: landed. Follows [57_RC29_TRUNCATION_RETRY.md](57_RC29_TRUNCATION_RETRY.md),
which fixed the same failure one layer down.

## 1. What the step-5 round actually died of

The RC29 work removed `truncated` from the summarizer: 0 occurrences across eight
cells, and the retry never fired. But a cell died anyway, and the reason was the
same mechanism one layer up — the AGENT's reply budget.

    turn 52   anomaly "empty response"  streak 1  finishReason "max-tokens"
    turn 53   anomaly "empty response"  streak 2  finishReason "max-tokens"
    turn 54   anomaly "empty response"  streak 3  finishReason "max-tokens"
    turn 55   anomaly "empty response"  streak 4  finishReason "max-tokens"
    turn 56   anomaly "empty response"  streak 5  finishReason "max-tokens"
    termination: "empty-streak (5, last finish max-tokens)"

Five CONSECUTIVE empty replies, every one finishing `max-tokens`, `providerFailures:
0`. The cell was ended after 56 model calls, having spent 1.04M tokens of a four-hour
budget. An `economy` cell reached 4 of the same 5 and would have died identically.

## 2. The defect was an ORDER OF TESTS

In `eval/lhtb/ef_lhtb_agent.py` the loop tested emptiness before it tested the finish
reason:

    if content == "" or content == EMPTY_PLACEHOLDER:   # first
        ... nudge: "Your last reply was empty. Continue the task..."
    if finish.endswith("max-tokens"):                   # second, unreachable when empty
        ... submit a bigger budget

So a reply that the cap cut off BEFORE it could emit anything was read as the model
DECLINING TO ACT, and answered with a nudge. A nudge cannot fix a budget overrun: the
model re-derives the same reasoning, is cut off at the same place, and the streak
walks to its ceiling. The two events need opposite responses — silence wants a nudge,
a cut-off wants more room — so the test is now made in that order, counted
separately (`MAX_TRUNCATION_STREAK`), and the cut-off is retried with an escalated
budget.

An empty reply that finishes `max-tokens` is proof, not inference: every output token
went to something other than content, and reasoning is the only other consumer.

## 3. The base budget was wrong for this model

`EF_BRIDGE_MAX_TOKENS` goes 8192 → **32768**, the same value already chosen for
summarization for the same reason. It is a CAP and not a target, so it costs nothing
unless the model uses the room — and at 8192 the measured behaviour was that the
reasoning consumed the whole budget and the answer was empty.

The agent escalates from there (`EF_LHTB_REPLY_MAX_TOKENS` defaults to
`EF_BRIDGE_MAX_TOKENS`), doubling per consecutive cut-off, capped by
`EF_LHTB_REPLY_MAX_TOKENS_CEILING` (131072). The escalated budget is remembered for
the rest of the episode and is never lowered: the model needed the room once.

## 4. The wedges were the harness's, not the model's

Two `vector-db` cells wrote nothing for 1h35m and 3h10m while their containers stayed
`Up` and the trials stayed `in-progress`. One held SIXTEEN orphaned processes aged up
to 2h54m. The agent had written itself a raw-socket benchmark server that deadlocked —
the agent's bug. The multi-hour consequence is the harness's:

    harbor/src/harbor/environments/docker/docker.py   except asyncio.TimeoutError:
        process.terminate()   # the LOCAL docker compose client
        ...
        process.kill()        # still the local client
        raise RuntimeError("Command timed out after 900 seconds")

The 900-second timeout kills the local `docker compose` client and NEVER the process
inside the container. The orphan then holds the pipe open, so the waiting call does
not return, and the agent waits forever. Nothing in the container was ever going to
end it.

## 5. Why the watchdog is not an agent

The stated alternative was "a supervising agent that notices and repairs". Rejected
for two reasons, one of which is decisive:

1. Every failure here is DETERMINISTIC. Replacing a comparison with an uncertain model
   call adds cost, latency and a new failure mode while making the thing it detects
   less reliable.
2. **A supervisor that repairs an episode becomes part of the measurement.** If it
   finishes the work, the cell scores agent+supervisor and the comparison against the
   other arm is void.

So the watchdog is a deterministic process that reaps a process the harness already
tried and failed to kill. It does not nudge the model, retry a step, restart a cell,
or edit a transcript. Its log and the transcript are deliberately separate records.

## 6. The rule that a live sample had to teach

The first draft reaped every process older than the tool timeout. Run against the
live cells it found three wedges — and would have destroyed several more cells:

- The `unknown-config-semantics` image runs `/opt/cfg/cfg_daemon.py`: the TASK's own
  service, a child of the container init, **13,967 seconds old**. Reaping it would not
  have un-wedged anything; it would have silently invalidated every cell of that task.
- One `economy` cell was making progress normally while holding FIVE of its own
  leftover `python3` servers, up to 1h32m old. Those are running experiments, not
  garbage.

Three rules came out of that, and each has a test:

| rule | why |
|---|---|
| silence is not evidence | a model call here takes 34-241s; a 75s window once caught 1 of 8 HEALTHY cells mid-call |
| old is not the same as orphaned | a process that started with the container is a task service, however old |
| only a WEDGED cell is touched | an orphan beside a working cell is that cell's own experiment |

A verdict of `leaking` therefore exists: leftovers in a working cell are RECORDED and
never removed.

Sampling moved from `docker exec ps` to `docker top`: the `unknown-config-semantics`
image has no `ps` binary at all, which is how three of seven cells came back unsampled
on the first live run — the watchdog was blind to an entire task.

## 7. What is verified

| claim | pinned by |
|---|---|
| the task daemon is never selected | `tests/lhtb-watchdog.spec.ts`, on a real `docker top` sample |
| the init and its keepalive are never selected | same file |
| a process inside its own timeout is left alone | same file |
| an orphan beside a working cell is `leaking`, not `wedged` | same file |
| 2 minutes of silence is ACTIVE, not wedged | same file |
| the container's age is read portably (no `pid === 1` assumption) | same file: `docker top` reports HOST pids |
| the protocol carries a per-call reply budget | bridge `step`/`turn` ops, client `step(max_tokens=)` |

The watchdog was also run against the live wedged cells before being trusted: it
identified exactly the two wedged cells and their 2 + 16 orphans, and after the rule
changes it refused to touch the working cell's servers.
