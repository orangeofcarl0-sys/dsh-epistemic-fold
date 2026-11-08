# EF-C1 — Handoff

## 1. State

```text
Repository            orangeofcarl0-sys/dsh-epistemic-fold
Base                  C0 HEAD 327598f342dfca4fab2a779442af56a9ab510ece
Branch                chore/ef-c1-evaluation-foundation
Worktree              F:/Codex_Work_Space/DSH plugin/ef-c1-foundation
Final HEAD            the evidence commit that closes this round
Push                  not performed
Merge / rebase        not performed
Tag                   not created
Branch deleted        none
```

The C0 worktree and every historical worktree were left at their commits. The
R38 and C0 worktrees were used for identity reconstruction and restored
afterwards; no historical evidence was left changed.

## 2. Commit map

```text
1  fix(eval): isolate historical report generation from test and install runs
2  test(eval): certify evidence isolation, DSH compatibility and the core baseline
3  docs(eval): publish the C1 isolation, compatibility and baseline decisions
4  chore(eval): record the C1 evidence outputs and this handoff
```

The final report states the four SHAs. Commit 4 changes no source and no
frozen evidence; it records the generated outputs.

## 3. What was executed

```text
WP0  baseline verification, isolated worktree, protected registry, side-effect inventory
WP1  verify/generate/promote separation; R1, R33, preset, map and manifest fixes
WP2  test identity accounting across R38 and C0
C1A  hard gate A0-A5
WP3  DSH compatibility matrix and failure classification
WP4  Basic compatibility certification (B0 / Bv)
WP5  EF Core offline baseline (B0 / Bv / E0 / E1)
WP6  live preregistration and readiness (not-authorized)
WP7  Track B semantic handoff
     gates C1-G0..G7, C1A A0-A5, full suite, local commits, this handoff
```

No live model call was made. No provider was contacted.

## 4. Headline findings

### 4.1 Four commands wrote historical files; all four now write none

Measured before (`observation-pre-*.json`) and after (`observation-post-*.json`):

| Trigger | Before | After |
|---|---|---|
| `npm ci` | `cordis.patch.yml` | none |
| `tests/r33-live-entry.spec.ts` | `live-report.json`, `live-check.json` | none |
| `tests/r33-arms.spec.ts` | `offline-report.json`, `.md` | none |
| `tests/r1-report.spec.ts` | `docs/12_R1_EVALUATION_REPORT.md`, `docs/MANIFEST.json` | none |

### 4.2 The 33-vs-24 arithmetic is an undeclared dependency

C0 added 33 tests but the suite grew by 24. The missing 9 are all
`tests/r38-native-context.spec.ts`, which imports a script that imports
`@deepseek-ai/dsh-agent-loop`. The package was in the R38 worktree's
`node_modules` but absent from `package.json`/`package-lock.json`, so a clean
install could not collect the file. EF-C1 declares it at `0.2.1-rc.3`; the 9
tests collect and pass. Arithmetic:

```text
R38 1800 + 33 new = 1833
C0  1824 +  9 restored = 1833
```

### 4.3 Three DSH identities, and the vendor is not the documented one

```text
declared      0.2.0-rc.2   package.json peer ranges
installed     0.2.1-rc.3   package-lock.json
vendored      0.1.7-rc.2   vendor/deepseek-harness/package.json (this machine)
CI pinned     0.2.0-rc.2   at 639ed01, not reproducible here
```

The README says the vendored checkout is `0.2.0-rc.2`. It is not. No local lane
has all three identities equal.

### 4.4 The 12 failures are five different things

```text
environment mismatch (no vendor tree)         4
host API hardening / fixture incompatibility  2
known upstream drift                          4
stale generated configuration                 1
unknown / real-defect suspect                 1   eval-corpus B04-failure-resolution
```

The unknown is the only one that could be a product defect. It is not dismissed
as vendor drift.

### 4.5 Basic is compatible on the contract; E0/E1 are isolated variables

- B0 and Bv produce the same checkpoint body (347 chars), same prefix
  fingerprint, same retained tokens, no EF bundle.
- E0 makes 0 auxiliary calls; E1 makes exactly 1 rationale call; the fold span
  and retention are identical.
- Both Basic arms contain a summary failure (no replacement), an abort (no
  replacement), a legal tool-pair span, and a readable checkpoint after restart.

### 4.6 Zero product-level evidence; deployment hold stands

C1 is offline. The mechanism results are real; they are not product results.
`coreReleaseEligible` and `semanticActiveEligible` are both false, for different
reasons.

## 5. C1A hard gate

```text
A0  passed  baseline verified
A1  passed  protected artifacts identified (287 paths)
A2  passed  ordinary tests do not overwrite historical evidence (4/4 observations at 0 drift)
A3  passed  report generation is explicit (verify/generate/promote for every generator)
A4  passed  test identity accounting consistent (net 24 = 33 - 9; dependency declared)
A5  passed  no new Core regressions (same 12 failures as R38; 0 status changes)
```

`eval/c1/out/c1a-gate.json`, `eligible: true`.

## 6. Gates

```text
C1-G0  passed  Git / baseline integrity
C1-G1  passed  Evidence isolation
C1-G2  passed  Test identity accounting
C1-G3  passed  DSH compatibility
C1-G4  passed  Basic compatibility
C1-G5  passed  EF minimal / rationale calibration
C1-G6  passed  Live readiness (not-authorized, 0 provider calls)
C1-G7  passed  Product / research separation
```

Strict exit: **0**. `stageComplete: true`, `coreReleaseEligible: false`,
`semanticActiveEligible: false`.

## 7. Tests

```text
typecheck (src, client, eval)     pass
build                             pass (79 modules)
eval:build                        pass (3 modules)
C1 targeted                       37/37 pass
full suite                        1860 total, 1778 passed, 12 failed, 70 skipped
```

The 12 failures are the known set in §4.4. No C1 test fails.
`eval/c1/out/c1-tests.json`, `eval/c1/out/full-tests-summary.json`.

## 8. Protected artifact audit

```text
protected paths          287 (12 explicit + 275 evidence artifacts)
frozen drift             0
generated-config drift   1 (docs/MANIFEST.json, regenerated after the snapshot)
unclassified writes      0 of 169 write sites
```

The five minimum paths are registered and unchanged:
`docs/12_R1_EVALUATION_REPORT.md`, `docs/MANIFEST.json`, `cordis.patch.yml`,
`eval/r33/out/live-report.json`, `eval/r33/out/offline-report.json`.

## 9. Test identity reconciliation

```text
R38 1800 -> C0 1824 (net +24)
added    33  (four convergence files)
missing   9  (r38-native-context, undeclared dependency)
changed   0
check    net == added - missing: true
```

The full identity lists are `eval/c1/out/raw/test-identity-{r38,c0}.json`
(gitignored, ~600 KB each), pinned by SHA-256 in
`eval/c1/out/test-accounting.json`.

## 10. DSH compatibility matrix

See `C1_DSH_COMPATIBILITY.md`. The API surface of the installed `0.2.1-rc.3` is
available for compaction, session, tools, llm, projection and system prompt;
the agent API is `AgentRegistry` (the 0.1.x `Agent` class is gone); Basic's
`frameCheckpoint` is absent by design and supplied by `src/basic`.

## 11. Basic compatibility results

See `C1_CORE_BASELINE.md` §4. Five contract cases, both arms: leaf fold,
tool-pair boundary, summary failure (contained), abort (no replacement),
restart (byte-identical checkpoint). Byte parity holds on this fixture; the
source-level identity test requires the vendor tree and is `not-verifiable`
here.

## 12. E0 / E1 offline baseline

See `C1_CORE_BASELINE.md` §2-§3:

```text
E0  calls 0   checkpoint 47 chars   archive 2   zero-LLM
E1  calls 1   checkpoint 67 chars   archive 2   rationale only
same legal span 1-10, same surface nodes, same fold policy
```

No cost claim. Cache read/write was not measured.

## 13. Known blockers

1. `eval-corpus > B04-failure-resolution` fails under `0.2.1-rc.3`; real-defect
   suspect.
2. The local vendor tree is `0.1.7-rc.2` while the code declares `>=0.2.0-rc.2`.
3. The CI pinned lane was not reproducible locally.
4. The R1 report and the R33 offline report are stale; promotion is a separate
   decision.
5. Semantic decision authority is unsplit (Track B).
6. No live experiment is authorized.

## 14. Live experiment readiness

`not-authorized`, 0 provider calls, 5 blocking conditions:
no frozen manifest, no authorization SHA, no route, no limits, no preflight.
`C1_LIVE_PREREGISTRATION.md` defines 18 cells (6 tasks × 3 arms) and a budget
derived from the R37-D actuals and the R1 per-step cost.

## 15. Track B continuation plan

Branch from this round's final commit. The risk is
`src/semantic/retirement.ts` (`decision` power 4) and `src/semantic/ops.ts`
(one `decision` domain): an assistant decision has the same standing as a user
decision. Promotion requires a mechanism certification, an offline ablation, a
live experiment, and a deployment decision. It does not affect C1's B0/E0/E1,
which run with `semanticContinuity: off`.

## 16. Push status

Not pushed. No PR, no merge, no rebase, no tag, no branch deletion.

## 17. Artifacts

```text
docs/convergence/
  C1_EVIDENCE_ISOLATION.md
  C1_DSH_COMPATIBILITY.md
  C1_CORE_BASELINE.md
  C1_LIVE_PREREGISTRATION.md
  C1_DECISION.md
  C1_HANDOFF.md
  data/report-baselines.json

eval/c1/
  protected-artifacts.mjs
  side-effects.mjs
  observe.mjs
  dsh-compatibility.mjs
  test-accounting.mjs
  live-readiness.mjs
  gates.mjs
  c1a-gate.mjs
  out/
    protected-artifacts.json
    side-effect-inventory.json
    observation-pre-*.json / observation-post-*.json
    dsh-compatibility.json
    test-accounting.json
    live-readiness.json
    core-baseline.json
    basic-compatibility.json
    c1-tests.json
    full-tests-summary.json
    gate-status.json
    c1a-gate.json

eval/r1-report/report.ts
scripts/generate-docs-manifest.mjs
scripts/run-with-env.mjs
tests/c1-evidence-isolation.spec.ts
tests/c1-core-baseline.spec.ts
tests/c1-basic-compatibility.spec.ts
tests/c1-gates.spec.ts
tests/c1-eval.d.ts
```

## 18. Next executable commands

```bash
npm run eval:c1-evidence
npm run eval:c1-compat
npm run eval:c1-readiness
npm run eval:c1-tests
npm run eval:c1-gates
npm run eval:c1a-gate
# or the chain
npm run eval:c1
```

Do not push, merge, rebase, tag or delete a branch without a separate
authorization. Do not run a live experiment without a frozen manifest and an
authorization naming its SHA.
