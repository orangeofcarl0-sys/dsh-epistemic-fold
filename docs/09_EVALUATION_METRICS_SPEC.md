# Epistemic Fold — Evaluation Metrics Specification

> Purpose: define exact metrics so reports cannot drift into attractive but incorrect claims.

---

# 1. Metric classes

Use four disjoint classes:

```text
Correctness
Behavior
Context economics
Provider economics
```

Do not combine them into one scalar during R0-C.

---

# 2. Correctness metrics

## Authority Loss Rate

\[
ALR=
\frac{
missing\ active\ authoritative\ anchors
}{
expected\ active\ authoritative\ anchors
}
\]

Target:

\[
ALR=0
\]

## State Staleness Rate

\[
SSR=
\frac{
superseded\ values\ presented\ as\ current
}{
presented\ current\ values
}
\]

Target:

\[
SSR=0
\]

## Provenance Coverage

\[
PC=
\frac{
authoritative\ state\ objects\ with\ valid\ provenance
}{
authoritative\ state\ objects
}
\]

Target:

\[
PC=1
\]

## Critical Constraint Violation Rate

\[
CCVR=
\frac{
runs\ violating\ a\ hard\ active\ constraint
}{
runs
}
\]

Report absolute counts in addition to rate.

---

# 3. Prefix-locality metrics

Let previous prompt nodes be \(P\), current nodes \(C\).

Find first mutation position:

\[
m=
\min \{i:P_i\ne C_i\}
\]

If all shared nodes match:

\[
m=\min(|P|,|C|)
\]

## Shared Prefix Nodes

\[
SPN=m
\]

## Shared Prefix Tokens

Use token prices from the previous request:

\[
SPT=
\sum_{i=0}^{m-1} Tokens(P_i)
\]

## Invalidated Suffix Tokens

\[
IST=
\sum_{i=m}^{|P|-1} Tokens(P_i)
\]

This is an architecture metric, not proof of provider cache billing.

---

# 4. Reclaimed tokens

For fold \(j\):

\[
R_j=
TokensBefore_j-TokensAfter_j
\]

Only count positive realized reduction.

Run total:

\[
R=\sum_j R_j
\]

---

# 5. PMA

\[
\boxed{
PMA=
\frac{
\sum_j IST_j
}{
\sum_j R_j
}
}
\]

If \(R=0\), PMA is undefined.

Do not report lower absolute IST as “lower PMA” without computing the ratio.

---

# 6. Prompt exposure

For requests \(t=1...T\):

\[
TotalPrompt=
\sum_t PromptTokens_t
\]

Also report:

```text
meanPromptTokens
medianPromptTokens
peakPromptTokens
p95PromptTokens
```

---

# 7. Frozen checkpoint load

Per request:

\[
F_t=
\sum_{\text{visible EF checkpoints}} Tokens(checkpoint)
\]

Report:

```text
meanFrozenTokens
peakFrozenTokens
frozenShareOfPrompt
```

---

# 8. Auxiliary compaction cost

Report:

```text
compactionCallCount
compactionInputTokens
compactionOutputTokens
```

Split by Basic summary and EF rationale.

For `semanticMode=none`, these must be zero.

---

# 9. Recall cost

Report:

```text
contextSearchCalls
contextRecallCalls
recallReturnedTokens
uniqueCheckpointRefsRecalled
```

---

# 10. Context Regret

For fold \(f\), let \(R_f\) be reclaimed tokens.

Let \(Q_{f,k}\) be tokens from that fold reintroduced through recall within \(k\) post-fold actions.

\[
CR@k=
\frac{
\sum_f Q_{f,k}
}{
\sum_f R_f
}
\]

Recommended:

```text
CR@1
CR@3
CR@5
```

---

# 11. Duplicate Work Rate

\[
DWR=
\frac{
AvoidableRepeatedActions
}{
PostBoundaryActions
}
\]

A repeated action is avoidable only when its relevant environment version is unchanged.

Report:

```text
DWR-read
DWR-search
DWR-test
DWR-recall
DWR-total
```

---

# 12. After-fold signal rates

```text
RAF@k read-after-fold
SAF@k search-after-fold
TAF@k test-after-fold
```

These are signals, not correctness failures.

---

# 13. Recall trigger metrics

\[
RTR=
\frac{
runs\ where\ the\ model\ invokes\ appropriate\ recall
}{
runs\ requiring\ recall
}
\]

\[
RSGT=
\frac{
runs\ completing\ correctly\ after\ recall
}{
runs\ that\ triggered\ recall
}
\]

Keep trigger failure and retrieval failure separate.

---

# 14. Behavioral success

Each scenario defines a machine score.

Prefer:

```text
success = all hard oracles pass
```

Optional partial score may be in \([0,1]\), but critical constraint failures must remain separately visible.

---

# 15. Trajectory efficiency

Report:

```text
toolActionCount
modelTurnCount
wallClock
```

and optionally:

\[
Efficiency=
\frac{
TaskScore
}{
1+ToolActionCount
}
\]

Do not use as a hard gate.

---

# 16. Cache-adjusted cost

Define:

\[
\rho=
Cost(hitToken)/Cost(missToken)
\]

Approximate architectural hit tokens by Shared Prefix Tokens.

\[
EstimatedMiss=
PromptTokens-SharedPrefixTokens
\]

\[
Cost_\rho=
EstimatedMiss+
\rho\cdot SharedPrefixTokens
\]

Run-level add:

\[
+\ AuxiliaryInput
+\lambda_o AuxiliaryOutput
+\ RecallReturnedTokens
\]

Evaluate at:

```text
rho = 0
0.1
0.2
0.5
1.0
```

Actual provider cache metrics, when available, belong in a separate table.

---

# 17. Break-even cache discount

Find \(\rho\) where:

\[
Cost_\rho(EF)<Cost_\rho(Basic)
\]

Report break-even rather than universal cost superiority.

---

# 18. Paired statistics

For every pair:

\[
\Delta_i=
Metric(EF_i)-Metric(Basic_i)
\]

Report:

```text
paired mean delta
paired median delta
bootstrap 95% CI
wins / ties / losses
```

For binary success:

```text
Basic success count
EF success count
paired disagreement table
```

---

# 19. Catastrophic failures

Always report separately:

```text
hard constraint violation
wrong destructive edit
cross-session recall
lost required obligation
unrecoverable exact provenance
```

Average gains do not compensate for higher catastrophic failure rate.

---

# 20. Result schema

```ts
interface EvalRunResult {
  runVersion: 1
  caseId: string
  arm: string
  replicate: number

  efCommit: string
  dshCommit: string
  model?: string

  success: boolean
  score?: number

  correctness: {
    authorityLossRate?: number
    stateStalenessRate?: number
    provenanceCoverage?: number
    criticalViolations: string[]
  }

  context: {
    promptTokensTotal: number
    peakPromptTokens: number
    p95PromptTokens: number
    sharedPrefixTokensTotal: number
    invalidatedSuffixTokensTotal: number
    reclaimedTokensTotal: number
    pma?: number
  }

  behavior: {
    actions: number
    duplicateActions: number
    duplicateWorkRate: number
    recallCalls: number
  }
}
```

Markdown tables must be generated from JSON results.
