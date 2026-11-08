# EF-C1 — EF Core Offline Baseline

Status: measured 2026-11-08. Machine-readable:
`eval/c1/out/core-baseline.json` and `eval/c1/out/basic-compatibility.json`.

These are **deterministic mechanism results** under a scripted adapter. No model
was called. They certify what each arm does; they say nothing about how a model
behaves, and no cost claim is made.

## 1. The four arms, as they actually resolved

| Arm | Configuration | What loaded on this machine |
|---|---|---|
| B0 | native Basic | installed `@deepseek-ai/dsh-compaction-basic@0.2.1-rc.3` |
| Bv | EF `mode: basic` | EF's `src/basic`, vendored from `dsh-v0.1.7-rc.2` |
| E0 | `semanticMode: none`, `semanticContinuity: off` | EF engine, zero auxiliary calls |
| E1 | `semanticMode: rationale`, `semanticContinuity: off` | EF engine + visible rationale |

E1 is **not** Semantic Continuity Active. It writes no semantic journal and
commits no delta. The difference between E0 and E1 is one visible rationale
call, nothing else.

Shared policy, frozen for every arm:

```text
thresholdRatio 0.15   headroomTokens 0   retainTokens 300   maxTokens 3000
```

## 2. Measured matrix

| Arm | aux calls | writer | rationale | summary | legal span | checkpoints | checkpoint chars | retained tokens | archive writes | bundled |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---|
| B0 | 1 | 0 | 0 | 1 | 1-10 | 1 | 347 | 104 | 0 | no |
| Bv | 1 | 0 | 0 | 1 | 1-10 | 1 | 347 | 104 | 0 | no |
| E0 | 0 | 0 | 0 | 0 | 1-10 | 1 | 47 | 20 | 2 | yes |
| E1 | 1 | 0 | 1 | 0 | 1-10 | 1 | 67 | 25 | 2 | yes |

Prefix fingerprints:

```text
B0  ee90380c566784229804ae1ac72b2cfc3395683c59b560cd3771e7bee9a19743
Bv  ee90380c566784229804ae1ac72b2cfc3395683c59b560cd3771e7bee9a19743
E0  b2c5bc9c7af5e635d8c917c4b3c94755ef3129452ef0721cb0082e3fd8cb316a
E1  7d50795c8f04007cee8c8666d8d22a5d05a27f1a9249e93db61d261746af7199
```

## 3. What the matrix establishes

### E0 is truly zero-LLM

`calls = 0`. No writer, no rationale, no summary call. The fold still lands:
one checkpoint, one legal span, two archive writes. This is the arm a deployment
can run with no auxiliary model budget.

### E1 adds exactly the rationale

`calls = 1`, and the call is the visible rationale call (`rationaleCalls = 1`,
`writerCalls = 0`). The fold policy is unchanged: same legal span, same surface
node count after the fold. The checkpoint is 20 characters longer and 5 prompt
tokens heavier; that is the rationale text, not a different fold.

### B0 and Bv are the same fold

Same calls, same span, same checkpoint body (347 chars), same prefix
fingerprint, same retained tokens, no EF bundle. On this fixture, EF's
`mode: basic` is indistinguishable from the installed host Basic at the
checkpoint level.

**Caveat.** B0 is `0.2.1-rc.3`; Bv is a copy of `0.1.7-rc.2`. The parity is
therefore a cross-version result on one fixture, not a proof that the two lines
are equivalent in general. `rc7-vendored-basic.spec.ts` is the test that proves
byte identity against the *same* source when the vendor tree is present.

## 4. Basic contract cases

Both B0 and Bv, on the same five cases:

| Case | B0 | Bv |
|---|---|---|
| normal leaf fold | folds, 1 checkpoint, surface 4 → 1 | same |
| tool pair boundary | call and result stay inside the same span | same |
| summary failure | fold fails, 0 checkpoints, surface unchanged | same |
| aborted fold | 0 checkpoints, surface unchanged | same |
| restart | checkpoint readable after event-log reconstruction, same bytes | same |

The summary-failure contract is **containment**, not fallback: Basic's
`compaction/summary-error` waterfall defaults to `false`, so a generic failure
propagates and the span is left intact. A host may register a recovery listener;
that is the listener's contract. The important property is that a failed summary
never replaces the span with a partial one.

## 5. What this does not establish

- It does not establish model behavior. The adapter is scripted.
- It does not establish cost. Token counts are prompt-side estimates, not
  provider billing, and cache read/write is not measured here.
- It does not transfer the historical 1/17 economy claim to E0/E1. That figure
  came from a different configuration and is not a property of this matrix.
- It does not prove `mode: basic` is byte-identical to the host on every input.
  It proves one fixture, plus the source-level identity test when the vendor
  tree exists.
- It does not test Semantic Continuity Active (S0).

## 6. Reproduce

```bash
npx vitest run tests/c1-core-baseline.spec.ts tests/c1-basic-compatibility.spec.ts
# write the machine-readable results (explicit generator mode):
EF_C1_BASELINE_OUT=eval/c1/out EF_C1_BASIC_OUT=eval/c1/out \
  npx vitest run tests/c1-core-baseline.spec.ts tests/c1-basic-compatibility.spec.ts
```
