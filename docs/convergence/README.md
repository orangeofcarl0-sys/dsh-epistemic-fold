# Epistemic Fold — Convergence (EF-C0 / EF-C1)

Status: current project entry, 2026-11-08.

This directory is the single authoritative entry for the project's current
state. Historical round documents under `docs/semantic-continuity/` remain the
research archive; they are not rewritten.

## The five core documents

| Document | Answers |
|---|---|
| [PROJECT_CHARTER.md](PROJECT_CHARTER.md) | what EF is, the three tracks, ownership, non-goals |
| [ARCHITECTURE_BASELINE.md](ARCHITECTURE_BASELINE.md) | what the code actually does |
| [REPOSITORY_GOVERNANCE.md](REPOSITORY_GOVERNANCE.md) | branch roles, push/PR/merge/release discipline |
| [EVIDENCE_REGISTRY.md](EVIDENCE_REGISTRY.md) | what is proven, at what level, with which artifact |
| [RESEARCH_ROADMAP.md](RESEARCH_ROADMAP.md) | what remains open and how it can be promoted |

## EF-C1 — evaluation foundation

| Document | Answers |
|---|---|
| [C1_EVIDENCE_ISOLATION.md](C1_EVIDENCE_ISOLATION.md) | which commands wrote historical files, and how that stopped |
| [C1_DSH_COMPATIBILITY.md](C1_DSH_COMPATIBILITY.md) | the three DSH identities, the 12 failures, the supported lanes |
| [C1_CORE_BASELINE.md](C1_CORE_BASELINE.md) | B0 / Bv / E0 / E1 offline calibration |
| [C1_LIVE_PREREGISTRATION.md](C1_LIVE_PREREGISTRATION.md) | the bounded experiment that is **not authorized** |
| [C1_DECISION.md](C1_DECISION.md) | the C1 answers, A-G, and the Track B handoff |
| [C1_HANDOFF.md](C1_HANDOFF.md) | the round report: commits, gates, tests, blockers |

## EF-E2E — real tasks, native host, bounded live runs

| Document | Answers |
|---|---|
| [E2E_EXECUTION.md](E2E_EXECUTION.md) | scope, envelope, native harness, tasks, frozen manifests, evidence layout |
| [E2E_RESULT.md](E2E_RESULT.md) | what the core/pilot/retest campaigns show, what was fixed, what remains unknown |

The E2E campaigns executed 59 cells on `deepseek-v4.1-flash` inside the
envelope's request/token/time caps. Results are exploratory: two seeds per
template, one model, one route. The deployment hold stands, and no default is
recommended by this round.

Supporting documents:

```text
REPOSITORY_HISTORY.md        stage map, ancestry, change distribution
EVIDENCE_INVENTORY.md        artifact census, external archive, reconstruction
FEATURE_AND_SCOPE_MATRIX.md  Core / Optional / Research / Deferred / Deprecated
CONFIGURATION_TRUTH.md       tiers, switches, auxiliary calls, doc drift
BOUNDARY_CONTRACTS.md        C1-C7, mechanism and test
BASELINE_EVIDENCE_REVIEW.md  the five evidence questions
PRODUCT_INTEGRATION_PLAN.md  how Track B could reach main, and why it does not yet
CI_AND_RELEASE_GATES.md      current CI, proposed gates, release checklist
NEXT_MILESTONES.md           the next five questions
EF_C0_DECISION.md            the convergence decision, A-G
```

## The state in one screen

```text
Product            EF Active: deployment hold
deploymentEligible false
Track A            Compression Runtime — product baseline, works with semantic off
Track B            Semantic Continuity — optional, default off, mechanism evidence only
Track C            Context Intelligence — research, eval code, no runtime path

origin/main        93b6666   Track A only; no src/semantic
R38 research       0067020   96 commits ahead of main; Track A + B + C
Product-level
evidence           0
Live calls in R38  0
```

## What convergence changed

```text
- a verified repository/stage/evidence map
- a configuration truth table generated from the resolver
- C1-C7 boundary contracts with tests
- an 18-claim evidence registry with hashed artifacts
- branch/push/PR/release governance
- a research roadmap that keeps Track B/C open
```

It did **not** merge R38 into main, rebase it, delete a branch, create a tag, or
push anything.

## How to verify this round

```bash
# EF-C0 convergence
node eval/c0/git-audit.mjs
node eval/c0/config-matrix.mjs
node eval/c0/evidence-registry.mjs
npx vitest run tests/convergence-config.spec.ts tests/convergence-boundaries.spec.ts
node eval/c0/gates.mjs

# EF-C1 evaluation foundation
npm run eval:c1-evidence      # protected registry + side-effect inventory
npm run eval:c1-compat        # DSH fingerprint
npm run eval:c1-readiness     # live readiness (not-authorized)
npm run eval:c1-tests         # 33 targeted tests
npm run eval:c1-gates         # C1-G0..G7
npm run eval:c1a-gate         # C1A A0..A5
```

The C0 gate report is `docs/convergence/data/gate-status.json`; the C1 reports
are `eval/c1/out/gate-status.json` and `eval/c1/out/c1a-gate.json`.

## Reading order for a new contributor

```text
1. this README
2. PROJECT_CHARTER.md
3. ARCHITECTURE_BASELINE.md
4. CONFIGURATION_TRUTH.md
5. BOUNDARY_CONTRACTS.md
6. EVIDENCE_REGISTRY.md
7. RESEARCH_ROADMAP.md
```

A historical round document is evidence, not current policy. When it disagrees
with a convergence document, the convergence document is current and the
historical document is history.
