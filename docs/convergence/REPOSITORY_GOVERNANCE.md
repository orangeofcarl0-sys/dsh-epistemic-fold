# EF-C0 — Repository Governance

Status: policy, effective 2026-11-08. Not yet enforced by branch protection.

## 1. Branch roles

| Prefix | Role | Base | Merge target |
|---|---|---|---|
| `main` | stable product | — | — |
| `research/*` | long-running research | `main` or the verified research line | never automatic |
| `feature/*` | product candidate | `main` | `main` via PR |
| `fix/*` | narrow production fix | `main` | `main` via PR |
| `chore/*` | repository maintenance | `main` or the line it audits | as declared |

Current branches mapped:

```text
main                            stable product line
rc38-mechanism-validation       frozen research milestone (do not rename now)
rc36/rc37c/rc37d                research stages; commits reachable, no remote ref
rc29-working-set-observer       side line + open PR #4
chore/ef-c0-convergence         this round's audit branch
```

`rc38-mechanism-validation` is a **frozen research milestone**. Renaming it
would break the SHA references in R38 evidence and is not worth the churn.

## 2. The four operations are separate

```text
local commit   →  push  →  open PR  →  merge  →  release
```

Each is its own authorization. The rules:

1. A completed research round does **not** imply a push.
2. A push does **not** imply a PR.
3. A PR does **not** imply a merge.
4. A merge does **not** imply a release.
5. A release does **not** promote a research mechanism to a product default.

The R38 push was authorized explicitly and separately from this round. EF-C0
does not push.

## 3. Research line policy

- A research branch is cut from the verified research HEAD, not from `main`,
  when the work depends on prior research.
- Research commits are never rebased once shared. A correction is a new commit.
- A research branch may contain production `src/` changes, but those changes do
  not reach `main` without the product integration pipeline
  (`PRODUCT_INTEGRATION_PLAN.md`).
- A research milestone is identified by a SHA in the registry, not necessarily
  by a remote branch ref.

## 4. Tags and snapshots

Use a tag when a **release artifact** must be immutable. Use a SHA registry
entry when a research stage must be identifiable.

```text
release          annotated tag, e.g. v0.1.0
research stage   SHA in git-stage-map.json / evidence-registry.json
```

Do not create a tag per research round. Do not move an existing tag. The
existing `v0.1.0` is annotated and points at `f7fa86c`, on `origin/main`.

## 5. Deleting a branch, tag or worktree

Before any deletion, all four must hold:

1. the commits are still reachable from a surviving ref;
2. no evidence artifact depends on the ref being present;
3. no worktree has it checked out;
4. a separate authorization names the deletion.

The `rc36`/`rc37c`/`rc37d` commits are reachable from R38 and are therefore
safe from a commit-loss perspective, but their refs are still the only local
names for those stages. Deleting them would make the stage map depend on the
registry alone. Do not delete them in this round.

## 6. Open PR #4 (RC29)

```text
PR            4
title         RC29: thermal working-set observer and shadow folding policy
branch        rc29-working-set-observer
target        main
state         OPEN since 2026-10-19
```

The thermal observer already exists on the main line: `src/state/thermal.ts`
(413 lines) was added by `377515b`, which is an ancestor of both `origin/main`
and R38. The RC29 branch is not an ancestor of R38.

Recommendation: **review, then close as superseded** if the remaining diff adds
nothing beyond `377515b`. Do not merge it blindly; do not delete the branch
without the deletion checklist. This round takes no remote action.

## 7. Branch protection (recommended, not enabled)

```text
main
  require PR review                 1
  require status checks             core-gate
  require linear history            optional
  disallow force push               yes
  disallow deletion                 yes
```

The repository currently has no protection. Until it does, the discipline in
this document is policy, not a control. A direct push to `main` is technically
possible.

## 8. Agent scope control

A future agent working in this repository must:

- read `docs/convergence/README.md` first;
- treat `Research-only` as "no production path", not "approved to wire";
- not add a new LLM component to replace a working deterministic mechanism;
- not push, merge, rebase, delete branches, or create tags without a separate
  authorization;
- record a gate as `blocked` / `not-verifiable` rather than `passed` when it
  cannot be verified;
- keep historical evidence immutable.

These are the rules that prevent the scope from expanding silently. They are
also the rules this round applied to itself.

## 9. What this round did to Git

```text
created branch      chore/ef-c0-convergence
created worktree    ../ef-c0-convergence from R38 HEAD
commits             local only (see handoff)
push                not performed
merge/rebase/reset  not performed
tag                 not created
branch deleted      none
```

## 10. Evidence

```text
docs/convergence/data/git-stage-map.json
docs/convergence/REPOSITORY_HISTORY.md
```
