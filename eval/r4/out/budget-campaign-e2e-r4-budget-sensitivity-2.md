# EF-R4 budget-sensitivity campaign — e2e-r4-budget-sensitivity-2

Status: **partial**, stop: `runner-error: Error: EEXIST: file already exists, mkdir 'F:\Codex_Work_Space\DSH plugin\ef-c1-foundation\eval\e2e\runs\e2e-r4-budget-sensitivity-2\T11-p1-B0-r1'
    at async mkdir (node:internal/fs/promises:859:10)
    at async runCell (file:///F:/Codex_Work_Space/DSH%20plugin/ef-c1-foundation/eval/e2e/src/cell.mjs:451:3)
    at async main (file:///F:/Codex_Work_Space/DSH%20plugin/ef-c1-foundation/eval/e2e/src/run.mjs:309:16)
    at async file:///F:/Codex_Work_Space/DSH%20plugin/ef-c1-foundation/eval/e2e/src/run.mjs:401:1`, executed **18/36**.

| Arm | Budget | Cells | Correct | Incorrect | Incomplete | Step-limited | Mechanism | Cost-valid | Budget aborts | Requests | Input | Output |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B0 | 8 | 3 | 2 | 0 | 1 | 0 | 0 | 3 | 0 | 35 | 82165 | 11287 |
| B0 | 16 | 3 | 2 | 0 | 1 | 0 | 0 | 3 | 0 | 17 | 76080 | 3233 |
| E0 | 8 | 3 | 2 | 0 | 1 | 1 | 0 | 3 | 0 | 17 | 216932 | 2002 |
| E0 | 16 | 3 | 0 | 0 | 3 | 0 | 1 | 3 | 0 | 26 | 163885 | 3591 |
| E1 | 8 | 3 | 2 | 0 | 1 | 0 | 0 | 3 | 0 | 15 | 104381 | 2214 |
| E1 | 16 | 3 | 3 | 0 | 0 | 0 | 1 | 3 | 0 | 18 | 121084 | 2969 |

## Paired comparisons

| Comparison | Pairs | Both | Neither | Left only | Right only | p |
|---|---|---|---|---|---|---|
| B0-16-vs-8 | 0 | 0 | 0 | 0 | 0 | 1 |
| E0-16-vs-8 | 0 | 0 | 0 | 0 | 0 | 1 |
| E1-16-vs-8 | 0 | 0 | 0 | 0 | 0 | 1 |
| E1-vs-B0@8 | 1 | 1 | 0 | 0 | 0 | 1 |
| E1-vs-B0@16 | 1 | 1 | 0 | 0 | 0 | 1 |

## Per-cell

| Cell | Arm | Budget | Outcome | Mechanism | Termination | Cost-valid | Budget aborts |
|---|---|---|---|---|---|---|---|
| T11-p1-B0-r1 | B0 | 8 | correct | — | finish | valid | 0 |
| T11-p1-E0-r1 | E0 | 16 | incomplete | — | finish | valid | 0 |
| T11-p1-E1-r1 | E1 | 8 | correct | — | finish | valid | 0 |
| T12-p1-B0-r1 | B0 | 16 | incomplete | — | finish | valid | 0 |
| T12-p1-E0-r1 | E0 | 16 | incomplete | — | finish | valid | 0 |
| T12-p1-E1-r1 | E1 | 8 | incomplete | — | finish | valid | 0 |
| T13-p1-B0-r1 | B0 | 16 | correct | — | finish | valid | 0 |
| T13-p1-E0-r1 | E0 | 8 | incomplete | — | finish | valid | 0 |
| T13-p1-E1-r1 | E1 | 8 | correct | — | finish | valid | 0 |
| T14-p1-B0-r1 | B0 | 16 | correct | — | finish | valid | 0 |
| T14-p1-E0-r1 | E0 | 8 | correct | — | finish | valid | 0 |
| T14-p1-E1-r1 | E1 | 16 | correct | — | finish | valid | 0 |
| T15-p1-B0-r1 | B0 | 8 | correct | — | finish | valid | 0 |
| T15-p1-E0-r1 | E0 | 8 | correct | — | step-limit | valid | 0 |
| T15-p1-E1-r1 | E1 | 16 | correct | — | finish | valid | 0 |
| T16-p1-B0-r1 | B0 | 8 | incomplete | miss | finish | valid | 0 |
| T16-p1-E0-r1 | E0 | 16 | incomplete | met | finish | valid | 0 |
| T16-p1-E1-r1 | E1 | 16 | correct | met | finish | valid | 0 |

