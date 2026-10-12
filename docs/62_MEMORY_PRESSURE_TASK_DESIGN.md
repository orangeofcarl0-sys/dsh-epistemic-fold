# 62 — Extreme memory pressure: task design

Status: **DESIGN**. Nothing here has been built or run. The companion survey
(`61_MEMORY_PRESSURE_BENCHMARK_SURVEY.md`) establishes which components exist; this fixes
what the task is, why each choice was made, and what would show the design is wrong.

This revision is a **consistency pass**. Five earlier revisions each added a section without
re-reading the whole, and the sections ended up contradicting each other — two different arm
lists, a corpus larger than the window alongside an arm that requires the whole corpus in the
window, and a randomisation rule alongside a rule requiring controlled placement. Section 12
records what the review found, because the failure mode is the one this repository keeps
hitting in code: patching an instance instead of re-reading the whole.

## 0. Definitions

Terms are fixed here so the sections below cannot drift apart.

| term | meaning |
|---|---|
| **fact** | one (project, field, value) triple in the corpus. The unit that can be lost. |
| **probe** | one question about one fact. A fact may be probed in several cells. |
| **probe instance** | one probe in one cell. The unit of observation; n counts these. |
| **exposure(f)** | how many folds had fact f inside the shadowed region, by mechanism |
| **ingestion** | phase 1: the corpus enters the context |
| **probing** | phase 2: the questions are asked, in a single turn |
| **cell** | one run: one arm, one corpus, one compression setting |

**Ingestion and probing are the only two phases.** Earlier revisions referred to "phase 2"
without defining it; the names above are now the definitions.

## 1. What this measures, and what it does not

The measured quantity is a **retention curve**: accuracy on a fixed probe set as a function of
compression, relative to a ceiling in which the information is available but the compression
is not.

**It measures a system, not a model.** At probing time the model has never seen the raw corpus
— only what survived compression. The score is the joint result of the model and the
compression policy, and the same model with a better compressor scores higher. That is the
point, but a result here must never be read as a model ranking.

**It does not measure retrieval.** In the push paradigm no tool is available at all, so the
model cannot go back and look. Anything it answers, it answered from what it kept. The
exploration paradigm (6.7) allows one action and measures a different ability; the two are
never pooled.

## 2. Why this is not a long-context benchmark

Three differences, each removing an escape route:

1. **The corpus is not present at probing time.** A long-context benchmark places the question
   after the haystack in the same window; here a lossy step sits between them and only its
   output is visible.
2. **Pressure comes from interference, not length.** A single long document creates length.
   Several projects sharing surface forms create ambiguity, and ambiguity is what a summary
   cannot represent without spending tokens it may not spend.
3. **The question is asked after the loss**, so a correct answer is evidence about what
   survived rather than about what could be found.

## 3. The corpus

**Shape.** About 20 projects, **larger than the model's window**. Pressure comes from
compression depth rather than from length: a window is bounded at roughly a million tokens and
performance is already degrading before that bound, so length alone cannot supply extreme
pressure. Ingesting more than can be held, with compression as the only mechanism, can.

**This has a consequence for the arms, stated here so section 6 cannot contradict it:** a
corpus larger than the window **cannot** be run whole, so there is no full-context arm in the
main experiment. The load penalty is measured in a **separate, smaller experiment** (6.5).

**Three properties are load-bearing:**

| property | why |
|---|---|
| projects **share surface forms** (same field names, similar entity names) | a summary that keeps `retry_limit: 5` without keeping *whose* 5 has lost the binding while appearing complete |
| some facts **cross-reference other projects** | a single project's summary is not sufficient, so composition is required |
| documents carry **no project labels or section boundaries** | a boundary is a retrieval index; withholding it is what makes the thread flat (SCALE-QA's critique) |

**Synthesised, not scraped.** Contamination (a published corpus may be in training data) and
coherence (a random needle fails the Controllable Examination requirement that details be
semantically connected). Every fact is arbitrary in *value* but sits in a coherent project
narrative, so it cannot be recalled from world knowledge and cannot be dismissed as noise.

### 3.1 Placement is designed; everything else is randomised

Earlier revisions said both "order is randomised" and "the same fact is planted at different
positions", which cannot both hold. The reconciliation:

| what | rule |
|---|---|
| **probed facts** | **placed by design**, so positions span the intended range |
| **everything else** | **randomised**, so project identity is not confounded with position |
| **analysis** | uses the **measured** position and exposure, never the intended ones |

Designing the placement of probed facts is what makes the within-fact comparison (7.4)
possible; randomising the rest is what keeps position from being a proxy for project.

## 4. Compression as the independent variable

Compression must be an independent variable, and natural pressure cannot supply one: it depends
on the corpus, the threshold and the provider, so the fold count would vary per cell and no
curve could be drawn.

**A `compact` operation is added to the bridge**, so a cell can request exactly N compressions
and receive the engine's counters back. Recorded per event: mechanism, `folds`, `roots`,
`emergencies`, surface tokens before and after, node count, and the shadowed seq range.

Natural pressure is still recorded as a covariate — a cell that folded on its own before the
first requested compaction is not at depth zero.

## 5. The probes

**Disambiguation is the primary instrument**, for a reason worth stating:

    Aurora    retry_limit = 5
    Borealis  retry_limit = 8

    extraction      "What is Aurora's retry_limit?"      -> 5
    disambiguation  "Which project has retry_limit 8?"   -> Borealis

A lossy summary characteristically **keeps the value and loses the binding**. On an extraction
probe that summary can still guess right half the time; on a disambiguation probe it cannot.
Extraction understates the loss, and disambiguation is where it shows.

| probe | what a failure means |
|---|---|
| **disambiguation** (primary) | the fact survived but its referent did not |
| extraction | the fact itself did not survive |
| composition across projects | one side survived and the other did not, or the relation did |
| update (a value changed mid-corpus) | the stale value survived instead of the current one |
| abstention (asked about a fact never stated) | the model confabulates rather than declining |

### 5.1 How the corpus creates interference

Every project carries the **same schema** with **different values**, so `retry_limit` exists in
all twenty and means something different in each. A summary can record "retry_limit: 5" and be
wrong about which project it belongs to while looking complete.

### 5.2 How the probes are built, and why they are paired

    extraction      "What is Aurora's retry_limit?"       options = every project's retry_limit
    disambiguation  "Which project has retry_limit 8?"    options = project names

**The two have the same option structure**, so they are comparable rather than merely similar,
and the distractors **share the field and differ only in the referent**. That is what makes them
measure binding rather than knowledge.

**The update probe has the strongest distractor available**: the stale value is in the corpus,
so a model that kept the old value does not guess — it selects a wrong answer it has a reason to
believe.

**The abstention probe** asks about a (project, field) pair never stated, with "not stated"
among the options.

**Distractors are the other projects' real values**, so the floor is chance among real candidates
rather than among nonsense.

### 5.3 All probes are asked in ONE turn

Batching probes across turns changes the state between them: answering probe 1 adds tokens,
those tokens can trigger a fold, and probe 2 is then asked at a higher exposure than probe 1.
That would violate the decoupling section 7 exists to establish, so **every probe goes in a
single turn** and no fold can occur between them.

The cost is a long reply and a truncation risk, which the multiple-choice format removes — one
letter per probe — and which the existing reply-budget escalation already handles.

## 6. Arms

### 6.1 The ceiling is REGENERABLE, not uncompressed

The first version used the whole corpus in context as the ceiling. That is wrong, and the error
is worth recording because it is systematic rather than careless. Writing each condition as
information minus load:

    acc(full context) = I(complete)  - L(high)      <- the denominator is DEPRESSED
    acc(compressed)   = I(surviving) - L(low)
    acc(regenerable)  = I(complete)  - L(low)  ~= I(complete)

so `acc(compressed) / acc(full)` divides by a quantity already reduced by the cost of carrying
the context. **The ratio is inflated and the compression loss is understated** — the load
penalty is silently credited to compression as retention.

A window is bounded at roughly a million tokens and performance degrades before that bound, so
"the whole corpus in context" is not a ceiling but **a second damaged condition**.

### 6.2 The arm list

**One authoritative list.** Earlier revisions carried two different ones.

| arm | context at probing time | purpose |
|---|---|---|
| **A — compressed** | the compressed surface, nothing injected | the measurement |
| **B — compressed + injected** | the same compressed surface, plus the document(s) a probe needs | the control: isolates *information availability* with the context held constant |
| **C — clean + injected** | a minimal context, plus the same document(s) | the reading-comprehension ceiling: how much does the retained summary actively hurt? |
| **N — probe only** | the probe, no corpus | the leakage and floor check |

**B is the control for retention**, because it holds the compressed context constant and changes
only whether the information is present. **C is not the control**: it removes the compressed
context as well as adding the document, so it changes two things at once. C exists to measure
interference.

### 6.3 What the arms separate

    B - A = recoverable loss        the fact was gone and re-supplying the source restores it
    B - C = the summary as an INTERFERENT   the source is in hand and the answer is still wrong
    C - A = total loss

**`B - C` is the one a two-arm design cannot see.** A summary reading "retry_limit is 5 or 8"
can keep the model from answering correctly *even when the correct document is placed in front
of it*: the retained text has stopped carrying information and become a distractor. That is
damage from compression alone, with nothing missing.

### 6.4 Injection covers every document a probe needs

A composition probe needs **two** projects' documents, so "the document a probe needs" is a
set, not one file. Each injection is validated against the probe's ground truth before the arm
is scored — an injection that does not contain the answer measures the injection rather than
the model (threat 8).

### 6.5 The full-context arm is a SEPARATE experiment

The corpus is larger than the window (section 3), so it cannot be run whole. The load penalty is
therefore measured in its own experiment on a **reduced corpus that fits**, with the same schema
and the same probes:

    load penalty = acc(B on the reduced corpus) - acc(full context, reduced corpus)

That answers "what does carrying this much cost?" at a size where the question is answerable. It
does **not** answer it for the full corpus, and it is not used as a denominator anywhere.

### 6.6 Ingestion order is a factor

A very long target cannot be ingested at once, so it enters in SOME order, and the order decides
**which facts are folded most often** — therefore which facts the probes are really asking
about.

| mode | exposure profile | what it stresses |
|---|---|---|
| **random** | position independent of importance | the control — no structure to exploit |
| **temporal** | age equals exposure | the natural narrative order; the oldest is folded most |
| **logical** | prerequisites first, so prerequisites are folded most | **the sharpest**: the facts later composition probes DEPEND on are the most decayed |

**Logical order runs first.** The failure mode is "the most needed fact decayed the most", which
is both realistic and invisible to an aggregate score.

### 6.7 Push and exploration are two PARADIGMS, not two modes

Ingestion "does not require a tool call", which is not the same as forbidding one — and
**self-exploration cannot exist under a pure push regime**, because choosing what to read next
is an action. Exploration is therefore **not a fourth ingestion mode**; it is a different
paradigm, and an earlier revision wrongly listed it as one.

| paradigm | ingestion | the ability under test |
|---|---|---|
| **push** (default) | documents are appended; the model acts not at all | **maintenance alone** |
| **exploration** (variant) | the model requests the next document — one minimal action | **intake policy** |

**These are never pooled.** A low score in the exploration arm is evidence about what the model
**chose to read**, not about what it retained; reading it as a retention result would attribute a
selection failure to the compressor.

Exploration must also be **non-regenerable**: with retrieval available the model can read nothing
and fetch later. And a model that reads everything in order is indistinguishable from the
temporal arm, which is itself the finding.

### 6.8 Exploration needs a read cap and a matched-random control

A menu of titles would be an index, and an index is what SCALE-QA says makes the task easier, so
exploration cannot be menu-driven. The store holds N documents under **opaque ids**, the model
may request any **unread** one, and a read consumes it.

**A read cap is mandatory.** If the model can read everything, exploration collapses into the
push arm. With k < N the choice has consequences, and exploration gets its own control:

    random-k       same number of reads, no selection skill
    oracle-k       the harness picks the k most informative documents
    exploration    the model picks

    exploration - random   selection skill
    oracle - exploration   distance from optimal

### 6.9 Three constraints that protect the measurement

1. **No note-taking.** The exploration arm needs a tool call to request a document. If the model
   can also WRITE, it externalises its memory and the test stops measuring retention. Read only;
   no scratchpad, no notes, no files.
2. **A minimal system prompt.** Any instruction to be concise, or to summarise, changes what the
   compressor does and contaminates the independent variable.
3. **A seeded corpus.** Cells are compared by pairing facts across positions; if the corpus
   differs between cells the pairing does not exist.

### 6.10 The factors, and the minimum grid

| factor | levels |
|---|---|
| arm | A (compressed), B (control), C (interference), N (floor) |
| compression depth | 1, 3, 5 |
| compression mechanism | Basic summarisation vs EF tiers |
| ingestion order | random, temporal, logical |
| warning | told a question follows, or not |
| paradigm | push, exploration |

**Minimum viable grid**, before any expansion:

    N  (floor)                     1 cell
    A  depth 1 and 5, Basic        2 cells
    A  depth 1 and 5, one EF tier  2 cells
    B  depth 5, one EF tier        1 cell    <- the control for retention
    C  depth 5, one EF tier        1 cell    <- the interference term
    = 7 cells, push paradigm, logical order, unwarned

Depth 3, the other tiers, the other orders, the warning factor and the exploration paradigm are
added only once these seven separate.

## 7. Per-probe exposure, and decoupling the analysis from it

### 7.1 The defect this fixes

Depth N is a GLOBAL count, and the first version treated it as a property shared by every fact.
It is not:

    P(correct | probe p) = f(exposure(p)),   not f(N)

A fact ingested early is folded repeatedly; one ingested late is folded rarely. Averaging over
probes therefore averages over a distribution that **differs per cell**, and comparing two
ingestion orders compares two exposure distributions rather than two orders. This is a validity
problem, not noise, and more probes do not fix it.

### 7.2 Exposure is measurable

`CompactionResult` carries `shadowedSeqs` and `summarySeq`, so the fold lineage can be
reconstructed:

    fact f  ->  summary s1  ->  summary s2  ->  ...  ->  sk
    exposure(f) = k

**The bridge does not capture these today** — it reads the engine's lifetime counters only — so
recording each fold's `shadowedSeqs` and `summarySeq` is a prerequisite of the measurement, not
an optimisation.

Four per-probe covariates come out of the same structure:

| covariate | why it matters |
|---|---|
| `exposure` | how many times the fact was folded |
| `lineage depth` | how deep in the summary chain it sits |
| **`containing-summary size`** | a fact inside a 50-token summary is likelier intact than one inside a 5-token summary |
| `token distance` | distance from the probe |

### 7.3 Exposure is typed by MECHANISM

The engine compresses three ways and their loss signatures should not be assumed equal: a leaf
fold is local, a root fold is global, and an emergency rebase happens under overflow pressure
inside a live turn and is likeliest to be hasty. "Folded three times by leaves" and "folded once
by a root" are not the same event, so exposure is a vector over mechanisms rather than an
integer.

### 7.4 The analysis is against exposure, not against depth

    retention(k) = P(correct | exposure = k)

and the **fact is its own control**: the same fact is planted at different positions in different
cells (3.1), so the fact is held constant and only its exposure varies.

Three decouplings, in decreasing strength:

1. **Within-fact comparison** — same fact, different exposure, across cells. Strongest, because
   nothing about the fact can confound it.
2. **Stratified comparison** — compare only probes whose exposure matches. Weaker, and it costs
   sample size, but it needs no extra cells.
3. **Covariate-adjusted reporting** — report the exposure distribution beside every aggregate.
   Weakest, but a retention figure without its exposure distribution is uninterpretable, so this
   is a floor rather than an option.

### 7.5 Pairing is where the statistical power comes from

Resolving 0.9 from 0.7 unpaired needs 60-90 **probe instances** per condition at 80% power.
Stratifying by exposure makes it worse: six levels at 60 each is 360.

**The within-fact design is paired, and that is the reason to prefer it.** Detecting the same 0.2
difference with pairing needs on the order of 30-40. The power comes from holding the fact
constant, not from buying more probes.

**Every reported number carries its exposure distribution.**

## 8. Scoring

**The headline comparison is at matched final size, not matched fold count.** Five EF folds and
five Basic summarisations are not the same work: if one reaches 20k and the other 40k, comparing
their retention compares two different amounts of compression. Fold count describes what was
done; **final size is what must be held equal**.

    retention_information = acc(A) / acc(B)      <- the headline; context held constant
    interference          = acc(B) - acc(C)      <- the summary hurting with the source in hand
    recoverable loss      = acc(B) - acc(A)
    total loss            = acc(C) - acc(A)
    binding loss          = acc(extraction) - acc(disambiguation)
    confabulation rate    = 1 - acc(abstention)
    cost per retained fact = total cost / (probes answered correctly)

`retention_information` uses **B**, never C, because B holds the compressed context constant and
changes only whether the information is present. Using C would change two things at once.

`binding loss` is the second headline: a positive value means facts outlived their referents,
which is the specific damage a token-budgeted summary does and the specific damage a good folding
policy should avoid.

`cost per retained fact` is what makes the result comparable across tiers, and the existing
telemetry (`costTotal`, `tokensUncachedInput`, `folds`) already supplies both terms.

## 9. Threats to validity

1. **Contamination** — mitigated by synthesis, not provable. Arm N is the check: a probe the
   model answers with no corpus at all is a leak signal.
2. **Position** — probed facts are placed by design and the rest randomised (3.1); the analysis
   uses measured position, and the same fact appears at several positions across cells.
3. **Probe leakage** — a probe can hint at its own answer. Probes name the field and the project
   but never the value.
4. **Compression during probing** — the probe turn can itself trigger a fold before it is
   answered. All probes are in one turn (5.3) so no fold can fall *between* them, and any fold in
   that turn is recorded.
5. **Refusal read as failure** — a model answering "unknown" to everything scores zero on
   extraction and perfect on abstention. The abstention rate is reported alongside, never as a
   substitute.
6. **Chance floor** — with k real distractors the floor is 1/k, so accuracy is reported against
   that floor, not against zero.
7. **Sample size** — 60-90 probe instances per condition unpaired, 30-40 paired (7.5). If pairing
   is abandoned the grid must shrink to match.
8. **The control's own competence** — an injection that does not contain the answer measures the
   injection. Every injection is validated against the probe's ground truth first (6.4).
9. **The probe turn is a state change** — mitigated by one-turn batching (5.3), recorded
   regardless.
10. **Externalised memory** — any write capability in the exploration arm voids the measurement
    (6.9).
11. **Ingestion order interacts with compression** — which facts fold first depends on arrival
    order, so two cells at the same depth can retain different facts. Per-probe outcomes are
    kept, not only aggregates.
12. **Arm B is not a pure ceiling** — it still contains the compressed context, which may
    interfere. That is why interference is measured as `B - C` rather than assumed zero, and why
    `retention_information` is reported alongside it rather than alone.

## 10. What has to be built

| piece | note |
|---|---|
| corpus generator | 20 projects, shared schema, cross-references, no labels, larger than the window, seeded, able to place a fact at a chosen position |
| probe generator + scorer | five kinds, distractors from other projects, deterministic |
| bridge `compact` operation | makes depth an independent variable |
| **fold-lineage capture** | records each fold's mechanism, `shadowedSeqs` and `summarySeq`; without it exposure cannot be computed |
| injection harness | injects the set of documents a probe needs (6.4), validated against ground truth |
| memory-pressure driver | ingests (phase 1), requests N compressions, probes in one turn (phase 2) |
| analysis | the retention curve, interference, binding loss, cost per retained fact |
| **size calibration** | per mechanism, the fold count that reaches a target surface size (10.1) |
| reduced-corpus run | the separate load-penalty experiment (6.5) |

### 10.1 Matched size needs its own calibration step

"The headline comparison is at matched final size" is a requirement, not a mechanism. It needs a
calibration pass that, for each compression mechanism, finds the fold count reaching the target
surface size. Without it the arms are compared at whatever size they happen to land on, which is
the confound section 8 exists to remove.

### 10.2 The corpus generator, concretely

    schema      a fixed set of field names, shared by every project
    projects    ~20, each a coherent service narrative: config, dependencies, incidents
    values      generated from plausible ranges (retry_limit 2-12, timeouts 5-120s), so they are
                neither recallable from world knowledge nor eliminable as obviously random
    links       some projects name others as dependencies, which composition probes traverse
    seeding     one seed reproduces the corpus exactly, which is what makes pairing possible
    placement   probed facts at designed positions; everything else randomised (3.1)

**The driver is a local harness, not a container task.** Nothing here needs a shell: ingestion
appends documents, probing asks questions. The existing `EpistemicFoldBridge` already speaks to
the plugin, so the test reuses the same engine and telemetry as the LHTB lane without a container,
a verifier or a reward file.

## 11. What would falsify this design

- **Retention near 1.0 at every depth** — the corpus is not hard enough, or compression is
  lossless at this size. Either way the instrument has no range.
- **Arm B near chance** — the probes are unanswerable even with the source injected, so nothing
  downstream can be attributed.
- **B and A indistinguishable at depth 1** — compression at this size does nothing, and depth must
  be raised before the comparison means anything.
- **Extraction and disambiguation move together** — the binding-loss hypothesis is wrong and
  extraction is sufficient; the primary metric would then be simpler.
- **The warned and unwarned arms differ only in fold count** — the warning changed the compressor,
  not the model, and the factor measures policy rather than attention.
- **Exposure does not predict retention** — compression is not what is losing the facts and the
  covariates are decoration. The search would move to the probe design or the corpus.
- **`B - C` is near zero** — the retained summary does not interfere, the interference term can be
  dropped, and retention alone suffices.
- **The load penalty is near zero in the reduced-corpus run** — the original ceiling was usable
  after all at that size. That is a result about the model and is reported as one.

## 12. What the consistency review found

Recorded because the failure mode matters more than the individual fixes.

Five revisions were made in sequence, each adding a section. **Each was locally correct and the
document as a whole was not**, and the result was four genuine contradictions:

| contradiction | resolution |
|---|---|
| two different arm lists (6.3's {regenerable, compressed, full} against 6.4's A/B/C) | one list (6.2), and the retention denominator fixed to B |
| a corpus larger than the window (3) alongside an arm requiring the whole corpus in it (6.2) | the full-context arm moved to a separate reduced-corpus experiment (6.5) |
| "order is randomised" (3) alongside "the same fact at different positions" (7.4) | probed facts placed by design, the rest randomised, analysis uses measured values (3.1) |
| exploration listed as an ingestion mode (6.5) and as a separate paradigm (6.6) | it is a paradigm, never a mode (6.7) |

Four stale passages were also found — text contradicted by a later section and never removed (an
"uncompressed ceiling" in section 1, batch-based probing in sections 5 and 9) — and six terms were
used without definition, now fixed in section 0.

**The fix was a rewrite, not fourteen patches.** Patching is what produced the state, and this
repository has hit the same shape repeatedly in code this session: a correct fix applied to one
instance of a class, leaving the class. The review is recorded here so the next revision starts by
reading the whole document rather than the section it intends to change.
