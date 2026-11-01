# R33 offline arm report

- dataset: `2666e70f0cdba13bc3c756ff086b3566f51c0a9b595ecd9495859f73c0c21f26` (17 frozen cases)
- execution: `scripted-writer + scripted-follow-up (pipeline measurement, not a model result)`
- generated: 2026-11-01T12:13:52.422Z

This is a scripted-writer / scripted-follow-up measurement of the PIPELINE. It is not a model result.

## Per-arm aggregate

| arm | valid | success | damage | task success | critical recall | grounded precision | false normative | current state | direct visibility |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B0 | 17/17 | 7 | 10 | 0.412 | n/a | n/a | n/a | n/a | n/a |
| B1 | 17/17 | 7 | 10 | 0.412 | n/a | n/a | n/a | n/a | n/a |
| S | 17/17 | 15 | 2 | 0.882 | 0.926 | 1.000 | 0.000 | 0.928 | 0.928 |
| O1 | 17/17 | 16 | 1 | 0.941 | 0.993 | 1.000 | 0.000 | 0.995 | 0.995 |
| O2 | 17/17 | 17 | 0 | 1.000 | n/a | n/a | n/a | n/a | n/a |
| OR | 17/17 | 17 | 0 | 1.000 | n/a | n/a | n/a | n/a | n/a |
| F | 17/17 | 17 | 0 | 1.000 | n/a | n/a | n/a | n/a | n/a |
| N | 17/17 | 3 | 14 | 0.176 | n/a | n/a | n/a | n/a | n/a |
| FM | 8/8 | 0 | 8 | 0.000 | 0.875 | 1.000 | 0.000 | 0.875 | 0.875 |

## Task-level comparisons (left vs right)

| left | right | pairs | left-only (damage) | right-only (rescue) | both | neither |
|---|---|---:|---:|---:|---:|---:|
| S | B1 | 17 | 8 | 0 | 7 | 2 |
| S | B0 | 17 | 8 | 0 | 7 | 2 |
| O1 | S | 17 | 1 | 0 | 15 | 1 |
| O2 | O1 | 17 | 1 | 0 | 16 | 0 |
| F | S | 17 | 2 | 0 | 15 | 0 |
| S | N | 17 | 12 | 0 | 3 | 2 |
| O1 | B1 | 17 | 9 | 0 | 7 | 1 |
| OR | B1 | 17 | 10 | 0 | 7 | 0 |

## Per-case rows

| case | arm | success | action | failed checks | critical recall | current state | checkpoint chars |
|---|---|---:|---|---|---:|---:|---:|
| A1 | B0 | yes | keep-api | - | n/a | n/a | 711 |
| A1 | B1 | yes | keep-api | - | n/a | n/a | 782 |
| A1 | S | yes | keep-api | - | 1.000 | 1.000 | 692 |
| A1 | O1 | yes | keep-api | - | 1.000 | 1.000 | 692 |
| A1 | O2 | yes | keep-api | - | n/a | n/a | 782 |
| A1 | OR | yes | keep-api | - | n/a | n/a | 782 |
| A1 | F | yes | keep-api | - | n/a | n/a | 782 |
| A1 | N | no | rename-api | constraint.legacy-string-api | n/a | n/a | 782 |
| A1 | FM | no | rename-api | constraint.legacy-string-api | 1.000 | 1.000 | 692 |
| A2 | B0 | yes | rename-api | - | n/a | n/a | 698 |
| A2 | B1 | yes | rename-api | - | n/a | n/a | 769 |
| A2 | S | yes | rename-api | - | 1.000 | 1.000 | 689 |
| A2 | O1 | yes | rename-api | - | 1.000 | 1.000 | 689 |
| A2 | O2 | yes | rename-api | - | n/a | n/a | 769 |
| A2 | OR | yes | rename-api | - | n/a | n/a | 769 |
| A2 | F | yes | rename-api | - | n/a | n/a | 769 |
| A2 | N | no | keep-api | constraint.legacy-string-removed, constraint.callers-migrated | n/a | n/a | 769 |
| B1 | B0 | yes | use-outbox | - | n/a | n/a | 739 |
| B1 | B1 | yes | use-outbox | - | n/a | n/a | 810 |
| B1 | S | yes | use-outbox | - | 1.000 | 1.000 | 700 |
| B1 | O1 | yes | use-outbox | - | 1.000 | 1.000 | 700 |
| B1 | O2 | yes | use-outbox | - | n/a | n/a | 810 |
| B1 | OR | yes | use-outbox | - | n/a | n/a | 810 |
| B1 | F | yes | use-outbox | - | n/a | n/a | 810 |
| B1 | N | no | use-memory | decision.durable-outbox | n/a | n/a | 810 |
| B1 | FM | no | use-memory | decision.durable-outbox | 1.000 | 1.000 | 700 |
| B2 | B0 | yes | use-memory | - | n/a | n/a | 739 |
| B2 | B1 | yes | use-memory | - | n/a | n/a | 810 |
| B2 | S | yes | use-memory | - | 1.000 | 1.000 | 870 |
| B2 | O1 | yes | use-memory | - | 1.000 | 1.000 | 870 |
| B2 | O2 | yes | use-memory | - | n/a | n/a | 810 |
| B2 | OR | yes | use-memory | - | n/a | n/a | 810 |
| B2 | F | yes | use-memory | - | n/a | n/a | 810 |
| B2 | N | no | use-outbox | decision.in-memory | n/a | n/a | 810 |
| C1 | B0 | no | fs-watch | functionality.delivers-change | n/a | n/a | 629 |
| C1 | B1 | no | fs-watch | functionality.delivers-change | n/a | n/a | 698 |
| C1 | S | yes | poll | - | 1.000 | 1.000 | 825 |
| C1 | O1 | yes | poll | - | 1.000 | 1.000 | 825 |
| C1 | O2 | yes | poll | - | n/a | n/a | 698 |
| C1 | OR | yes | poll | - | n/a | n/a | 698 |
| C1 | F | yes | poll | - | n/a | n/a | 698 |
| C1 | N | no | fs-watch | functionality.delivers-change | n/a | n/a | 698 |
| C1 | FM | no | fs-watch | functionality.delivers-change | 1.000 | 1.000 | 825 |
| C2 | B0 | no | poll | functionality.delivers-change | n/a | n/a | 629 |
| C2 | B1 | no | poll | functionality.delivers-change | n/a | n/a | 698 |
| C2 | S | yes | fs-watch | - | 1.000 | 1.000 | 827 |
| C2 | O1 | yes | fs-watch | - | 1.000 | 1.000 | 827 |
| C2 | O2 | yes | fs-watch | - | n/a | n/a | 698 |
| C2 | OR | yes | fs-watch | - | n/a | n/a | 698 |
| C2 | F | yes | fs-watch | - | n/a | n/a | 698 |
| C2 | N | no | poll | functionality.delivers-change | n/a | n/a | 698 |
| D1 | B0 | no | trust-history | constraint.claim-accuracy, constraint.tests-or-evidence, constraint.evidence-bound | n/a | n/a | 594 |
| D1 | B1 | no | trust-history | constraint.claim-accuracy, constraint.tests-or-evidence, constraint.evidence-bound | n/a | n/a | 663 |
| D1 | S | yes | report-unverified | - | 1.000 | 1.000 | 650 |
| D1 | O1 | yes | report-unverified | - | 1.000 | 1.000 | 650 |
| D1 | O2 | yes | report-unverified | - | n/a | n/a | 663 |
| D1 | OR | yes | report-unverified | - | n/a | n/a | 663 |
| D1 | F | yes | report-unverified | - | n/a | n/a | 663 |
| D1 | N | no | trust-history | constraint.claim-accuracy, constraint.tests-or-evidence, constraint.evidence-bound | n/a | n/a | 663 |
| D1 | FM | no | trust-history | constraint.claim-accuracy, constraint.tests-or-evidence, constraint.evidence-bound | 1.000 | 1.000 | 650 |
| D2 | B0 | no | claim-unverified | constraint.claim-accuracy | n/a | n/a | 594 |
| D2 | B1 | no | claim-unverified | constraint.claim-accuracy | n/a | n/a | 663 |
| D2 | S | yes | carry-verification | - | 1.000 | 1.000 | 623 |
| D2 | O1 | yes | carry-verification | - | 1.000 | 1.000 | 623 |
| D2 | O2 | yes | carry-verification | - | n/a | n/a | 663 |
| D2 | OR | yes | carry-verification | - | n/a | n/a | 663 |
| D2 | F | yes | carry-verification | - | n/a | n/a | 663 |
| D2 | N | no | claim-unverified | constraint.claim-accuracy | n/a | n/a | 663 |
| E1 | B0 | no | use-v1 | dependency.artifact-version | n/a | n/a | 592 |
| E1 | B1 | no | use-v1 | dependency.artifact-version | n/a | n/a | 659 |
| E1 | S | yes | use-v2 | - | 1.000 | 1.000 | 624 |
| E1 | O1 | yes | use-v2 | - | 1.000 | 1.000 | 624 |
| E1 | O2 | yes | use-v2 | - | n/a | n/a | 659 |
| E1 | OR | yes | use-v2 | - | n/a | n/a | 659 |
| E1 | F | yes | use-v2 | - | n/a | n/a | 659 |
| E1 | N | no | use-v1 | dependency.artifact-version | n/a | n/a | 659 |
| E1 | FM | no | use-v1 | dependency.artifact-version | 1.000 | 1.000 | 624 |
| E2 | B0 | no | use-v2 | dependency.artifact-version | n/a | n/a | 592 |
| E2 | B1 | no | use-v2 | dependency.artifact-version | n/a | n/a | 659 |
| E2 | S | yes | use-v1 | - | 1.000 | 1.000 | 624 |
| E2 | O1 | yes | use-v1 | - | 1.000 | 1.000 | 624 |
| E2 | O2 | yes | use-v1 | - | n/a | n/a | 659 |
| E2 | OR | yes | use-v1 | - | n/a | n/a | 659 |
| E2 | F | yes | use-v1 | - | n/a | n/a | 659 |
| E2 | N | no | use-v2 | dependency.artifact-version | n/a | n/a | 659 |
| F1 | B0 | no | delete-legacy | constraint.legacy-preserved | n/a | n/a | 636 |
| F1 | B1 | no | delete-legacy | constraint.legacy-preserved | n/a | n/a | 705 |
| F1 | S | yes | keep-legacy | - | 1.000 | 1.000 | 664 |
| F1 | O1 | yes | keep-legacy | - | 1.000 | 1.000 | 664 |
| F1 | O2 | yes | keep-legacy | - | n/a | n/a | 705 |
| F1 | OR | yes | keep-legacy | - | n/a | n/a | 705 |
| F1 | F | yes | keep-legacy | - | n/a | n/a | 705 |
| F1 | N | yes | keep-legacy | - | n/a | n/a | 705 |
| F1 | FM | no | delete-legacy | constraint.legacy-preserved | 1.000 | 1.000 | 664 |
| F2 | B0 | no | keep-legacy | constraint.legacy-removed | n/a | n/a | 636 |
| F2 | B1 | no | keep-legacy | constraint.legacy-removed | n/a | n/a | 705 |
| F2 | S | yes | delete-legacy | - | 1.000 | 1.000 | 645 |
| F2 | O1 | yes | delete-legacy | - | 1.000 | 1.000 | 645 |
| F2 | O2 | yes | delete-legacy | - | n/a | n/a | 705 |
| F2 | OR | yes | delete-legacy | - | n/a | n/a | 705 |
| F2 | F | yes | delete-legacy | - | n/a | n/a | 705 |
| F2 | N | no | keep-legacy | constraint.legacy-removed | n/a | n/a | 705 |
| F3 | B0 | yes | scoped | - | n/a | n/a | 623 |
| F3 | B1 | yes | scoped | - | n/a | n/a | 694 |
| F3 | S | yes | scoped | - | 1.000 | 1.000 | 885 |
| F3 | O1 | yes | scoped | - | 1.000 | 1.000 | 885 |
| F3 | O2 | yes | scoped | - | n/a | n/a | 694 |
| F3 | OR | yes | scoped | - | n/a | n/a | 694 |
| F3 | F | yes | scoped | - | n/a | n/a | 694 |
| F3 | N | no | unscoped | scope.release | n/a | n/a | 694 |
| F3 | FM | no | unscoped | scope.release | 1.000 | 1.000 | 885 |
| F4 | B0 | no | apply-0 | rule.1-no-id, rule.2-no-name, rule.3-id-range, rule.4-name-length, rule.5-trim, rule.6-default-status, rule.7-tombstone, rule.8-negative-amount, rule.9-round-amount, rule.10-uppercase-currency, rule.11-known-currency, rule.12-empty-currency, rule.13-amount-max | n/a | n/a | 2018 |
| F4 | B1 | no | apply-0 | rule.1-no-id, rule.2-no-name, rule.3-id-range, rule.4-name-length, rule.5-trim, rule.6-default-status, rule.7-tombstone, rule.8-negative-amount, rule.9-round-amount, rule.10-uppercase-currency, rule.11-known-currency, rule.12-empty-currency, rule.13-amount-max | n/a | n/a | 2105 |
| F4 | S | no | apply-12 | rule.13-amount-max | 0.889 | 0.923 | 2155 |
| F4 | O1 | no | apply-12 | rule.13-amount-max | 0.889 | 0.923 | 2155 |
| F4 | O2 | yes | apply-all-13 | - | n/a | n/a | 2105 |
| F4 | OR | yes | apply-all-13 | - | n/a | n/a | 2105 |
| F4 | F | yes | apply-all-13 | - | n/a | n/a | 2105 |
| F4 | N | no | apply-0 | rule.1-no-id, rule.2-no-name, rule.3-id-range, rule.4-name-length, rule.5-trim, rule.6-default-status, rule.7-tombstone, rule.8-negative-amount, rule.9-round-amount, rule.10-uppercase-currency, rule.11-known-currency, rule.12-empty-currency, rule.13-amount-max | n/a | n/a | 2105 |
| G1 | B0 | yes | implement | - | n/a | n/a | 467 |
| G1 | B1 | yes | implement | - | n/a | n/a | 532 |
| G1 | S | yes | implement | - | n/a | n/a | 470 |
| G1 | O1 | yes | implement | - | n/a | n/a | 633 |
| G1 | O2 | yes | implement | - | n/a | n/a | 532 |
| G1 | OR | yes | implement | - | n/a | n/a | 532 |
| G1 | F | yes | implement | - | n/a | n/a | 532 |
| G1 | N | yes | implement | - | n/a | n/a | 532 |
| G2 | B0 | yes | implement | - | n/a | n/a | 449 |
| G2 | B1 | yes | implement | - | n/a | n/a | 514 |
| G2 | S | yes | implement | - | n/a | n/a | 460 |
| G2 | O1 | yes | implement | - | n/a | n/a | 609 |
| G2 | O2 | yes | implement | - | n/a | n/a | 514 |
| G2 | OR | yes | implement | - | n/a | n/a | 514 |
| G2 | F | yes | implement | - | n/a | n/a | 514 |
| G2 | N | yes | implement | - | n/a | n/a | 514 |
| H1 | B0 | no | use-us | region.production | n/a | n/a | 603 |
| H1 | B1 | no | use-us | region.production | n/a | n/a | 672 |
| H1 | S | no | use-us | region.production | 0.000 | 0.000 | 474 |
| H1 | O1 | yes | use-eu | - | 1.000 | 1.000 | 641 |
| H1 | O2 | yes | use-eu | - | n/a | n/a | 672 |
| H1 | OR | yes | use-eu | - | n/a | n/a | 672 |
| H1 | F | yes | use-eu | - | n/a | n/a | 672 |
| H1 | N | no | use-us | region.production | n/a | n/a | 672 |
| H1 | FM | no | use-us | region.production | 0.000 | 0.000 | 474 |
