# EF-E2E — Execution

Status: the core, semantic pilot and T5b retest campaigns are complete. This
document records the scope, the environment, the method and the frozen
manifests. Results are in [E2E_RESULT.md](E2E_RESULT.md).

## 1. Scope and authorization

The round executes the EF-E2E work package: real tasks, a native host, real
model calls inside a bounded envelope, a deterministic semantic-authority fix,
and a candidate build. The envelope (work package §2.3):

```text
continuation cells       <= 72
HTTP attempts            <= 2,200
provider input tokens    <= 18,000,000
provider output tokens   <= 1,000,000
live wall-clock          <= 8 hours
paid concurrency         <= 2
monetary cost            <= USD 25 equivalent
```

The manifest is frozen by the agent and authorized by
`eval/e2e/authorization.json`, which names the manifest SHA-256. That is the
delegated model in §2.4: the envelope is authorized, the concrete manifest is
not a retroactive user approval of a hash that did not exist.

**No per-token price is verifiable for this route.** The route is the existing
local OpenAI-compatible proxy (`omnigate2api`, `127.0.0.1:7866`, model
`deepseek-v4.1-flash`). The enforced bound is requests/tokens/time; no cost in
currency is claimed anywhere in this round.

## 2. Environment

```text
worktree            F:/Codex_Work_Space/DSH plugin/ef-c1-foundation
branch              chore/ef-c1-evaluation-foundation
installed DSH       0.2.1-rc.3 (agent-loop, agent, tools, llm, session,
                    compaction, compaction-basic)
declared peers      >=0.2.0-rc.2
vendor tree         absent in this worktree (CI checks out the pinned tree)
Node / npm          24.14.1 / 11.11.0
typecheck           src, client and eval projects pass
build               79 modules to lib/
native smoke        R37-C N0/N1/N2 pass on 0.2.1-rc.3
```

The lane is the installed `0.2.1-rc.3` path that the native smoke certifies.
The pinned CI lane is verified separately by CI against the vendored tree.

### Remote CI (run 42507121191, head `f8f51f8`)

```text
DSH 0.2.0-rc.2 (pinned)   success, every step
  install, build, maps, presets, typechecks, supported tests,
  keyless eval, R1, R2, R1 report check, docs manifest, live tier (skipped)
DSH master                 failure at typecheck (independent compatibility probe)
```

The pinned job's tests are split into a **blocking supported lane** (all files
except the twelve historical ones listed in `ci.yml`) and a **non-blocking
probe** that runs those twelve and keeps their real results in the log. The
split is named, not silent: `bridge-loads`, `checkpoint-residency`,
`p0-regressions`, `persistence-compat`, `plugin-composition`,
`rc3-plugin-packaging`, `rc7-vendored-basic`, `r38-native-context`,
`lhtb-runner-dispatch`, `r32-process-faults`, `r35-live-failures`,
`r36-agent-calibration`.

## 3. What the harness is, and what it is not

`eval/e2e/` mounts the REAL host, not the R33 text loop:

```text
Context + LlmRuntime + SessionStore + SessionProjectionRegistry + TokenMeter
+ SystemPrompt + ToolRuntime + AgentRegistry + AgentLoop
+ one compaction backend (B0: @deepseek-ai/dsh-compaction-basic;
  Bv/E0/E0a/E0i/E1/S: dsh-epistemic-fold/plugin)
+ the live OpenAI-compatible adapter behind a recording wrapper
```

Each cell:

1. materializes the task workspace (the only agent-readable state);
2. builds a SEEDED session log with the loop's real event order
   (`step/start`, `request/header`, `system/message`, `user/message`, tool
   call/result pairs, closers);
3. creates the agent with that seed and starts the task message;
4. lets the host's own `agent/pre-step` pressure path decide to fold — the
   runner never calls `compactRegion` to fake an end-to-end fold;
5. continues with the native loop (8-step cap), then runs the task checker.

The tools are identical in every arm: `list_dir`, `read_file`, `write_file`,
`edit_file`, `run_tests`, `finish`. EF arms additionally expose the product's
recall tools (`context_search`, `context_recall`); B0 does not, because Basic
does not. That is a product difference, not a harness asymmetry.

### Operational configuration (all arms)

```text
contextWindow            16,384 tokens   (an OPERATIONAL budget, not the model window)
thresholdRatio           0.5
retainRatio              0.04
headroomTokens           512
maxTokens per request    1,024
max steps                8
```

The 65,536 default headroom is sized for a 128k window; at 16k it leaves no
pressure budget and the fold can never fire. 512 is the same value in both
backends. That the retention is 0.04 rather than 0.16 is deliberate: Basic
retains the recent tail by tokens, and a seed whose only large block is recent
leaves it almost nothing it may fold.

## 4. Tasks

Six templates × two seeds. Each instance is a frozen JSON file with a
workspace, a seeded history, a continuation task, a reference solution, a
counterfactual solution, declarative checks and analysis-only gold.

| Template | Question | Checker |
|---|---|---|
| T1 | implementation with a hidden edge | `node --test` + hidden assertions |
| T2 | exact identifier/number from before the fold | exact `answer.json` |
| T3 | revised decision vs the old plan | tests + no `Map` + plain-object snapshot |
| T4 | value observed through a tool, then rotated | exact `deploy.plan.json` |
| T5 | two folds, no stale revival | `state.json` + `final.json` + ≥2 compactions |
| T6 | stable long prefix, small working budget | tests + contract constants |

`T5B` is the explicit-shape version of T5, created after the core T5 cells all
produced the right values nested under `batch` while the checker required a
flat object. The original T5 cells keep their recorded outcome; T5B is a new
template and a new campaign.

### Offline certification

`eval/e2e/src/certify-tasks.mjs` runs the same checker three times per
instance:

```text
initial          must FAIL
reference        must PASS
counterfactual   must FAIL
seed tokens      must exceed the pressure threshold
```

14/14 instances pass. A task that could be solved without the fold, or whose
counterfactual also passes, is not shipped.

## 5. Campaigns and frozen manifests

| Campaign | Cells | Manifest SHA-256 (first 12) | Evaluated commit |
|---|---|---|---|
| `e2e-core-1` | 39 (3 calibration + 36 core) | `19a15d516a8e` | `5d5c744a28fb` |
| `e2e-pilot-1` | 12 (T2/T3/T5 × {E1,S} × 2) | `24177766ad92` | `d0e5771acad8` |
| `e2e-t5-retest-1` | 8 (T5B × {B0,E0,E1,S} × 2) | `ab4f738ccd9b` | `74698849a816` |
| `e2e-recall-1` | 12 (T2/T4/T5B × {E0,E0a} × 2) | `9685ce6b2317` | `5aa7179d7a11` |
| `e2e-guard-smoke-1` | 1 (T2-s1 × E0, completion guard on) | `229e3db1ba2a` | `08064ecd1d5a` |
| `e2e-index-1` | 24 (T2/T4 × {E0,E0i,E0ai} × 2 seeds × 2) | `73b435ec73ab` | `c527f97c7ca3` |

`E0a` is E0 plus the `recallAffordance` section. `E0i` is E0 plus the
`foldedSpanIndex`; `E0ai` is both. The guard is not an arm: it is a shared
completion check enabled per cell, and it writes nothing.

**Two envelopes, both closed.** The original 72-cell envelope is closed at
72/72. The index campaign ran under a separate 24-cell follow-up envelope
(720 requests / 6M input / 250k output / 3h / concurrency 1), also closed at
24/24. They are accounted separately: the index manifest does not subtract the
original spend, because it is not an extension of it. The guard-smoke
manifest's cumulative limit was computed before the recall campaign was added
to the prior list, so it says 13 cells remain instead of 1; the run itself was
one cell and the total is exactly 72. That accounting bug is recorded here
rather than rewritten in a frozen manifest.

Each manifest binds the code tree (excluding the evidence directory and the
authorization), the lockfile, the installed DSH versions, every task digest,
the arm configuration, the route identity, the cell order, the per-cell and
global limits, and the cache policy. The runner refuses to start when:

- the source tree differs from the manifest;
- the worktree is dirty outside `eval/e2e/out/` and `eval/e2e/runs/`;
- a task file differs from its frozen digest;
- the authorization does not name the exact manifest SHA;
- a limit is missing or non-positive.

Core order interleaves arms inside each replicate block (arm rotation by
template and replicate), so provider drift over the batch cannot masquerade as
an arm effect. The pilot runs E1 and S in the same batch. The retest runs all
four arms on T5B.

### Cumulative envelope

The pilot and retest manifests carry the envelope MINUS the observed usage of
the earlier campaigns, not a fresh 2,200 requests:

```text
after core     requests 1,941 / input 16,785,420 / output 930,834
after pilot    requests 1,864 / input 16,504,882 / output 914,879
```

## 6. Evidence layout

```text
eval/e2e/out/
  manifest-<campaign>.json       frozen manifest
  results-<campaign>.json        per-cell status, usage, stop reason
  analysis-<campaign>.json/.md   aggregates, failure classes, per-cell table
  evidence-index-<campaign>.json per-cell report path + SHA-256
  task-certification.json        initial/reference/counterfactual outcomes
  candidate-build.json           tarball hash + install smoke
  full-tests.json                full suite (tracked summary)

eval/e2e/runs/<campaign>/<cellId>/
  workspace/                     final workspace
  report.json                    events, checkpoint, usage, checker, transcript
  raw/requests.json              request structure (previews in the report)
  bundles/  semantic/            EF archives (gitignored)
```

Raw run directories are gitignored; `evidence-index-*.json` pins every analysed
report by SHA-256. Only aggregate evidence and the frozen tasks are tracked.

## 7. Reproduce

```bash
npm run eval:e2e-tasks          # regenerate + certify the task instances
npm run eval:e2e-freeze         # freeze the core manifest
npm run eval:e2e-authorize      # authorize it
npm run eval:e2e-check          # verify binding + route, no request
npm run eval:e2e-run            # execute
npm run eval:e2e-analyze

npm run eval:e2e-freeze-pilot   # pilot manifest (cumulative limits)
npm run eval:e2e-run-pilot
npm run eval:e2e-analyze-pilot

npm run eval:e2e-freeze-retest  # T5B retest
npm run eval:e2e-run-retest
npm run eval:e2e-analyze-retest

node eval/e2e/src/candidate-smoke.mjs --install eval/e2e/candidate/install
```

## 8. What this execution does not establish

- It is not a product-level non-inferiority certification: two seeds per
  template, one model, one route, one machine, one operational budget.
- It does not price the runs: the route has no verifiable per-token price.
- The history is SEEDED; only the continuation after the fold is model
  behaviour. Every report says `seededHistory: true`.
- A `no-fold` cell would be a measurement, not a failure; in fact all 71
  executed cells folded.
- Bv is not part of the main comparison; compatibility is certified in
  `C1_CORE_BASELINE.md`, and the main experiment compares B0/E0/E1 (and S in the
  pilot/retest).
