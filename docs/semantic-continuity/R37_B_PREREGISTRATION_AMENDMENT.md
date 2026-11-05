# R37-B — Preregistration Amendment A1

## Status

```text
Written before the first R37-B provider request.
Supersedes only the replicate count and the staging rule in
docs/semantic-continuity/R37_B_PREREGISTRATION.md.
```

The original preregistration planned eight replicates per cell and allowed six
if the budget could not fund eight. The user authorized R37-B on 2026-11-06, but
no numeric budget was supplied. To avoid spending an unbounded amount before
the harness is revalidated, R37-B is split into two stages.

## A1. Stage 1 — exploratory

```text
replicates      4 per case/arm cell
status          exploratory
confirmatory    no
```

Stage 1 covers:

- writer W0/W1 on A1-v2, D1-v2, B2, C1, F1, H1;
- O2 under P3e on the same six cases;
- B2 F-P/F-S/F-N and C1 F-H/F-P/F-S;
- B1/S end-to-end on the same six cases.

Stage 1 is used only to:

1. verify that P3e removes the B2 r1 class of corruption in a live run;
2. verify that A1-v2/D1-v2 are executable by a model and by the scorer;
3. estimate transport and invalid-measurement rates;
4. estimate the pair discordance needed to size Stage 2.

Stage 1 must not be reported as a confirmatory product result.

## A2. Stage 2 — confirmatory

Stage 2 runs only if Stage 1 satisfies all of:

```text
P3e turn-level protocol rejection rate <= 10%
>= 80% of end-to-end S rows have a determined delivery status
O2 contract success >= 4/6
no case is invalidated by a benchmark defect discovered in Stage 1
```

Stage 2 uses:

```text
replicates      6 per case/arm cell (the original minimum)
status          confirmatory
```

The Stage 1 rows are not pooled into the Stage 2 confirmatory estimate. They
remain an exploratory pilot and are reported separately.

## A3. Stopping rules unchanged

The original stopping rules remain in force:

- stop a case if a gold fact is absent from the transcript;
- stop a case if the checker requires a rule absent from task and visible tests;
- stop end-to-end expansion if the O2 floor is below 4/6;
- stop mechanism attribution if actual delivery cannot be determined;
- never substitute the custom loop for H-native;
- never retry a transport failure indefinitely (cap: 2 resends per case).

## A4. Analysis change

The original analysis plan applies to Stage 2. Stage 1 reports:

```text
per-case rows and pair counts
rescue / damage / both / neither
transport failures and invalid rows
protocol rejection diagnostics
delivery status
```

No McNemar p-value from Stage 1 is presented as confirmatory. A Stage 1
McNemar result may be reported only as a pilot estimate with its n.

## A5. What does not change

- E1 and E2 remain separate estimands.
- The P3e harness is fixed for both stages.
- P4 raw-body parsing remains experimental and is not used.
- A1-v2/D1-v2 remain versioned; old A1/D1 are not pooled.
- The product decision remains `insufficient evidence` until Stage 2 meets the
  original rule.
