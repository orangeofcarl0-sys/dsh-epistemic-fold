# R35 — Decision

## Verdict

```text
R34.1 evaluation integrity closure:   complete
R35 real writer evidence:             blocked / not executed
R35 behavioural evidence:             blocked / not executed
R35 causal (O1/O2/ablation) evidence:  not executed
provider requests:                    0
real-model behavioural benefit:       insufficient evidence
product recommendation:               do not expand EF before the pilot
```

The instrument is now ready for a live writer-only pilot. The pilot has not run
because no explicit spend authorization, resolved route, or budget was supplied.

## Gate status

### G0 — Git and baseline

**Met.** R34 HEAD `8db92f425a35e41bb77158a830de31d5c4874736` is the base of
`rc35-real-semantic-evaluation` in a separate worktree. The primary worktree and
the R30–R34 worktrees are untouched. R34's seven commits and review package are
preserved. The environment is recorded in the review package.

### G1 — Live safety and preflight

**Met offline.** Retry accounting has one authority; the mock `429,429,200` run
reports 3 attempts and 2 retries, not 4. Provider, budget, fold, checker,
harness, and task failures are separate axes. A case that throws keeps the cost
of the requests it made. Writer-only executes the real fold chain and stops.
Preflight runs the real call path, refuses an 8,192-token bound against the
16,384-token writer floor, refuses an insufficient input budget, a total plan
above the request limit, and a reused run directory. It reads no credential and
makes no request. `R33_LIVE` still refuses a live run.

### G2 — Writer evidence

**Blocked.** Zero real writer outputs. The writer-only stage and its evidence
fields are implemented and tested locally, but no provider was called.

### G3 — Behavioural evidence

**Blocked.** Zero real B1/S pairs, tool loops, or hidden checker outcomes. The
scripted 15/17 vs 7/17 remains an offline pipeline control and is not promoted
into a model result.

### G4 — Causal attribution

**Not executed.** O1/O2 and the Handoff-Only/Delta-Only ablations require a first
live result. No causal claim is made.

### G5 — Reproducibility

**Met for local work; not applicable to a live run.** The repo records Git SHA,
dataset digest, scorer version, run ID, case/arm/replicate, writer raw digest,
checkpoint digest, tool trace, usage, and checker outcome in the run directory.
The live run's route and model parameters are recorded in its report manifest.
No live run exists.

### G6 — No architecture expansion

**Met.** No memory architecture was added. The only production-semantic change
is the R33.1 missing-state-witness guard already present at the R34 base. The
writer prompt, journal format, replay, working-set compiler, root/exit lifecycle,
and fold policy are unchanged.

## The question

**Does EF Active beat ordinary history compression on key-knowledge retention,
subsequent task correctness, and total cost?**

**Insufficient evidence.** The real-model experiment was not authorized. The
offline instrument can show that the pipeline delivers a fact and that a hidden
checker can measure a task, but it cannot show what a real writer extracts or how
a real agent behaves.

## What would change this decision

1. A live writer-only pilot on 4–6 cases with real usage would convert
   `insufficient evidence` into positive or negative writer evidence.
2. A live B1/S continuation on the same frozen inputs, with at least 12 valid
   pairs, would support or refute a behavioural claim.
3. A reproduced writer omission would make the writer the first R35 target.
4. A reproduced per-fold capacity limit would make capacity the first target.
5. A real retrieval-trigger failure would justify studying a gap hint or bounded
   prefetch — not a new memory subsystem.

## What not to do

Do not change the writer prompt, gold, hidden checkers, or fold policy before
the first live evidence is saved. Do not start a MemoryOS, vector database,
Experience Bank, knowledge graph, second compaction engine, or active prefetcher
on the current evidence. Do not describe the scripted 15/17 or the mock-provider
tests as real-model results.

## Verification

```text
targeted R33/R34.1/R35 suites:   85 passed (14 files)
full suite:                      1445 passed, 3 failed, 66 skipped
full-suite failures:             3 known installed-vs-vendored DSH drift
typecheck:                       source, client, eval all pass
four-arm scripted self-test:     68/68 functional, 68/68 contract
writer-only scripted self-test:  2/2 valid (A1, S/O1)
preflight example manifest:      12/12 feasible, 0 provider requests
real provider requests:          0
```
