# 143 — Four directions, converged: what survives, what inverted, and what the bench cannot say

Status: synthesis of docs/139-142 plus the 252K replication. 2026-10-27. Parent `377515b`.

## A. The 252K replication inverted one headline

docs/141 measured the anchors x exit matrix at 131K and concluded that `off + retire` DOMINATES
`on + retire` -- same accuracy to four decimals at 4.6x less growth. That conclusion does not
hold at 252K:

| cell | 131K acc | 131K growth | 252K acc | 252K growth |
|---|---|---|---|---|
| anchors off, exit none | 0.8971 | +8,678 | 0.9167 | +8,301 |
| anchors off, exit retire | **0.9902** | **+1,515** | 0.9216 | **+2,241** |
| anchors on, exit none | 0.9804 | +30,418 | 0.9559 | +18,939 |
| anchors on, exit retire | **0.9902** | +6,916 | **0.9608** | +12,759 |

At 252K the best accuracy is `on + retire` (0.9608) and the cheapest growth is `off + retire`
(+2,241, 3.9 points behind). The trade is real rather than dominated: **anchors buy about four
points for about ten thousand tokens of extra growth.**

What DOES replicate across both tiers:

1. **Exit reduces growth.** 131K 83% (off) and 77% (on); 252K 73% (off) and 33% (on).
2. **Anchors increase growth**, on the order of 2-6x, because 166 rendered coordinate lines are
   re-rendered into every checkpoint.
3. **Anchors increase accuracy** wherever growth is not the binding constraint: +8.3 points at
   131K with exit off, +3.9 at 252K with exit on.

## B. Both tiers agree on WHY, once the failing probes are read

| tier | cell | wrong composition probes |
|---|---|---|
| 131K | off, none | 166-170 (all five) |
| 131K | off, retire | none |
| 252K | **all four cells** | 166-170 in three, 166/168/169/170/173 and similar in the fourth |

At 252K, composition ids 166-170 fail in EVERY cell including both exit conditions and both
anchor settings. That is not a treatment effect. It is the PROTOCOL: each phase ingests about
272K tokens at this tier against a retained tail of roughly 62K, so a phase's content is folded
away before the next phase's cross-phase probes can use it. At 131K a phase is about 136K and
the loss is smaller.

So the 252K matrix has a protocol artifact dominating one of five probe channels, and the
accuracy column at that tier cannot be read as a clean treatment comparison either. The honest
reading of 252K is the growth column (which is mechanical) and the extraction/disambiguation
columns (0.95 -> 1.00 under anchors in both exit conditions), not the total.

## C. What each direction actually established

**1. Exit -- established and shipped.** Checkpoint lifecycle (`c9ab09f`), retirement write
(`6a08983`), surface removal (`d2266ac`). Deterministic probe: the archive is byte-identical
before and after a retirement, and the tombstone carries the `cp:` reference so the content is
reachable in one call. The first tombstone did not carry it, which made exit a deletion in
practice -- found by the deterministic probe, not by the accuracy experiment.

**2. Semantic merge -- the mechanism was already right, the substrate was missing.**
`state.ts` bounds state by coordinate and never renders a displaced value;
`tests/checkpoint-boundedness.spec.ts` proves a checkpoint is a function of coordinate count,
not revision count (2,000 historical facts render identically to 40). The bench held zero
coordinates until `f7652bd` declared them. Once declared, anchors are a bigger constant and a
better accuracy carrier -- not the cheaper retention they were hoped to be.

**3. Temperature -- correct, and inapplicable to this workload.** The RC29 observer classified
166 of 166 coordinates as `pinned`, because the bench declares `constraint` + `normative` and
pin exactly that. The content that actually grows is the prose digest, which is not an anchor
and which the observer structurally cannot see.

**4. Root-leaf -- never started, and the reason is now clear.** `context_recall` already
expands a root to verbatim leaves; what was missing was a trigger, and the two things that would
provide one (growth pressure, temperature) are handled by exit and are inapplicable here
respectively.

## D. The convergence

**Exit is the only mechanism of the four that removes the obligation to retain. The other three
make retention cheaper, better-encoded, or better-ranked -- and all three act only after the
retention has already happened.**

That ordering explains every measurement in this series:

- Exit suppresses growth at both tiers, in both anchor settings, and the archive keeps every
  byte, so it does not trade fidelity for space.
- Coordinates improve accuracy because a rendered coordinate set is a better carrier than model
  prose -- a statement about ENCODING, which matters most when nothing can be retired.
- The thermal observer ranks coordinates by demand, which cannot help when the coordinates are
  the undemotable kind and the growing thing is not a coordinate at all.

## E. What the bench cannot say, stated once

1. **Whether coordinates are a better SLOPE or only a bigger CONSTANT.** The corpus ends exactly
   when its 166 coordinates saturate, so the anchored plateu lies outside every measurement
   window. A corpus that keeps producing new coordinates past saturation would settle it.
2. **Whether the phased protocol measures what it intends at 252K or above.** Its own
   cross-phase chain fails in every cell at that tier. The protocol is clean at 131K and is not
   validated above it.
3. **The cost of exit with a statistically useful bound.** docs/139 puts the 252K exit
   difference at -2.65 points, t = -1.19, and the more recent single cells move around that. The
   mechanism probe settled what the score could not: the content is reachable, so any cost is a
   retrieval call rather than a loss.
4. **Anything about a model that writes long digests.** `cat-jam-free` wrote 100-330 characters
   per fold. OmniGate's `deepseek-v4.1-flash` writes more, which is why the 131K and 252K
   matrices here are not comparable with the earlier paid-route growth curve (+1,024 tokens per
   fold).

## F. What a next round should do, in order

1. **Fix the phased protocol's 252K chain break** -- put the cross-phase probes in the phase
   that still holds both endpoints, or give the phase a retrieval step. Without it, no
   multi-phase result above 131K is interpretable.
2. **Run exit at 252K and 475K with the protocol fixed**, n=5, and report the growth column and
   the mechanism probe. That is the deployable claim: growth suppressed, archive intact.
3. **Only then** revisit coordinates, with a corpus that does not end with its own fact set.

## G. Reproduce

    docs/139  exit measured (n=5)            ef-phase7-logs/analyse-252k.mjs
    docs/140  merge substrate                bridge op {"op": "state"}
    docs/141  2x2 at 131K                    ef-phase7-logs/.matrix2x2.mjs
    docs/142  thermal on this workload       tests/thermal-residency.spec.ts
    this doc  2x2 at 252K                    ef-phase7-logs/.m2x2-252.mjs
