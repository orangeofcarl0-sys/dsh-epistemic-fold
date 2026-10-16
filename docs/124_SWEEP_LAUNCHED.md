# 124 — Four-arm parallel sweep launched: unknown-config-semantics x cat-jam-free, n=2

Status: RUNNING. 2026-10-16. Parent `e36455e`.

## A. What was launched

```
task     unknown-config-semantics        (the fold-capable one -- docs/123)
model    cat-jam-free                    (route /zen/go/v1, no free-tier gates)
arms     basic, economy, balanced, quality     (the four archived arms)
n        2 attempts each                 8 cells, in parallel
budget   REQUIRED=1  requests 140  prompt 7,000,000  output 550,000  wall 28,800,000
```

## B. One invocation is one ARM, so four were needed

`scripts/run-lhtb.sh:296` exports a single `EF_LHTB_ARM`, and the job name carries it
(`:485`). A four-arm sweep is therefore four parallel invocations, not one.

## C. The config needed one change to honour n=2

`lhtb-ef-sweep-ucs.yaml` is the unknown-config-only config (`:88-89`) but declares `n_attempts: 3`,
and the runner rewrote only `job_name` and `model_name`. **The operator asked for n=2, so the
attempt count is now overridable the same way the model is**:

```bash
-e "s/^n_attempts: .*/n_attempts: ${EF_LHTB_ATTEMPTS:-2}/" \\
```

**Verified in the written configs, not assumed:**

```
lhtb-ef-20261016-220646-sweep-ucs-balanced.yaml   n_attempts: 2   model_name: openai/cat-jam-free
lhtb-ef-20261016-220646-sweep-ucs-economy.yaml    n_attempts: 2   model_name: openai/cat-jam-free
lhtb-ef-20261016-220647-sweep-ucs-quality.yaml    n_attempts: 2   model_name: openai/cat-jam-free
lhtb-ef-20261016-220648-sweep-ucs-basic.yaml      n_attempts: 2   model_name: openai/cat-jam-free
```

## D. Concurrency is at the measured limit, not past it

Four arms x two attempts is **8 cells**, and `lhtb-ef-sweep.yaml:71-81` measured this host's route:

```
concurrency   sec/call   calls/cell   cells that scored
~2-4          34.6-60.7  111-163      1/4, 1/3
8             39.3       138          1/8
32            258.2      51           0/16
```

**8 is the largest point that does not queue**, so running all four arms at once stays inside what
was measured rather than past it. Seven containers were up at launch; the eighth was still building
(`force_build: true` in this config, deliberately).

## E. What this run can and cannot show

**Can**: whether the four arms differ on a task that folds (`docs/123`: this task folded 13-47 times
in the archive), and whether cat-jam reaches the threshold this time.
**Cannot**: a fold is still not guaranteed -- cat-jam finished this task at 62 and 72 calls at
30,245-40,473 tokens, against a 65,536 threshold (`docs/122`). **n=2 per arm is two cells, not a
distribution**, and no effect size should be read from it.
