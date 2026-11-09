# EF-R1 — Authority Closure and Executable Historical Recovery

Status: complete for the offline scope, 2026-11-09.

This round did **not** make a model call, open a live envelope, push, merge,
release or deploy. Both earlier envelopes are closed (72/72 and 24/24), and the
work package did not authorize a new one. What it does contain is a security
fix verified through the production path, a stage-level re-analysis of the 96
executed cells, an executable archive address behind an opt-in flag, four new
recovery tasks, a frozen 120-cell design, and a preservable research archive.

Machine evidence lives under `eval/ef-r1/out/` and `eval/e2e/out/`. The E2E
round's result is not rewritten; [E2E_RESULT.md](E2E_RESULT.md) remains the
record of those campaigns.

## 1. What was actually wrong: the operation, not only the relation

The E2E round fixed two ways an assistant decision could retire a user decision:
an explicit `supersedes` target, and `supersedes: ["previous"]` at the same
coordinate. This round reproduced a third and broader path through
`validateDeltas → planCommit → applyOps`:

| Reproduced path | Pre-fix behaviour | Now |
|---|---|---|
| Assistant decision at an occupied coordinate, `supersedes: []` | declares and replaces the user head; `withheld: []` | delta withheld, user value active |
| Assistant decision with an unrelated `supersedes` target | named target refused, **implicit** head still replaced | both effects refused, delta withheld |
| Assistant decision citing assistant + tool evidence | source derived as `tool`; source check bypassed | origin `assistant`; refused |
| Assistant decision quoting the user's **original** statement | source `user`; opposite decision written and labelled user | `stale-source`; refused |

The root cause is one sentence: **a declare at an occupied coordinate is a
retirement operation**, and authorization was only applied to relations the
writer named. `planCommit` now resolves the actual state effect of every declare
against the state it will meet — including earlier declares in the same packet —
and withholds the whole delta when the displaced head is not authorized. A
second rule requires a decision revision to cite a statement newer than the value
it replaces; restating an identical value is allowed because it changes nothing.

The fix is in `src/semantic/plan.ts`, `retirement.ts`, `validate.ts` and
`state/authority.ts`. Historical replay is deliberately **not** re-authorized:
recorded ops still apply as recorded, and the new matrix includes that case.

Evidence:

```text
eval/ef-r1/out/operation-authority.json   15/15 required cases, verdict authority-closed
eval/ef-r1/out/probe-before.txt           four vulnerable paths at cb218cc
eval/ef-r1/out/probe-after.txt            the same four paths, zero declares
tests/ef-r1-operation-authority.spec.ts   the 15-case matrix
```

The four probe outputs are the before/after comparison. The probes were run with
the source fix stashed, then restored; no historical result was edited.

## 2. Research assets are preserved

`eval/e2e/src/archive-research.mjs` built an external package at
`../EF_E2E_RESEARCH_ARCHIVE`:

```text
files            1,224
bytes            38,046,786
campaigns/cells  6 / 96
git bundle       23,628,649 bytes, verified, 14 archive tags
credentials      0
absolute paths   115 files (reported, not a secret)
proxy values     27 files (the local route)
safeToShare      true
```

Every file is listed in `SHA256SUMS` (1,224 entries; `sha256sum -c` passes). The
repository-side pointer is `eval/e2e/out/research-archive.json`, which records
the archive manifest and sums hashes. The archive copies the bytes; it does not
rewrite, redact or re-analyse them. A credential would have been reported and
the package marked unsafe, not silently cleaned.

One archive tag is not backed by any remote
(`archive/snapshot-pre-semantic-audit-v1`); the bundle is the copy that protects
it. No worktree, branch, tag, PR or remote was changed by this round.

## 3. The 96 cells, attributed to a stage

`eval/e2e/src/stage-attribution.mjs` reconstructs seven stages per cell:

```text
A archiveAvailable  B evidenceLocated  C correctEvidenceObserved
D correctValueProduced  E outputWritten  F outputSchemaValid  G checkerPassed
```

47 of 96 cells failed, and the failures are not one mechanism:

| Stage | Cells | What it means |
|---|---:|---|
| produce | 17 | nothing written and the value never stated |
| write | 13 | value stated, deliverable not written |
| schema | 12 | file exists but keys/types wrong |
| verify | 5 | shape-correct, values or tests fail |
| observe | 0 | not demonstrable from the recorded text |

**C is unknown in 35 memory-task cells** (19 of them failures). The first 71
cells predate ordered trajectory capture; a truncated preview cannot prove that
a fact was absent, so those are counted apart rather than labelled an
observation failure. No cell can be shown to have failed at observation with
the evidence that exists — a limit of coverage, not a claim that observation
never failed.

How passing values actually arrived:

| Path | Cells |
|---|---:|
| from a primary tool result | 22 |
| from the checkpoint alone | 7 |
| neither visible source | 12 |
| value not produced | 30 |

The checkpoint path is why a Basic cell can pass T2 (`B0`'s summary contained
both values) and why an E1 cell can pass without recall. A pass is not evidence
that the archive was used.

Evidence: `eval/e2e/out/stage-attribution.json` (per-cell) and `.md`.

## 4. An executable address for archived evidence

The index campaign's decisive failure was an address-space confusion: the
checkpoint said `read_file logs/gateway-2026-10-11.log`, the model re-issued
`read_file`, the path had been rotated, and the model concluded the evidence
was gone.

`src/checkpoint/locator.ts` renders a different object:

```text
Historical evidence (archived messages, NOT current workspace files)
- archived observation from read_file logs/x.log @4 -> context_recall {"ref":"cp:...","depth":"exact","offset":4,"limit":1}
```

The identity is the archived message index plus `canonicalHash(message)`;
retrieval is the existing `context_recall`; the result is an observation, not a
claim about the current workspace. Resolution re-reads through the recall path
and refuses a digest mismatch, a missing bundle, or another session's
checkpoint. Only a one-token path-like label from untrusted tool arguments
survives; a newline or an instruction is dropped.

It is opt-in (`archiveLocator`, default false), bounded to 3 addresses and 720
characters, adds no tool and intercepts no `read_file`. A representative
three-result section is 675 characters (~169 tokens by chars/4), so the cost is
real and must be measured, not assumed.

Evidence: `eval/ef-r1/out/locator-contract.json`, 11/11 cases;
`tests/archive-locator.spec.ts`.

## 5. Four new recovery problems and a frozen design

The 96-cell round concentrated its retrieval evidence in T2/T4. Four templates
were added, each a different recovery shape:

| Template | Question | The trap |
|---|---|---|
| T7 | failure count of the pre-fix test run | a newer all-passing run in the workspace |
| T8 | timeout in effect during the incident | the current config file has changed |
| T9 | service + release + tag of the incident deploy | two files, both since redeployed |
| T10 | concurrency at 10:00 | three revisions; first and current are both wrong |

All **22/22** instances certify: initial fails, reference passes, counterfactual
fails, seed above the pressure threshold
(`eval/ef-r1/out/task-certification-e2e2.json`). The original 14 task files are
byte-identical; the generator only added the new ones.

The next behavioural step is designed, not run. A 2×2 factorial separates the
locator (L) from the completion guard (G), with E1 as an independent reference:

```text
E0      L off, G off       E0-L    L on,  G off
E0-G    L off, G on        E0-LG   L on,  G on
E1      rationale reference, never pooled into the 2x2
```

6 templates × 2 seeds × 2 paired replicates × 5 arms = **120 cells**, plus 18
fault reserve, cap 138. The primary unit is the task instance, not the cell.
The frozen design is `eval/ef-r1/out/ablation-design.json`
(SHA-256 `1c52fed8818b858fbc64776e41c029efae562a958775715b8d1aa1d15edd7245`),
with a zero-request preflight in
`eval/ef-r1/out/ablation-design.freeze.json`. `executionAuthorized` is false:
the requested envelope (138 cells, 4,200 requests, 30M input, 1.2M output, 6h,
concurrency 2, monetary 25 with no verifiable price) is **not granted**.

## 6. Integration and the candidate

```text
typecheck:src/client/eval    pass
supported lane               1,726 passed, 66 skipped, 204 files
local-only failure           rc7-inplace-drift (installed DSH 0.2.1-rc.3 has
                             19 preset rows; the pinned CI tree has 22)
candidate tarball            built and installed; size/hash in the smoke report
install smoke                basic/economy/quality mount, semantic off,
                             no raw run, no credential, no checkout path
```

The tarball is not tracked (the repository carries the source and the report,
not the 1.4 MB artifact). Its SHA-256, file count and every smoke check are in
`eval/ef-r1/out/candidate-build.json`; a reader can rebuild it and compare. The
hash is deliberately not repeated in this document: the document is inside the
tarball, so a hash written here would describe a package that did not contain
it.

The supported lane's only failure is an environment divergence, not a code
regression: this worktree runs the installed `0.2.1-rc.3`, while the pinned CI
lane checks the vendored `0.2.0-rc.2` preset tree. Remote CI was **not** run:
this round's work package does not authorize remote Git operations, and no push
was made.

Candidate: `eval/ef-r1/candidate/dsh-epistemic-fold-0.1.0.tgz`, smoke report
`eval/ef-r1/out/candidate-build.json`.

## 7. Decisions

```text
EF Core default            unchanged
Semantic Active            Deployment Hold (unchanged)
recallAffordance           Off
foldedSpanIndex            Off
completionGuard            Research-only (not an EF feature)
archiveLocator             Research candidate, default Off
Operation-level authority  Fixed and certified; not a product release
```

The authority fix is a correctness fix, not a product benefit claim. The locator
has a deterministic contract and no behavioural result. The stage attribution
does not show that any EF configuration is better than another; it shows that
"compression failed" was too coarse to be useful.

## 8. Limits

- No live call, so no new behavioural or product-level evidence.
- The 96-cell attribution is observational and post hoc; C is unknown in 35
  memory cells because the raw tool bytes were not captured.
- The four new tasks are certified offline but have never met a model.
- The locator is an address, not a retrieval success; whether a model uses it is
  the next experiment and is not authorized.
- The archive is external to the repository. Its pointer is tracked; its bytes
  are not. A reader who has a copy can verify it; a reader who has only the
  repository cannot.
- The supported lane has one local-only, environment-specific failure; remote CI
  was not run in this round.

## 9. Verify

```bash
node eval/ef-r1/operation-authority.mjs   # WP1 matrix + before/after probes
node eval/e2e/src/stage-attribution.mjs   # WP2, offline
node eval/ef-r1/locator-contract.mjs      # WP3, 11 cases
node eval/ef-r1/ablation-design.mjs --check
node eval/e2e/src/archive-research.mjs --out ../EF_E2E_RESEARCH_ARCHIVE
npx vitest run tests/ef-r1-operation-authority.spec.ts tests/archive-locator.spec.ts
```
