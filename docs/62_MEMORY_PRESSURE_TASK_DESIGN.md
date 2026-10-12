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

### 3.2 Task objective: four content types

The corpus is not twenty interchangeable projects. It is **four content types, five projects
each**, because compression is not type-blind and a single retention number cannot show that.

#### 3.2.1 The hypothesis this tests

Different content has different structure, and a token-budgeted summary destroys structure
unevenly:

| type | what the facts are | what compression most likely destroys |
|---|---|---|
| **coding** | source, APIs, configuration | **exact identifiers** — a summary paraphrases `retry_limit` into "retry limit", and the probe asks for the identifier |
| **execution** | runbooks, deployment steps, escalation paths | **step order** — a summary keeps the steps and loses the sequence |
| **reasoning** | premises, derivations, conclusions | **the chain** — a summary keeps the conclusion and drops the premise it rested on |
| **generation** | requirements, style constraints, templates | **constraints** — a summary keeps the topic and loses the rules |

**This is the sharper claim.** "Retention was 0.62" says how much was kept; "conclusions
survived and premises did not" says **what kind of thing the compressor drops**, which is what
a folding policy can act on. It is also the same axis as the binding-loss hypothesis in
section 5: binding loss should be worst for **coding** (identifiers) and **reasoning**
(premise-to-conclusion links), because those are exactly the structures a fluent summary
discards while still reading well.

#### 3.2.2 Why five per type, not one

    four types x five projects = twenty projects

- five instances inside a type make **within-type variance measurable**, so a type difference
  can be told from project noise
- the type comparison then has n=5 per type rather than n=1
- projects **inside** a type share the schema, which is the interference in 5.1
- projects **across** types share surface forms but not schemas

**Cross-type interference is the strongest kind available**, and it is worth building on
purpose: a coding project defines a configuration field, an execution runbook says to check
"that configuration", and a composition probe then needs both held at once. A summary that
keeps one and paraphrases the other cannot answer it.

#### 3.2.3 The probe taxonomy is orthogonal to the type

    content type (4) x probe kind (5) x compression depth (N)

All five probe kinds (extraction, disambiguation, composition, update, abstention) can be built
against all four content types, so the two factors cross rather than nest. That is what makes
the per-type retention curve computable from the same run, and it is why the corpus needs the
four types rather than more of one.

#### 3.2.4 What this changes downstream

| section | change |
|---|---|
| 3 (corpus) | twenty projects, four types, five each; each type carries its own schema |
| 5 (probes) | every probe is tagged with its type, and every reported retention is **per type** |
| 8 (scoring) | `binding loss` is reported **per type**, because the hypothesis predicts it differs by type |
| 11 (falsification) | if retention is the same across all four types, compression is type-blind and the four-type corpus was unnecessary work |

That last row is the honest cost: the four-type corpus is more work than twenty of one kind, and
it is only worth it if the types separate. The falsifier is written down so the result can say
so.

#### 3.2.5 Sizing

The corpus must exceed what the model can hold, and the window differs per model, so the target
is stated as a multiple rather than an absolute: **at least four times the window of the model
under test**, which for a 131k window is roughly 500k tokens. Twenty projects at ~25k tokens
each reaches it.

#### 3.2.6 The fact schema of each type

Every fact is a tuple, and the four types differ only in the tuple's shape. All four fit the
existing field constructors, so no new grading logic is needed.

| type | tuple | example |
|---|---|---|
| **coding** | `(module, symbol, property) -> value` | `(retry.py, MAX_ATTEMPTS, default) -> 5` |
| **execution** | `(runbook, condition, threshold)` and `(runbook, step_index, action)` | `(P1 runbook, escalate_after_minutes) -> 15` |
| **reasoning** | `(study, premise_id, statement)` and `(study, conclusion, rests_on)` | `(latency study, C2, rests_on) -> P4` |
| **generation** | `(spec, rule, value)` | `(API doc spec, section_order) -> [...]` |

#### 3.2.7 The cross-type links form a closed cycle

This is where the strongest interference comes from, and it is built deliberately:

    coding  --defines a config key-->  execution
       ^                                  |
       |                            cites a threshold
    generation  <--must cite the analysis--  reasoning

| link | the composition probe it makes possible |
|---|---|
| coding -> execution | "the runbook escalates when retries exceed **the configured limit** -- what is it?" |
| execution -> reasoning | "which **premise** justifies the 200 ms threshold?" |
| reasoning -> generation | "which section **must cite** the effect size?" |
| generation -> coding | "which config key **violates** the naming rule?" |

Each needs both sides held at once, so keeping one and paraphrasing the other cannot answer it.

#### 3.2.8 The logical ingestion order is defined by that cycle

A consequence worth stating, because it removes a hand-made decision: the prerequisite relation
for the **logical** order (6.6) is the direction of the cross-type links. Coding's config must
exist before the runbook that cites it.

So the three orders acquire exact meanings:

| order | meaning on this corpus |
|---|---|
| **random** | types interleaved, no structure to exploit |
| **temporal** | blocked by type |
| **logical** | **topological order of the cross-type cycle** -- the cited project enters first |

And because "cited first" means "folded most", the failure mode section 6.6 calls the sharpest --
**the most needed fact decays the most** -- arises here by construction rather than by assertion.

#### 3.2.9 Probe instances for every type and kind

All twenty combinations, so the crossing in 3.2.3 is concrete rather than claimed:

| | coding | execution | reasoning | generation |
|---|---|---|---|---|
| **extraction** | default of `MAX_ATTEMPTS` in `retry.py`? | minutes before a P1 escalates? | effect size in the latency study? | required section order? |
| **disambiguation** | which module defines `MAX_ATTEMPTS = 7`? | which runbook escalates at 15 min? | which study reports 0.31? | which spec requires Overview first? |
| **composition** | the limit the runbook escalates on? | which premise justifies 200 ms? | which premise does C2 rest on? | which config key breaks the naming rule? |
| **update** | what did the errata change it to? | what is the corrected window? | **does C2 still hold after P4 was revised?** | what is the new preferred term? |
| **abstention** | `MAX_RETRIES` in `client.py`? | the P3 escalation window? | effect size in the throughput study? | section order for the runbook doc? |

**The reasoning update probe is the interesting one**: it does not change a value, it revises a
premise and asks whether the conclusion survives. That is a chain-level update, and it is a
different failure from a stale number.

#### 3.2.10 Two hundred probes still fit in one turn

Section 5.3 requires every probe in a single turn, and 200 probes sounds too many for that.
Arithmetic says otherwise: 200 questions at roughly 25 tokens each is about **5,000 tokens of
question**, and one letter per answer is about **400 tokens of reply**.

So the one-turn rule survives the corpus size, and the batch does not have to be split -- which
matters, because splitting it is what would let a fold fall between probes and break the
decoupling of section 7.

#### 3.2.11 The probe count, pinned

    per type      5 projects x 10 probed facts per project = 50 probes
    per project   10 probed facts = 2 probes of each of the five kinds
    per type      10 probes of each kind
    total         4 x 50 = 200 probes

The 30-40 paired observations section 7.5 needs do **not** come from one cell. They come from
the same fact appearing in several cells at different positions (3.1), so a per-cell count of 50
per type is enough to build the curve while the pairing supplies the power.

#### 3.2.12 What a project's documents physically are

Each project is about five documents of roughly 5k tokens, so ~25k per project and ~500k for
twenty -- the sizing 3.2.5 asks for.

| type | documents |
|---|---|
| **coding** | source files, README, CHANGELOG, config |
| **execution** | runbooks, on-call policy, postmortems |
| **reasoning** | analysis notes, data dictionary, memo |
| **generation** | spec, style guide, template |

#### 3.2.13 Abstention probes have nothing to inject

Section 6.4 says the injection covers every document a probe needs. **An abstention probe asks
about a fact that was never stated, so there is no document to inject**, and arm B is empty for
it: `B - A` is undefined.

**Abstention probes are therefore analysed on their own** and excluded from the B/A comparison.
They answer a different question -- whether the model confabulates -- and folding them into a
retention ratio would make one number carry two meanings.

#### 3.2.14 Distractors require a shared schema, and here is how it is built

For a coding disambiguation probe the distractors are **another module's value for the same
symbol**. That only works if every project of a type carries the **same symbol set** with
different values -- which is what "projects share surface forms" (5.1) means concretely.

**So the generator's rule is: one field vocabulary per type, one value set per project.** The
same rule gives execution its thresholds, reasoning its effect sizes and generation its rules.

#### 3.2.15 The answer key reuses the existing format, with one adaptation

The key keeps the shape the workspace already grades:

    { "fields": { "max_attempts_default": { "type": "num", "expected": 5, "criterion": "..." } } }

and `public_spec()` strips `expected`, which is the mechanism that keeps the answers out of
anything the model can read.

**One adaptation is needed.** The existing spec's `depends_on` and `drops` exist to unlock
stages **reactively, one at a time**. This design asks every probe **at once**, so that machinery
is not used for unlocking here. It is used for **corpus assembly** instead -- which document
belongs to which project, and which projects a composition probe links -- so the field stays
meaningful rather than becoming dead weight.

#### 3.2.16 The generator, as an algorithm

    VOCAB = { coding: [...], execution: [...], reasoning: [...], generation: [...] }
    # one field vocabulary per type, so a type's projects are mutually confusable

    for type in TYPES:
        for project in 1..5:
            values = { field: draw(field, rng) for field in VOCAB[type] }
            assert all values in a type are UNIQUE across projects
            documents = render(type, project, values)        # ~5 docs, ~25k tokens
            facts += [ (type, project, field, values[field]) for field in probed ]

    assign cross-links as a ring between adjacent types
    place the errata documents late in the corpus
    reserve some (project, field) pairs as NEVER STATED

**Four constraints in that algorithm are load-bearing, and each was found by asking what would
break the probe rather than by taste:**

1. **Values must be unique within a type.** If two projects share `max_attempts = 5`, a
   disambiguation probe has **two correct answers** and the distractor is not a distractor. The
   generator asserts uniqueness rather than hoping for it.
2. **Every project of a type carries the whole vocabulary.** A distractor is "the same field in
   another project", which only exists if every project has that field. This is what "shared
   schema" (5.1) means operationally.
3. **Some pairs are reserved as never stated.** An abstention probe asks about a fact that does
   not exist, so the generator must **deliberately omit** specific pairs. Without an explicit
   reserve, abstention probes would be accidental and their count unpredictable.
4. **Errata go late.** An update probe needs the stale value to have been **stated earlier**, so
   the correction must arrive after the original. Placing it early makes the "stale" value the
   only one the model ever saw.

#### 3.2.17 The cross-links are a ring, and the count works out

Five projects per type and four link edges give **20 links**, and each link supports a
composition probe **from either side** -- 40 composition probes, which is exactly the 10 per type
that 3.2.11 requires.

The ring is chosen over a random graph for one reason: it is **checkable**. A ring has a known
in-degree and out-degree, so "every project is cited by exactly one other" is an assertion the
generator can make, and a composition probe can never point at a project that does not exist.

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

### 5.4 Compaction is DISABLED for the probe turn

Earlier revisions had the probe turn recorded as "a state change", with any fold in it noted as
a caveat. That is weaker than it needs to be: **the probe measures a state, so it must not
change one.**

Compaction is therefore **switched off for the probe turn in every arm**. The consequence is
that threats 4 and 9 stop being threats -- no fold can fall between probes, and none can fall
before them either -- and section 7's decoupling no longer depends on the batch being small
enough to fit one turn.

It also fixes a problem that was not visible until the injection arms were specified: **injecting
a document adds tokens, and tokens can trigger a fold, which would compress the very document
just injected.** Arms B and C would then be measured on a state the injection itself changed.

Disabling compaction is a measurement choice, not a claim about production, and it is recorded
as one.

#### 5.5 The probe turn's exact form, and how it is parsed

    Answer each question with ONE letter. Reply with exactly 200 lines, "N: X".

    1. What is the default of max_attempts in retry.py?
       A) 3   B) 5   C) 7   D) 9

Parsing is per line against `^(\\d+):\\s*([A-D])`, with a fallback that takes the first
letter of each line. **The fallback matters**: a model that answers in prose still produces
parseable letters, and a parse failure must be recorded as a parse failure rather than silently
scored as wrong -- those are different facts about the run.

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

#### 6.4.1 What "the document a probe needs" means exactly

The injection is **the minimal document set that states the required fact(s)** -- minimal
because injecting the whole project would make arm B trivially easy and blunt the measurement.

| probe kind | injected |
|---|---|
| extraction | the probe's project documents |
| **disambiguation** | **the documents of the project that holds the answer** -- asking "which project has retry_limit 8?" injects the project that has 8 |
| composition | **both linked projects' documents** |
| update | the project's documents **plus the errata** |
| abstention | **nothing** (3.2.13) |

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

#### 6.8.1 The exploration menu needs titles, and the objection does not apply to it

An earlier reading of 6.8 had the store hold documents under **opaque ids only**, on the grounds
that metadata would be an index. That reading is self-defeating: with opaque ids the model
cannot judge what to read, so selection degenerates to random and the arm measures nothing.

**The objection was aimed at the wrong thing.** SCALE-QA's critique is that a corpus **pre-segmented
into topics** hands the model a retrieval index at *probe* time. A menu of titles at *intake* is
not that -- it is how any real reader encounters documents.

**And it does not help at probe time**, which is the point: **the titles are not retained
either.** The model still has to remember which document held what, and that is what the arm
measures.

So the menu shows an **opaque id plus a one-line title**, and the model fetches by id.

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

### 6.11 What "minimal context" means in arm C

Arm C is "a minimal context, plus the same document(s)". Concretely: the system prompt, the
probe turn, and the injected documents. **No corpus, no summaries, nothing else.**

That makes C the pure reading-comprehension ceiling -- can the model answer at all when the
source is in front of it and nothing else is -- which is what the interference term
`B - C` needs as its baseline.

### 6.12 The three ingestion orders ARE the position assignment

Section 3.1 requires the same fact at different positions across cells, and section 7.4 makes
that pairing the source of statistical power. The three ingestion orders supply it directly:

| cell | order | where a given fact lands |
|---|---|---|
| 1 | random | an arbitrary position |
| 2 | temporal | inside its type's block |
| 3 | logical | by its position in the cross-type cycle |

So the pairing is not extra machinery -- **it falls out of a factor the design already has**, and
each fact is observed at three different exposures without a dedicated position sweep.

#### 6.13 The exploration action is a text protocol, not a tool

The proposal says ingestion "does not require a tool call", and the exploration arm should not
quietly reintroduce one. The model emits

    FETCH doc-7f3a

the harness appends that document and marks it consumed, and the loop repeats until the read cap
k is reached. **A text protocol rather than a tool** keeps the difference between the paradigms
about *what the model does*, not about what the harness exposes.

#### 6.14 The cell count, and the arithmetic

The minimum grid (6.10) is seven cells, but ingestion order is a factor **and the pairing in 7.4
comes from it** (6.12), so the orders cannot be dropped:

    7 cells x 3 orders = 21
    minus the floor arm, which does not depend on order = 19

At roughly two hours per cell and eight running concurrently, that is about five hours of wall
clock -- long but feasible, and the number is stated here so the cost is known before the run
rather than discovered during it.

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

### 8.1 Binding loss must be PAIRED, which changes the probe count

Section 8 defines `binding loss = acc(extraction) - acc(disambiguation)`, but as first written
those two probes ask about **different facts**, so the difference is between two independent
samples. That contradicts the design's own principle -- the fact is its own control (7.4) -- and
it throws away the power the pairing exists to provide.

**Every probed fact therefore gets BOTH an extraction probe and a disambiguation probe**, which
makes binding loss a paired comparison on the same fact asked two ways.

The count changes accordingly:

    per type   5 projects x 5 facts            = 25 probed facts
               each fact x 2 (extraction, disambiguation) = 50
               + composition 10 + update 10 + abstention 10 = 30
    per type   80 probes
    total      320 probes

320 questions at roughly 25 tokens each is about 8k tokens of question, so the one-turn rule
(5.3) still holds.

### 8.2 Probes are not independent, and the resampling unit must be the fact

The same fact appears in several cells -- that is what 6.12 buys -- so probe instances **within a
fact are correlated**. Bootstrapping over probes would understate the interval, because the
effective sample size is the number of **facts**, not the number of probes.

**The bootstrap is clustered by fact.** Type comparisons additionally nest fact within project
within type, so the cluster structure is not flat and a naive per-type interval would be too
narrow in exactly the comparison section 3.2 exists for.

### 8.3 The tests, named

| comparison | test | why |
|---|---|---|
| **retention vs exposure** (primary) | **McNemar**, paired by fact, with a cluster bootstrap CI | paired binary outcomes |
| **binding loss** | **McNemar** -- the same fact asked two ways | paired only after 8.1 |
| **difference between types** | mixed-effects logistic with random effects for project and fact, **or** per-type McNemar with **Holm** correction | four comparisons |
| **interference** `B - C` | McNemar, paired by probe | same probes, different arm |

**Multiplicity is handled by pre-registration rather than by correction alone**: the primary
metric is retention per type, everything else is labelled exploratory, and Holm-Bonferroni is
applied within each family.

**And TRACE's `pass^2` is adopted**: every cell is run twice and counts only if it passes both
times. That is the direct answer to the n=1 problem this design would otherwise inherit, and it
costs a factor of two in cells rather than a factor of two in claims.

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

### 10.3 Most of this is already built, in this workspace

Designing the corpus, the probes and the grader from scratch would be a large amount of work
for no benefit, because an existing task in this checkout already implements the pattern and
has been instantiated twice (`apex-law433-matter`, `apex-ib244-matter`).

What `apex-law433-matter` contains:

    70 stages
    292 typed probe fields          bool 177, enum 24, quote 28, num 63
    86 declared drops (38 unique files)
    a frozen 113 KB answer key, an 84 KB single-source generator

| this design needs | where it already exists | what to do |
|---|---|---|
| interference: confusable candidates and decoys | `_build_chain_matter()` builds three documents per chain with decoy rows and three interchangeable candidates | **scale the parameter** |
| typed probes | `B()` `N()` `E()` `Q()` field constructors | reuse as-is |
| answers verified against the SOURCE document | `check_quote` + `load_doc_norm` normalise the cited document and require the quote to appear in it | reuse as-is |
| an answer key separated from the agent-visible spec | `full_spec()` / `public_spec()` | reuse as-is |
| deterministic grading, no LLM judge | `grade.py` + `test_outputs.py`, per-stage breakdown written to `scorecard.json` | reuse as-is |
| one source regenerating every derived artifact | `main()` | reuse as-is |
| **the compression loop, exposure measurement, injection arms** | -- | **build; this is the only genuinely new part** |

**292 fields already exceeds the ~60 probes this design asked for**, and the grader is
deterministic and reports per-stage, which is the per-probe outcome section 7.4 needs.

**The one real gap is scale.** The existing corpus is about 115 KB, which cannot create
extreme pressure. But `_build_chain_matter(n_chains=12)` is parametric, so reaching a corpus
larger than the window is a change of parameter rather than a redesign -- which is what makes
borrowing worth more here than building.

**What borrowing does not remove:** the existing task reveals documents *reactively to an
agent that fetches them*, while this design needs them *pushed* (6.7). The corpus generator
and the grader transfer unchanged; the delivery mechanism does not, and the driver is where
that difference lives.

### 10.4 What the six benchmarks already solved

All six were read in full (README, and where it mattered the harness). Four of them contain
pieces this design would otherwise have had to invent.

**MemoryAgentBench** (ICLR 2026, MIT) already runs the push paradigm and names it:

> "inject once, query multiple times" -- one long text corresponds to multiple questions

Its data is chunked to simulate multi-turn interaction, and its four competencies (Accurate
Retrieval, Test-Time Learning, Long-Range Understanding, **Conflict Resolution**) are a
probe taxonomy. Conflict Resolution is the one this design calls the update probe.

**MemoryCD** (MIT) already implements the arm comparison behind a plug-in interface:

    --method long_context      the long-context baseline
    --method bm25_rag          retrieval

Both sit behind one interface, over one unified JSONL, producing `predictions_*.jsonl` and
`summary_*.json`. That is arms F and the regenerable control, already written. Its data
(Amazon reviews, user personalisation) does not fit this task, but the harness does.

**TRACE** (Nokia, MIT) is the methodology source, and four of its choices apply directly:

| TRACE does | why this design needs it |
|---|---|
| reports `mean(POST) - mean(PRE)` per boundary over the first k post-boundary actions | **the paired pre/post design section 7.4 asks for**, with a horizon parameter |
| marks effects with a **bootstrap 95% CI excluding zero** | an effect size without an interval is what section 7.5 warns about |
| **PRE rollouts are never re-run** -- the control does not depend on the summary | the control arm can be computed once and frozen, which is most of the cost |
| **stratifies evidence boundaries** rather than selecting worst-by-score | selecting the worst by score "skews the failure mix" -- the same error as averaging over exposure in 7.1 |
| **promotes on pass^2** -- run twice, count a task only if it passes both | variance control, and the direct answer to this design's n=1 problem |
| checks reproduction by sha256 against frozen CSVs | the corpus and answer key must be frozen the same way |

Its warning about the proposer is also worth carrying: giving a model measurements makes it
**back-fit a causal story** to them. Any arm here that is shown its own scores mid-run risks
the same.

**LongMemEval** (ICLR 2025, MIT) supplies the five-ability taxonomy -- Information Extraction,
Multi-Session Reasoning, **Knowledge Updates**, Temporal Reasoning, **Abstention** -- and a
caution from its own changelog: a later release "cleaned up the history sessions to prevent
**interference on answer correction**". Update and abstention probes are the ones interference
corrupts first, which is why this design keeps the stale value in the corpus deliberately
rather than accidentally.

**BABILong** (NeurIPS 2024, MIT) supplies a difficulty ladder rather than a single setting: its
20 tasks are tabulated by *facts per task* and *supporting facts per task*, so difficulty is a
declared parameter. This design's depth levels should be calibrated the same way, not chosen by
feel.

**RULER** (MIT) supplies the argument for section 3. Its finding is that models claiming 32k or
more mostly cannot use it, and that "almost all models fall below the threshold before reaching
the claimed context lengths". Length is therefore a poor source of pressure -- which is why
this design puts the pressure in compression depth instead.

**What none of them does**, and why this design still exists:

    MemoryAgentBench   injects once, never compresses
    MemoryCD           compares SELECTION methods, not compression depths
    TRACE              optimises compression, but measures action burden (blocked, refetch),
                       not what the model still knows
    LongMemEval        multi-session, no compression loop
    BABILong, RULER    synthetic length, no compression at all

The gap is unchanged: **compression depth as the independent variable, retention as the
dependent variable, and a regenerable arm as the control.** Four benchmarks supply the harness,
the probes and the statistics; none supplies that comparison.

**The driver is a local harness, not a container task.** Nothing here needs a shell: ingestion
appends documents, probing asks questions. The existing `EpistemicFoldBridge` already speaks to
the plugin, so the test reuses the same engine and telemetry as the LHTB lane without a container,
a verifier or a reward file.

### 10.5 The driver, as a sequence

    for cell in grid:
        bridge.init(system_prompt)                     # minimal (6.9)
        for doc in corpus in cell.order:               # phase 1, ingestion
            bridge.append(user_message(doc))           # no tool call (6.7)
        for i in 1..cell.depth:                        # the independent variable
            bridge.compact()                           # returns mechanism + sizes
        if cell.arm in {B, C}:                         # injection, if any
            bridge.append(user_message(needed_documents(cell.probe)))
        bridge.set_compaction(enabled = False)         # 5.4: measure, do not change
        answers = bridge.step(probe_turn(all_probes))  # phase 2, ONE turn
        score(answers, answer_key)                     # deterministic, no LLM
        record(lineage, exposure, telemetry, cost)

**Three ordering details in that sequence are not arbitrary:**

- **Compaction is requested before the injection.** Otherwise the injection's own tokens could
  be folded, and arm B would be measured on a corpus that includes the answer key's source
  material in compressed form (5.4).
- **Compaction is disabled before the probe turn, not during it.** Disabling it after the first
  probe token would leave a window in which a fold could land.
- **Every document is appended as a user message**, so ingestion is push and requires no tool
  call at all -- which is the paradigm difference 6.7 insists on.

### 10.6 Calibration, as a procedure

Section 8 requires the headline comparison at **matched final size**, and 10.1 says that needs
its own pass. Concretely:

    target = 20% of the ingested surface size          # a ratio, so it survives resizing
    for mechanism in {basic, economy, balanced, quality}:
        sweep depth N upward
        record surface tokens after the Nth compaction
        stop at the smallest N whose size <= target
        that N is the mechanism's depth for the matched-size arms

**The target is a ratio, not an absolute**, for the same reason 3.2.5 states sizing as a
multiple: an absolute target silently stops being matched when the corpus is resized.

**The sweep is recorded, not discarded.** If a mechanism cannot reach the target at any
practical depth, that is itself a finding about the mechanism, and it is reported rather than
hidden by choosing a target it happens to hit.

### 10.7 The analysis, as a table

| what | against what | answers |
|---|---|---|
| retention per type | arm B, at matched size | how much survived, **and whether it differs by content type** |
| binding loss per type | extraction vs disambiguation | whether facts outlived their referents, **worst where predicted** |
| interference | `B - C` | whether the retained summary hurts with the source in hand |
| retention vs exposure | the measured lineage, not the nominal depth | whether compression is what is losing the facts |
| cost per retained fact | `costTotal` / correct | which tier is worth its price |
| confabulation | abstention probes alone | whether the model invents rather than declines |

**The per-type row is the one 3.2 exists for.** If the four types produce one curve, the
four-type corpus was unnecessary and 11 says so.

### 10.8 The telemetry this needs, and which parts are new

    {
      "cell":          { arm, depth, order, mechanism, paradigm, warned },
      "foldLineage":   [ { mechanism, shadowedSeqs, summarySeq,
                           tokensBefore, tokensAfter, phase } ],
      "probeAnswers":  [ { id, factId, kind, raw, parsed } ],
      "injections":    [ { arm, probeIds, docs } ],
      "compactionDisabledAtProbe": true
    }

**`foldLineage` is the only genuinely new capture** (7.2): the bridge reads the engine's
lifetime counters today and does not record `shadowedSeqs` or `summarySeq`, so exposure cannot
be computed without it.

Four per-probe covariates are **derived**, not captured: `exposure`, `lineageDepth`,
`containingSummarySize` and `tokenDistance` (7.2).

**`phase` on each fold event matters**: a fold during ingestion and a fold during probing are
different events, and 5.4 disables compaction for the probe turn precisely so the second should
not occur. If one does, it is visible rather than inferred.

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
