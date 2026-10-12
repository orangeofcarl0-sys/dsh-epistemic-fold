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
    bash run-memory.sh --calibrate --arm quality --order logical   # depth reaching 50% of the window
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
| `build_filler_source.py` | vendors the real-text background, and asserts what must not be in it |
| `filler_source.txt` | the background itself — real documentation prose, used once, never repeated |
| `filler_source_provenance.json` | where the text came from, under which licences, and the narrowed rule |
| `documents.json` | 100 documents, 20 projects — sized from the window, see Sizing |
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
5. **the background names no vocabulary field and carries no numeric probed value** — a field name
   is what binds a value to a fact, and a background figure equal to a probed one puts a second
   candidate in the corpus. *Narrowed from "no probed value at all": twenty of the 86 probed values
   are ordinary English words, so the original rule is unsatisfiable for real prose and unnecessary
   — an unbound word is not a competing answer. The narrowing is recorded in the provenance file
   rather than assumed.*
6. **every expected answer is stated somewhere** — a probe whose answer is stated nowhere is
   unanswerable by construction, and its failure is indistinguishable from a retention failure

Two more are checked at run time: every injected set must **contain** the answer, and the public
probe file may carry **only** a named set of fields, so a field added later cannot leak.

## Status

Built and unit-verified; **not yet run against a live endpoint.** The provider answered
`HTTP 429 Upstream request failed: Rate limit exceeded` throughout the session in which this was
written. [docs/62 §13.0](../../docs/62_MEMORY_PRESSURE_TASK_DESIGN.md) carries the per-step status.

### What was verified without the provider (2026-10-13)

| check | result |
|---|---|
| `build_corpus.py` | exit 0, all six constraints pass |
| regeneration | byte-identical hashes for all five artifacts — the files on disk match the generator |
| corpus | 100 documents / 20 projects / **591,437 tokens** = 4.51x the 131k window |
| background | 94% of it, **19,346 distinct words** (the generated filler had 58) |
| injection | max composition batch 59,150 tokens = 0.45x the window; with a 50% surface, 0.95x |
| probes | 204 — extraction 80, disambiguation 80, composition 20, update 4, abstention 20 |
| leakage | 204 keyed, 204 public, **0 leaked answers** |
| answer positions | 46 / 43 / 66 / 49 — position carries no signal |
| `analyse.py` | exits 1 with "no result files found" — correct while no cell has run |

### Sizing, and why the background is real text

`EF_MEMORY_WINDOW` defaults to **131,072**. The corpus is **derived** from it, because a flat size
cannot serve tiers that differ by an order of magnitude — sized for 131k it is not four times a 1M
window, and sized for 1M it cannot be injected into 131k.

    documents          100        (20 projects x 5)
    doc tokens         ratio * W / 100
    composition batch  10 * doc  = ratio * W / 10     (a composition probe needs two projects)
    at probe           batch + 0.5W = W * (ratio/10 + 0.5)

    fits iff  ratio/10 + 0.5 <= 1   ->   ratio <= 5.0

The floor is 3.2.5's four-times rule, the ceiling is the injection protocol. **Any window in
[4.0, 5.0] works with the same ratio**; 4.5 sits between them with 5% to spare.

| tier | window | per document | corpus | ratio | composition batch | batch + 50% surface |
|---|---|---|---|---|---|---|
| 131K | 131,072 | 5,898 | 589,824 | 4.5x | 58,982 | 124,518 = 0.95x |
| 252K | 258,048 | 11,612 | 1,161,216 | 4.5x | 116,122 | 245,146 = 0.95x |
| 475K | 475,136 | 21,381 | 2,138,112 | 4.5x | 213,811 | 451,379 = 0.95x |
| 1M | 1,048,576 | 47,186 | 4,718,592 | 4.5x | 471,859 | 996,147 = 0.95x |

**The pool bounds which tiers are reachable.** It is 7,233,446 chars, supporting windows up to about
402k. The 475K and 1M tiers need a larger pool, and the generator **refuses** rather than emitting a
corpus too small to be four times its window.

**What a flat size got wrong.** The corpus was briefly a flat 4M tokens. Against a 131k window that
is 30.9x, and every composition batch was 181k — **1.38x the window** — so arm B could not inject at
all and would have measured truncation rather than the model, while every score looked like a
measurement. A corpus is not "as large as possible"; it is as large as the **injection** allows.

**The first background was generated, and it was measured rather than suspected.** 48 sentence
templates over 12 topics: 2,344,000 word tokens drawn from **58 distinct words**, 99.60% of a
4M-token corpus. Deleting every filler line collapsed the corpus to 16,240 tokens — 12.4% of the
window, far below the 50%-of-window calibration target — so fold 1 already overshot the target and
depth 2+ had nothing to do. **The depth axis was dead while appearing alive**, and every number the
calibration produced would have looked like a measurement. Boilerplate creates LENGTH, not
PRESSURE.

The background is now real technical documentation prose, in the **same register as the probed
facts**. Register is the point: background in a different register — literary prose, or source code
— lets a summariser treat the facts as the only real content and keep them, inflating retention.
Source code is included only in a bounded share, for the same reason.

The size follows the **vendored pool**, not a knob. It was briefly an environment variable and that
went wrong in a way worth recording: the default was 25000 while the corpus on disk was 4,044,275,
and because the generator test runs the script with no environment, **every run of the suite
silently shrank the corpus back to 861,697**. Both values are plausible alone; only their
disagreement was wrong. A committed pool removes the failure mode instead of tuning it.

**What was NOT repaired.** A mid-session claim that the corpus was too small compared it against a
**1M-token window belonging to a different model** — the model a separate mistake had wrongly
switched the harness to. Against the window actually under test the corpus was already **6.57x**,
past the four-times rule, and section 3.2.5 had said so. See
[docs/63](../../docs/63_STEP5_RESUME_HANDOFF.md) §8.1.

**Diversity is a test, not a comment.** The old generator's comment claimed its paragraphs "differ
in their subject, their numbers and their phrasing"; the phrasing was byte-identical. That claim is
now pinned by `tests/memory-filler-source.spec.ts`, because a claim about the corpus that nothing
executes can stay false for as long as nobody looks.

### Running it

`python` on this host is the Microsoft Store stub and returns `9009`. Use the harbor venv
interpreter named in `run-memory.sh`; `run-memory.sh` already does.
