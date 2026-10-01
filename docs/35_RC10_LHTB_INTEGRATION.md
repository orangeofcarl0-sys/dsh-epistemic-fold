# RC10 — LHTB Integration (the LongWork lane)

**Status:** bridge and adapter built; oracle smoke running.
**Position:** this is the lane that tests EF's actual claim — sustained work over
hundreds of steps. τ² covers interaction reliability; this covers long work.

---

## 1. The architectural fact that decides everything

Harbor agents run **on the host** and drive the container through
`environment.exec(command=...)`. The agent does *not* run inside the container.

This is not a detail. Every LHTB task sets:

```toml
allow_internet = false
```

So a container-resident agent could not reach any model at all. Because the loop
is host-side, the model call can happen in the EF bridge exactly as it does for
τ² — against the folded surface. The same bridge host serves both lanes; only the
Python driver differs.

```text
Harbor trial (host)                    EF bridge host (Node, one per episode)
  │                                      │
  │  instruction ──────────────────────► │  append to DSH session
  │                                      │  fold if over threshold
  │                                      │  call model on the FOLDED surface
  │  ◄──────────────── tool_calls ────── │
  │                                      │
  │  environment.exec(command)           │
  │  (inside the container)              │
  │  ──────────────────────────────────► │  append tool result
  │                                      │
  └─ official hidden verifier ───────────┘   (never sees EF)
```

## 2. Zero modification to the benchmark

Harbor's `AgentConfig` accepts an `import_path` (`"module:Class"`), and
`AgentFactory.create_agent_from_import_path` builds it directly. So the LHTB
checkout stays pristine — `git status` on it shows only `__pycache__` — and the
arm is selected by pointing the config at the EF module.

```yaml
agents:
  - import_path: "ef_lhtb_agent:EFLhtbAgent"
    model_name: openai/space-bunny-free
```

## 3. Serial by hardware, not by choice

| resource | LHTB task wants | this host |
|---|---:|---:|
| RAM | 4–8 GB per task | **8 GB total** (WSL cap) |
| CPU | 2–4 | 12 available |
| agent budget | up to 6 h | — |

`n_concurrent_trials: 1` is therefore a hardware limit. **A parallel LHTB run is
not possible here**, which is precisely why τ² carries the statistical work and
this lane is a probe.

## 4. The task, and why it is the right one

`unknown-config-semantics` is one of the two **discriminators** in
`bench/ef-selectbench-v1.json` for this route (published reward 0.50, inside the
0.15–0.85 band). The saturated tasks were excluded in RC8 precisely because they
cannot show a difference.

It is also the most EF-shaped task in the set. From its own description:

- five stages unlock **in order** (A → B → C → D → E);
- the spec is *deliberately noisy and partly wrong*, with "contradicting
  revisions that drop as it progresses — each revision fixes an old lie while
  sometimes planting a new field-specific one";
- stage D fields are **computed from already-resolved A/B/C values**, so "an
  earlier mistake resurfaces";
- the verifier "credits a field only if its stage's STAGE_PASS is present".

That is a direct test of whether earlier discoveries survive to the end and
whether a superseded fact stays superseded — the exact thing EF exists to do.

## 5. The pacing, which is a property of the task

The oracle reference solution "intentionally takes on the order of
`sum(stage rounds) * min_interval_sec` of wall-clock — that is the point."

Measured from the running container: `min_interval_sec = 50`, `rounds = 21` per
stage, 5 stages. So the reference solution needs **~1.75 hours**, and a live
agent run needs at least that. A run that looks "stuck" at 0% CPU is the task's
time-floored gate working as designed — verified by watching
`/opt/cfg/runs/actions.log` advance stage by stage.

## 6. What the probes established

The oracle smoke **passed end to end**: reward 1.0, 5/5 stages (A→B→C→D→E), 696/696
fields across 58 cases, in ~1.75 h. That validates Docker, the staged gate
structure, and the official hidden verifier — none of which EF touches.

The EF-driven runs then established that the integration works and produced four
real defects, each found by running rather than reading. Every one would have
silently corrupted a measurement:

1. **An empty model response was treated as task completion.** The first
   diagnostic run scored 0 after only 14 shell calls because the loop read "no
   tool calls" as "the model is done". One blank completion silently ended a task
   budgeted in hours. An empty reply is now an anomaly to nudge past; only a
   sustained streak ends the loop. After the fix the same task ran 101 shell
   calls with 8 folds.

2. **`retainTokens: 0` was the opposite of a neutral default.** DSH Basic's own
   default is `retainRatio 0.16`. Pinning the token form to zero made every fold
   retain *nothing*, so the agent re-read the same files repeatedly — `spec.md`
   seven times, `engine.py` six times. That is a property of the configuration,
   not of the mode under test. The field is now omitted for every arm.
   (This never affected the tau2 sweep: that run folded zero times, so the
   setting could not take effect.)

3. **A transport failure was indistinguishable from a silent model.** A run
   produced five consecutive empty replies with `costTotal 0`; reproducing the
   same call moments later returned proper tool calls, and the log showed the
   local proxy saturated. The bridge now reports the stream's finish reason, so
   `error:fetch failed` is visibly different from the model declining to act.

4. **Harbor reuses a job directory and reports the stale result.** A second
   invocation exited in 60 s while printing "Total runtime: 29m 31s" and the
   previous run's reward. Each run now gets a timestamped job directory.

A fifth, operational rather than logical: the bridge host's stderr was a pipe
drained only on crash, so a live failure left no trace. It now goes to a file.

### The result, and what it means

With the wiring verified, the runs scored **reward 0, 0 stages, 0 submits** — and
the transcript shows why. Across 38–101 shell calls with 3–8 folds, the agent
spent its budget reading `spec.md`, `cfg_daemon.py` and the data pools, and
**never modified `/opt/cfg/engine.py`** (`cmp` against `engine.orig.py` stayed
identical). It never reached `cfg probe`, so no stage gate could pass.

That is a statement about the model's approach on this task, not about the
harness: the loop ran, folded, executed commands, and was graded correctly. It is
also the honest baseline — the published route reward for this task is 0.50
*with* the full 90-minute budget and a harness that continues until timeout,
which this probe does not replicate.

**What is proven:** DSH's Basic and EF runtimes mount inside a real LHTB trial,
fold a long transcript (checkpoints carry "Folded 30 message(s)" with the exact
history archived for `context_recall`), execute commands through Harbor's
official environment, and are graded by the official hidden verifier.

**What is not:** any comparison between arms. That needs the same probe repeated
per arm, and this host runs one LHTB cell at a time.

## 7. Reproducing

```bash
# one-time: install the bundled (LHTB-patched) Harbor
cd lhtb/harbor && uv venv --python 3.13 .venv && uv pip install -e .

# validate Docker + the official verifier with NO API key
harbor run -c configs/examples/oracle_smoke.yaml

# the EF probe, serial, one task, one arm
bash scripts/run-lhtb.sh probe
EF_LHTB_ARM=economy bash scripts/run-lhtb.sh probe
```

`LHTB_ROOT` overrides the benchmark checkout. The credential is read at runtime
from DSH's store and never printed, written, or passed as an argument.
