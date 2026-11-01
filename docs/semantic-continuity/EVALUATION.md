# Evaluation

> **R31 adds a new evaluation record.** This v3 document's unit counts and
> commit-predicate tests are historical. Current results, including the real
> JSONL process restart and 10/30/100 measurements, are in `R31_EVALUATION.md`.

This document separates six kinds of evidence. They are not interchangeable, and
none of the scripted results is a claim about real-model quality.

## 1. Unit tests

Pure protocol invariants (`tests/semantic-core.spec.ts`, 23 tests):

- writer parsing: handoff + deltas, absent, malformed, fenced JSON;
- evidence: exact match, ambiguity refusal, derived-narrative refusal, minimum
  quote length;
- authority: a constraint grounded in a tool result is refused; a finding
  grounded only in assistant prose is downgraded;
- `verified` scope: the lint-pass/"all concurrency bugs" counterexample is
  refused; a scoped claim with a matching success line is granted; a `verified`
  request without a quote is refused;
- plan: same-coordinate supersession without a redundant retire, cross-coordinate
  retire, duplicate skip, replay idempotency;
- working set: pinned never dropped, overflow reported, omission pointer,
  provenance-scoped changed set, cap with pinned-first ordering;
- temporal render: changed/carried/rationale headings, no `Current` section.

Long-horizon simulation (`tests/semantic-longchain.spec.ts`, 6 tests). Measured
on the pure compile path, `chars/4` pricing, 1,024-token budget:

| folds | last body | working set | omitted | frozen chain total | max body |
|---|---|---|---|---|---|
| 10 | 512 t | 376 t | 0 | 3,125 t (avg 312.5) | — |
| 30 | 1,167 t | 1,030 t | 6 | — | — |
| 100 | 1,176 t | 1,037 t | 90 | 101,659 t (avg 1,016.6) | 1,176 t |

What this shows: the per-fold body saturates at ~1,176 tokens and the latest
revision is the one rendered; the 90 omitted items become a countable retrieval
pointer. What it does NOT show: the frozen chain still grows linearly (101,659 t
over 100 folds). Exit/root rebase is the mechanism for that, and combining them
is the next measured experiment.

## 2. Integration tests

End-to-end through the real engine and projection
(`tests/semantic-continuity.spec.ts`, 5 tests):

- active: stage → commit → activate → the next checkpoint carries the state;
- a coordinate revised across folds keeps only the new value;
- a fold rejected by the shrink check leaves an `abandoned` packet and no state;
- restart with a fresh `Context` and a new engine replays the journal without
  duplicating state;
- shadow's visible checkpoint is byte-identical to `off` (after normalizing the
  random checkpoint id), with exactly one extra recorded call and no journal file.

The real 0.2.1 host API (`tests/semantic-host-0.2.spec.ts`, 5 tests):

- `appendPluginRecord` writes `ignorable: true`; the host's own
  `validateStoredEvents` retains the record;
- EF's reader/guard/projection consume the host record;
- raw `Session.append(..., {ignorable:true})` still drops the marker on this
  build, and the read path refuses an unmarked unknown event — the measurement
  that justifies the transport split.

## 3. Fault-injection tests

Covered by the transaction suite and by existing main-line fault tests:

| Injection | Expected | Verified |
|---|---|---|
| writer failure | state-only body; no packet | `semantic-continuity` writer-failure path |
| shrink rejection | packet abandoned; no state | explicit test |
| surface replacement missing | `archived-only` | classifier unit + journal status |
| crash after commit | restart reconcile activates | restart test |
| duplicate staging | one packet id, replay idempotent | `semantic-core` replay |
| journal write failure | fold aborts before the bundle | by construction (staging precedes bundle) |

The in-flight lock, surface perturbation during summarization, and truncation
retry are covered by main's existing `m0-crash`, `summary-retry`, and
`harness-fold-containment` suites, which remain green.

## 4. Scripted semantic evaluation (pipeline/representation)

`npx vitest run tests/eval-semantic.spec.ts`

```
scenario                        B0   B1   S1   S2   folds(B0/B1/S1/S2)   chars
unanchored-constraint          MISS MISS MISS  ok    3/3/3/3              1782/1843/1843/2028
negative-knowledge             MISS MISS MISS  ok    3/3/3/3              1782/1843/1843/2038
supersession                   MISS MISS MISS  ok    3/3/3/3              1782/1843/1843/1998
validation-boundary            MISS MISS MISS  ok    3/3/3/3              1782/1843/1843/1984
tool-output-injection          ok   ok   ok   ok    3/3/3/3              1782/1843/1843/1792
cross-phase-dependency         MISS MISS MISS  ok    3/3/3/3              1782/1843/1843/2028
resolved: B0=1/6 B1=1/6 S1=1/6 S2=6/6
```

Arms: **B0** native Basic, **B1** EF with semantics off, **S1** shadow, **S2**
active. `folds` counts committed `compaction/end` events per arm (3 each), so no
arm passes with zero folds. `tool-output-injection` is a safety invariant, not a
differentiating scenario: no arm may surface tool text as a user requirement, and
none does.

This measures whether validated semantic state reaches the model-visible text
after several folds and a root rebase. The writer is scripted. It is **not**
evidence that a real model extracts the right deltas or that a real agent behaves
better.

## 5. Real LLM semantic evaluation

**Not executed.** `EF_LIVE` is unset and no provider route/credentials are
configured in this environment. The command that would run it is the existing
live tier:

```bash
EF_LIVE=1 npx vitest run tests/r1-live.spec.ts tests/r1-live-behavior.spec.ts
```

There is no live SEMANTIC arm in this repository yet: the semantic writer is
driven by the compaction purpose, and a live semantic run needs a grader for the
ten briefing scenarios. Marking this `not executed` is deliberate; the scripted
6/6 must not be relabeled as a quality result.

Provider usage: the controlled adapter reports none, so packet `writer.usage`
is absent. That is reported as `unknown`, never as `0`.

## 6. Full suite

Command: `npx vitest run` (vitest 5, Windows).

| run | files | tests | passed | failed | skipped |
|---|---|---|---|---|---|
| baseline (origin/main @ 93b6666), default 5 s timeout | 135 | 1,274 | 1,202 | 7 | 65 |
| final, default 5 s timeout | 141 | 1,324 | 1,252 | 7 | 65 |
| **final, `--testTimeout=20000 --hookTimeout=20000`** | **141** | **1,324** | **1,255** | **4** | **65** |

The 20 s run is the stable measurement on this Windows machine: the default
timeout turns several 1.5-4 s LHTB/hygiene tests into failures under 141
parallel workers. The 5 s runs are reported too, because the difference is
itself evidence about the environment rather than about the code.

The +50 tests are the new suites (10 P0 + 23 core + 5 continuity + 5 host +
6 long-chain + 1 eval). No pre-existing passing test was removed or skipped.

Final failures in the 20 s run, classified:

| Failure | Class | Detail |
|---|---|---|
| `rc3-plugin-packaging` engines.dsh | pre-existing repo inconsistency | package declares `>=0.2.0-rc.2`; vendored runtime is 0.1.7-rc.2. Fails at baseline too. |
| `bridge-loads` "same DSH line" | environment | vendored 0.1.7 vs installed 0.2.1. Fails at baseline too. |
| `rc7-inplace-drift` | environment / generated artifact | `cordis.patch.yml` was generated against a different installed DSH; reverting the install-time regeneration keeps the diff isolated. Fails at baseline too. |
| `task-root-bridge` "Leaf, Leaf, PROTECTED ROOT, Leaf" | flaky under full parallel load | passes when the file is run alone (verified: 52/53 in a four-file isolated run). The bridge reports no captured request under 141 workers. |

Isolation checks performed:

```
npx vitest run tests/rc3-plugin-packaging.spec.ts tests/ef-collect.spec.ts   tests/task-root-bridge.spec.ts tests/release-hygiene.spec.ts --maxWorkers=1
=> 1 failed (the pre-existing engines.dsh mismatch), 52 passed
```

So the only deterministic failures are the three pre-existing
environment/version issues; none is in the semantic path. The semantic gate
(`p0-regressions`, `semantic-core`, `semantic-continuity`, `semantic-host-0.2`,
`semantic-longchain`, `eval-semantic`) is 50/50 green.
