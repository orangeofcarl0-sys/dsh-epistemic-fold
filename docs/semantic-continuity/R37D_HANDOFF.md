# R37-D — Handoff

## 1. State

```text
Repository            orangeofcarl0-sys/dsh-epistemic-fold
R37-D base            045cccf275132ffda8c76a9fbdc8620338af6164 (R37-C HEAD)
R37-D branch          rc37d-operational-completion
R37-D worktree        F:/Codex_Work_Space/DSH plugin/ef-r37d-operational
Final HEAD            this handoff commit
Push                  not performed
```

The R37-B and R37-C worktrees were not modified. The R37-B archive still
matches:

```text
de6102989457fba6e5f4c43406478ce91b360f247f2dd462759f252f69de1c92
3,763,962 bytes
```

Commit map:

```text
0fa7870  test(eval): establish R37-D baseline and preserve R37-C evidence
7766068  feat(eval): add operational completion metrics without rewriting legacy scores
cb6fe19  fix(eval): keep the R37-D baseline artifact compact
48aa308  feat(eval): classify no-valid-action calls and budget exhaustion
c5b363e  feat(eval): freeze B2 and D1 process-intervention fixtures
e6dc9bd  test(eval): extend native tool lifecycle and recovery
cd51dd2  feat(eval): preregister the bounded process-prompt pilot
48eefd3  feat(eval): certify the authority-scope case and freeze the held-out plan
this     docs(eval): publish the R37-D decision and handoff
```

Diff from `045cccf` to this handoff commit:

```text
68 files changed, 34,114 insertions(+), 17 deletions(-)
```

Most insertions are audit JSON and the new case fixtures.

## 2. What was executed

```text
WP0  R37-C git/evidence audit, independent C2 recomputation, archive hash
WP1  layered operational completion, digest views, legacy comparison
WP2  per-call action accounting, no-valid classes, B2/D1 forensics
WP3  fixed B2/D1 contexts, outcome-blind G0/r1 selection, four fixtures
WP4  24-cell process-prompt manifest, preflight, ready-for-authorization
WP5  native N3 multiple tools, N4 interruption recovery, N5 repeated folds
WP6  H1-v2 leakage audit, S1-v1 certification, held-out plan
```

No provider request was made in R37-D. The native smoke uses a scripted
adapter. The process batch was not executed.

## 3. Headline results

### 3.1 Completion semantics

```text
C2 legacy contract            19/24
C2 operational completion     16/24
legacy pass / operational fail 3
```

The three are stale verification. Seven of the eight D1 cells with a failing
test and an honest `not-verified` claim are operational completions; the eighth
is the third stale-verification cell above.

R37-B Stage 2, descriptive:

```text
legacy 83/146; operational 74/146
B1 26 -> 25; S 18 -> 17
```

The Active direction and the eight-cell difference are unchanged.

### 3.2 Protocol

```text
model calls 163; no-valid 46 (28.22%)
B2 40.70% no-valid; D1 14.29%
invalid-envelope 30; missing-parameter 13; truncated-output 6; natural-language 2
```

B2's three contract failures never tested and never wrote code. D1's two
missing artifacts are one rejected write and one never-requested write.

### 3.3 Guard

All five contract failures never requested finish. The guard had no opportunity
in any failing cell. It is not the next intervention.

### 3.4 Native

```text
N3 passed: 5 calls, 5 results, write before test, duplicate read, thrown error
N4 passed: TOOL_NOT_STARTED and TOOL_OUTCOME_UNKNOWN
N5 passed: two folds, stale anchors retired, one active anchor, native call
```

### 3.5 Benchmark

```text
H1-v2 audit passed; us-west-2 passes visible and fails hidden
S1-v1 certified; staging 5 and alternative 10 pass visible and fail hidden
held-out plan: 2 certified, 4 specified
```

### 3.6 Process pilot

```text
24 cells frozen; guard off; 8 steps; 1,024 output tokens
P0 empty; P1 one generic process sentence
status ready-for-authorization; 0 provider calls
```

## 4. Gates

```text
R37D-D0  passed                  repository and evidence integrity
R37D-D1  passed                  operational metric validity
R37D-D2  passed                  protocol and action attribution
R37D-D3  passed                  fixed-context certification
R37D-D4  passed                  native runtime extension
R37D-D5  ready-for-authorization process pilot readiness
R37D-D6  not-executed            process pilot executed
R37D-D7  passed                  product decision
```

Strict exit: **2** — no failure, two non-pass states. `eligible: false`.

```text
eval/r37d/out/gate-status-r37d.json
```

## 5. Product decision

```text
EF Active: deployment hold
```

R37-D did not find an end-to-end Active benefit, did not reverse the R37-B harm
direction, and did not execute the process batch. A fixed-context process result
would be a mechanism result, not a product result.

## 6. Tests

```text
Typecheck                  pass (src, client, eval)
R37-D tests                62/62 pass
R37 tests                  49/49 pass
R36 tests                  34/34 pass
R33 targeted               94/94 pass
Full suite                 1645 passed, 12 failed, 70 skipped
```

The 12 failures are the same pre-existing vendor/DSH-drift set recorded by
R36/R37-B/R37-C. No R37-D test fails.

`npm run eval:build` is required before the R36/R33 live-subprocess tests. The
build output is gitignored.

## 7. Provider usage

```text
HTTP attempts     0
input tokens      0
output tokens     0
wall clock        0
```

The C2 raw evidence was read from the R37-C worktree. No credential was read or
written.

## 8. Artifacts

```text
eval/r37d/out/
  baseline.json
  r37c-audit.json
  operational-completion.json
  action-accounting.json
  protocol-efficiency.json
  b2-d1-action-forensics.json
  fixed-context-manifest.json
  native-extended.json
  process-pilot-manifest.json
  process-pilot-preflight.json
  h1-v2-audit.json
  s1-v1-validity.json
  held-out-plan.json
  r37d-tests.json
  gate-status-r37d.json

eval/r37d/fixtures/
  B2-B1/  B2-S/  D1-v2-B1/  D1-v2-S/

eval/r37d/cases/S1-v1/

docs/semantic-continuity/
  R37D_BASELINE.md
  R37D_R37C_AUDIT.md
  R37D_OPERATIONAL_COMPLETION.md
  R37D_PROTOCOL_EFFICIENCY.md
  R37D_ACTION_BUDGET_FORENSICS.md
  R37D_FIXED_CONTEXT.md
  R37D_NATIVE_RUNTIME.md
  R37D_PROCESS_PILOT.md
  R37D_BENCHMARK_PREREGISTRATION.md
  R37D_DECISION.md
  R37D_HANDOFF.md
```

Local, gitignored:

```text
eval/live/dist/              eval build output
node_modules/
```

## 9. Unresolved issues

- The process batch has no live adapter wiring. The frozen inputs are complete;
  the execution path is not.
- The batch has no authorization. The R37-C authorization does not cover it.
- The C2 pilot is exploratory: three replicates, one model, two cases.
- The 1,000-character trace cap limits per-turn attribution. Totals come from
  harness counters.
- The four specified held-out cases are design briefs, not cases.
- The native N3/N4/N5 proof uses a manual host and a scripted adapter, not the
  production harness.
- The full suite still has 12 pre-existing vendor/DSH-drift failures.

## 10. Next executable commands

```bash
npm run eval:r37d-baseline
npm run eval:r37d-operational
npm run eval:r37d-protocol
npm run eval:r37d-fixtures
npm run eval:r37d-native
npm run eval:r37d-pilot
npm run eval:r37d-h1
npm run eval:r37d-s1
npm run eval:r37d-plan
npm run eval:r37d-tests
node eval/r37d/gates.mjs

# Refuses without a new authorization; makes no provider call
node eval/r37d/process-pilot.mjs --run
```

Do not run the process batch without a new frozen manifest and a new explicit
authorization naming its digest, cell count, model, route, and budget.
