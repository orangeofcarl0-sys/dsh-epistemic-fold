# RC7-D — Parallel long-task testing

Status: the runner is built and working; the first runs produced a finding that
changes how the results must be read.

## 1. The route

`space-bunny-free` is served by **OpenCode Zen**, not by `spacebunny.app`. The
machine already had it configured in the `web` profile:

```
opencode-zen:
  apiKeyEnv: OPENCODE_GO_API_KEY
  baseURL: https://opencode.ai/zen/v1
  models:
    - id: space-bunny-free
      contextWindow: 1048576
      maxTokens: 524288
      input: [text, image]
      reasoningEfforts: { low, medium, high, xhigh, max }
```

Measured capabilities, all confirmed by direct call:

| Property | Result |
| --- | --- |
| Basic completion | ✅ `pong`, usage reported |
| Tool calling | ✅ returned a well-formed `tool_calls` |
| Streaming + usage | ✅ `stream_options.include_usage`, with `reasoning_content` |
| Cache accounting | ✅ `prompt_tokens_details.cached_tokens` (128 on a 163-token prompt) |
| Reasoning tokens | ✅ `completion_tokens_details.reasoning_tokens` |
| **90K-token needle** | ✅ retrieved `batch limit 64 / timeout 90` from the middle of a 405 KB prompt |
| **Concurrency** | ✅ 50 simultaneous requests, all HTTP 200, 3.8s wall |

## 2. Two environment facts that are not obvious

**The provider is reachable only through the local HTTP proxy.** Direct access
fails at TLS (`ERR_TLS_CERT_ALTNAME_INVALID`); the system proxy is configured at
`127.0.0.1:10808` in the Windows registry, not in the shell environment. Node's
own `fetch` honours it when told to:

```bash
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:10808
```

That is the whole fix — no adapter change, no proxy dependency, no undici. A
hand-rolled CONNECT tunnel was tried first and returned Cloudflare 403, because
Cloudflare rejects the raw TLS fingerprint; Node's fetch does not.

**The key is read at runtime and never copied.** It lives in DSH's own credential
store (`<DSH_HOME>/.credentials.yaml`, refs block). `scripts/run-live-parallel.sh`
reads that one value into the process environment, never echoes it, never writes
it to a file, and never passes it as an argument.

## 3. What was built

| Artifact | Purpose |
| --- | --- |
| `eval/real-task/parallel.ts` | `runCellsParallel` — bounded-concurrency scheduling over the SAME `runTaskArm` cells the sequential driver runs |
| `tests/rc7d-parallel-long-tasks.spec.ts` | The live suite: builds the cell set, runs it, pools by arm, reports per task |
| `scripts/run-live-parallel.sh` | One command that sets the route, the proxy and the credential |

Design points that matter for honesty:

- **Bounded concurrency, not unbounded.** A provider is not a compute cluster; the
  default is 6.
- **A failed cell is counted, never dropped.** `poolByArm` reports `failed`
  alongside `ok`, because a run that silently loses cells to errors would
  overstate quality.
- **Per-check detail is logged.** A low score is diagnosable from the run output
  rather than requiring a re-run under a debugger. This was added after the first
  runs produced a 0.00 that could not be explained from the log.

## 4. The speedup, measured

Controlled: the SAME five cells (one task × five arms) at concurrency 1 and 6.

| Concurrency | Wall clock |
| --- | --- |
| 1 | **424s** |
| 6 | **104s** |

**4.1× faster**, with every cell producing the same quality scores. The runner
adds scheduling, not semantics.

## 5. The finding: at n=1 the arms are NOT distinguishable

The first runs appeared to show a clean ordering — `quality` at 1.00, `basic` at
0.58. Further runs destroyed that reading. Same task, same arms, same fixtures:

| Run | basic | ef-legacy | economy | balanced | quality |
| --- | --- | --- | --- | --- | --- |
| first parallel sweep (n=3) | 0.58 | 0.67 | 0.67 | 0.92 | **1.00** |
| controlled, concurrency 1 (n=1) | **0.00** | 1.00 | 1.00 | 1.00 | 1.00 |
| controlled, concurrency 6 (n=1) | **0.00** | 1.00 | 1.00 | 1.00 | 1.00 |
| diagnostic (n=1) | 1.00 | 1.00 | 1.00 | 1.00 | **0.00** |

`basic` scored 0.00 twice and 1.00 once. `quality` scored 1.00 three times and
0.00 once. **The arm labels do not explain the scores.**

The cause is visible in the timelines. The failing cells stop early:

```
quality / coding-paginate: answered
  rounds=4 calls=4 failed=0
  timeline: list_files -> context_search
  LOST constraint-retained, revision-honoured, no-resurrection, interface-honoured
```

Four rounds, two tool calls, then the model declared itself done — having written
none of the files the task requires. A passing cell on the same task uses 8–22
rounds and 8–22 calls. The model is deciding, per run, how much work to do, and
that decision dominates the metric.

**So the correct reading of every table above is: n=1 per cell measures the
model's variance, not the mode's effect.** This is exactly the trap RC2 flagged
when it said its numbers had to be read as a timeline rather than statistics —
and it is why the parallel runner matters: it is what makes a replicate count
large enough to average the variance out affordable.

## 6. What is now known, and what is not

**Known:**
- The route works and is capable (long context, tools, streaming, cache, 50-way
  concurrency).
- The parallel runner is correct: same cells, same results, 4.1× less wall clock.
- Single-replicate arm comparisons are meaningless on this task family.

**Not known, and not claimed:**
- Whether any tier is better than another. RC2's conclusion is unchanged and now
  better supported: the tiers' steadiness benefit remains a HYPOTHESIS.
- Whether the variance is a property of `space-bunny-free` specifically. A
  different route might be steadier. This is worth one controlled comparison
  before drawing conclusions about EF from this route.

## 7. The next run, stated precisely

The variance finding makes the next run's design determinate rather than
exploratory:

- **Replicates ≥ 5 per cell**, so a single early-stopping run cannot decide an
  arm. At 4.1× parallel speedup, 5 replicates × 3 tasks × 5 arms = 75 cells is
  roughly 75 × 77s / 6 ≈ 16 minutes.
- **Report the variance, not just the mean.** A mean over a bimodal distribution
  (0.00 or 1.00) is a number with no referent. The report should carry the
  per-cell scores so the spread is visible.
- **Consider a steadier route for the comparison.** If the variance is
  `space-bunny-free`'s, the mode comparison should run on a route that does not
  early-stop, or the metric should separate "answered" from "did the work".

The third point is a real question the data raises and cannot answer: the metric
currently scores `outcome: 'answered'` as success, and a session that answers
after two tool calls is not wrong to stop — it is wrong to be scored as if it had
done the task. That distinction is worth fixing before the next comparison, or
the comparison will keep measuring the same thing.

---

# Part II — The n=5 run, and what it settles

Run after the variance finding above, with the fixes that finding called for:
replicates raised to 5, and the pool extended to report the per-cell spread.

## 8. The measurement

25 cells (1 task × 5 arms × 5 replicates), concurrency 6:

```
RC7-D RUN: 25 cells, 25 ok, 0 failed, wall 259s at concurrency 6
  sequential estimate 1366s -> parallel 259s (5.3x)
RC7-D SANITY: 25/25 successful runs made a tool call
```

**5.3× faster, zero failures.** At this size the sample is no longer bounded by
patience: 25 cells in 4.3 minutes, where the sequential driver would need 23.

## 9. The spread, which is the actual result

```
arm       mode      n     fail  cost        calls   quality  spread  steady  trunc
basic     legacy    5     0     0.003727    11.4    0.80     1.00    0.75    0
ef-legacy legacy    5     0     0.003696    13.6    1.00     0.00    0.95    0
economy   economy   5     0     0.003302    10.4    0.80     1.00    0.75    0
balanced  balanced  5     0     0.003685    12.4    0.90     0.25    1.00    0
quality   quality   5     0     0.002871    11.8    1.00     0.00    1.00    0

RC7-D SPREAD (per-cell quality, ascending):
  basic     [0.00, 1.00, 1.00, 1.00, 1.00] range=1.00
  ef-legacy [1.00, 1.00, 1.00, 1.00, 1.00] range=0.00
  economy   [0.00, 1.00, 1.00, 1.00, 1.00] range=1.00
  balanced  [0.75, 0.75, 1.00, 1.00, 1.00] range=0.25
  quality   [1.00, 1.00, 1.00, 1.00, 1.00] range=0.00
```

## 10. What this settles, and what it does not

**Settled — the scheduling question.** Concurrency works, is correct, and pays.
Two independent controlled measurements agree: 4.1× at 5 cells, 5.3× at 25. The
runner is the enabling infrastructure for any future sample that needs to be
sized by the question rather than by patience.

**Settled — single replicates are worthless here.** The n=1 readings from Part I
put `basic` at 0.00 twice and 1.00 once, and `quality` at 0.00 once and 1.00
three times. At n=5 the spread column makes the reason visible: two arms are
**bimodal** — `basic` and `economy` each scored `[0.00, 1.00, 1.00, 1.00, 1.00]`.

**NOT settled — which arm is better.** A bimodal arm's mean describes no run that
happened. `basic`'s 0.80 is the average of a 0.00 and four 1.00s; the honest
statement is "basic fails roughly one run in five on this task, and the failures
are total rather than partial."

Two arms are perfectly steady — `ef-legacy` and `quality` both scored 1.00 on
every replicate. That is suggestive and it is **not** a result: five replicates
cannot distinguish "always works" from "works 90% of the time" with any
confidence, and the two arms that did show variance showed it at n=5 only because
one cell failed.

## 11. The metric defect this exposes

The per-cell detail shows the mechanism, and it is not an EF behaviour:

```
rounds=4  calls=4  timeline: list_files -> context_search
LOST constraint-retained, revision-honoured, no-resurrection, interface-honoured
```

The failing cells stop early — 4 rounds and 2 tool calls against 7–19 rounds and
7–22 calls for a passing cell — and are still recorded as `outcome: 'answered'`.
The model decides how much work to do, and that decision dominates the metric.

So the metric currently conflates two different failures:

1. **The session did the work and lost the facts** — the thing EF exists to
   prevent, and what the checks measure.
2. **The session declined to do the work** — a model-behaviour event that no
   context runtime can be credited or blamed for.

Scoring both as 0.00 is what produces the bimodality. Until the metric separates
them, every arm comparison on this route measures the model's willingness to keep
working, not the runtime's ability to preserve state.

## 12. Recommended next step

Fix the metric before running a larger comparison, because more replicates of a
conflated metric buys precision on the wrong quantity. Concretely: record whether
a run's tool-call count reached the task's own requirement (the coding task needs
its files written), and report "declined" separately from "lost the facts".

Only then is a larger sample worth its wall clock — and the runner is now cheap
enough that the sample can be as large as the question needs.

> **DONE — see Part III.** The metric was split, but NOT by tool-call count: a
> better model may finish in fewer calls, so the contract is each task's own
> artifact/interface/execution milestones. Two 25-cell batches then showed why
> the split was necessary — the arm ordering inverted between them.

---

# Part III — The metric fix, and the two batches it produced

Implemented per the directive: split the metric, classify engagement against a
task-defined contract, and protect the cost gate from concurrent runs.

## 13. What was built

| Artifact | What it does |
| --- | --- |
| `eval/real-task/engagement.ts` | The outcome state machine, the classifier, and the split report |
| `tests/rc7e-engagement.spec.ts` | 18 keyless tests; both sabotages (conflate early-stop with completed; drop the execution milestone) are caught |
| `parallel.ts` | Now scheduling ONLY — the old single-mean pooling was removed rather than left beside the new one |

### The outcome state machine

`answered` no longer means "done". The four states are:

```
transport-failed     every provider call failed; nothing measured
truncated            the round cap stopped it while still working
completed            answered AND satisfied the task's execution contract
answered-incomplete  answered WITHOUT satisfying it — the early-stop case
```

### The contract is task-defined, never a tool count

The directive is explicit that "tool calls >= N" must not be the gate, because a
better model may finish in fewer. Each task's contract is read from its OWN work
steps, using milestones the run already records:

| Task | Required artifacts | Required interface | Execution |
| --- | --- | --- | --- |
| `coding-paginate` | `module-exists`, `test-exists` | `named-export` | `run_node` |
| `research-retry-policy` | `config-exists`, `checker-exists` | `config-valid-json` | `run_node` |
| `tool-heavy-manifest` | `schema-exists`, `sample-exists`, `validator-exists` | `all-fields-present` | `run_node` |

`run_node` is a milestone because every task's work steps literally say "run it
with run_node". A run that writes the files and never executes them has skipped
a step the task required.

### The five reported quantities

Per arm: `completed k/n`, `early-stop k/n`, `quality | completed`,
`steady | completed`, `e2e success k/n`, and `cost / successful task`.

Counts are printed as `k/n`, never as a percentage: "1/5" says what was observed,
"20%" claims a property of the population.

## 14. Two independent batches, and the result

Each batch is 25 fresh cells (1 task × 5 arms × 5 replicates), concurrency 6.

**Batch 1** (400s wall, 2079s sequential → **5.2×**):

```
arm       mode      n   completed  early-stop  truncated  quality|comp  steady|comp  e2e   cost/success
basic     legacy    5   2/5        3/5         0/5        1.00          0.88         1/5   0.019513
ef-legacy legacy    5   3/5        1/5         1/5        1.00          1.00         3/5   0.005404
economy   economy   5   5/5        0/5         0/5        1.00          1.00         5/5   0.003535
balanced  balanced  5   5/5        0/5         0/5        1.00          0.95         4/5   0.006784
quality   quality   5   5/5        0/5         0/5        1.00          1.00         5/5   0.004644
```

Read alone, that table says `basic` early-stops three times in five and the tiers
do not. It is a clean-looking ordering, and it is wrong to believe it.

**Batch 2** (331s wall), same cells, same fixtures:

```
arm       mode      n   completed  early-stop  truncated  quality|comp  steady|comp  e2e   cost/success
basic     legacy    5   5/5        0/5         0/5        1.00          1.00         5/5   0.005454
ef-legacy legacy    5   4/5        1/5         0/5        1.00          0.94         3/5   0.003785
economy   economy   5   4/5        1/5         0/5        1.00          1.00         4/5   0.003337
balanced  balanced  5   5/5        0/5         0/5        1.00          1.00         5/5   0.003358
quality   quality   5   4/5        1/5         0/5        1.00          0.94         3/5   0.004626
```

**The ordering inverts.** `basic` goes 2/5 → 5/5, and `economy` and `quality`
each go 5/5 → 4/5. Across the two batches every arm produced at least one
early-stop except `balanced`.

### The honest reading

> `basic` and `economy` each showed catastrophic non-completion in one batch and
> none in the other. The early-stops do not follow the arm. This sample cannot
> say whether they are a mode effect, provider/model variance, or an interaction.

And for the arms that looked clean:

> `balanced` showed no early-stop in either batch (10/10). That is an observation,
> not a stability claim: at n=10, 10/10 is consistent with a 10% failure rate.

This is exactly the outcome the directive predicted, and it is why the split
metric was worth building before spending more replicates: the single-mean table
in Part II would have reported batch 1 as "basic 0.80, tiers 1.00" and batch 2 as
"basic 1.00, tiers 0.80" with no way to see that the arm labels explain neither.

## 15. The mechanism, from the timelines

Every early-stop is the same shape — `rounds=4`, and a timeline that stops at
reading:

```
basic / coding-paginate: answered
  rounds=4 calls=4 failed=0
  timeline: list_files
  LOST constraint-retained, revision-honoured, no-resurrection, interface-honoured
```

`runTurn` returns as soon as the model emits text with no tool call. The coding
task has three work steps, and `rounds=4` is the signature of a session that
called a tool once and then answered the remaining steps with PROSE:

```
step 1  "Now write src/paginate.js"        -> list_files, then text
step 2  "Write a small test script"        -> text only
step 3  "Report the final contents"        -> text only
```

So this is not the model giving up mid-task. It is the model treating the work
steps as conversation to be described rather than instructions to be executed.
That is a model-behaviour property, and it is the reason the metric needed a
layer for it: no context runtime can be credited or blamed for it.

## 16. The cost gate, protected

The directive's warning is implemented as a refusal, not a note. A run declares
its purpose, and a cost claim from a concurrent run is **rejected before any
provider call**:

```
parallel: purpose=quality — cost columns below are NOT a conclusion
          (concurrent cells share the provider prefix cache)
```

`assertPurposeAllowed('cost', n > 1)` throws. The reason is that a contaminated
cost number looks exactly like a clean one, and this project has already been
burned once by cross-run cache contamination — the cost gate is OPEN partly
because of it. Quality and steadiness are safe in parallel (each cell owns its
workspace, session and engine); **realized cost is not**, and the runner now says
so mechanically rather than in a comment.

## 17. Status

- **Done:** the split metric, the engagement classifier, the task-defined
  contracts, the cost-gate guard, and the two-layer report — 18 keyless tests,
  both sabotages caught.
- **Done:** two independent 25-cell batches, which between them demonstrate why
  the split was necessary.
- **Not done, and now correctly deferred:** a larger n. The question is no longer
  "how many replicates" but "on which route", because the early-stop rate varies
  by batch more than by arm. Running more replicates of this route would buy
  precision on the model's willingness to act, not on the runtime's ability to
  preserve state.
- **Unchanged:** the tiers' steadiness benefit remains a HYPOTHESIS. Nothing in
  either batch supports promoting it.
