# EF-E2E — stage attribution

Reconstructed offline from the 96 executed cells. No model call was made.

Cells: **96**, passed **49**, failed **47**. Ordered trajectories: **25**; the rest use request previews with a `truncated` flag.

## Where the failures stop

| Stage | Meaning | Failed cells |
|---|---|---|
| observe | the fact was not in any tool result the model received | 0 |
| produce | nothing was written and the value was not stated | 17 |
| write | the value was stated, but the deliverable was not written | 13 |
| schema | the deliverable exists but its keys/types are wrong | 12 |
| verify | the deliverable parses, but its values or tests fail | 5 |
| unknown | no recorded stage explains the result | 0 |

**C is unknown in 35 memory-task cells** (19 of them failures). A truncated tool preview cannot prove absence, so those are counted apart rather than labelled `observe`.

No cell can be shown to have failed at **observation** with the recorded evidence: every memory-task failure either had the fact visible in a tool text or had a truncated text where absence proves nothing. That is a limit of the evidence coverage, not a claim that observation never failed.

## How the value reached the answer

| Path | Memory-task cells |
|---|---|
| the final text/deliverable carries the value, seen in a primary tool result | 22 |
| the value was carried by the CHECKPOINT, not a tool result | 7 |
| the value was produced with neither visible source | 12 |
| the value was not produced | 30 |
| value production unknown (no gold pair) | 0 |

The checkpoint path is why an E1 cell can pass T2 without calling recall: the semantic state carried the exact value inline. It is also why a B0 cell can pass: Basic's summary contained the build and timeout verbatim. Neither is a retrieval success, and neither is evidence that the archive was used.

Verification failures split by the failing checker:

| Sub-stage | Cells |
|---|---|
| external-check | 1 |
| wrong-value | 4 |

## Memory tasks by arm

| Arm | Cells | Passed | Failure stages |
|---|---|---|---|
| B0 | 8 | 6 | schema 1, write 1 |
| E0 | 23 | 6 | produce 7, schema 4, write 3, verify 3 |
| E0a | 6 | 1 | schema 1, produce 3, write 1 |
| E0ai | 8 | 1 | produce 4, write 3 |
| E0i | 8 | 0 | verify 1, produce 3, write 4 |
| E1 | 12 | 7 | schema 4, write 1 |
| S | 6 | 4 | schema 2 |

## What this changes

The 47 failures are not one mechanism. Seventeen never put the value anywhere, thirteen stated it but wrote no file, twelve wrote a wrong shape, and five wrote a shape-correct file whose values or tests fail. `B0` is not uniformly worse for the same reason: its compaction summary can carry the exact values inline (the T2-s1 summary contains both), so a short task can pass without any archive interface; an EF fold applies a retention policy that may move the same tool result into the archive, so the continuation must retrieve it. The stage table makes that trade visible instead of calling both outcomes "compression quality".

## Per template

| Template | Cells | Passed | Failure stages |
|---|---|---|---|
| T1 | 9 | 8 | verify 1 |
| T2 | 27 | 7 | produce 10, write 5, schema 3, verify 2 |
| T3 | 10 | 10 | — |
| T4 | 22 | 9 | produce 4, verify 2, write 7 |
| T5 | 10 | 1 | schema 8, write 1 |
| T5B | 12 | 8 | schema 1, produce 3 |
| T6 | 6 | 6 | — |

## The cells that matter most

| Campaign | Cell | Pass | D value | C observed | Written | Failure |
|---|---|---|---|---|---|---|
| e2e-core-1 | T2-s1-E0-r1 | no | false | null | false | produce |
| e2e-core-1 | T4-s1-E0-r1 | no | false | true | false | produce |
| e2e-core-1 | T5-s1-E1-r1 | no | false | null | true | schema |
| e2e-core-1 | T5-s1-B0-r1 | no | false | null | true | schema |
| e2e-core-1 | T5-s1-E0-r1 | no | true | null | true | schema |
| e2e-core-1 | T2-s2-E0-r2 | no | true | true | false | write |
| e2e-core-1 | T4-s2-E0-r2 | no | true | true | true | verify |
| e2e-core-1 | T5-s2-B0-r2 | no | true | null | false | write |
| e2e-core-1 | T5-s2-E1-r2 | no | false | null | true | schema |
| e2e-pilot-1 | T2-s1-E1-r2 | no | true | null | false | write |
| e2e-pilot-1 | T5-s1-E1-r1 | no | false | null | true | schema |
| e2e-pilot-1 | T5-s1-S-r1 | no | false | null | true | schema |
| e2e-pilot-1 | T5-s1-E1-r2 | no | false | null | true | schema |
| e2e-pilot-1 | T5-s1-S-r2 | no | false | null | true | schema |
| e2e-t5-retest-1 | T5B-s2-E0-r2 | no | false | null | true | schema |
| e2e-recall-1 | T2-s1-E0-r1 | no | false | null | false | produce |
| e2e-recall-1 | T2-s1-E0a-r1 | no | false | null | true | schema |
| e2e-recall-1 | T2-s2-E0-r2 | no | false | null | true | schema |
| e2e-recall-1 | T2-s2-E0a-r2 | no | false | null | false | produce |
| e2e-recall-1 | T4-s1-E0a-r1 | no | false | true | false | produce |
| e2e-recall-1 | T4-s2-E0a-r2 | no | true | true | false | write |
| e2e-recall-1 | T5B-s1-E0-r1 | no | false | null | false | produce |
| e2e-recall-1 | T5B-s1-E0a-r1 | no | false | null | false | produce |
| e2e-recall-1 | T5B-s2-E0-r2 | no | false | null | false | produce |
| e2e-guard-smoke-1 | T2-s1-E0-r0 | no | false | true | true | schema |
| e2e-index-1 | T2-s1-E0-r1 | no | true | true | false | write |
| e2e-index-1 | T2-s1-E0i-r1 | no | false | true | true | verify |
| e2e-index-1 | T2-s1-E0ai-r1 | no | false | true | false | produce |
| e2e-index-1 | T2-s2-E0-r1 | no | false | true | false | produce |
| e2e-index-1 | T2-s2-E0i-r1 | no | false | true | false | produce |
| e2e-index-1 | T2-s2-E0ai-r1 | no | true | true | false | write |
| e2e-index-1 | T4-s1-E0-r1 | no | true | true | true | verify |
| e2e-index-1 | T4-s1-E0i-r1 | no | false | true | false | produce |
| e2e-index-1 | T4-s1-E0ai-r1 | no | true | true | false | write |
| e2e-index-1 | T4-s2-E0i-r1 | no | true | true | false | write |
| e2e-index-1 | T4-s2-E0ai-r1 | no | true | true | false | write |
| e2e-index-1 | T2-s1-E0-r2 | no | false | true | false | produce |
| e2e-index-1 | T2-s1-E0i-r2 | no | true | true | false | write |
| e2e-index-1 | T2-s1-E0ai-r2 | no | false | true | false | produce |
| e2e-index-1 | T2-s2-E0-r2 | no | false | true | true | verify |
| e2e-index-1 | T2-s2-E0i-r2 | no | false | true | false | produce |
| e2e-index-1 | T2-s2-E0ai-r2 | no | false | true | false | produce |
| e2e-index-1 | T4-s1-E0i-r2 | no | true | true | false | write |
| e2e-index-1 | T4-s1-E0ai-r2 | no | false | true | false | produce |
| e2e-index-1 | T4-s2-E0-r2 | no | true | true | false | write |
| e2e-index-1 | T4-s2-E0i-r2 | no | true | true | false | write |
