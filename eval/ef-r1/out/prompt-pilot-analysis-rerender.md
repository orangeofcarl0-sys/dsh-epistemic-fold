# EF-R1 — prompt-protection pilot

Campaign `e2e-prompt-rerender-1`, 8 cells, 36 requests, 279579 input, 4239 output.

| Arm | Pass | Prompt visible at end | Prompt lost | No fold | Mean retained | Requests | Input |
|---|---|---|---|---|---|---|---|
| E0 | 1/4 | 0/4 | 4/4 | 0/4 | 15795 | 18 | 151262 |
| E0-R | 4/4 | 4/4 | 0/4 | 0/4 | 11388 | 18 | 128317 |

## Paired by task

| Task | E0 pass | E0-R pass | E0 prompt lost | E0-R prompt lost |
|---|---|---|---|---|
| T10-s1 | no | yes | yes | no |
| T10-s2 | no | yes | yes | no |
| T9-s1 | no | yes | yes | no |
| T9-s2 | yes | yes | yes | no |

Improved **3**, worsened **0**, tied **1**. Prompt lost E0 **4**, E0-R **0**. n=4 pairs; a direction check.

## The treatment folded normally

Every E0-R cell folded (no economic refusal) and retained fewer tokens on average, so the comparison is a real fold-vs-fold difference. The request is preserved by a runtime-authored copy in the checkpoint body, not by blocking compression.
