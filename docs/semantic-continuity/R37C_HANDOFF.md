# R37-C — Handoff

## 1. State

```text
Repository            orangeofcarl0-sys/dsh-epistemic-fold
Base commit           5ef67814a4ec8fd8bcca362b89ad338acd0a8ae0 (R37-B HEAD)
R37-C branch          rc37c-measurement-closure
R37-C worktree        F:/Codex_Work_Space/DSH plugin/ef-r37c-closure
Final HEAD            this handoff commit
Push                  not performed
```

Commit map:

```text
5ef6781  R37-B HEAD
fc777ef  test(eval): preserve R37-B evidence and establish the R37-C baseline
1ce0969  fix(eval): separate accepted, committed and rendered semantic metrics
0820984  fix(eval): separate measurement validity from pipeline outcomes
482c935  fix(eval): enforce preregistered gates and audit the R37-B statistics
1edb578  fix(eval): harden DSML decoding and protocol admission diagnostics
c2f1174  test(eval): certify the native agent/tool lifecycle
77a2439  feat(eval): preregister and run the bounded process-causal pilot
this     docs(eval): publish the R37-C decision and handoff
```

Diff from `5ef6781` to this handoff commit:

```text
64 files changed, 98,262 insertions(+), 9 deletions(-)
```

Most insertions are evidence JSON (`evidence-inventory.json`,
`protocol-admission.json`, audit rows), not source code.

## 2. What was executed

```text
C0-A  raw R37-B archive inventory, integrity, secret scan, compressed archive
C0-B  accepted/committed/rendered funnel recomputation from traces + journals
C0-C  measurement vs pipeline classification of all 218 Stage 2 reports
C0-D  case-level statistics, leave-one-case-out, strict gate exit
C1-A  DSML byte-fidelity codec and strict parser
C1-B  903-turn no-valid-action attribution
C1-C  native N0/N1/N2 smoke with real AgentLoop/AgentRegistry/ToolRuntime
C2    24-cell bounded finish-guard pilot, real provider, within caps
C3    second-model preregistration, H1-v2 certification, held-out plan
```

No R37-B artifact was rewritten. The R37-B worktree remained clean and was not
used for R37-C commits.

## 3. Headline results

### 3.1 Metric correction

```text
W1 accepted-fact recall   0.722
W1 committed-fact recall  0.514
accepted-but-not-committed rows  14
strictCriticalRecall      true exact zero on parsed rows; 18 nulls separated
```

### 3.2 Measurement correction

```text
R37-B "11 invalid measurements"
  = 2 provider/transport-invalid
  + 9 fold refusals (valid pipeline outcomes)
```

### 3.3 Statistics

```text
contract 1 rescue / 9 damage, p = 0.0215
5/6 cases negative, 1 flat
case-level sign test p = 0.0625
leave-one-case-out p range 0.0078–0.0703
```

The direction survives the audit; the precision claim does not.

### 3.4 Protocol

```text
Stage 2 model calls        903 (not 819 completed steps)
stored no-valid turns      216
no-valid rate              23.92%
Stage 1 admission          gate-not-verifiable
```

### 3.5 Native

```text
N0 passed, N1 passed, N2 passed
TOOL_NOT_STARTED cause: AgentLoop constructed with a plain number instead of createVolatile(1)
```

### 3.6 C2 pilot

```text
24/24 cells, complete
B1/G0 5/6 contract, B1/G1 4/6
S/G0  6/6 contract, S/G1  4/6
guard under B1  -16.7 pp contract
guard under S   -33.3 pp contract
guard-assisted completions: 1 B1, 0 S
```

The guard is not beneficial in this pilot. The pilot is exploratory.

## 4. Gates

```text
R37C-C0A  passed
R37C-C0B  passed
R37C-C0C  passed
R37C-C0D  passed
R37C-C1A  passed
R37C-C1B  passed
R37C-C1C  passed
R37C-C1D  gate-not-verifiable (historical Stage 1 admission)
R37C-C2   passed (executed, not a benefit result)
R37C-C3   passed
```

Strict gate exit: **2** — no gate failed, but the historical Stage 1 admission
is not verifiable. `stageEligible: false` is the correct automated reading.

Authoritative gate file:

```text
eval/r37c/out/gate-status-r37c.json
```

## 5. Product decision

```text
EF Active: deployment hold
```

The hold is unchanged. R37-C corrected the metrics, found no Active benefit,
and found that the finish guard does not fix the process harm in this pilot.
It did not reverse the R37-B direction.

## 6. Raw evidence

```text
Archive   F:/Codex_Work_Space/DSH plugin/ef-r37c-evidence-archive/r37b-raw-evidence-20261106.tar.gz
SHA-256   de6102989457fba6e5f4c43406478ce91b360f247f2dd462759f252f69de1c92
Bytes     3,763,962
Secrets   0 findings
```

The archive is outside the git worktree. It preserves the 1,000-character
trace cap; it does not reconstruct a full response.

## 7. Provider usage

C2 pilot, observed:

```text
HTTP attempts     187 / 240
input tokens      226,808 / 300,000
output tokens      29,980 / 70,000
wall clock        504,096 ms / 3,600,000 ms
```

Per-cell ledger admission uses the adapter's 131,072-token context reserve;
the global caps above are enforced on observed usage. No credentials were
written to any manifest, report, log, or commit.

## 8. Tests

```text
Typecheck                  pass (src, client, eval)
R37-C tests                55/55 pass
R37 tests                  49/49 pass
R36 tests                  34/34 pass
R33 targeted               94/94 pass
Full suite                 1580 passed, 12 failed, 70 skipped
```

The 12 failures are the same pre-existing vendor/DSH-drift set recorded by
R36/R37-B: four need the absent `vendor/deepseek-harness`, eight are
installed-vs-vendored DSH differences. No R37-C test fails.

## 9. Artifacts

```text
eval/r37c/out/
  baseline.json
  evidence-inventory.json
  evidence-integrity.json
  evidence-archive.json
  semantic-funnel-audit.json
  measurement-vs-pipeline.json
  statistics-audit.json
  protocol-admission.json
  native-smoke.json
  h1-v2-validity.json
  r37c-c2-results.json
  r37c-c2-analysis.json
  r37c-tests.json
  gate-status-r37c.json

docs/semantic-continuity/
  R37C_BASELINE.md
  R37C_EVIDENCE_ARCHIVE.md
  R37C_METRIC_CORRECTION.md
  R37C_R37B_AUDIT.md
  R37C_PROTOCOL_INTEGRITY.md
  R37C_NATIVE_SMOKE.md
  R37C_PROCESS_PILOT.md
  R37C_NEXT_PREREGISTRATION.md
  R37C_DECISION.md
  R37C_HANDOFF.md
```

Local, gitignored:

```text
eval/r37c/runs-c2/          C2 raw reports/traces/workspaces
eval/r37c/manifests-c2/     C2 frozen manifests
eval/r37c/runs-c2-smoke/    one-cell orchestration smoke
eval/r37c/manifests-c2-smoke/
eval/r37c/out/*progress*.json
```

## 10. Unresolved issues

- The Stage 1 admission cannot be verified retroactively; the trace cap and
  the wrong metric both prevent it.
- The 1,000-character turn cap remains in the historical archive.
- The C2 guard pilot is small and has delivery confounds in S/G1 (one empty
  commit, one full-history fallback). Do not deploy the guard.
- The second model and new held-out cases are preregistered, not executed.
- H-native is a minimal smoke, not the production evaluation runtime.
- The full suite still has 12 pre-existing vendor/DSH-drift failures.

## 11. Next executable commands

```bash
npm run eval:r37c
npm run eval:r37c-c2-analyze
npm run eval:r37c-tests
node eval/r37c/gates.mjs

# R37-D preregistration only; no live call until a new frozen batch is approved
cat docs/semantic-continuity/R37C_NEXT_PREREGISTRATION.md
```

Do not run `eval:r37c-c2` again without a new frozen manifest and a new
authorization check. It is a live provider command.
