# 138 - Proposal D as executed: the src/ directory move

**Status:** complete. Seven commits, `c1b1f55` through `f74412a`.
**Plan of record:** `docs/133_SRC_STRUCTURE_AUDIT.md` §5.
**Scope:** navigation only. Nothing was renamed, no exported symbol changed, and
`src/basic/` was never touched.

## 1. What changed

53 flat modules became 6 root modules plus 7 purpose directories.

~~~
src/
  compat.ts  doctor.ts  entry.ts  index.ts  plugin.ts  types.ts    (6, stayed)
  basic/      5   VENDORED, untouched
  checkpoint/ 11  archive-refs bundle-codec bundle-store checkpoint-marker
                  compiler framing hash inventory rationale renderer summary-retry
  config/     6   ef-keys effective-config plugin-config policy preset preset-self-check
  fold/       8   candidate engine fold-telemetry frontier idle-rebase
                  leaf-policy rebase-intent task-root
  policy/     7   economics-profile fold-economics policy-compiler pressure
                  root-policy trigger trigger-diagnostics
  recall/     8   descriptors gate recall recall-loop recall-telemetry
                  recall-transport subagent-recall tools
  state/      4   anchor-service authority projection state
  status/     4   command event-data status status-projection
~~~

## 2. Per-cluster churn, predicted against actual

`docs/133` §6 predicted the specifier edits per commit. Every batch landed on
the predicted number, which is the check that the rewrite tool and the audit
were modelling the same thing.

| cluster | commit | files | predicted edits | actual edits |
|---|---|---|---|---|
| status/ | `c1b1f55` | 4 | 24 | 24 |
| recall/ | `fab8db4` | 8 | 39 | 39 |
| state/ | `92cf6ec` | 4 | 47 | 47 |
| fold/ | `0968c14` | 8 | 71 | 70 |
| checkpoint/ | `4f466e8` | 11 | 79 | 79 |
| config/ | `74f5eaf` | 5 (+1) | 77 | 78 |
| policy/ | `f74412a` | 7 | 97 | 97 |

`fold/` is one edit short and `config/` one long, because `ef-keys.ts` did not
exist when the audit ran: it was created by proposal C afterwards, and it added
one out-edge to `config/` and removed one from `fold/`.

## 3. Two blind spots the first batch did not have

A directory move is usually described as "safe because every missed specifier is
a compile error". That is true of `import` statements and false of two other
categories, and both bit this migration.

**(a) Scan lists that were one directory short.** `bench/paired-baseline.ts`
imports `../src/leaf-policy.ts`. `bench/` was not in the rewrite tool's scan
list, so the fold batch moved the file and left the importer behind. `tsc` did
catch it, which is the only reason it did not ship. `scripts/dev/repair-specifiers.mjs`
now closes this class: it finds any relative specifier that no longer resolves,
locates the target by unique basename under `src/`, and rewrites it.

**(b) Source-inspection assertions.** Five tests pin a property by reading a
module's *text*, building the path as `join(ROOT, 'src', 'engine.ts')`. A rename
turns those into an `ENOENT` that reads exactly like a behavioural regression —
which is what they looked like until the error was read. They now resolve the
module by basename through `tests/src-module.ts`, which enforces uniqueness and
makes the assertions immune to the remaining batches. This is a real improvement
and not just a repair: the assertions were testing module *content*, and coupling
that to module *location* was never intended.

Neither category is visible to a specifier resolver, so the gate for every batch
became: typecheck, resolver check, a quoted-basename sweep, and the full suite.

## 4. Gate used per batch

1. `npm run typecheck` — src + client + eval, after proposal A made `eval/` type-checked
2. `node scripts/dev/check-specifiers.mjs` — every relative specifier in `src tests eval bench scripts` must resolve
3. a sweep for `'<moved>.ts'` quoted anywhere, to catch category (b)
4. `npx vitest run` — the full suite, not a subset

Result on the final tree: typecheck green; **1202 passed, 2 failed, 34 skipped**.
Both failures are environmental and fail identically before the migration:
`rc3-plugin-packaging` (stale `lib/` build artifact) and `rc7-inplace-drift`
(installed-DSH drift, 19 rows against a 21-row reference).

## 5. Tooling left behind

- `scripts/dev/relocate-modules.mjs` — the batch planner and rewriter. Resolves
  both endpoints against the pre-move layout, so an importer that moves and a
  target that moves are both handled, and the write phase replays a precomputed
  map rather than re-resolving against a filesystem that has already changed.
- `scripts/dev/check-specifiers.mjs` — the independent resolver check.
- `scripts/dev/repair-specifiers.mjs` — the recovery path for a missed scan list.
- `tests/src-module.ts` — `readSrcModule(name)`, for assertions about module text.

## 6. What this does NOT do

Proposal E — splitting `engine.ts` along its ten responsibilities — is untouched.
It is a semantic change, not a move, and `docs/137` §4 explicitly forbids
bundling it into a move commit. `engine.ts` is now at `src/fold/engine.ts` and
is still the largest unit in the tree.
