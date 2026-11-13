# EF-C0 — Baseline Evidence Review

Status: current, 2026-11-08.

This document answers the five evidence questions the convergence brief asks,
using the registry rather than a summary of summaries.

## 1. What does RC1.3's quality parity actually apply to?

RC1.3 measured the **explicit zero-LLM profile**, not today's economy tier:

```text
configuration    economy preset with semanticMode: none
auxiliary calls  none
mechanism        the model retrieves folded facts through context_search
result           un-hinted 2.33/3 -> 3.00/3 (run A), 3.00/3 (run B)
```

The doc's own limits:

- n = 9 per arm, one probe shape (three facts in one message), one window;
- the 2.33 → 3.00 step rests on 2 of 9 runs;
- one route, which the document does not name.

Today's `economy` tier sets `semanticMode: 'rationale'` and makes one auxiliary
call per fold. The RC1.3 quality result **does not automatically transfer** to
it: a rationale call changes both the checkpoint body and the cost. The result
transfers to `semanticMode: none`, which remains available as an explicit
override.

## 2. Is the ~1/17 cost advantage reproducible?

The claim in `docs/00_README_EF.md` is:

> economy, at parity with Basic, costs about a seventeenth as much.

What the underlying artifact records:

| Question | Answer |
|---|---|
| Which task? | the RC1.2 sample, n = 5, one probe (three facts in one message) |
| Which provider/price? | **Unknown** — the RC1.3 document does not name the route or price list |
| Which configuration? | `economy` with `semanticMode: none`; no auxiliary calls |
| Are auxiliary calls included? | there are none in this arm |
| Are cache effects included? | not separated; the cost figure is a per-run total from the observed sample |
| Is the total cost reproducible? | **No, not as a general claim.** The sample is n = 5 and the cost gate is explicitly OPEN (`dispersion, n=8`) |
| Does it apply to today's economy tier? | **No** — that tier now makes a rationale call |

The number itself is real for that sample: `0.00166` vs `0.02778` per run. What
is not established is that the ratio is a stable property of the configuration
across tasks, routes or prices.

## 3. Why is the cost gate still open?

RC1.3 says so directly:

```text
cost gate = OPEN (dispersion, n=8)
economyRecommended = false
default = legacy
```

Three reasons the evidence does not close it:

1. **Dispersion.** The per-run cost varies enough that a point estimate is not a
   gate result; n = 8 does not bound the variance.
2. **One task shape.** A retrieval-dependent mode's cost depends on how often
   the model searches. One probe cannot estimate that frequency.
3. **Price-list dependence.** The economics policy prices a rebase from the
   routed model's profile. A different provider changes the answer.

A closed cost gate would need a frozen task set, a frozen route and price list,
and a cost ledger per arm. No historical round has that combination.

## 4. What does R37's Active negative difference support?

Stage 2, confirmatory under the preregistration amendment:

```text
pairs            36
contract         rescue 1, damage 9, both 17, neither 9
task             rescue 2, damage 7, both 20, neither 7
```

It supports:

> Under `deepseek-v4.1-flash` through the local omnigate2api route, in the
> H-protocol-e/P3e custom harness, across six cases and six replicates, the
> Active arm did not improve contract success and showed a negative difference.

It does **not** support:

- "Active is harmful for all models/routes";
- "Active is worse than Native DSH Basic" — the comparison arm was **B1**, EF's
  own Basic delegation inside the custom harness, not B0;
- "the semantic mechanism is wrong" — the arm bundles the writer, the state,
  the working set and the prompt together.

The confounds the R37 documents record (protocol failures, empty semantic
commits, ceiling effects, fallback delivery) are part of the result, not noise
to be argued away.

## 5. Why can't R38's mechanism gains be product gains?

R38 made **0 live model calls**. Its results are:

```text
relation authorization     deterministic, 8/8
revision identity          deterministic, 7/7
integrity auditor          fixture cases, 9/9
task-aware selection       fixture ablation, 5/5
archive recovery           fixture ablation, 8/8
native overlay             scripted adapter, 6/6
```

Every one of these answers "does the mechanism do what it says on this input?"
None answers "does a model, given this context, complete more tasks at lower
cost?" A selector that picks the right fixture anchor has not been shown to
improve a real long-horizon run, and an overlay that delivers a stable digest
has not been shown to change behavior.

The promotion rule is therefore:

```text
Mechanism Certified  →  (needs a bounded behavioral experiment)  →  Product Candidate
```

R38 stops at the first state. That is the correct stopping point, not a
shortfall.

## 6. Cross-harness comparability

| Experiment | Harness | Scorer | Comparable with |
|---|---|---|---|
| RC1.3 | retrieval probe | 0–3 fact score | nothing else |
| R35/R36 | writer harness / custom loop | v2 / v3 | each other only within their frozen conditions |
| R37-B | H-protocol-e / P3e | R37-B scorer | nothing else |
| R37-D | custom-json-loop | v3 | nothing else |
| R38 | deterministic fixtures | n/a | nothing behavioral |

The rule the brief states and this review enforces:

```text
Do not pool results across harnesses or scorers.
Do not treat a custom-harness B1 arm as Native DSH Basic.
```

## 7. What would change the product decision

A bounded, preregistered experiment with:

1. a frozen manifest (model, route, runtime, config, dataset, scorer);
2. a cost ledger per arm;
3. held-out cases the selector/writer never saw;
4. a safety gate that passes first;
5. a comparison that includes B0 (Native DSH Basic), not only EF's own Basic
   arm.

Until then:

```text
EF Active: deployment hold
deploymentEligible: false
```

## 8. Evidence map

```text
docs/convergence/data/evidence-registry.json          18 claims, hashed artifacts
docs/convergence/data/baseline-comparison-manifest.json  6 arms
docs/convergence/EVIDENCE_INVENTORY.md                artifact census, external archive
docs/22_RC1_3_RETRIEVAL_ERGONOMICS.md                 RC1.3 source
docs/semantic-continuity/R37_B_STAGE2.md              R37-B source
docs/semantic-continuity/R37C_*.md                    R37-C sources
docs/semantic-continuity/R37D_*.md                    R37-D sources
docs/semantic-continuity/R38_*.md                     R38 sources
```
