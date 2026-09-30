# RC8 — External Benchmark Integration: What Is Real, What Is Blocked

**Status:** verification complete; two lanes feasible, two blocked on this host.
**Frozen selection:** `bench/ef-selectbench-v1.json`

---

## 1. Why this document exists

The previous phase ended with a metric that could not separate the arms: two
independent 25-cell batches produced **inverted arm orderings** (`basic` 2/5 →
5/5, `economy`/`quality` 5/5 → 4/5). That is the signature of a sample that
cannot separate a mode effect from provider variance — the tasks were too easy,
the grader was ours to get wrong, and single rollouts vary too much.

The response is to stop authoring both the task and the grader, and adopt mature
benchmarks. This document records what that adoption actually requires on this
machine, because three of the four assumptions in the original plan did not
survive contact with the sources.

---

## 2. Verification method

Every claim below was checked against the upstream source, not against a summary:

- repository existence and layout via the GitHub API;
- **every cited task/question id** fetched and its content compared to the
  description given for it;
- reward bands from the published per-task results
  (`IntelligenceLab/LHTB-leaderboard` → `data/per_task.jsonl`, 1,196 rows over
  26 models × 48 tasks);
- dataset sizes from the HuggingFace API.

The id check is the one that mattered most. A curated set built on ids that do
not exist, or that no longer match their description, would have wasted the
entire effort — and several of the proposed names were wrong on first contact.

---

## 3. Corrections to the original plan

### 3.1 The primary benchmark's repository was wrong

`github.com/long-horizon-tasks/lhtb` returns **404**. The real repository is
**`zli12321/LHTB`** (712 stars, *"Long Horizon Terminal Benchmark with Dense
Reward Grading"*). The task set, the 46-task count, and the dense-reward design
described in the plan are all accurate — only the location was wrong.

### 3.2 "LHTB 4 题" does not discriminate for our route

This is the finding that changes the plan. The plan selected four LHTB tasks by
their **cross-model mean reward**, reasoning that a mid-range mean means the task
discriminates. But the arms under test all run on **one** model, and a task can
be discriminating on average while being saturated for that model.

Our route is `deepseek-v4.1-flash`. The published per-task rewards for
*DeepSeek V4 Flash*:

| task | all-model mean | **our route** | verdict |
|---|---:|---:|---|
| `duckdb-optimizer-closure` | 0.512 | **1.00** | **saturated — excluded** |
| `riscv-core-debug` | 0.843 | 0.88 | above band — **anchor only** |
| `vector-db-iterative-build` | 0.567 | 0.84 | **discriminator** |
| `unknown-config-semantics` | 0.223 | 0.50 | **best discriminator** |

`duckdb-optimizer-closure` is the clearest case: it looks ideal by the plan's
rule (mean 0.512) and is worthless for us (our route scores 1.00 every time).

The corrected rule, now written into the frozen manifest: **condition selection
on the route model's own reward band**, and exclude anything above 0.85 or below
0.15 for that model. Under that rule the primary set becomes
`unknown-config-semantics` (0.50) and `vector-db-iterative-build` (0.84) — two
discriminators, not four tasks.

`riscv-core-debug` (0.88) is above the band, so it is **not** admitted as a
discriminator. It is carried as a **stability anchor**: a task our route usually
solves, where a mode that damages long-horizon behaviour would produce a visible
regression. It cannot show an improvement, and the manifest says so explicitly —
the distinction between "discriminator" and "anchor" is enforced by
`tests/selectbench-manifest.spec.ts`, which caught this exact overreach when the
manifest was first written.

### 3.3 The plan's exclusion rationale was also inconsistent

The plan excluded `nbody-accel-iterative` as "saturated (0.93)". The measured
all-model mean is **0.859**, and for our route it is **1.00** — so the exclusion
was right, but for a different and stronger reason than stated.
`spot-scheduler-traces` was given as 0.96; measured **0.944**. Close enough to
not matter, but it confirms the figures in the plan were approximate.

### 3.4 τ²-Bench-Verified is a separate repository, not a flag

The plan required "τ²-Bench-Verified" without saying where it lives. It is
**`amazon-agi/tau2-bench-verified`**, a corrected fork of
`sierra-research/tau2-bench` that fixes tasks whose expected actions violated
their own stated policies, whose ids did not match the database, or whose
scenarios were impossible. Upstream `tau2-bench` has no "verified" split — its
`split_tasks.json` contains only `train`/`test`/`base`.

All six cited ids were confirmed **present in the Verified fork as well as
upstream**, so the selections are valid in the version that matters:

`retail/{5,18,21,22}`, `airline/{11,42}` — each fetched and its content matched
to the description in the plan (retail/5 is the water-bottle-and-lamp
supersession, retail/22 the partial address rollback, airline/11 the withheld
reservation id, and so on).

---

## 4. Host feasibility: what can actually run here

Measured on this machine: 24 logical CPUs, **16 GB RAM**, an 8 GB RTX 5050, and
a WSL VM capped at `memory=8GB` by `.wslconfig`.

| lane | verdict | blocking fact |
|---|---|---|
| **τ²-Bench-Verified** | **runnable** | text mode needs only Python ≥3.12 and `uv`; no Docker, no GPU |
| **LHTB** | **blocked for parallel** | every cited task requests **4–8 GB RAM**; the WSL cap is 8 GB total, so at most one cell runs at a time |
| **LongMemEval-V2** | **blocked** | harness expects a local **Qwen3.5-9B** reader plus **Qwen3-Embedding-8B**; 8 GB of GPU is below that |
| SWE-bench Pro V2 | deferred | needs Docker plus a long agent budget; overlaps LHTB |
| AgencyBench V2 | deferred | most expensive lane; needs a Docker sandbox |

This is why the parallel runner built in the previous phase — 4.1× at 5 cells,
5.3× at 25 — **cannot be reused for LHTB**. Those numbers were measured against
the custom coding tasks, which are cheap in-process runs. An LHTB cell is a
multi-GB container holding 4–8 GB of RAM for up to six hours. The runner remains
valuable, but as the τ² orchestration layer, not the LHTB one.

**The practical consequence:** τ² is the only lane that can produce a large
sample on this host, and it happens to be the lane that directly answers the
variance problem (`pass^k`). The LHTB lane — the one that tests the actual EF
claim — is limited to **sequential, single-task runs**.

---

## 5. Storage

Storage was raised as a concern, and the audit found a real defect plus one
non-issue.

### 5.1 The defect: 44,035 leaked scratch directories (fixed)

Every suite created scratch with a bare `mkdtemp(join(tmpdir(), 'ef-...'))` and
**never removed it**. Accumulated total:

| prefix | count |
|---|---:|
| `ef-m0-` | 35,533 |
| `ef-eval-` | 8,311 |
| others (`ef-task-`, `ef-flaky-`, `ef-plugin-`, `rc2-*`) | ~190 |

The content was small (~290 MB; measured means of 114 KB and 6 KB per directory)
but the **count** was the damage: `os.tmpdir()` is on **C:**, the drive with the
least free space (16 GB of 201 GB), and enumerating a directory with ~88,000
entries made a full `stat` pass take **9.1 seconds**.

Fixed by `eval/tmp.ts` (one managed root, registered creation, explicit release),
wired into every call site, with `scripts/sweep-temp.mjs` for the backlog and
`tests/tmp-scratch.spec.ts` pinning the contract. Results:

- **40,503 directories reclaimed**, C: free space **16 GB → 20 GB**;
- a subsequent full 714-test run leaked **0** `ef-m0-`/`ef-eval-` directories;
- the sweep went from **5m12s to 0.36s** once the backlog was gone — the cost
  *was* the symptom.

Scratch is now contained in a single `%TEMP%/ef-tmp` subtree, which is bounded
and cheap to reclaim, rather than scattered across `%TEMP%`.

### 5.2 The non-issue: Docker

Docker's build cache is 23 GB and its VHDX is 28 GB, but the VHDX lives on
**D:** (`/d/DockerData/...`), not C:. D: has 61 GB free. So Docker is not
currently a C: risk — but note that Docker's *images* for a benchmark sweep
(1.4 GB for `riscv-core-debug` alone) would still land there, and D: has 61 GB,
not 146 GB.

### 5.3 Dataset footprints

| dataset | size | note |
|---|---:|---|
| LHTB (HuggingFace) | 1.18 GB | 650 files |
| LongMemEval-V2 | **7.12 GB** | 1.2 GB `trajectories.jsonl` + **5.9 GB** screenshot tarballs |
| SWE-bench Pro | 15 MB | task metadata only; instances fetched separately |
| tau2-bench | ~15 MB | `db.json` is 2.8 MB (retail) + 7.0 MB (airline) |

The LongMemEval screenshots are optional for the six text-only questions in the
frozen set, so that lane's working footprint is ~1.2 GB rather than 7.1 GB.

### 5.4 The repository's own footprint

The checkout itself is not the problem, and it is worth recording why so a
future sweep does not delete the wrong thing:

| path | size | tracked? |
|---|---:|---|
| `vendor/` | **2.0 GB** | no — gitignored, a separate upstream checkout |
| `node_modules/` | 77 MB | no — gitignored |
| `.git/` | 5.8 MB | — |
| `lib/` | 422 KB | no — built output |
| `bench/`, `profiles/`, `docs/`, `src/`, `eval/`, `tests/` | < 3 MB total | yes |

218 files are tracked. The 2.0 GB is almost entirely the vendored DSH source
tree, which the test aliases resolve against and which is deliberately **not**
part of this repository. A cleanup that targets "large directories under the
workspace" would destroy it; only the `%TEMP%/ef-tmp` subtree and the owned
`%TEMP%` prefixes are safe to sweep, which is exactly what
`scripts/sweep-temp.mjs` is restricted to.

The largest *generated* artifact to watch is Docker's image store on D: once a
benchmark lane runs — `riscv-core-debug` alone is a 1.4 GB image, and LHTB's
`continue-until-timeout` harness resumes agents for up to six hours per task, so
a single sweep can leave several GB of container layers behind.

---

## 6. What was adopted, and what was not

**Adopted:** the frozen 16-cell manifest (`bench/ef-selectbench-v1.json`), the
three-lane structure, the rule that headline metrics are the benchmark's own,
and the rule that selection is conditioned on the route model.

**Not adopted:** the original LHTB four. Two of them are saturated for our route,
so the primary set is **two discriminators plus one anchor**, not four tasks.
`duckdb-optimizer-closure` moves to the excluded list with its reason recorded,
and `riscv-core-debug` is demoted from discriminator to anchor.

**Still open:** the LHTB and LongMemEval lanes need either a larger machine
(≥32 GB RAM, ≥24 GB VRAM) or a hosted/remote endpoint for the reader and
embedder. Until then the honest statement is that **the EF claim can be tested
for interaction reliability at scale, and for long-horizon behaviour only
sequentially.**
