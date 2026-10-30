# 144 — Exit above the saturated tier: 71-84% less growth, no detectable accuracy cost

Status: n=5 per arm per tier, OmniGate route (`deepseek-v4.1-flash`), anchors off.
2026-10-31. Parent `15382fe`.

## A. Why this run

docs/143's fourth next-round item was the only one producing a deployable claim: exit suppresses
checkpoint growth, the archive stays intact, and the claim does not depend on any accuracy column
this bench cannot make clean. docs/139 measured exit at 252K with n=5 on a free model writing
100-330 character digests -- the smallest regime the bench can produce, not quotable for a
deployment. This is the same protocol on the route that is available, at the two tiers above the
saturated one.

## B. The result

| | baseline (n=5) | exit (n=5) |
|---|---|---|
| 252K accuracy | 0.9010 +/- 0.0395 | 0.8814 +/- 0.0472 |
| 252K growth | 7,578 +/- 440 | **2,223 +/- 1,737** |
| 475K accuracy | 0.9128 +/- 0.0295 | 0.9108 +/- 0.0184 |
| 475K growth | 8,843 +/- 1,743 | **1,447 +/- 542** |

    accuracy difference   252K -0.0196  SE 0.0275  t = -0.71
                          475K -0.0019  SE 0.0156  t = -0.12

    growth reduction      252K 70.7%     475K 83.6%
    separation            both tiers non-overlapping (7,138 vs 3,961; 7,100 vs 1,989)

    residency             retired 8, conflicts 0, in all ten exit cells

`conflicts 0` is the invariant docs/139 defines: a retirement recorded and not honoured would
appear there, and does not. Every one of the fifty exit-arm cells across both tiers retired
exactly the eight checkpoints its four phases produced.

## C. The per-cell growth distribution, which the mean hides

    252K exit growth   3,622  414  616  4,851  1,614
    475K exit growth     688 1,262 1,304 2,342 1,639

At 475K the effect is uniform. At 252K it is bimodal: three cells are near-flat (414-616) and two
are an order of magnitude higher (3,622, 4,851). The mean of 2,223 is a fair summary and a poor
description -- the typical 252K retired cell frees almost everything and the occasional one frees
little, which is what a tombstone smaller than the checkpoint it replaces would look like. This is
recorded rather than smoothed: anyone quoting "71%" for 252K should know that three of five cells
were above 90%.

## D. The composition column is still not evidence either way

Composition probe 166 fails in every cell at every setting (docs/143 B). The corrected diagnosis
there stands: both endpoints and every needed field are present in the checkpoint when the probe
is asked, against 32,115 characters of coordinate lines, so the failure is the JOIN and not
retention. A probe that fails under both treatments cannot evaluate either.

## E. What this supports, and what it does not

**Supports:** a 71% (252K) to 84% (475K) reduction in checkpoint growth, standard deviations
non-overlapping at both tiers, with no detectable accuracy cost (t = -0.71 and -0.12, n=5), on a
route a deployment would plausibly use, with the archive provably intact (docs/139 H: recall
byte-identical before and after a retirement, and the tombstone carries the `cp:` reference).

That is the claim this series set out to make. Everything the four directions explored --
semantic merge, coordinates, temperature -- was an attempt to make retention cheaper; exit
removes the obligation, and the measurement says that is worth 71-84% at no measurable cost.

**Does not support:**

1. Any claim about composition under either condition -- that channel is limited by prompt
   density in every cell.
2. A bound on the cost tighter than "not detectable at n=5 with SE 0.016-0.028". The data admits
   a true cost of about -0.05 at 252K.
3. Anything about a model that writes long digests, or about a corpus whose phases do not
   correspond to a completion boundary a driver can name. Exit needs a boundary; here the
   boundary is the corpus's own project grouping.

## F. Reproduce

    EF_LIVE_BASE_URL=http://127.0.0.1:17866/v1 EF_LIVE_MODEL=deepseek-v4.1-flash \
    EF_MEMORY_DRIVER=phased.py EF_MEMORY_WINDOW=258048|475136 \
      bash eval/memory/run-memory.sh --arm quality --phases 4 --parts-per-phase 2 \
      --anchors off --phase-exit none|retire --out <file>

Tabulation: `ef-phase7-logs/.exitn5.mjs` and `.exitn5detail.mjs`.
