# EF-R1 — prompt-protection pilot

Campaign `e2e-prompt-pilot-2`, 8 cells, 24 requests, 117205 input, 3341 output.

| Arm | Pass | Prompt visible at end | Prompt lost | No fold | Mean retained | Requests | Input |
|---|---|---|---|---|---|---|---|
| E0 | 0/4 | 0/4 | 4/4 | 0/4 | 5593 | 16 | 115618 |
| E0-P | 3/4 | 4/4 | 0/4 | 4/4 | 18768 | 8 | 1587 |

## Paired by task

| Task | E0 pass | E0-P pass | E0 prompt lost | E0-P prompt lost |
|---|---|---|---|---|
| T10-s1 | no | yes | yes | no |
| T10-s2 | no | yes | yes | no |
| T9-s1 | no | no | yes | no |
| T9-s2 | no | yes | yes | no |

Improved **3**, worsened **0**, tied **1**. Prompt lost E0 **4**, E0-P **0**. n=4 pairs; a direction check.

## The caveat that decides the reading

**Every E0-P cell was an economic refusal, not a fold around the prompt.** The span after the active request was ~133 tokens and the checkpoint ~530, so the admission refused it; the cell retained the full ~18–19k surface. The pass rate is therefore a comparison of **no-fold vs fold**, not of "prompt protected during a fold" vs fold. Starting the leaf after the request is not a viable protection: it disables compression on this workload. The next design must fold normally and re-render the active request verbatim in the checkpoint (or re-pin it after the fold), not block the span.
