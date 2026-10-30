# 145 — What four memory mechanisms actually bought, and what was refuted getting there

Status: closing report for docs/139-144. 2026-10-31. Parent `e34e72d`.

This is the document to read instead of the six. It separates three kinds of claim, because
mixing them is how a series like this goes wrong: **mechanism** (deterministic, no sampling),
**measured** (sampled, with its n and its spread), and **refuted** (what a later check killed,
including two of my own hypotheses).

---

## 1. The deployable claim

Retiring a finished phase's checkpoints removes **71-84% of checkpoint growth** with no
detectable accuracy cost, at the two tiers above saturation.

| | baseline (n=5) | exit (n=5) |
|---|---|---|
| 252K accuracy | 0.9010 +/- 0.0395 | 0.8814 +/- 0.0472 |
| 252K growth | 7,578 +/- 440 | **2,223 +/- 1,737** |
| 475K accuracy | 0.9128 +/- 0.0295 | 0.9108 +/- 0.0184 |
| 475K growth | 8,843 +/- 1,743 | **1,447 +/- 542** |

    accuracy difference   -0.0196 (t = -0.71)      -0.0019 (t = -0.12)
    growth reduction      70.7%                    83.6%
    separation            non-overlapping at both tiers
    residency             retired 8, conflicts 0, in all ten exit cells

**Why this one survives:** the effect is in a mechanical quantity (tokens on the surface), the
standard deviations do not overlap at either tier, and the invariant that would expose a
dishonoured retirement is zero everywhere.

## 2. The mechanism claims, which need no statistics

These are checked by asking the system directly, and they are the strongest results in the
series because a failure would be categorical rather than a shift in a mean.

**Retirement does not touch the archive.** A `context_recall` of a checkpoint returns 23,202
characters across 16 archived messages, **byte-identical before and after** a retirement.
`context_recall` resolves a checkpoint id against the bundle store directly (`store.verify`),
never through the surface, so `exit` is a visibility change with a retrieval cost, **not a
deletion**. The tombstone carries the `cp:` reference precisely because the alternative --
content present, pointer gone -- is a deletion from the only vantage point that matters, and
that was the first version's defect.

**A checkpoint is bounded by coordinate, not by revision count.** `renderStructuredCheckpoint`
over 40 coordinates revised 50 times (2,000 historical facts) renders the same length as 40
coordinates revised once, and the displaced value in `superseded` never appears. Proved on the
pure renderer in `tests/checkpoint-boundedness.spec.ts`.

**The thermal observer is correct and inapplicable here.** On this workload it classifies 166 of
166 coordinates as `pinned`, because the bench declares `constraint` + `normative` and pin exactly
that. Its other classes all work when given anchors it may move, and its discipline holds: a
state it cannot see is `unknown`, never `cold`.

---

## 3. The four directions, verdict by verdict

| direction | verdict |
|---|---|
| **exit** | **shipped and measured.** Lifecycle, write path, removal, and a deterministic proof that the archive survives. 71-84% less growth at no detectable cost. |
| **semantic merge** | **the mechanism was already right; the substrate was missing.** EF bounds state by coordinate and never renders a displaced value. This bench held zero coordinates until they were declared. Once declared they buy accuracy and cost growth -- a bigger constant, not a better slope. |
| **temperature** | **correct, and inapplicable.** The observer ranks coordinates by demand; this workload's coordinates are the undemotable kind and the content that grows is not a coordinate at all. |
| **root-leaf** | **never needed.** `context_recall` already expands a root to verbatim leaves; the trigger it lacked is what exit provides, and exit is cheaper. |

## 4. Refuted, in the order it was discovered

**"Coordinates are the answer to growth."** They cost 2-6x MORE growth at both tiers, because
166 rendered coordinate lines are re-rendered into every checkpoint. The anchored form should
plateau once its coordinate set saturates -- but the corpus ends exactly when its coordinates do,
so the plateau is outside every measurement window. **Undetermined, not refuted**, and stated as
undetermined in docs/143.

**"`off + retire` dominates `on + retire`."** True at 131K (same accuracy to four decimals, 4.6x
less growth). **False at 252K**, where anchors buy 3.9 accuracy points for about ten thousand
tokens. A single-tier matrix was treated as a conclusion and the next tier inverted it.

**"The phased protocol breaks its own cross-phase chain at 252K."** The hypothesis was that a
phase ingests more than the retained tail keeps, so its content is folded away before the next
phase probes it. It fitted the numbers. **A direct check of the checkpoint refuted it**: at the
moment the phase-3 composition probes run, both endpoints (`execution-1`, `reasoning-1`) and every
field they need are present, in 32,115 characters. The failure is the JOIN against prompt density,
not retention, and the recommendation to fix the protocol was withdrawn.

**"The free model is good enough for these measurements."** It writes 100-330 character digests,
which put every checkpoint at 200-300 tokens -- the smallest regime the bench can produce, where
both the benefit and the cost are bounded by that. docs/139's 252K numbers are not comparable
with docs/144's.

## 5. What this bench cannot say

1. **Whether coordinates are a better slope or only a bigger constant.** The corpus and its
   coordinate set end together.
2. **Anything about composition under either treatment.** Probe 166 fails in every cell at every
   setting; a channel that fails everywhere cannot evaluate anything.
3. **A bound on exit's cost tighter than "not detectable at n=5, SE 0.016-0.028".** The data
   admits a true cost near -0.05 at 252K.
4. **Anything about corpora whose phases are not a boundary a driver can name.** Exit needs a
   boundary; here it is the corpus's own project grouping. A deployment with no natural
   completion point would need one supplied.
5. **Anything about a model writing long digests**, which is the regime where checkpoint growth
   is a real problem rather than a modest one.

## 6. If this continues

In priority order, and each for a specific reason:

1. **Repeat docs/144 on a long-digest model.** That is the regime the whole question is about,
   and it is one route change away.
2. **Reduce prompt density rather than change the protocol.** The join fails against 32K
   characters of coordinate lines; fewer, better-chosen coordinates per checkpoint addresses it,
   and that is a retrieval-ranking problem -- which is what the RC29 observer was actually for.
3. **Only then** revisit encoding, with a corpus that keeps producing coordinates past saturation.

## 7. Index

    139  exit measured (n=5, free model)          archive intact, conflicts 0, cost unresolvable
    140  semantic merge substrate                 bounded by coordinate; bench had none
    141  coordinates vs exit at 131K              off+retire dominated -- later inverted
    142  thermal observer on this workload        166/166 pinned; classes all work
    143  four directions converged                252K 2x2; chain-break hypothesis refuted
    144  exit above saturation (n=5)              71% / 84%, no detectable cost

Code: `src/checkpoint/residency.ts`, `src/state/thermal.ts`, `eval/memory/phased.py`,
bridge ops `checkpoints` / `retire` / `state` / `anchor`.
Tests: `checkpoint-residency`, `checkpoint-boundedness`, `thermal-residency`.
