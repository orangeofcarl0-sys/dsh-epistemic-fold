# 139 — Checkpoint EXIT, measured: 84% less summary growth, no detectable accuracy cost

Status: measured at 252K, n=5 per arm, free model (`cat-jam-free`), single corpus order.
2026-10-22. Parent `d2266ac`.

## A. What was built

The summary-growth question (does EF grow without bound over a long conversation?) ended
with a bound that is far away and an uncomfortable consequence: staying under it requires
compressing checkpoints into checkpoints, and every such pass loses fidelity.

`exit` is the one mechanism that removes the OBLIGATION to retain instead of making the
retention cheaper. A phase finishes, its checkpoints leave the working surface, and the
content is reachable only through `context_recall`.

Three parts, each landing separately so each could be validated alone:

| piece | commit | what it adds |
|---|---|---|
| lifecycle model | `c9ab09f` | `resident` / `archived` / `retired`, and the `conflicts` invariant |
| retirement write | `6a08983` | `ef/retire`, the bridge ops, `--phase-exit` |
| removal | `d2266ac` | the tombstone replacement that takes the node off the surface |

## B. The observation surface is the corpus, not a new one

The single-phase protocol has no moment at which any content is DONE, so exit was
unmeasurable on it. `phased.py` cuts the EXISTING corpus into four phases at project
boundaries, and the existing 20 composition probes become real cross-phase dependencies:

    phase  docs  projects                        probes  cross-phase deps
    1      25    coding-1..5                     45      --
    2      25    execution-1..5                  50      5 need phase 1
    3      25    reasoning-1..5                  50      5 need phase 2
    4      29    generation-1..5 + 4 errata      59      10 need 3/1, plus 4 updates

A probe is asked in the phase where ALL its dependencies are available, never in the phase
its own project lives in. Every errata goes in the LAST phase, because each corrected fact
carries both an extraction probe expecting the OLD value and an update probe expecting the
new one -- asking the extraction one after the errata arrived would make the expected answer
wrong.

## C. The result

Quality arm, 252K, 4 phases, `--phases 4 --parts-per-phase 2`, folds 8/8 in all ten cells.

| | baseline (no exit) | exit |
|---|---|---|
| accuracy | 0.9765 +/- 0.0190 | 0.9500 +/- 0.0460 |
| surface growth | +2,480 +/- 81 | **+396 +/- 293** |
| final residency | n/a | resident 0, archived 0, retired 8, **conflicts 0** |

    accuracy difference  -0.0265   SE(diff) 0.0223   t = -1.19   -> not significant
    growth reduction     84.0%, and the standard deviations do not overlap
                           (2,399 lower bound vs 689 upper bound)

Mean surface per phase:

    phase   baseline    exit
      1       65,677    65,761
      2       66,409    65,973
      3       67,092    65,792
      4       68,157    66,157

The baseline grows monotonically, as the growth curve predicted. The exit arm is FLAT.

## D. What is established, and what is not

**Established: the benefit.** An 84% reduction in growth with disjoint standard deviations
is not a marginal effect and does not depend on the model.

**Not established: the cost.** The overall difference is -2.65 points with t = -1.19 at
n=5. That is UNDER-powered, not null: the data admits a true cost anywhere from about 0 to
-0.05. Three rounds of this round's own defect list say the same thing -- a number that
looks like a result and cannot support one.

**The predicted cost channel did not materialise.** The cross-phase composition probes were
the reason the phased protocol exists, and their mean is IDENTICAL in both arms (0.950 vs
0.950). An earlier n=1 pass suggested 20/20 -> 17/20 and would have been written down as
the cost; at n=5 both arms produce occasional composition slips.

**What did move is VARIANCE, and only in phase 2:**

    phase 2 accuracy   baseline 0.9960 +/- 0.0080   exit 0.8720 +/- 0.1532

Phase 2 is where the `coding-N -> execution-N` probes ask about content ingested in phase 1
and retired after it. Its standard deviation moves by a factor of 19, and those intervals do
not overlap. That is the mechanism behaving as designed, expressed as instability rather
than as a lower mean -- which is the shape a mechanism takes when it only fails sometimes.

Phase 1 also reads lower in the exit arm (0.9867 -> 0.9422) and CANNOT be affected by a
retirement that happens after it is probed. That is the noise floor at n=5 with this model,
and it is the same size as the effect being claimed. It is the single strongest reason not
to call the cost measured either way.

## E. A protocol cost worth recording

The phased baseline (0.9765) sits below the single-phase matrix on the same tier and arm
(0.9961, n=5). Splitting the probes across phases costs roughly two points on its own.
Comparisons between exit and no-exit are unaffected -- both arms pay it -- but a phased cell
must never be compared directly against a single-phase one.

## F. What would settle the cost

The effect being hunted is about 2.5 points with a within-arm SD of 2-4 points. At that
signal-to-noise, n=5 gives roughly one third of the power needed. Two cheaper routes than
more reps:

1. **Restrict the probe set to the 19 cross-phase probes** and run many more of them. The
   mechanism is supposed to act there; measuring 19 probes 20 times is better resolved than
   measuring 204 probes 5 times.
2. **Measure the mechanism, not the score.** Ask whether the retired content is reachable
   through `context_recall` and how many turns it costs, which is a deterministic number
   rather than a sampled one.

## G. Reproduction

    EF_MEMORY_DRIVER=phased.py EF_MEMORY_WINDOW=258048 \
      bash eval/memory/run-memory.sh --arm quality --phases 4 --parts-per-phase 2 \
      --phase-exit none|retire --out <file>

Analysis: `ef-phase7-logs/analyse-252k.mjs`.
