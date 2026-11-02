# R35 — Decision

## Verdict

```text
R34.1 evaluation integrity closure:   complete
R35 real writer evidence:             executed (3 runs, 16 scored rows)
R35 behavioural evidence:             executed (3 runs; 9 valid complete pairs)
R35 causal (O1/O2/ablation) evidence:  writer + task-stage attribution complete
provider requests:                    34 in writer phase + 578 in continuation
real-model behavioural benefit:       insufficient / negative
product recommendation:               no memory-architecture expansion; fix writer contract and agent process first
```

The writer ran on the real route and produced 16 scored outputs. It extracted
every critical fact in the six-case set at least once, but only 10/16 responses
used the required envelope and only 6/8 gold facts were fully committed. The
continuation ran three replicates; r2 is excluded because its fallback used an
empty checkpoint. Across the 9 valid B1/S pairs (r1 3, r3 6), every pair is
`neither`: no rescue and no damage. The dominant measured bottleneck is the
custom agent's process compliance, not semantic memory delivery.

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

**Met.** Sixteen real writer outputs were scored across three live runs
(5 + 6 + 6 calls; the first run lost one row to a pre-fix fold abort, and its
fifth output is retained as the fold-refusal evidence). Results:

```text
protocol parsed                 10 / 16
gold facts in raw output         8 / 8
gold facts committed (best run)  6 / 8 full, 1 partial, 1 unparsed
false normative accepted         0
verification overclaims refused  2
authority-overreach refused      2
```

The writer is not a coverage bottleneck on this set. The failures are envelope,
status, and kind choices; the validator correctly refused the overclaims and the
tool-grounded normative proposal. The automatic exact scorer reports 0 recall
because the model paraphrases and uses its own coordinates; manual adjudication
against the frozen transcript finds the facts equivalent. Both the automatic
score and the adjudication are preserved.

### G3 — Behavioural evidence

**Executed; no stable Active benefit.** Three continuation runs produced 24 rows
each (r1 has 18 valid because three B1/O2 folds were refused before the
fallback fix). r2 is excluded: its fallback used an empty checkpoint. Across the
9 valid B1/S pairs (r1 3, r3 6), every pair is `neither`: 0 rescue, 0 damage.
Contract success was 3/18 (r1) and 0/24 (r3); process violations dominated. The
scripted 15/17 vs 7/17 remains an offline control and is not promoted.

### G4 — Causal attribution

**Writer stage and task stage: met at the mechanism level.** The
protocol-vs-coverage distinction is established by H1 (correct fact, invalid
envelope, no commit) and by A1/C1/D1 (stable parsed envelopes). The status/kind
distinction is established by C1 (the 12/40 fact refused because the writer chose
`verified` without `verificationQuote` and a `rejected-approach` on tool
evidence). The task-stage attribution is established by the arm matrix: B2 fails
the contract in every arm despite functional success (process), C1 fails
functionality in every arm including O1 (task/agent), and D1 produces false
verification claims in three of four arms (agent). The oracle arms do not
provide a stable advantage, so memory delivery is not the binding constraint on
this dataset.

### G5 — Reproducibility

**Met for the writer runs.** Every writer run records Git SHA, dataset digest,
scorer version, route, model parameters, run ID, replicate ID, per-case raw
writer text and digest, handoff, proposals, refusals, commit status, checkpoint
digest, state digest, observed usage, and wall clock. The raw outputs are stored
in the run directories and the review package. The failed-route runs are
retained separately and are not mixed into the writer results.

### G6 — No architecture expansion

**Met.** No memory architecture was added. The only production-semantic change
is the R33.1 missing-state-witness guard already present at the R34 base. The
writer prompt, journal format, replay, working-set compiler, root/exit lifecycle,
and fold policy are unchanged.

## The question

**Does EF Active beat ordinary history compression on key-knowledge retention,
subsequent task correctness, and total cost?**

**No stable behavioural benefit; no rescue and no damage in the valid pairs.**
The real writer extracted every critical fact in the six-case set at least once,
but 6/16 responses failed the required envelope and only 6/8 gold facts were
fully committed. The continuation ran three replicates; r2 is excluded because
its fallback used an empty checkpoint. Across the 9 valid B1/S pairs, every pair
is `neither`. Contract success was 3/18 in r1 and 0/24 in r3, with process
violations in 12/18 and 22/24. The oracle arms did not provide a stable
advantage either. The binding constraint measured here is the custom agent's
process compliance and task behaviour, not semantic memory delivery.

## What would change this decision

1. A writer-contract fix (envelope, `verified` + `verificationQuote`,
   `rejected-approach` authority) followed by a paired run would separate writer
   protocol effects from agent effects.
2. A process-compliance fix in the agent loop (require a visible test before a
   `verified` finish, and make the finish action honest) would remove the
   dominant confound.
3. A larger paired run with at least 12 valid pairs per arm and family-aware
   analysis would support or refute a behavioural claim.
4. A real retrieval-trigger failure would justify studying a gap hint or bounded
   prefetch — not a new memory subsystem.

## What not to do

Do not change the writer prompt, gold, hidden checkers, or fold policy before the
next paired run; the current outputs are the baseline. Do not start a MemoryOS,
vector database, Experience Bank, knowledge graph, second compaction engine, or
active prefetcher on the current evidence. Do not describe the scripted 15/17 or
the mock-provider tests as real-model results. Do not describe the automatic
exact score of 0 as a writer coverage result; it is a coordinate/paraphrase
mismatch. Do not count the r2 fallback rows as a full-history baseline: their
checkpoint was empty due to a harness defect, and r3 is the authoritative run.

## Verification

```text
targeted R33/R34.1/R35 suites:   94 passed (14 files)
full suite:                      1454 passed, 3 failed, 66 skipped
full-suite failures:             3 known installed-vs-vendored DSH drift
typecheck:                       source, client, eval all pass
four-arm scripted self-test:     68/68 functional, 68/68 contract
writer-only scripted self-test:  2/2 valid (A1, S/O1)
preflight example manifest:      12/12 feasible, 0 provider requests
live writer runs:                17 HTTP attempts, 17 responses, 16 scored rows
live continuation runs:          578 requests over three replicates
live failures:                   0 provider failures in the scored runs
```
