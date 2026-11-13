# EF-R4 — candidate decision

Selected: **active-task-delivery** (contract only, not wired).

## Pre-registered rules

| Rule | Met | Actual |
|---|---|---|
| H1a-task-source-loss | yes | {"failedWithLoss":7,"passedWithLoss":0,"cells":["T11-p1-E0-r1","T12-p1-E0-r1","T13-p1-E0-r1","T15-p1-E0-r1","T15-p1-E1-r1","T16-p1-E0-r1","T16-p1-E1-r1"]} |
| H1b-recall-refolding | yes | {"folded":53,"refolded":51,"ratio":0.9622641509433962} |
| H2-evidence-scope | yes | {"cases":["T11-p1-E1-r1"]} |
| failure-projection-inflation | yes | {"cells":[{"cellId":"T16-p1-E0-r1","duplicateSignatures":2,"share":0.9121863799283154},{"cellId":"T16-p1-E1-r1","duplicateSignatures":4,"share":0.3213669313082499}]} |

## Offline simulation

| Cell | Active label | Prompt chars | Deliveries | Added chars | Share of final checkpoint |
|---|---|---|---|---|---|
| T11-p1-E0-r1 | task | 127 | 2 | 254 | 5.40 |
| T12-p1-E0-r1 | task | 87 | 2 | 174 | 3.70 |
| T13-p1-E0-r1 | task | 93 | 2 | 186 | 3.96 |
| T15-p1-E0-r1 | task | 81 | 2 | 162 | 3.45 |
| T15-p1-E1-r1 | task | 81 | 2 | 162 | 0.08 |
| T16-p1-E0-r1 | taskB | 100 | 2 | 200 | 0.36 |
| T16-p1-E1-r1 | taskB | 100 | 1 | 100 | 0.03 |

Total added prompt chars: **1238** across 7 failed cells (bounded to two deliveries per cell).

## Counterevidence

- T11-p1-E1 has no task-source loss and no recall, yet writes the wrong historical value; that is H2, not task delivery.
- T16-p1-B0 has no task-source loss and still fails on the output schema and the fold count; task delivery alone is not sufficient.
- Passing EF cells have no task-source loss, so the correlation is strong but not a counterfactual proof.

## Limits

- The candidate is a research contract, not a product change.
- The simulation adds exact prompt chars to a request; it does not prove the model would act on them.
- No live run was made; quality, cost and latency effects are unmeasured.
- Deployment Hold remains; this is not a product candidate.

