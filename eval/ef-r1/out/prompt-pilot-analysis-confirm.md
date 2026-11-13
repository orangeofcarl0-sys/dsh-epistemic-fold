# EF-R1 — prompt-protection pilot

Campaign `e2e-prompt-confirm-1`, 24 cells, 112 requests, 817764 input, 22570 output.

| Arm | Pass | Prompt visible at end | Prompt lost | No fold | Mean retained | Requests | Input |
|---|---|---|---|---|---|---|---|
| E0 | 2/8 | 2/8 | 6/8 | 0/8 | 18567 | 39 | 350935 |
| E0-R | 4/8 | 8/8 | 0/8 | 0/8 | 14150 | 44 | 326813 |

## Paired by task

| Task | E0 pass | E0-R pass | E0 prompt lost | E0-R prompt lost |
|---|---|---|---|---|
| T10-s1 | no | yes | yes | no |
| T10-s2 | no | yes | yes | no |
| T2-s1 | no | no | no | no |
| T2-s2 | no | no | no | no |
| T4-s1 | no | yes | yes | no |
| T4-s2 | no | yes | yes | no |
| T9-s1 | yes | no | yes | no |
| T9-s2 | yes | no | yes | no |

Improved **4**, worsened **2**, tied **2**. Prompt lost E0 **6**, E0-R **0**. n=4 pairs; a direction check.

## The treatment folded normally

Every E0-R cell folded (no economic refusal) and retained fewer tokens on average, so the comparison is a real fold-vs-fold difference. The request is preserved by a runtime-authored copy in the checkpoint body, not by blocking compression.
