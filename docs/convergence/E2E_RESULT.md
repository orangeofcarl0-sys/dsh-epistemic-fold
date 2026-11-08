# EF-E2E — Result

Status: complete. The core campaign (39 cells), the semantic pilot (12 cells)
and the T5b retest (8 cells) all executed. This document reports what the runs
show, what they do NOT show, and what was fixed because of them.

## 1. Headline answers

**1. Can EF Minimal keep quality in real compression tasks and save
resources?** In this setup, partly. E0 uses zero auxiliary calls and the least
input (298,566 tokens over 12 core cells vs 391,224 for B0 and 445,450 for E1),
but it passes 7/12 core cells against 10/12 for both B0 and E1. The loss is
concentrated in exact-recall tasks (T2/T4: 0/4). The archive holds the facts —
E0 recalled correctly in 5 of 12 core cells — but a 47-character checkpoint
marker does not reliably tell the model that recall exists or that it should
write a file after recalling. Two of the four T2/T4 failures had the right
values in the final answer and never wrote the required file.

**2. Does Rationale pay for its extra call?** E1 passes 10/12 core and 2/2 T5b,
with 20 rationale calls and 12,624 output tokens across core (vs B0's 53
summary calls and 43,227 output tokens). On these tasks the rationale is what
carries the exact values into the post-fold context; E0's bare marker does not.
The extra call is cheap relative to Basic's summarization, but the comparison
is not powered to call it a product gain.

**3. Does Semantic Active, after the authority fix, show a behavioural signal
worth pursuing?** Not in this pilot. S-safe passes 4/6 pilot cells against E1's
3/6, and 2/2 in the T5b retest against E1's 2/2. The one pilot difference is a
T2 cell where E1 narrated the right values without writing the file. On T3 and
T5 the two arms are indistinguishable at two replicates each. S costs about 40%
more input in the pilot (163,541 vs 116,997). There is no signal here that
would justify changing the default.

**4. Which failures are compression, which are host/tools/config/eval?** The
large majority of failures in this round are task-contract or
instruction-following, not memory: nested-but-correct answers (T5), correct
values never written to a file (T2/T4), one hidden-edge test failure (T1 B0),
and one step-limit. Only the E0 T2/T4 failures combine a real recall question
with a real output miss. The environment failures were found and fixed before
the campaigns (preset reference, native-smoke output pollution).

## 2. What ran

```text
campaign          cells  executed  requests  input tokens  output tokens  wall
e2e-core-1           39        39       259     1,214,580         69,166   12.4 min
e2e-pilot-1          12        12        77       280,538         15,955    3.6 min
e2e-t5-retest-1       8         8        62       288,422         16,010    3.0 min
total                59        59       398     1,783,540        101,131   18.9 min
```

Envelope used: 398 / 2,200 requests, 1.78M / 18M input, 101k / 1M output,
18.9 min / 8 h. No monetary claim: the route has no verifiable per-token price.

All 59 cells reached at least one successful fold. No cell is `no-fold`.

## 3. Core campaign (36 core cells + 3 calibration)

Core-only, excluding the calibration block:

| Arm | Pass | Requests | Aux calls | Input | Output | Folds | Recall calls |
|---|---|---|---|---|---|---|---|
| B0 | 10/12 | 102 | 53 (summary) | 391,224 | 43,227 | 32 | 0 |
| E0 | 7/12 | 67 | 0 | 298,566 | 7,280 | 27 | 25 |
| E1 | 10/12 | 68 | 20 (rationale) | 445,450 | 12,624 | 20 | 0 |

Per template (core cells only):

| Template | B0 | E0 | E1 |
|---|---|---|---|
| T1 implementation | 2/2 | 2/2 | 2/2 |
| T2 exact recall | 2/2 | 0/2 | 2/2 |
| T3 decision revision | 2/2 | 2/2 | 2/2 |
| T4 tool dependency | 2/2 | 0/2 | 2/2 |
| T5 multi-fold | 0/2 | 1/2 | 0/2 |
| T6 cache pressure | 2/2 | 2/2 | 2/2 |

The calibration block (T1-s1, three arms) is excluded from these rates. Its B0
cell failed the hidden `max = 0` case; E0 and E1 passed.

### Failure classes (core)

| Class | B0 | E0 | E1 |
|---|---|---|---|
| tests fail | 0 | 0 | 0 |
| missing output file | 0 | 3 | 0 |
| shape mismatch (values present) | 1 | 1 | 2 |
| wrong value | 0 | 0 | 0 |
| step limit / other | 0 | 0 | 0 |

The T5 shape mismatch is a task-contract defect: every arm wrote
`{"batch":{"max_attempts":2,"window_seconds":30}}` while the checker required a
flat object. It is not evidence about memory. T5b states the shape explicitly.

## 4. T5b retest (explicit shape)

| Arm | Pass | Requests | Aux | Input | Output |
|---|---|---|---|---|---|
| B0 | 2/2 | 18 | 10 | 79,623 | 9,533 |
| E0 | 1/2 | 18 | 0 | 102,233 | 1,761 |
| E1 | 2/2 | 14 | 4 | 51,563 | 2,304 |
| S | 2/2 | 12 | 4 | 55,003 | 2,412 |

With the shape stated, the multi-fold task is solvable by every arm. E0's
second seed ran to the step limit after seven recall calls and still produced a
shape-mismatched answer; its first seed passed with three recall calls.

## 5. Semantic pilot (E1 vs S-safe, contemporaneous)

| Arm | Pass | Requests | Aux | Input | Output | Recall calls |
|---|---|---|---|---|---|---|
| E1 | 3/6 | 33 | 10 | 116,997 | 7,013 | 0 |
| S | 4/6 | 44 | 12 | 163,541 | 8,942 | 3 |

Per task:

| Task | E1 | S |
|---|---|---|
| T2 exact recall | 1/2 (one missing output) | 2/2 |
| T3 decision revision | 2/2 | 2/2 |
| T5 multi-fold (shape defect) | 0/2 | 0/2 |

The S checkpoint carries the semantic state (objective/evidence lines); the E1
checkpoint carries the rationale. Both carried the T2 values. The difference is
one output-file behaviour, not a memory effect.

## 6. Semantic authority

### The defect

`decision` is grounded by both `user/message` and `assistant/message`, and the
anchor recorded only the domain. An assistant-origin decision therefore had the
user's retirement standing. Two paths reached it:

1. **explicit `supersedes`** naming the user's anchor — equal ranks passed;
2. **`supersedes: ['previous']` at the same coordinate** — `mayRetire` was
   skipped entirely, because the coordinate was treated as the permission.

### The fix

An anchor now records `sourceAuthority` (`user`, `system`, `tool`, `assistant`,
or `unknown` for historical anchors). An assistant-origin decision may not
retire a decision whose source is not assistant; a same-coordinate refusal
**withholds** the delta, because declaring it would overwrite the anchor
through the reducer's same-key path. A user decision may revise either source,
and an assistant may revise its own decision. Historical replay is not
re-authorized: `applyOps` applies recorded operations as they are.

### Evidence

```text
tests/semantic-source-authority.spec.ts   10 tests, pass
  same-coordinate bypass                  withheld, user value active
  explicit-supersedes bypass              refused, no retire op
  assistant -> assistant                  allowed
  user -> assistant                       allowed
  historical unknown -> assistant         refused; user allowed
  replay                                  withheld delta contributes no op;
                                          authorized ops replay identically
mayRetire source gate                     separate from rank and scope
eval/r38 relation-security audit          8/8 (re-run, historical output restored)
```

## 7. Cost and cache accounting

Per-cell request structure is in `report.json`:

```text
usage.primary / usage.auxiliary / usage.byPurpose (writer, rationale, summary)
usage.cacheReadTokens / cacheWriteTokens
```

Provider usage is the provider's own counters. `inputTokens` is UNCACHED input;
cache reads are separate. Requests that reported no usage are counted as
unknown, never zero. In these campaigns every request reported usage.

A few structural facts from the core campaign:

- Basic's summary is the dominant auxiliary cost: 53 calls and 43,227 output
  tokens, with checkpoints growing to ~4k characters and repeated re-summaries
  because the checkpoint itself approaches the threshold.
- E0 makes zero auxiliary calls; its checkpoints are 47 characters (the marker
  only), and the archive carries the content.
- E1 makes one rationale call per fold; its checkpoints carry the rationale and
  the exact values.
- S makes one writer call per fold in these cells; its checkpoint is ~2.2k
  characters with semantic anchors.

## 8. Defects found and fixed in this round

| Defect | Evidence | Fix |
|---|---|---|
| Pinned CI stopped at `generate-presets --check` (no `~/.dsh`) | CI run 42470653930 | explicit `--reference` at the pinned checkout |
| Native smoke rewrote tracked `eval/r37c/out/native-smoke.json` | protected registry drift after a certification run | output overrides; file restored |
| R38 relation audit rewrote its tracked output | observed while re-running 8/8 | output overrides; file restored |
| C1 gates depended on branch names/PR #4 being open | detached CI checkout | frozen records + detached HEAD accepted |
| C1-G5 compared a checkpoint body hash named `prefixFingerprint` | code inspection | renamed `checkpointBodyDigest` |
| B04 named as a live blocker after it was fixed | gate reason | removed |
| Native loop request had no output cap → budget refused the call | first live smoke | `defaultMaxTokens` on the resolved model |
| Checkpoint reader missed a log-only checkpoint | checkpoint null after a fold | log fallback + source recorded |
| T5 required a flat JSON shape but the task did not say so | 5/6 T5 cells nested correctly | T5b template + retest |
| Semantic `decision` source not separated | this round's reproduction | sourceAuthority + tests |

## 9. Limitations

1. **Exploratory scale.** Six templates × two seeds, one model
   (`deepseek-v4.1-flash`), one local route, one machine. No significance test
   is claimed; the two seeds of a template are not independent tasks.
2. **Seeded history.** Only the continuation after the fold is model behaviour.
   The fold itself is real (auto pre-step pressure), but the history was
   scripted.
3. **Operational budget.** 16,384 tokens is an experiment budget, not the
   model's window, and it is small enough that Basic re-summarizes repeatedly.
4. **No currency cost.** The route has no verifiable per-token price. Tokens,
   requests and wall-clock are the enforced and reported limits.
5. **Task-contract sensitivity.** The T5 shape defect moved 5 cells from
   "correct values" to "failed". The retest fixes it; the original cells keep
   their recorded outcome.
6. **Windows teardown warning.** The S arm occasionally printed a libuv
   `UV_HANDLE_CLOSING` assertion at process exit AFTER the result was written.
   It did not affect any measurement; it is recorded as a known teardown noise,
   not fixed blind.
7. **Bv** is certified for compatibility (C1) but is not part of the main
   comparison.

## 10. Decisions

```text
coreDefaultRecommended        false   (exploratory scale; no default change)
semanticActiveRecommended     false   (no signal beyond E1; hold stands)
deploymentEligible            false   (EF Active: deployment hold)
researchPRReady               false   (a reviewer's call, not this round's)
```

The candidate build is installable and smoke-tested (1.34 MB, 391 files, no
raw runs, no credentials, no checkout path). It is a candidate, not a release.

## 11. What would change the answer

- More templates and more seeds, so a per-template rate can be estimated
  rather than described.
- A task set where E0's recall is prompted by the product surface, not by the
  experimenter; the current failure is as much a checkpoint-affordance finding
  as a model finding.
- A second model/route, to separate the mechanism from the model's tool habits.
- A price-verifiable route, if a monetary comparison is wanted.
