# 66 — The exposure boundary: what the model is shown in place of what it lost

Status: research design, opened from the measured retrieval behaviour of the 4.1F round. Nothing here
is applied yet except where it names an existing commit.

## 1. The finding, restated precisely

EF storage is LOSSLESS: a folded region is archived in full, and `context_recall(depth="exact")`
returned the task instruction character-for-character identical to `instruction.md` (docs/65 §3, and
the two cells that recovered it). So the loss is not in the archive.

EF's published claim is about retrieval CAPABILITY — "exact recall of folded history is half of what
EF claims". What the round measured is a failure of retrieval INITIATION and TARGETING, and both live
at the **exposure boundary**: the interface through which the model learns that something is missing,
decides to fetch it, and chooses what to fetch.

Measured over the nine EF cells of the 4.1F round (262 recall/search calls):

| reading | value |
|---|---|
| recall/search calls that returned a MARKER with no content | **150 (57%)** |
| ... that returned an actual page of messages | 23 (9%) |
| `context_search` calls that returned `hits: []` | 88 (34%) |
| `context_recall` calls | 136, over **92 distinct** checkpoints |
| recall calls that RE-OPENED a checkpoint already opened | **44 (32%)**, up to **10x the same id** |
| cells that ever recovered the instruction | **4 of 9** |
| times each of those recovered it | **once** (turns 11-95 of 401) |
| folds after the recovery in the cell that recovered earliest | **79** |

`9zeBtpL` opened one checkpoint **four times, all with `depth="summary"`** — the same call, the same
empty answer, four times. That is the shape of a model probing an interface that tells it nothing.

## 2. The exposure defects

### D1 — the handle is an opaque global id

Every affordance renders the same thing:

```
"[EF1 L cp:56aee82f-654a-4c4f-acc7-be79bb912da1]"
```

56 characters, globally unique, semantically empty. It names a location without saying anything about
the content or about where it sits in the agent's own history. The retrieval decision is a MATCHING
problem — "what do I need now" against "what was dropped" — and this vocabulary supplies neither side.

### D2 — a recall that returns nothing looks like a recall that succeeded

`depth="summary"` and `depth="detail"` return the marker as `text`, with no error and no flag. That is
a false green at the exposure boundary: the model cannot tell "this checkpoint has no summary" from
"the summary is the marker". It is the same defect class this repository keeps finding — a state that
cannot be distinguished from a healthy one — and it is why 57% of calls returned nothing useful while
the tool reported success.

The cause is known and deliberate: an EF leaf fold is a DETERMINISTIC MARKER fold with no LLM call
(`summarizationAttempts: 0`), so there is no summary to render. The defect is not that the marker is
deterministic; it is that the other depths pretend to have something and return the marker instead.

### D3 — search hits carry no information

`context_search` does match content (`matchKind: "message-text"`, `matchedMessageIndex`), but the
`text` it returns for each hit is the marker. So a hit says "something matched, message index 5" and
nothing else: the model cannot rank hits, cannot tell whether the match is what it wanted, and must
open candidates one at a time. 34% of searches returned nothing at all.

### D4 — recall has no admission control

Partially measured, and stated as such. A recall result is an ordinary surface node, so it counts
against the fold threshold the moment it arrives, and `depth="exact"` is PAGED over
`totalMessages`/`offset` — a large checkpoint is fetched page by page into the live surface. There is
no token budget on a recall, no "this will not fit" refusal, and no signalling of what was left
unread. The measured consequence in this round is indirect: the one recovered instruction was
re-evicted by a later fold, so the fetch bought a few turns and not the episode. The loop to look for
is recall -> overflow -> fold -> recall; it is not yet demonstrated, and demonstrating it is E5 below.

### D5 — the measurement channel is lossy, so exposure cannot be reconstructed afterwards

`ef_lhtb_agent.py:602,609` records `output[:1000]` for every tool result. The archive therefore cannot
answer "what did the model actually see" for any output over 1000 characters — which is most of them.
This is our record, not EF exposure, but it is the same defect one layer out: the instrument cannot
observe the thing under study. Any research programme on exposure needs this fixed first.

## 3. The window law, which is a ratio and needs a floor

`thresholdTokens = floor(min(W x thresholdRatio, W - reserve - headroom))`
(`src/policy.ts:386-431`), with `thresholdRatio = 0.5` in this lane (`bridge-host.ts:1400`).

**A fold is only affordable if `thresholdRatio x W` exceeds the working set**, because below that
boundary every fold evicts material the agent must immediately re-read:

```
working set (this task)      = 16,471 tokens
threshold at W = 32,000      = 16,000 tokens     <- 471 BELOW the working set: thrash
threshold at W = 131,072     = 65,536 tokens     <- 4x the working set
minimum safe W at ratio 0.5  = 32,942            (threshold == working set)
minimum with 2x headroom     = 65,884            (room for the agent own reasoning)
```

The round's configuration sat **3% below the thrash boundary**. That is the precise form of "EF does not
suit a short window": not that the policy is wrong for small windows, but that a fixed RATIO has no
floor, so at some window size the budget silently falls under the material it must hold. The design
consequence is a **minimum-window guard**: refuse to run, or refuse to fold, when
`thresholdRatio x W <= workingSetEstimate`. EF cannot know a task's working set a priori, but it can
know the OBSERVED one: the surface size just after the first fold is a lower bound on it.

## 4. The design

Three mechanisms, each answering a different question. They are complementary, not alternatives.

### 4.1 A descriptor: expose SEMANTICS and RELATIVE LOGICAL POSITION

Replace the marker with a descriptor a model can reason with. Three fields, all DETERMINISTIC — no LLM
call, so `summarizationAttempts` stays 0 and nothing is added to the fold's cost or latency:

```
span      "turns 1-6, before your first cfg probe"        relative logical position
contents  ["user instruction", "run_shell: cat engine.py",
           "run_shell: cfg status", "spec.md (4.2 KB)"]   semantic inventory
handle    cp:56aee82f                                     exact retrieval
```

* **Relative logical position**, not seq numbers. The agent has no idea what seq 62 is; it does know
  what "before your first probe" means. Position is computable from the dropped events' own turns and
  tool names.
* **Semantic inventory** extracted from the dropped events: role, tool name, the command's first line,
  and the output size. That is enough to tell "the task statement" from "a `cat` of a log" without a
  model call.
* **Handle** retained for exact retrieval — the id stops being the ONLY thing exposed and becomes the
  last resort rather than the interface.

Two one-line companions:
* `context_search` hits return a SNIPPET of the matching text instead of the marker (D3).
* `depth="summary"`/`"detail"` on a checkpoint that has no summary return an explicit
  `{"summaryAvailable": false, "descriptor": {...}}` rather than the marker as `text` (D2).

### 4.2 A pin for the objective

Unchanged from docs/65 §9, and now with the measurement that makes it non-optional: the objective was
recoverable and was recovered by only 4 of 9 cells, once each. **Recoverable is not recovered.** The
one node whose loss cannot be repaired by reasoning about the rest is the criterion, not the evidence.
It must be applied to both engines or neither (`src/basic/region.ts:143` implements the identical
rule, so an EF-only pin would hand EF an advantage on a dimension the benchmark does not test).

### 4.3 A subagent: retrieval as a bounded QUERY, not a document fetch

This answers the handle problem AND D4, and it changes the SHAPE of the interface rather than
improving it.

The main agent never names a checkpoint. It states a NEED, and a subagent answers it:

```
main agent  ->  "what did the spec say about disk units?"
subagent    ->  reads descriptors, searches, pages through exact content, reads the bundles
            ->  "binary memory uses mb/gb; disk uses decimal gb with gib/tib; the spec revision 3
                retracts the earlier claim. Quote: ..."
```

What it fixes, in the order it matters:

1. **The window is protected by construction.** The interface is a question and a bounded answer, so a
   50,000-token checkpoint yields a 500-token reply. D4 stops being a policy question and becomes a
   reply-budget question.
2. **The handle problem dissolves.** The subagent can afford to read descriptors, try search, and page
   through `exact` — the work the main agent was doing blindly (57% empty results, 32% repeat opens).
   The id becomes an internal detail of the retrieval implementation.
3. **Initiation is the only thing left to the main agent**, and the descriptor (§4.1) is what makes it
   possible: the agent knows WHAT it lost, so it knows what to ask.

What it costs, stated plainly because the economy arm is a cost claim:

* **Extra model calls.** At minimum one per question, realistically several. That is a direct
  regression on the cost axis, and it must be counted in the same budget as the main agent's turns.
* **A read-only view of the SAME archive.** The subagent must reach the bundle store; a separate store
  would be a second source of truth. In DSH terms: a nested agent whose tool set is exactly
  `context_search` / `context_recall` / descriptor listing, over the session's existing bundles.
* **Paraphrase fidelity.** The answer is a paraphrase, so facts that must be exact (a hash, a key name,
  a unit) have to cross the boundary VERBATIM and be marked as quoted. Otherwise the compression
  becomes lossy in a new place, one layer out.
* **Attribution.** For a benchmark the subagent is part of the system under test: its calls, tokens and
  latency belong to the cell. A free helper would silently change what is measured.
* **Determinism.** Another sampling step means the same question can get different answers; the Q&A
  pairs must be logged as part of the record.

What it does NOT solve: the objective (still needs the pin — a subagent cannot ask "what was I
supposed to do?" on the agent's behalf and have the answer be authoritative), and awareness (the
descriptor is still what tells the agent to ask at all).

### 4.4 Budgeted recall, as the stopgap

If the subagent is not built yet, the same protection can be approximated inside the recall tool: cap
the returned tokens, report `truncated: true` and what remains unread, and make the cap explicit in
the response rather than silent. That does not fix targeting, but it removes the unbounded-fetch half
of D4 and makes the truncation visible instead of invisible.

## 5. The measurement: retention is not exposure

The memory-pressure benchmark (docs/61, docs/62) measures `retention = acc(A)/acc(B)` and
`interference = acc(B) - acc(C)`. Those ask whether the agent can still ANSWER about ingested content.
They do not ask whether the agent knows to LOOK. The 4.1F round is a case of capability without
initiation, and no current metric would have caught it.

Proposed exposure metrics, with what each costs to obtain:

| id | metric | how | cost |
|---|---|---|---|
| E1 | fraction of turns on which the objective is on the surface | telemetry | free |
| E2 | fraction of folds whose replacement carries a descriptor with >=1 semantic token | telemetry | free |
| E3 | recall initiation: after a fold that shadowed the objective, turns until the agent recalls it | transcript | free |
| E4 | recall precision: fraction of recall calls that returned CONTENT | transcript | free |
| E5 | recall-induced overflow: fraction of recalls after which the surface crossed the threshold within N turns | telemetry | free |
| E6 | goal restatement accuracy: at a random turn, ask the agent to restate its objective and current plan; score exact/fuzzy | a probe turn | one call per sample |

E1, E2, E4 and E5 should be PUBLISHED BY THE BRIDGE rather than reconstructed afterwards — the same
principle as docs/65 F2, applied to exposure. E6 is the only one that needs a model call, and it is the
direct measurement of legibility: a model that has lost its objective cannot restate it.

## 6. The experiment

One task, one model, one window, four arms differing ONLY in the exposure design:

| arm | replacement | search hits | objective | retrieval |
|---|---|---|---|---|
| A (control) | marker | marker | foldable | direct recall |
| B | descriptor | snippet | foldable | direct recall |
| C | descriptor | snippet | PINNED | direct recall |
| D | descriptor | snippet | PINNED | subagent |

Primary readings: E1-E6, plus the existing cost, turn and reward readings. Falsifiers, stated in
advance:

* B does not raise E4 above A by >20 points -> the descriptor does not fix targeting, and the problem
  is elsewhere.
* C does not change the reward or the re-read counts -> the objective was never the constraint.
* D does not reduce the surface peak or the re-read counts -> the subagent is not bounding anything,
  and its extra calls are pure cost.

Cohort boundary: the 4.1F diagnostic round (window 32,000, MAX_TURNS 400, marker-only, no pin) is a
distinct cohort. Nothing here may be pooled with it or with step-5.

## 7. Sequencing, cheapest first

1. **D5** — stop truncating the record at 1000 characters, so exposure can be studied at all.
2. **D2 + D3 + §4.1** — descriptor, snippet hits, and an honest empty-summary response. Deterministic,
   no extra model calls, no engine-policy change; measure E2 and E4 against the existing corpus shape.
3. **E1/E2/E4/E5 telemetry** — publish exposure, so the next round can be read without forensics.
4. **§4.2 pin** — symmetric across both engines, decided together with how the objective is delivered.
5. **§4.3 subagent** — the largest change, and the only one that bounds retrieval volume by
   construction. Worth building only after B and C have been measured, because its cost is real and its
   benefit is exactly what B and C are designed to test the need for.

## 8. Open questions

* Is the descriptor's semantic inventory enough for targeting, or does it need an abstractive one-liner
  (which reintroduces a model call, and a failure mode)?
* What is the right cap on a subagent answer, and who decides it — the caller, the tool, or the
  engine remaining budget?
* Should the subagent see the main agent's current objective (better answers, more context to leak) or
  only the question (cheaper, blinder)?
* Does a pinned objective cost enough tokens to matter on a small window, and is a capped pin
  ("protect the first K tokens of the initial user turn") the right compromise?
* If retrieval is delegated, does the main agent's recall TOOL still exist? Two retrieval paths with
  different ergonomics is how one of them rots.