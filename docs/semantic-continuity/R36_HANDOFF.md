# R36 — Handoff

## State

```text
Repository            orangeofcarl0-sys/dsh-epistemic-fold
Base                  R35 HEAD 914ed317ae022ac9c5fe39f098d406b7ce03c8da
Branch                rc36-semantic-interface
Worktree              F:/Codex_Work_Space/DSH plugin/ef-r36-interface
Dataset               r33-semantic-continuity-v2
Dataset digest        407148f0c3280ada831b72150640ac6cdf14dceae600c3dcdbf2a61bd8e0c87f
Scorer                v3
W0 prompt digest      1d13166dfaba145986af0d183d1739ed2835aca76668774dada15f0aaf937abc
W1 prompt digest      61f380abc4fc2e98a02a55891a9a06c8e41040fbaf845f276ca6bbeadab3b5a3
R35 worktree          untouched; run archive read-only
R36 provider requests 0
R36 commits           af6e533, 1e36ca8, 0b354b1, d3fc6e0, 7b25ea0
Push                  not authorized, not performed
```

The primary worktree and the R30–R35 worktrees were not reset, cleaned, or
overwritten. The new worktree was created from the verified R35 HEAD.

Commit map:

```text
af6e533  fix(eval): score verification at the final state and calibrate the loop
1e36ca8  feat(semantic): version the writer contract and align W1 with the validator
0b354b1  feat(eval): audit R35 evidence and add the P1 parser ablation
d3fc6e0  feat(eval): certify benchmark feasibility and freeze R36 conditions
7b25ea0  docs(eval): publish R36 evidence, decision, and handoff
```

## What changed

- R35 evidence is reconstructed from the real reports and raw outputs:
  per-attempt table, six-way protocol classification, L0–L4 fact funnel,
  handoff-exposure measurement.
- D1's scorer is temporal: historical t0 status is separate from the final
  status derived from trusted tool runs. `verification.json` is no longer
  execution evidence.
- C1 has a certified hybrid reference: polling is the delivery guarantee,
  watch is an optional hint. Visible and hidden tests both pass.
- A1/B2/C1/D1/D2/F1/H1 are certified for visible tests, hidden checker, and
  historical contract.
- `selectCases` preserves request order and refuses unknown/duplicate ids.
- `cost.modelRequests` is a per-case delta, not the run total.
- W1 is the production writer contract; W0 is preserved byte-for-byte.
- P1 is a bounded envelope-recovery ablation. It is not in the production
  parser.
- The continuation loop records tool-protocol diagnostics, step/output limits,
  truncation, finish reasons, and a finish guard. Guard-assisted completion is
  reported separately from unguided compliance.
- H-native is declared and refused before any provider request; it is not
  implemented.
- Conditions and 10 manifests are frozen. Every live manifest is marked
  `blocked`; no R36 spend was authorized.

## Results

```text
Writer attempts                 17 (16 scoreable, 1 lost)
Protocol parsed                 10/16
Protocol categories             parsed 10, bare-array 4, bare-object 1,
                                invalid-json 1, unknown 1
Raw fact mention                1.000
Proposal recall                 0.594
Accepted / commit recall        0.563
Direct visibility               0.625
Handoff refusals in machine state 0
Narrative-only exposures        4
P0 → P1 accepted fact recall    0.5625 → 0.875
P1 recovered                    5/6; content preserved
Cases certified                 7/7
R36 live runs                   0
```

The key attribution: the writer's understanding was not the bottleneck; the
envelope and authority/status contract were. H1 is the clearest case: the
production region is in the raw text and never reaches a proposal.

## Gates

| gate | status |
|---|---|
| G0 R35 Evidence Closed | passed |
| G1 Benchmark Valid | passed |
| G2 Writer Experiment | blocked (W1-P0 live not authorized) |
| G3 Agent Identifiability | blocked (H-native absent; live O2 not authorized) |
| G4 Real Causal Comparison | blocked |
| G5 Product Decision | insufficient evidence |

`eval/r36/out/gate-status.json` is authoritative.

## Commands

```bash
npm ci
npm run build
npm run eval:build

npm run eval:r36-audit       # rebuild R35 evidence audit
npm run eval:r36-parser      # P0/P1 ablation
npm run eval:r36-certify     # 7-case solvability certification
npm run eval:r36-conditions  # freeze prompt/parser/validator/harness digests
npm run eval:r36-manifests   # rewrite the 10 condition manifests
npm run eval:r36-gates       # gate status; exits non-zero only on a failed gate

npm run eval:r36-tests       # 25 R36 tests
npm run eval:r33             # 94 targeted R33/R34.1/R35 tests
npm run typecheck
```

Note: `npm run eval:r33` needs `npm run eval:build` first in a fresh worktree;
without the built adapter, the live-entry tests stop at "adapter not built".

## Verification at this HEAD

```text
Typecheck                 pass (src, client, eval)
Targeted R33/R34.1/R35    94/94 pass
R36 tests                 25/25 pass
Full suite                1467 passed, 12 failed, 70 skipped
```

The 12 full-suite failures are the pre-existing environment/DSH-drift set, not
R36 failures:

- 4 need the absent `vendor/deepseek-harness` checkout
  (`bridge-loads`, `rc3-plugin-packaging`, two `rc7-vendored-basic`).
- 8 are installed-vs-vendored DSH differences
  (`checkpoint-residency` x2, `eval-corpus`, `p0-regressions`,
  `persistence-compat` x2, `plugin-composition`, `rc7-inplace-drift`).

R35 recorded a different baseline count because its worktree had a generated
`cordis.patch.yml` and a different installed DSH line. The R36 worktree restored
the tracked file, so `rc7-inplace-drift` joins the visible drift set. No R36
test fails. The full-suite run regenerates `eval/r33/out/*` and
`docs/MANIFEST.json`; those test-generated changes were restored to `HEAD`.

## Artifacts

```text
eval/r36/evidence/r35/
  writer-audit.json              per-attempt table, funnel, exposure
  reports/*.json                 frozen R35 reports
  raw-writer/**                  frozen raw writer outputs
  continuation-writers.json      compact S-row writer evidence

eval/r36/out/
  parser-ablation.json
  case-certification.json
  conditions.json
  gate-status.json

eval/r36/manifests/              10 condition manifests, 8 live-blocked
eval/r36/reference/              A1/C1/D1/F1/H1 reference fixtures
docs/semantic-continuity/R36_*   this round's documents
```

## Next step

Do not run the live manifests without an explicit R36 authorization naming the
model, route, request limit, input/output budgets, wall clock, per-request
output bound, and approved scope.

When authorized:

1. Paired W0-P0 / W1-P0 writer pilot.
2. O2 harness calibration: H0, H-step, H-output, H-finish.
3. Freeze final conditions and run B1/S/O1/O2.
4. Report rescue/damage/both/neither and provider/budget/invalid/incomplete
   pairs; do not pool with R35 r1/r2/r3.

## Caveats

- R35 did not record a per-run git SHA or writer finish reason. The audit uses
  `null`, not an inferred commit.
- F1's initial raw output is lost; the call and its cost remain counted.
- R35 r2 continuation is invalid and remains so.
- The 0/0 R35 pair result is not equivalence.
- Guard-assisted success is not unguided compliance.
- H-native is not implemented; no native-runtime result exists.
- No currency is reported.
