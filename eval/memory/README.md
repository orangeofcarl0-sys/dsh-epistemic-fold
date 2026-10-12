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
| `documents.json` | 100 documents, 20 projects, ~1.81M tokens |
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
| corpus | 100 documents / 20 projects / **1,809,974 tokens** = 13.8x the window |
| background | 94% of it, **19,346 distinct words** (the generated filler had 58) |
| probes | 204 — extraction 80, disambiguation 80, composition 20, update 4, abstention 20 |
| leakage | 204 keyed, 204 public, **0 leaked answers** |
| answer positions | 46 / 43 / 66 / 49 — position carries no signal |
| `analyse.py` | exits 1 with "no result files found" — correct while no cell has run |

### Sizing, and why the background is real text

`EF_MEMORY_WINDOW` defaults to **131,072**, which is the routed model's real window.

    1,809,974 / 131,072 = 13.8x         section 3.2.5 requires >= 4x   -> PASS

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
