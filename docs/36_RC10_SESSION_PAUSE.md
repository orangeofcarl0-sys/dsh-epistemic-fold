# RC10 — Session State: Paused

**Paused at:** 2026-10-01, at the user's request ("本机暂时不能继续跑测试了").
**State:** all work committed and pushed; nothing left running; no cleanup owed.

---

## 1. Where the two benchmark lanes stand

| lane | status | evidence |
|---|---|---|
| **τ²-Bench-Verified** | **DONE** — 96 episodes, graded | `eval/tau2/results/sweep-96.json`, doc 34 |
| **LHTB (LongWork)** | **WIRED, NOT CONCLUDED** — integration proven, arm comparison not run | doc 35 |

### τ² — complete

6 tasks × 4 arms × 4 replicates, all 96 cells completed with zero errors, graded
by the official `DB × COMMUNICATE` verifier. **Result: no arm separation**
(`economy` − `basic` = +0.125, permutation p = 0.164; task-level spread 0.94 vs
arm-level 0.17). The lane was then corrected to the same route-conditioned band
rule used for LHTB: `retail/18` and `retail/5` are the discriminators,
`retail/22`, `airline/11`, `retail/21` are saturated anchors, `airline/42` is
floored and excluded.

### LHTB — integration proven, comparison not run

**Proven:** the oracle smoke passed (reward 1.0, 5/5 stages, 696/696 fields), and
EF-driven runs mounted DSH Basic/EF inside a real LHTB trial, folded a long
transcript (checkpoints recording "Folded 30 message(s)" with exact history
archived for `context_recall`), executed commands through Harbor's official
environment, and were graded by the official hidden verifier.

**Not proven:** any arm comparison. Every EF-driven run scored reward 0 with 0
submits, because the agent spent its budget reading `spec.md` / `cfg_daemon.py` /
the data pools and **never modified `/opt/cfg/engine.py`**. That is a statement
about the model's approach on this task, not about the harness — but it also is
not a fair test of the route, since the published 0.50 reward assumes the full
90-minute budget with continue-until-timeout, which these probes did not have.

---

## 2. What to run next

```bash
# The serial probe, one arm at a time (this host runs one LHTB cell at a time).
EF_LHTB_ARM=basic   bash scripts/run-lhtb.sh probe
EF_LHTB_ARM=economy bash scripts/run-lhtb.sh probe
EF_LHTB_ARM=quality bash scripts/run-lhtb.sh probe
```

Read the result from the job's `ef-transcript.json` (per-command, written
incrementally) plus `verifier/reward.json` (the official dense reward:
`best_correct_fields / total_fields` and `passed_stages`).

**Before a real comparison, consider:** the probes used
`EF_LHTB_MAX_TURNS=200` and a 3-hour cap, while the task's own budget is 4 hours
and the published runs use continue-until-timeout. A run that ends by turn cap
scores 0 for reasons unrelated to the mode. Raising the cap is the first thing to
try.

---

## 3. Defects found and fixed this session

Each was found by running, and each would have silently corrupted a measurement:

| # | defect | consequence |
|---|---|---|
| 1 | Empty model reply treated as task completion | ended a multi-hour task after 14 shell calls |
| 2 | `retainTokens: 0` for the basic arm | folds retained nothing; agent re-read the same files (spec.md ×7) |
| 3 | Transport failure indistinguishable from a silent model | 5 empty replies looked like a finished task |
| 4 | Harbor reuses a job dir and prints the stale result | a run exited in 60 s reporting "29m 31s" and the old reward |
| 5 | Bridge stderr drained only on crash | a live `fetch failed` left no trace |
| 6 | 900-token completion budget | heredocs truncated to `max-tokens` with nothing usable |
| 7 | Transcript written only on normal exit | three runs lost their entire diagnostic record |

Defect 2 is worth re-reading: it **never affected the τ² sweep** (that run folded
zero times), so the τ² results stand. It only manifests once folding starts.

---

## 4. Environment facts for the next session

- **Harbor:** `$BENCH_WORKSPACE/lhtb/harbor/.venv` (Python 3.13,
  `uv pip install -e .`). The LHTB checkout is pristine — the EF agent is injected
  via `import_path`, so nothing there was modified. Pass it as `LHTB_ROOT`.
- **tau2:** `$BENCH_WORKSPACE/tau2-verified/.venv` (Python 3.13). Pass it as
  `TAU2_ROOT`.
- **Benchmark checkouts are outside the repo**, in a directory this document calls
  `$BENCH_WORKSPACE` — which is why the runner scripts require `LHTB_ROOT` and
  `TAU2_ROOT` rather than carrying a default path.
- **Credential:** read at runtime from DSH's store; never printed, written, or
  passed as an argument.
- **Memory is the binding constraint:** 16 GB host, 8 GB WSL cap, and one LHTB
  task wants 4–8 GB. A concurrent Docker build in another project starved one
  probe to death (host free memory was 1.04 GB). **Check free memory before
  launching an LHTB run.**
- **Do not run two LHTB probes at once**, and prefer a quiet machine.

---

## 5. Standing rules (unchanged)

- τ² and LHTB are separate lanes and their scores are never pooled.
- Headline metrics are the benchmark's own; EF contributes telemetry and failure
  attribution only, never an aggregate score.
- Selection is conditioned on the route model's own reward band (0.15–0.85);
  saturated tasks become anchors, floored ones are excluded. Enforced by
  `tests/selectbench-manifest.spec.ts`.
- Quality/reliability runs may be parallel; any realized-cost run must be
  cache-isolated (concurrency 1), enforced mechanically.
- τ² is deliberately **not** shrunk-window-forced into folding.

## 6. Verification at pause

- 724 tests pass, 23 skipped (three consecutive clean runs).
- Typecheck clean; build clean; no secrets in the tree.
- Working tree clean; `HEAD == origin/main == 9a531c4`.
- No stray containers or processes; only the unrelated `omnigate2api` container
  was left running by its own project.
