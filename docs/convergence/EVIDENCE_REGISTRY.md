# EF-C0 — Evidence Registry

Status: current, 2026-11-08.

Machine-readable companion: `docs/convergence/data/evidence-registry.json`
(18 claims, every artifact hashed). This document is the readable index; the
JSON is the authority for fields.

## 1. How to read a claim

Every claim carries:

```text
claimId          stable identifier
claim            one sentence, falsifiable
evidenceLevel    see below
experimentId     the round/batch
gitSha           the commit that owns the artifact
model / route    Unknown when not recorded — never inferred
harness          the runner that produced it
configuration    the frozen config
datasetVersion   the frozen cases
scorerVersion    the scorer
rawArtifact      the file that still exists
resultSummary    the number
limitations      what it cannot support
status           current / superseded / on hold
```

Levels:

| Level | Meaning | Promotion |
|---|---|---|
| Deterministic Contract | a test fails when the code changes | about the code only |
| Mechanism Certified | a fixture proves a mechanism | not model behavior |
| Behavioral Observation | a model ran and behavior was measured | only within its harness/route |
| Product-level Evidence | behavioral result under the production config, with cost and reliability | product claim |
| Hypothesis | declared expectation, no measurement | none |
| Invalid / Superseded | contradicted or replaced | none |
| Decision | a governance outcome | not evidence |
| Constraint | true by construction (e.g. "not executed") | not evidence |

## 2. Registry

| ID | Level | Experiment | Artifact | What it says |
|---|---|---|---|---|
| RC13-QUALITY | Behavioral Observation | RC1.3 / RC1.3.1 | `docs/22_RC1_3_RETRIEVAL_ERGONOMICS.md` | economy-none matched Basic on the retrieval probe (3.00/3) |
| RC13-COST | Behavioral Observation | RC1.3 | same | ~17× cheaper on the n=5 sample; cost gate OPEN |
| CORE-TRANSACTION | Deterministic Contract | EF core suite | `src/fold/engine.ts` | bundle before lossy replacement |
| R33-LIVE-NOT-EXECUTED | Constraint | R33 live | `eval/r33/out/live-report.json` | 0 requests; not executed |
| R34-NO-REAL-MODEL | Constraint | R34 | `docs/semantic-continuity/R34_REAL_MODEL_RESULTS.md` | 0 provider requests; 68/68 scripted |
| R35-WRITER-RECALL | Behavioral Observation | R35 writer | `docs/semantic-continuity/R35_WRITER_RESULTS.md` | facts extracted, automatic recall 0 from coordinate mismatch |
| R36-INTERFACE | Behavioral Observation | R36 | `docs/semantic-continuity/R36_HANDOFF.md` | 845 requests; W1 aligns writer with validator |
| R37B-CONTRACT-HARM | Behavioral Observation | R37-B Stage 2 | `eval/r37/out/r37b-stage2-results.json` | 9 damage vs 1 rescue over 36 pairs |
| R37C-MEASUREMENT-CORRECTION | Deterministic Contract | R37-C | `eval/r37c/out/measurement-vs-pipeline.json` | the earlier funnel overstated commit/recall |
| R37C-C1D-NOT-VERIFIABLE | Deterministic Contract | R37-C gates | `eval/r37c/out/gate-status-r37c.json` | Stage 1 admission cannot be verified |
| R37D-PROCESS-PILOT | Behavioral Observation | R37-D | `eval/r37d/out/process-pilot-results.json` | 24 cells; P1 helps D1, hurts B2 |
| R38-RELATION-AUTHORITY | Deterministic Contract | R38 WP1 | `eval/r38/out/relation-security-audit.json` | unauthorized retirement refused; 8/8 |
| R38-REVISION-IDENTITY | Deterministic Contract | R38 WP1 | `eval/r38/out/revision-idempotency.json` | claim identity vs revision identity; 7/7 |
| R38-N5 | Mechanism Certified | R38 WP2 | `eval/r38/out/integrity-audit.json` | stale negative knowledge detected; 9/9 |
| R38-SELECTION | Mechanism Certified | R38 WP3 | `eval/r38/out/working-set-ablation.json` | critical coverage 0/1 → 1/1 under budget |
| R38-RECOVERY | Mechanism Certified | R38 WP4 | `eval/r38/out/archive-recovery-ablation.json` | archive-only facts recovered; 8/8 |
| R38-NATIVE-OVERLAY | Mechanism Certified | R38 WP6 | `eval/r38/out/native-context-smoke.json` | runtime-context delivery; 6/6 |
| PRODUCT-DECISION | Decision | R37-B/D, R38 | `eval/r38/out/gate-status.json` | deployment-hold |

## 3. What the registry shows at a glance

```text
Deterministic Contract   5
Mechanism Certified      4
Behavioral Observation   6
Product-level Evidence   0
Hypothesis               0 (hypotheses live in the roadmap, not here)
Invalid / Superseded     0 (superseded status is recorded per claim)
Decision                 1
Constraint               2
```

**Zero Product-level Evidence.** That is the central fact of the convergence.
The project has strong deterministic and mechanism evidence, several behavioral
observations under custom harnesses, and no product-level result.

## 4. Metadata gaps

These fields are recorded as `Unknown` because the source artifact does not
contain them:

```text
RC13-QUALITY / RC13-COST   model, route
R37D-PROCESS-PILOT         route
R37B-CONTRACT-HARM         scorer version (no single field)
```

This is deliberate. A field that is guessed is worse than a field that is
missing, because a later reader cannot tell the difference.

## 5. Rules for adding a claim

1. One claim, one sentence, one falsifiable statement.
2. The artifact must exist and be hashed by `node eval/c0/evidence-registry.mjs`.
3. The harness, model, route, configuration, dataset and scorer must be named or
   `Unknown`.
4. A mechanism result may not be entered as Product-level Evidence.
5. A claim contradicted by a later round stays in the registry as
   `Invalid / Superseded`; it is not deleted.
6. A claim that depends on an external artifact (the R37-B raw archive) says so
   in `limitations`.

## 6. Evidence

```text
eval/c0/evidence-registry.mjs
docs/convergence/data/evidence-registry.json
docs/convergence/data/baseline-comparison-manifest.json
eval/c0/out/evidence-registry-summary.json
docs/convergence/EVIDENCE_INVENTORY.md   artifact census and hashes
```

## 7. EF-R1 companion registry

EF-R1 did not rewrite the 18 C0 claims. Its claims are a separate, hashed
registry:

```text
eval/ef-r1/evidence-claims.mjs
eval/ef-r1/out/evidence-claims.json   12 claims: authority, stages, locator,
                                      tasks, design, archive, candidate, ablation,
                                      prompt folding, writer audit, combined archive,
                                      campaign authorization
docs/convergence/EF_R1.md             readable index and limitations
```

The strongest EF-R1 claim is a Deterministic Contract (16 authority cases,
11 locator cases, 22 task certifications). The stage attribution is a
Behavioral Observation re-derived from the existing 96 cells. The locator and
the completion guard have no behavioural result, and the 120-cell design is a
Constraint with no authorization.
