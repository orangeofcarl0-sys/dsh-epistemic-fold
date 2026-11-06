# R38-M0 — Mechanism Evaluation

## 1. Shape

Three layers, eleven cases. Every case carries a gold statement, a reference
input that must pass, a counterfactual that must fail as intended, a leakage
check and independent source refs. A case that cannot certify all four is
`blocked`, not counted.

`eval/r38/out/mechanism-evaluation.json` — 11/11 certified, 0 blocked, 1
safety blocker with 0 observed.

## 2. Cases

| Case | Layer | Risk class | Reference | Counterfactual |
|---|---|---|---|---|
| n5-cross-coordinate | semantic-integrity | unresolved-supersession | complete revision retires both | partial revision leaves the rejected outbox active |
| decision-override-vs-tool-attack | semantic-integrity | unauthorized-retirement | user revision applies | tool finding refused |
| multi-fold-supersession | semantic-integrity | incorrect-active-state | ordered folds leave the last value | out-of-order application revives the middle value |
| scope-overlap | semantic-integrity | scope-contamination | in-scope revision applies | cross-scope anchor id refused |
| relation-authority-attack | semantic-integrity | unauthorized-retirement (safety blocker) | tool finding cannot retire a constraint | a simulated pre-fix retire is blocking |
| b2-v2-implementation-sensitive | context-selection | implementation-relevance | S1 selects the file-scoped decision | S0 omits it under budget |
| h1-production-region | context-selection | archive-only | S2 recovers eu-west-2 | S1 misses it |
| s1-authority-scope | context-selection | scope-contamination | only repo A is returned | repo B is not returned |
| b2-negative-knowledge | context-selection | negative-knowledge-coverage | S1 selects the rejected outbox | S0 misses it |
| recent-tail-reversal | recent-tail | stale-state-delivery | old decision marked unsafe | no tail leaves it safe |
| operational-pilot-replay | operational-continuity | artifact-and-verification | committed 24-cell aggregate replays | the process prompt is not a uniform fix |

## 3. By layer

```text
semantic-integrity        5/5 certified
context-selection         4/4 certified
recent-tail               1/1 certified
operational-continuity    1/1 certified
```

By risk class:

```text
unauthorized-retirement          2/2
scope-contamination              2/2
unresolved-supersession          1/1
incorrect-active-state           1/1
implementation-relevance         1/1
archive-only                     1/1
negative-knowledge-coverage      1/1
stale-state-delivery             1/1
artifact-and-verification        1/1
```

## 4. The safety blocker

`relation-authority-attack` is the only case marked `safetyBlocker`. It has two
halves:

- reference: a tool-grounded finding naming a user-constraint anchor is
  accepted as a claim but its retirement is refused
  (`insufficient-authority`), and the constraint stays active;
- counterfactual: a simulated pre-fix packet that actually emitted the retire
  op is detected by the auditor as `unauthorized-retirement` at `blocking`
  severity.

`unauthorizedRetirementObserved` is 0: no case produced an unauthorized
retirement in the current runtime.

## 5. Costs

```text
b2-v2 selection            98 tokens
h1 recovery                3 operations, +25 tokens
s1 recovery                2 operations
b2 negative knowledge      S0 115 tokens, S1 99 content tokens
recent-tail                2 warnings
operational replay         34 tests, 51 no-valid-action calls
```

## 6. Operational replay

The R37-D pilot is re-scored from its committed aggregate, not re-run:

```text
cells 24/24; legacy 17; operational 17; strict finish 8
B2 P0 5/6 -> P1 3/6
D1 P0 3/6 -> P1 6/6
```

The counterfactual holds: the process prompt helps D1 and hurts B2. It is not
a uniform fix, and the replay is not a new experiment.

## 7. Failure taxonomy (from the R37-D trajectories)

```text
test-no-finish                     9
finish-with-artifact               7
protocol-stall-no-test             5
finish-with-test                   1
finish-with-inconsistent-artifact  1
finish-without-artifact            1
```

## 8. What this evaluation does NOT establish

- No model call was made. Every case is deterministic.
- The context-selection and recovery cases use synthetic states and fixtures.
- The semantic cases exercise the production validate/plan/apply path, but not
  a live writer.
- A certified case means the mechanism does what the fixture says, not that a
  model will behave better.
- No significance claim is made. The operational replay is descriptive.

## 9. Evidence

```text
eval/r38/mechanism-evaluation.mjs
eval/r38/out/mechanism-evaluation.json
eval/r38/out/relation-security-audit.json
eval/r38/out/revision-idempotency.json
eval/r38/out/integrity-audit.json
eval/r38/out/working-set-ablation.json
eval/r38/out/archive-recovery-ablation.json
eval/r38/out/recent-tail-consistency.json
eval/r38/out/native-context-smoke.json
```
