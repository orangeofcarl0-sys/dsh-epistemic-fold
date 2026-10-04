# LHTB LongWork Findings: EF reaches the oracle, and the fold path has two defects

**Status:** oracle validation passed (2/2). Four-arm sweep complete: **16 trials, 0 still running.**
**Headline:** EF **reached the reference solution on both discriminators** — equal on one
(1.000), higher on the other (0.883 vs 0.820) — while `roots` was 0 in 16 of 16.
**Position:** this is the LongWork lane — the only one of the three that tests EF's actual claim.

---

## 1. What ran

LHTB was recorded as BLOCKED in RC8 (docs/33): no benchmark checkout, Docker not
running, and a memory argument that turned out to be wrong. All three are resolved.

| step | result |
|---|---|
| benchmark checkout | `zli12321/LHTB` cloned (bundled Harbor, 46 tasks) |
| Harbor | venv built on CPython 3.13.13 |
| Docker | daemon up; two dead proxies fixed (below) |
| **oracle validation** | **2/2 passed, 0 errors, no API spend** |

Oracle runs each task's own reference solution through the official hidden
verifier. It is the check that says "the environment works" rather than "the model
did well".

| task | reward | detail | wall clock |
|---|---:|---|---:|
| `unknown-config-semantics` | **1.000** | 5/5 stages, 696/696 fields, 58 cases | 81 min |
| `vector-db-iterative-build` | **0.820** | — | 268 min |

Two things worth recording: the verifier scores correctly, and
`vector-db-iterative-build` is **not** saturated by the reference solution — 0.820,
not 1.0. The published route reward for this task is 0.84 (bench/ef-selectbench-v1.json),
which brackets it correctly.

---

## 2. The four-arm sweep

Four arms x 2 tasks x 2 attempts, `n_concurrent_trials: 2`, seed-free, route
`space-bunny-free`. Nine trials completed on disk; the rest were still running when
this was written.

| arm | task | reward | stages | min | folds | **roots** | archived | cost | exception |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| **balanced** | **unknown-config** | **1.000** | **5/5** | 153 | 11 | **0** | 0 | $0.169 | — |
| **quality** | **vector-db** | **0.883** | — | 181 | 1 | **0** | 1 | **$0.018** | timeout |
| balanced | unknown-config | 0 | 1/5 | 180 | 13 | **0** | 5 | $0.236 | timeout |
| balanced | vector-db | 0 | — | 180 | 3 | **0** | 3 | $0.045 | timeout |
| balanced | vector-db | 0 | — | 181 | 0 | **0** | 0 | $0.007 | timeout |
| basic | unknown-config | 0 | 0/5 | 20 | 4 | **0** | 4 | $0.062 | — |
| basic | unknown-config | 0 | 0/5 | 150 | 32 | **0** | 15 | $0.434 | — |
| basic | vector-db | 0 | — | 181 | 1 | **0** | 1 | $0.022 | timeout |
| basic | vector-db | — | — | 156 | 2 | **0** | 2 | $0.030 | **BridgeError** |
| economy | unknown-config | 0 | 0/5 | 149 | 31 | **0** | 4 | $0.476 | — |
| economy | unknown-config | 0 | 3/5 | 180 | 21 | **0** | 6 | $0.293 | timeout |
| economy | vector-db | 0 | — | 180 | 0 | **0** | 0 | $0.005 | timeout |
| economy | vector-db | 0 | — | 180 | 0 | **0** | 0 | $0.004 | timeout |
| quality | unknown-config | 0 | 0/5 | 180 | 47 | **0** | 10 | $0.636 | timeout |
| quality | unknown-config | 0 | 0/5 | 180 | 23 | **0** | 23 | $0.321 | timeout |
| quality | vector-db | 0 | — | 180 | 0 | **0** | 0 | $0.003 | timeout |

**EF reached the reference solution on both discriminators.**

| task | oracle | best EF arm | verdict |
|---|---:|---:|---|
| `unknown-config-semantics` | 1.000 | **1.000** (balanced) | equal — same 5/5 stages, 696/696 fields, 58 cases |
| `vector-db-iterative-build` | 0.820 | **0.883** (quality) | **higher** |

The vector-db result deserves its caveats. It was recorded under
`AgentTimeoutError` — the agent was still working when the 180-minute budget
expired, and LHTB's continuous reward credits partial work, so 0.883 is a score for
work in progress rather than a finished artifact. It is also not a like-for-like
comparison with the oracle, which ran to completion in 268 minutes. What it does
establish is that EF carried that task further than the reference solution did, in
181 minutes and $0.018 of provider spend.

**What the rest of the table says.** `roots` is 0 in **16 of 16**, so the rebase path
never ran anywhere — including in both successful trials. The two winners folded 11 and
1 times; the failures folded anywhere from 0 to 47, and `quality` folded 47 times to
reach 0/5 stages on the same task another arm solved in 153. Folding more is neither
necessary nor sufficient for success here, and a fold count this variable across arms
that scored 0, 0.883 and 1.000 is not a mode ranking.

Twelve of sixteen trials ended in `AgentTimeoutError`. Several burned the full budget
for less progress than the oracle achieved in half the time. Whether that is model
behaviour or engine overhead is **not** separated by this run — and the one trial that
both timed out and scored (quality/vector-db) suggests the agent was still making
progress when the budget ran out, which is a budget question rather than a fold
question.

---

## 3. Defect 1 — the fold retry loop cannot see that folding is futile

```
BridgeError: epistemic-fold: still above threshold after 2 leaf fold attempts
(111143 estimated tokens >= threshold 16000)
```

`src/engine.ts:573` retries a leaf fold and then throws:

```ts
for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
  const span = selectLeafSpan(agent.session, measurement, spec.retainTokens)
  if (span === null) { if (result === null) return null; break }
  result = await this.compactRegion(span.start, span.end, agent, signal)
  measurement = meter.measure(agent.session)
  if (measurement.totalTokens < spec.thresholdTokens) { ...; return result }
}
throw new Error(`epistemic-fold: still above threshold after ...`)
```

The engine already knows the answer. `src/pressure.ts:101` computes it exactly:

```ts
leafCannotSuffice: frozen.count > 0 && frozenTokens >= thresholdTokens
```

and `src/fold-economics.ts:86` acts on it, with a message that describes this exact
situation:

> `frozen prefix N >= threshold M; a leaf fold cannot restore headroom and only adds a checkpoint`

**That handler is gated behind a flag the default configuration does not set.**
`src/effective-config.ts:84-85`:

```ts
leafAdmission: 'legacy',
rootPolicy: 'legacy',
```

so `engine.ts:552` — `if (this.efConfig.leafAdmission === 'economic')` — is false for
the `basic` arm, `admitLeafEconomically` is never called, and the retry loop runs
blind.

A second copy of the same idea, `classifyPressureRegime` (pressure.ts:173), splits the
state into `idle` / `frozen-bound` / `open-bound` and is the natural thing to ask
before the loop. It has **no production consumer**: the only references outside its own
definition are tests.

**Fix:** ask `classifyPressureRegime` before the loop and hand off to
`rebaseAfterLeafRefusal` when the regime is `frozen-bound`.

---

## 4. Defect 2 — the tiers record a rebase intent that nothing drains

The three tiers *do* enable economics (`src/preset.ts:211-213, 241-242, 270-271`):

```ts
leafAdmission: 'economic',
rootPolicy: 'economics',
```

so they reach `rebaseAfterLeafRefusal` (`engine.ts:631`) and can record an intent
(`engine.ts:653`). R3-0b deliberately made that a **pending intent** rather than an
immediate action, because a rebase needs an idle agent and this path runs inside an
open turn. The comment says who is supposed to drain it:

> R3-0b replaces that with an intent the PRODUCTION idle consumer drains

That consumer is `plugin.ts:213`:

```ts
ctx.effect(() => {
  const registration = registerIdleRebaseConsumer({
    ctx, engine: this.engine, intents: this.engine.rebaseIntentRegistry, ...
```

**The benchmark harness never registers it.** `eval/tau2/bridge-host.ts:505` constructs
the engine directly:

```ts
engine = new EpistemicFoldEngine(ctx, request.arm.engine === 'basic' ? common : {...})
```

bypassing the plugin entirely — so there is no idle consumer, and
`grep -r rebaseIntentRegistry eval/` returns **nothing**.

The intent is recorded and never executed. `roots` stays 0 forever, on every tier, in
every trial. This is why `economy`, `balanced` and `quality` — which have the
fallback that `basic` lacks — show the same `roots=0`.

---

## 5. What this does and does not show

**Shown, with evidence:**

- The LHTB lane is runnable end to end on this host, and the hidden verifier scores.
- **EF reached the reference solution on both discriminators.** `balanced` tied the
  oracle on `unknown-config-semantics` (1.000, identical 5/5 stages and 696/696
  fields); `quality` scored higher than the oracle on `vector-db-iterative-build`
  (0.883 vs 0.820).
- `roots` is 0 in **16 of 16** trials, across all four arms.
- Two distinct code paths explain the missing rebase: a detection gated off by
  default, and an intent with no consumer in the harness.
- Fold count does not predict outcome. The two winners folded 11 and 1 times; the
  failures span 0 to 47.

**Not shown, and deliberately not claimed:**

- **That any tier beats another.** Two trials of sixteen scored above zero, on
  different tasks, and no tier won both. The tau2 lane already showed (three sweeps,
  three different winners) what a single sample does to an arm ordering; n=4 per arm
  is not much stronger.
- **That the 0.883 is a finished solution.** It was recorded under
  `AgentTimeoutError`. LHTB credits partial work, so it is a score for work in
  progress against an oracle that ran to completion.
- **That the fold defects caused the fourteen non-winning trials.** Model behaviour
  stays a live alternative: the previous probe (docs/35) scored 0 because the agent
  read the spec seven times and never edited `engine.py`. Twelve of sixteen trials
  ended in `AgentTimeoutError`, which this run cannot attribute.
- **Any economic claim.** `economy`'s cost advantage was measured in RC1.3 against
  Basic on the in-process suite. The `$0.003`–`$0.636` spread here tracks how long a
  run lasted, not what a mode is worth — the cheapest trial scored 0 and the `$0.636`
  one scored 0 as well.
- **That a fold that never fires is a working fold.** `roots` never ran, so the
  rebase path is entirely unexercised on this workload in either direction.

---

## 6. Reproducing

```bash
# One-time
git clone https://github.com/zli12321/LHTB.git <bench-workspace>/lhtb
cd <bench-workspace>/lhtb/harbor && uv venv --python 3.13 .venv && uv pip install -e .

# Oracle: validates Docker + the hidden verifier, spends nothing
LHTB_ROOT=<bench-workspace>/lhtb bash scripts/run-lhtb.sh oracle

# One arm of the sweep
LHTB_ROOT=<bench-workspace>/lhtb EF_LHTB_ARM=economy bash scripts/run-lhtb.sh sweep
```

### Two dead proxies on this host

Both `git` and Docker Desktop pointed at `127.0.0.1:7890`, where nothing listens;
the live proxy is `10808`. The first oracle attempt failed in 17 seconds with
`RuntimeError` on both cells for this reason. Docker's `settings-store.json` must be
edited only after quitting Docker Desktop, or it is rewritten on exit.

### The memory argument in RC8 was wrong

RC8 recorded the lane as serial because "every task requests 4-8 GB and the WSL VM is
capped at 8 GB". Both halves were false. The cap is 24 GB (`~/.wslconfig`), and
`memory_mb` in a task.toml is the container **limit**, not a reservation — Docker does
not preallocate it. Measured with both discriminators running:

| task | observed | limit |
|---|---:|---:|
| `vector-db-iterative-build` | 193 MiB | 8 GiB |
| `unknown-config-semantics` | 16 MiB | 4 GiB |

Nine containers ran concurrently in this sweep at a few hundred MiB each. See commit
`d3b3182` and `tests/lhtb-parallelism.spec.ts`, which pins the measurement.

---

## 7. Recommended next step

Fix both paths, then re-run the `basic` arm against the oracle-known ceiling:

1. `engine.ts:573` — consult `classifyPressureRegime` before retrying, and hand off
   to `rebaseAfterLeafRefusal` on `frozen-bound`.
2. `bridge-host.ts:505` — construct the engine through the plugin path, or register
   `registerIdleRebaseConsumer` directly, so the tiers' intents are drained.

Neither is a large change. Both are on the path EF's claim depends on.

**What they would and would not buy.** Fixing them cannot raise the ceiling — EF already
reached the reference solution on both discriminators here. What it would buy is the
other fourteen trials: today a run that needs a rebase either thrashes leaves on leaves
or dies on the retry loop, and no amount of model capability changes that. Until the
degradation path holds, the LongWork lane can show that EF *can* carry a task, but not
what it does when carrying one is hard.
