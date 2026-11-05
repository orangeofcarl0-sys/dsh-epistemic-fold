# R37-A — Handoff

## State

```text
Repository            orangeofcarl0-sys/dsh-epistemic-fold
Base commit           b8274bba8b2a974e9c75af283e415e61a650295e (R36 HEAD)
Branch                rc37-semantic-action
Worktree              F:/Codex_Work_Space/DSH plugin/ef-r37-action
Base worktree         F:/Codex_Work_Space/DSH plugin/ef-r36-interface (read-only, clean)
Dataset               r33-semantic-continuity-v2
Dataset digest        407148f0c3280ada831b72150640ac6cdf14dceae6003c3dcdbf2a61bd8e0c87f
Provider requests     0 in R37-A
R37-B authorization   not granted
Push                  not authorized, not performed
H-native              blocked
```

Commit map before the handoff:

```text
7d519f2  test(eval): establish the R37 baseline and freeze R36 evidence
89f7fc6  feat(eval): reconstruct run-level semantic-to-action evidence
8d2b730  feat(eval): isolate the DSML protocol layers and deterministic recovery
6e5919b  fix(eval): version the A1 and D1 benchmark contracts
73412b3  feat(eval): add B2/C1 forensics and controlled representation fixtures
ada372f  docs(eval): preregister R37-B and publish the R37-A gates
```

The final HEAD is the commit that adds this handoff. The worktree was clean
before that commit except for the handoff itself; test-generated
`docs/12_R1_EVALUATION_REPORT.md`, `docs/MANIFEST.json`, `eval/r33/out/*` and
`ef-phase7-logs/watchdog.heartbeat` were restored/removed and are not in any
R37 commit.

## What changed

- `eval/r37/baseline.mjs` writes `eval/r37/out/baseline-manifest.json`: R36
  worktree identity, 32 authoritative file digests, 12 causal reports, 36 arm
  traces, final workspace/journals/bundles, dataset digest, environment, and
  the rebuilt test baseline.
- `eval/r37/src/evidence.mjs` and `eval/r37/reconstruct-r36.mjs` rebuild every
  R36 arm row from the report and trace bytes. They separate assigned arm from
  actual delivery, produce the semantic funnel, classify the first observable
  failure and sufficient cause, and compare their own 12-pair counts with the
  R36 aggregate.
- `eval/r37/src/tool-protocol-r37.mjs` and `eval/r37/protocol-ablation.mjs`
  implement P0/P1/P2/P3/P3e/P4 parsers, validation diagnostics, provenance
  checks, and deterministic B2 dispatch recovery.
- `eval/r37/cases/A1-v2` and `eval/r37/cases/D1-v2` are versioned benchmark
  repairs. Old A1/D1 are unchanged. `eval/r37/benchmark-validity.mjs` certifies
  reference and counterfactual behavior.
- `eval/r37/forensics.mjs` builds the B2/C1 timelines and six controlled
  representation fixtures.
- `eval/r37/gates.mjs` writes G0–G6 from the artifacts.
- `tests/r37-*.spec.ts` add 49 deterministic tests. `tests/r37-eval.d.ts` gives
  the TypeScript tests the surface of the plain-JS R37 modules.
- `package.json` adds the R37 scripts.

## Results

### Evidence reconstruction

```text
R36 pairs reproduced    12
contract                1 rescue / 3 damage / 4 both / 4 neither
task                    1 rescue / 2 damage / 5 both / 4 neither
row integrity           36/36
score discrepancies     0
arm-not-run notes       12 (r2 selected B1/S only)
```

Delivery:

```text
B1 EF-off                12
S semantic-committed     11
S full-history fallback   1 (C1 r1)
O1 semantic-committed     6
O2 oracle-gold-facts      6
```

S funnel over 16 fact-instances:

```text
source visible           16/16  1.000
writer mentioned         16/16  1.000
accepted delta           15/16  0.938
committed state          14/16  0.875
rendered checkpoint      16/16  1.000
```

The two committed misses are the two C1 facts in the refused r1 fold.

### Protocol

```text
corpus                   58 runs, 91 trace rows, 732 turns
P0 valid actions         302
P1                       472  (+170 complete DSML)
P2                       555  (+83 short attribute)
P3                       852  (+297 multi-action)
P3e                      852  (same count, decoded content)
P4                       856  (+4 raw-body, experimental)
```

Deterministic B2 r1 S:

```text
stored bytes             node --check fail, hidden checker fail
P3e decoded bytes        node --check pass, hidden checker pass
```

### Benchmark validity

```text
A1-v2  reference visible/hidden pass; string-form counterfactual fails hidden
D1-v2  reference visible/hidden pass; false-verified counterfactual fails claim-accuracy
old A1/D1 bytes and R36 scores unchanged
```

### Forensics

```text
B2 r1  semantic-committed, changed src/scheduler.mjs, tool-parameter-corruption,
       action-consistent with the in-memory decision
B2 r2  semantic-committed, zero writes, zero tests, workspace byte-identical,
       no-observed-action
C1 r1  full-history-fallback, zero writes, fold packet aborted
C1 r2  semantic-committed, polling watcher, contract success (candidate, n=1)
```

### Gates

```text
G0 Baseline Integrity          passed
G1 Evidence Reconstruction     passed
G2 Protocol Attribution        passed
G3 Benchmark Validity          passed
G4 Behavioral Identifiability  passed
G5 Live Experiment Readiness   ready-not-authorized
G6 Product Decision            insufficient-evidence
```

`eval/r37/out/gate-status.json` is authoritative.

## Verification at this HEAD

```text
Typecheck                 pass (src, client, eval)
R37 tests                 49/49 pass
Targeted R33/R34.1/R35    94/94 pass
R36 tests                 34/34 pass
Full suite                1525 passed, 12 failed, 70 skipped
```

The 12 full-suite failures are the same pre-existing environment/DSH-drift set
recorded by R36:

- 4 need the absent `vendor/deepseek-harness` checkout
  (`bridge-loads`, `rc3-plugin-packaging`, two `rc7-vendored-basic`).
- 8 are installed-vs-vendored DSH differences
  (`checkpoint-residency` ×2, `eval-corpus`, `p0-regressions`,
  `persistence-compat` ×2, `plugin-composition`, `rc7-inplace-drift`).

The baseline was 1476 passed / 12 failed / 70 skipped; the R37 addition is 49
passing tests, so 1525 is the expected full-suite count.

## What was reproduced

- The R36 12-pair contract and task counts.
- The 36 arm rows' checkpoint, writer, state, and workspace identities.
- The C1 r1 fallback and C1 r2 commit.
- The B2 r1 checker failure and its post-unescape pass.
- The D1 r1 invalid claim vocabulary and D1 r2 missing/empty artifact.

## What remains unknown

- The R36 trace stores only 1000 characters per turn. The full step-5 B2 write
  turn is not available, so its exact live parse is an unresolved hypothesis.
- Why B2 r2 stopped after seven reads without writing or testing.
- Whether P3e improves live task success rather than only offline recovery.
- Whether the C1 r2 candidate replicates.
- Whether the plain-vs-structured representation changes action choice.
- Whether a real DSH native runtime changes the harness floor.

## What is blocked

- R37-B live experiments: `blocked-live-authorization`.
- H-native: `blocked-implementation`.
- Any product claim from R37-A: blocked by design; the decision is
  `insufficient evidence`.

## What must run next

R37-B, only after explicit spend authorization:

1. Freeze the R37-B manifest (model, route, limits, case versions, harness).
2. Run the A1-v2/D1-v2 and writer/O2 calibration phases.
3. Run B2/C1 representation cells and the B1/S end-to-end pairs.
4. Analyze with case-level clustering, paired rescue/damage counts, and the
   preregistered McNemar rule.
5. Publish `R37_B_*` results; do not overwrite the R37-A artifacts.

## Commands

```bash
npm ci
npm run build
npm run eval:build

node eval/r37/baseline.mjs            # refuses to overwrite an executed baseline
R37_RUN_TESTS=1 node eval/r37/baseline.mjs  # full rebuild incl. the test baseline

npm run eval:r37-reconstruct          # R36 evidence reconstruction
npm run eval:r37-protocol             # DSML layer ablation + B2 dispatch recovery
npm run eval:r37-benchmark            # A1-v2/D1-v2 certification
npm run eval:r37-forensics            # B2/C1 timelines + fixtures
npm run eval:r37-gates                # G0–G6
npm run eval:r37-tests                # 49 R37 tests
npm run eval:r37                      # reconstruct → protocol → benchmark → forensics → gates
```

`eval:r37` does not call a provider. `eval:r37-baseline` refuses to overwrite the
executed baseline unless `R37_RUN_TESTS=1` or `R37_FORCE_BASELINE=1`.

## Artifacts

```text
eval/r37/out/
  baseline-manifest.json
  r36-evidence-reconstruction.json
  r36-evidence-discrepancies.json
  protocol-ablation.json
  benchmark-validity.json
  forensics.json
  representation-fixtures.json
  gate-status.json

eval/r37/cases/A1-v2/        versioned case, checker, reference, workspace
eval/r37/cases/D1-v2/        versioned case, checker, reference, workspace
eval/r37/fixtures/           six controlled representation contexts
docs/semantic-continuity/    R37_BASELINE, R37_EVIDENCE_AUDIT,
                             R37_PROTOCOL_ATTRIBUTION, R37_BENCHMARK_VALIDITY,
                             R37_BEHAVIORAL_FORENSICS, R37_B_PREREGISTRATION,
                             R37_DECISION, R37_HANDOFF
```

## Caveats

- No provider request was made in R37-A; the only route information in the
  baseline is the R36 route, and no key is recorded.
- The R36 run archive is local and gitignored. The baseline identifies its
  bytes by digest; it is not a second copy.
- The r2 report rows carry `replicateId: r1` because the runner used its
  default. R37 uses the run-id prefix for analysis and records the runner value
  separately.
- The token estimates in the fixtures are `ceil(chars/4)`, not provider tokens.
- No currency is reported.
- Do not pool the old A1/D1 with the v2 cases, and do not pool the C1 r1
  fallback with the committed semantic-checkpoint runs.
- A harness repair is not EF evidence; a single C1 pair is not a product effect.
