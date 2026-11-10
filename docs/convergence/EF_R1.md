# EF-R1 — Authority Closure and Executable Historical Recovery

Status: complete, 2026-11-09. Offline work first, then a 24-cell pilot and a
120-cell confirmatory campaign under explicit authorization.

The round contains a security fix verified through the production path, a
stage-level re-analysis of the 96 E2E cells, an executable archive address
behind an opt-in flag, four new recovery tasks, a preservable research archive,
and two live campaigns that test the address and a completion guard. It made no
merge, release or deployment; the branch was pushed for CI, and the candidate
is an installable build, not a release. Both earlier envelopes remain closed
(72/72 and 24/24); the 144 new cells ran under two separate grants.

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
eval/ef-r1/out/operation-authority.json   16/16 required cases, verdict authority-closed
eval/ef-r1/out/probe-before.txt           four vulnerable paths at cb218cc
eval/ef-r1/out/probe-after.txt            the same four paths, zero declares
tests/ef-r1-operation-authority.spec.ts   the 16-case matrix
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
it.

After the pilot and confirm, a second package
(`../EF_R1_RESEARCH_ARCHIVE`) was built over the combined evidence:

```text
files            3,018
bytes            72,984,436
campaigns/cells  8 / 240
git bundle       23,829,277 bytes, verified
credentials      0
safeToShare      true
pointer          eval/ef-r1/out/research-archive-r1.json
```

It was verified against the pointer, copied to `E:/EF_R1_RESEARCH_ARCHIVE`, and
the copy was verified again with the same pointer and `SHA256SUMS`. That is a
second volume on this machine, **not** an off-machine backup; the distinction is
in §8. Neither archive overwrites the other, and the E2E pointer still names the
96-cell package. The 10-cell T10 retest post-dates the 240-cell package; its
aggregate results are tracked in `eval/e2e/out/`, but its raw runs are local and
not in that snapshot.

No worktree, branch, tag or remote was changed by the archive work.

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

How passing values actually arrived, after adding a task-prompt source and a
loose prose match for checkpoint delivery:

| Path | Cells |
|---|---:|
| every value seen in a primary tool result | 13 |
| every value explained by the checkpoint (some also by a tool) | 13 |
| every value explained by checkpoint or task prompt (some also by a tool) | 10 |
| at least one value has no visible source | 5 |
| value not produced | 30 |

The five unexplained cells are T2/T4 cells whose short second value sat beyond
a truncated preview; they are the class full-message capture removes. The
checkpoint path is why a Basic cell can pass T2 (`B0`'s summary contained both
values) and why an E1 cell can pass without recall. A pass is not evidence that
the archive was used.

New runs write `raw/messages.json` with the exact primary messages, so C is
decidable: all 24 pilot cells have C=true from a full message or a trajectory.
The 96 old cells cannot be repaired; their unknowns stay unknown.

Evidence: `eval/e2e/out/stage-attribution.json` (per-cell) and `.md`; the
current run covers 240 cells (96 E2E + 24 pilot + 120 confirm).

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

## 5. Four new recovery problems, then two campaigns

The 96-cell round concentrated its retrieval evidence in T2/T4. Four templates
were added, each a different recovery shape:

| Template | Question | The trap |
|---|---|---|
| T7 | failure count of the pre-fix test run | a newer all-passing run in the workspace |
| T8 | timeout in effect during the incident | the current config file has changed |
| T9 | service + release + tag of the incident deploy | two files, both since redeployed |
| T10 | concurrency at 10:00 | three revisions; first and current are both wrong |

All 22 instances certified before the campaigns. The pilot then exposed a
**fixture defect in T10**: its random log contained concurrency values at times
that contradicted the changelog, so a model could answer from the log and be
defensibly right while the checker required the middle revision. T10 was fixed
(time-based values, unambiguous windows) and re-certified, but the 120-cell
campaign had already been frozen with the ambiguous version. **Every T10 cell in
the confirm is excluded from the primary estimate and reported separately.** No
other template was changed after certification.

### 5.1 Pilot: 24 cells

T2/T9/T10 × 2 seeds × {E0, E0-L, E0-G, E0-LG}, one paired replicate, under a
32-cell cap. 24/24 executed; 124 requests, 1.18M input, 17.7k output, 5.0 min.

| Arm | Pass | Cells |
|---|---:|---|
| E0 | 0 | 6 |
| E0-L | 2 | 6 |
| E0-G | 2 | 6 |
| E0-LG | 3 | 6 |

No arm lost a cell E0 passed. The locator converted T9/T10 write failures into
passes; the guard converted T2/T10 produce/write failures. The pre-registered
gate was positive, so the confirmatory design was run.

### 5.2 Confirm: 120 cells

6 templates × 2 seeds × 2 paired replicates × {E0, E0-L, E0-G, E0-LG, E1},
under a separate 138-cell cap. 120/120 executed; 514 requests, 3.70M input,
72,960 output, 21 minutes. No budget stop, no provider failure.

| Arm | Pass | Rate | Requests | Input | Output |
|---|---:|---:|---:|---:|---:|
| E0 | 9/24 | 0.375 | 83 | 678,175 | 10,569 |
| E0-L | 15/24 | 0.625 | 77 | 842,370 | 9,963 |
| E0-G | 15/24 | 0.625 | 145 | 919,738 | 19,764 |
| E0-LG | 16/24 | 0.667 | 113 | 967,562 | 15,937 |
| E1 | 18/24 | 0.750 | 96 | 295,420 | 16,727 |

Paired by task instance and replicate (24 pairs per comparison):

| Comparison | Left only | Right only | McNemar p | Instances L/R/tied |
|---|---:|---:|---:|---:|
| E0-L vs E0 | 8 | 2 | 0.109 | 6/1/5 |
| E0-G vs E0 | 9 | 3 | 0.146 | 7/2/3 |
| E0-LG vs E0 | 8 | 1 | 0.039 | 7/1/4 |
| E0-LG vs E0-L | 4 | 3 | 1.000 | 4/3/5 |
| E0-LG vs E0-G | 5 | 4 | 1.000 | 4/3/5 |
| E1 vs E0 | 12 | 3 | 0.035 | 8/1/3 |

Excluding the ambiguous T10 (100 cells, 20 per arm):

| Arm | Pass | Paired vs E0 | p |
|---|---:|---|---:|
| E0 | 9/20 | — | — |
| E0-L | 14/20 | +7 / −2 | 0.180 |
| E0-G | 13/20 | +7 / −3 | 0.344 |
| E0-LG | 15/20 | +7 / −1 | 0.070 |
| E1 | 17/20 | +11 / −3 | 0.057 |

**After excluding the defective fixture, no L/G arm is significant at 0.05.**
The direction is positive for both mechanisms, but the pilot's signal did not
confirm as a general effect. It is template-specific: E0-L is 4/4 on T4 and E0-G
is 4/4 on T7, while E0-LG is 4/4 on T4 and T9 but 0/4 on T2. The combination
does not beat either mechanism alone (both p=1.0).

### 5.3 T10 fault retest with the fixed fixture

The fixed T10 was run over both seeds and all five arms (10 cells) inside the
confirm envelope's remaining reserve, with the prior usage subtracted: 61
requests, 397,783 input, 8,300 output, 2.7 minutes.

| Arm | Pass |
|---|---:|
| E0 | 0/2 |
| E0-L | 0/2 |
| E0-G | 2/2 |
| E0-LG | 1/2 |
| E1 | 2/2 |

E0 exhausts the step limit; E0-L's failure is explicit task loss ("there's no
question on the surface"); E0-LG once writes a different shape
(`{"time","flag","value"}`), a schema failure. The guard and E1 solve the fixed
task; the locator alone does not. This is n=2 per arm and is a fault retest, not
a powered estimate.

### 5.4 The task prompt itself is foldable

At the 16k operational budget the active request is sometimes archived during
the continuation, not only the evidence. In the confirm, **44/120 cells lost
the task prompt by the last primary request** (27/100 excluding T10). The
covariate:

| Arm | Pass, prompt lost | Pass, prompt visible |
|---|---:|---:|
| E0 | 2/12 | 7/12 |
| E0-L | 2/9 | 13/15 |
| E0-G | 4/11 | 11/13 |
| E0-LG | 3/10 | 13/14 |
| E1 | 0/2 | 18/22 |

The locator's benefit is concentrated where the prompt survives; it does not
recover a lost task. This is a separate product defect: **the current request
must be protected from folding**, not merely better addressed in the archive.
The pilot's T9-s1 E0 cell failed with "I don't see a question in your latest
message — just the folded context markers" after three folds.

### 5.5 Prompt-protection pilot: the treatment was no-fold

An opt-in prototype (`protectActiveRequest`) starts the leaf span after the last
real user message. The repaired 8-cell pilot (the first attempt is invalid: a
stale `lib/` made every E0-P cell fail at construction with zero requests) ran
T9/T10 × 2 seeds × {E0, E0-P}: 24 requests, 117,205 input, 3,341 output.

| Arm | Pass | Prompt visible at end | Prompt lost | No fold | Mean retained tokens |
|---|---:|---:|---:|---:|---:|
| E0 | 0/4 | 0/4 | 4/4 | 0/4 | 5,593 |
| E0-P | 3/4 | 4/4 | 0/4 | **4/4** | 18,768 |

The prompt is preserved and the pass rate moves 0/4 → 3/4, **but every E0-P
cell is an economic refusal, not a fold around the prompt**: the post-request
span was ~133 tokens and the checkpoint ~530, so admission refused it and the
cell kept the full ~18–19k surface. The comparison is **no-fold vs fold**, not
"protected during a fold" vs fold. Starting the leaf after the request disables
compression on this workload and is not a viable protection.

The next design must fold normally and **re-render the active request verbatim
in the checkpoint** (or re-pin it after the fold), so the model always has the
instruction without blocking the span. That is a checkpoint-rendering change,
not a span-selection one.

### 5.6 Reading

- The locator is a correct address with a template-specific benefit, not a
  general retrieval win. It is strongest on T4 (expired configuration) and in
  combination on T9 (cross-file), and it hurts T2 in this batch.
- The guard moves failures from produce/write to verify (wrong value): it makes
  the model deliver, not retrieve. 145 requests and 920k input for 15/24.
- E1 (rationale) is the strongest and cheapest arm (17/20 excluding T10) but
  p=0.057; it deserves a dedicated evaluation, not an automatic default.
- On the fixed T10, the guard and E1 both pass 2/2, the locator 0/2 and E0 0/2.
  The multi-revision task is solvable, but not by the address alone; n=2.
- Protecting the prompt by moving the span start does not fold; it triggers an
  economic refusal. It preserves the request and passes, but the treatment is
  no-fold at ~18–19k retained tokens, not a viable compression policy.
  Re-rendering the active request after a normal fold is the next candidate.

## 6. Integration and the candidate

```text
typecheck:src/client/eval    pass
supported lane               1,726 passed / 66 skipped / 0 failed
                             12 historical files excluded; rc7-inplace-drift
                             excluded as a local environment divergence
CI run 42681223364           DSH 0.2.0-rc.2 pinned: success
                              DSH master probe: failure (independent, non-blocking)
candidate tarball            rebuilt after the anchor-service fix
install smoke                basic/economy/quality mount, semantic off,
                             no raw run, no credential, no checkout path
```

The local-only `rc7-inplace-drift` failure was an environment divergence:
this machine runs installed DSH `0.2.1-rc.3`, whose preset block has 19 rows
against the pinned tree's 22. The pinned CI lane passed on the first pushed
commit; the final run ID (after the anchor-service fix) is recorded in PR #5.

The candidate tarball is not tracked. Its SHA-256, size and every check are in
`eval/ef-r1/out/candidate-build.json`. The hash is not repeated here because
this document is inside the tarball.

No merge, release or deployment was performed. The branch is pushed; PR #5
remains a research integration record, not a product change.

## 7. Decisions

```text
EF Core default            unchanged
Semantic Active            Deployment Hold (unchanged)
recallAffordance           Off
foldedSpanIndex            Off
archiveLocator             Research candidate, default Off;
                           general benefit NOT confirmed (p=0.070 excluding T10)
completionGuard            Research-only; hand to DSH Agent Runtime, not EF
Operation-level authority  Fixed, invariant-tested; not a product release
E1 rationale               strongest reference (17/20), p=0.057; dedicated
                           evaluation recommended, no default change
protectActiveRequest       Experimental, default Off; span-start protection
                           REJECTED (it triggers economic refusal / no-fold).
                           Next candidate: re-render the active request
                           verbatim after a NORMAL fold
```

The authority fix is a correctness fix. The locator and guard are not product
features on this evidence. The most important product finding is not the
locator at all: it is that the active request can be folded at a 16k budget.

## 8. Limits

- 120 confirmatory cells, six templates, two seeds, two replicates, one model,
  one route, one machine. The primary unit is the task instance; 12 instances
  (10 without T10) cannot support a product-level claim.
- T10's confirm cells are invalidated by the fixture defect described in §5;
  the fixed T10 was run separately (10 cells, n=2 per arm), not re-integrated
  into the 120-cell estimate.
- The prompt-protection pilot is n=4 pairs and every E0-P cell was a no-fold
  (economic refusal), not a fold with a protected request. Its pass rate cannot
  be attributed to protection. The first attempt was invalid (stale `lib/`,
  zero requests in the E0-P cells) and is kept only as evidence of the harness
  defect that the new preflight now prevents.
- Task-prompt loss is both a finding and a confound. The L/G estimate is
  reported with and without the covariate, and no arm is significant at 0.05
  once T10 is excluded.
- The 96-cell attribution remains post hoc; C is unknown in 35 memory cells
  because those runs predate full-message capture. New runs are decidable.
- The archive is external to the repository; a second copy is on another local
  volume, not off-machine.
- The candidate is installable and smoke-tested, not released or deployed.

## 9. Verify

```bash
node eval/ef-r1/operation-authority.mjs      # 16-case matrix + probes
node eval/ef-r1/state-write-audit.mjs       # every writer + 180-pair invariant
node eval/e2e/src/stage-attribution.mjs     # stage labels, 258 cells
node eval/ef-r1/ablation-analysis.mjs       # 120-cell paired analysis
EF_R1_EXCLUDE_TEMPLATES=T10 node eval/ef-r1/ablation-analysis.mjs
node eval/ef-r1/prompt-pilot-analysis.mjs   # 8-cell repair pilot + no-fold caveat
node eval/ef-r1/locator-contract.mjs        # 11 contract cases
node eval/ef-r1/ablation-design.mjs --check
node eval/e2e/src/verify-archive.mjs        # external archive vs pointer
```
