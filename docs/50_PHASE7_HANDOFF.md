# Phase 7 handoff — running the LongWork lane on a machine that can

This is the prompt and the preconditions for the Phase 7 sweep. It is written to
be handed to an agent on a machine with the benchmark conditions; everything it
needs is either in this repository or measured below.

Phase 6 ran two cells and both completed on the EF side. It did **not** produce
an arm comparison, and cannot: one attempt per arm is not a sample, and one of
the two cells died in Harbor's teardown. Phase 7 is what would produce evidence.

---

## 1. Preconditions — verify before spending anything

| condition | how to check | why it matters |
|---|---|---|
| Docker daemon up | `docker version --format '{{.Server.Version}}'` | Harbor needs it |
| LHTB checkout + Harbor venv | `$LHTB_ROOT/harbor/.venv/Scripts/harbor.exe` exists | the lane lives outside this repo |
| Credential store | `$DSH_HOME/.credentials.yaml` has `OPENCODE_GO_API_KEY` | read at runtime, never printed |
| Route reachable **by the bridge's own transport** | `node scripts/check-route.mjs` | **not** a `curl` — see §2.1 |
| **Container memory** | task images at 4 GiB, and one run was pinned at 4 GiB / 4 GiB for an hour | see the memory trap below |
| Disk | two task images are ~420 MB each | `vector-db-iterative-build` is **not** cached here |
| **A runnable Python 3** | `LHTB_ROOT=<checkout> npm test` — green reads **922 passed / 23 skipped**; **28 skipped** means no interpreter was found | the `ef-collect` behaviour checks skip *silently* without one, and a Windows Store `python3` stub is not an interpreter — see `docs/53` |

Run the oracle first. It uses the tasks' own reference solutions, needs no API
key, and answers "does the environment work" rather than "did the model do well":

```bash
LHTB_ROOT=<checkout> bash scripts/run-lhtb.sh oracle
```

**A reward of 0 there is the environment failing, not the task.** Do not proceed
past it.

---

## 2. Three traps that cost real time in Phase 6

### 2.1 The proxy is a property of the HOST, and `curl` cannot tell you which

`scripts/run-lhtb.sh` used to hardcode `NODE_USE_ENV_PROXY=1` with
`127.0.0.1:10808`. Measured on the Phase 6 host:

```
direct  https://opencode.ai/zen/v1/models   200, repeatedly
proxied via 127.0.0.1:10808                 000, repeatedly
```

A Node fetch through it dies with a bare `fetch failed`, which the bridge reports
as `error:fetch failed` — naming neither proxy nor port, so it reads like a
credential or route fault. The runner therefore leaves the proxy off unless
`EF_USE_PROXY=1` is set. **The opt-in default is right; the value is per host.**

The Phase 7 host measured the opposite, and the way it was missed matters:

```
Node, direct               0/10   (9 x ECONNREFUSED, 1 x ETIMEDOUT)
Node, via 127.0.0.1:10808  5/5    HTTP 200
curl, direct               200
```

`opencode.ai` publishes nine A records and **four refuse TCP 443**. `curl` walks
the address set and falls back, so it reports 200 and looks healthy. Node's
`fetch` does not fall back — and the EF bridge is Node. So the old precondition
("route reachable directly, checked with curl") passed on a host where every
model call failed.

**Check the route with the bridge's own transport, not with curl:**

```bash
node scripts/check-route.mjs
```

It POSTs to the same endpoint the adapter does, over the same Node `fetch`, with
the proxy environment the runner exports, and reports the failure classes
(`ECONNREFUSED`, `ETIMEDOUT`, …). `scripts/run-lhtb.sh` now runs it before Harbor
pulls anything, so a transport fault is found in seconds rather than after the
episode budget — override with `EF_SKIP_ROUTE_CHECK=1` if you deliberately want
to run against a down route.

Set `EF_USE_PROXY=1` when that check fails directly but succeeds through a proxy.
Verify the proxy answers the same check first; a proxy that answers `curl` and
not this is the same trap one layer down.

### 2.2 Container memory is the binding constraint

The `economy` cell ended with Harbor's `AddTestsDirError` and a compose teardown
returning `3221225794` (`STATUS_CONTROL_C_EXIT`), with the container pinned at
**4 GiB / 4 GiB** for over an hour. The EF side had already finished cleanly
(`finish: stop`, 15 folds, nothing pending) — the failure came in Harbor's
post-run step.

If that reproduces, it is a resource decision, not a code defect. Raising a task's
declared memory changes the benchmark's own envelope, which is the benchmark's
call. Record it as a constraint rather than editing `task.toml`.

### 2.3 The 180-minute cap — FIXED, do not reintroduce it

PR #1's `lhtb-ef-sweep.yaml` set `override_timeout_sec: 10800` (180 min) with the
comment "the task's own agent budget is the real limit; this bounds a runaway
loop". The task declares `timeout_sec = 14400` (**240 min**), so 10800 was not a
bound above that budget — it was 25% *below* it. Measured consequence in the Phase
6 probe: **every timeout row sat at 180/181 minutes**, so that cap, not the task,
is what ended those trials.

Both configs on `main` now use `14400`. If a future revision lowers it, say
explicitly that it is a self-imposed constraint rather than claiming it defers to
the task.

---

## 3. What to run

The sweep and oracle configs are now **on `main`**, brought forward from PR #1
(docs/51):

```bash
ls eval/lhtb/            # lhtb-ef-probe.yaml, lhtb-ef-sweep.yaml, lhtb-ef-oracle.yaml
```

**The 180-minute cap has already been fixed** — both configs now use
`override_timeout_sec: 14400`, matching the task's own `timeout_sec`. See §2.3 for
why that mattered.

One thing to know before sweeping: `n_concurrent_trials: 2` in the sweep config is
set from the **measured** steady state (193 MiB and 16 MiB held, against limits of
8 GiB and 4 GiB), not from the declared limits. That reasoning is host-independent,
because a `memory_mb` is a cgroup limit and not a reservation.

**The cap itself is a property of the host, so check it rather than trusting a
number here or in a config.** This document named one — 8 GB, "verified three
ways" — and it was a measurement of a different machine; the Phase 7 host grants
substantially more. Ask the machine:

```bash
docker info --format '{{.MemTotal}}'     # bytes the runtime will actually hand out
```

`tests/lhtb-parallelism.spec.ts` now reads that value, compares the measured cells
against it, and **skips rather than passes** where the host cannot be asked. It also
forbids a numeric cap in any committed config or in the runner, because a file that
ships to other machines cannot state one.

Then, per the Phase 6 gate:

```bash
# one arm per invocation, by design: EF_LHTB_ARM is read from the environment,
# and the tau2 lane already showed that separate per-arm provider windows
# masquerade as mode effects.
for arm in basic economy balanced quality; do
  LHTB_ROOT=<checkout> EF_LHTB_ARM=$arm bash scripts/run-lhtb.sh sweep
done
```

**Arms must be blocked, not run back-to-back.** Harbor blocks on (task,
replicate) and shuffles within the block; four separate jobs over four provider
windows is what the sweep yaml's own comment warns against. If the runner cannot
express that, one arm per invocation is the compromise — but then say so in the
report, because it is a real limitation on attribution.

---

## 4. What to record

Every run now writes `ef-lhtb-transcript/1` beside Harbor's logs, with a
provenance block (relative locator + revision + dirty flag — deliberately **no
filesystem path**, because a tracked archive naming one machine's layout fails
the release gate).

Read these fields, and treat an inconsistency as a finding rather than noise:

| field | means |
|---|---|
| `folds`, `roots`, `emergencies` | engine lifetime counters, per mode |
| `bundleWrites` | bundles **published** — can exceed committed folds, by design |
| `bundlesPresent` | bundles on disk; `null` if the store was unreadable |
| `pendingIntents` | **must be 0 at episode end**; non-zero means a producer with no consumer |
| `pressureRegime` | the regime the last automatic decision resolved |
| `foldFailures` | folds that THREW; **must be reported**, and a non-zero value needs reading |
| `lastFoldError` | the most recent fold failure's message, or `null` |

Two invariants to check on every cell:

1. **`bundleWrites >= folds + roots + emergencies`**, never less. The reverse gap
   would be a surface replacement with no archive — data loss.
2. **`pendingIntents == 0`** at the end. Non-zero is the I3 violation made
   visible.

A third reading, not an invariant: **`foldFailures` must be quoted whenever it is
non-zero.** A failed fold no longer ends the episode (see below), so an arm that
folded 15 times while failing 12 of them would otherwise look identical to one
that folded 15 times cleanly.

For a `basic` arm, **`bundleWrites` and `bundlesPresent` must both be 0**. Real
DSH Basic has no bundle store. A non-zero count there means the arm is not Basic —
which is exactly what every pre-RC23 run reported (3, 4, 15).

### A failed fold used to be reported as a failed TASK

The Phase 7 `basic` arm died at turn 62 with:

```
ef_bridge_client.BridgeError: summarization truncated at the token cap
(incomplete checkpoint)
```

That is a FAILED FOLD. It ended the trial at reward 0 because `bridge-host.ts`
called `compactIfNeeded` with no try/catch, so the error propagated out of the
step loop. Production does not behave that way: `src/basic/index.ts` registers
`agent/pre-step` and wraps its own call in a catch that logs
`step compaction failed: …; continuing the turn`.

The harness now contains the failure and records it as `foldFailures` /
`lastFoldError`, and bounds each fold with a wall-clock deadline
(`EF_TAU2_FOLD_TIMEOUT_MS`, default 600s) — previously the fold's signal was an
`AbortController` that was created and never aborted, which is how one fold
stalled for 16 minutes with no error and both processes alive.

**Consequence for reading the Phase 7 numbers.** The "62 model calls then died"
row is evidence about the harness, not about Basic's summarization quality, and
it should not be cited as either. Whether Basic's checkpoint body is genuinely
too large for this model is still open — it now surfaces as a `foldFailures`
count with the run continuing, which is the measurement that can answer it.

---

## 5. What not to claim

- **No arm ranking from one replicate.** The tau2 lane produced three sweeps with
  three different winners on n=24. A single LHTB sweep is weaker than that.
- **No cost claim across arms.** Phase 6 measured `economy` at $0.20 for 230
  model calls and `basic` at $0.05 for 43 — different amounts of work attempted,
  so the figures are not comparable.
- **No claim that a difference is attributable to the mode** unless the arms were
  blocked (§3) and the container budget was identical (§2.2).
- **No re-use of the old `roots=0` finding.** It was produced by a harness with no
  idle consumer and a `roots` detector that could never fire. Both are fixed;
  `roots` now comes from the engine's own counter.

---

## 6. The state you are starting from

`main` at the RC23 commit:

- **887 passed, 23 skipped, 0 failed**; three typecheck projects clean.
- Phase 6, two cells on `unknown-config-semantics`:
  - `basic` — completed clean, 43 model calls, 46 shell calls, `bundleWrites` 0
  - `economy` — EF side clean, 230 model calls, 15 folds, stages A/C/D solved
- Three harness defects fixed, all found by running it: the forced-on proxy, the
  2000-token summarization budget that truncated Basic checkpoints, and the span
  guard that compared surface nodes against archived messages.

The lane is runnable and the harness now measures the production configuration.
What it has not produced is a sample.
