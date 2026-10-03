# RC21 — The client face is typechecked, and its contract is pinned

A structural review of this repository found it in good shape — 10,215 lines of
source against 22,007 of tests, no orphan modules, no TODO/FIXME/`@ts-ignore`,
full `strict` with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`,
and a clean `tsc --noEmit`. The review found **one** real concentration of risk,
and this round closes it.

## 1. What was wrong

`client.js` — the browser face — was the only file in the repository that **no
compiler had ever looked at**:

| check | `src/**` | `client.js` |
| --- | --- | --- |
| `tsc` (in `tsconfig.json`) | yes | **no** |
| lint config | — | **none exists** |
| executed by tests | yes | 2 files, via a fake loader |

It is also the file every recent defect round touched (RC13–RC20, 11 of the last
40 commits) and holds the largest single function in the codebase
(`EpistemicFoldPanel`, ~219 lines, 23 ternaries, 22 null-guards). That
correlation is not a coincidence: it was the one place a mistake could not
surface.

## 2. P1 — a second typecheck project

`client.js` cannot join the main project: that one resolves `@deepseek-ai/*`
through a 93-entry path table into the vendored DSH **sources** and compiles
under full `strict`, and a file that `require`s React from the host loader does
not belong in that graph. So it gets its own:

```
tsconfig.client.json      checkJs, strict, allowJs — include: client.js + the shim
client-ambient.d.ts       12 lines: react, react/jsx-runtime, window.__ModuleLoader__
```

The shim declares only the two things the **browser** supplies. React is
deliberately not a dependency of this package — adding it would ship React to a
plugin that merely borrows it.

**Result: 45 errors → 0.** Every one was an annotation gap (`TS7006`×17,
`TS7031`×14, `TS7005`×7, `TS7034`×4, `TS7053`×2, `TS6133`×1) — **no logic
errors**. That is the point: after the annotations land, a real mistake has
somewhere to surface.

The check is wired into `package.json` (`typecheck:client`, `typecheck:all`) and
into **both** CI lanes.

### It found a real (latent) hole

While annotating, the compiler rejected this:

```js
const promptTokens = usage === null ? undefined : usage.uncachedInputTokens + usage.cacheReadTokens
const cacheHit = promptTokens === undefined || promptTokens === 0
  ? undefined
  : usage.cacheReadTokens / promptTokens      // ← 'usage' is possibly 'null'
```

The guard narrowed `promptTokens`, and `usage` was safe only because the two
happen to be undefined together. That is a coincidence, not a guarantee. The
condition now names `usage` directly.

### Destructive verification

Introducing a field typo (`archivedItems` → `archivedItemCount`) now fails:

```
client.js(521,31): error TS2551: Property 'archivedItemCount' does not exist on
type 'FoldStatusView'. Did you mean 'archivedItems'?
```

Before this round, that typo would have rendered a silent `—`.

## 3. P2 — the contract, pinned where the compiler cannot reach

A JS file cannot import `FoldStatusView`, so it carries a `@typedef` that
**mirrors** the host interface. A mirror is the weak part, and this was measured:

> Renaming one view field across all three host sites — the interface, the
> `viewSchema`, and the `view` function — left **all 46** panel and registry
> tests passing.

The panel would render `—` for that row in production, indistinguishable from a
figure that is legitimately unknown.

`tests/panel-contract.spec.ts` closes it by comparing the panel's typedef
against **the host's runtime output** rather than against its declaration —
parsing `FoldStatusView` out of the source would pass on a schema/interface
disagreement, and would also pass if `view()` stopped emitting a declared field.
Driving the real projection and reading `Object.keys` tests what a browser
actually receives.

Four assertions: the top-level key sets match; the panel reads exactly the keys
it declares; the nested `usage` block matches the host split; and the pressure
typedef matches the meter's three fields.

**Verified destructively**: re-applying the same coordinated rename now fails
with an exact diff — `+ "folds"` (what the panel declares) against
`- "leafFolds"` (what the host publishes).

## 4. P4 — a test that was 49 process spawns

Found while investigating an intermittent failure I could not name in the
previous round. It was not flaky:

```
Error: Test timed out in 5000ms.
❯ tests/docs-manifest.spec.ts:101
```

The test called `git cat-file blob HEAD:<path>` once per doc — **49 sequential
subprocess spawns** against vitest's 5000ms default. In isolation it took 4.04s
of test time: passing alone, crossing the limit under the full suite's parallel
load.

`committedBlobs()` now asks for every path in one `git cat-file --batch`
invocation, reading responses by declared size so binary content cannot
desynchronize the stream.

**4.04s → 0.645s**, and the reader still detects a wrong hash (verified by
corrupting one expectation: it named exactly `00_README_EF.md: hash`).

## 5. What was deliberately NOT changed

The review also identified four things that look like debt and are not:

- **`src/basic/*` duplicating `src/policy.ts`** — it is a vendored copy of DSH's
  Basic backend, regenerated by script and guarded by
  `rc7-vendored-basic.spec.ts`. Editing it would break `mode: basic`
  byte-identity.
- **`engine.ts` at 1,131 lines** — 37% comments; largest method 65 lines;
  module fan-in normal. Splitting by line count is surgery without benefit.
- **`status.ts` vs `status-projection.ts`** — two independent surfaces whose
  numbers are *meant* to differ (bundles vs events). Unifying them would destroy
  a documented property.
- **37–54% comment density** — this project's deliberate style, not rot.

P3 (splitting `EpistemicFoldPanel`) was **declined** on evidence: of the last
seven defect rounds only RC19 substantially touched the panel body (31 lines);
the rest were registration wiring. It is a readability preference, not risk
reduction.

## 6. Verification

- `npm run typecheck:all` — both projects clean.
- Full suite: **761 passed, 23 skipped** (63 files, up from 62).
- Four consecutive full runs, all green — the P4 timeout no longer reproduces.
- Live, `zh` deployment: the panel renders identically to before the
  annotations, with no `NaN`/`undefined` leaking into the output.

## 7. Lesson

The repository's discipline was real, and it had a hole exactly where the
discipline stopped — at the boundary the compiler could not see. Every check in
the project pointed at `src/`; the file that broke most often was the one just
outside it.

The contract test is the sharper half of the lesson. Typechecking `client.js`
against a **local mirror** of the host type does not make the mirror correct; it
only makes the panel internally consistent. Comparing the mirror against the
host's runtime output is what makes the two agree, and only that comparison
would have caught the rename that all 46 existing tests missed.
