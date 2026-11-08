# EF-C1 — DSH Compatibility

Status: measured 2026-11-08 in `ef-c1-foundation`. Machine-readable:
`eval/c1/out/dsh-compatibility.json`.

## 1. Three identities, never one

The repository's own documentation says the vendored checkout is `0.2.0-rc.2`.
On this machine it is not.

| Identity | Measured | Source |
|---|---|---|
| declared line | `0.2.0-rc.2` | `package.json` peer ranges and `engines.dsh` |
| installed | `0.2.1-rc.3` | `package-lock.json` → `node_modules` |
| vendored (this machine) | `0.1.7-rc.2` | `vendor/deepseek-harness/package.json` |
| vendored Basic provenance | `dsh-v0.1.7-rc.2` | `src/basic/config.ts` header |
| CI pinned vendor | `0.2.0-rc.2` at `639ed01` | `.github/workflows/ci.yml` (documented, not reproducible here) |

No local lane has all three identities equal:

- **CI pinned lane**: vendor `0.2.0-rc.2` + installed `0.2.1-rc.3`. Vitest
  resolves the vendored source; plain-Node scripts (the live runner) resolve the
  installed package. A mixed lane.
- **Main worktree**: vendor `0.1.7-rc.2` + installed `0.1.7-rc.2`. Internally
  consistent, but on a line the code no longer declares.
- **Research worktrees (R38, C0, C1)**: no vendor + installed `0.2.1-rc.3`.
  Consistent, but the vitest alias table is dead (500 aliases, 0 targets
  present) and every test resolves the installed package.

The fingerprint records the alias state explicitly:

```text
typescript path aliases   500 entries, 0/500 targets present (no vendor tree)
```

A dead alias table is not a silent fallback. It changes which DSH the tests
exercise, and that is the fact this round records.

## 2. API surface

Probed against the installed `0.2.1-rc.3`:

| Surface | Status | Detail |
|---|---|---|
| compaction | available | `CompactionEngine`, `isCompactCheckpointSource` |
| Basic `frameCheckpoint` | absent (by design) | no released DSH ships it; `src/basic` supplies the seam |
| agent | available | `AgentRegistry`; the 0.1.x `Agent` class is gone |
| session | available | `Session`, `SessionStore` |
| tools | available | `ToolRuntime` |
| llm | available | `LlmAdapter`, `LlmRuntime` |
| session projection | available | default export |
| system prompt | available | `SystemPrompt` |

The vendored TypeScript surface is **not** probed here: plain Node cannot import
it. It is covered by `typecheck:src`/`typecheck:eval`, which resolve through the
tsconfig paths. A typecheck pass is not a runtime availability proof, and this
document does not present it as one.

## 3. The 12 failures, by identity

The same 12 tests fail under R38 (`0067020`) and C0 (`327598f`) in a clean
install. They are not one phenomenon.

| # | Test | Error | Class |
|---:|---|---|---|
| 1 | `bridge-loads > runs on the SAME DSH line it typechecks against` | ENOENT `vendor/deepseek-harness/package.json` | environment mismatch |
| 2 | `rc3-plugin-packaging > RC16 … declares the DSH range at engines.dsh` | ENOENT `vendor/…/package.json` | environment mismatch |
| 3-4 | `rc7-vendored-basic > every module is a byte-identical copy` / `span-selection algorithm` | ENOENT `vendor/…/compaction-basic/src/*.ts` | environment mismatch |
| 5-6 | `checkpoint-residency > writes the retirement` / `REFUSES a second retirement` | `TypeError: Receiver must be an instance of class Session` | host API hardening: 0.2.x validates `instanceof Session`; the fixture is a duck-typed fake |
| 7 | `p0-regressions > P0-3 … keeps the raw ef/anchor event` | `'plugin:epistemic-fold/anchor' !== 'ef/anchor'` | known upstream drift: plugin event naming |
| 8 | `persistence-compat > refuses ef/anchor exactly when the host cannot mark it ignorable` | `SessionFormatUnsupportedError` | known upstream drift: 0.2.x session format |
| 9 | `persistence-compat > anchor service durability guard` | `'plugin:epistemic-fold/anchor' !== 'ef/anchor'` | known upstream drift |
| 10 | `plugin-composition > the anchor service refuses a write this host cannot persist` | expected a throw, none thrown | known upstream drift: the host now persists the record |
| 11 | `rc7-inplace-drift > each preset differs ONLY inside the compaction group` | row count 19 vs 22 | generated configuration stale vs installed DSH `0.2.1-rc.3` |
| 12 | `eval-corpus > B04-failure-resolution (hard)` | oracle `failure-retired FAILED: failure failure:call-1` | **eval query bug — fixed in the C1 follow-up** |

Summary:

```text
environment mismatch (no vendor tree)     4
host API hardening / fixture incompatibility 2
known upstream drift                      4
stale generated configuration             1
eval query bug (fixed)                    1
real plugin regression confirmed           0
```

11 remain after the B04 fix (4 + 2 + 4 + 1).

The last row was the only candidate for a product defect, and it is not one.
`eval/src/session-queries.ts` read verified failures by the raw `ef/anchor`
event type. On `0.2.1-rc.3` the plugin-record transport writes
`plugin:epistemic-fold/anchor`, so the eval oracle saw every verified failure as
still open. The production reducer already read both transports
(`efPluginRecordOf`); the query now does too. `tests/eval-corpus.spec.ts`
passes 19/19, and the production code was not changed.

## 4. The undeclared dependency

`tests/r38-native-context.spec.ts` (9 tests) did not collect in C0:

```text
Cannot find package '@deepseek-ai/dsh-agent-loop'
imported from eval/r38/native-context-smoke.mjs
```

`@deepseek-ai/dsh-agent-loop` was present in the R38 worktree's `node_modules`
but absent from `package.json` and `package-lock.json`. R38's 1800-test count
therefore included 9 tests that a clean install cannot reproduce, and
`eval/r38/out/native-context-smoke.json` was produced with an undeclared
package.

EF-C1 declares `@deepseek-ai/dsh-agent-loop@0.2.1-rc.3` as a devDependency. The
9 tests collect and pass again. This is the whole explanation of the 33-vs-24
arithmetic; see `C1_DECISION.md` §B.

## 5. Supported lanes

| Lane | Declared support | Evidence |
|---|---|---|
| CI pinned `0.2.0-rc.2` vendor + `0.2.1-rc.3` install | **supported** (mixed) | CI workflow; not reproducible on this machine |
| Local vendor `0.1.7-rc.2` + install `0.1.7-rc.2` | experimental | main worktree only; the code declares `>=0.2.0-rc.2` |
| No vendor + install `0.2.1-rc.3` | **experimental probe** | R38/C0/C1 worktrees; 12 failures, 4 of them purely missing-vendor |
| DSH master | allowed-to-fail probe | CI `dsh-master` lane |

There is no lane on this machine that is green end-to-end. The closest is the
CI pinned lane, which this round could not reproduce (no network clone of
`639ed01` and no pnpm workspace build).

## 6. What this does not prove

- It does not prove `0.2.0-rc.2` and `0.2.1-rc.3` are behaviorally equivalent.
  The four upstream-drift failures are evidence that they are not.
- It does not prove the vendored `0.1.7-rc.2` tree matches the code's declared
  line. `bridge-loads` says it does not.
- It does not resolve the `eval-corpus` B04 failure by changing production
  code: the failure was in an eval query, and the production reducer was
  already transport-neutral.
- It does not certify a Basic version as "the" Basic; `C1_CORE_BASELINE.md`
  records which object each arm actually loaded.
