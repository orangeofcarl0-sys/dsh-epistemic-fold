# Phase 7 — the oracle gate, and two blockers that must clear before a sweep

This records what the Phase 7 sweep could and could not do on this host, and why
no arm comparison is reported. Nothing here is an EF result: no arm ranking, no
cost-per-arm figure, and no claim that any mode outperforms any other.

Starting point: `main` at RC24 (`7745dff`), **897 passed / 23 skipped / 0 failed**,
three typecheck projects clean — re-measured here, not carried over.

---

## 1. Repository state

`main` had diverged from `origin/main` by 6 local commits against 15 upstream. The
six were preserved on `backup/local-main-pre-phase7` before `main` was moved to the
RC24 commit; nothing was dropped.

RC24 independently salvaged most of what the handoff asked for in §3: the sweep and
oracle configs are on `main`, `scripts/proxy-env.sh` exists, and both configs carry
`override_timeout_sec: 14400`. That last one matches the task's own
`timeout_sec = 14400` for both discriminators, so §2.3 is satisfied without action.

## 2. A defect RC24 did not fix: the runner ignores its own argument

`scripts/run-lhtb.sh` never read `$1`. It always passed `lhtb-ef-probe.yaml` — one
task, one attempt, `n_concurrent_trials: 1` — regardless of what it was asked to do.

So the handoff's own §3 commands, `run-lhtb.sh sweep` and `run-lhtb.sh oracle`,
would each have run a single-task probe while printing a normal-looking run. This is
the exact failure mode the handoff warns about in §2.1's neighbourhood: an
invocation that measures something other than what it claims, and reports it as
success. An oracle gate run that way would have "passed" while proving nothing
about the environment.

The fix reads the mode from the first positional argument, dispatches to the matching
config, rejects an unknown mode instead of defaulting it, and puts **both the mode
and the arm** in the job name — four sweep arms share a mode and must not collide
on it. Verified: `bash -n` clean, `run-lhtb.sh bogusmode` exits 1 with a diagnostic.

This is the same shape as the `roots=0` finding §5 warns about — a number that
could not mean what it claimed was read as if it did — except here it is a value
that could never differ, so the check could never fail.

## 3. The oracle gate (§1)

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
was stopped after six such phases (~15 minutes each, ~2.5 h of budget remaining)
because re-running an identical solution cannot change the outcome.

That task also disagrees with itself. The solution's own `bench_results.json`
reports `speedup: 0.34` and its `JOURNAL.md` claims "speedup >= 5x over brute-force";
the verifier, on 100K vectors, measures `speedup: 8.16` with `recall: 1.0` and
`insert_time: 795.9 s`. A 24x discrepancy between a solution's self-measurement at
10K vectors and the verifier's at 100K is a property of the task, not of any arm.

**Consequence for the sweep.** A discriminator whose own ceiling is 0.8327 cannot
distinguish "this arm is worse" from "this arm also failed to hit what the reference
solution failed to hit". Per §5, a difference is not attributable to the mode, so
`vector-db-iterative-build` is excluded from arm comparison. It is not deleted from
the lane; it is demoted from *discriminator* to *environment check*.

## 4. Blocker 1 — the route needs a proxy on this host, and §2.1's default is wrong here

The first `basic`-arm probe returned **reward 0.0, 0 submits, 8m07s**, with every
model call failing as `error:fetch failed`. That message names neither proxy nor
port, which is precisely why §2.1 says it reads like a credential fault.

It is not a credential fault, and it is not the bracketed-`NO_PROXY` fault — that one
is genuinely live on this machine (`NO_PROXY` ends `::1,[::1]`) and is scrubbed by
`scripts/proxy-env.sh`, but scrubbing it did not fix this.

`opencode.ai` publishes **nine A records, and four of them refuse TCP 443**:

| address | :443 | address | :443 |
|---|---|---|---|
| 182.16.61.114 | open | 141.193.154.210 | open |
| 182.16.61.115 | open | 141.193.154.50 | **refused** |
| 182.16.61.117 | open | 141.193.154.146 | **refused** |
| 182.16.61.118 | open | 180.178.40.218 | **refused** |
| | | 117.55.193.18 | **refused** |

`curl` looks healthy on this host because it falls back across the address set.
Node's `fetch` does not, and the EF bridge is Node. Measured, with the runner's own
environment:

```
Node, direct        : 0/10   (9 x ECONNREFUSED, 1 x ETIMEDOUT)
Node, via 127.0.0.1:10808 : 5/5   HTTP 200
curl, direct        : 200
```

§2.1 says to enable the proxy only if the route genuinely requires one, and to
verify the proxy answers `curl` first. Both conditions hold here, so
`EF_USE_PROXY=1` is the correct setting **on this host**. The RC23 comment in
`run-lhtb.sh` — "this machine reaches the provider only through a local HTTP proxy" —
was right about this machine and was removed on the strength of a measurement taken
on a different one. The opt-in default is still the right shape; it just needed
`EF_USE_PROXY=1` here.

With the proxy on, the basic arm works: 62 model calls, `lastFinishReason:
'tool-calls'`, and the agent doing real stage-E analysis of `effective_throughput`
relations against the task's own hash-checked probe channel.

## 5. Blocker 2 — 8192 is not enough for Basic's checkpoint summary

With the route fixed, the basic arm still ended in a failure, at turn 62:

```
ef_bridge_client.BridgeError: summarization truncated at the token cap
(incomplete checkpoint)
```

This is the defect handoff §6 lists as already fixed — "the 2000-token
summarization budget that truncated Basic checkpoints". RC23 raised it to 8192 via
`EF_TAU2_SUMMARY_MAX_TOKENS`, and the code comment is explicit that 8192 is "a
deliberate headroom multiple rather than a measured minimum". It is still too
small: on this task, with this model, the summary exceeds it.

The model's real ceiling was measured rather than assumed:

| requested | result |
|---|---|
| 8192 | 200, `finish_reason: length`, 8192 completion tokens |
| 16384 | 200, `finish_reason: length`, 16384 completion tokens, 204 s |
| 32768 | transport failure after 305 s |

So the request is honoured, not clamped — the summary genuinely needs more than 8192.

But raising it is not yet a fix. At 16384 the run **stalled**: the transcript stopped
being written for 16 minutes with Harbor and the container both alive, no error, no
progress — one model call that never returned. A 204-second generation for a short
prompt becomes an open-ended wait once the summarization prompt is large.

The honest reading is that the budget is the wrong lever, and that Basic's
full-checkpoint summary is too large for this model to produce inside any usable
wall-clock. Two directions, neither yet taken:

1. make Basic's checkpoint body compact enough to fit a sane budget, which is the
   defect RC23 described and did not actually finish; or
2. bound the summarization call separately from the fold, so a slow summary degrades
   a fold rather than the episode.

## 6. What §4 says about the runs that did complete

Every completed run wrote an `ef-lhtb-transcript/1` with provenance and the full
telemetry set. On the `basic` arm the invariants hold, which is the one §4 check
that is conclusive here:

| field | basic arm | §4 requirement | verdict |
|---|---|---|---|
| `bundleWrites` | 0 | must be 0 | pass |
| `bundlesPresent` | 0 | must be 0 | pass |
| `pendingIntents` | 0 | must be 0 | pass |

`bundleWrites >= folds + roots + emergencies` holds trivially at 0 for this arm,
because Basic does not fold (`folds: 0`, `roots: 0`, `emergencies: 0`) — so invariant
1 is **not** exercised by this evidence and is not claimed. It has to be checked on
an EF arm, which is where folding actually happens.

A collector (`ef-collect.sh`, untracked) reports a missing field as `MISSING` and
skips the dependent invariant, rather than reading it as a passing zero. That is
deliberate: the prior pre-RC23 archives have no `emergencies`, `bundleWrites`,
`bundlesPresent`, `pendingIntents` or `pressureRegime` at all, and a missing counter
displayed as 0 is the old `roots=0` mistake again.

## 7. What is not claimed

- **No arm ranking.** No arm completed a trial on this host.
- **No cost-per-arm figure.** Recorded spend differs by arm only because one arm ran
  further before dying; the amounts are not comparable.
- **No `vector-db-iterative-build` attribution**, for the ceiling reason in §3.
- **No re-use of the old `roots=0` finding.** `roots` comes from the engine's own
  counter and reads 0 here because Basic does not produce root rebases, not because a
  detector cannot fire.
- **No statement about the provider's 4-of-9 dead A records being stable.** That is
  an observation of one lookup window, not a measurement of uptime.

## 8. To run a sweep, two things must change first

1. `EF_USE_PROXY=1` on any host whose route resolves to a partial address set — and
   the reachability test belongs in the precondition table, not in a comment.
2. A Basic-arm checkpoint summary that fits a usable budget, or a summarization call
   bounded independently of the fold.

With both in place, `run-lhtb.sh sweep` (mode dispatch now working) can run the four
arms on `unknown-config-semantics` alone. Budget from measurement, not from the
declared limit: the oracle's 87-minute agent phase is the floor for one clean trial,
so four arms at two replicates is on the order of a day.
