# R33 — Handoff and Final Report

**Branch:** `rc33-semantic-behavior` (worktree `ef-r33-behavior`)
**Baseline:** R32 `bef473dc77f18a07980031cf110b253fe0288cb1`
**Status:** offline instrument, arms, and documentation complete. **Live model
evaluation blocked / not executed.** No provider request was made.

---

## 1. Git baseline and commit stack

R33 starts at the R32 commit and adds six commits on `rc33-semantic-behavior`:

```
910ead3 feat(eval): gate the live run on one global budget
8d1eee4 feat(eval): add baseline, oracle and fault arms with behavioural grading
9c62a8e feat(eval): freeze the R33 semantic-continuity cases and gold
e69fcba docs(semantic): correct the journal recovery runbook
617f1f2 fix(semantic): bind missing-receipt recovery to the rendered state
56182eb fix(semantic): expose writer protocol and coverage diagnostics
bef473d (R32 baseline) style(test): trim trailing blank lines
```

The primary R30 worktree, the R31 worktree, and `origin/main` were not touched.
No reset, clean, force push, or destructive Git operation was used. The R33
worktree has its own `node_modules`; `npm ci` regenerated `cordis.patch.yml`
against the local DSH install and that generated change was **reverted** — the
reviewed assembly file is unchanged.

## 2. R33-0 / R32.1 minimal safety fixes

| Fix | Commit | Test | Evidence |
|---|---|---|---|
| Writer call / protocol / deltas / integrity are four separate axes; `parsed` no longer means `ready`; `coverage` is always `not-assessed`; limit-exceeded is counted separately. | `56182eb` | `tests/r33-writer-observation.spec.ts` (11) | An absent block and malformed JSON report `partial`; an empty list is `ready`; 14 proposals report `accepted 12 / limitExceeded 2` without claiming coverage. |
| Handoff vs machine-state coverage is measured, not assumed. | `56182eb` | `tests/r33-coverage.spec.ts` (1) | With 3 gold constraints, 1 accepted, 1 omitted, 1 refused, the checkpoint contains 1 and the diagnostic says `parsed / not-assessed`; the test records the gap rather than hiding it. |
| Missing-receipt recovery is bound to the state its bundle rendered. | `617f1f2` | `tests/r33-receipt-window.spec.ts` (2) | An untampered crash still repairs; replaced legal `ops` produce an `ops-state-mismatch` conflict, no receipt, and a blocked next fold. |
| Recovery runbook no longer says “move the journal aside and continue”. | `e69fcba` | documentation | Recovery requires a preserved copy, an identified condition, and an explicit lost-state decision; clearing the journal to manufacture `valid-empty` is forbidden. |

The R32 recovery guarantees are preserved: a legitimate missing receipt is
still repaired; a receipt that does not bind is still not a missing receipt.

## 3. Evaluation tasks, types, gold and digest

* **17 frozen cases**, dataset `r33-semantic-continuity-v1`.
* **Manifest digest:** `2666e70f0cdba13bc3c756ff086b3566f51c0a9b595ecd9495859f73c0c21f26`.
* Risk classes: persistent-constraint 2, decision-override 2,
  negative-knowledge 2, validation-boundary 2, cross-phase-dependency 2,
  authority-scope 4, retrieval-trigger 1, history-independent 2.
* **5 counterfactual pairs** (A, B, C, E, F) with identical workspace and task,
  plus 7 diagnostic singles.
* Every case has a frozen transcript, verbatim gold quotes with source refs, a
  real initial workspace, an action tree, an independent hidden checker, and a
  digest. Gold was written before any arm ran.
* `tests/r33-dataset.spec.ts` asserts pair identity, gold provenance, no
  workspace leakage, and manifest stability.

## 4. Arms actually run

Offline, on the real engine and real Basic transaction:

* **B0** native Basic; **B1** EF off; **S** EF Active; **O1** oracle delta
  through the real validator/plan/journal; **O2** oracle visible facts; **OR**
  oracle evidence; **F** full history; **N** null; **FM** false-memory fault.
* 144 arm×case rows; 17×9 minus the 9 cases without a fault injection.
* 144/144 real folds; 0 `no-fold`; 0 `checker-invalid`.

Live: `S` and `O2` are implemented in `eval/r33/live.mjs` (real fold host, real
tool loop, budgeted). They were **not executed**.

## 5. Real model route and requests

**None.** Route: not resolved. Requests: **0**. Input/output tokens: **0**.
Retries: 0. The live gate exited 3 with `not-executed`. No key was read, logged,
or written.

## 6. Semantic extraction correctness and error types

Offline S (scripted writer; pipeline measurement):

* critical recall: **0.926** (weighted).
* grounded precision: **1.000**.
* current-state accuracy: **0.928**.
* direct visibility: **0.928**.
* Accepted deltas: 30 across the 15 applicable cases; 3 refusals total:
  1 `limit-exceeded` (F4), 2 `authority-ungrounded` (F1/F2).
* S's two case failures:
  * **H1** — writer proposed 0; the gold fact existed only in a tool record.
    O1 passes, so the earliest failure is writer/coverage.
  * **F4** — writer proposed 13; validator accepted 12. O2/F pass, so the
    earliest failure is the per-fold delta limit.

## 7. Unsupported and false normative claims

* F1/F2 propose a constraint grounded in a tool result; the validator refuses
  each as `authority-ungrounded`. The accepted normative deltas all match gold
  coordinates: `falseNormativeRate = 0.000` with a reported denominator.
* No accepted normative claim outside gold was observed in this set. That is a
  gold-relative result, not a general guarantee.
* The FM fault injects a false fact; the grader detects a violation in **8/8**
  injected cases.

## 8. Working set, recall and agent-action attribution

* **State delivery:** no bottleneck observed. S matches O1 on 15/17; the direct
  visibility of current gold facts is 0.928 (the missing ones are H1 and F4's
  rule 13).
* **Retrieval:** OR (same compressed state + evidence quotes) passes 17/17,
  including H1. Offline S cannot ask; the live runner records `recall` attempts
  and success. This is the open retrieval-trigger question.
* **Agent action:** O2 and F pass 17/17. The tasks and the finite actions are
  solvable; the agent is not the bottleneck in this set.
* **Authority:** F1/F2's B1 arm obeys tool-embedded text; S refuses it and
  follows the user. Full history passes only with the scripted authority guard;
  a real model's attribution is a live question.

## 9. Success, damage, rescue and no-difference

| Outcome | Count |
|---|---:|
| S task success | 15/17 |
| B1 / B0 task success | 7/17 / 7/17 |
| N task success | 3/17 |
| O1 task success | 16/17 |
| O2 / OR / F task success | 17/17 |
| S rescues vs B1 | 8 |
| S damage vs B1 | 0 |
| Both succeed | 7 |
| Neither | 2 (F4, H1) |
| FM detected | 8/8 |

The 8 rescues: C1, C2, D1, D2, E1, E2, F1, F2. The 7 shared successes: A1, A2,
B1, B2, F3, G1, G2. N's 3 successes: F1 (default action happens to be correct),
G1, G2.

## 10. Cost, tokens and cache

Offline: **0 provider requests, 0 tokens, $0**. Wall clock ~21.6 s for 144
rows; per successful task 143–821 ms depending on the arm (see
`R33_BASELINE.md`). No monetary figure is claimed.

The R32 30/100/300-commit journal harness, re-run with the R33 source:

```
commits  duration  proofCalls  scans  sourceReDerivations  journalBytes
30       95.8 ms   31          31     90                  59,778
100      301.6 ms  101         101    300                 199,848
300      993.8 ms  301         301    900                 601,647
```

The new state-digest check only runs when a bundle exists; this synthetic
journal harness has no bundles, so it measures the existing N-scan cost, not the
new replay. Real-fold costs are in the offline rows (2.4–2.8 s per 17-case arm,
including checkers). No index was added.

## 11. Comparison with EF Off / Basic / Oracle

* **S vs B1 / B0:** 15 vs 7, +0.471 (task-level bootstrap [0.235, 0.706],
  exploratory).
* **O1 vs S:** 16 vs 15, +0.059 [0.000, 0.176]; the only difference is H1
  (writer omission).
* **O2 / F vs O1:** 17 vs 16, +0.059 [0.000, 0.176]; the only difference is F4
  (delta limit).
* **S vs N:** 15 vs 3; the null control fails 12 memory-dependent cases.
* B0 and B1 are byte-identical in outcome on this set; EF off adds no behavioral
  change without semantic state.

## 12. Statistical and validity limits

* 17 cases, 5 pairs; not a random sample and not 12–24 pairs.
* The writer and agent are scripted; this is a pipeline result, not a model
  result.
* The bootstrap is task-level and exploratory; no non-inferiority claim.
* Synthetic micro-repositories; no large-codebase effects.
* Closed-world gold; unsupported means “outside this gold”, not “false”.
* F1/F2's authority guard is scripted; live attribution is unmeasured.
* H1's recall trigger is inferred from OR, not observed.
* `D2`'s earlier 0.862 current-state figure was a needle bug; the corrected
  figure is 0.928. The bug is fixed in the frozen case, not hidden.

## 13. Unfinished

| Item | Reason |
|---|---|
| Live S vs O2 pilot | No explicit budget permission / resolved route. |
| Natural-pressure folding | Controlled boundaries only. |
| 12–24 counterfactual pairs | First-stage instrument: 5 pairs. |
| Multi-fold / root / exit / fork behavioral run | Not in this round. |
| Real large-codebase continuations | Synthetic repos only. |
| Full production `context_recall` in the live loop | The live `recall` is a transcript search stand-in; R31/R32 cover the real tool. |
| F4 capacity fix | Evidence collected; deliberately not changed while measuring. |
| H1 coverage fallback | Evidence collected; deliberately not changed. |
| Unscoped task-identity collision, live | Support boundary from R32. |

## 14. Reproducible commands, patches and logs

```bash
npm ci
npm run build
npm run typecheck
npm run eval:r33-verify          # dataset digest
npm run eval:r33                 # 25 R33 tests (offline arms + R33-0)
npm run eval:r33-live-check      # interface only, no credentials
npm run eval:r33-self-test       # real fold/tool-loop plumbing, scripted adapter
EF_R32_PERF=1 npx vitest run tests/r32-perf.spec.ts
```

Live, once budget is approved:

```bash
R33_LIVE=1 EF_LIVE_BASE_URL=... EF_LIVE_API_KEY=... \
  node eval/r33/live.mjs --run --manifest live-manifest.json
```

Reports: `eval/r33/out/offline-report.{json,md}`, `self-test-report.json`,
`live-check.json`, `live-report.json` (`not-executed`). Review package:
`R33_REVIEW_PACKAGE/` (patches, log, status, test output, docs).

## 15. R34

**R34 should exist, minimally.** In order:

1. A 4–6-case live pilot (S vs O2) with an explicit global budget, measuring
   real writer output, real agent actions, recall attempts, usage and cost.
2. Fix F4's capacity limit with evidence, preserving validation and whole-
   checkpoint pricing.
3. Decide on a budgeted coverage fallback or an explicit `coverage incomplete`
   notice for H1.
4. Instrument the retrieval trigger in a real agent loop; no prefetcher.
5. Keep scope/task identity open until live evidence exists.

R34 must not add a second memory system to compensate for a writer omission and
a 12-delta limit. If no live budget is available, R34 should not expand
production code; it should stop at the offline instrument and say so.

## 16. Verification results (actual)

Two dependency graphs were measured, because the answer differs:

### Vendored graph (the R32-comparable one)

`vendor/deepseek-harness` is a local symlink to the same vendored tree the R32
worktree uses (gitignored; not part of the commit). With it:

```
Test Files  4 failed | 137 passed | 24 skipped (165)
Tests       4 failed | 1383 passed | 66 skipped (1453)
```

The four failures:

* `tests/bridge-loads.spec.ts` — known vendor/host drift.
* `tests/rc3-plugin-packaging.spec.ts` — known vendor/host drift.
* `tests/rc7-inplace-drift.spec.ts` — known vendor/host drift.
* `tests/release-hygiene.spec.ts` — a 5 s test timeout under full-suite load;
  it passes alone (5/5, 8.1 s).

All **25 R33 tests pass** in this run, including the arms suite.

### Installed-only graph (vendor absent)

Without the vendored tree, `vitest.config.ts` falls back to the installed
`@deepseek-ai/dsh-*` 0.2.1-rc.3 packages. The same run produced:

```
Test Files  10 failed | 131 passed | 24 skipped (165)
Tests       13 failed | 1370 passed | 70 skipped (1453)
```

The nine extra failures are host-drift assertions that expect the vendored
0.1.7 event transport (`ef/anchor`) rather than the installed 0.2.1 sanctioned
plugin transport, plus one 5 s timeout. The same tests pass on the R32 worktree
and pass here with the vendored graph. They are **not** R33 regressions, and
they are not evidence that the installed 0.2.x line is unsupported by the
product code — the product code adapts to the host; the tests are written
against one graph.

The mixed-resolution result is not reported as a single-version compatibility
proof. The supported declarations remain those in `R32_HANDOFF.md`.

### Typecheck, build, preflight

```
npm run typecheck   OK (src, client, eval)
npm run build       OK (78 modules; lib/ current)
npm run preflight   OK (lib/ present and current)
npm run eval:r33-verify   OK (17 cases; digest 2666e70f…)
```

## 17. Gate status

| Gate | Result | Evidence |
|---|---|---|
| **G1 Valid Dataset** | **PASS** | 17 frozen cases, verbatim gold, manifest digest, leakage tests. |
| **G2 Controlled Comparison** | **PASS offline; LIVE BLOCKED** | Shared initial state and paired arms; live S/O2 implemented, not run. |
| **G3 Diagnostic Observability** | **PASS** | Call/protocol/deltas/integrity; state; visible context; action; checker. |
| **G4 Behavioral Measurement** | **PARTIAL / NOT CLAIMED** | Real workspaces, tools, visible tests and hidden checkers, but the agent is scripted. Per §12, G4 is not passed without a real model run. |
| **G5 Cost Integrity** | **PASS for the gate; LIVE NOT EXERCISED** | One global ledger, positive limits, retries counted, unknown usage charged, exit codes. No spend. |
| **G6 Reproducibility** | **PASS** | Manifest digest, frozen cases, route manifest schema, reports, commands. |
