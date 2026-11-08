# EF-C0 — Handoff

## 1. State

```text
Repository            orangeofcarl0-sys/dsh-epistemic-fold
Base                  R38 HEAD 006702023e8cf2fcdfd4a814e7be5f2ddf3534ec
Branch                chore/ef-c0-convergence
Worktree              F:/Codex_Work_Space/DSH plugin/ef-c0-convergence
Final HEAD            this handoff commit
Push                  not performed
Merge / rebase        not performed
Tag                   not created
Branch deleted        none
```

The R38 worktree and every historical worktree were left untouched. The R38
branch still points at `0067020`.

## 2. Commit map

```text
3940e8a  docs(convergence): reconstruct the repository, change and evidence map
3e911f0  docs(convergence): establish the charter and certify configuration truth
52d4d44  test(convergence): certify the core/semantic boundary contracts
920de75  docs(convergence): register the evidence and the baseline comparison
e28c56a  docs(convergence): define governance, CI gates and the research roadmap
this     test(convergence): add the EF-C0 gates and publish the handoff
```

## 3. What was executed

```text
WP0  repository, change and evidence audit; isolated worktree
WP1  project charter, scope matrix, ownership boundaries
WP2  configuration truth matrix and runtime call-count certification
WP3  core/semantic boundary contracts C1-C7
WP4  evidence registry, baseline comparison manifest, evidence review
WP5  repository governance, product integration plan, CI/release gates
WP6  research roadmap and next milestones
     tests, gates C0-G0..C0-G5, local commits, this handoff
```

No live model call was made. No provider was contacted.

## 4. Headline findings

### 4.1 `origin/main` has no semantic layer

```text
src/semantic/ on origin/main        0 files
src/fold/engine.ts on origin/main   2,137 lines
src/fold/engine.ts on R38           3,716 lines
```

Track B (Semantic Continuity) and Track C (Context Intelligence) exist only on
the research line. "Backport the R38 safety fix to main" is therefore not a
cherry-pick; it would require importing the whole layer.

### 4.2 The configuration document was stale, not the preset

`docs/ARCHITECTURE.md` §10 said economy/balanced were `semantic none`. Commit
`0376ca3` (2026-10-18) changed all tiers to `rationale` and did not update the
document. The preset was not changed back. The document now records the current
truth and links to the history.

### 4.3 RC29's main artifact is already on main

`src/state/thermal.ts` was added by `377515b`, an ancestor of both `main` and
R38. PR #4 is still open on the RC29 side line. Recommendation: review and close
as superseded if no remaining delta; do not merge blindly. No remote action was
taken.

### 4.4 Zero product-level evidence

The registry has 18 claims:

```text
Deterministic Contract   5
Mechanism Certified      4
Behavioral Observation   6
Product-level Evidence   0
Decision                 1
Constraint               2
```

This is the central convergence fact. The mechanism results are real; they are
not product results.

### 4.5 The test suite rewrites historical evidence

Running the full suite mutates:

```text
eval/r33/out/live-report.json
eval/r33/out/offline-report.json
eval/r33/out/live-check.json
eval/r33/out/self-test-report.json
docs/12_R1_EVALUATION_REPORT.md
docs/MANIFEST.json
cordis.patch.yml
```

EF-C0 restored them before committing and registered the R33 claim against the
committed document, not the regenerated JSON. The defect is recorded in
`EVIDENCE_INVENTORY.md` and is not fixed in this round.

## 5. Gates

```text
C0-G0  passed   Repository integrity
C0-G1  passed   Configuration truth
C0-G2  passed   Architecture boundary
C0-G3  passed   Evidence consistency
C0-G4  passed   Governance
C0-G5  passed   Roadmap
```

Strict exit: **0**. `eligible: true` means the convergence stage is complete,
not that deployment is eligible.

```text
productDecision      deployment-hold
deploymentEligible   false
```

## 6. Tests

```text
typecheck (src, client, eval)     pass
build                             pass (79 modules)
eval:build                        pass (3 modules)
EF-C0 convergence tests           33/33 pass
full suite                        1824 total, 1742 passed, 12 failed, 70 skipped
```

The 12 failures are the pre-existing vendor/DSH-drift set recorded by
R36/R37-B/R37-C. No convergence test fails. The suite mutates evidence paths
(§4.5); the files were restored to the R38 baseline after the run.

EF-C0 test evidence: `eval/c0/out/c0-tests.json` — 33/33.
Full-suite summary: `eval/c0/out/full-tests-summary.json`.

## 7. Product decision

```text
EF Active: deployment hold
```

Track A remains the product baseline on `main`. Track B stays optional and
default-off on the research line. Track C stays research.

## 8. Artifacts

```text
docs/convergence/
  README.md
  PROJECT_CHARTER.md
  ARCHITECTURE_BASELINE.md
  REPOSITORY_GOVERNANCE.md
  EVIDENCE_REGISTRY.md
  RESEARCH_ROADMAP.md
  REPOSITORY_HISTORY.md
  EVIDENCE_INVENTORY.md
  FEATURE_AND_SCOPE_MATRIX.md
  CONFIGURATION_TRUTH.md
  BOUNDARY_CONTRACTS.md
  BASELINE_EVIDENCE_REVIEW.md
  PRODUCT_INTEGRATION_PLAN.md
  CI_AND_RELEASE_GATES.md
  NEXT_MILESTONES.md
  EF_C0_DECISION.md
  HANDOFF.md
  data/
    git-stage-map.json
    change-inventory.json
    artifact-manifest.json
    effective-config-matrix.json
    evidence-registry.json
    baseline-comparison-manifest.json
    gate-status.json

eval/c0/
  git-audit.mjs
  config-matrix.mjs
  evidence-registry.mjs
  gates.mjs
  out/
    git-audit.json
    config-matrix.json
    evidence-registry-summary.json
    c0-tests.json
    full-tests-summary.json

tests/
  convergence-config.spec.ts
  convergence-boundaries.spec.ts
  convergence-evidence.spec.ts
  convergence-gates.spec.ts
  c0-eval.d.ts
```

## 9. Unresolved issues

1. **The test suite rewrites historical evidence paths.** See §4.5. A future
   round should make the R33/R1 report tests write to a temp directory or an
   explicitly non-historical path.
2. **`engine.ts` is 3,716 lines** with the semantic branch interleaved. A split
   is not justified yet; the boundary is testable without one.
3. **The thermal observer is research code in `src/`.** It has no production
   import and only a test. Move it to `eval/` or wire it; decide separately.
4. **The `decision` authority domain does not distinguish user from assistant.**
   This is the highest remaining semantic safety question (M2).
5. **The R38-M1 experiment is on hold.** No manifest, no authorization, no
   execution. The old preregistration file is unchanged.
6. **CI pins DSH 0.2.0-rc.2 while devDependencies are 0.2.1-rc.3.** This is the
   source of the known drift failures. Recorded, not fixed.
7. **PR #4 is open and likely superseded.** Review/close is a separate
   authorization.

## 10. Next executable commands

```bash
npm run eval:c0-audit
npm run eval:c0-config
npm run eval:c0-evidence
npm run eval:c0-tests
npm run eval:c0-gates
# or the whole chain
npm run eval:c0
```

Do not push, merge, rebase, tag or delete a branch without a separate
authorization. Do not run a live experiment without a new frozen manifest and a
new explicit authorization naming its SHA.
