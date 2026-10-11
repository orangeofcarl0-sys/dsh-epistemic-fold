# Measuring retention on long-horizon WIDE tasks

A design method for selecting and repairing benchmarks so that they measure what we
actually want, derived from the unknown-config-semantics repair in this session.

## 1. The measurement model, and its six failure modes

We want to know whether a context-compression runtime helps an agent sustain work on
a long-horizon, **wide** task. That sentence hides six ways a benchmark can fail to
answer it, and every one of them was observed here.

| # | Failure mode | What it looks like | Observed |
|---|---|---|---|
| F1 | **Shortcut** | a route to score that skips the intended work | 847 probe answers stored as unsalted sha256 of small integers; the best archived run scored 0.8894 with **zero** probes |
| F2 | **Optional capability** | the capability under test is not *necessary* for success | every needed fact was re-derivable by \`cat\` or a re-run, so retention never paid |
| F3 | **Binary reward** | outcomes collapse to 0 or 1, so effort is invisible | 40 archived engines with accuracy 0.37-0.89 were **all** recorded as 0 |
| F4 | **Strategy confound** | the score depends on the agent's policy prior, not its capability | exploration found the pool and won (0.8894 at 4 CLI calls) while the intended path lost (0.8333 at 159 probes) |
| F5 | **Irrelevant variance** | infra noise moves the score | 3 of 26 archived zeros were verifier failures, not agent failures; a provider ceiling of 12 was hit at hour 3 of an 8h run |
| F6 | **Non-reproducibility** | the number cannot be recomputed later | an early archive kept only \`actions.log\` and not the engines it graded |

## 2. The six principles

* **P1 Necessity.** No strategy that skips the intended capability may score as high.
  This is *protocol validity*.
* **P2 Dense and monotone.** Score is a monotone function of demonstrated capability,
  with an interpretable floor and a wide usable range.
* **P3 Non-regenerability.** Information that must be carried across a compression
  event may not be cheaply re-derivable.
* **P4 Strategy invariance.** Exploration breadth must not pay.
* **P5 Determinism and archivability.** The score is computable offline from archived
  artifacts, with no wall clock in it.
* **P6 Legibility.** Every non-maximal outcome states why: infra vs agent.

## 3. Width, defined precisely

A task has **retention width W** when it needs W information items that are

1. **revealed** at t_k and **needed** at u_k > t_k,
2. separated by at least one compression event,
3. **independent** (knowing item j tells you nothing about item k),
4. **non-regenerable** after u_k.

Two further quantities decide whether an instrument can detect anything:

* **D** - the distance between reveal and need, in folds or tokens.
* **R** - regenerability: the cost to re-derive an item versus the cost to recall it.

If R is low, every runtime looks the same, because nobody needs the archive. That is
exactly what we measured: **17 recall-tool calls in ~1,900 model calls across 16
tier cells**, including zero for the highest scorer (the top-scoring cell, WTqMmb2 at
0.982, never called a recall tool). W and D were irrelevant because nothing needed
carrying.

Consequences:

| task | W | R | Can it test compression? |
|---|---|---|---|
| vector-db-iterative-build | ~0 | low (re-run the command) | **no** |
| unknown-config, as shipped | large in shape (12 independent field families) | **low** - the pool and the spec revisions were readable | **no: collapsed into a search task** |
| unknown-config, after repair | large | high - all channels are paced and stage-locked | **yes** |

## 4. Case study: repairing unknown-config

### 4.1 Scoring: dense, ungated, archived

The verifier already computed the right quantity and then threw it away:

\`\`\`python
if not submit_ids:
    _write_reward(0.0, {...})     # <- the source of 0/40
    raise AssertionError(...)
\`\`\`

The HARD metric is documented as *"no wall clock anywhere in it"*, but it sat behind a
return that requires a submission, and a submission requires time-floored stage
passes. The time dependence the metric exists to remove came back through the door.

Repair: reward the **live engine's** ungated field accuracy as well as any submitted
snapshot. Then

* the score is dense (0..696 field matches), so a run need not finish to be readable;
* the floor is the shipped engine (0.3678), so **zero ceases to exist** as an outcome
  and the scale reads "no net improvement" at the bottom;
* it is exact equality against hidden configs (seed 7777) - deterministic, no clock;
* the graded engine is archived, so any cell can be re-scored offline. Demonstrated:
  40 archived engines graded without re-running a single agent.

**Precondition, and it must be tested.** Dense scoring is only sound while the
shortcut is closed. If the pool or the spec revisions ever become readable again, this
metric degenerates into rewarding the shortcut. The test must fail if
\`cfgd_secret.json\` is reachable during the agent phase.

### 4.2 Widening: many independent items, not one long chain

An early version of this design proposed revealing one rule per few probe rounds along
a single narrative. That is the wrong shape. A **deep** chain asks the summarizer to
keep one evolving state; a **wide** set asks it to keep N unrelated items, which is
where summarisation actually loses information - capacity, not coherence.

So: maximise the number of **independent, non-regenerable** items, each needed after a
fold. unknown-config's 12 field families are already this shape (aliases, four-layer
precedence, three unit families that disagree, enums, couplings, derived). The repair
is to stop the answers leaking, not to add prose.

### 4.3 Making the probe loop pay per step

As shipped, the loop carried no incremental reward: 105 probe rounds against 5
information events (one spec revision per passed stage), a 21:1 ratio, with the
per-round output identical once the engine was correct. The measured consequence is
that the heaviest prober issued **159 manual repetitions** - 56% of its entire turn
budget - while the loop is the only path to progress.

A candidate repair is to release one new fact every few rounds, so each round carries
something. This is **not yet justified**: the 21:1 ratio is only a defect if the loop
is *the* channel, and until the leaks were closed the model never saw a reason to enter
it. Gate C3 below decides.

### 4.4 Strategy invariance

All three anti-parallel mechanisms already existed: a fresh nonce per gated call
(*"anti-batch / anti-pipeline"*), the time floor, and the stage lock. They were
bypassed by readable files. With the files closed, the only route is sequential and
paced, so breadth stops paying.

### 4.5 Budget calibration

The budget must cover the **protocol**, not the floor. Measured: 32 of 70 archived runs
hit \`AgentTimeoutError\`, and the median timed-out run managed 109 model calls in
14400 s - **132 s per call, model latency, not pacing**. The protocol needs ~185 turns
(105 probes + up to 45 samples + ~35 reads/edits). Headroom was **-70%**: no agent
could finish, at any skill level.

Note what the 50 s floor does *not* cost: at 132 s per call, consecutive gated calls are
already further apart than the floor, so it never binds on the intended path and binds
only against scripting.

## 5. The gate procedure, for any candidate task

**Gate A - Protocol validity.**
A1 enumerate every channel to an answer; for each, can it be read without the intended
work? A2 write down the cheapest path to a high score; if it is not the intended path,
the task is invalid. A3 automate A2: run an agent instructed to cheat.

**Gate B - Retention necessity.**
B1 for each needed fact, measure R. B2 measure W and D; if W is ~0 or D is under one
fold, the task cannot test compression. B3 remove cheap re-derivation paths.

**Gate C - Score shape.**
C1 is the score monotone in the measured sub-capability? C2 is the floor interpretable
and the usable range wide? C3 does a partially-good run earn partial credit? C4 can any
shortcut inflate it (the Mislead gap)?

**Gate D - Determinism and archivability.**
D1 no wall clock in the score. D2 re-score N cells from the archive and compare. D3 are
the graded artifacts in \`artifacts\`?

**Gate E - Variance hygiene.**
E1 is the budget calibrated to the protocol's minimum turn count (measured seconds per
call x required turns)? E2 do infra failure allowances scale with the episode? E3 are
verifier flakes retried or at least labelled?

**Gate F - Attribution.**
F1 does every outcome state why: termination reason, sub-metrics, effort counters?

## 6. The arm we are missing: a positive control

Four similar arms scoring similarly is **uninterpretable**. It could mean the
compression method does not help, or that the instrument cannot see a difference.
Before drawing any conclusion we need an arm that must be worse - an aggressively
lossy runtime with retrieval disabled - so that "no difference" becomes a finding
rather than an absence of signal.

## 7. What to keep from LHTB

Keep the shapes and the machinery: long-horizon terminal work, the reference solution
with an end-to-end self-check, the HMAC-chained action log, staged unlock, the
time floor as an anti-rush device. Rebuild the enforcement: where every gate is
*stated*, it must be enforced at the layer where it can be violated.

The recurring defect this session found, four times in one task, is exactly that gap:

| stated invariant | where it was stated | where it was enforced | consequence |
|---|---|---|---|
| "no labelled cases on disk" | instruction | unsalted hashes on disk | 847 recoverable cases |
| one revision per passed stage | \`cfg doc\` output | presentational only; \`cat\` gave all five | 8/8 cells read it and stopped probing |
| "no wall clock anywhere in it" | verifier comment | behind a \`submit\`-gated early return | 40 engines recorded as 0 |
| budget defers to the task | config comment | a lower override value | 109 turns for a 185-turn protocol |

**Validating the solution path does not validate the task.** A reference solution never
cheats, never short-circuits a gate, and never needs the reward it cannot reach. Only an
adversarial pass finds these.

## 8. Roadmap

1. unknown-config with dense scoring and closed channels; take the four-tier data.
2. Add the width instrument: many independent non-regenerable items; measure W and D.
3. Build the gate suite (Gates A-F) as an automated audit; apply it across the portfolio.
4. Assemble the benchmark: only tasks that pass every gate, with one normalised dense
   score, and an archive-based re-scoring pipeline for reproducibility.
