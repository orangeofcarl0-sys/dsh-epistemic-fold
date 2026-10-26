# 141 — Coordinates vs exit at 131K: four cells, and the cheapest one wins

Status: measured 2026-10-27 on the OmniGate route (`deepseek-v4.1-flash`, local proxy),
n=1 per cell. Parent `f7652bd`.

## A. Why four cells

Two independent remedies for checkpoint growth existed and had never been compared:

| remedy | mechanism | added in |
|---|---|---|
| **coordinates** | declare the corpus's stated facts as `ef/anchor`, so the checkpoint renders a bounded set of coordinates instead of accumulating prose | `f7652bd` (docs/140) |
| **exit** | retire a finished phase's checkpoints, leaving a tombstone that carries the recall reference | `d2266ac` (docs/139) |

Quality arm, four phases, eight folds, 131K. `folds 8/8` in every cell.

## B. The result

| cell | accuracy | surface growth | composition | extraction | update |
|---|---|---|---|---|---|
| anchors off, exit none | 0.8971 | +8,678 | **0.75** | 0.9125 | 1.00 |
| anchors on, exit none | 0.9804 | **+30,418** | 1.00 | 1.00 | **0.75** |
| anchors off, exit retire | **0.9902** | **+1,515** | 1.00 | 0.9875 | 1.00 |
| anchors on, exit retire | **0.9902** | +6,916 | 0.95 | 1.00 | 1.00 |

Per-phase surfaces:

    off, none     35,502 -> 38,138 -> 40,411 -> 44,180
    on,  none     37,877 -> 45,432 -> 55,755 -> 68,295
    off, retire   34,968 -> 34,534 -> 35,846 -> 36,483
    on,  retire   38,111 -> 40,796 -> 43,863 -> 45,027

## C. Three findings, each carried by the probes that failed

**1. `off + retire` DOMINATES `on + retire`.** Same accuracy to four decimals (0.9902) at
1,515 tokens of growth against 6,916 -- 4.6x less. Once a phase can be retired, a better
representation of what is retained matters much less, because less is retained.

**2. Coordinates are a bigger CONSTANT, not a better SLOPE -- as far as this corpus can show.**
Anchored cells are 3.5x worse on growth with exit off (+30,418 against +8,678). 166 rendered
coordinate lines are not free, and every fold re-renders all of them. The anchored
representation SHOULD plateau once the coordinate set saturates while prose keeps accumulating,
but the corpus ends exactly when its 166 coordinates do, so the plateau lies outside the
measurement window. This is the second of the two outcomes docs/140 named in advance, and it is
the one that arrived.

**3. The two arms fail on DIFFERENT probes, and that is the strongest evidence in the table:**

    off, none     composition ids 166-170 ALL wrong   (execution-N -> reasoning-N, the chain)
    on,  none     update id 183 wrong                 (reasoning-2.effect_size, an errata)
    on,  retire   composition id 167 wrong
    off, retire   nothing wrong

Without coordinates the prose digest loses an entire cross-phase chain; with coordinates and no
exit it loses an errata CORRECTION instead -- the ghost-memory confusion `state.ts` warns about,
where the old and the new value compete for the same fact. Both are losses of the same kind:
content that survived is no longer answerable. Exit fixes both channels, and it is the only
single change that does.

## D. What this changes about direction 2

Semantic merge was the plan to make retention cheaper. The measurement says the cheaper
retention is not needed if retention can be ENDED -- and exit ends it. The two remedies are not
additive: they compete for the same problem, and the one that removes the obligation beats the
one that improves the encoding.

That does not make coordinates useless. `on + none` scores 0.9804 against `off + none` 0.8971,
so coordinates are worth +8.3 points when exit is UNAVAILABLE -- a deployment that cannot retire
phases should declare coordinates. It just should not pay 3.5x growth for them when it can.

The honest framing: **coordinates buy accuracy, exit buys accuracy AND space, and the space is
what a long conversation actually runs out of.**

## E. Limits

- n=1 per cell. The differences here are large (8-9 points, 4.6x growth) and the failures are
  categorical -- whole probe channels -- so they are unlikely to be sampling noise, but n=1 is
  n=1.
- 131K only. The tier is saturated for the five-arm matrix (docs/139 D), so these numbers are
  not comparable with the 252K exit sweep.
- The extractor is the BENCH's, not EF's, and its two patterns are tuned to this corpus's two
  statement forms (docs/140 G). A different corpus needs a different extractor, and an LLM
  extractor would be a different experiment with a different hazard.
- The plateau that would settle "constant or slope" cannot be measured here, because the
  corpus and its coordinate set end together.

## F. Reproduce

    EF_LIVE_BASE_URL=http://127.0.0.1:17866/v1 EF_LIVE_MODEL=deepseek-v4.1-flash \
    EF_MEMORY_DRIVER=phased.py EF_MEMORY_WINDOW=131072 \
      bash eval/memory/run-memory.sh --arm quality --phases 4 --parts-per-phase 2 \
      --anchors off|on --phase-exit none|retire --out <file>

Tabulation: `ef-phase7-logs/.matrix2x2.mjs` and `.wrongrows.mjs`.
