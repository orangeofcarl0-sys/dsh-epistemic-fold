# R38-M0 — Baseline

## 1. Repository

```text
base        7a2c974c479bc1286f172e9f7b203af92e22e629   (R37-D HEAD)
branch      rc38-mechanism-validation
worktree    F:/Codex_Work_Space/DSH plugin/ef-r38-mechanism
```

Created with `git worktree add` from the verified R37-D HEAD. The R37-B/C/D
worktrees were not modified.

```text
R37-B branch   rc37-semantic-action      5ef67814a4ec8fd8bcca362b89ad338acd0a8ae0
R37-C branch   rc37c-measurement-closure 045cccf275132ffda8c76a9fbdc8620338af6164
R37-D branch   rc37d-operational-completion 7a2c974c479bc1286f172e9f7b203af92e22e629
```

## 2. Historical evidence

The R37-B archive still matches:

```text
sha256  de6102989457fba6e5f4c43406478ce91b360f247f2dd462759f252f69de1c92
bytes   3,763,962
```

Digests of the R37-C/D gate, statistics, evidence and pilot artifacts are
recorded in `eval/r38/out/baseline-manifest.json`. No historical output was
rewritten.

## 3. Toolchain

```text
node   v24.14.1
npm    11.11.0
dsh    0.2.1-rc.3 (all @deepseek-ai packages)
```

`@deepseek-ai/dsh-agent-loop` is installed with `--no-save` for the native
smoke. `package.json` is unchanged; no production dependency version was
overridden.

## 4. Build and typecheck

```text
npm ci                          pass
npm run eval:build              pass
npm run typecheck               pass (src, client, eval)
```

## 5. Test baseline

```text
total     1737
passed    1656
failed      11
skipped     70
```

The eleven failures are the pre-existing vendor/DSH-drift set recorded by
R36/R37-B/R37-C:

```text
bridge-loads.spec.ts
checkpoint-residency.spec.ts        (2)
eval-corpus.spec.ts
p0-regressions.spec.ts
persistence-compat.spec.ts          (2)
plugin-composition.spec.ts
rc3-plugin-packaging.spec.ts
rc7-vendored-basic.spec.ts          (2)
```

R37-D reported 1655 passed / 12 failed against the same 1737 total; one of
those failures now passes. No R38 test fails.

## 6. Source digests

`eval/r38/out/baseline-manifest.json` records the SHA-256 of the ten files the
R38 work depends on, including the four production files changed in WP1
(`validate.ts`, `plan.ts`, `types.ts`, `engine.ts`) and the new
`retirement.ts`.

## 7. What changed in production

Only the WP1 safety layer:

```text
src/semantic/retirement.ts   new
src/semantic/plan.ts         authorization, target classification, withholding
src/semantic/validate.ts     revision identity, duplicate-claim handling
src/semantic/types.ts        duplicateClaim, retirement audit
src/fold/engine.ts           record the retirement audit in the packet
```

The selector, recovery, overlay and auditor are eval code. No production
module imports them.

## 8. Evidence

```text
eval/r38/baseline.mjs
eval/r38/out/baseline-manifest.json
eval/r38/out/baseline-tests.json
```
