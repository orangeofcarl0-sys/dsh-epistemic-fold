# R37-B — Handoff

## State

```text
Repository            orangeofcarl0-sys/dsh-epistemic-fold
Base commit           b8274bba8b2a974e9c75af283e415e61a650295e (R36 HEAD)
R37-A HEAD            e78780d1c44995d9208f272520d4af01ae24ed6c
R37-B branch          rc37-semantic-action
Worktree              F:/Codex_Work_Space/DSH plugin/ef-r37-action
Final HEAD            this handoff commit
Push                  not authorized, not performed
H-native              blocked (not implemented)
```

Commit map:

```text
b8274bb  R36 HEAD / R37-A base
7d519f2  test(eval): establish the R37 baseline and freeze R36 evidence
89f7fc6  feat(eval): reconstruct run-level semantic-to-action evidence
8d2b730  feat(eval): isolate the DSML protocol layers and deterministic recovery
6e5919b  fix(eval): version the A1 and D1 benchmark contracts
73412b3  feat(eval): add B2/C1 forensics and controlled representation fixtures
ada372f  docs(eval): preregister R37-B and publish the R37-A gates
e78780d  docs(eval): publish the R37-A decision and handoff
2a38fdd  feat(eval): wire the R37-B P3e and fixture arms into the live harness
05bfb40  feat(eval): record the R37-B Stage 1 exploratory comparison
3ed0fa4  feat(eval): record the R37-B Stage 2 confirmatory result
```

The final commit adds this handoff and the one-line R37 test fixture fix.

## What was run

```text
Authorization          user granted R37-B on 2026-11-06
Model                  deepseek-v4.1-flash
Route                  local omnigate2api, http://127.0.0.1:7866/v1
Harness                H-protocol-e / P3e (JSON + both DSML forms + unescape + validation)
Cases                  A1-v2, D1-v2, B2, C1, F1, H1
Stage 1                4 replicates per cell, exploratory
Stage 2                6 replicates per cell, confirmatory
Stage 1 and Stage 2    separate run roots; not pooled
```

The local gateway stopped during the first Stage 1 O2 pass (`ECONNREFUSED`).
The affected rows are provider-invalid, were retried under new run IDs, and
remain counted in cost. The gateway was restarted from its own
`F:/Codex_Work_Space/omnigate2api/start.sh`; no key was written to any log.

## Results

### Stage 1 (exploratory)

```text
writer W0   10/24 parsed, recall 0.396, 25 accepted, 3 refused
writer W1   23/24 parsed, recall 0.813, 51 accepted, 8 refused
O2          17/23 contract (73.9%), 17/23 task
B2 rep      F-P 3/4, F-S 4/4, F-N 2/4
C1 rep      F-P 1/4, F-S 0/4, F-H 0/4
B1/S        24 pairs: 3 rescue / 8 damage / 10 both / 3 neither (contract)
task        3 rescue / 6 damage / 12 both / 3 neither
protocol    569 turns, 792 valid actions, 93 rejected, unparsed-turn rate 5.1%
```

### Stage 2 (confirmatory)

```text
writer W0   22/36 parsed, recall 0.500, 54 accepted, 14 refused
writer W1   32/36 parsed, recall 0.722, 72 accepted, 8 refused
O2          24/36 contract (66.7%), 26/36 task
B2 rep      F-P 4/6, F-S 6/6, F-N 3/6
C1 rep      F-P 0/6, F-S 1/6, F-H 1/6
B1/S        36 pairs: 1 rescue / 9 damage / 17 both / 9 neither (contract)
task        2 rescue / 7 damage / 20 both / 7 neither
protocol    819 turns, 1148 valid actions, 121 rejected, unparsed-turn rate 4.5%
```

Paired statistics:

```text
contract   S 50.0% vs B1 72.2%; difference -22.2 pp
           exact McNemar 1/9, p = 0.0215
           case-clustered bootstrap 95% CI -30.6 to -11.1 pp
task       S 61.1% vs B1 75.0%; difference -13.9 pp
           exact McNemar 2/7, p = 0.1797
           case-clustered bootstrap 95% CI -25.0 to -2.8 pp
```

S delivery, Stage 2:

```text
semantic-committed        31
full-history-fallback      4
semantic-committed-empty   1
determined                35/36 (97.2%)
```

Representation paired (Stage 2):

```text
B2 F-S vs F-P   2 wins / 0 losses / 4 ties, p = 0.50
B2 F-N vs F-P   1 win  / 2 losses / 3 ties, p = 1.00
C1 F-S vs F-P   1 win  / 0 losses / 5 ties, p = 1.00
C1 F-H vs F-P   1 win  / 0 losses / 5 ties, p = 1.00
```

## Decision

```text
Previous: insufficient evidence for Active vs Off
Current:  Active not supported; confirmatory harm signal on contract success
```

The benefit criterion (rescue > damage, McNemar p < 0.05, delivery determined
>= 80%) is not met. The direction is negative. Eight of the nine Stage 2
contract damages are implementation/process failures (no test run or broken
code), not fact loss. H1 is the only fact-visible, action-inconsistent damage;
it also produced the only Stage 2 rescue, so it is variable.

The correct posture is a deployment hold, not a rollout. The result is not a
population estimate: one model, one route, one harness, six cases.

## Gates

```text
R37-A G0-G4   passed
R37-A G5      ready-not-authorized (superseded by R37-B authorization)
R37-A G6      insufficient-evidence (superseded by Stage 2)

R37-B Stage 1 all six gates passed; stage-1-complete
R37-B Stage 2 all six gates passed; stage-2-complete
R37-B product active-not-supported-harm-signal
```

Authoritative files:

```text
eval/r37/out/gate-status.json
eval/r37/out/gate-status-r37b.json
eval/r37/out/gate-status-r37b-stage2.json
```

## Cost

```text
Stage 1   777 HTTP attempts, 884,561 input, 167,871 output, 703,461 cache,
          6 unknown-usage, 19 invalid measurements
Stage 2 1,088 HTTP attempts, 1,250,840 input, 235,317 output, 999,626 cache,
          1 unknown-usage, 11 invalid measurements
Total   1,865 HTTP attempts, 2,135,401 input, 403,188 output, 1,703,087 cache,
          7 unknown-usage, 30 invalid measurements
Currency not reported.
```

Invalid measurements are counted in cost and excluded from the deduplicated
outcome cells. They are not task failures.

## Verification at this HEAD

```text
Typecheck                 pass (src, client, eval)
R37 tests                 49/49 pass
Targeted R33/R34.1/R35    94/94 pass
R36 tests                 34/34 pass
Full suite                1525 passed, 12 failed, 70 skipped
```

The 12 failures are the same pre-existing vendor/DSH-drift set recorded by R36:
four need the absent `vendor/deepseek-harness`, eight are installed-vs-vendored
DSH differences. No R37 test fails.

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
  r37b-results.json                 Stage 1
  gate-status-r37b.json             Stage 1 gates
  r37b-stage2-results.json          Stage 2
  r37b-stage2-statistics.json       paired stats
  gate-status-r37b-stage2.json      Stage 2 gates

eval/r37/runs-b/                    Stage 1 local archive (gitignored)
eval/r37/runs-b2/                   Stage 2 local archive (gitignored)
eval/r37/manifests-b/               Stage 1 manifests (gitignored)
eval/r37/manifests-b2/              Stage 2 manifests (gitignored)

docs/semantic-continuity/
  R37_BASELINE.md
  R37_EVIDENCE_AUDIT.md
  R37_PROTOCOL_ATTRIBUTION.md
  R37_BENCHMARK_VALIDITY.md
  R37_BEHAVIORAL_FORENSICS.md
  R37_B_PREREGISTRATION.md
  R37_B_PREREGISTRATION_AMENDMENT.md
  R37_DECISION.md
  R37_B_STAGE1.md
  R37_B_STAGE2.md
  R37_B_DECISION.md
  R37_HANDOFF.md
  R37_B_HANDOFF.md
```

## Commands

```bash
npm ci
npm run build
npm run eval:build
npm run typecheck
npm run eval:r37-tests

# R37-A offline
npm run eval:r37
npm run eval:r37b-analyze
npm run eval:r37b-gates

# R37-B live (requires authorization and a running local gateway)
R37B_PHASE=writer R37B_REPLICATES=6 \
  R37B_RUN_ROOT=eval/r37/runs-b2 \
  R37B_MANIFEST_ROOT=eval/r37/manifests-b2 \
  R37B_PROGRESS=eval/r37/out/r37b-stage2-writer-progress.json \
  node eval/r37/live-r37b.mjs

R37B_PHASE=representation R37B_REPLICATES=6 ...
R37B_PHASE=end-to-end R37B_REPLICATES=6 ...
R37B_PHASE=o2 R37B_REPLICATES=6 ...

R37B_RUNS=eval/r37/runs-b2 \
  R37B_OUT=eval/r37/out/r37b-stage2-results.json \
  R37B_STAGE=stage2 R37B_STAGE_REPLICATES=6 \
  node eval/r37/analyze-r37b.mjs

node eval/r37/stats-r37b.mjs

R37B_RESULTS=eval/r37/out/r37b-stage2-results.json \
  R37B_GATES_OUT=eval/r37/out/gate-status-r37b-stage2.json \
  R37B_PAIR_EXPECTED=36 R37B_REP_EXPECTED=36 R37B_O2_MIN_VALID=30 \
  R37B_STAGE_NUMBER=2 R37B_PRODUCT_DECISION=active-not-supported-harm-signal \
  node eval/r37/gates-r37b.mjs
```

## What remains unknown

- Whether the process-compliance harm is caused by the checkpoint, the prompt,
  or model variance.
- Whether H1's action inconsistency replicates; H1's visible test checks only
  the type, not `eu-west-2`, so the case has a visible/hidden gap.
- Whether a structured representation helps B2 beyond noise.
- Whether the harm persists on another model or route.
- Whether a real DSH native runtime changes the floor. H-native remains blocked.

## What must run next

1. Replicate Stage 2 on a second model and route.
2. Separate process-prompt / finish-guard interventions from Active; do not
   bundle them into the product arm.
3. Fix the H1 visible test or treat H1 as a benchmark limitation.
4. Re-run the representation contrast on more cases before claiming a
   structured-representation effect.
5. Do not add a new semantic component until the process harm is explained.

## Caveats

- Stage 1 and Stage 2 are not pooled.
- The Stage 2 result is one model, one route, one harness, six cases.
- The case-clustered bootstrap is descriptive, not a population interval.
- The task outcome is directionally negative but not significant; the contract
  outcome is the primary result.
- The provider outage rows are invalid measurements, not task failures.
- No credentials were written to any manifest, log, report, or commit.
- No push was performed.
