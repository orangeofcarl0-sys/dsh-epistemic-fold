# 69 — Recall reachability: why a folded instruction could not be reached

Status: measured on one real fold, 2026-10-13. Confirms docs/66 D2 and D3 and adds one
defect those documents do not name.

## 1. The observation

Cell `unknown-config-semantics__yFUiH4d` (economy arm, `deepseek-v4.1-flash`, window
131072, threshold 65536) folded once:

| | |
|---|---|
| checkpoint | `cp:75c8a907-1a58-48a5-bce9-5afd7b94d3ee` |
| tokens | 65,974 -> 23,643 (42,351 shadowed over 108 surface seqs) |
| archive | 108 messages, 130,530 characters |

The model then tried twice to get something back, and failed both times:

```
turn 74  context_search  {"query":"task: reverse engineer hidden program CLI outputs"}
         -> { "hits": [] }

turn 86  context_recall  {"ref":"cp:75c8a907-...","depth":"detail"}
         -> { "text": "[EF1 L cp:75c8a907-1a58-48a5-bce9-5afd7b94d3ee]" }
```

It never called `context_recall_subagent`, the only path that would have handed it an
inventory.

## 2. The fold is not the defect

Decoding the bundle shows the instruction archived **verbatim** at message index 0:

```
archive.messageCount 108   shadowedMessages 108   chars 130,530
[0] user len=5741 :: "You must RECOVER THE TRUE SEMANTICS of an undocumented job-config format..."
INSTRUCTION present in the archive: true
```

There is no duplication either: 0 of 108 messages are exact duplicates, and the
instruction and `cfg_daemon.py`'s marker each appear exactly once.

**So the content was stored correctly and is reachable in principle. Every failure below
is in the retrieval interface.**

## 3. The chain, and where it breaks

### 3.1 The surface carries an identity and nothing else

A fold leaves `[EF1 <code> cp:<uuid>]` (`src/checkpoint-marker.ts:80`) — 40 characters.
The V2 marker deliberately dropped the trailing `Recall` section because the tool
description already explains the syntax (`src/checkpoint-marker.ts:129-136`).

The explanation it relies on is:

> "Messages marked `[EF1 <mode> cp:<id>]` are Epistemic Fold checkpoints ... Call
> context_recall with `cp:<id>` when exact folded history is needed."
> — `src/checkpoint-marker.ts:137-140`

**It names no `depth`.** That omission is the first break, and it is load-bearing because
of 3.2.

### 3.2 The default depth returns what the model already has

```
src/recall.ts:58    const depth = options.depth ?? 'summary'
src/recall.ts:168   summary -> bundle.rendered.text
src/recall.ts:171   detail  -> bundle.semantic?.text ?? bundle.rendered.text
src/recall.ts:179   exact   -> paginated archive messages
```

For a leaf fold with no semantic digest, `bundle.rendered.text` **is** the 40-character
marker (`src/types.ts:125-128`: "absent on fallback"). So:

| depth | returns | for this fold |
|---|---|---|
| `summary` (the default) | `rendered.text` | `[EF1 L cp:75c8a907-...]` |
| `detail` | `semantic?.text ?? rendered.text` | **the same string** |
| `exact` | the 108 archived messages | the answer |

A model that follows the explanation literally — `context_recall` with `cp:<id>`, no
depth — receives back the exact string that is already in its context. Escalating to
`detail` returns it a third time. Nothing in either response says that `exact` exists or
that it is the one that works.

**Two of the three advertised depths are identical for the most common fold kind, and the
one that works is not reachable by escalating.** That is D2, and this is its measured
cost: the model spent two calls and got zero characters.

### 3.3 The same situation is handled correctly one module away

```
src/recall-loop.ts:267   fallbackPlan: { fetches: [{ ref, depth: "exact", offset: 0 }] }
src/recall.ts:58         recall:       const depth = options.depth ?? 'summary'
```

The subagent's fallback plan, given a ref and nothing else, chooses `exact` and comments
that "the caller named a ref ... so use it". The main tool, given the same ref and nothing
else, chooses `summary` — a no-op by construction.

**This is the one defect not named in docs/66**, and it is a one-line asymmetry rather
than a design question.

### 3.4 Search treats the whole query as one needle

```
src/recall.ts:442   "M0 match rule: id equality or case-insensitive substring over text faces"
src/recall.ts:465   const needle = query.toLowerCase()
src/recall.ts:468   if (bundle.rendered.text.toLowerCase().includes(needle)) ...
```

The query `"task: reverse engineer hidden program CLI outputs"` is matched as a single
substring. The instruction says `"RECOVER THE TRUE SEMANTICS of an undocumented
job-config format"`. Semantically identical, lexically disjoint, therefore `hits: []`.

This is D3. It matters more than it looks: search is the only path that does not require
already knowing the handle, so when it is lexical, a model that has forgotten a handle has
no way to re-derive it.

### 3.5 The inventory exists but is only built for the subagent

`src/descriptors.ts:29-38` already produces, deterministically and with no model call:

```
handle        cp:56aee82f
mode, span, messageCount
inventory     one line per archived message: role, tool name, leading 80 chars
```

Its own docstring says the marker "names a location and nothing else, **which is what made
targeting fail**". The inventory is exactly the missing half.

It reaches the model through `src/recall-loop.ts:251-252` — the `DESCRIPTOR LIST` in the
**subagent's** prompt. Nothing puts it in the main model's context, and the main model has
no tool that returns it. So the mechanism that solves the problem is one tool call away,
and the tool is one the model did not call.

## 4. What this changes about docs/66

Nothing in docs/66 is wrong. Its section 4 prescribes exactly what this measurement
independently derived:

* `context_search` hits return a snippet, not the marker (D3) — `docs/66:132`
* `summary`/`detail` on a checkpoint with no summary return an explicit
  `{"summaryAvailable": false, "descriptor": {...}}` rather than the marker as `text`
  (D2) — `docs/66:133-134`
* a descriptor exposing span, contents and handle — `docs/66:110-129`

What this adds:

1. **Evidence, from a real cell, that these are the blocking defects** rather than
   improvements. The model did what its instructions said, twice, and recovered nothing.
2. **The default-depth asymmetry (§3.3)**, which is not in D1-D5 and is cheaper to fix than
   any of them.
3. **A measured consequence for §4.2's pin.** docs/66 records that the objective was
   recovered by 4 of 9 cells once each. In this cell the objective was archived verbatim and
   still recovered 0 times in 2 attempts — so the pin is not redundant with a working
   retrieval path, and a working retrieval path is not a substitute for the pin.

## 5. Fix order, cheapest first

1. **Name the depth** (`src/checkpoint-marker.ts:137-140`). One string: say that
   `context_recall` returns the archived messages at `depth: "exact"`. No machinery, and
   it addresses precisely what the model did.
2. **Default `exact` when a ref is given and no depth is** (`src/recall.ts:58`), matching
   `fallbackPlan`'s existing choice. One line; removes a call whose return value is
   identical to its input.
3. **Make `detail` mean something for a non-semantic fold** — return the descriptor
   inventory plus a head excerpt, so `summary` (identity) < `detail` (what is inside) <
   `exact` (the messages) becomes a real ladder. `describeCheckpoint` already computes
   this; the cost is wiring, not new computation.
4. **Token-based search** instead of whole-phrase substring (D3), with the phrase match
   ranked first so precision is not lost.
5. **Put a bounded descriptor into the surface at fold time** (docs/66 §4.1). Highest
   leverage — it needs no call at all — but it spends tokens on every fold, and V2 removed a
   trailing section for exactly that reason. The inventory bound is already 10 lines x 80
   chars, so the budget is knowable before deciding.

## 6. What to measure to confirm each

* (1) and (2): does a cell that folds then succeed in fetching content, and at which depth?
  Both are visible in the transcript as `context_recall` calls and their character counts.
* (3): the same, plus whether `detail` ever returns more characters than `summary`.
* (4): re-run the exact query from §1 against the same bundle. It must not return `hits: []`.
  That is a unit test, not a wave.
* (5): folds per cell and total tokens spent on descriptors, against the fold count.

Items 1-4 are all deterministic and testable without a wave. Only 5 needs one.
