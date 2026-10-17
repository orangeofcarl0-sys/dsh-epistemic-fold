# 132 — The checkpoint digest is a manifest, and it was being discarded

Measured 2026-10-18 on the memory bench, `quality` tier, 252K window, arm A, logical order.
This document records the evidence chain from a 47-character checkpoint to a 0.9020 score,
and the design question it settled.

## The observation

Decoding a real bundle (`eval/memory/_bundles/`, zstd payload) gave the checkpoint EF handed the
model after folding 100 documents -- 1,043,005 tokens:

```
[EF1 L cp:ec545751-5654-4719-8010-fa0cc120eb01]
```

47 characters. `state.anchors = 0`. Every machine section (Current / Evidence / Open) was empty,
so `renderStructuredCheckpoint` emitted the marker and nothing else. Arm A scored 0.5961.

## The cause was two defects, stacked

### 1. The cap equalled the instruction's upper bound

`RATIONALE_INSTRUCTION` asked for "100-400 tokens". `RATIONALE_MAX_TOKENS` was exactly 400.
A model writing the top of the range it was ASKED for finished `max-tokens`; `finishError` maps
that to an error, `rationaleOnly` throws, and `engine.ts` catches it and sets
`semanticText = undefined`. The rationale was DISCARDED, not truncated.

Following the instruction and succeeding were mutually exclusive. A cap must sit above the range
a prompt requests; equality makes the top of the requested range unachievable.

### 2. The no-anchor case had no carrier at all

With `anchorCount = 0` the machine sections are empty, but the instruction still FORBADE the
rationale from stating current state, constraints, or failure status -- a division of labour that
is correct only when those sections carry something. So the one channel that could have carried
the facts was instructed not to, and the checkpoint carried nothing.

## What made it visible

Nothing in the artifact could tell "the rationale failed" from "no rationale was requested".
`summarizationAttempts` stayed 0 because it counts Basic's summarizer, not EF's rationale.
Four counters were added (`src/fold-telemetry.ts`) and published through the bridge:

```
rationaleAttempts / rationaleFailures / rationaleFailureReason / rationaleChars
```

They named the failure immediately: `attempts 1, failures 1, reason MAX_TOKENS, chars 0`.

## The measured progression

```
                          checkpoint              rationaleChars   arm A accuracy
cap 400   (original)      [EF1 L cp:...] 47 chars        0            0.5961
cap 1024                  [EF1 L cp:...] 47 chars     1432            0.6765
cap 8192 + no-anchor      [EF1 L cp:...] + manifest   2468            0.9020
                                                                      ------
Basic (its own narrative summary, 44,513 tokens)                      0.8824
```

+0.306 from the first to the last, against an arm-A run-to-run noise of about +/-0.05.
The 1024 step still failed on the no-anchor instruction -- asking for "the operative facts" of 100
documents needs more than 1024 tokens, so the model overshot again and lost everything. The lesson
is that a FIXED cap cannot bound a task whose size grows with the folded span; 8192 is a backstop
above any plausible terse digest, so the model is bounded by the INSTRUCTION rather than by a
tripwire that discards its work.

## What the checkpoint carries now

```
[EF1 L cp:f7781382-287b-4b03-9721-084b5ddbed82]

Rationale
- Operative parameters by family:
- Coding: coding-1 max_attempts=8, connect_timeout_ms=758, ... coding-2 corrected max_attempts=11
  (published 2), ...
- Execution: execution-1 escalate_after_minutes=32, retry_budget=6, ...
- Reasoning: reasoning-1 effect_size=0.46, ci_low=10, ci_high=67, p_value=0.034. reasoning-2
  corrected effect_size=0.29 (published 0.64), ...
- Generation: generation-1 preferred_term is "settings" in style_guide versus "configuration"
  in spec; ...
- Errata supersede earlier figures: coding-2 max_attempts 2 -> 11; execution-2
  escalate_after_minutes 10 -> 34; reasoning-2 effect_size 0.64 -> 0.29;
```

## Stability: the honest result

Three replicates of the same cell, comparing the distinct facts each digest preserved:

```
chars 2198, 2013, 1941      distinct facts 12, 6, 13
facts in all three: 0        union: 26        Jaccard: 0.000
accuracy: 0.9461, 0.9363, 0.9507
```

**Aggregate accuracy is stable (+/-0.007); the facts preserved are not.** Each run keeps a
different random subset -- even the count varies 2x. The digest is a valid manifest of roughly the
right size, and an unreproducible one. Structure is stable (facts grouped by family, errata
marked); content is not.

## Why this is not a violation of the core contract

`docs/ARCHITECTURE.md` rule 3 said "Narrative summaries are not authoritative state", and rule 8
that "compression is judged by closed-loop behavior, not summary similarity". Read as a prohibition
on ANY digest content, rule 3 argued for the 47-character checkpoint. That reading is wrong, and
`src/inventory.ts` is the evidence:

```
 *  - `recall.ts` serves `context_recall depth="detail"`, which for a checkpoint with no
 *    semantic digest must return THIS inventory -- the main agent has no other way to see
 *    what was folded away.
```

EF already intends the model to see what was folded away. The full recovery chain is: the model
reads a `cp:<id>`, must call `context_recall depth="detail"` to learn what is behind it, receives
the inventory, and only then can ask for specifics. **Every step depends on the model behaving
correctly, and a model that cannot tell what it is missing cannot decide to ask.** A checkpoint
that carries nothing does not preserve recoverability -- it breaks it, one layer up.

So rule 3 constrains AUTHORITY, not informativeness. It was updated to say so: the digest is a
manifest, never a substitute for the bundle, and both halves are load-bearing.

## What this does not settle

- **The bench still measures outside EF's contract.** Arm A never calls `context_recall`, so it
  tests the digest as a substitute for the bundle rather than as a manifest. By rule 8 the
  closed loop includes "does the model choose to recall", and arm A cuts it. Wiring a tool-answer
  path into `run_code.py` is the change that would close it.
- **0.9020 vs Basic's 0.8824 is inside the noise** (+/-0.05, single run each). The +0.306 from the
  cap fix is far outside it and is the result that holds.
- **The digest's fact-level unreproducibility is unresolved.** It is the dominant term in arm-A
  variance. Fixing it needs either a deterministic extraction step or a structured fact list that
  coverage can be scored against.

## Files

```
src/rationale.ts          rationaleInstruction(anchorCount); WITH_ANCHORS cites anchors by id,
                          NO_ANCHORS must preserve the facts
src/engine.ts             RATIONALE_MAX_TOKENS 400 -> 8192; records the rationale's outcome
src/renderer.ts           machineAnchorCount()
src/fold-telemetry.ts     rationaleAttempts / rationaleFailures / rationaleFailureReason /
                          rationaleChars
eval/tau2/bridge-host.ts  publishes those four
eval/memory/run_cell.py   whitelist
docs/ARCHITECTURE.md      rule 3 restated as a manifest rule
```

