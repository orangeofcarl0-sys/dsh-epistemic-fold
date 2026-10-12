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

### 5.1 How the corpus creates interference

Every project carries the **same schema** — the same field names — with **different values**.
`retry_limit` therefore exists in all twenty projects and means something different in each.
That is the interference: a summary can record "retry_limit: 5" and be wrong about which
project it belongs to while looking complete.

### 5.2 How the probes are built, and why they are paired

    extraction      "What is Aurora's retry_limit?"       options = every project's retry_limit
    disambiguation  "Which project has retry_limit 8?"    options = project names

**The two have the same option structure**, so they are comparable rather than merely
similar, and the distractors **share the field and differ only in the referent**. That is
what makes them measure binding rather than knowledge.

**The update probe has the strongest distractor available**: the value it asks about was
changed mid-corpus, so **the stale value is in the corpus**. A model that kept the old value
does not guess — it selects a wrong answer that it has a reason to believe.

**The abstention probe** asks about a (project, field) pair never stated, with "not stated"
among the options.

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

### 6.4 The control is three arms, because the failure has three states

A two-arm design cannot tell "the fact is gone" from "the fact is present and harmful".
Three conditions separate them:

    A = acc(compressed, no injection)
    B = acc(compressed + oracle injection)
    C = acc(clean context + oracle injection)

| difference | meaning |
|---|---|
| `B - A` | **recoverable loss** — the fact was gone, and re-supplying the source restores it |
| **`C - B`** | **the summary as an interferent** — the source is in hand and the answer is still wrong |
| `C - A` | total loss |

**`C - B` is the one a two-arm design cannot see.** A summary reading "retry_limit is 5 or 8"
can keep the model from answering correctly *even when the correct document is placed in
front of it*: the retained text has stopped being a carrier of information and become a
distractor. That is damage caused by compression alone, with nothing missing, and it is
worth separating from loss.

### 6.5 Ingestion order is a factor, not a nuisance

A very long target cannot be ingested at once, so it enters in SOME order. Which order is
not a detail: it decides **which facts are folded most often**, and therefore which facts
the probes are really asking about.

| mode | exposure profile | what it stresses |
|---|---|---|
| **random** | position independent of importance | the control — no structure to exploit |
| **temporal** | age equals exposure | the natural narrative order; the oldest is folded most |
| **logical** | prerequisites first, so prerequisites are folded most | **the sharpest**: the facts later composition probes DEPEND on are the most decayed |
| **self-exploration** (non-regenerable) | chosen by the model | intake policy itself — the model doing its own compression by attention |

**Logical order is the one to run first.** If prerequisites enter first they are folded most
often, and later composition probes need exactly them, so the failure mode is "the most
needed fact decayed the most" — which is both realistic and invisible to an aggregate
score.

### 6.6 Push and exploration are two paradigms, not two settings

The proposal says ingestion "does not require a tool call", which is not the same as
forbidding one — and the distinction matters, because **self-exploration cannot exist under
a pure push regime**. Choosing what to read next is an action.

| paradigm | ingestion | the ability under test |
|---|---|---|
| **push** (default) | documents are appended; the model acts not at all | **maintenance alone** |
| **exploration** (variant) | the model requests the next document — one minimal action | **intake policy** |

**These must never be pooled.** A low score in the exploration arm is evidence about what
the model chose to read, not about what it retained, and reading it as a retention result
would attribute a selection failure to the compressor. The push arm is the one that
measures retention; the exploration arm measures curation.

**Self-exploration must also be non-regenerable**, or it degenerates: with retrieval available,
the model can read nothing and fetch later. Withholding retrieval makes the intake decision
consequential, and a model that reads everything in order is then indistinguishable from
the temporal arm — which is itself the finding.

### 6.7 Exploration needs a read cap and a matched-random control

A menu of titles would be an index, and an index is exactly what SCALE-QA says makes the task
easier, so exploration cannot be menu-driven. The store therefore holds N documents under
**opaque ids**, the model may request any **unread** one, and a read consumes it.

**A read cap is mandatory.** If the model can read everything, exploration collapses into the
push arm and measures nothing. With k < N the choice has consequences.

That gives exploration its own control, and without it "the exploration arm scored low" cannot
be told from "it chose badly":

    random-k       same number of reads, no selection skill
    oracle-k       the harness picks the k most informative documents
    exploration    the model picks

    exploration - random   selection skill
    oracle - exploration   distance from optimal

### 6.8 Three constraints that protect the measurement

1. **No note-taking.** The exploration arm needs a tool call to request a document. If the
   model can also WRITE, it externalises its memory and the test stops measuring retention.
   Read only; no scratchpad, no notes, no files.
2. **A minimal system prompt.** Any instruction to be concise, or to summarise, changes what
   the compressor does and contaminates the independent variable.
3. **A seeded corpus.** Cells are compared by pairing facts across positions; if the corpus
   differs between cells the pairing does not exist.

## 7. Per-probe exposure, and decoupling the analysis from it

### 7.1 The defect this fixes

Depth N is a GLOBAL count, and the first version of this design treated it as a property
shared by every fact. It is not:

    P(correct | probe p) = f(exposure(p)),   not f(N)

    exposure(f) = how many folds had f inside the shadowed region

A fact ingested early is folded repeatedly; one ingested late is folded rarely. Averaging
over probes therefore averages over a distribution that **differs per cell**, and comparing
two ingestion modes compares two different exposure distributions rather than two orders.

This is a validity problem, not noise, and it does not go away with more probes.

### 7.2 Exposure is measurable

`CompactionResult` carries `shadowedSeqs` and `summarySeq`, so the fold lineage can be
reconstructed:

    fact f  ->  summary s1  ->  summary s2  ->  ...  ->  sk
    exposure(f) = k

**The bridge does not capture these today** — it reads the engine's lifetime counters only
— so recording each fold's `shadowedSeqs` and `summarySeq` is a prerequisite of the
measurement, not an optimisation.

Four per-probe covariates come out of the same structure:

| covariate | why it matters |
|---|---|
| `exposure` | how many times the fact was folded |
| `lineage depth` | how deep in the summary chain it sits |
| **`containing-summary size`** | a fact inside a 50-token summary is likelier intact than one inside a 5-token summary |
| `token distance` | distance from the probe |

### 7.3 Exposure is typed by MECHANISM, not just counted

The engine compresses three ways, and their loss signatures should not be assumed equal:

| mechanism | character |
|---|---|
| leaf fold | local — the fact is replaced by a summary of its neighbourhood |
| root fold (idle rebase) | global — the whole surface is rebased |
| emergency rebase | happens under overflow pressure inside a live turn, and is the likeliest to be hasty |

"Folded three times by leaves" and "folded once by a root" are not the same event, so
exposure is a vector over mechanisms rather than an integer. Retention is then reportable by
`(mechanism, count)`, and a difference between mechanisms is a finding about the compressor
rather than about the corpus.

### 7.4 The analysis is against exposure, not against depth

    retention(k) = P(correct | exposure = k)

and the **fact is its own control**: the same probed fact is planted at different positions
in different cells, so the fact is held constant and only its exposure varies. A synthetic
corpus can place a given fact anywhere, which is what makes this possible.

Three further decouplings, in decreasing strength:

1. **Within-fact comparison** — same fact, different exposure, across cells. Strongest,
   because nothing about the fact can confound it.
2. **Stratified comparison** — compare only probes whose exposure matches. Weaker, and it
   costs sample size, but it needs no extra cells.
3. **Covariate-adjusted reporting** — report the exposure distribution beside every
   aggregate. Weakest, but a retention figure without its exposure distribution is
   uninterpretable, so this is a floor rather than an option.

### 7.5 Pairing is where the statistical power comes from

Resolving 0.9 from 0.7 with an unpaired two-proportion test needs roughly 60-90 probes per
condition at 80% power. Stratifying by exposure makes that worse rather than better: six
exposure levels at 60 probes each is 360.

**The within-fact design is paired, and that is the reason to prefer it.** Detecting the same
0.2 difference with pairing needs on the order of 30-40. The power comes from holding the
fact constant, not from buying more probes — which matters because probes are not free and
the grid is already constrained.

**Every reported number carries its exposure distribution.** An aggregate retention figure
alone would be exactly the kind of number this section exists to prevent.

### 7.6 All probes go in ONE turn

Batching probes across turns changes the state between them: answering probe 1 adds tokens,
those tokens can trigger a fold, and probe 2 is then asked at a higher exposure than probe 1.
A batch therefore violates the decoupling section 7 exists to establish.

**All probes are asked in a single turn**, so no fold can occur between them.

The cost is a long reply and a truncation risk, which the multiple-choice format removes —
one letter per probe — and which the existing reply-budget escalation already handles.

## 8. Scoring

**The headline comparison is at matched final size, not at matched fold count.** Five EF
folds and five Basic summarisations are not the same work: if one compresses the surface to
20k and the other to 40k, comparing their retention compares two different amounts of
compression. Fold count describes what was done; **final size is what must be held equal**
before "which compressor is better" means anything.

    retention(size)        = accuracy(at matched final size) / accuracy(regenerable)  <- headline
    retention(depth)       = accuracy(depth) / accuracy(regenerable)                  <- mechanism
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

## 9. Threats to validity

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
7. **Sample size** — separating 0.9 from 0.7 needs 60-90 probes per condition UNPAIRED, and
   stratification by exposure multiplies that by the number of levels. The within-fact design
   is paired and needs 30-40 for the same difference (7.5), which is what keeps the grid
   affordable. If pairing is abandoned the grid must shrink to match.
8. **The control's own competence** — oracle retrieval assumes the injected document
   actually contains the answer. Each injection is validated against the probe's ground
   truth before the arm is scored, or the ceiling is measuring the injection rather than
   the model.
9. **A batch of probes is a state change.** Mitigated by asking all probes in one turn
   (7.6); recorded regardless, since the probe turn itself can fold before it is answered.
10. **Externalised memory.** Any write capability in the exploration arm lets the model keep
    notes instead of retaining, which voids the measurement (6.8).
11. **Ingestion order interacts with compression** — which facts are folded first depends on
   arrival order, so two cells with the same depth can retain different facts. Order is
   randomised and the per-probe outcome is kept, not only the aggregate.

## 10. What has to be built

| piece | note |
|---|---|
| corpus generator | 20 projects, shared surface forms, cross-references, no labels, larger than the window |
| probe generator + scorer | five kinds, distractors from other projects, deterministic |
| bridge `compact` operation | makes depth an independent variable |
| **fold-lineage capture** | records each fold's `shadowedSeqs` and `summarySeq`, without which exposure cannot be computed |
| oracle-retrieval harness | injects the document each probe needs, validated against ground truth |
| memory-pressure driver | ingests with no tool calls, requests N compressions, asks probes |
| analysis | the retention curve, load penalty, binding loss, cost per retained fact |
| **size calibration** | for each mechanism, the fold count that reaches a target surface size |

### 10.1 Matched size needs its own calibration step

"The headline comparison is at matched final size" is a requirement, not a mechanism. It needs
a calibration pass that, for each compression mechanism, finds the fold count that reaches the
target surface size. Without it the arms are compared at whatever size they happen to land on,
which is the confound section 8 exists to remove.

### 10.2 The corpus generator, concretely

    schema      a fixed set of field names, shared by every project
    projects    ~20, each a coherent service narrative: config, dependencies, incidents
    values      generated from plausible ranges (retry_limit 2-12, timeouts 5-120s),
                so they cannot be recalled from world knowledge and cannot be eliminated
                as obviously random
    links       some projects name others as dependencies, which is what composition
                probes traverse
    seeding     one seed reproduces the corpus exactly, which is what makes cross-cell
                pairing possible

The generator must also be able to **place a given fact at a chosen position**, because
section 7.4's within-fact comparison depends on it.

**The driver can be a local harness rather than a container task.** Nothing in this design
needs a shell: ingestion appends documents, probing asks questions. The existing
`EpistemicFoldBridge` already speaks to the plugin, so the test reuses the same engine and
the same telemetry as the LHTB lane without a container, a verifier or a reward file.
Packaging it as an LHTB task later is possible but is not on the critical path.

## 11. What would falsify this design

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
- **Exposure does not predict retention** — then the compression is not what is losing the
  facts, and the per-probe covariates are decoration. That would send the search to the
  probe design or the corpus rather than to the compressor.
- **The load penalty is near zero** — then the full-context arm was a usable ceiling after
  all and the correction, while sound in principle, does not bind at this size. That is a
  result about the model, and it would be reported as one.
