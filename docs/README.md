# Epistemic Fold Documentation

[中文](README.zh.md)

This directory contains two different kinds of documentation:

1. **stable product documentation** — what the software is and how to use it today;
2. **research / verification records** — the chronological evidence trail that led to the current design.

Do not read the numbered RC documents as a user manual. They intentionally preserve superseded hypotheses, failed experiments, defect investigations, and later corrections.

## Start here

| document | use it for |
| --- | --- |
| [../README.md](../README.md) / [../README.zh.md](../README.zh.md) | project overview and current status |
| [USER_GUIDE.md](USER_GUIDE.md) | install, configure, switch modes, inspect status, troubleshoot |
| [ARCHITECTURE.md](ARCHITECTURE.md) | current architecture and contracts |
| [DEVELOPMENT.md](DEVELOPMENT.md) | local development, testing, evaluation discipline |
| [42_DEPLOYMENT_CHAIN.md](42_DEPLOYMENT_CHAIN.md) | detailed DSH preset/browser deployment path |

## Current product model

Epistemic Fold separates:

```text
canonical history
      ↓
exact archive + deterministic state
      ↓
compact active context
      ↕
bounded search / recall
```

User-facing modes:

- **Economy** — cost priority; compact hot context and on-demand recall.
- **Balanced** — keeps a larger verbatim recent tail.
- **Quality** — Balanced plus semantic rationale checkpoints.
- **Legacy** — EF's frozen compatibility baseline.
- **Basic** — EF stands aside.

Only Economy has targeted end-to-end measurements behind its current claim. Balanced and Quality are intentionally labelled as hypotheses until real long-horizon tasks show a reliable steadiness benefit.

## Evidence map

If you want the shortest path through the research record:

| question | read |
| --- | --- |
| What was the original design? | [00](00_README_EF.md), [01](01_EF_RFC_001_ARCHITECTURE.md) |
| How is compaction correctness tested? | [08](08_BOUNDARY_CORPUS_PROTOCOL.md), [09](09_EVALUATION_METRICS_SPEC.md) |
| Why is cost provider/cache dependent? | [12](12_R1_EVALUATION_REPORT.md), [19](19_RC1_POLICY_NORMALIZATION.md) |
| Why was Delta Leaf rejected? | [12](12_R1_EVALUATION_REPORT.md) |
| How did framing / repeated checkpoint cost get fixed? | [14](14_R2_EVALUATION_REPORT.md), [16](16_R3_EVALUATION_REPORT.md) |
| How was real recall closed? | [21](21_RC1_2_RECALL_CLOSURE.md), [22](22_RC1_3_RETRIEVAL_ERGONOMICS.md), [23](23_RC1_3_1_TEMPORAL_RETRIEVAL_GUARD.md) |
| Where did the three tiers come from? | [24](24_RC2_PRODUCT_INTEGRATION.md), [25](25_RC2_1_STATUS_AND_RETENTION_AB.md), [29](29_RC5_PRESET_DESIGN.md) |
| How is EF mounted in real DSH? | [26](26_RC3_REAL_DSH_PLUGINIZATION.md), [31](31_RC7_TRANSFORMATION_PLAN.md), [42](42_DEPLOYMENT_CHAIN.md) |
| How was the Sidebar verified? | [27](27_RC4_SIDEBAR_PANEL.md), [37](37_RC11_BROWSER_VERIFICATION.md), [39–47](#browser-deployment-and-ux-hardening) |
| What do external benchmarks currently show? | [33](33_RC8_EXTERNAL_BENCHMARKS.md), [34](34_RC9_TAU2_INTEGRATION.md), [35](35_RC10_LHTB_INTEGRATION.md), [36](36_RC10_SESSION_PAUSE.md) |

## Research archive

### Foundation and first implementation — 00–10

These documents define the original model, implementation plan, invariants, corpus, and evaluation rules.

- [00_README_EF.md](00_README_EF.md)
- [01_EF_RFC_001_ARCHITECTURE.md](01_EF_RFC_001_ARCHITECTURE.md)
- [02_EF_IMPLEMENTATION_PLAN_M0_M3.md](02_EF_IMPLEMENTATION_PLAN_M0_M3.md)
- [03_EF_TEST_BENCHMARK_SPEC.md](03_EF_TEST_BENCHMARK_SPEC.md)
- [04_EF_LOCAL_AGENT_WORK_ORDER.md](04_EF_LOCAL_AGENT_WORK_ORDER.md)
- [05_EF_DECISIONS_AND_OPEN_QUESTIONS.md](05_EF_DECISIONS_AND_OPEN_QUESTIONS.md)
- [06_FINAL_REPORT.md](06_FINAL_REPORT.md)
- [07_R0C_EVALUATION_CLOSURE.md](07_R0C_EVALUATION_CLOSURE.md)
- [07_R0C_EVALUATION_REPORT.md](07_R0C_EVALUATION_REPORT.md)
- [08_BOUNDARY_CORPUS_PROTOCOL.md](08_BOUNDARY_CORPUS_PROTOCOL.md)
- [09_EVALUATION_METRICS_SPEC.md](09_EVALUATION_METRICS_SPEC.md)
- [10_LOCAL_AGENT_WORK_ORDER_R0C.md](10_LOCAL_AGENT_WORK_ORDER_R0C.md)

### Economics and architecture selection — 11–17

This phase introduced source attribution, provider-aware cache economics, ROI gates, and the framing/rebase work that made EF economically competitive in controlled workloads.

- [11_R1B_ROUTE_SELECTION_GATE.md](11_R1B_ROUTE_SELECTION_GATE.md)
- [12_R1_EVALUATION_REPORT.md](12_R1_EVALUATION_REPORT.md)
- [13_R1_LIVE_BEHAVIORAL_RESULTS.md](13_R1_LIVE_BEHAVIORAL_RESULTS.md)
- [14_R2_EVALUATION_REPORT.md](14_R2_EVALUATION_REPORT.md)
- [15_R2_FRAMING_CEILING.md](15_R2_FRAMING_CEILING.md)
- [16_R3_EVALUATION_REPORT.md](16_R3_EVALUATION_REPORT.md)
- [17_R4_EVALUATION_REPORT.md](17_R4_EVALUATION_REPORT.md)

### Evidence reconciliation and retrieval closure — 18–25

These records are important because several attractive earlier conclusions were explicitly withdrawn after better instrumentation.

- [18_RC0_RELEASE_HARDENING.md](18_RC0_RELEASE_HARDENING.md)
- [19_RC1_POLICY_NORMALIZATION.md](19_RC1_POLICY_NORMALIZATION.md)
- [20_RC1_1_EVIDENCE_RECONCILIATION.md](20_RC1_1_EVIDENCE_RECONCILIATION.md)
- [21_RC1_2_RECALL_CLOSURE.md](21_RC1_2_RECALL_CLOSURE.md)
- [22_RC1_3_RETRIEVAL_ERGONOMICS.md](22_RC1_3_RETRIEVAL_ERGONOMICS.md)
- [23_RC1_3_1_TEMPORAL_RETRIEVAL_GUARD.md](23_RC1_3_1_TEMPORAL_RETRIEVAL_GUARD.md)
- [24_RC2_PRODUCT_INTEGRATION.md](24_RC2_PRODUCT_INTEGRATION.md)
- [25_RC2_1_STATUS_AND_RETENTION_AB.md](25_RC2_1_STATUS_AND_RETENTION_AB.md)

### Product integration and preset design — 26–31

- [26_RC3_REAL_DSH_PLUGINIZATION.md](26_RC3_REAL_DSH_PLUGINIZATION.md)
- [27_RC4_SIDEBAR_PANEL.md](27_RC4_SIDEBAR_PANEL.md)
- [28_RC4A_INTERACTION_AUDIT.md](28_RC4A_INTERACTION_AUDIT.md)
- [29_RC5_PRESET_DESIGN.md](29_RC5_PRESET_DESIGN.md)
- [30_RC6_PRIOR_ART_SURVEY.md](30_RC6_PRIOR_ART_SURVEY.md)
- [31_RC7_TRANSFORMATION_PLAN.md](31_RC7_TRANSFORMATION_PLAN.md)

### Long-task and external benchmark work — 32–36

- [32_RC7D_PARALLEL_LONG_TASK_TESTING.md](32_RC7D_PARALLEL_LONG_TASK_TESTING.md)
- [33_RC8_EXTERNAL_BENCHMARKS.md](33_RC8_EXTERNAL_BENCHMARKS.md)
- [34_RC9_TAU2_INTEGRATION.md](34_RC9_TAU2_INTEGRATION.md)
- [35_RC10_LHTB_INTEGRATION.md](35_RC10_LHTB_INTEGRATION.md)
- [36_RC10_SESSION_PAUSE.md](36_RC10_SESSION_PAUSE.md)

### Browser, deployment, and UX hardening

These records document real-host defects and browser/deployment integration. They are useful when debugging a concrete deployment, not as conceptual prerequisites.

- [37_RC11_BROWSER_VERIFICATION.md](37_RC11_BROWSER_VERIFICATION.md)
- [38_RC12_PRESET_BACKEND_DOCTOR_DEFECT.md](38_RC12_PRESET_BACKEND_DOCTOR_DEFECT.md)
- [39_RC13_SIDEBAR_PANEL_RENDER_DEFECT.md](39_RC13_SIDEBAR_PANEL_RENDER_DEFECT.md)
- [40_RC14_DUAL_SIDEBAR_ADAPTER.md](40_RC14_DUAL_SIDEBAR_ADAPTER.md)
- [41_RC15_NATIVE_SIDEBAR_RENDERS.md](41_RC15_NATIVE_SIDEBAR_RENDERS.md)
- [42_DEPLOYMENT_CHAIN.md](42_DEPLOYMENT_CHAIN.md)
- [43_RC17_SIDEBAR_ENTRY_DEDUPE.md](43_RC17_SIDEBAR_ENTRY_DEDUPE.md)
- [44_RC18_HONEST_PRICING.md](44_RC18_HONEST_PRICING.md)
- [45_RC19_PANEL_READABILITY.md](45_RC19_PANEL_READABILITY.md)
- [46_RC20_ARCHIVED_ITEM_COUNT.md](46_RC20_ARCHIVED_ITEM_COUNT.md)
- [47_RC21_CLIENT_TYPECHECK_AND_CONTRACT.md](47_RC21_CLIENT_TYPECHECK_AND_CONTRACT.md)
- [48_RC22_STORAGE_AND_REVISION_TRACEABILITY.md](48_RC22_STORAGE_AND_REVISION_TRACEABILITY.md)
- [49_RC23_LONGWORK_HARNESS_AND_GATE.md](49_RC23_LONGWORK_HARNESS_AND_GATE.md)
- [50_PHASE7_HANDOFF.md](50_PHASE7_HANDOFF.md)
- [51_RC24_PR1_SALVAGE_AND_MEMORY_CEILING.md](51_RC24_PR1_SALVAGE_AND_MEMORY_CEILING.md)
- [52_PHASE7_ORACLE_GATE_AND_BLOCKERS.md](52_PHASE7_ORACLE_GATE_AND_BLOCKERS.md)
- [53_RC25_PR2_LANDED_AND_FOLD_CONTAINMENT.md](53_RC25_PR2_LANDED_AND_FOLD_CONTAINMENT.md)
- [54_RC26_MEMORY_CAP_IS_A_HOST_PROPERTY.md](54_RC26_MEMORY_CAP_IS_A_HOST_PROPERTY.md)
- [56_RC28_FOLD_REACHABILITY_AND_PROVIDER_FAILURE.md](56_RC28_FOLD_REACHABILITY_AND_PROVIDER_FAILURE.md)

## How to read old conclusions

A numbered document is a record of what was known at that stage. It may contain claims that a later report falsified. That is intentional.

When a historical claim conflicts with current stable documentation:

1. treat the current README / USER_GUIDE / ARCHITECTURE as the product contract;
2. read the later numbered report for the correction;
3. keep the older report as provenance for why the project changed direction.

`MANIFEST.json` records the historical document inventory and hashes. It is an audit artifact, not the navigation surface.
