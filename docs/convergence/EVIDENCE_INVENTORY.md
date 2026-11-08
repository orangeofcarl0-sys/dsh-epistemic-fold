# EF-C0 — Evidence Inventory

Status: current evidence truth, verified 2026-11-08.

Machine-readable companion: `docs/convergence/data/artifact-manifest.json`
(277 artifacts, path + bytes + SHA-256) and
`docs/convergence/data/evidence-registry.json` (claim-level registry).

The rule this document follows:

```text
A result is only as strong as the artifact that still exists.
```

Nothing here was regenerated. Historical outputs were read, hashed and
classified.

## 1. Evidence classes

| Class | Meaning | Can it become a product claim? |
|---|---|---|
| Deterministic contract | a test or invariant that fails when the code changes | yes, about the code |
| Mechanism certified | a fixture proves a mechanism does what it says | no — it is not model behavior |
| Behavioral observation | a model was run and behavior was measured | only within its harness/model/route |
| Product-level evidence | behavioral observation under the production configuration, with cost and reliability | yes, for that configuration |
| Hypothesis | a declared expectation with no measurement | no |
| Invalid / superseded | contradicted by a later measurement | no |

`Mechanism Certified` is never silently promoted to `Product-level Evidence`.

## 2. Artifact census

```text
artifacts tracked in git        277
  evidence JSON                 181   (51.1 MB)
  research documents             96   (0.7 MB)
evidence JSON excluding corpora 173   ( 9.7 MB)
benchmark corpora                 8   (41.1 MB, tracked, inputs not results)
```

The corpora are inputs, not evidence of behavior. They are counted separately
so a size comparison does not read as a result count.

Largest evidence files:

```text
1,759,659  eval/r37c/out/evidence-inventory.json
  982,021  eval/r37c/out/protocol-admission.json
  635,370  eval/r33/out/self-test-report.json
  569,451  eval/r37/out/r36-evidence-reconstruction.json
  407,766  eval/r37d/out/operational-completion.json
```

## 3. R37-B — the confirmatory behavioral batch

Authoritative committed results:

```text
eval/r37/out/r37b-results.json             2ea58f1e…  72,679 B
eval/r37/out/r37b-stage2-results.json      4a699a0e… 101,997 B
eval/r37/out/r37b-stage2-statistics.json   c3b400da…   2,703 B
eval/r37/out/gate-status-r37b.json         d242d14d…   2,637 B
eval/r37/out/gate-status-r37b-stage2.json  8d43a5ed…   2,739 B
```

Stage 2 (confirmatory, 6 replicates):

```text
pairs            36
contract         rescue 1, damage 9, both 17, neither 9
task             rescue 2, damage 7, both 20, neither 7
model turns      819
rejected actions 121 (9.5% of action turns)
unparsed turns   37 (4.5%)
```

The direction is a **negative contract difference for the Active arm under this
model, route and harness**. It is not a population estimate and it is not a
claim about Native DSH Basic.

Raw runs:

```text
../ef-r37-action/eval/r37/runs-b    163 runs, 491 entries, ~10 MB
../ef-r37-action/eval/r37/runs-b2   218 runs, 654 entries, ~13 MB
inventory total                     381 runs, 2,919 files, 17.4 MB
```

These live in the **R37-A/B worktree**, outside this worktree. A clone of the
repository alone does not contain them.

Frozen archive (external, verified now):

```text
path      F:/Codex_Work_Space/DSH plugin/ef-r37c-evidence-archive/r37b-raw-evidence-20261106.tar.gz
bytes     3,763,962
sha256    de6102989457fba6e5f4c43406478ce91b360f247f2dd462759f252f69de1c92
match     yes (byte count and hash)
```

Truncation:

- `writerRawTruncated: false` for every run in the inventory.
- Several runs have `cappedTurns` — a turn hit the per-turn cap and its trace is
  truncated at that point. The turn index is recorded, so the truncation is
  locatable rather than silent.
- Six stage-1 requests had unknown usage (`unknownUsageRequests: 6`); one in
  stage 2. Their cost is not imputed.

## 4. R37-C — measurement correction

```text
gate status      attention
C0-A..C0-D       passed (evidence preservation, funnel correction,
                 measurement vs pipeline, statistics audit)
C1-A..C1-C       passed (DSML fidelity, no-valid-action attribution,
                 native lifecycle)
C1-D             gate-not-verifiable (Stage 1 admission)
C2               passed (bounded process pilot)
C3               passed (benchmark and next-stage readiness)
product          deployment-hold
```

The C1-D non-pass is historical and is **not repaired** by a new threshold. It
means the Stage 1 admission cannot be verified under the current record, so
Stage 1 cannot be used as a confirmatory batch. Stage 2 stands on its own
pre-registration amendment.

Committed evidence:

```text
eval/r37c/out/evidence-inventory.json     381-run census + archive identity
eval/r37c/out/measurement-vs-pipeline.json
eval/r37c/out/semantic-funnel-audit.json
eval/r37c/out/protocol-admission.json
eval/r37c/out/statistics-audit.json
eval/r37c/out/native-smoke.json
```

`eval/r37c/out/evidence-archive.json` is the index of the external archive, not
the archive itself.

## 5. R37-D — operational completion and the process pilot

```text
gate status       complete (8/8)
product           deployment-hold
pilot             24 cells executed, 24 valid measurements
legacy contract   17/24
operational       17/24
strict finish      8/24
tests executed    34
no-valid-action   51 calls
step-limit cells  14
```

Committed artifacts:

```text
eval/r37d/out/process-pilot-results.json       50,449 B
eval/r37d/out/process-pilot-trajectories.json 230,619 B  (24 cells, per-turn)
eval/r37d/out/process-pilot-manifest.json      49,017 B
eval/r37d/out/process-pilot-preflight.json      2,908 B
eval/r37d/out/process-pilot-analysis.json       5,434 B
eval/r37d/out/operational-completion.json     407,766 B
eval/r37d/out/gate-status-r37d.json
```

The trajectories carry the turns, tool sequences, finish/test turns, capped
turns and per-cell counts. The pilot is re-scorable from the repository; it is
not re-runnable without a new authorization.

Authorization scope:

```text
covered     the executed 24-cell process pilot
does not cover
            a new batch, a new manifest, or R38-M1
```

## 6. R38-M0 — offline mechanism evidence

```text
live model calls   0
HTTP attempts      0
input tokens       0
output tokens      0
mechanism cases    11/11 certified, 0 blocked
gates              8/8
product            deployment-hold
deploymentEligible false
```

Committed artifacts:

```text
eval/r38/out/relation-security-audit.json
eval/r38/out/revision-idempotency.json
eval/r38/out/integrity-audit.json
eval/r38/out/working-set-ablation.json
eval/r38/out/archive-recovery-ablation.json
eval/r38/out/recent-tail-consistency.json
eval/r38/out/native-context-smoke.json
eval/r38/out/mechanism-evaluation.json
eval/r38/out/gate-status.json
```

What these establish: the relation-authorization fix refuses unauthorized
retirement; N5 is reproducible; the selector, recovery and overlay behave as
specified on fixtures; the native `runtime-context` delivery path works.

What they do **not** establish: that a model behaves better, that the cost is
lower, or that any of it is a product benefit.

## 7. Reconstruction matrix

| Evidence | Reconstructable from a clone? | Needs external artifact? |
|---|---|---|
| R37-B committed aggregates | yes | no |
| R37-B per-run traces | no | yes — `runs-b`, `runs-b2` or the tar.gz |
| R37-B archive identity | yes (hash recorded) | the bytes themselves are external |
| R37-C measurement audits | yes | no |
| R37-C raw C2 runs | no — not in this worktree | yes, if they still exist |
| R37-D pilot trajectories | yes (24 cells, per-turn) | no |
| R37-D raw provider transcripts | partial — the trajectory is a derived record | yes, for byte-level replay |
| R38 mechanism results | yes (deterministic fixtures) | no |
| R38 native smoke | yes (scripted adapter) | no |

## 8. Scripted-adapter evidence

These prove a delivery or lifecycle path, not model behavior:

```text
eval/r37c/out/native-smoke.json
eval/r37d/out/native-extended.json
eval/r38/out/native-context-smoke.json
```

Each uses a scripted adapter. A scripted adapter cannot produce a behavioral
claim; it can only prove that the host delivered what the runtime produced.

## 9. Integrity checks performed in this round

```text
R37-B archive sha256 + bytes        match
six historical result digests       match
artifact hashes recorded            277/277
working tree at audit time          clean
```

`docs/convergence/data/artifact-manifest.json` records the hash of every
evidence JSON and research document. A later round can detect a silently edited
artifact by re-running `node eval/c0/git-audit.mjs`.

## 10. Limits

- A hash proves identity, not correctness. A wrong result that was never edited
  still hashes correctly.
- The R37-B raw runs are outside git. If that directory is deleted, the
  per-run traces are gone even though the aggregates remain.
- The R37-C C2 raw runs are not present in this worktree; the committed
  analysis is the surviving record.
- Cost figures are per-harness and per-route. They are not transferable to a
  different provider or price list without re-measurement.
- No historical artifact was regenerated, and none was edited.

### A mutation found during this round

Running the full Vitest suite rewrites these tracked evidence paths:

```text
eval/r33/out/live-report.json       the live gate's refusal record
eval/r33/out/offline-report.json    the offline report
docs/12_R1_EVALUATION_REPORT.md     regenerated by the R1 report test
docs/MANIFEST.json                  regenerated with it
cordis.patch.yml                    regenerated by the preset build
```

EF-C0 restored them to the R38 baseline before committing and registered the
R33 claim against the committed document, not the regenerated JSON. This is a
real evidence-hygiene defect in the test suite: a test that writes a historical
evidence path makes the artifact non-immutable. It is recorded here and in the
handoff, not fixed in this round.

