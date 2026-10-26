# 140 — Semantic merge: the mechanism is bounded, the substrate is empty

Status: measured and proved, 2026-10-27. Parent `f5f1a03`.

## A. The question

Checkpoint growth at 252K is +310 tokens per fold on the free model and +1,024 on the paid
route. Exit removes it (docs/139, 84% at n=5), but exit works by REMOVING the obligation to
retain. Semantic merge is the other route: keep retaining, and make the representation of
what is retained grow with meaning rather than with history.

## B. EF already contains the mechanism, and it is bounded by coordinate

`state.ts:13-18` states the model outright:

> The ONE bounded exception is `superseded`: the immediately-previous anchor at each state
> coordinate ... bounded by the number of coordinates (one entry each), not by the number of
> revisions, and it is deliberately NOT rendered into any checkpoint -- a model that sees both
> the old and the new value at one coordinate is exactly the ghost-memory confusion this keeps
> out of the prompt.

That is the whole design a merge needs, and it was already there: bounded by meaning,
conflicts traceable, conflicts never rendered.

`tests/checkpoint-boundedness.spec.ts` proves the property rather than asserting it, on the
pure renderer:

    forty coordinates revised once    -> N characters
    forty coordinates revised fifty  -> N characters  (2,000 historical facts)
    eighty coordinates               -> N + 500 or more

and `value-49`, which sits in `superseded`, does not appear in the rendered checkpoint while
`value-50` does.

## C. The substrate is empty in the memory bench, and that is the actual gap

A `state` op was added to the bench bridge to count coordinates. Measured at 131K, projection
mounted:

    at init      constraints 0  stateHeads 0  evidence 0  superseded 0  total 0
    after ingest constraints 0  stateHeads 0  evidence 0  superseded 0  total 0
    after a fold constraints 0  stateHeads 0  evidence 0  superseded 0  total 0

The projection is MOUNTED (`mounted: true`) and holds nothing. The corpus arrives as plain
user messages and never issues `ef/anchor`, so no coordinate is ever created. The checkpoint
therefore has no machine sections, the model prose digest is the sole carrier, and prose
accumulates -- which is exactly the growth the bench measured.

So semantic merge is not missing from EF. **The substrate it operates on is missing from the
corpus.** The same fact explains why the RC29 thermal observer (PR #4) would classify nothing
in this bench: it also reads the deterministic state.

## D. What that turns direction 2 into

Not "add merging" -- it exists and is bounded. The question becomes:

**if the corpus produced coordinates, would growth stop?**

That is testable, and its risk is worth stating before it is run. Coordinates have to come from
somewhere, and there are exactly two sources:

1. **A deterministic extractor keyed to the corpus's structure.** The bench's documents state
   facts in a fixed shape ("The on-call retry_budget is 7 attempts."), so an extractor is
   feasible -- but it would be a property of the BENCH, not of EF, and any result from it must
   be labelled that way. It measures the value of structured extraction, using EF's existing
   bounded rendering.
2. **An LLM extraction pass.** This is the `rationale.ts` hazard in a new place: a model
   writing state is a model writing what the next fold will treat as authoritative. EF's
   authority gate exists precisely to keep narrative from becoming state.

Option 1 is the honest experiment. Option 2 is the one that quietly breaks the design.

## E. What is already known about the answer

The corpus holds 104 documents over 20 projects, each stating a small fixed set of fields, plus
four errata that correct four of them. The number of distinct coordinates is therefore a few
hundred and FIXED -- it does not depend on how many folds happen. Under the bounded renderer a
checkpoint would converge on that set and stop growing, with the errata handled by
`superseded` taking the old value out of the prompt and keeping it in the log.

The `update` probes already measure the failure mode this guards against: if the merge kept
both values visible, the model would be reading ghost memory. Measured across both 252K arms
and both exit conditions, `update` is 1.000. Nothing is currently confusing the corrected and
the original value -- because there is no coordinate machinery to get it wrong.

## G. The substrate, populated and verified

A deterministic extractor now reads the corpus's two fact shapes and declares each as an
`ef/anchor` citing the message that stated it (`--anchors on` in `phased.py`). Verified OFFLINE,
before any provider call:

    documents                     104
    facts extracted               193
    distinct coordinates          166
    errata -> corrected values    11 / 34 / 0.29 / faq-first   (all four match the answer key)
    answer-key coordinates        75 of 100 recovered: the 25 absent are 20 abstention probes
                                  (those facts are deliberately NOT in the corpus) and 5
                                  disambiguation probes (their subject is a value, not a
                                  coordinate)

Then cross-checked against a live session, which is the only reason to trust the extractor:

    anchors_declared   193
    constraints        166
    superseded          19
    retiredCount        27

The offline prediction and the runtime agree exactly. `superseded: 19` is the reducer doing its
job: four errata plus fifteen re-statements of a coordinate already held, each displacing the
previous value instead of appending it. That is the mechanism docs/139's growth curve lacked.

### Two extractor defects, both found offline

1. Matching only the assignment form (`max_attempts = 8.`) recovered **62 of 100** coordinates.
   Thirty-eight are stated in prose (`The on-call retry_budget is 6.`). A second anchored
   pattern is required.
2. The pooled filler contains real code (`(options, args) = parser.parse_args()`), so an
   unanchored `=` match INVENTS facts out of sample code -- the worst failure available here,
   because it manufactures authority. The assignment pattern is now anchored to a line with no
   brackets or commas.
3. An errata's header reads `# ERRATA -- coding-2`, so taking the project from the header
   attributed the correction to a project named `ERRATA`. The path supplies it instead.

## H. BLOCKED: the growth question needs a working route

The anchors on/off control was run and **cannot be used**. Both arms returned 204 of 204 probes
unparsed with `rationaleChars: 0` and eight or nine rationale failures:

    cat-jam-free          HTTP 400  Upstream request failed: Model is unavailable.
    deepseek-v4.1-flash   HTTP 429  Go usage limit exceeded (limitName: monthly)

The free model is gone and the paid route's MONTHLY quota is spent, so no live cell can run.

What the failed run does NOT show, and would have been easy to misread: the `--anchors off` arm
looked FLAT (33,205 -> 33,542) against a baseline that grows (+3,707). That is not a result. With
the provider down there were no digests, so every checkpoint was marker-only and there was
nothing to grow. The correct reading is that the cell is void.

What remains unanswered, and can be run the moment a route returns:

    --anchors off   the prose digest accumulates   (measured: +3,707 over four phases at 131K)
    --anchors on    the checkpoint renders 166 coordinate lines instead

If the on arm's surface converges while the off arm keeps climbing, the bounded representation
is the answer to growth and the extractor is the missing piece. If the on arm climbs FASTER --
which the void cell hints at, since 166 rendered lines are not free -- then structured state is
a bigger constant, not a better slope, and the honest conclusion is that annotations cost tokens
that prose did not.

## I. Reproduce

    tests/checkpoint-boundedness.spec.ts          the boundedness property
    bridge op {"op": "state"}                     coordinate counts for a live session