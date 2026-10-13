# 67 — Subagent recall (experimental): retrieval as a bounded query

Status: IMPLEMENTED, off by default, tested. Not yet run against a task. This is the first
mechanism from the exposure research programme in docs/66 to be built.

## 1. What it is

A recall that used to be a document fetch becomes a bounded query:

```
context_recall { ref }                       -> content, up to the direct limit
context_recall { ref }  (over the limit)     -> REFUSED, with the size, the descriptor,
                                                and the instruction to use the subagent
context_recall_subagent { goal, ref?, query? } -> a short answer + verbatim quotes
                                                + a FURTHER list of what else it saw
context_recall_subagent { }                  -> a SURVEY of what the archive holds
```

The caller states a need in its own words and never has to name a checkpoint. A subagent
reads the archive — descriptors, search, exact pages — and answers within a reply budget, so a
120,000-character read can yield a 300-token answer. That asymmetry is the whole feature.

## 2. Why it exists

Measured over nine cells of the 4.1F round (docs/66): 57% of recall/search calls returned a
marker with no content; 34% of searches returned `hits: []`; 32% of recalls re-opened a
checkpoint already opened, up to ten times the same id; 4 of 9 cells ever recovered the task
instruction. The archive was never at fault — `depth: "exact"` returned the instruction
character-for-character. The fault was at the interface: an opaque id to target with, and no
size control on what came back.

## 3. The protocol

Two model calls, no tool-call protocol:

1. **Plan.** The subagent is shown the GOAL and a DESCRIPTOR LIST — never the archive — and
   returns `{"queries": [...], "fetches": [{"ref", "depth", "offset", "limit"}]}`. A model that
   cannot produce that falls back to a DETERMINISTIC plan: the ref or query the caller already
   named, or the summaries of the most recent descriptors.
2. **Read.** Searches first (they are pointers, already bounded), then fetches, in order, until
   the fetch budget or the fetch cap stops it. Stopping early sets `used.truncated`.
3. **Answer.** The subagent is shown the material and the goal, and returns
   `{"answer", "quotes", "further"}`. `quotes` exist so an exact fact — a name, a unit, a hash,
   a path — can cross the boundary verbatim instead of paraphrased. `further` is required even
   when the goal is met: it is what else the subagent saw that the caller may want next.

In SURVEY mode (no goal) the same loop runs and `further` is the point: it is how a caller
discovers what is in an archive it has never read. That is the NON-GOAL half of the feature —
not every recall need is known in advance.

## 4. The descriptor, which is what makes targeting possible

```
handle    cp:56aee82f
mode      leaf
span      seq 2-62                    a position, from what the fold recorded
messages  10
inventory ["user: You must RECOVER THE TRUE SEMANTICS of an undocumented job-config...",
           "assistant -> run_shell {\"command\": \"cat engine.py\"}",
           "tool: # JobSpec -> Canonical Config -- field reference...",
           "... and 7 more message(s)"]
```

**Everything in it is deterministic.** No model call, so an EF leaf fold still makes zero
auxiliary calls and this adds nothing to its cost or latency. It answers "what is this" rather
than "what does it say": enough to decide WHETHER to fetch, with the content still behind the
handle. An archive that cannot be resolved says `archive unreadable` rather than returning an
empty inventory, because "I could not read this" and "this is empty" are different claims.

## 5. The bounds, all of them

| bound | default | what it stops |
|---|---|---|
| `subagentRecallThresholdChars` | 24,000 (~6,000 tokens) | a direct recall returning more than the caller can afford |
| `subagentRecallFetchBudgetChars` | 120,000 (~30,000 tokens) | the subagent reading without limit |
| `SUBAGENT_MAX_FETCHES` | 6 | a plan that asks for the whole archive |
| `SUBAGENT_PLAN_MAX_TOKENS` | 512 | the planning reply |
| `SUBAGENT_ANSWER_MAX_TOKENS` | 1,024 | **what the caller receives** — the number that makes the feature worth having |
| `SUBAGENT_MAX_DESCRIPTORS` | 40, newest first | the descriptor list growing into a prompt of its own |

The direct limit is deliberately far below the fold threshold so that a PERMITTED recall cannot
be the thing that triggers the next fold. The fetch budget is five times it, because the subagent
does not keep what it reads.

## 6. Gating, and the default-off guarantee

`subagentRecall` is `false` by default, strict (`"true"` throws rather than enabling), and the
two sizes are validated even while the flag is off so a configuration error surfaces at mount
rather than the first time somebody turns it on.

When it is off: `context_recall` returns exactly what it always returned — the gate is not
applied — and `context_recall_subagent` is **not registered at all**, so it is not even offered
to the model. A default deployment is byte-identical to before this feature.

```yaml
- name: dsh-epistemic-fold
  config:
    subagentRecall: true
    subagentRecallThresholdChars: 24000
    subagentRecallFetchBudgetChars: 120000
```

## 7. Telemetry, because an experiment that cannot be read is not an experiment

Module-level counters in `src/subagent-recall.ts`, read by the LHTB bridge into
`telemetry.subagentRecall` (reset per episode, like the summary-retry counters):

| counter | reading |
|---|---|
| `gated` | direct recalls REFUSED for size — **the reading that says the experiment was exercised at all** |
| `invocations` / `surveyInvocations` | subagent runs, split by whether a goal was given |
| `planCalls` / `answerCalls` | the two calls per run |
| `fetches` / `fetchedChars` | what it read |
| `answerChars` | what the caller received |
| `failures` / `lastError` | runs that could not produce an answer |

A run with `gated: 0` and `invocations: 0` says nothing about this feature, however many turns
it took — the same principle as docs/65 F2: publish the reading, do not reconstruct it.

## 8. What it does NOT do

* **It does not protect the objective.** A subagent cannot ask "what was I supposed to do?" on
  the agent behalf and have the answer be authoritative; the pin in docs/66 §4.2 is still needed.
* **It does not create awareness.** The descriptor is what tells the caller to ask at all. Without
  it the caller still has to notice something is missing on its own.
* **It does not make the answer exact.** The answer is a paraphrase. `quotes` is the mitigation,
  and it depends on the subagent choosing to use it — so an exact fact that matters must be
  checked against `quotes`, not against `answer`.
* **It is not free.** Two model calls per run, and they are billed to the cell. On the economy
  arm that is a real regression on the axis that arm exists to measure.

## 9. Provenance, and why the answer cannot simply be retired

A subagent answer is a **derived** artifact: a paraphrase of raw material that the subagent can
regenerate at any time. It reaches the caller as an ordinary `tool/result`, and that is a problem
with two halves.

**The half that is dangerous.** `tool/result` is an AUTHORITATIVE kind (`anchor-service.ts:19-24`),
and the fold policy treats the answer like any other surface material — so it can be archived into
the MAIN tree as if it were history. A later `context_search` then matches it, a later subagent
fetches it, and answers FROM it: a paraphrase becomes a source. That is precisely the laundering
`authority.ts` refuses to let an anchor do ("derived authority must terminate at raw authority
roots"), and there was no equivalent guard for recall content.

**The half that cannot be fixed as asked.** There is no primitive in this codebase that REMOVES a
surface node except a fold. `ef/anchor` is not a surface node at all: `state.ts` reduces anchor
events into hot state with a `lifecycle` and a `retiredCount`, so declaring and retiring an anchor
records a lifecycle without taking the material off the surface. So "retire the returned content
promptly" cannot be implemented as removal today; a `drop`/volatile-node capability, or a tool
result the host does not retain, would be a host-level change.

What is implemented instead, in the order it matters:

1. **A provenance mark that survives the fold.** Every answer carries
   `efDerived: { by, refs, reads, fetchedChars, truncated }`. It is in the archived bytes, so the
   distinction is recoverable AFTER the fold, and it is a distinctive JSON key so detection is a
   substring test rather than a re-parse of every archived message.
2. **A label wherever derived material is re-exposed.** `inventoryOf` renders any message carrying
   the mark as `DERIVED ANSWER (retrieval subagent) - not raw history: ...`, so a checkpoint
   descriptor that holds a folded answer advertises it instead of presenting a paraphrase as the
   record.
3. **A rule in both subagent prompts.** Material labelled derived is not evidence: read the raw
   checkpoint it names, and if the only thing that answers the goal is derived, say so rather than
   restating it as fact.
4. **A size bound that makes the fold unlikely in the first place.** The answer budget is 1,024
   tokens — far below the fold threshold — so a permitted answer is a negligible fold candidate.
   This is the closest thing to "retire it promptly" that exists: the material is small enough not
   to matter, and it is marked so that mattering is recoverable.

**The subagent contributes no EF state of its own**, which is the other half of the same worry: it
makes two model calls and read-only fetches, appends nothing to the session, folds nothing, and
writes no bundle. It cannot put its own checkpoints into the main tree, and it reads the main
session store read-only through the same `recall`/`search` the caller uses.

Open: whether answers should be one-at-a-time (a new answer supersedes the previous), and who
decides to retire — the caller, the tool, or the fold that eventually swallows them all.
## 10. A label defect this could not avoid

`GenerateOptions.purpose` is a closed union, `"compaction" | "session-title"`, and there is no
retrieval value. The subagent calls are therefore labelled `compaction`, which is a MISLABEL: a
host attributing cost by purpose will bill them to compaction. It is documented at the call site,
and `subagentRecallStats` exists partly because of it — the calls are attributable from here even
when the transport label is not.

The subagent deliberately does NOT replay the conversation prefix. A compaction call reuses the
prefix so the provider warm cache still applies; a retrieval question is asked about the ARCHIVE,
and shipping the live surface to it would spend the budget this feature exists to protect.

## 11. Tests

`tests/subagent-recall.spec.ts`, 26 cases. The loop is pure logic over three injected callbacks —
a fetch, a search, one model call — so every branch that decides what the caller RECEIVES is
reachable without a provider: the gate at its boundary, the descriptor for a readable and an
unreadable archive, the plan parser on prose and on junk, the deterministic fallback, the fetch
budget stopping short and SAYING so, the fetch cap, the survey path, and a model call that
throws. What cannot be tested without a model is the PROMPTS, and those are asserted by shape.

## 12. Open questions

* Should the survey path be its own tool? Two entry points with one implementation is fine; one
  entry point with two modes is what exists, and the mode is inferred from whether a goal was
  given, which is a silent switch.
* The `further` list is unranked and unbounded in count. A subagent that lists twenty candidates
  has moved the targeting problem rather than solved it.
* The answer budget is a constant. It should probably be derived from what the caller has LEFT,
  which the tool layer cannot currently see.
* Should a gated recall COUNT against anything? Today a refusal is free and unlimited, so a
  caller can retry the same over-budget recall forever.