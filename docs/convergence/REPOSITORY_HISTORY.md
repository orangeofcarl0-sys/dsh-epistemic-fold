# EF-C0 — Repository History and Stage Map

Status: current implementation truth, verified 2026-11-08.

Machine-readable companion: `docs/convergence/data/git-stage-map.json` and
`docs/convergence/data/change-inventory.json`. Every SHA below was read from
the repository, not copied from a handoff note.

## 1. Verified remote state

```text
Repository   orangeofcarl0-sys/dsh-epistemic-fold
origin/main  93b6666913dab6e00ca67032de9660f1bc75c052
R38          006702023e8cf2fcdfd4a814e7be5f2ddf3534ec
Merge base   93b6666913dab6e00ca67032de9660f1bc75c052
R38 ahead    96 commits
R38 behind   0 commits
```

`origin/main` is an ancestor of R38, so the two are one line, not two
competing histories. R38 is 30 commits ahead of R37-B
(`5ef67814a4ec8fd8bcca362b89ad338acd0a8ae0`).

The local `main` is **not** the released line:

```text
local main   bd1131cc039c8addf1590973f7e6e406ed126e64
origin/main  93b6666913dab6e00ca67032de9660f1bc75c052
diverged     yes — local main is 243 behind and 1 ahead
```

This is recorded, not repaired. No operation in this round merges, rebases or
resets either line.

## 2. Stage map

Every row after `main` was checked with `git merge-base --is-ancestor` against
its predecessor. The chain is unbroken.

| Stage | Base SHA | Final SHA | Commits | Remote ref | Production files touched |
|---|---|---|---|---|---|
| main / released | `93b6666` | `93b6666` | baseline | `origin/main` | — |
| RC30 | `77ab916` | `77ab916` | 1 | yes | 26 |
| RC31 | `ef3cdc7` | `6607149` | 4 | yes | 12 |
| RC32 | `9d4c84d` | `bef473d` | 8 | yes | 19 |
| RC33 | `56182eb` | `ad3020d` | 9 | yes | 8 |
| RC34 | `76c4414` | `8db92f4` | 7 | yes | 2 |
| RC35 | `823a3db` | `914ed31` | 12 | yes | 0 |
| R36 | `af6e533` | `b8274bb` | 14 | **no** | 2 |
| R37-A/B | `7d519f2` | `5ef6781` | 11 | yes | 0 |
| R37-C | `fc777ef` | `045cccf` | 10 | **no** | 0 |
| R37-D | `0fa7870` | `7a2c974` | 12 | **no** | 0 |
| R38-M0 | `5e464ef` | `0067020` | 8 | yes | 5 |

"Production files touched" counts paths under `src/` in that stage's diff. A
zero means the stage changed evaluation, tests or documentation only — it did
not change the runtime.

The per-stage `productionPaths` and `evidencePaths` arrays are in
`git-stage-map.json`.

## 3. Reachability is not the same as a branch ref

```text
rc36-semantic-interface      b8274bb   commit reachable from R38; no origin ref
rc37c-measurement-closure    045cccf   commit reachable from R38; no origin ref
rc37d-operational-completion 7a2c974   commit reachable from R38; no origin ref
```

All three commits are ancestors of `origin/rc38-mechanism-validation` and are
therefore present on the remote. The branch *refs* do not exist. This round
does not create them: a missing ref is a naming/ governance question, not a
lost commit, and adding refs automatically would change the remote surface
without a decision.

## 4. RC29 is a side line, not a predecessor

```text
rc29-working-set-observer   bd1131c -> 7a42ec6   (1 commit)
branched from               bd1131c (the local main)
ancestor of R38             no
remote ref                  yes
open PR                     #4, opened 2026-10-19, target main
```

RC29's single commit ("a thermal working-set observer and a shadow folding
policy") is **not** in R38's history. Any statement that treats RC29 as the
first stage of the R38 chain is wrong. It is a separate proposal sitting in
PR #4 and must be reviewed on its own terms.

## 5. Tags and release

```text
refs/tags/v0.1.0   annotated tag object b167ce0
                   -> commit f7fa86c
                   reachable from origin/main   yes
```

The repository has one release tag. No tag was created, moved or deleted in
this round.

## 6. Change distribution, main → R38

```text
files changed     630
insertions        353,531
deletions             572
current bytes      12,921,464
```

By category (path-classified, not commit-message-classified):

| Category | Files | Insertions | Current bytes |
|---|---:|---:|---:|
| research evaluation | 311 | 26,999 | 1,054,694 |
| generated evidence | 103 | 274,547 | 9,302,145 |
| documentation | 98 | 17,786 | 738,493 |
| tests | 78 | 14,647 | 649,411 |
| semantic continuity (`src/semantic`) | 17 | 5,438 | 224,254 |
| core runtime (`src/fold`, plugin, index) | 5 | 1,832 | 235,598 |
| deterministic state | 5 | 488 | 46,843 |
| configuration / build | 5 | 1,461 | 127,493 |
| checkpoint / archive / recall | 3 | 215 | 41,247 |
| configuration | 3 | 85 | 38,196 |
| shared evaluation harness | 2 | — | — |

Two facts follow directly:

1. **78% of the inserted lines are generated evidence JSON** (274,547 of
   353,531). The research rounds committed their results, not only their code.
2. **The runtime surface is small relative to the research surface.** 33 files
   under `src/` changed, against 311 research-evaluation files.

The largest changed files are all evidence, not code:

```text
1,759,659  eval/r37c/out/evidence-inventory.json
  982,021  eval/r37c/out/protocol-admission.json
  635,370  eval/r33/out/self-test-report.json
  569,451  eval/r37/out/r36-evidence-reconstruction.json
  407,766  eval/r37d/out/operational-completion.json
```

Separately, `eval/memory/corpora/` contains **eight tracked JSON files totalling
about 41 MB** (the largest is 25.9 MB). They are benchmark inputs, not results,
but they dominate repository size. They were already present on `main`; R38 did
not add them.

## 7. R38's production surface

R38 changed exactly five production files:

```text
src/fold/engine.ts            attach the retirement audit to packets
src/semantic/plan.ts          authorized retirement, withholding, target classes
src/semantic/retirement.ts    new: retirement power and refusal reasons
src/semantic/types.ts         audit and duplicate-claim types
src/semantic/validate.ts      claim identity vs revision identity
```

No R38 commit touches R37-B/C/D evidence. The R37-B archive identity still
matches (§ `EVIDENCE_INVENTORY.md`).

## 8. CI reality

`.github/workflows/ci.yml`:

```text
push trigger            branches: [main] only
pull_request trigger    any PR
workflow_dispatch       manual
jobs                    pinned-dsh (required), dsh-master (continue-on-error)
```

Consequences, stated plainly:

- A pushed research branch **without a PR gets no CI**. `rc38` was pushed and
  no workflow ran for it.
- Opening a PR would run CI, because `pull_request` is unconditional.
- The pinned job checks out DSH at `0.2.0-rc.2` (`639ed01`), while
  `package.json` devDependencies pin `0.2.1-rc.3`. The CI vendor tree and the
  local dependency tree are different versions. This is the source of the
  known vendor/DSH-drift failures and is recorded in
  `CI_AND_RELEASE_GATES.md`, not fixed here.
- The pinned job runs the full Vitest suite plus R1/R2 evaluation. It does not
  run R33–R38 research evaluation, so a green CI says nothing about the
  research rounds.
- There is no branch protection. A direct push to `main` is technically
  possible; the discipline in `REPOSITORY_GOVERNANCE.md` is policy, not an
  enforced control.

## 9. Method and limits

- All Git commands were read-only. No fetch was needed for the comparison: the
  remote refs were already present and were re-read with `git ls-remote` before
  the push that created `origin/rc38-mechanism-validation`.
- Classification reads paths, not commit messages. A path whose role was
  ambiguous (`scripts/build-eval.mjs`) was classified by reading it.
- Renames are reported as add + delete; the inventory is a path census, not a
  similarity analysis.
- The stage map uses branch tips as stage boundaries. A stage's "base" is the
  first commit after the previous tip, so a stage that was later amended would
  show the amended range.
