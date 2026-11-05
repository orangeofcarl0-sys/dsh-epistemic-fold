# R37-A — Evidence Audit

## 1. What was audited

The audit reads the R36 worktree at `b8274bb` directly:

```text
12 causal report.json files        (6 cases × 2 replicates; r1 has B1/S/O1/O2, r2 has B1/S)
36 trace/record.json files         (one per arm row)
36 final workspace trees           (file hashes, verification.json, journals, bundles)
```

It does not copy the R36 archive and does not edit an R36 file. Content digests
are in `eval/r37/out/baseline-manifest.json`; the run-level reconstruction is
`eval/r37/out/r36-evidence-reconstruction.json`.

## 2. Independent reproduction

The reconstruction re-derives each pair from the report row and the trace bytes,
then compares with `eval/r36/out/causal-comparison.json`.

| outcome | R36 report | reconstruction |
|---|---:|---:|
| valid pairs | 12 | 12 |
| rescue | 1 | 1 |
| damage | 3 | 3 |
| both | 4 | 4 |
| neither | 4 | 4 |
| invalid | 0 | 0 |

Task outcome also reproduces: 1 rescue, 2 damage, 5 both, 4 neither.

By case (contract):

```text
A1  1 damage, 1 neither
B2  2 damage
C1  1 rescue, 1 neither
D1  2 neither
F1  2 both
H1  2 both
```

By replicate:

```text
r1  0 rescue, 2 damage, 2 both, 2 neither
r2  1 rescue, 1 damage, 2 both, 2 neither
```

There is **no score discrepancy**. The discrepancy report records 12
`arm-not-run` notes: the r2 runs selected B1/S only, so O1/O2 were not executed
there. Those are not missing measurements and are not counted as failures.

## 3. Assigned arm versus actual delivery

| arm | delivery | rows |
|---|---|---:|
| B1 | EF-off basic context | 12 |
| S | semantic checkpoint committed | 11 |
| S | full-history fallback | 1 |
| O1 | semantic checkpoint committed | 6 |
| O2 | oracle gold facts | 6 |

The one S fallback is C1 r1: the writer packet was `aborted`, the fold produced
no commit, and the harness continued on the full transcript. It is assigned S
but is **not** a semantic-checkpoint delivery. R37 does not pool it with the 11
committed runs when discussing representation.

## 4. Semantic-to-action funnel

For the 12 S rows, the gold facts give 16 fact-instances:

| stage | count | recall |
|---|---:|---:|
| source fact present in frozen transcript | 16/16 | 1.000 |
| mentioned in raw writer output | 16/16 | 1.000 |
| proposed delta matches fact | 15/16 | 0.938 |
| accepted by validator/authority | 15/16 | 0.938 |
| committed in replayed state | 14/16 | 0.875 |
| rendered in checkpoint body | 16/16 | 1.000 |

The two committed misses are the two C1 facts in the refused r1 fold. The
checkpoint still carried the full transcript because the harness fell back; the
fact was rendered, but it was not a semantic commit. This is exactly why
`rendered` alone is not evidence of semantic delivery.

No R35 metric was renamed or given a new denominator. This is a new R37 field
(`funnel`) with its own definition and denominator.

## 5. Failure classification

Across all 36 reconstructed rows, the sufficient cause is:

```text
none (contract success)             17
implementation-failure               9
checker-ambiguity                    2
tool-parameter-corruption            1
tool-parameter-loss                  2
verification-artifact-invalid        2
verification-artifact-missing        2
verification-not-executed            1
```

`checker-ambiguity` is A1 r1 S/O1: the hidden checker requires `retries: 2` on
the legacy string form, but the task and visible test state only the object
form. It is not counted as a memory failure.

## 6. Case-level findings

### A1 — task/gold ambiguity

- The S checkpoint contains the compatibility constraint.
- r1 S failed `constraint.legacy-string-api`; r1 B1 passed.
- The hidden checker requires the string form to return `retries: 2`; neither
  R36's task nor its visible test says so.
- A1-v2 states the rule in the task and the visible test. The old A1 bytes and
  R36 scores are unchanged.

### B2 — two different failures, neither a missing fact

**r1 S:** the checkpoint contains the in-memory decision. The model wrote a
scheduler that keeps `mode: 'memory'`. The final file failed to parse because
the DSML content attribute retained literal `\`` and `\${` escapes. Decoding
those two escape forms makes both `node --check` and the hidden checker pass.
The sufficient cause is `tool-parameter-corruption`, not decision inconsistency.

**r2 S:** the checkpoint also contains the decision, but the agent read files
for all eight steps, never wrote a file, and never ran a test. The final
workspace is byte-identical to the initial workspace. This is an
implementation/process stop; it is not evidence that the fact was lost.

### C1 — fallback is not a semantic checkpoint

**r1 S:** the fold packet status is `aborted`; actual delivery is
`full-history-fallback`. The full transcript visibly contains the fs.watch
cannot and the 28/40 result. The agent wrote no code and failed the visible
behavior. This is a fallback-plus-implementation failure.

**r2 S:** the fold committed the rejected-approach anchor; the agent wrote a
polling watcher and passed. B1 failed without writing. This is the only
candidate memory signal in the pair set, and it is n=1.

### D1 — two artifact failure modes, not one

R36's narrative said the agent never wrote `verification.json`. The actual
artifacts are more specific:

```text
r1 B1  verification.json present, claim "failed"        -> invalid vocabulary
r1 S   verification.json present, claim "not verified"  -> invalid vocabulary
r2 B1  verification.json absent                          -> missing artifact
r2 S   verification.json present but empty               -> write content was lost
```

The r2 S empty file is a `tool-parameter-loss` at step 5: the DSML write had a
path but no content. The r1 files were written but used claim strings the
checker does not accept. D1-v2 states the exact vocabulary.

### F1/H1 — ceiling

Both arms reach contract success in both replicates. They do not discriminate
Active from Off.

## 7. What this audit does not claim

- It does not claim the model understood or forgot any fact.
- It does not turn visibility into action consistency.
- It does not turn the C1 r2 pair into a product effect.
- It does not treat the 12 pairs as 12 independent tasks.
- It does not use the R36 aggregate as the source of truth; the aggregate is
  the thing the reconstruction checks.

## 8. Evidence limits

- The trace stores at most 1000 characters per model turn. A truncated turn is
  reported as truncated, not as a model failure.
- R36 did not store the full rendered `messages` array or exact tool-result
  strings. The reconstruction records the checkpoint body, the task, and the
  exact first-message digest; it marks unpersisted result text as unavailable.
- The r2 report rows say `replicateId: r1` because the runner was invoked with
  its default replicate id. R37 uses the run-id prefix for the analysis
  replicate and records the runner value separately (`runnerReplicateId`).
- The R36 worktree is a local, gitignored run archive. The manifest identifies
  its bytes by digest; it is not a second copy.
