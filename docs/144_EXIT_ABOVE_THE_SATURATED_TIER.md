# 144 — Exit at 252K and 475K: 80-92% of the growth, none of the accuracy

Status: n=1 per cell, OmniGate route (`deepseek-v4.1-flash`), anchors off. 2026-10-31.
Parent `15382fe`. n=5 in progress.

## A. Why this run and not another

docs/143's fourth next-round item was the only one that produces a deployable claim: exit
suppresses checkpoint growth, the archive stays intact, and the claim does not depend on any of
the accuracy columns this bench cannot make clean. docs/139 measured exit at 252K with n=5 on a
free model that wrote 100-330 character digests; that is the smallest regime available and not
quotable for a deployment.

So: the same protocol, the same arm, on the route that is actually available, at the two tiers
above the saturated one.

## B. The result

| cell | accuracy | surface growth | per-phase surfaces | residency | composition |
|---|---|---|---|---|---|
| 252K none | 0.8922 | +7,967 | 67,637 -> 70,244 -> 71,938 -> 75,604 | n/a | 0.75 |
| 252K retire | 0.8971 | **+1,614** | 66,636 -> 67,750 -> 67,532 -> 68,250 | r0 a0 t8 **c0** | 0.65 |
| 475K none | 0.8922 | +8,402 | 122,079 -> 124,298 -> 127,284 -> 130,481 | n/a | 0.90 |
| 475K retire | 0.8922 | **+688** | 122,274 -> 121,748 -> 122,154 -> 122,962 | r0 a0 t8 **c0** | 0.75 |

    growth reduction   252K 80%     475K 92%
    accuracy           unchanged at 475K, +0.5 points at 252K
    residency          retired 8, conflicts 0, at BOTH tiers

The surface stops moving. At 475K the exit arm's four phase measurements are 122,274, 121,748,
122,154 and 122,962 -- it hovers rather than climbs, and the variation is the tombstone and the
retained tail, not accumulation.

`conflicts 0` at both tiers is the invariant docs/139 defines: a retirement recorded and not
honoured would show up here, and none does.

## C. The composition column, and why it is not evidence either way

Composition probe 166 is wrong in ALL FOUR cells, and the sets differ elsewhere:

    252K none   166,168,169,171,172
    252K retire 162,164,166,167,168,169,170
    475K none   166,175
    475K retire 166,168,169,170,171

docs/143 established that this is the JOIN, not retention: both endpoints and every field a
composition probe needs are present in the checkpoint when it is asked, against 32,115 characters
of coordinate lines. The treatment is not implicated -- the per-cell sets overlap in a probe that
is wrong everywhere.

## D. What this does and does not support

**Supports:** an 80-92% reduction in checkpoint growth at the two tiers above the saturated one,
with no measurable accuracy cost, on a route a deployment would plausibly use, and with the
archive provably intact (docs/139 H: byte-identical recall before and after a retirement, and the
tombstone carries the reference).

**Does not support:** a claim about composition under either condition, because that column is
limited by prompt density in every cell; and any statistical statement, because this is n=1.

n=5 is running for both tiers and both arms. The n=1 pairs differ by 0.5 and 0.0 accuracy points
and by 6,353 and 7,714 tokens of growth; the growth gap is large enough that more reps are about
bounding the accuracy side, not about whether the effect exists.

## E. Reproduce

    EF_LIVE_BASE_URL=http://127.0.0.1:17866/v1 EF_LIVE_MODEL=deepseek-v4.1-flash \
    EF_MEMORY_DRIVER=phased.py EF_MEMORY_WINDOW=258048|475136 \
      bash eval/memory/run-memory.sh --arm quality --phases 4 --parts-per-phase 2 \
      --anchors off --phase-exit none|retire --out <file>

Tabulation: `ef-phase7-logs/.exitn1.mjs`.
