# Phase 7 — the oracle gate, and two blockers (one of them mis-read)

This records what the Phase 7 sweep could and could not do on the host it was run
on, and what the two blockers actually were. Nothing here is an EF result: no arm
ranking, no cost-per-arm figure, and no claim that any mode outperforms any other.

Starting point: `main` at RC24 (`7745dff`), **897 passed / 23 skipped / 0 failed**,
three typecheck projects clean — re-measured here, not carried over.

The oracle-gate numbers and blocker 1 come from the Phase 7 run. **Blocker 2's
diagnosis is corrected below**: the run was killed by an unguarded call in the
harness, not by Basic's summarization quality, and the fix is containment rather
than a larger budget.

---

## 1. A defect the handoff depended on: the runner ignored its own argument

`scripts/run-lhtb.sh` never read `$1`. It always passed `lhtb-ef-probe.yaml` — one
task, one attempt, `n_concurrent_trials: 1` — regardless of what it was asked to do.

So the handoff's own §3 commands, `run-lhtb.sh sweep` and `run-lhtb.sh oracle`,
would each have run a single-task probe while printing a normal-looking run. This is
the exact failure mode the handoff warns about: an invocation that measures something
other than what it claims, and reports it as success. An oracle gate run that way
would have "passed" while proving nothing about the environment.

The fix reads the mode from the first positional argument, dispatches to the matching
config, rejects an unknown mode instead of defaulting it, and puts **both the mode
and the arm** in the job name — four sweep arms share a mode and must not collide on
Harbor's `job_name` key.

This is the same shape as the `roots=0` finding §5 warns about — a number that could
not mean what it claimed was read as if it did — except here it is a value that could
never differ, so the check could never fail.

`tests/lhtb-runner-dispatch.spec.ts` now drives the real script against a hermetic
fixture (a fake `harbor.exe` that prints the config it was handed, a fake interpreter
that performs the credential read, a throwaway credential file). Asserting on the
script's text would have passed against a runner that reads the mode and then ignores
it; the dispatch has to be exercised.

### 1.1 An absolute invocation died before reaching any of it

Driving the real script by absolute path — which is what the handoff tells an
operator to do — failed before the dispatch block:

```
run-lhtb.sh: line 131: ...\scripts\run-lhtb.sh/proxy-env.sh: Not a directory
```

The script sourced `proxy-env.sh` through `${BASH_SOURCE[0]%/*}`, and that parameter
expansion cannot strip a **backslash** path. The documented relative invocation never
exercised the difference. Both runners now derive their own directory with `dirname`,
and the dispatch spec invokes them by absolute path so it stays fixed.

## 2. The oracle gate

| task | oracle reward | what it establishes |
|---|---|---|
| `unknown-config-semantics` | **1.0** | environment works end to end |
| `vector-db-iterative-build` | **0.8327** | the task's own reference solution does not saturate |

`unknown-config-semantics` is a clean pass: all five stages A–E, 696/696 hidden
fields credited, 58 cases, 112 log records verified, agent phase 87 minutes. Images
pull, containers start, and the hidden verifier scores. The environment is not
broken.

`vector-db-iterative-build` is the problem. Its **reference solution** — no model
involved — tops out at 0.8327, and Harbor then holds the trial open in a
`continue_until_timeout` loop that re-runs the same deterministic solution. The run
was stopped after six such phases because re-running an identical solution cannot
change the outcome.

That task also disagrees with itself. The solution's own `bench_results.json` reports
`speedup: 0.34` and its `JOURNAL.md` claims "speedup >= 5x over brute-force"; the
verifier, on 100K vectors, measures `speedup: 8.16` with `recall: 1.0` and
`insert_time: 795.9 s`. A 24x discrepancy between a solution's self-measurement at
10K vectors and the verifier's at 100K is a property of the task, not of any arm.

**Consequence for the sweep.** A discriminator whose own ceiling is 0.8327 cannot
distinguish "this arm is worse" from "this arm also failed to hit what the reference
solution failed to hit". A difference is therefore not attributable to the mode, so
`vector-db-iterative-build` is excluded from arm comparison. It is not deleted from
the lane; it is demoted from *discriminator* to *environment check*.

## 3. Blocker 1 — the route needed a proxy on that host, and `curl` hid it

The first `basic`-arm probe returned **reward 0.0, 0 submits, 8m07s**, with every
model call failing as `error:fetch failed`. That message names neither proxy nor
port, which is precisely why §2.1 says it reads like a credential fault.

It is not a credential fault, and it is not the bracketed-`NO_PROXY` fault — that one
is genuinely live on that machine (`NO_PROXY` ends `::1,[::1]`) and is scrubbed by
`scripts/proxy-env.sh`, but scrubbing it did not fix this.

`opencode.ai` publishes **nine A records, and four of them refuse TCP 443**:

| address | :443 | address | :443 |
|---|---|---|---|
| 182.16.61.114 | open | 141.193.154.210 | open |
| 182.16.61.115 | open | 141.193.154.50 | **refused** |
| 182.16.61.117 | open | 141.193.154.146 | **refused** |
| 182.16.61.118 | open | 180.178.40.218 | **refused** |
| | | 117.55.193.18 | **refused** |

`curl` looks healthy on that host because it falls back across the address set.
Node's `fetch` does not, and the EF bridge is Node. Measured there, with the
runner's own environment:

```
Node, direct        : 0/10   (9 x ECONNREFUSED, 1 x ETIMEDOUT)
Node, via 127.0.0.1:10808 : 5/5   HTTP 200
curl, direct        : 200
```

So `EF_USE_PROXY=1` is correct **on that host**, and the opt-in default is still the
right shape. But the precondition that was supposed to catch this was stated as a
`curl`, and a `curl` cannot catch it: the check has to run in the transport that will
actually make the calls.

That is now `scripts/check-route.mjs` — a POST to the adapter's own
`/chat/completions` over Node's `fetch`, with the proxy environment the runner
exports, reporting failure classes (`ECONNREFUSED`, `ETIMEDOUT`, …) rather than the
bare `fetch failed`. `run-lhtb.sh` runs it before Harbor pulls anything, so a
transport fault costs seconds instead of an episode budget; `EF_SKIP_ROUTE_CHECK=1`
overrides it for a deliberate down-route run.

With the proxy on, the basic arm works: 62 model calls, `lastFinishReason:
'tool-calls'`, and the agent doing real stage-E analysis of `effective_throughput`
relations against the task's own hash-checked probe channel.

## 4. Blocker 2 — CORRECTED: the harness killed the episode, not the budget

With the route fixed, the basic arm still ended at turn 62:

```
ef_bridge_client.BridgeError: summarization truncated at the token cap
(incomplete checkpoint)
```

The Phase 7 write-up read this as a budget problem — "8192 is not enough for Basic's
checkpoint summary" — and proposed either shrinking Basic's checkpoint body or
bounding the summarization call. **The first reading is wrong and the first direction
is not available.**

### 4.1 The error was a FAILED FOLD, and production survives those

`src/basic/index.ts` registers `agent/pre-step` and wraps its own
`compactIfNeeded` in a try/catch:

```ts
try {
  const result = await this.compactIfNeeded(agent, 'pressure', signal)
  if (result !== null) logResult(result, 'step pressure')
} catch (error: unknown) {
  …
  ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
}
return next()
```

A truncated summary in a real DSH session is a **missed fold the agent works
through**. It is not fatal.

`bridge-host.ts` called the same method with **no try/catch**. The error propagated
out of `modelTurn`, became `{ok: false}`, raised `BridgeError` in the Python client,
and left `ef_lhtb_agent.run()` — ending the trial at reward 0 after 62 real model
calls.

So the trial did not die of a budget. It died because this harness reports a failed
fold as a failed task, and the row was read as evidence about Basic's summarization
quality. It is evidence about the harness. Reproduced directly against the engine in
`tests/harness-fold-containment.spec.ts`: a `max-tokens` summarizer on a conversation
large enough to fold throws exactly that message, and leaves the surface untouched —
so containment is safe.

### 4.2 There was no bound on the call at all

The stall at 16384 (16 minutes, no progress, no error, Harbor and the container both
alive) has the same root cause. The fold's signal was:

```ts
runMaintenance: <T,>(task) => task(new AbortController().signal)
```

An `AbortController` created and never aborted. The adapter forwards
`options.signal` to `fetch` but sets no timeout of its own, so a single
summarization had **no upper limit of any kind**. Raising the token budget lengthens
the unbounded wait; it cannot shorten it.

### 4.3 What was done instead

- The fold is **contained**: the failure is counted (`foldFailures`), its message is
  kept (`lastFoldError`, redacted like every other error path), and the episode
  continues — matching production's semantics.
- The fold is **bounded** by a wall-clock deadline (`EF_TAU2_FOLD_TIMEOUT_MS`,
  default 600s), so a hang becomes a recorded fold failure rather than a lost run.
  600s is from measurement: a legitimate 16384-token summary returned in 204s, and
  the transport failed at 32768 after 305s, so 600s is ~3x the observed legitimate
  worst case and still an order of magnitude under the episode budget.

Both new fields are in the telemetry and therefore in the `ef-lhtb-transcript/1`
archive. `foldFailures` is a **reading**, not an invariant: a non-zero value must be
quoted, because an arm that folded 15 times while failing 12 would otherwise look
identical to one that folded cleanly.

### 4.4 What is still open

Whether Basic's full-checkpoint body is genuinely too large for this model at 8192 is
**not settled** — it is now measurable, as a `foldFailures` count on a run that
continues, rather than as a dead trial. The second direction the Phase 7 write-up
listed ("make Basic's checkpoint body compact enough to fit a sane budget") is not
available as stated: every module under `src/basic/` is a byte-identity-enforced copy
of the vendored reference (`tests/rc7-vendored-basic.spec.ts`) and says "Do not edit
to change behaviour" in its header. That would be a change to DSH's own compaction,
not to EF's harness.

## 5. What the completed runs say about §4

Every completed run wrote an `ef-lhtb-transcript/1` with provenance and the full
telemetry set. On the `basic` arm:

| field | basic arm | requirement | verdict |
|---|---|---|---|
| `bundleWrites` | 0 | must be 0 | pass |
| `bundlesPresent` | 0 | must be 0 | pass |
| `pendingIntents` | 0 | must be 0 | pass |

`bundleWrites >= folds + roots + emergencies` holds trivially at 0 for this arm,
because Basic does not fold (`folds: 0`, `roots: 0`, `emergencies: 0`) — so invariant
1 is **not** exercised by this evidence and is not claimed. It has to be checked on
an EF arm, which is where folding actually happens.

The collector that performs those checks is now tracked as
`scripts/ef-collect.py` — it was previously an untracked file on one machine, which
meant the verification step the handoff tells the next operator to run was not in the
repository. It reports a missing field as `MISSING` and **skips** the dependent
invariant rather than reading it as a passing zero: the pre-RC23 archives have no
`emergencies`, `bundleWrites`, `bundlesPresent`, `pendingIntents`, `pressureRegime`
or `foldFailures` at all, and a missing counter displayed as 0 is the old `roots=0`
mistake again. Unverified checks are counted separately from passes.

## 6. What is not claimed

- **No arm ranking.** No arm completed a trial on that host.
- **No cost-per-arm figure.** Recorded spend differs by arm only because one arm ran
  further before dying; the amounts are not comparable.
- **No `vector-db-iterative-build` attribution**, for the ceiling reason in §2.
- **No re-use of the old `roots=0` finding.** `roots` comes from the engine's own
  counter and reads 0 here because Basic does not produce root rebases, not because a
  detector cannot fire.
- **No claim that the 62-call basic arm failed because of Basic's summary size.**
  That row is a harness defect (§4.1), and is not evidence about any arm.
- **No statement about the provider's 4-of-9 dead A records being stable.** That is
  an observation of one lookup window, not a measurement of uptime.

## 7. To run a sweep

Both blockers are now addressed in code:

1. The route is checked with the bridge's own transport
   (`scripts/check-route.mjs`), and `EF_USE_PROXY=1` is set only where that check
   says it is needed.
2. A failed fold is contained and counted, and each fold is bounded — so a slow or
   failing summary degrades a fold rather than the episode.

`run-lhtb.sh sweep` (mode dispatch working, job names per mode-and-arm) can then run
the four arms on `unknown-config-semantics` alone. Budget from measurement, not from
the declared limit: the oracle's 87-minute agent phase is the floor for one clean
trial, so four arms at two replicates is on the order of a day.

Note that the arms must still be **blocked** rather than run back-to-back, and that
the container-memory constraint from Phase 6 (`AddTestsDirError` with the container
pinned at 4 GiB / 4 GiB) is unresolved — it is a resource decision for the benchmark,
not a code defect.
