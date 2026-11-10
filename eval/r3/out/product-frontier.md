# EF-R3 — quality, cost and reliability (stress lane)

Pilot and confirm are separate instance sets. They are not pooled. The confirm is partial: **23/54 valid**.

## Arms

| Campaign | Arm | Pass | Committed | Delivered | Cost-valid | Requests | Uncached input | Cache read | Output |
|---|---|---|---|---|---|---|---|---|---|
| e2e-r2-pilot-1 | B0 | 5/6 | 20 | 16 | 4/6 | 77 | 916786 | 66816 | 39463 |
| e2e-r2-pilot-1 | E0 | 2/6 | 24 | 23 | 5/6 | 49 | 736288 | 54912 | 8875 |
| e2e-r2-pilot-1 | E1 | 6/6 | 9 | 9 | 6/6 | 47 | 711836 | 110720 | 13886 |
| e2e-r2-confirm-merged | B0 | 4/7 | 18 | 15 | 6/7 | 90 | 708122 | 229248 | 37741 |
| e2e-r2-confirm-merged | E0 | 1/7 | 33 | 30 | 7/7 | 55 | 811541 | 46848 | 10074 |
| e2e-r2-confirm-merged | E1 | 5/9 | 17 | 17 | 7/9 | 68 | 975989 | 42752 | 20374 |

## Paired E1 − B0

| Campaign | Pairs | Both | Neither | E1 only | B0 only | McNemar p | Recorded pass | Recorded requests | Recorded input | Recorded cache read | Recorded output | Cost-valid pairs | Cost-valid input | Cost-valid output |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| e2e-r2-pilot-1 | 6 | 5 | 0 | 1 | 0 | 1 | 1 | -30 | -204950 | 43904 | -25577 | 4 | -85646 | -12935 |
| e2e-r2-confirm-merged | 7 | 4 | 3 | 0 | 0 | 1 | 0 | -28 | 169138 | -186496 | -18954 | 5 | 141527 | -12552 |

`recorded` includes cells with partial usage; `cost-valid` keeps only pairs where both sides reported every request. Neither is a USD price.

## Eligibility

| Campaign | Valid | Unresolved | Never-started | Cost-invalid valid cells | Config-mismatch cells |
|---|---|---|---|---|---|
| e2e-r2-pilot-1 | 18 | 0 | 0 | 3 | 6 |
| e2e-r2-confirm-merged | 23 | 1 | 30 | 3 | 18 |

## Missing by template (confirm)

`{"T11":0,"T12":0,"T13":4,"T14":9,"T15":9,"T16":9}`

T14-T16 have no valid confirm cells. The 23-cell valid subset is therefore task-type biased, not a random 23 of 54.

## Stress lane vs shipped presets

| Lane | Window | Retain | Framing | Hint | Data |
|---|---|---|---|---|---|
| 16k stress | 16384 | 0.04 | legacy | 400 effective (800 declared) | observed |
| economy | product-dependent | 0.16 | system-dedup | 400 | not executed |
| balanced | product-dependent | 0.24 | system-dedup | 800 | not executed |
| quality | product-dependent | 0.24 | system-dedup | 1600 | not executed |

## Exact-span economics

Deterministic keyless matrix: **60** cases. Widest span {"count":60,"min":12384,"median":12384,"max":12384}, executed span {"count":60,"min":9288,"median":10320,"max":11868}, gap {"count":60,"min":516,"median":2064,"max":3096}.

At the default reclaim floors: **0** false admissions. Floor-sensitivity cases that put the floor between the two reclaims: **3/3** flip to admission=true, execution=false.

R2 live cells with an engine probe: **0/41**. The R2 reports predate the probe, so their exact-span economics is unavailable, not zero.

## Decision

**No product candidate. Deployment Hold remains.**

- The confirm is partial (23/54 valid; 1 unresolved; 30 never-started) and is not a confirmatory result.
- The valid confirm cells cover T11-T13 only; T14-T16 have no valid cells, so the subset is task-type biased.
- E1 vs B0 paired checker difference is 0 in the confirm and +1 in the pilot; neither is a powered quality estimate.
- Recorded economics direction is unstable: the pilot shows lower uncached input, the confirm shows higher uncached input; cache-read direction is opposite.
- Cost validity is incomplete: 3 confirm cells and 3 pilot cells have null usage; only 5/7 and 4/6 B0/E1 pairs are cost-valid.
- The R2 E1 treatment is not the shipped economy preset: legacy framing, retain 0.04, 16k window, and hint 400 effective vs 800 declared.
- No product-representative lane has run; the stress lane cannot support a product candidate claim.
- No verifiable USD price is recorded; token-resource deltas are not a monetary comparison.

This is not a claim that E1 is ineffective. It is a refusal to promote a candidate on a partial, task-biased, stress-lane, incomplete-cost sample.

