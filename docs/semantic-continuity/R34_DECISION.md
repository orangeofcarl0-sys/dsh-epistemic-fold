# R34 — Decision

## Verdict

```text
real-model behavioural benefit:   insufficient evidence (live not executed)
benchmark validity:               acceptable for a live pilot after R33.1
provider status:                  blocked (no authorization/route/budget)
product recommendation:           do not expand the product in R35 before the pilot
```

The instrument is now credible enough to run the pilot; it has not run it.

## The questions, answered honestly

### 1. Does Active show a repeatable behavioural benefit?

**Scripted pipeline: yes, on this dataset.** S succeeds 15/17, B1 7/17. The
paired comparison is 8 rescues, 0 damage. The null-memory control succeeds only
3/17, and O2/F succeed 17/17, so the failures are memory-delivery failures, not
unsolvable tasks.

**Real model: not measured.** No provider request was made. The scripted result
cannot be promoted into a model result.

### 2. Does the benefit come from the Handoff or the Delta?

**Not measured.** The Handoff-Only and Delta-Only ablations belong to R34-C and
require a first live result. The scripted O1−S difference is one rescue (H1),
which is consistent with a structured-delta contribution, but O1 is a
conditional oracle and the difference is exploratory (bootstrap [0, 0.2]).

### 3. Is the Writer the current bottleneck?

**The scripted writer is one bottleneck; the runtime has a second.**

- H1: writer proposes 0 deltas. O1 rescues it, so the downstream path can carry
  the fact.
- F4: 13 rules exceed the 12-delta limit. O1 ALSO fails, so the limit, not the
  writer, is the binding constraint there.

Whether the REAL writer exhibits the H1 omission is exactly what the live
writer-only pilot must measure. It has not run.

### 4. Were false normative claims admitted?

**Not in the scripted runs.** S and O1 have false-normative rate 0.000. The
authority-injection case (F1) produced 2 proposals, 1 accepted, 1 refused
`authority-ungrounded`; the injected constraint never entered state. FM-2 also
refused a tool-grounded normative claim and a fabricated quote.

Real-model false-normative behavior is unmeasured.

### 5. Does the agent retrieve what it needs?

**Not measured.** The live retrieval-trigger experiment requires a real agent.
H1 shows the gap that would trigger it: the checkpoint omits the region fact, the
scripted action guesses, and the hidden check fails. The harness records recall
attempts, success, and whether the retrieved entry is a gold source, but no real
agent has used them. Production `context_search`/`context_recall` was not used.

### 6. Is the extra cost worth it?

**Unknown.** There are 0 live tokens, 0 live attempts, and no price profile. The
scripted accounting path reports 5.81 attempts and 116.2 scripted tokens per
successful task, but those are pipeline numbers, not provider cost.

### 7. Should R35 start, and on what mechanism?

**Not as a product-expansion round.** The next step is the blocked live pilot,
in this order:

1. **Live writer-only** on 4–6 discriminating cases (A1, C1, D1 or D2, F1, H1).
   Measure protocol, exact-claim recall, source support, false normative, scope,
   and real usage. Do not touch the writer prompt after seeing the output; save
   the failure evidence first.
2. **B1/S/O1/O2 continuations** on the same frozen inputs, with the real tool
   loop, hidden checkers, and per-case attribution.
3. **Only then** run Handoff-Only / Delta-Only and the retrieval-trigger arm.
4. **Only if** the live writer shows a coverage failure should R35 modify the
   writer; if F4-type capacity binds, the per-fold delta limit/partitioning is
   the mechanism; if retrieval fails, a gap hint or bounded prefetch is the
   research question — not a new memory subsystem.

No vector database, Experience Bank, MemoryOS, second compaction engine, or
active prefetcher is justified by the current evidence.

## What would change this decision

- A live writer-only run with at least 4 cases and real usage could upgrade
  `insufficient evidence` to positive/negative evidence.
- A live S-vs-B1 run with 12–24 pairs could support a behavioural claim.
- A reproduced H1-type writer omission on the real model would make the writer
  the first R35 target.
- A reproduced F4-type limit would make capacity the first target.

Until one of those exists, the honest status is `insufficient evidence` and the
honest action is to keep the product unchanged.
