# R37-D — Baseline

## 1. Repository state

```text
Repository          orangeofcarl0-sys/dsh-epistemic-fold
R37-C branch        rc37c-measurement-closure
R37-C HEAD          045cccf275132ffda8c76a9fbdc8620338af6164
R37-B base          5ef67814a4ec8fd8bcca362b89ad338acd0a8ae0
R37-C worktree      F:/Codex_Work_Space/DSH plugin/ef-r37c-closure
R37-B worktree      F:/Codex_Work_Space/DSH plugin/ef-r37-action
R37-D worktree      F:/Codex_Work_Space/DSH plugin/ef-r37d-operational
R37-D branch        rc37d-operational-completion
Push                not performed
```

The R37-C branch is local only. R37-D was created from the local commit, not
from the remote R37-B head.

```text
git diff --check 5ef6781..045cccf    clean
git status (R37-C worktree)          clean
git status (R37-B worktree)          clean
```

R37-C diff from the R37-B head:

```text
67 files changed, 102,492 insertions(+), 9 deletions(-)
```

Most insertions are audit JSON, not source code.

Commit chain:

```text
fc777ef  test(eval): preserve R37-B evidence and establish the R37-C baseline
1ce0969  fix(eval): separate accepted, committed and rendered semantic metrics
0820984  fix(eval): separate measurement validity from pipeline outcomes
482c935  fix(eval): enforce preregistered gates and audit the R37-B statistics
1edb578  fix(eval): harden DSML decoding and protocol admission diagnostics
c2f1174  test(eval): certify the native agent/tool lifecycle
77a2439  feat(eval): preregister and run the bounded process-causal pilot
ea7c092  docs(eval): publish the R37-C decision and handoff
f450483  docs(eval): attribute the C2 guard result to the observed trajectories
045cccf  docs(eval): finalize the R37-C handoff
```

## 2. Evidence archive

```text
Path      F:/Codex_Work_Space/DSH plugin/ef-r37c-evidence-archive/r37b-raw-evidence-20261106.tar.gz
Bytes     3,763,962
SHA-256   de6102989457fba6e5f4c43406478ce91b360f247f2dd462759f252f69de1c92
```

The hash and byte count match the R37-C handoff. The archive remains outside
the git worktree.

R37-C evidence integrity, re-read rather than trusted:

```text
status                 passed
runs                   381
rows                   381
files                  2,919
bytes                  17,449,050
cell matrix            360 / 360 unique observed
missing / unexpected   0 / 0
secret findings        0
truncated rows         113
```

The 1,000-character trace cap is a property of the stored evidence. The archive
does not reconstruct text that was never stored.

## 3. What R37-D may and may not touch

Frozen:

```text
eval/r37/out/*
eval/r37c/out/*
eval/r37c/runs-c2/*
eval/r37c/manifests-c2/*
docs/semantic-continuity/R37C_*.md
the R37-B and R37-C worktrees
```

R37-D writes only under:

```text
eval/r37d/
tests/r37d-*.spec.ts
docs/semantic-continuity/R37D_*.md
```

New metrics are additive. Legacy `contractSuccess`, `taskSuccess`, and the
R37-B/R37-C reports are not rewritten.

## 4. Machine artifacts

```text
eval/r37d/out/baseline.json
eval/r37d/out/r37c-audit.json
```

Both are produced by:

```bash
node eval/r37d/audit-r37c.mjs
```

The script exits non-zero when any checked property disagrees with the expected
state. The current run exits `0` with zero discrepancies.
