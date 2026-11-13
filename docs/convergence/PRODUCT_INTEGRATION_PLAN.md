# EF-C0 — Product Integration Plan

Status: plan, 2026-11-08. No integration is executed in this round.

## 1. The fact that shapes everything

`origin/main` does **not** contain the semantic layer:

```text
src/semantic/ on origin/main        0 files
src/fold/engine.ts on origin/main   2,137 lines
src/fold/engine.ts on R38           3,716 lines
```

The entire Semantic Continuity track — writer, validator, journal, commit
proof, replay, working set, R38's relation-authorization fix — exists only on
the research line. `origin/main` is the Compression Runtime (Track A) plus the
deterministic state projection and the thermal observer.

So "backport the R38 safety fix to main" is not a cherry-pick. There is nothing
on `main` for the fix to attach to. The real decision is whether Track B becomes
a product candidate at all.

## 2. Two lines, one shared interface

```text
Product line        base = main
  Track A only
  releases from main
  no semantic writer, no journal

Research line       base = verified R38
  Track A + Track B + Track C
  no automatic merge
```

The shared interface is the fold transaction, the bundle/recall contract, the
state projection and the config resolver. Those are stable enough to share.

## 3. Integration paths

### Path A — main stays Track A (recommended now)

No code moves. The research line continues on its own. A product release from
`main` does not carry semantic continuity.

This is the correct default while:

```text
Product-level Evidence   0
R37-B Active             negative contract difference
R38                      mechanism only, 0 live calls
```

### Path B — Track B becomes a product candidate

Only after a bounded behavioral experiment shows a benefit that survives its
own cost. The sequence is fixed:

```text
1. Dependency audit
2. Minimal change selection
3. Focused PR from main
4. Compatibility tests
5. Product gate
```

#### Step 1 — dependency audit

The semantic layer is not self-contained. A port must bring:

```text
src/semantic/*                  the layer
src/fold/engine.ts              the acquisition branch (~1,579 added lines)
src/state/state.ts              anchor vocabulary and reducer
src/state/projection.ts         state projection
src/state/anchor-service.ts     ef/anchor producer
src/config/*                    semanticContinuity, semanticMode, budgets
tests/semantic-*.spec.ts        the transaction and replay suites
```

A port that brings only `plan.ts`/`retirement.ts` would compile against nothing.

#### Step 2 — minimal change selection

Do not cherry-pick individual commits. The R38 fix depends on the planner and
validator rewrite from the same series. Select the smallest **coherent** slice:
the semantic layer at the R38 SHA, with its tests, and nothing from Track C.

#### Step 3 — focused PR

```text
branch   feature/semantic-continuity-candidate
base     main
content  the semantic layer + tests + config, default OFF
```

Default `off` is non-negotiable. A product PR that turns the writer on by
default would ship an unmeasured cost and an unmeasured behavior change.

#### Step 4 — compatibility tests

The port must pass:

```text
core-gate            (see CI_AND_RELEASE_GATES.md)
semantic-gate        validator, journal, commit proof, replay, authority
C1-C7                the boundary contracts
```

and must not change any Track A behavior when continuity is `off`.

#### Step 5 — product gate

The product gate is behavioral, not structural:

```text
frozen manifest + cost ledger + held-out cases + a safety gate
```

R38-M1 is the preregistered shape of such an experiment, but it is on hold and
not authorized. A new manifest would supersede it.

## 4. What must not happen

- **No blind cherry-pick.** A commit that looks safe in isolation may depend on
  a planner rewrite or a test fixture that is not being ported.
- **No default-on semantic writer.** The tier config already makes one rationale
  call per fold; turning on the writer changes cost and behavior.
- **No merge of the research line into main.** It would carry 96 research
  commits, Track C eval code, and generated evidence into the product history.
- **No "it passed mechanism tests, so ship it".** Mechanism certification is the
  entry condition for a behavioral experiment, not a substitute for one.

## 5. Concrete recommendation

```text
now        Path A. main stays Track A.
next       R38-M1 remains on hold. Do not run it without a new manifest,
           a new authorization and a preflight.
if/when    a behavioral experiment shows a net benefit, open Path B with the
           five-step sequence above.
```

## 6. What the product line can do meanwhile

Track A has its own open questions that do not need the semantic layer:

1. Does the fold transaction hold under a longer, more varied workload?
2. Is prefix stability actually realized on the production route, or is the
   cache benefit theoretical?
3. What is the real cost distribution of `economy` with its current rationale
   call, on a frozen task set?
4. Which of the 12 known vendor/DSH-drift failures are product-relevant?

These are cheaper than a semantic experiment and they protect the product
baseline the research line depends on.

## 7. Evidence

```text
docs/convergence/FEATURE_AND_SCOPE_MATRIX.md
docs/convergence/BASELINE_EVIDENCE_REVIEW.md
docs/convergence/REPOSITORY_GOVERNANCE.md
docs/convergence/data/git-stage-map.json
```
