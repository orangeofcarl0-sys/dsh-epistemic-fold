# EF-R2 — cost ledger

| Arm | Cells | Pass | Requests | Input | Output | Aux calls | Rationale calls | Attempts | Commits | Refused | Delivered | Bundle bytes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| E0 | 24 | 9 | 83 | 678175 | 10569 | 0 | 0 | 54 | 54 | 0 | 54 | 318114 |
| E0-L | 24 | 15 | 77 | 842370 | 9963 | 0 | 0 | 51 | 48 | 0 | 48 | 286548 |
| E0-G | 24 | 15 | 145 | 919738 | 19764 | 0 | 0 | 72 | 71 | 0 | 71 | 448435 |
| E0-LG | 24 | 16 | 113 | 967562 | 15937 | 0 | 0 | 62 | 62 | 0 | 62 | 405494 |
| E1 | 24 | 18 | 96 | 295420 | 16727 | 42 | 42 | 42 | 11 | 31 | 11 | 173918 |

E1 failed calls: 31 calls, 7083 input, 7890 output (47.2% of E1 output).

Repeated failed calls: 16 calls, 3510 input, 4241 output. First-attempt failed calls: 15, 3573 input, 3649 output.

Reconciliation: matches (campaign 514/3703265/72960).

Caps: per-cell output 20000; rationale max observed 16384; observed max single-request output 1024.

