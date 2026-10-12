# 62 — Extreme memory pressure: task design

Status: **DESIGN**. Nothing here has been built or run. The companion survey
(`61_MEMORY_PRESSURE_BENCHMARK_SURVEY.md`) establishes which components exist; this
fixes what the task is, why each choice was made, and what would show the design is
wrong.

## 1. What this measures, and what it does not

The measured quantity is a **retention curve**: accuracy on a fixed probe set as a
function of compression depth, divided by an uncompressed ceiling.

**It measures a system, not a model.** At probe time the model has never seen the raw
corpus — only what survived compression. The score is therefore the joint result of the
model and the compression policy, and the same model with a better compressor scores
higher. That is the point (the value being tested is whether folding preserves what the
later task needs), but it means a result here must never be read as a model ranking.

**It does not measure retrieval.** No tool is available in the closed-book variant, so
the model cannot go back and look. Anything it answers, it answered from what it kept.

## 2. Why this is not a long-context benchmark

Three differences, each of which removes an escape route:

1. **The corpus is not present at probe time.** Long-context benchmarks place the
   question after the haystack in the same window; here a lossy step sits between them,
   and only its output is visible.
2. **Pressure comes from interference, not length.** A single long document creates
   length. Several projects sharing surface forms create ambiguity, and ambiguity is
   what a summary cannot represent without spending tokens it may not spend.
3. **The question is asked after the loss**, so a correct answer is evidence about what
   survived rather than about what could be found.

## 3. The corpus

**Shape.** About 20 projects. **The corpus is deliberately larger than the model's
window**, because the pressure this task creates comes from compression depth rather than
from context length: a window is bounded at roughly a million tokens, and performance is
already degrading before that bound is reached, so length alone cannot supply extreme
pressure. Ingesting more than can be held, with compression as the only mechanism, can.

**Three properties are load-bearing:**

| property | why |
|---|---|
| projects **share surface forms** (same field names, similar entity names) | a summary that keeps `retry_limit: 5` without keeping *whose* 5 has lost the binding while appearing complete |
| some facts **cross-reference other projects** | a single project's summary is not sufficient, so composition is required |
| documents carry **no project labels or section boundaries** | a boundary is a retrieval index; withholding it is what makes the thread flat (SCALE-QA's critique) |

**Synthesised, not scraped.** Two reasons, both from the survey: contamination (a
published corpus may be in training data) and coherence (a random needle fails the
Controllable Examination requirement that details be semantically connected). Every fact
here is arbitrary in *value* but sits in a coherent project narrative, so it cannot be
recalled from world knowledge and cannot be dismissed as noise.

**Order is randomised per cell.** Position sensitivity is well documented (Lost in the
Middle), so a fixed order would confound project identity with position.

## 4. The compression variable

Compression depth must be an independent variable, and natural pressure cannot supply
one: it depends on the corpus, the threshold and the provider, so the fold count would
vary per cell and no curve could be drawn.

**A `compact` operation is therefore added to the bridge**, so a cell can request exactly
N compressions and receive the engine's counters back. What must be recorded per event:
`folds`, `roots`, `emergencies`, surface tokens before and after, and the node count.
Depth is then a measured quantity rather than a proxy.

Natural pressure is still recorded as a covariate — a cell that folded on its own before
the first requested compaction is not at depth zero, and averaging it with one that did
not would blur the curve.

## 5. The probes

Five kinds, mapped onto the abilities the survey identified in LongMemEval and
MemoryAgentBench. **Disambiguation is the primary instrument**, for a reason worth
stating:

    Aurora    retry_limit = 5
    Borealis  retry_limit = 8

    extraction      "What is Aurora's retry_limit?"      -> 5
    disambiguation  "Which project has retry_limit 8?"   -> Borealis

A lossy summary characteristically **keeps the value and loses the binding**. On an
extraction probe that summary can still guess right half the time; on a disambiguation
probe it cannot. Extraction therefore understates the loss, and disambiguation is where it
shows.

| probe | what a failure means |
|---|---|
| **disambiguation** (primary) | the fact survived but its referent did not |
| extraction | the fact itself did not survive |
| composition across projects | one side survived and the other did not, or the relation did |
| update (a value changed mid-corpus) | the stale value survived instead of the current one |
| abstention (asked about a fact never stated) | the model confabulates rather than declining |

**Distractors are the other projects' real values.** A guesser then lands on a plausible
value rather than an obviously wrong one, so the floor is chance among real candidates
rather than among nonsense.

**Probes are batched into a small number of turns** as a numbered list. One turn per probe
would multiply cost by the probe count, and a multiple-choice form does not need a
conversation. Batching is recorded so a batch-position effect can be checked.

## 6. Arms and controls

### 6.1 The control is REGENERABLE MEMORY, not the absence of compression

The first version of this design used the whole corpus in context as the ceiling. That is
wrong, and the error is worth recording because it is systematic rather than careless.

Writing each condition as information minus load:

    acc(full context) = I(complete)  - L(high)      <- the denominator is DEPRESSED
    acc(compressed)   = I(surviving) - L(low)
    acc(regenerable)  = I(complete)  - L(low)  ~= I(complete)

so `acc(compressed) / acc(full)` divides by a quantity that has already been reduced by
the cost of carrying the context. **The ratio is inflated and the compression loss is
understated** — the load penalty is silently credited to compression as retention.

A window is bounded at roughly a million tokens and performance degrades before that bound,
so "the whole corpus in context" is not a ceiling but **a second damaged condition**.

The control is therefore a **regenerable-memory arm**: the same corpus and the same probes,
with the information available **on demand** rather than held. Both arms then carry a low
load, and the ratio between them isolates information availability alone.

**Two retrieval variants, and only one is a ceiling:**

| variant | what it measures |
|---|---|
| **oracle retrieval** — the harness injects the document a probe needs | the pure information ceiling; the retrieval decision is removed |
| agentic retrieval — the model decides what to fetch | retrieval skill, which is a different ability |

**Oracle retrieval is the control.** Agentic retrieval is worth running later, but as a
measured condition rather than as the denominator, because otherwise a failure to retrieve
would be read as a failure to retain.

### 6.2 The full-context arm is demoted, not deleted

It stays as a **third condition**, because the difference between it and the retrievable
arm is itself the quantity the correction identifies:

    load penalty = acc(regenerable) - acc(full context)

That is the cost of holding context, measured rather than assumed. It is reported, and it
is deliberately **not** used as a denominator.

### 6.3 The factors

| factor | levels | why |
|---|---|---|
| condition | **regenerable (control)**, compressed, full context | see 6.1 |
| compression depth | 1, 3, 5 (the control needs no depth) | locates the breakdown |
| compression mechanism | Basic summarisation vs EF tiers | the actual comparison of interest |
| warning | told a question follows, or not | does *intent* change what survives? |

**The warning factor is not decoration.** A statement in the system prompt reaches the
summariser too, so it may change what the *compressor* chooses to keep, not only what the
model attends to. Those are different effects and the telemetry can separate them (fold
count and summary size differ if the compressor changed behaviour).

**Minimum viable grid** before expanding: regenerable control, plus depth 1 and 5 for
Basic and one EF tier, unwarned — five cells. The full-context arm is added once the first
five separate.

## 7. Scoring

    retention(depth)       = accuracy(depth) / accuracy(regenerable)   <- the headline
    load penalty           = accuracy(regenerable) - accuracy(full context)
    binding loss           = accuracy(extraction) - accuracy(disambiguation)
    confabulation rate     = 1 - accuracy(abstention)
    cost per retained fact = total cost / (probes answered correctly)

`retention` is measured against the **regenerable** arm, never against the full-context
one. `load penalty` is reported separately so the effect the correction identifies stays
visible instead of being absorbed into the headline.

`binding loss` is the second headline. A positive value means facts outlived their
referents, which is the specific damage a token-budgeted summary does and the specific
damage a good folding policy should avoid.

`cost per retained fact` is what makes the result comparable across tiers: a tier that
retains more while spending more has not obviously won, and the existing telemetry
(`costTotal`, `tokensUncachedInput`, `folds`) already supplies both terms.

## 8. Threats to validity

1. **Contamination** — mitigated by synthesis, not provable; a probe the model answers
   before the corpus is fed is a leak signal.
2. **Position** — randomised order; checked by comparing probe batches.
3. **Probe leakage** — a probe can hint at its own answer. Probes are written to name the
   field and the project but never the value.
4. **Compression during probing** — a probe turn can itself trigger a fold, making the
   measured depth larger than the requested one. Folds during phase 2 are recorded and
   reported separately.
5. **Refusal read as failure** — a model that answers "unknown" to everything scores zero
   on extraction and perfect on abstention. The abstention rate is therefore reported
   alongside, never as a substitute.
6. **Chance floor** — with k real distractors the floor is 1/k, so accuracy must be
   reported against that floor, not against zero.
7. **Sample size** — separating 0.9 from 0.7 needs on the order of 60 probes per condition.
   Fewer probes make the curve unreadable, and this constrains the grid.
8. **The control's own competence** — oracle retrieval assumes the injected document
   actually contains the answer. Each injection is validated against the probe's ground
   truth before the arm is scored, or the ceiling is measuring the injection rather than
   the model.
9. **Ingestion order interacts with compression** — which facts are folded first depends on
   arrival order, so two cells with the same depth can retain different facts. Order is
   randomised and the per-probe outcome is kept, not only the aggregate.

## 9. What has to be built

| piece | note |
|---|---|
| corpus generator | 20 projects, shared surface forms, cross-references, no labels, larger than the window |
| probe generator + scorer | five kinds, distractors from other projects, deterministic |
| bridge `compact` operation | makes depth an independent variable |
| oracle-retrieval harness | injects the document each probe needs, validated against ground truth |
| memory-pressure driver | ingests with no tool calls, requests N compressions, asks probes |
| analysis | the retention curve, load penalty, binding loss, cost per retained fact |

**The driver can be a local harness rather than a container task.** Nothing in this design
needs a shell: ingestion appends documents, probing asks questions. The existing
`EpistemicFoldBridge` already speaks to the plugin, so the test reuses the same engine and
the same telemetry as the LHTB lane without a container, a verifier or a reward file.
Packaging it as an LHTB task later is possible but is not on the critical path.

## 10. What would falsify this design

- **Retention near 1.0 at every depth** — the corpus is not hard enough, or the compression
  is lossless at this size. Either way the instrument has no range.
- **Control accuracy near chance** — the probes are unanswerable even with oracle
  retrieval, so nothing downstream can be attributed.
- **Control and depth-1 accuracy indistinguishable** — compression at this corpus size does
  nothing, and depth must be raised before the comparison means anything.
- **Extraction and disambiguation move together** — the binding-loss hypothesis is wrong,
  and extraction is sufficient; the primary metric would then be simpler.
- **The warned and unwarned arms differ only in fold count** — then the warning changed the
  compressor, not the model, and the factor measures policy rather than attention.
- **The load penalty is near zero** — then the full-context arm was a usable ceiling after
  all and the correction, while sound in principle, does not bind at this size. That is a
  result about the model, and it would be reported as one.
