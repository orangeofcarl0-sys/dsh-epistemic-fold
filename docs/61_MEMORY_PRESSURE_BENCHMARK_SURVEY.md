# 61 — Extreme memory pressure: what already exists, and what has to be built

Status: **SURVEY**. No task has been designed yet. This records what was checked
against the repositories themselves, what the field's own critiques demand, and the
one axis that no existing benchmark covers.

## 0. The proposed test

Feed a model a large body of multi-project, multi-detail documents — **with no tool
calls**, so the whole burden is cognitive maintenance rather than retrieval — let the
harness compress it repeatedly, and then ask something only a model that retained the
details *across* those compressions can answer.

Two properties make it different from a long-context benchmark. The pressure comes from
**interleaving**, not length: a single long document creates length, while several
projects sharing surface forms create interference. And the question is asked **after**
the compressions, where every existing benchmark asks while the context is still whole.

## 1. Availability, checked against the repositories

Every row below was confirmed by fetching the repository or dataset page, not inferred
from the paper. `web_search` is unavailable in this environment (HTTP 402), so the
finding was done by direct fetch and by the arXiv API; a benchmark with no reachable
artifact cannot be confirmed this way and is marked as such.

| benchmark | artifact | licence | state |
|---|---|---|---|
| **LongMemEval** | `github.com/xiaowu0162/LongMemEval` | MIT | confirmed |
| **RULER** | `github.com/hsiehjackson/RULER` | MIT | confirmed |
| **BABILong** | `github.com/booydar/babilong`, HF `RMT-team/babilong` | MIT | confirmed |
| **TRACE** | `github.com/nokia-applied-research/Trace` | MIT | confirmed |
| **MemoryAgentBench** | `github.com/HUST-AI-HYZ/MemoryAgentBench`, HF `ai-hyz/MemoryAgentBench` | MIT | confirmed |
| **MemoryCD** | `github.com/AgentMemoryWorld/MemoryCD`, HF `WZDavid/MemoryCD` | MIT | confirmed |
| SCALE-QA | none found | paper CC BY 4.0 | **no data link** |
| RECON | `anonymous.4open.science/r/RECON-Bench` | paper CC BY 4.0 | **anonymous, under review** |

**Six are usable and all six are MIT**, which is the permissive case for adaptation.

The two that are not usable are also the two whose *structure* is closest to the
proposal: SCALE-QA for unsegmented mixed-topic threads, RECON for interleaved case
files. SCALE-QA's full text was fetched in both versions and carries **no external
link at all** despite naming a Reproducibility-artifacts section, so its data is not
reachable. RECON states its benchmark and code are at an `anonymous.4open.science`
address, which is a review-period location and cannot be depended on. **Their design
principles are usable; their data is not.**

## 2. What the field says is wrong with its own benchmarks

These are the critiques the benchmarks make of each other, and together they read as a
specification for the proposed test.

### 2.1 A result without a control cannot be attributed

100-LongBench (arXiv 2505.19293) names two shortcomings of real-task long-context
evaluation:

> benchmarks like LongBench often do not provide proper metrics to **separate
> long-context performance from the model's baseline ability** ... such benchmarks are
> usually constructed with **fixed input lengths** ... and fail to reveal **when a model
> begins to break down**.

Both apply directly. Without a no-compression arm, "compression lost it" and "the model
could not do it anyway" are the same number. And the number of compressions has to be a
variable, or there is no curve and no breakdown point.

### 2.2 Synthetic and real inputs fail in opposite ways

A Controllable Examination (arXiv 2506.02921):

> Real-world tasks often involve complexity that makes interpretation challenging and
> **suffer from data contamination**, whereas synthetic tasks frequently **lack
> meaningful coherence between the target information (needle) and its** context.

So the corpus must be synthesised to avoid contamination, and its details must still be
semantically connected to each other. Random needles satisfy the first and fail the
second.

### 2.3 Compression fidelity is not downstream faithfulness

When Less is More (arXiv 2602.09789) reports a **Size-Fidelity Paradox**: increasing
compressor size can **lessen the faithfulness of reconstructed contexts** even though
reconstruction error falls.

This is the reason the evaluation must be a downstream task rather than a summary-quality
metric. A summary that scores well on reconstruction can still have dropped exactly the
detail the later question needs — which is the failure this whole test exists to detect.

### 2.4 Boundaries are a concession

SCALE-QA (arXiv 2608.25655) on the harder regime it targets:

> Existing long-context and memory benchmarks often **expose session or topic
> boundaries** ... These settings **understate a harder assistant-memory regime**: a
> flat mixed-topic thread where the system must infer which earlier episode makes a
> later task decision valid.

Giving the model topic boundaries is giving it a retrieval index. The pressure the
proposal wants requires withholding them.

### 2.5 Existing memory benchmarks are short and scripted

MemoryCD (arXiv 2603.25973): memory benchmarks "remain limited to **short-session
synthetic dialogues**", and existing datasets "rely on **scripted personas**".

### 2.6 Retrieval is the shallow form

RULER (arXiv 2404.06654) on the needle-in-a-haystack test that long-context evaluation
has leaned on: it "is indicative of only a **superficial form** of long-context
understanding".

## 3. The constraints these impose

| # | constraint | source |
|---|---|---|
| 1 | a **no-compression paired arm** is mandatory | 100-LongBench |
| 2 | compression count (or length) must be a **controlled variable** | 100-LongBench |
| 3 | **no session or topic boundaries** in the corpus | SCALE-QA |
| 4 | details must be **semantically connected**, not random needles | Controllable Examination |
| 5 | score the **downstream task**, never summary quality | Size-Fidelity Paradox |
| 6 | the corpus must be **synthesised** to avoid contamination | Controllable Examination, MemoryCD |

## 4. The gap

Three axes, and no single benchmark has all three:

    axis 1  unsegmented multi-topic detail     SCALE-QA, RECON       (data unavailable)
    axis 2  repeated compression cycles        TRACE                 (measures action stability, not memory)
    axis 3  retention measured AFTER them      -- nobody --

Axis 3 is the proposal's actual subject. Every available benchmark asks its question
while the context is intact, or measures whether an agent still behaves after compaction
rather than what it still knows.

## 5. The assembly

Six confirmed benchmarks supply the components; the compression engine already exists
here.

| component | taken from |
|---|---|
| corpus: facts distributed across very long synthetic documents | BABILong |
| corpus: multi-domain interleaved structure | MemoryCD |
| probes: extraction, multi-session reasoning, temporal reasoning, knowledge update, abstention | LongMemEval |
| probes: conflict resolution and test-time learning | MemoryAgentBench |
| transformation: long context into multi-turn increments | MemoryAgentBench's own method |
| attribution: paired closed-loop continuation from one state | TRACE |
| calibration: configurable length to locate the breakdown point | RULER |
| **the compression loop itself** | **this repository's fold mechanism** |

The last row is the part that is not borrowed. Other work can only *truncate* to
simulate compression; this harness compresses for real and counts each event
(`folds`, `roots`, `emergencies`), so compression depth is a measured quantity rather
than a proxy.

## 6. Not verified

- **MemoryAgentBench's and MemoryCD's data contents** — the repositories and licences
  were confirmed, their schemas were not read.
- **Whether LongMemEval's five abilities map cleanly onto the proposed probes** — that
  is a design question, not a lookup.
- **SCALE-QA may publish data later.** The check above is a statement about today.
- **Nothing here has been run.** No cell has executed against any of these datasets;
  this document is a survey and its claims are about artifacts, not measurements.
