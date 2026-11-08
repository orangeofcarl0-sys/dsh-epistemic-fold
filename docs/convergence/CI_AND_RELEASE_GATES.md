# EF-C0 — CI and Release Gates

Status: proposal, 2026-11-08. No workflow file is modified in this round.

## 1. What CI does today

`.github/workflows/ci.yml`:

```text
push                branches: [main] only
pull_request        any PR
workflow_dispatch   manual
jobs                pinned-dsh (required), dsh-master (continue-on-error)
```

The required job:

```text
checkout plugin
checkout DSH at 639ed01 (0.2.0-rc.2) into vendor/deepseek-harness
pnpm install
build DSH declarations
npm ci
regenerate resolution maps and verify they are current
tsc --noEmit -p tsconfig.json
npm run typecheck:client
npm run typecheck:eval
npx vitest run
npm run eval:keyless
npm run eval:r1
npm run eval:r2
R1 report reproducibility check
R1 live tier (skips without a route)
```

## 2. Three gaps

### Gap 1 — a research branch without a PR gets no CI

`rc38-mechanism-validation` was pushed and no workflow ran, because the push
trigger is `main` only. The `pull_request` trigger would run CI if a PR were
opened, but a research push alone is invisible.

### Gap 2 — the CI vendor tree is a different version from the dev tree

```text
CI vendor checkout     0.2.0-rc.2 (639ed01)
package.json devDeps   0.2.1-rc.3
```

The `vitest.config.ts` aliases `@deepseek-ai/*` to the vendor tree when present.
So CI tests 0.2.0-rc.2 sources while a local run tests 0.2.1-rc.3 packages. The
known vendor/DSH-drift failures are the visible symptom of this mismatch.

### Gap 3 — the required job says nothing about the research rounds

`npx vitest run` runs every test, including research tests, but the job does not
run the R33–R38 evaluation scripts or the mechanism gates. A green CI does not
mean the research evidence still reproduces.

## 3. Known failures

The full suite currently reports 12 failures, all in the pre-existing
vendor/DSH-drift group recorded by R36/R37-B/R37-C. The baseline before R38 had
11; `rc7-inplace-drift.spec.ts` flipped on one run. Both are in the same group.

Classification rule:

```text
known baseline failure   recorded, attributed, not silently skipped
new regression           fails a test that passed at the baseline SHA
environment failure      missing vendor tree, port, credential, or OS path
not executed             skipped or not reached
```

Do **not** delete a failing test to make CI green. Do not mark it `skip` without
a written attribution.

## 4. Proposed gates

Four levels. A release requires the first three; the fourth is informational.

### Core Gate (required, blocking)

```bash
npm run typecheck
npm run build
npx vitest run \
  tests/m0-*.spec.ts tests/m2-*.spec.ts tests/m3a-*.spec.ts \
  tests/ef-*.spec.ts tests/bundle-*.spec.ts tests/recall-*.spec.ts \
  tests/rc0a-*.spec.ts tests/rc7-*.spec.ts \
  tests/convergence-config.spec.ts tests/convergence-boundaries.spec.ts
npm run eval:keyless
```

Covers: build, typecheck, fold transaction, frontier, exact recall, Basic
stand-down, configuration truth, boundary contracts C1–C7.

### Semantic Gate (required when `src/semantic` changed)

```bash
npx vitest run \
  tests/semantic-*.spec.ts \
  tests/r31-*.spec.ts tests/r32-*.spec.ts \
  tests/r38-*.spec.ts \
  tests/convergence-config.spec.ts tests/convergence-boundaries.spec.ts
```

Covers: validator, journal, commit proof, replay, authority, supersession, the
R38 relation-authority and revision-identity suites.

### Research Gate (required for a research milestone, not for a product release)

```bash
npm run eval:r33
npm run eval:r35
npm run eval:r36
npm run eval:r37
npm run eval:r37c
npm run eval:r37d
npm run eval:r38
npm run eval:r38-gates
```

These are offline. They must not call a provider. A gate that would need one is
`not-executed`, not `passed`.

### Compatibility Gate (informational)

```text
pinned DSH 0.2.0-rc.2     required
current DSH 0.2.1-rc.3    required
latest DSH master         continue-on-error
```

The latest probe must never be mixed into release eligibility. A red master
probe is a signal to investigate, not a reason to hold a release built on the
pinned version.

## 5. Workflow changes proposed

```yaml
on:
  push:
    branches: [main, 'research/**', 'feature/**', 'fix/**', 'chore/**']
  pull_request:
  workflow_dispatch:
```

and split the single job into `core-gate`, `semantic-gate` (conditional on
`src/semantic/**` changing), `research-gate` (nightly or manual), and
`compatibility-gate`.

Do not enable branch protection until `core-gate` is stable on `main`; a
protection rule that blocks every PR because of a known vendor failure would be
worse than none.

## 6. Release gates

A release from `main` must satisfy:

```text
1. Core Gate green on the release commit
2. npm run build produces the published lib/
3. npm run preflight passes
4. the tarball contains lib, src, client.js, cordis.patch.yml, docs
5. the compatibility matrix records pinned + current DSH
6. the release notes state which tracks are included
7. no research claim is presented as a product result
```

Release notes template:

```text
Track A (Compression Runtime)   included
Track B (Semantic Continuity)   NOT included on main
Track C (Context Intelligence)  research only
Known failures                  12 vendor/DSH-drift, attributed
```

## 7. What this round changed

Nothing in `.github/`. The proposal is documentation plus the local scripts that
already exist (`eval/c0/*`). Enabling a new workflow is a separate decision with
its own authorization, because it changes what runs on every push.

## 8. Evidence

```text
.github/workflows/ci.yml
package.json
vitest.config.ts
tsconfig.json
tsconfig.eval.json
docs/convergence/data/git-stage-map.json
```
