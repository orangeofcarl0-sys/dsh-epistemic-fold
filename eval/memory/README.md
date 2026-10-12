# Extreme memory pressure

Measures a **system** — a model together with a compression policy — rather than a model. The
design is [docs/62_MEMORY_PRESSURE_TASK_DESIGN.md](../../docs/62_MEMORY_PRESSURE_TASK_DESIGN.md);
this directory is its implementation.

## The one idea worth stating up front

The control is **regenerable memory**, not "no compression". A full-context arm looks like the
ceiling and is not one: with the whole corpus in the window the model must search it, and the
accuracy lost to that search is charged to the *absence* of compression. The denominator shrinks,
retention inflates, and the load penalty is silently credited to compression.

So the ceiling is arm **B** — the same compressed context as arm **A**, plus the documents a probe
needs. Arms **C** (clean context, same documents) and **N** (probe only) supply the interference
term and the floor.

    retention        = acc(A) / acc(B)
    interference     = acc(B) - acc(C)
    recoverable loss = acc(B) - acc(A)

The primary probe is **disambiguation, not extraction**. A lossy summary characteristically keeps
the value and loses the binding; on an extraction probe it still guesses right about half the
time, and on a disambiguation probe it cannot.

## Pipeline

    python build_corpus.py      # regenerates every derived artifact, or fails on a constraint
    bash run-memory.sh --calibrate --arm quality --order logical   # find the depth that reaches 20%
    bash run-memory.sh --mode A --arm quality --order logical --depth 5
    python analyse.py           # the table, and which falsifiers the data triggers

`run-memory.sh` reads the credential from the store, resolves the proxy, and sets the
`x-opencode-session` header the route requires. Run everything through it: a direct invocation
gets a fast HTTP 400 that reads as "the endpoint is fine".

    bash run-memory.sh --check-route   # one question, and the error verbatim

## Files

| file | what it is |
|---|---|
| `build_corpus.py` | the single source of truth; one run regenerates everything below |
| `documents.json` | 100 documents, 20 projects, ~862k tokens |
| `answer_key.json` | 204 probes **with** expected values — the grader reads this |
| `public_probes.json` | the same probes with every answer stripped — a run may see only this |
| `orderings.json` | random, temporal and logical, as explicit sequences |
| `generation_report.json` | the six constraints, checked rather than assumed |
| `run_cell.py` | the driver: ingest, fold to depth, inject, disable compaction, probe, score |
| `score_probes.py` | renders the probe turn and scores a reply; no model involved |
| `analyse.py` | the results table and the falsifier evaluation |
| `check_route.py` | one question to the configured route, with the error verbatim |

## What is checked rather than assumed

The generator **fails** on any of six constraints, because each is a silent corruption that is
invisible in the output:

1. **values unique within a type** — otherwise a disambiguation probe has two correct answers
2. **every project carries the whole vocabulary** — a distractor is the same field elsewhere
3. **the ring is closed and regular** — so a composition probe cannot point at nothing
4. **the orderings actually differ** — `temporal` and `logical` were once byte-identical, which
   would have made two thirds of the position pairing one observation counted twice
5. **filler values are disjoint from probed ones** — a filler figure equal to a probed value puts a
   second candidate in the corpus
6. **every expected answer is stated somewhere** — a probe whose answer is stated nowhere is
   unanswerable by construction, and its failure is indistinguishable from a retention failure

Two more are checked at run time: every injected set must **contain** the answer, and the public
probe file may carry **only** a named set of fields, so a field added later cannot leak.

## Status

Built and unit-verified; **not yet run against a live endpoint.** The provider answered
`HTTP 429 Upstream request failed: Rate limit exceeded` throughout the session in which this was
written. [docs/62 §13.0](../../docs/62_MEMORY_PRESSURE_TASK_DESIGN.md) carries the per-step status.
