# R38-M0 — Handoff

## 1. State

```text
Repository            orangeofcarl0-sys/dsh-epistemic-fold
R38 base              7a2c974c479bc1286f172e9f7b203af92e22e629 (R37-D HEAD)
R38 branch            rc38-mechanism-validation
R38 worktree          F:/Codex_Work_Space/DSH plugin/ef-r38-mechanism
Final HEAD            this handoff commit
Push                  not performed
```

The R37-B/C/D worktrees were not modified. The R37-B archive still matches:

```text
de6102989457fba6e5f4c43406478ce91b360f247f2dd462759f252f69de1c92
3,763,962 bytes
```

Commit map:

```text
5e464ef  fix(semantic): enforce authorized retirement and revision integrity
f7b2b7d  feat(eval): add a read-only cross-coordinate integrity auditor
863fc31  feat(eval): add a task-aware working-set shadow selector
8ce3336  feat(eval): add bounded archive recovery and its ablation
e6d0a87  feat(eval): add recent-tail consistency assessment
820abfb  test(eval): certify native context delivery through runtime-context
this     docs(eval): publish the R38-M0 baseline, mechanism evaluation and gates
```

## 2. What was executed

```text
WP0  repository audit, isolated worktree, baseline manifest
WP1  relation authorization, revision identity, minimal safety fix
WP2  read-only cross-coordinate integrity auditor
WP3  task-aware working-set shadow selector and ablation
WP4  bounded archive recovery and three-arm ablation
WP5  recent-tail consistency assessment
WP6  native context delivery through runtime-context
WP7  mechanism evaluation, gates G0-G7, decision and M1 preregistration
```

No live model call was made.

## 3. Headline results

### 3.1 Relation authorization

Pre-fix reproduction (R37-D tree): a tool-grounded finding named a user
constraint anchor and the planner emitted a retire op; the constraint left hot
state with `retiredCount: 1`. The same followed an assistant decision.

Post-fix:

```text
tool finding vs user constraint       refused (insufficient-authority)
assistant decision vs user constraint refused (insufficient-authority)
cross-scope anchor id                 refused (cross-scope)
unknown target                        delta withheld
ambiguous bare subject                delta withheld
user revision                         applies
same-scope decision revision          applies
```

`eval/r38/out/relation-security-audit.json` — 8/8.

### 3.2 Revision identity

```text
same claim, different targets   same deltaId (unchanged)
repeat with a new plan          accepted as duplicateClaim; 1 declare, 2 retires
exact repeat                    refused duplicate
replay once                     matches the candidate state
second application              detected by the commit-state digest
replay at a cut                 matches the fork state
retry                           deterministic
```

`eval/r38/out/revision-idempotency.json` — 7/7.

### 3.3 Integrity auditor

`eval/r38/out/integrity-audit.json` — 9/9.

N5 is permanent: the incomplete revision produces
`stale-negative-knowledge` (requires-review); the complete revision clears it.
A simulated pre-fix unauthorized retirement is `blocking`. Cross-scope
opposition is informational; same-scope opposition is requires-review; shared
keywords alone produce nothing.

### 3.4 Task-aware selection

`eval/r38/out/working-set-ablation.json` — 5/5.

```text
n5-budget-pressure   S0 critical 0/1, S1 1/1
scope-separation     S0 precision 0.667, S1 1.0; tokens 122 -> 76
greedy-skip          S0 drops C, S1 keeps C
pinned-overflow      reported, never dropped
```

### 3.5 Archive recovery

`eval/r38/out/archive-recovery-ablation.json` — 8/8.

H1-v2 and S1-v1 facts recovered from archive only. A genuine miss is
`not-found-in-checked-scope`; a descriptor-bound miss is
`coverage-not-assessed`. No cross-scope passage, no state write, no gold term
in the query.

### 3.6 Recent tail

`eval/r38/out/recent-tail-consistency.json` — 9/9.

An explicit user revision is `superseded-by-user`; a task-relevant message
without a shared claim is `requires-reconciliation`; a tool observation cannot
revoke a constraint; an assistant message cannot override one; a different
scope is not a conflict; a stale frame is reported.

### 3.7 Native delivery

`eval/r38/out/native-context-smoke.json` — 6/6.

The overlay is a `runtime-context` user message, not a system-prompt section.
Identical steps produce one snapshot; a task change produces a second; a real
JSONL resume delivers the same digest; the system prefix is byte-identical.
The journal and checkpoint are not modified.

### 3.8 Mechanism evaluation

`eval/r38/out/mechanism-evaluation.json` — 11/11 certified, 0 blocked.

```text
semantic-integrity        5
context-selection         4
recent-tail               1
operational-continuity    1
safety blockers           1 (0 observed)
```

## 4. Gates

```text
R38-G0  passed   repository and baseline integrity
R38-G1  passed   relation authorization safety
R38-G2  passed   commit and supersession integrity
R38-G3  passed   integrity auditor validity
R38-G4  passed   task-aware selection validity
R38-G5  passed   archive recovery validity
R38-G6  passed   recent-tail and native delivery
R38-G7  passed   product and experiment decision
```

Strict exit: **0**. `eligible: true` means the R38-M0 stage is complete, not
that deployment is eligible.

```text
deploymentEligible: false
productDecision: deployment-hold
mechanismOutcome: safety-gate-passed; offline coverage improved; ready for a bounded live experiment
```

## 5. Product decision

```text
EF Active: deployment hold
```

R38-M0 found no product-level benefit and made no live model call. The safety
gate passed for the relation holes it targeted; task-aware selection and
bounded recovery improve coverage on fixtures; the native delivery path works.
None of that is a model-behavior result.

The next hypothesis is S1/S2 vs the current Active on held-out cases, under a
bounded R38-M1 manifest. A more complex memory architecture is not justified.

## 6. Tests

```text
Typecheck                  pass (src, client, eval)
R38 tests                  63/63 pass
Full suite                 see §7
```

R38 test files:

```text
tests/r38-relation-authority.spec.ts   19
tests/r38-integrity-auditor.spec.ts     8
tests/r38-task-aware.spec.ts            9
tests/r38-archive-recovery.spec.ts      8
tests/r38-recent-tail.spec.ts          10
tests/r38-native-context.spec.ts        9
```

`npm run eval:build` is required before the R36/R33 live-subprocess tests. The
build output is gitignored.

## 7. Full suite

```text
total     1800
passed    1718
failed      12
skipped     70
```

The twelve failures are the pre-existing vendor/DSH-drift set recorded by
R36/R37-B/R37-C. The baseline run had eleven; `rc7-inplace-drift.spec.ts`
flipped on this run. Both runs are in the same pre-existing group. No R38 test
fails.

R38 test evidence: `eval/r38/out/r38-tests.json` — 63/63 passed, 0 failed.

## 8. Provider usage

```text
live model calls   0
HTTP attempts      0
input tokens       0
output tokens      0
```

R38-M0 is offline by construction.

## 9. Artifacts

```text
eval/r38/
  baseline.mjs
  relation-security.mjs
  revision-idempotency.mjs
  integrity-audit.mjs
  working-set-ablation.mjs
  archive-recovery-ablation.mjs
  recent-tail.mjs
  native-context-smoke.mjs
  mechanism-evaluation.mjs
  gates.mjs
  src/integrity-auditor.ts
  src/task-aware-selector.ts
  src/archive-recovery.ts
  src/recent-tail.ts
  src/context-overlay.ts
  out/baseline-manifest.json
  out/baseline-tests.json
  out/relation-security-audit.json
  out/revision-idempotency.json
  out/integrity-audit.json
  out/working-set-ablation.json
  out/archive-recovery-ablation.json
  out/recent-tail-consistency.json
  out/native-context-smoke.json
  out/mechanism-evaluation.json
  out/gate-status.json

docs/semantic-continuity/
  R38_BASELINE.md
  R38_RELATION_AUTHORITY.md
  R38_COMMIT_INTEGRITY.md
  R38_SEMANTIC_INTEGRITY.md
  R38_TASK_AWARE_SELECTION.md
  R38_ARCHIVE_RECOVERY.md
  R38_RECENT_TAIL_CONSISTENCY.md
  R38_NATIVE_CONTEXT_DELIVERY.md
  R38_MECHANISM_EVALUATION.md
  R38_DECISION.md
  R38_HANDOFF.md
  R38_M1_PREREGISTRATION.md
```

## 10. Unresolved issues

- The `decision` authority domain does not distinguish a user decision from an
  assistant decision. A user decision can be retired by an assistant decision
  at the same rank. This is documented, not fixed.
- The selector, recovery and overlay are eval code. Production wiring needs a
  Task Frame source, a per-agent context registration and a rebuild policy.
- The relation rank and the text rules are English-centric. CJK polarity pairs
  are not implemented.
- The archive recovery fixtures use synthetic bundles written through the real
  store; an engine-level recovery test is still missing.
- The native smoke uses a scripted adapter and fixture state. It proves the
  delivery path, not model behavior.
- The R38-M1 experiment is specified but not authorized.

## 11. Next executable commands

```bash
npm run eval:r38-baseline
npm run eval:r38-relations
npm run eval:r38-idempotency
npm run eval:r38-integrity
npm run eval:r38-working-set
npm run eval:r38-recovery
npm run eval:r38-tail
npm run eval:r38-native
npm run eval:r38-mechanism
npm run eval:r38-tests
npm run eval:r38-gates
```

Do not run a live R38-M1 batch without a new frozen manifest and a new explicit
authorization. The R37-D authorization covers only the executed 24-cell process
pilot.
