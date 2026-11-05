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
R36 provider requests 845 (12 writer + 833 continuation)
R36 live route        local ZCode proxy 127.0.0.1:7866 (provider c15ab109…); direct keys expired
R36 commits           af6e533, 1e36ca8, 0b354b1, d3fc6e0, 7b25ea0, c6bf179, 8a7aef4, 5273faa
Push                  not authorized, not performed
```

The primary worktree and the R30–R35 worktrees were not reset, cleaned, or
overwritten. The new worktree was created from the verified R35 HEAD.

The user granted R36 spend on 2026-11-05. The three direct `/zen/go/v1` keys
answered HTTP 401 `api_key_expired`; the authorized runs used the local ZCode
proxy, which passed the production 16,384-token probe. The key was read at
runtime and never written to a report.

Commit map:

```text
af6e533  fix(eval): score verification at the final state and calibrate the loop
1e36ca8  feat(semantic): version the writer contract and align W1 with the validator
0b354b1  feat(eval): audit R35 evidence and add the P1 parser ablation
d3fc6e0  feat(eval): certify benchmark feasibility and freeze R36 conditions
7b25ea0  docs(eval): publish R36 evidence, decision, and handoff
c6bf179  docs(eval): record R36 verification counts and commit map
8a7aef4  feat(eval): add W0/W1 selection and the authorized live runner
5273faa  docs(eval): record the authorized R36 live results and harness floor
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
- Conditions and 11 manifests are frozen. Phase B/C manifests and the B1/S
  manifest are `executed` with run IDs; only H-native remains `blocked`.
- The live W0/W1 pair, the O2 calibration, and the B1/S comparison were run on
  2026-11-05. The same-time writer pair is 2/6 vs 6/6 parsed and 0.167 vs 0.917
  commit recall. The H-protocol tool-parser fix lifts O2 to 5/6 contract
  success. The B1/S comparison is 1 rescue / 3 damage / 4 both / 4 neither
  over 12 pairs; the damage is confounded by A1's task/gold ambiguity and B2's
  code/process variance.

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

W0 live control                 2/6 parsed, 4 accepted, 0 refused, commit 0.167
W1 live                         6/6 parsed, 14 accepted, 1 refused, commit 0.917
O2 H0                           1/6 contract, 2/6 task
O2 H-protocol                   5/6 contract, 5/6 task
B1/S pairs                      12: 1 rescue, 3 damage, 4 both, 4 neither
R36 HTTP attempts               845 (16 transport failures)
R36 observed tokens             777,005 input / 114,404 output / 581,622 cache
```

The key attribution: the writer's understanding was not the bottleneck; the
envelope and authority/status contract were. W1 removes the envelope failure
mode in the live pair. The bigger execution floor was the **tool protocol**:
the model emitted DSML invocations that H0 ignored. H-protocol parses JSON and
both DSML forms, and O2 rises to 5/6 contract success. The remaining D1 failure
is the missing `verification.json`; B2 damage is a code/process issue, and A1's
damage is a task/gold ambiguity.

## Gates

| gate | status |
|---|---|
| G0 R35 Evidence Closed | passed |
| G1 Benchmark Valid | passed |
| G2 Writer Experiment | passed (live pilot, 1 replicate) |
| G3 Agent Identifiability | partial (H-protocol 5/6 contract; D1 artifact; H-native absent) |
| G4 Real Causal Comparison | partial (12 exploratory pairs, mixed/confounded) |
| G5 Product Decision | insufficient evidence (Active vs Off) |

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

npm run eval:r36-tests       # 34 R36 tests
npm run eval:r33             # 94 targeted R33/R34.1/R35 tests
npm run typecheck

# authorized live staging (only with explicit spend authorization)
R36_PROMPT=W1 R36_STAGE=writer-only node eval/r36/run-authorized.mjs
R36_STAGE=continuation R36_ARMS=O2 R36_FINISH_GUARD=1 node eval/r36/run-authorized.mjs

# result analysis, no provider call
node eval/r36/analyze-live.mjs r36-writer-w0-r1 r36-writer-w1-r1
node eval/r36/analyze-harness.mjs
node eval/r36/record-live.mjs
```

Note: `npm run eval:r33` needs `npm run eval:build` first in a fresh worktree;
without the built adapter, the live-entry tests stop at "adapter not built".

## Verification at this HEAD

```text
Typecheck                 pass (src, client, eval)
Targeted R33/R34.1/R35    94/94 pass
R36 tests                 34/34 pass
Full suite                1476 passed, 12 failed, 70 skipped
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
  live-writer-analysis.json
  harness-calibration.json
  causal-comparison.json
  live-results.json
  gate-status.json

eval/r36/manifests/              12 condition manifests; H-native blocked, rest executed
eval/r36/reference/              A1/C1/D1/F1/H1 reference fixtures
eval/r36/runs/                   local run archive (gitignored)
docs/semantic-continuity/R36_*   this round's documents
```

## Next step

R36 authorization was granted and used. The B1/S comparison has run, but it is
exploratory. The next step is to remove its confounds:

1. Resolve A1's task/gold ambiguity: the hidden checker requires `retries: 2`
   on the string form; the task text does not state it. Either clarify the task
   or relax the checker. Do not count A1 damage as memory.
2. Fix the D1 verification artifact process: the agent never writes
   `verification.json`.
3. Replicate B2 damage and C1 rescue; both are currently n=2.
4. Replicate W0/W1 and the causal pairs beyond two runs; 0.917 and the
   1/3/4/4 split are not stable estimates.
5. Implement H-native or keep it explicitly blocked.

Do not pool R35 r1/r2/r3 with the R36 runs. Report rescue/damage/both/neither
and provider/budget/invalid/incomplete pairs if the causal comparison is rerun.

## Caveats

- R35 did not record a per-run git SHA or writer finish reason. The audit uses
  `null`, not an inferred commit.
- F1's initial raw output is lost; the call and its cost remain counted.
- R35 r2 continuation is invalid and remains so.
- The 0/0 R35 pair result is not equivalence.
- Guard-assisted success is not unguided compliance.
- H-native is not implemented; no native-runtime result exists.
- The direct `/zen/go/v1` keys were expired; the R36 live runs used the local
  ZCode proxy. The route is recorded, the key is not.
- The O2 calibration includes 16 transport-failed attempts and 9 unknown-usage
  attempts; those are counted in cost, and the affected rows are invalid, not
  task failures.
- A1 passed under H-step and failed under H-combined; one replicate per cell is
  not a stable harness estimate.
- No currency is reported.
