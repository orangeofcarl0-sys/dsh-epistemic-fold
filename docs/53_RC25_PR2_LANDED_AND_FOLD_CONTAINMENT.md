# RC25 — PR #2 landed, and its second blocker was the harness

This records bringing PR #2's real work onto `main`, and correcting the one
conclusion in it that would have sent Phase 7 in the wrong direction.

Starting point: `main` at RC24 (`7745dff`), **897 passed / 23 skipped / 0 failed**.
Ending point: **921 passed / 23 skipped / 0 failed**, three typecheck projects clean.

Nothing here is an EF result. No arm has completed a trial; there is still no
sample, and no arm ranking is claimed or implied.

---

## 0. Independent re-measurement found four defects in this work

The RC25 changes were re-tested on a second machine, which reported **0 failed and
green CI** but a different count: **911 passed / 28 skipped**, against the 916/23
claimed here. Five tests had moved from passing to skipped, all in
`tests/ef-collect.spec.ts`. Four defects were found in this work and all four are
fixed below: three came from that re-measurement, and the fourth (§0.4) surfaced
while re-checking this document's own claim about bounding folds.

Worth stating plainly, because it is the pattern this repository keeps hitting:
**the gate was green, and three of these were only visible from the count.** A
suite that reports 0 failed while silently skipping the checks that would have
failed is the `roots=0` mistake in a different costume — a number that could not
mean what it claimed, read as if it did.

### 0.1 The new collector gate silently degraded to skipped

The spec probed only `python3` / `python` on `PATH` and put its **entire** suite
behind `describe.skipIf`. On a machine whose `PATH` carries the Microsoft Store
execution-alias stubs, both names exist but exit **9009**, so the probe correctly
found no interpreter — and the whole gate became five skipped tests, including the
one whose only job is to assert the collector is in the repository and needs no
Python at all.

That is the exact gap the file was written to close, reproduced inside the fix for
it: a check nobody can run is not a check. Two changes:

1. The Python-free assertions moved to their own always-running `describe`, so
   "the collector is tracked and correctly referenced" is gated on every machine.
2. The probe searches harder (`EF_PYTHON`, `python3`, `python`, `py -3`, and the
   LHTB venv's interpreter) and requires the candidate to **execute** code rather
   than merely answer `--version`, which is what a Store stub can fake.

A skipped behavioural check is still a real limitation, so it now prints a warning
naming the interpreter options rather than passing quietly. Verified destructively:
with the interpreter forced unavailable, 3 checks still run and pass and the
degradation announces itself, where previously all 5 vanished.

The collector itself was never defective — the second machine ran all 15 assertions
against a real interpreter and they held. This was gate wiring.

### 0.2 The fold fix left the defect it was fixing on the line it fixed

`bridge-host.ts` passed the deadline through:

```ts
task(AbortSignal.any([deadline.signal, new AbortController().signal]))
```

Harmless at runtime — an `any()` with a never-aborting member is the deadline — but
it kept the **exact expression being fixed** on the **exact line being fixed**, so
grepping for `new AbortController().signal` hit the fix. A later reader could not
tell whether the fix had landed. It now passes `deadline.signal` directly.

`tests/harness-fold-containment.spec.ts` gained a detector for the real invariant:
not "no controller" (the deadline *is* one), but that every controller on the path
is one something actually aborts. Verified destructively by reintroducing the
leftover verbatim.

### 0.3 The route check described the environment, not the transport

`check-route.mjs` printed `proxy: enabled` whenever `HTTPS_PROXY` was set. Node
honours the proxy environment **only** with `NODE_USE_ENV_PROXY=1`, so with a bare
`HTTPS_PROXY` it printed "enabled" while connecting directly — measured: the
request reached the origin (HTTP 200) with the proxy pointed at a dead port.

An ironic failure for a tool built to stop a check from describing the environment
instead of the transport, which is what `curl` did. The label now reports three
states and names the trap explicitly:

```
proxy: not in effect — direct connection
proxy: NOT in effect — HTTPS_PROXY is set but Node ignores the proxy environment
       without NODE_USE_ENV_PROXY=1
proxy: in effect — Node will route via http://…
```

Each state is verified against real transport behaviour, not against the
environment: with the flag unset the request reaches the origin; with it set
against a dead port it fails `ECONNREFUSED`.

### 0.4 The idle rebase was still unbounded, so "each fold is bounded" was false

Found while re-checking this document's own claim. §3.2 says each fold is bounded;
that was true of the automatic pressure fold and **false of the idle rebase**,
which is also a fold — `compactNow` summarizes, and it builds its operation signal
as `AbortSignal.any([agentSignal, signal])` from the signal handed to it by
`runMaintenance`. The harness passed an un-aborted controller there, so the Phase 7
stall was still reachable through the other door.

Both paths now carry the same `FOLD_TIMEOUT_MS` deadline, and
`tests/harness-fold-containment.spec.ts` asserts each separately — verified
destructively by reverting only the idle-rebase bound, which fails that test and
leaves the pressure-fold test passing.

The remaining un-aborted controller in the harness is the EF recall tool call. It
is left as-is deliberately: it reads the local bundle store and makes no model
call, so there is nothing to bound and a deadline would be cargo cult.

---

## 1. What came forward from PR #2

PR #2 was opened against this repository and did three things: fixed the LHTB
runner's mode dispatch, reported the oracle gate, and reported two blockers. The
first is a real and severe defect and is now on `main`; the oracle numbers are
sound and are kept; the second blocker's diagnosis is corrected below.

### 1.1 The dispatch fix (severity: high, and silent)

`scripts/run-lhtb.sh` never read `$1`. It always passed `lhtb-ef-probe.yaml` — one
task, one attempt — regardless of what it was invoked as. The Phase 7 handoff's own
commands, `run-lhtb.sh sweep` and `run-lhtb.sh oracle`, would each have run a
single-task probe while printing a normal-looking run. An oracle gate invoked that
way would have "passed" proving nothing about the environment.

The fix dispatches on the first positional argument, rejects an unknown mode instead
of defaulting it, and puts **both mode and arm** in the job name — four sweep arms
share a mode and would otherwise collide on Harbor's `job_name` key, which makes
Harbor exit while reporting the previous run's reward.

`tests/lhtb-runner-dispatch.spec.ts` drives the real script against a hermetic
fixture: a fake `harbor.exe` that prints the config it was handed, a fake
interpreter that performs the credential read, and a throwaway credential file. It
asserts on the config Harbor actually read, not on the script's text — a text
assertion would pass against a runner that reads the mode and then ignores it.

Verified destructively: reintroducing the original defect fails four of the five
tests, and restoring the fix makes them pass.

### 1.2 An absolute invocation died before reaching the dispatch

Driving the script by absolute path — which is what the handoff tells an operator to
do — failed before any dispatch logic ran:

```
run-lhtb.sh: line 131: ...\scripts\run-lhtb.sh/proxy-env.sh: Not a directory
```

`${BASH_SOURCE[0]%/*}` cannot strip a **backslash** path, so the sourced
`proxy-env.sh` resolved to `...\run-lhtb.sh/proxy-env.sh`. The documented relative
invocation never exercised it. Both runners now derive their own directory with
`dirname`, and the dispatch spec invokes them by absolute path so it stays fixed.

`tests/tau2-bridge-contract.spec.ts` had pinned the broken expansion literally. Its
intent — "the runner sources the shared scrub" — is preserved; the assertion is now
on the source target and on the absence of the unportable expansion in executable
lines, with comments stripped, since both runners explain the old form in a comment.

## 2. Blocker 1 — the route needed a proxy, and `curl` could not say so

The first `basic`-arm probe returned reward 0.0 with every model call failing as
`error:fetch failed`. On that host, `opencode.ai` publishes nine A records and four
refuse TCP 443. `curl` walks the set and falls back, so it reports 200 and looks
healthy; Node's `fetch` does not fall back, and the bridge is Node:

```
Node, direct             0/10   (9 x ECONNREFUSED, 1 x ETIMEDOUT)
Node, via 127.0.0.1:10808  5/5  HTTP 200
curl, direct             200
```

The proxy was therefore correct **on that host**, and the opt-in default is the right
shape. The defect is the precondition: the handoff told the operator to verify
reachability with `curl`, and a `curl` 200 does not establish that the bridge can
reach the provider. That check would keep passing on hosts where every model call
fails.

`scripts/check-route.mjs` replaces it. It POSTs to the adapter's own
`/chat/completions` over Node's `fetch`, with the proxy environment the runner
exports, and reports failure classes (`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, …)
rather than the bare `fetch failed` that names no cause. `run-lhtb.sh` runs it
before Harbor pulls anything, so a transport fault costs seconds instead of an
episode budget; `EF_SKIP_ROUTE_CHECK=1` overrides it for a deliberate down-route run.

A 401 from the probe counts as REACHED. The question is whether the request arrives,
not whether it is authorised, and conflating the two would fail the check on a
credential problem the check cannot fix.

Verified on this host: 5/5 reached, HTTP 401, exit 0. Against an unreachable route:
0/2, `bad port`, exit 1, and the runner refuses to start.

The `proxy:` line reports what Node will actually DO, not what the environment
contains — see §0.3. Node ignores the proxy environment without
`NODE_USE_ENV_PROXY=1`, so a bare `HTTPS_PROXY` must not read as enabled.

## 3. Blocker 2 — CORRECTED: the harness killed the episode

PR #2 reported this as a budget problem:

> `ef_bridge_client.BridgeError: summarization truncated at the token cap
> (incomplete checkpoint)` — 8192 is not enough for Basic's checkpoint summary.

It then proposed either shrinking Basic's checkpoint body or bounding the
summarization call. **The first reading is wrong, and the first direction is not
available.**

### 3.1 Production survives a failed fold; this harness did not

`src/basic/index.ts` registers `agent/pre-step` and wraps its own `compactIfNeeded`
in a try/catch that logs `step compaction failed: …; continuing the turn`. A
truncated summary in real DSH is a **missed fold the agent works through**.

`bridge-host.ts` called the same method with no try/catch. The error propagated out
of `modelTurn`, became `{ok: false}`, raised `BridgeError` in the Python client, and
left `ef_lhtb_agent.run()` — ending the trial at reward 0 after 62 real model calls.

So that row is evidence about the harness, not about Basic's summarization quality,
and it is not cited as either. Reproduced directly against the engine in
`tests/harness-fold-containment.spec.ts`: a `max-tokens` summarizer over a
conversation large enough to fold throws exactly that message.

The fix matches production's semantics: the fold failure is counted
(`foldFailures`), its message is kept (`lastFoldError`, redacted like every other
error path), and the episode continues. Both fields are in the telemetry and
therefore in the `ef-lhtb-transcript/1` archive. `foldFailures` is a **reading, not
an invariant** — an arm that folded 15 times while failing 12 would otherwise look
identical to one that folded cleanly.

Containment is only safe if a failed fold leaves nothing half-applied. The engine
prepares a candidate and replaces the surface only after the summary lands, and the
test pins that: the surface is byte-identical after the throw, `bundleWriteCount`
and `leafFoldCount` are both 0.

### 3.2 The 16-minute stall had the same root cause

The fold's signal was `new AbortController().signal` — created and never aborted.
The adapter forwards `options.signal` to `fetch` and sets no timeout of its own, so a
single summarization had **no upper bound at all**. Raising the token budget
lengthens an unbounded wait; it cannot shorten it.

Each fold is now bounded by `EF_TAU2_FOLD_TIMEOUT_MS` (default 600s). 600s is from
measurement rather than taste: a legitimate 16384-token summary returned in 204s, and
the transport failed at 32768 after 305s — so 600s is ~3x the observed legitimate
worst case and still an order of magnitude under the episode budget.

**"Each fold" means both fold paths.** The first version of this fix bounded only
the automatic pressure fold and left the idle rebase open, which made the sentence
above false — see §0.4. The rebase summarizes too, so it carries the same deadline
now, and a test asserts each path separately.

(The first version of this fix passed the deadline through an `AbortSignal.any()`
alongside a second, never-aborted controller, which read as if the old defect were
still present. See §0.2.)

### 3.3 What is still open

Whether Basic's full-checkpoint body is genuinely too large for this model at 8192 is
**not settled**. It is now measurable — as a `foldFailures` count on a run that
continues — rather than as a dead trial.

The direction PR #2 proposed first ("make Basic's checkpoint body compact enough")
is not available as stated: every module under `src/basic/` is a byte-identity
enforced copy of the vendored reference (`tests/rc7-vendored-basic.spec.ts`) and says
"Do not edit to change behaviour" in its header. That would be a change to DSH's own
compaction, not to EF's harness.

## 4. The memory ceiling, finished

RC24 corrected a false 24 GB WSL cap to the measured 8 GB, but the correction reached
the spec, the runner and the probe config — not the sweep and oracle configs, which
are the two the Phase 7 sweep actually invokes. Both still told the reader the cap
was 24 GB while asserting a parallelism claim that only holds at 8.

The same measurement also appeared as three different numbers: 108 MiB, 193 MiB, and
"~125 MiB combined", against the spec's 192.8 MiB. Only one can be the measurement
recorded there, and the others were numbers nothing measured.

All three configs now state 8 GB with the three-way verification, quote 193 MiB and
16 MiB, and give the combined figure as the sum. `tests/lhtb-parallelism.spec.ts`
gained two gates: no config may repeat the 24 GB claim, and no config may quote the
superseded 108 MiB figure. Nothing read the yaml prose before, so nothing could fail
— which is why a wrong cap survived a correction that was already written down.

## 5. Two gaps in what Phase 7 could verify

**`docs/52` was not indexed.** The packaging gate checked `> 40` entries and that
indexed links resolve; it never checked the reverse. A new numbered document could be
added and never appear in the map, which is what happened. The gate now compares the
index against the directory, verified destructively.

**The collector was untracked.** The Phase 7 write-up cited `ef-collect.sh` as the
tool that performs the invariant check — so the verification step the handoff tells
the next operator to run was not in the repository. It is now `scripts/ef-collect.py`,
with the property that made it worth citing: a missing field is `MISSING` and its
dependent invariant is **skipped and counted as unverified**, never read as a passing
zero. The pre-RC23 archives have none of `emergencies`, `bundleWrites`,
`bundlesPresent`, `pendingIntents`, `pressureRegime` or `foldFailures`, and a missing
counter displayed as 0 is the old `roots=0` mistake again.

`tests/ef-collect.spec.ts` pins pass, skip and fail against three synthetic
transcripts, including a basic arm with non-zero bundles — the exact shape that made
every pre-RC23 "basic" row describe EF-legacy. Its structural assertions (the script
exists, is a Python program, and is named correctly by the documents that cite it)
run unconditionally, per §0.1: the first version of this gate skipped all of them on
a machine without a usable `PATH` Python, which reproduced the gap it was closing.

## 6. What is not claimed

- **No arm ranking, and no sample.** No arm has completed a trial.
- **No claim that the 62-call basic arm failed because of Basic's summary size.**
  That row is a harness defect (§3.1).
- **No claim about the provider's 4-of-9 dead A records being stable.** That is one
  lookup window, not a measurement of uptime.
- **No re-use of the old `roots=0` finding**, for the reasons in docs/49.
- **No `vector-db-iterative-build` attribution.** Its reference solution tops out at
  0.8327, so it cannot discriminate between arms; it is an environment check now.

## 7. State of the lane

Both Phase 7 blockers are addressed in code: the route is checked in the bridge's own
transport, and a fold failure is contained, counted and bounded. What remains is not
a code change — it is the container-memory constraint from Phase 6 (Harbor's
`AddTestsDirError` with the container pinned at 4 GiB / 4 GiB), which is a resource
decision for the benchmark rather than a defect in this repository, and the fact that
the arms must be **blocked** rather than run back-to-back.

With those acknowledged, `run-lhtb.sh sweep` can run the four arms on
`unknown-config-semantics`. Budget from measurement: the oracle's 87-minute agent
phase is the floor for one clean trial, so four arms at two replicates is on the
order of a day.
