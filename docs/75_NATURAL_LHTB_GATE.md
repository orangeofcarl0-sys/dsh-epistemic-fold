# 75 — Natural LHTB continuity gate: audit, launch, and what the run shows so far

Status: episode RUNNING, no natural fold yet. 2026-10-14. Parent `0cbbe60`. No source change.

## 1. Audit of the previous live trace: there was NO operational recall

`ef-phase7-logs/.s3.mjs:34,39,44` handled every model tool call by appending a FAKE tool result:

```js
await send({ op:'append', message:{ role:'tool', id: call.id,
                                     content:'(tool unavailable in smoke) ' } })
```

It never used the bridge's `{"op":"tool"}` branch, which is the only path that reaches
`callEfTool` (`bridge-host.ts:1131`, dispatched at `:1943`).

So, precisely:

* `finish=tool-calls` with `["context_recall","context_search"]` was REAL -- the model did emit
  those calls.
* **The tools were never executed. `context_recall` and `context_search` ran ZERO times.**
* The post-fold reply ("I called both retrieval tools ... both returned `(tool unavailable in
  smoke)`") is the model accurately describing the fabricated result it was shown. It did not
  hallucinate a tool call; the harness lied to it.
* Therefore the previous round's evidence supports **model continuation**, and says NOTHING about
  recall. `Operational Recall = 0` for that run.

## 2. Environment (pre-run)

| | |
|---|---|
| EF commit | `0cbbe607b9390c2a847d16b2f995ce8e4c5dd8c8` |
| parent | `117446e` |
| worktree | dirty: `eval/lhtb/lhtb-ef-probe.yaml`, `scripts/rescore-lhtb-vectordb.py` (both pre-existing) |
| DSH runtime | `@deepseek-ai/dsh-session` `0.2.0-rc.2` |
| model | `deepseek-v4.1-flash` |
| route | `https://opencode.ai/zen/go/v1`, `x-opencode-session` supplied by `EF_LIVE_HEADERS` |
| window | `EF_TAU2_WINDOW=131072` (the runner's measured value for this model) |
| threshold | 65536 (Economy preset default; not lowered) |
| task root mode | `exact` |
| task | `unknown-config-semantics` (the repo's `lhtb-ef-probe.yaml`) |
| runner | `LHTB_ROOT=... EF_LHTB_ARM=economy EF_LHTB_TASK_ROOT_MODE=exact EF_LIVE_MODEL=deepseek-v4.1-flash bash scripts/run-lhtb.sh probe` |

`probe` is the runner's own single-task, single-arm, single-attempt mode. No `EF_TAU2_HEADERS` was
set anywhere; the runner sets `EF_LIVE_HEADERS` itself for this route.

The runner confirmed the pinned values in its own output: `window: EF_TAU2_WINDOW=131072
(measured for this model)`, `request deadline: 300000`, `model=deepseek-v4.1-flash`,
`headers=x-opencode-session`.

### 2.1 Infrastructure: Docker was down

The first two launches died with `Docker daemon is not running`. Docker Desktop was started
(`29.7.2`) and the episode then began. This is an infrastructure delay, not an EF or provider
fault, and it is recorded rather than hidden.

### 2.2 Open, unattributed: the preflight prints `HTTP 400`

`scripts/run-lhtb.sh`'s own route preflight prints `node fetch: 5/5 reached` followed by `HTTP 400`,
and then continues. It did not abort the run, the episode's `provider_failures` is 0, and the model
answered every call, so the 400 is NOT affecting the episode. It is recorded as an unattributed
observation: `scripts/check-route.mjs` contains a check that deliberately omits the session header
to demonstrate the 400, and whether this line is that demonstration or a separate failing probe
was not established this round.

## 3. The run (snapshot while still in progress)

Job: `lhtb-ef-20261014-021547-probe-economy`, container
`unknown-config-semantics__unnas3j-main-1`.

```
arm                 economy
termination         in-progress
task_root           {mode: exact, status: resident, sourceSeq: 2,
                     digestVerified: true, surfacePosition: 0}
provider_failures   0
lastFinishReason    tool-calls
modelCalls          14
shell_calls         1
transcript turns    18
folds / roots / emergencies   0 / 0 / 0
bundleWrites        0        compactionFailures 0
promptTokensLast    22091    (threshold 65536 -> 34% of pressure)
surfaceNodesLast    33
tokens              prompt 292676, output 9702, cacheRead 222976, total 302378
```

**What is established here:** in a REAL LHTB episode, with the real Docker task, the real tool
execution and the real verifier path, the host declared the task instruction and the engine
verified it -- `resident`, `sourceSeq 2`, `digestVerified`, surface position 0 -- and the lane ran
14 model calls with **zero provider failures**.

**What is NOT established: a natural fold.** Context pressure reached 22,091 tokens against a
65,536 threshold. The task was still building context when this round's budget ran out, so the run
is censored by the operator, not by the harness.

## 4. Status

```
NATURAL FOLD NOT EXERCISED   (censored: stopped at 22091/65536 tokens, in-progress)
OPERATIONAL RECALL           NOT EXERCISED in the only fold-bearing run so far, and 0 in the
                             synthetic run (see section 1)
LHTB EPISODE COMPLETED       NO -- no reward recorded, no verifier result
QUALITY BENEFIT vs UNPINNED  NOT ESTABLISHED -- no paired sample
```

The job directory
`bench-workspace/lhtb/jobs/lhtb-ef-20261014-021547-probe-economy/unknown-config-semantics__UNNaS3J/`
holds `ef-transcript.json`, which will carry the fold lineage and post-fold turns if the episode
reaches the threshold.
