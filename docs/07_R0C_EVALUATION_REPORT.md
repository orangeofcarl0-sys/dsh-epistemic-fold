# R0-C Evaluation Report

> Generated from machine results · source of truth: the JSON run results and
> the vitest suites that produce them (`tests/eval-*.spec.ts`).
> EF HEAD: see `git log -1` · DSH pinned: `477b4f420553e8a52c2fbccc464d7561b239c443`

---

## 1. Measurement integrity (R0-C0)

| Requirement | Status | Evidence |
|---|---|---|
| PMA computed by its actual ratio | ✅ | `eval/src/metrics.ts:prefixMutationRatio`; `tests/eval-core.spec.ts` |
| No fake `stablePrefixBytes` metric | ✅ | replaced by `sharedPrefixTokens` (previous-request pricing) |
| `sharedPrefixTokens` / `invalidatedSuffixTokens` use PREVIOUS pricing | ✅ | spec 09 §3; unit-tested |
| Total/mean/median/peak/p95 prompt exposure | ✅ | `promptExposure()` |
| Frozen checkpoint recurring load (mean/peak/share) | ✅ | `frozenSummary()` |
| Auxiliary compaction accounting from durable usage | ✅ | `BaselineResult.auxiliaryCompaction` reads `compaction/summary.usage` |
| All reports machine-readable | ✅ | `EvalRunResult` JSON schema; Markdown generated from it (`eval/src/report.ts`) |

## 2. Boundary corpus (R0-C1)

| Class | Count | Keyless |
|---|---|---|
| Hard gate (B01–B12) | 12 | ✅ |
| Exploratory (X01–X06) | 6 | ✅ |

Each hard case carries: a deterministic pre-boundary Session, an EF sidecar
(boundary metadata + machine oracles), and a keyless replay test
(`tests/eval-corpus.spec.ts`). Oracles are a closed union
(`eval/src/schema.ts`) — no "LLM says it succeeded".

Hard-gate results across all three arms (B1 / E3a0 / E3aR): **all hard oracles
pass**. Note the arm-scope rule: state-based and EF-recall oracles are
EF-arm capabilities (a Basic checkpoint carries no EF state or bundle), so they
are reported as not-applicable for B1 rather than as failures.

## 3. Paired continuation (R0-C2)

Three arms run from identical deterministic pre-boundary state:
`B1` DSH Basic · `E3a0` EF state-only (`semanticMode=none`, zero LLM calls) ·
`E3aR` EF state + rationale-only auxiliary call.

Keyless mode proves infrastructure determinism (identical starting state,
deterministic action capture, deterministic verifier, deterministic metrics).
Live-model paired runs are **opt-in and not required** for R0-C closure; the
runner accepts a provider/model when available.

## 4. Behavior telemetry

Implemented per spec: `ActionSignature` families, environment-versioned
duplicate detection (a re-read after the file changed is NOT duplicate),
DWR by family, RAF/SAF/TAF-style after-fold signals, recall trigger vs recall
success separation, and `ContextRegret@k`. False-positive tests pin the
"environment unchanged" rule.

## 5. Economics (R0-C3, deterministic)

Long-horizon runs at 32/64/128 steps, window 32K-equivalent, three arms.
Representative output (128 steps):

```text
B1-basic      | prompt=322589/4746/4537 | SPT=286919 | IST=33013 | reclaimed=32278 | PMA=1.023 | frozen=0/0      | leaf=7 | root=0
EF-leaf-only  | prompt=349620/4781/4642 | SPT=313589 | IST=33748 | reclaimed=32652 | PMA=1.034 | frozen=503/1096 | leaf=8 | root=0
EF-leaf+root  | prompt=339688/4779/4642 | SPT=303247 | IST=36344 | reclaimed=34290 | PMA=1.060 | frozen=280/685  | leaf=8 | root=1
```

**Findings (evidence-driven, no spin):**

1. **EF keeps more history warm** — SPT is higher in both EF arms at every
   horizon (313589 vs 286919 at 128 steps).
2. **Absolute prefix invalidation is NOT uniformly lower at long horizons** —
   at 32 steps EF ≈ Basic, by 128 steps EF-leaf-only exceeds Basic
   (33748 vs 33013). The short-horizon advantage observed in the M2-era
   microbenchmark does not extrapolate; the fold cadence interacts with the
   frozen prefix's recurring cost.
3. **Frozen checkpoint load is the dominant recurring cost** — 503 tokens
   mean / 1096 peak at 128 steps. This is the mechanism behind finding 2.
4. **Root rebase pays off over long horizons** — the `leaf+root` arm cuts
   frozen load by ~45% (280/685 vs 503/1096) and lowers total prompt tokens
   vs leaf-only (339688 vs 349620), at the cost of a one-time full rewrite
   (higher IST/PMA).
5. **Cache break-even is real and measurable** — the ρ curve shows EF cheaper
   only while the provider's cache discount is deep; at ρ=1 (cache free) EF's
   frozen-checkpoint overhead makes it more expensive than Basic.

## 6. Compression incidents

The classifier (`eval/src/incidents.ts`) maps paired regressions into the
closed category union with evidence. Keyless runs produce none for the hard
corpus (all arms pass); the classifier is unit-tested against synthetic
authority-loss, recall, and duplicate-work scenarios.

## 7. Evidence-driven next-stage decision

| Observation | Next stage |
|---|---|
| Frozen-checkpoint recurring cost dominates at long horizons (finding 3) | **M5 generational fold** — the leaf/root hierarchy is the measured bottleneck |
| No correctness regressions across M0/M2/M3a (all hard gates green) | do not reopen correctness work |
| No evidence yet for M1 (tool ingress) or M3b (negative knowledge) | not justified by this corpus |
| Root rebase is the effective lever (finding 4) | tune rebase policy before adding layers |

**Decision: the observed bottleneck is leaf/root fold economics, not missing
intelligence. The next architecture layer, if any, is M5 (generational fold)
— and only after a rebase-policy tuning pass confirms the cost is structural
rather than a threshold artifact.**

## 8. R0-C closure status

| Gate | Status |
|---|---|
| Measurement integrity | ✅ CLOSED |
| ≥12 hard + ≥6 exploratory keyless scenarios | ✅ CLOSED |
| Paired harness (three arms, machine verifier) | ✅ CLOSED |
| 32/64/128 economics with leaf + root maintenance | ✅ CLOSED |
| Behavior on live-model subset | ⏸ OPEN — requires provider credentials (opt-in; not required for keyless closure) |
