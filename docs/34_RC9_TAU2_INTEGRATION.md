# RC9 — τ²-Bench-Verified Integration

**Status:** adapter gate passed (4/4 cells); 96-episode sweep executed.
**Headline result: no arm separation.** See §6.
**Position:** the **Interaction-State / reliability** verification line. It does
NOT replace the LHTB LongWork line, which remains serial and single-cell on this
host.

---

## 1. What was built, and why it is shaped this way

τ²-Bench-Verified is Python. The Epistemic Fold is a TypeScript context runtime
for DSH. They cannot be linked in-process, so the integration is a **bridge**:

```text
tau2 orchestrator (Python)          EF bridge host (Node, one per episode)
  │                                    │
  │  user/tool message ──────────────► │  append to DSH session
  │                                    │  fold if over threshold
  │                                    │  call the model on the FOLDED surface
  │  ◄──────────── assistant message ─ │
  │                                    │
  └─ official DB x COMMUNICATE grader ──┘   (never sees EF)
```

### The rule that shaped everything

**The model call happens on the Node side.** It would have been far simpler to
let tau2 call the provider and mirror the transcript across for telemetry — but
then the fold would run *after* the model had already seen the unfolded context,
and the experiment would measure nothing. The request is therefore built from
`surfaceMessages(session)`, so the model sees exactly what the fold chose to show
it.

### The seam that makes it possible

tau2's agent protocol is clean:

```python
agent.generate_next_message(message, state) -> AssistantMessage
```

One call produces ONE message, either text or tool calls; the orchestrator
executes the tools and calls back. So one round trip per turn is sufficient, and
the bridge needs no knowledge of tau2's internals.

### Process shape

One Node host per episode, kept alive across turns so the session, fold state and
bundle store persist — restarting per turn would reset the very state under test.
Communication is newline-delimited JSON over stdin/stdout: no port, no
dependency, and nothing left behind if the parent dies.

---

## 2. What the benchmark owns, and what EF owns

| Concern | Owner |
|---|---|
| Tasks, policies, tools, user simulator | tau2 (untouched) |
| The score (`DB × COMMUNICATE`) | tau2 (`evaluate_simulation`, `EvaluationType.ALL`, unmodified) |
| Which arm runs | the runner |
| What the model sees | **EF** |
| Why a run failed | EF classifier, reported separately |

The user simulator runs through tau2's own litellm path, **not** through the EF
bridge. That is deliberate: the simulated customer must behave identically in
every arm, so it cannot be the thing the fold influences. Only the agent's
context runtime varies.

---

## 3. The adapter gate

Run before any sweep, on `retail/22` (partial rollback) and `airline/42`
(cross-object temporal consistency) × `basic` + `economy` × 1 run. All four
conditions verified:

| # | Condition | Result |
|---|---|---|
| 1 | Official Verified environment resets correctly | ✅ `set_state` + policy load verified |
| 2 | DSH Basic / EF backends actually switch by arm | ✅ `basic` mounts the real Basic engine; tiers mount EF presets |
| 3 | Official `DB × COMMUNICATE` grader runs as-is | ✅ called with `EvaluationType.ALL`, never wrapped |
| 4 | EF adds telemetry only, never alters the outcome | ✅ telemetry reported in its own table |

Gate result: **4/4 cells completed**, one `reward=1.00` with `DB=1.00` and
`COMMUNICATE=1.00` through the official grader.

---

## 4. Four real defects the gate caught

Every one of these was found by running, not by reading, and each would have
silently corrupted a sweep:

1. **The user simulator has no model.** `orchestrator.set_seed` seeds BOTH agent
   and user, and tau2's `BaseUser` raises `"LLM is not set"` without one. Every
   cell died at step 0. Fixed by routing the user simulator through the same
   endpoint with its own litellm args.

2. **`isError: undefined` fails the session's JSON check.** Omitting the field
   leaves it `undefined`, and DSH rejects any event carrying a value that does
   not survive a lossless JSON round trip. The error named the whole event
   ("non-JSON-serializable data"), pointing at the payload rather than at the one
   absent boolean. This cost two debugging rounds because the first hypothesis
   (`-0` in tool output) was plausible and wrong.

3. **A whitespace-only assistant message is invalid.** tau2's `has_text_content`
   strips before testing, so my `' '` placeholder failed validation and aborted
   the episode. Now a visible `(no response)` is sent, so the event stays legible
   in the transcript instead of being hidden behind a silent retry.

4. **Telemetry was discarded by `stop()`.** tau2 calls `stop()` at the end of
   every episode, *before* the caller can read anything off the agent. Clearing
   `self._bridge` there threw away the whole telemetry record — which is why the
   first successful gate run reported real benchmark rewards alongside `folds=0,
   calls=0`. The benchmark numbers were right; the diagnostic column was empty.

A fifth, caught before it could matter: the arm was originally read from an
environment variable. Concurrent cells run in threads of one process, so that is
shared mutable state — two cells with different arms would race. The arm is now
passed explicitly to the constructor.

---

## 5. Scheduling

Blocks are `(task, replicate)`; **arms are shuffled within each block**. Running
`basic × 24, then economy × 24` would let provider drift over the run masquerade
as a mode effect: whichever arm ran during a degraded window looks worse.
Blocking spreads that drift across arms instead of concentrating it.

```text
retail/22 rep0:  economy, quality, basic, balanced   (random order)
retail/22 rep1:  balanced, basic, quality, economy   (re-randomized)
...
```

`--purpose quality` permits concurrency (6). `--purpose cost` **refuses**
concurrency > 1 and exits non-zero, because concurrent cells share the provider
prefix cache and no per-arm cost can be isolated.

---

## 6. The 96-episode result

6 tasks × 4 arms × 4 replicates = 96 episodes, seed 20261001, concurrency 6,
`purpose=quality`. **All 96 completed; zero cell errors.**

### Headline — the benchmark's own metrics

| arm | n | pass^1 | pass^2 | pass^4 | DB | COMM | meanR |
|---|---:|---:|---:|---:|---:|---:|---:|
| basic | 24 | 0.62 | 0.50 | 0.50 | 0.62 | 1.00 | 0.62 |
| economy | 24 | 0.75 | 0.61 | 0.50 | 0.75 | 1.00 | 0.75 |
| balanced | 24 | 0.58 | 0.39 | 0.33 | 0.58 | 1.00 | 0.58 |
| quality | 24 | 0.62 | 0.44 | 0.17 | 0.62 | 1.00 | 0.62 |

### The reading: no arm separation

`economy` leads `basic` by 0.125 on pass^1. **That is not a finding.** A blocked
permutation test (20,000 resamples, shuffling arm labels within each
(task, replicate) block) gives **p = 0.164**.

The reason is visible in the variance decomposition:

| source | range |
|---|---:|
| task-level success (pooled over arms) | 0.06 … 1.00 (**0.94**) |
| arm-level success | 0.58 … 0.75 (**0.17**) |

**Task difficulty varies 5.5× more than any arm effect.** With six tasks, one
task flipping moves an arm's pass^1 by 1/24 = 0.042, so the sample cannot
resolve a difference of this size. This is the same defect the earlier custom
suite had, now measured on a mature benchmark with a grader we did not write.

### The selection rule applied to its own result

The interaction lane was originally selected **without** route-conditioning —
the very error corrected for LHTB in RC8. Measuring the route's actual
performance shows four of the six tasks sit outside the 0.15–0.85 band:

| task | route success | verdict |
|---|---:|---|
| `retail/18` | 0.44 | **discriminator** |
| `retail/5` | 0.56 | **discriminator** |
| `retail/22` | 0.88 | saturated → anchor |
| `airline/11` | 0.94 | saturated → anchor |
| `retail/21` | 1.00 | saturated → anchor |
| `airline/42` | 0.06 | **floored → excluded** |

`airline/42` is the clearest case: at 0.06 it was dragging every arm's headline
down by an equal and uninformative amount, adding cost without adding signal.
Restricted to the two in-band tasks, the ordering is unchanged
(`economy`/`quality` 5/8, `basic`/`balanced` 3/8, n=32 — still far too small).

The manifest now carries these measured bands and roles, and
`tests/selectbench-manifest.spec.ts` enforces the same rule on this lane that it
enforces on the LHTB lane.

### Why zero folds is correct here

`folds = 0` for every arm, and that is the **expected** outcome:

```text
fold threshold = contextWindow x thresholdRatio = 32,000 x 0.5 = 16,000 tokens
observed peak  = 3,000 - 5,000 tokens
```

An earlier decision stands: τ² must **not** be shrunk-window-forced into
folding, because that would stop being the benchmark. So this lane answers
**interaction reliability**, not long-context differentiation — and the honest
reading is a **non-regression result**: the modes are indistinguishable at this
context pressure, which is not evidence of equivalence in general.

### What the run did establish

1. **The integration is sound.** 96/96 episodes ran through the stock
   orchestrator, user simulator and `DB × COMMUNICATE` grader, with the model
   seeing the EF-managed surface. Every arm mounted its own runtime.
2. **`COMMUNICATE = 1.00` for all four arms.** No mode damaged the agent's
   ability to communicate correctly — the failure channel is entirely `DB`.
3. **All failures are `db-only` and all terminations are `USER_STOP`.** No
   `AGENT_ERROR`, no premature stop, no transport failure. Every failure is the
   agent failing to reach the required database state, which is the benchmark
   doing its job.
4. **Cost is near-identical** (0.0029–0.0038 per episode), so no arm is buying
   its result with more compute.

### What it did not establish

Nothing about the tiers' long-context value. That is the LHTB lane's question,
and it remains open and serial on this host.

---

## 7. Reproducing

```bash
# one-time: install the benchmark (Python >=3.12,<3.14; uv)
git clone https://github.com/amazon-agi/tau2-bench-verified.git
cd tau2-bench-verified && uv sync

# adapter gate (4 cells)
bash scripts/run-tau2.sh gate

# the selected 6-task reliability run (96 episodes)
bash scripts/run-tau2.sh sweep --replicates 4 --concurrency 6 --purpose quality
```

The credential is read at runtime from DSH's store and never printed, written, or
passed as an argument. `TAU2_ROOT` overrides the benchmark checkout location.
