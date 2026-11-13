# EF-E2E — Result

Status: complete. The core campaign (39 cells), the semantic pilot (12 cells)
and the T5b retest (8 cells) all executed. This document reports what the runs
show, what they do NOT show, and what was fixed because of them.

## 1. Headline answers

**1. Can EF Minimal keep quality in real compression tasks and save
resources?** In this setup, partly. E0 uses zero auxiliary calls and the least
input (298,566 tokens over 12 core cells vs 391,224 for B0 and 445,450 for E1),
but it passes 7/12 core cells against 10/12 for both B0 and E1. The loss is
concentrated in exact-recall tasks (T2/T4: 0/4 in the core campaign). The
archive holds the facts — E0 recalled correctly in 5 of 12 core cells — but a
47-character checkpoint marker does not reliably tell the model that recall
exists or that it should write a file after recalling. Two of the four T2/T4
failures had the right values in the final answer and never wrote the file.

A follow-up experiment (§5b) added an explicit recall-affordance section to the
checkpoint and tested it against E0 on the same tasks: **it did not help** (E0
2/6, E0a 1/6) and the model invoked recall LESS often. The flag stays
experimental and off. The same experiment re-ran core E0 cells and found
run-to-run variance large enough to flip T4 from 0/2 to 2/2; see §5b and §9.

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
e2e-recall-1         12        12        51       310,376          6,418    2.0 min
e2e-guard-smoke-1    1         1         3        16,903            590    0.2 min
e2e-index-1          24        24        68       860,374         12,428    3.6 min
total                96        96       520     2,971,193        120,567   24.7 min
```

Original envelope: 452 / 2,200 requests, 2.11M / 18M input, 108k / 1M output,
21.1 min / 8 h. **Continuation cells: 72 / 72, closed.**

Follow-up envelope (`e2e-index-1`): 68 / 720 requests, 0.86M / 6M input,
12.4k / 250k output, 3.6 min / 3 h. **Cells: 24 / 24, closed.**

No monetary claim: the route has no verifiable per-token price.

All 96 cells reached at least one successful fold. No cell is `no-fold`.

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

## 5b. Recall-affordance experiment (negative)

The core campaign's most actionable finding was that E0's bare marker did not
prompt recall. A flag (`recallAffordance`, default off) appends one section:

```text
Recall
- Folded history is archived. Use context_search to find it, or context_recall to open it.
```

Cost on the E2E fixture: 47 → 146 characters (~25 tokens).

| Arm | Pass | Cells | Recall calls | Input | Output |
|---|---|---|---|---|---|
| E0 | 2/6 | T2/T4/T5B × 2 | 23 | 178,848 | 3,486 |
| E0a (affordance) | 1/6 | same | 7 | 131,528 | 2,932 |

**The affordance did not help.** E0a invoked recall LESS often and passed one
fewer cell; the failures are still mostly `missing-output` (the model has the
value and does not write the file). The flag stays experimental and OFF.

The same campaign re-ran the core E0 tasks and seeds. T4 went from 0/2 in the
core campaign to 2/2 here, with the same task, seed and budget. That is direct
run-to-run variance at this scale, and it is the main reason the per-arm rates
in §3 are descriptions, not estimates.

## 5c. Trajectory and variance attribution

`eval/e2e/src/trajectory-analysis.mjs` reads all 96 executed cells. 25 have an
ordered event trajectory (the guard smoke and the 24 index cells); the earlier
71 are reconstructed from request deltas and tool counts. The index campaign's
trajectories were captured before the user-event extractor fix, so their user
text is empty while assistant/tool events are intact; the analysis records it.

Across the 71 output-file cells (T2/T4/T5/T5B):

| Behaviour | Pass | Fail |
|---|---|---|
| wrote an output (`write_file`/`edit_file`) | 25 | 20 |
| wrote nothing | **0** | **26** |
| called recall | 8 | 22 |
| never called recall | 17 | 24 |

Two gates, in this order:

1. **The write gate.** No write means no pass: **0/26**. With a write, 25/45 pass.
2. **The value gate.** Given a write, the remaining failures are wrong values,
   a nested shape, or an explicit UNKNOWN. Recall does not predict success:
   E1/S/B0 often pass without ever calling recall, because their checkpoint
   carries the values; E0 calls recall and still fails when it trusts the
   later distractor.

### T2 is a stable failure, not variance

All three E0 T2-s1 runs (core, recall, guard smoke) end the same way: the model
reads the late distractor log in the live turn, never recalls, and says the
values are not in the log. The guard then makes it write the refusal:

```text
seq 42  assistant  I can't provide those values. The log I read
                   (logs/gateway-late.log) contains only gateway request lines...
seq 49  user       (completion guard: answer.json does not exist yet)
seq 50  assistant  I still can't fill those fields, but I can make the absence
                   explicit in the file...
seq 51  tool/call  write_file answer.json {"build":"UNKNOWN...","timeout_ms":null}
```

The correct log (`logs/gateway-2026-10-11.log`, with `build=7f3c9a1e` and
`timeout_ms=1847`) is in the folded span. The checkpoint is a bare marker, and
the retained tail is the later log. The model has no cue that the useful log
was folded, so it does not ask for it. **This is a checkpoint-content gap, not
a write gap.**

### T4 is variance in tool persistence

Same task, seed and arm:

| Campaign | Outcome | Recalls | Writes | What happened |
|---|---|---|---|---|
| core | fail (missing-output) | 2 | 0 | stated `eu-west-3`/`3` in prose and stopped |
| recall | pass | 7 | 1 | re-queried, corrected itself, wrote the file |

The fold and the archive are identical. The difference is whether the model
kept acting after its first answer.

### The completion guard (one live cell)

`completionGuard` checks the declared output files after the turn is idle and
injects a corrective message (`source: completion-guard`, not `user`) at most
twice. It writes nothing and is identical for every arm.

- Offline certification: a stop-first scripted model is refused once, writes,
  and passes.
- Live smoke (the 72nd and last cell): the guard fired once, `answer.json`
  exists at the end — and contains UNKNOWN. **The guard closes the write gate,
  not the value gate.**

### The folded-span index

`foldedSpanIndex` (default off) lists the folded span's tool calls in the
checkpoint, e.g.:

```text
Archived calls
- read_file logs/gateway-2026-10-11.log
```

It costs 56 characters (~14 tokens) on the T2 fixture and names the exact log
the model needed. Unit- and self-test-certified; live-tested below.

## 5d. Folded-span index (negative)

The original 72-cell envelope was closed. A separate 24-cell follow-up
envelope (`e2e-index-1`, 720 requests / 6M input / 250k output / 3h) ran the
paired arms on T2/T4, two seeds, two replicates.

| Arm | Pass | Recall calls | Writes | Folded-path `read_file`/`list_dir` | ENOENT |
|---|---|---|---|---|---|
| E0 | 2/8 | 19 | 4 | 0 | 0 |
| E0i (index) | 0/8 | 9 | 1 | 0 | 0 |
| E0ai (index + instruction) | 1/8 | 18 | 1 | 2 | 2 |

**The index did not help.** E0i halved recall and passed none; E0ai restored
recall but produced the worst behaviour in the whole round — the model read the
archived path with the WORKSPACE tool:

```text
checkpoint: Archived calls / - read_file logs/gateway-2026-10-11.log
assistant:  I can't provide those values — the rotated-out log I read
            (logs/gateway-late.log) contains only gateway request lines...
tool/call   read_file logs/gateway-2026-10-11.log
tool/result Error: ENOENT: no such file or directory
tool/call   list_dir logs
tool/result Error: ENOENT
assistant:  The logs are gone...
```

The index names a PAST tool call. The model resolves it with `read_file`,
which only sees the workspace; the failure then reinforces "the evidence is
gone". Naming the tool that was used is not the same as naming the tool that
can retrieve it.

The baseline also moved: E0 passed 2/8 here against 0/4 for T2/T4 in the core
campaign, with the same tasks and seeds. The variance is now observed in every
campaign, not just once.

**What this points to.** The next product change is not more checkpoint text:
it is archive-aware path resolution (`read_file` on a folded path resolves the
archived message) or an unambiguous instruction that says the path is NOT in
the workspace and only `context_recall` can open it. Either needs its own
24-cell paired campaign under a new envelope.

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
2. **Run-to-run variance.** The recall campaign re-ran the core E0 cells with
   the same tasks, seeds and budget: T4 moved from 0/2 to 2/2. Single runs per
   cell are noisy, so an arm difference of one or two cells is not a finding.
   The core rates are descriptions of these runs, not estimates of a rate.
3. **Seeded history.** Only the continuation after the fold is model behaviour.
   The fold itself is real (auto pre-step pressure), but the history was
   scripted.
4. **Operational budget.** 16,384 tokens is an experiment budget, not the
   model's window, and it is small enough that Basic re-summarizes repeatedly.
5. **No currency cost.** The route has no verifiable per-token price. Tokens,
   requests and wall-clock are the enforced and reported limits.
6. **Task-contract sensitivity.** The T5 shape defect moved 5 cells from
   "correct values" to "failed". The retest fixes it; the original cells keep
   their recorded outcome.
7. **Windows teardown warning.** The S arm occasionally printed a libuv
   `UV_HANDLE_CLOSING` assertion at process exit AFTER the result was written.
   It did not affect any measurement; it is recorded as a known teardown noise,
   not fixed blind.
8. **Bv** is certified for compatibility (C1) but is not part of the main
   comparison.

## 10. Decisions

```text
coreDefaultRecommended        false   (exploratory scale; no default change)
semanticActiveRecommended     false   (no signal beyond E1; hold stands)
deploymentEligible            false   (EF Active: deployment hold)
researchPRReady               false   (a reviewer's call, not this round's)
recallAffordance              off     (negative live result)
completionGuard               experimental, not a default
foldedSpanIndex               off     (negative live result: E0 2/8, E0i 0/8, E0ai 1/8)
```

The candidate build is installable and smoke-tested (1.38 MB, 393 files, no
raw runs, no credentials, no checkout path). It is a candidate, not a release.

## 11. What would change the answer

- **Archive-aware path resolution.** The index experiment showed the model
  resolving an archived path with `read_file`, getting ENOENT, and concluding
  the evidence was gone. The next product change is either `read_file` resolving
  a folded path from the archive, or wording that says the path is not in the
  workspace and only `context_recall` can open it. It needs a new 24-cell
  paired campaign; both existing envelopes are closed.
- More templates, more seeds, and repeated runs per cell, so a per-template
  rate can be estimated rather than described. The T4 flip between campaigns
  shows that one run per cell is not enough for an arm comparison.
- A study of the output contract on top of the retrieval cue: the guard proves
  the write gate can be closed, but the guard smoke wrote UNKNOWN because the
  model still did not know that the useful log was folded. The index named the
  call and the model still used the wrong tool. The guard is the completion
  check; the retrieval affordance must be a TOOL the model uses, not a line it
  reads.
- A second model/route, to separate the mechanism from the model's tool habits.
- A price-verifiable route, if a monetary comparison is wanted.
