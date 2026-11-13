# EF-E2E core campaign — e2e-lg-confirm-1

Status: **complete**. 120/120 cells executed.

| Arm | Cells | Pass | Rate | Folds | No-fold | Recall cells | Requests | Aux | Input | Output |
|---|---|---|---|---|---|---|---|---|---|---|
| B0 | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0 | 24 | 9 | 0.375 | 54 | 0 | 14 | 83 | 0 | 678175 | 10569 |
| E0a | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0i | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0ai | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E0-L | 24 | 15 | 0.625 | 51 | 0 | 15 | 77 | 0 | 842370 | 9963 |
| E0-G | 24 | 15 | 0.625 | 72 | 0 | 14 | 145 | 0 | 919738 | 19764 |
| E0-LG | 24 | 16 | 0.667 | 62 | 0 | 15 | 113 | 0 | 967562 | 15937 |
| E1 | 24 | 18 | 0.75 | 11 | 13 | 2 | 96 | 42 | 295420 | 16727 |
| S | 0 | 0 | null | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Template | Arm | Pass | Rate | Mean folds | Mean requests | Aux requests | Mean input | Mean output |
|---|---|---|---|---|---|---|---|---|
| T10 | B0 | 0/0 | null | null | null | 0 | null | null |
| T10 | E0 | 0/4 | 0 | 5 | 6.75 | 0 | 56009.75 | 970.5 |
| T10 | E0a | 0/0 | null | null | null | 0 | null | null |
| T10 | E0i | 0/0 | null | null | null | 0 | null | null |
| T10 | E0ai | 0/0 | null | null | null | 0 | null | null |
| T10 | E0-L | 1/4 | 0.25 | 4.25 | 5.25 | 0 | 51110.25 | 691 |
| T10 | E0-G | 2/4 | 0.5 | 8.5 | 14.75 | 0 | 106315.25 | 2029 |
| T10 | E0-LG | 1/4 | 0.25 | 6.75 | 11 | 0 | 72028.5 | 1744.25 |
| T10 | E1 | 1/4 | 0.25 | 0.25 | 4.75 | 8 | 9769.25 | 1020.5 |
| T10 | S | 0/0 | null | null | null | 0 | null | null |
| T2 | B0 | 0/0 | null | null | null | 0 | null | null |
| T2 | E0 | 0/4 | 0 | 1.75 | 2 | 0 | 34277.25 | 469.5 |
| T2 | E0a | 0/0 | null | null | null | 0 | null | null |
| T2 | E0i | 0/0 | null | null | null | 0 | null | null |
| T2 | E0ai | 0/0 | null | null | null | 0 | null | null |
| T2 | E0-L | 1/4 | 0.25 | 3 | 3.5 | 0 | 82853.5 | 733.5 |
| T2 | E0-G | 2/4 | 0.5 | 2.25 | 6 | 0 | 35305.75 | 1158 |
| T2 | E0-LG | 0/4 | 0 | 2.75 | 4.75 | 0 | 87276.75 | 967 |
| T2 | E1 | 4/4 | 1 | 1 | 3 | 4 | 16855.5 | 703.75 |
| T2 | S | 0/0 | null | null | null | 0 | null | null |
| T4 | B0 | 0/0 | null | null | null | 0 | null | null |
| T4 | E0 | 1/4 | 0.25 | 2 | 3.5 | 0 | 15127.75 | 463 |
| T4 | E0a | 0/0 | null | null | null | 0 | null | null |
| T4 | E0i | 0/0 | null | null | null | 0 | null | null |
| T4 | E0ai | 0/0 | null | null | null | 0 | null | null |
| T4 | E0-L | 4/4 | 1 | 1 | 3 | 0 | 14214.5 | 257.75 |
| T4 | E0-G | 1/4 | 0.25 | 2.25 | 4.75 | 0 | 19889 | 648.75 |
| T4 | E0-LG | 4/4 | 1 | 1 | 3 | 0 | 14176.5 | 270.75 |
| T4 | E1 | 4/4 | 1 | 1 | 3 | 4 | 14178.25 | 437.5 |
| T4 | S | 0/0 | null | null | null | 0 | null | null |
| T7 | B0 | 0/0 | null | null | null | 0 | null | null |
| T7 | E0 | 2/4 | 0.5 | 1 | 2 | 0 | 17694 | 107 |
| T7 | E0a | 0/0 | null | null | null | 0 | null | null |
| T7 | E0i | 0/0 | null | null | null | 0 | null | null |
| T7 | E0ai | 0/0 | null | null | null | 0 | null | null |
| T7 | E0-L | 3/4 | 0.75 | 1 | 1.75 | 0 | 17641.5 | 148.25 |
| T7 | E0-G | 4/4 | 1 | 1 | 2 | 0 | 17693 | 107.5 |
| T7 | E0-LG | 4/4 | 1 | 1 | 2.25 | 0 | 17717 | 140.25 |
| T7 | E1 | 3/4 | 0.75 | 0 | 5 | 10 | 9654 | 713.25 |
| T7 | S | 0/0 | null | null | null | 0 | null | null |
| T8 | B0 | 0/0 | null | null | null | 0 | null | null |
| T8 | E0 | 3/4 | 0.75 | 1 | 2 | 0 | 17167 | 110.25 |
| T8 | E0a | 0/0 | null | null | null | 0 | null | null |
| T8 | E0i | 0/0 | null | null | null | 0 | null | null |
| T8 | E0ai | 0/0 | null | null | null | 0 | null | null |
| T8 | E0-L | 4/4 | 1 | 1 | 2.5 | 0 | 17260.5 | 127.5 |
| T8 | E0-G | 4/4 | 1 | 1 | 2 | 0 | 17153.5 | 101.75 |
| T8 | E0-LG | 3/4 | 0.75 | 1 | 2.25 | 0 | 17163.5 | 137 |
| T8 | E1 | 4/4 | 1 | 0 | 5 | 10 | 9302.5 | 666.5 |
| T8 | S | 0/0 | null | null | null | 0 | null | null |
| T9 | B0 | 0/0 | null | null | null | 0 | null | null |
| T9 | E0 | 3/4 | 0.75 | 2.75 | 4.5 | 0 | 29268 | 522 |
| T9 | E0a | 0/0 | null | null | null | 0 | null | null |
| T9 | E0i | 0/0 | null | null | null | 0 | null | null |
| T9 | E0ai | 0/0 | null | null | null | 0 | null | null |
| T9 | E0-L | 2/4 | 0.5 | 2.5 | 3.25 | 0 | 27512.25 | 532.75 |
| T9 | E0-G | 2/4 | 0.5 | 3 | 6.75 | 0 | 33578 | 896 |
| T9 | E0-LG | 4/4 | 1 | 3 | 5 | 0 | 33528.25 | 725 |
| T9 | E1 | 2/4 | 0.5 | 0.5 | 3.25 | 6 | 14095.5 | 640.25 |
| T9 | S | 0/0 | null | null | null | 0 | null | null |

## Per-cell

| Cell | Block | Exposure | Folds (fail) | Check | Recall | Req (aux) | In | Out | Probes visible |
|---|---|---|---|---|---|---|---|---|---|
| T2-s1-E0-G-r1 | lg-confirm | fold | 4 (0) | pass | 3 | 10 (0) | 89042 | 2014 | 0/2 |
| T2-s1-E0-LG-r1 | lg-confirm | fold | 2 (0) | fail | 1 | 4 (0) | 86255 | 1026 | 0/2 |
| T2-s1-E1-r1 | lg-confirm | fold | 1 (0) | pass | 0 | 3 (1) | 16805 | 604 | 2/2 |
| T2-s1-E0-r1 | lg-confirm | fold | 1 (0) | fail | 0 | 1 (0) | 15969 | 196 | 0/2 |
| T2-s1-E0-L-r1 | lg-confirm | fold | 2 (0) | fail | 2 | 2 (0) | 86569 | 465 | 0/2 |
| T2-s1-E0-LG-r2 | lg-confirm | fold | 5 (0) | fail | 4 | 8 (0) | 159628 | 1123 | 0/2 |
| T2-s1-E1-r2 | lg-confirm | fold | 1 (0) | pass | 0 | 3 (1) | 16713 | 920 | 2/2 |
| T2-s1-E0-r2 | lg-confirm | fold | 1 (0) | fail | 0 | 1 (0) | 15970 | 355 | 0/2 |
| T2-s1-E0-L-r2 | lg-confirm | fold | 5 (0) | pass | 8 | 7 (0) | 125261 | 1057 | 0/2 |
| T2-s1-E0-G-r2 | lg-confirm | fold | 2 (0) | pass | 2 | 5 (0) | 18128 | 718 | 0/2 |
| T2-s2-E0-LG-r1 | lg-confirm | fold | 2 (0) | fail | 1 | 4 (0) | 85825 | 793 | 0/2 |
| T2-s2-E1-r1 | lg-confirm | fold | 1 (0) | pass | 0 | 3 (1) | 16925 | 670 | 2/2 |
| T2-s2-E0-r1 | lg-confirm | fold | 3 (0) | fail | 3 | 3 (0) | 87246 | 673 | 0/2 |
| T2-s2-E0-L-r1 | lg-confirm | fold | 1 (0) | fail | 0 | 1 (0) | 16136 | 248 | 0/2 |
| T2-s2-E0-G-r1 | lg-confirm | fold | 1 (0) | fail | 0 | 2 (0) | 16271 | 470 | 0/2 |
| T2-s2-E1-r2 | lg-confirm | fold | 1 (0) | pass | 0 | 3 (1) | 16979 | 621 | 2/2 |
| T2-s2-E0-r2 | lg-confirm | fold | 2 (0) | fail | 3 | 3 (0) | 17924 | 654 | 0/2 |
| T2-s2-E0-L-r2 | lg-confirm | fold | 4 (0) | fail | 4 | 4 (0) | 103448 | 1164 | 0/2 |
| T2-s2-E0-G-r2 | lg-confirm | fold | 2 (0) | fail | 0 | 7 (0) | 17782 | 1430 | 0/2 |
| T2-s2-E0-LG-r2 | lg-confirm | fold | 2 (0) | fail | 0 | 3 (0) | 17399 | 926 | 0/2 |
| T4-s1-E0-LG-r1 | lg-confirm | fold | 1 (0) | pass | 1 | 3 (0) | 13952 | 262 | 1/2 |
| T4-s1-E1-r1 | lg-confirm | fold | 1 (0) | pass | 0 | 3 (1) | 13966 | 397 | 2/2 |
| T4-s1-E0-r1 | lg-confirm | fold | 2 (0) | fail | 1 | 3 (0) | 14529 | 388 | 1/2 |
| T4-s1-E0-L-r1 | lg-confirm | fold | 1 (0) | pass | 1 | 3 (0) | 13946 | 278 | 1/2 |
| T4-s1-E0-G-r1 | lg-confirm | fold | 3 (0) | fail | 3 | 5 (0) | 32606 | 1011 | 1/2 |
| T4-s1-E1-r2 | lg-confirm | fold | 1 (0) | pass | 0 | 3 (1) | 14098 | 446 | 2/2 |
| T4-s1-E0-r2 | lg-confirm | fold | 2 (0) | fail | 2 | 3 (0) | 14631 | 407 | 1/2 |
| T4-s1-E0-L-r2 | lg-confirm | fold | 1 (0) | pass | 1 | 3 (0) | 13996 | 250 | 1/2 |
| T4-s1-E0-G-r2 | lg-confirm | fold | 2 (0) | pass | 3 | 5 (0) | 15391 | 440 | 0/2 |
| T4-s1-E0-LG-r2 | lg-confirm | fold | 1 (0) | pass | 1 | 3 (0) | 13936 | 253 | 1/2 |
| T4-s2-E1-r1 | lg-confirm | fold | 1 (0) | pass | 0 | 3 (1) | 14334 | 441 | 2/2 |
| T4-s2-E0-r1 | lg-confirm | fold | 2 (0) | fail | 3 | 3 (0) | 15788 | 708 | 1/2 |
| T4-s2-E0-L-r1 | lg-confirm | fold | 1 (0) | pass | 1 | 3 (0) | 14454 | 246 | 1/2 |
| T4-s2-E0-G-r1 | lg-confirm | fold | 2 (0) | fail | 2 | 4 (0) | 15700 | 589 | 1/2 |
| T4-s2-E0-LG-r1 | lg-confirm | fold | 1 (0) | pass | 1 | 3 (0) | 14360 | 278 | 1/2 |
| T4-s2-E0-r2 | lg-confirm | fold | 2 (0) | pass | 3 | 5 (0) | 15563 | 349 | 1/2 |
| T4-s2-E0-L-r2 | lg-confirm | fold | 1 (0) | pass | 1 | 3 (0) | 14462 | 257 | 1/2 |
| T4-s2-E0-G-r2 | lg-confirm | fold | 2 (0) | fail | 2 | 5 (0) | 15859 | 555 | 1/2 |
| T4-s2-E0-LG-r2 | lg-confirm | fold | 1 (0) | pass | 1 | 3 (0) | 14458 | 290 | 1/2 |
| T4-s2-E1-r2 | lg-confirm | fold | 1 (0) | pass | 0 | 3 (1) | 14315 | 466 | 2/2 |
| T7-s1-E1-r1 | lg-confirm | fold | 0 (2) | pass | 0 | 4 (2) | 18109 | 539 | — |
| T7-s1-E0-r1 | lg-confirm | fold | 1 (0) | fail | 0 | 2 (0) | 17601 | 112 | 0/0 |
| T7-s1-E0-L-r1 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17601 | 135 | 0/0 |
| T7-s1-E0-G-r1 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17601 | 103 | 0/0 |
| T7-s1-E0-LG-r1 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17626 | 146 | 0/0 |
| T7-s1-E0-r2 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17603 | 115 | 0/0 |
| T7-s1-E0-L-r2 | lg-confirm | fold | 1 (0) | fail | 0 | 1 (0) | 17393 | 262 | 0/0 |
| T7-s1-E0-G-r2 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17601 | 100 | 0/0 |
| T7-s1-E0-LG-r2 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17616 | 142 | 0/0 |
| T7-s1-E1-r2 | lg-confirm | fold | 0 (2) | fail | 0 | 4 (2) | 829 | 767 | — |
| T7-s2-E0-r1 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17783 | 84 | 0/0 |
| T7-s2-E0-L-r1 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17785 | 97 | 0/0 |
| T7-s2-E0-G-r1 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17783 | 96 | 0/0 |
| T7-s2-E0-LG-r1 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17705 | 145 | 0/0 |
| T7-s2-E1-r1 | lg-confirm | fold | 0 (4) | pass | 0 | 8 (4) | 18927 | 1038 | — |
| T7-s2-E0-L-r2 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17787 | 99 | 0/0 |
| T7-s2-E0-G-r2 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17787 | 131 | 0/0 |
| T7-s2-E0-LG-r2 | lg-confirm | fold | 1 (0) | pass | 0 | 3 (0) | 17921 | 128 | 0/0 |
| T7-s2-E1-r2 | lg-confirm | fold | 0 (2) | pass | 0 | 4 (2) | 751 | 509 | — |
| T7-s2-E0-r2 | lg-confirm | fold | 1 (0) | fail | 0 | 2 (0) | 17789 | 117 | 0/0 |
| T8-s1-E0-r1 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17154 | 102 | 0/0 |
| T8-s1-E0-L-r1 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17164 | 76 | 0/0 |
| T8-s1-E0-G-r1 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17158 | 126 | 0/0 |
| T8-s1-E0-LG-r1 | lg-confirm | fold | 1 (0) | fail | 0 | 2 (0) | 17094 | 222 | 0/0 |
| T8-s1-E1-r1 | lg-confirm | fold | 0 (3) | pass | 0 | 6 (3) | 18102 | 720 | — |
| T8-s1-E0-L-r2 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17154 | 87 | 0/0 |
| T8-s1-E0-G-r2 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17158 | 71 | 0/0 |
| T8-s1-E0-LG-r2 | lg-confirm | fold | 1 (0) | pass | 0 | 3 (0) | 17256 | 142 | 0/0 |
| T8-s1-E1-r2 | lg-confirm | fold | 0 (3) | pass | 0 | 6 (3) | 986 | 802 | — |
| T8-s1-E0-r2 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17160 | 104 | 0/0 |
| T8-s2-E0-L-r1 | lg-confirm | fold | 1 (0) | pass | 0 | 4 (0) | 17574 | 219 | 0/0 |
| T8-s2-E0-G-r1 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17150 | 107 | 0/0 |
| T8-s2-E0-LG-r1 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17152 | 97 | 0/0 |
| T8-s2-E1-r1 | lg-confirm | fold | 0 (2) | pass | 0 | 4 (2) | 17370 | 490 | — |
| T8-s2-E0-r1 | lg-confirm | fold | 1 (0) | fail | 0 | 2 (0) | 17162 | 108 | 0/0 |
| T8-s2-E0-G-r2 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17148 | 103 | 0/0 |
| T8-s2-E0-LG-r2 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17152 | 87 | 0/0 |
| T8-s2-E1-r2 | lg-confirm | fold | 0 (2) | pass | 0 | 4 (2) | 752 | 654 | — |
| T8-s2-E0-r2 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17192 | 127 | 0/0 |
| T8-s2-E0-L-r2 | lg-confirm | fold | 1 (0) | pass | 0 | 2 (0) | 17150 | 128 | 0/0 |
| T9-s1-E0-L-r1 | lg-confirm | fold | 2 (0) | pass | 2 | 3 (0) | 18927 | 364 | 0/0 |
| T9-s1-E0-G-r1 | lg-confirm | fold | 4 (0) | fail | 5 | 11 (0) | 39759 | 1590 | 0/0 |
| T9-s1-E0-LG-r1 | lg-confirm | fold | 3 (0) | pass | 4 | 6 (0) | 39671 | 998 | 0/0 |
| T9-s1-E1-r1 | lg-confirm | fold | 0 (1) | fail | 0 | 2 (1) | 18056 | 634 | — |
| T9-s1-E0-r1 | lg-confirm | fold | 4 (0) | pass | 8 | 7 (0) | 42070 | 900 | 0/0 |
| T9-s1-E0-G-r2 | lg-confirm | fold | 2 (0) | pass | 2 | 4 (0) | 19699 | 284 | 0/0 |
| T9-s1-E0-LG-r2 | lg-confirm | fold | 2 (0) | pass | 2 | 3 (0) | 18865 | 354 | 0/0 |
| T9-s1-E1-r2 | lg-confirm | fold | 1 (1) | fail | 1 | 4 (2) | 2320 | 869 | 0/0 |
| T9-s1-E0-r2 | lg-confirm | fold | 2 (0) | pass | 2 | 4 (0) | 19717 | 289 | 0/0 |
| T9-s1-E0-L-r2 | lg-confirm | fold | 4 (0) | fail | 3 | 5 (0) | 54177 | 901 | 0/0 |
| T9-s2-E0-G-r1 | lg-confirm | fold | 2 (0) | fail | 1 | 6 (0) | 18928 | 1054 | 0/0 |
| T9-s2-E0-LG-r1 | lg-confirm | fold | 2 (0) | pass | 2 | 3 (0) | 18562 | 342 | 0/0 |
| T9-s2-E1-r1 | lg-confirm | fold | 1 (0) | pass | 0 | 3 (1) | 18029 | 365 | 0/0 |
| T9-s2-E0-r1 | lg-confirm | fold | 3 (0) | pass | 3 | 5 (0) | 36584 | 564 | 0/0 |
| T9-s2-E0-L-r1 | lg-confirm | fold | 2 (0) | pass | 2 | 3 (0) | 18568 | 391 | 0/0 |
| T9-s2-E0-LG-r2 | lg-confirm | fold | 5 (0) | pass | 7 | 8 (0) | 57015 | 1206 | 0/0 |
| T9-s2-E1-r2 | lg-confirm | fold | 0 (2) | pass | 0 | 4 (2) | 17977 | 693 | — |
| T9-s2-E0-r2 | lg-confirm | fold | 2 (0) | fail | 2 | 2 (0) | 18701 | 335 | 0/0 |
| T9-s2-E0-L-r2 | lg-confirm | fold | 2 (0) | fail | 2 | 2 (0) | 18377 | 475 | 0/0 |
| T9-s2-E0-G-r2 | lg-confirm | fold | 4 (0) | pass | 5 | 6 (0) | 55926 | 656 | 0/0 |
| T10-s1-E0-G-r1 | lg-confirm | fold | 7 (0) | pass | 11 | 13 (0) | 78311 | 1338 | 0/0 |
| T10-s1-E0-LG-r1 | lg-confirm | fold | 4 (0) | fail | 4 | 9 (0) | 38945 | 1617 | 0/0 |
| T10-s1-E1-r1 | lg-confirm | fold | 1 (1) | fail | 1 | 7 (2) | 19751 | 1493 | 0/0 |
| T10-s1-E0-r1 | lg-confirm | fold | 2 (0) | fail | 2 | 3 (0) | 18913 | 576 | 0/0 |
| T10-s1-E0-L-r1 | lg-confirm | fold | 4 (0) | pass | 2 | 4 (0) | 53231 | 325 | 0/0 |
| T10-s1-E0-LG-r2 | lg-confirm | fold | 7 (0) | fail | 13 | 10 (0) | 79533 | 1787 | 0/0 |
| T10-s1-E1-r2 | lg-confirm | fold | 0 (2) | pass | 0 | 4 (2) | 942 | 811 | — |
| T10-s1-E0-r2 | lg-confirm | fold | 5 (0) | fail | 10 | 8 (0) | 60018 | 1159 | 0/0 |
| T10-s1-E0-L-r2 | lg-confirm | fold | 2 (0) | fail | 1 | 4 (0) | 18609 | 408 | 0/0 |
| T10-s1-E0-G-r2 | lg-confirm | fold | 11 (0) | fail | 19 | 17 (0) | 125039 | 2026 | 0/0 |
| T10-s2-E0-LG-r1 | lg-confirm | fold | 12 (0) | fail | 18 | 17 (0) | 131719 | 2240 | 0/0 |
| T10-s2-E1-r1 | lg-confirm | fold | 0 (2) | fail | 0 | 4 (2) | 17640 | 809 | — |
| T10-s2-E0-r1 | lg-confirm | fold | 7 (0) | fail | 9 | 8 (0) | 83010 | 1075 | 0/0 |
| T10-s2-E0-L-r1 | lg-confirm | fold | 7 (0) | fail | 12 | 8 (0) | 79477 | 1292 | 0/0 |
| T10-s2-E0-G-r1 | lg-confirm | fold | 6 (0) | fail | 10 | 12 (0) | 76906 | 1975 | 0/0 |
| T10-s2-E1-r2 | lg-confirm | fold | 0 (2) | fail | 0 | 4 (2) | 744 | 969 | — |
| T10-s2-E0-r2 | lg-confirm | fold | 6 (0) | fail | 11 | 8 (0) | 62098 | 1072 | 0/0 |
| T10-s2-E0-L-r2 | lg-confirm | fold | 4 (0) | fail | 2 | 5 (0) | 53124 | 739 | 0/0 |
| T10-s2-E0-G-r2 | lg-confirm | fold | 10 (0) | pass | 18 | 17 (0) | 145005 | 2777 | 0/0 |
| T10-s2-E0-LG-r2 | lg-confirm | fold | 4 (0) | pass | 4 | 8 (0) | 37917 | 1333 | 0/0 |

## What this table does not say

- The two seeds of a template are not two independent tasks; do not pool them into a population estimate.
- A checker failure is a task outcome, not an invalid measurement. Invalid cells are labelled separately.
- `inputTokens` is the provider's uncached input. Cache reads are reported in the JSON, not folded into this column.
- No cost in currency is claimed: this route has no verifiable per-token price.
