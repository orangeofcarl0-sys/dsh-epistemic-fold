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
rc29-working-set-observer       side line; PR #4 (historical state below)
chore/ef-c0-convergence         this round's audit branch
```

Historical facts frozen at EF-C0 (the current state may differ; these are
records, not live claims):

```text
chore/ef-c0-convergence was never pushed (no upstream) as of 327598f.
PR #4 was open at EF-C0 convergence; it was closed as superseded by PR #5
on 2026-11-08, and its branch was preserved. The closure is recorded in
docs/convergence/C1_DECISION.md and in the PR #4 comment.
```

A gate that re-checks "PR #4 is open" or "the branch has no upstream" would
turn a frozen record into a claim about today, and would fail on a CI checkout
that has neither the local branch nor the PR. The gates read the frozen text
above instead.

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

## 6. PR #4 (RC29) — closed as superseded

```text
PR            4
title         RC29: thermal working-set observer and shadow folding policy
branch        rc29-working-set-observer
target        main
state         open at EF-C0 convergence (2026-10-19); closed as superseded by
              PR #5 on 2026-11-08
```

The thermal observer already exists on the main line: `src/state/thermal.ts`
(413 lines) was added by `377515b`, which is an ancestor of both `origin/main`
and R38. The RC29 branch is not an ancestor of R38.

The EF-C1 round reviewed the branch, found a real but narrow delta
(`src/working-set.ts`, `src/shadow-policy.ts`, `src/working-set-observer.ts`),
and closed PR #4 with that delta recorded in its comment. The branch was not
deleted. Do not reopen or delete it without a new authorization.

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
