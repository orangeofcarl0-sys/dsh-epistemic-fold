# Epistemic Fold (EF) 项目总览

> 状态：可实施设计基线  
> 目标宿主：DeepSeek Harness (DSH) `0.1.7-rc.2`  
> 已核验 DSH 基线：`477b4f420553e8a52c2fbccc464d7561b239c443`（master，release/dsh-0.1.7-rc.2）  
> 本文档用途：作为本地 Agent 的项目入口、范围约束与交付索引。

---

## 0. 命名体系

| 层级 | 名称 |
|---|---|
| **项目名** | **Epistemic Fold** |
| **短名** | **EF** |
| **GitHub 仓库** | **`dsh-epistemic-fold`** |
| **DSH 插件/包名** | **`dsh-epistemic-fold`** |
| **架构名称** | **Epistemic Fold Runtime** |
| **核心机制名称** | **Epistemic Folding** |
| **技术副标题** | **A contract-preserving context runtime for DeepSeek Harness** |

README 第一屏：

> **Epistemic Fold for DeepSeek Harness**  
> *A contract-preserving context runtime for long-horizon agents.*

> **Epistemic Fold 是项目名；epistemic context runtime 是它是什么。**

命名理由：Epistemic Fold 表达的不是单纯"压缩状态"，而是：

\[
\boxed{
\text{trajectory / reasoning / observations}
\rightarrow
\text{epistemic state}
\rightarrow
\text{fold}
}
\]

即：当历史轨迹的知识效应已被 decision、evidence、artifact、constraint、negative knowledge、uncertainty 等更稳定对象承载后，把原轨迹从 active context 中折叠出去。

名字保留 `dsh-` 前缀：第一阶段明确建立在 DSH 的 `ctx.compaction` / `ctx.sessionProjections` / Session surface / `tokenMeter` / tool pipeline / `BasicCompactionEngine` 等原语上，不是已抽象完成的通用框架，避免过早为跨 Harness 泛化付出架构成本。未来真正完成宿主解耦后再演化为 monorepo：

```text
epistemic-fold/
├── packages/
│   ├── core/
│   ├── dsh/
│   ├── bench/
│   └── recall/
```

即 `Epistemic Fold`（上层项目）→ `DSH Epistemic Fold`（DSH adapter/backend）。**现在不做这个拆分。**

---

## 1. 项目目标

Epistemic Fold 不是"更强的聊天摘要器"，而是面向长周期 Agent 的上下文运行时。

核心目标：

\[
\boxed{
\text{History} \neq \text{Memory} \neq \text{Context}
}
\]

EF 将长期运行状态拆为：

\[
\text{Immutable Truth}
\rightarrow
\text{Current Epistemic State}
\rightarrow
\text{Checkpoint Knowledge}
\rightarrow
\text{Model Working Set}
\]

系统持续回答三个问题：

1. 什么信息根本不应该进入模型工作上下文？
2. 哪些历史知识已经被更稳定的状态、证据、artifact 或 checkpoint 吸收，因此可以退出 working set？
3. 当前模型为了下一步正确行动，最少需要看到什么？

EF 的主要优化目标不是最大化压缩率，而是在硬正确性约束下提高：

- working-context 信息密度；
- prefix cache 局部性；
- 长期状态一致性；
- exact recall 能力；
- closed-loop continuation 稳定性。

---

## 2. 项目定位

架构定义：

**Epistemic Fold (EF)** — A contract-preserving epistemic context runtime for DeepSeek Harness

更加工程化的描述：

> Event-sourced, state-aware, cache-conscious, provenance-preserving context runtime for long-horizon agents.

项目不是以下任意一种方案的简单拼接：

- PiDeck；
- Instant/VCC；
- ARGP；
- dsh-compressor。

而是抽取其正交机制：

| 来源 | EF 吸收的机制 |
|---|---|
| PiDeck | immutable epoch、stable-prefix / fold-frontier 思想 |
| Instant/VCC | exact provenance、deterministic emergency representation、recall |
| ARGP | dependency-aware retention、guard philosophy |
| dsh-compressor | ingress entropy reduction / first-view reduction |
| Context-Folding | task hierarchy → context hierarchy |
| TRACE 类研究 | semantic similarity ≠ behavioral equivalence |
| ACON 类研究 | compression policy 可以根据失败/后悔反馈优化 |
| reasoning forgetting 研究 | reasoning 外化后更容易安全退出 working set |

---

## 3. 证据等级

实现过程中必须区分三类结论。

### 3.1 外部研究/行业依据

来自用户提供的企业级 context-compression 研究总结，包括：

- compaction 已成为长周期 Agent 基础机制；
- compaction alone 不足以承担全部长期状态；
- external artifact / structured handoff / context reset 很重要；
- task hierarchy 可以用于 context folding；
- reasoning 的结果被可靠外化到代码、文件、工具结果、环境状态后，旧 reasoning 更容易被安全遗忘；
- compression 必须评价 closed-loop continuation，而不是只比较文本相似度；
- compressor policy 可以通过 compression failure 反向优化；
- 企业级趋势正在从"压一个巨大的 context"转向"避免构造巨大的 context"。

这些结论是设计依据，但不能当作 EF 自身架构已经被证明。

### 3.2 已核验 DSH 能力

当前 `0.1.7-rc.2` 已核验：

- Session 是 append-only event log；
- model history 是 Session surface 的派生；
- compaction 使用 `surfaceOp: replace`，shadow 原 surface，但不删除历史；
- `ctx.compaction` 是独立 capability seam；
- 同一 context 只应加载一个 compaction implementation；
- `CompactionEngine` 提供 `compactIfNeeded` / `compactNow` / `compactRegion`；
- `BasicCompactionEngine` 已实现 lock、range validation、tool-call/result pairing、summary call、surface revalidation、replace、end 等事务；
- `summarize()` 是 Basic 的 subclass customization hook；
- `ctx.sessionProjections` 可把 committed session events 同步 fold 为 per-session host state，并支持 checkpoint cache；
- tool pipeline 顺序包括 `projectContent → tools/post-execute → finalizeContent → durable tool/result`；
- 新 production code 不应建立在 deprecated `eventAt/snapshotEvents/ownEvents` 随机读取接口上。

### 3.3 EF 自身新增设计

以下属于 EF 推演，需要 benchmark/测试证明：

- Checkpoint 六元 Ports；
- Fold Frontier；
- CheckpointBundle-before-loss；
- Leaf Fold / Root Fold / Emergency Fold 三种 compaction 语义；
- Authority Model；
- deterministic StateReducer；
- Negative Knowledge / Uncertainty；
- Prefix Mutation Amplification；
- Recall Debt；
- State Ambiguity；
- future Graph Quotient / Generational hierarchy。

---

## 4. 九条核心不变量

### I1 — Truth is immutable

折叠只改变模型工作 surface，不改变 canonical truth。

### I2 — No lossy reduction without durable provenance

任何有损处理之前必须先存在可验证的 source reference 或 artifact/archive。

### I3 — Narrative cannot create authoritative state

LLM semantic summary 只能解释，不得独立产生 verified state。

### I4 — Hard dependency boundaries may not disappear

跨越被折叠 span 的 hard dependency 必须在 checkpoint interface 中保留。

### I5 — Unresolved obligations may not silently disappear

pending validation、open failure、commitment、approval condition、open question 都必须有明确生命周期。

### I6 — Normal leaf fold advances a monotonic fold frontier

日常折叠只压 frontier 之后的闭合连续 span。

### I7 — Frozen surface changes only transactionally

只有 Leaf fold checkpoint、Root rebase、Emergency recovery、未来 Hard handoff 可以改 frozen surface。

### I8 — Recall is bounded and provenance-based

禁止"搜索后一次性重新注入 50K–100K 历史"。

### I9 — Compression quality is behavioral

最终评价是 Agent 后续行为和任务结果，而不是摘要语义相似度。

---

## 5. 推荐开发顺序

不要按"功能看起来最炫"的顺序开发。

推荐：

\[
\boxed{
M0 \rightarrow M2 \rightarrow M3a \rightarrow M1 \rightarrow M3b \rightarrow M4/M5
}
\]

### M0 — Recall correctness

建立：

- 单一 EF compaction backend；
- CheckpointBundle；
- exact archived model history；
- bounded `context_search/context_recall`；
- semantic failure deterministic fallback。

### M2 — Prefix correctness

建立：

- Fold Frontier；
- immutable leaf checkpoint；
- automatic = Leaf Fold；
- manual `/compact` = Root Fold；
- rare root rebase；
- prefix fingerprint tests。

### M3a — State correctness

建立 deterministic：

- objective；
- explicit constraint；
- current values；
- decision；
- evidence；
- failure；
- obligation；
- supersession；
- current state heads。

### M1 — Verified ingress reduction

等核心架构稳定以后再做：

- artifact-backed tool-output reduction；
- only verified-compatible tools；
- audit `finalizeContent` interference。

### M3b — Semantic epistemic state

最后加入模型辅助：

- negative knowledge；
- uncertainty；
- semantic classification；
- durable classification events。

### M4/M5 — 有证据再做

只有 benchmark 显示 M3 仍受跨 checkpoint 隐式依赖或超长 leaf/root 结构限制时，才实现：

- hard dependency graph；
- graph quotient；
- multi-level generations；
- adaptive planner；
- hard cross-session handoff。

---

## 6. 生产甜点位假设

当前最值得验证的生产甜点位不是"全功能 EF"，而是：

\[
\boxed{
M3a =
Exact Archive/Recall
+
Fold Frontier
+
Immutable Checkpoint
+
Deterministic Current State
}
\]

该层：

- 不需要 embedding；
- 不需要每轮 LLM compression；
- 不需要完整 semantic dependency graph；
- 不需要 learned planner；
- 已经能够显著降低 summary drift、stale state、旧值混淆和 prefix churn。

---

## 7. 目录与交付

本包建议先保持非常小：

```text
dsh-epistemic-fold/
├── src/
│   ├── engine.ts
│   ├── candidate.ts
│   ├── bundle-store.ts
│   ├── compiler.ts
│   ├── recall.ts
│   └── types.ts
├── tests/
└── package.json
```

M2 再增加：

```text
frontier.ts
leaf-policy.ts
root-policy.ts
```

M3a 再增加：

```text
projection.ts
state.ts
authority.ts
renderer.ts
```

不要提前创建 graph/embedding/planner 模块。

---

## 8. 术语表

统一命名概念体系：

| 术语 | 含义 |
|---|---|
| **Epistemic Fold Runtime** | 架构名称 |
| **Epistemic Folding** | 核心机制名称 |
| **Leaf Fold** | 日常稳定前缀折叠（automatic pressure maintenance） |
| **Root Fold** | 主动全局重整（manual `/compact`、极低频 rebase） |
| **Emergency Fold** | 确定性溢出恢复（provider-confirmed context overflow） |
| **Fold Frontier** | 冻结前缀与开放轨迹之间的边界（原 Freeze Frontier） |
| **Fold Checkpoint** | 折叠产生的 checkpoint |
| **Fold Bundle** | checkpoint 的 durable 存储单元（CheckpointBundle） |
| **Fold Bundle Store** | bundle 存储层 |
| **Fold Validator** | 折叠安全验证器 |
| **Fold Benchmark** | 行为基准测试 |
| **Fold Archive** | 折叠前的精确归档 |
| **Fold Projection** | host-side bounded 当前状态投影 |

surface 层次：

```text
Frozen Prefix
        │
        ▼
Fold Frontier
        │
        ▼
Open Trajectory
```

---

## 9. 文档索引

- `01_EF_RFC_001_ARCHITECTURE.md`  
  架构规范、数据模型、不变量、三类 fold transaction、DSH integration。

- `02_EF_IMPLEMENTATION_PLAN_M0_M3.md`  
  可直接执行的工程任务 DAG、类设计、阶段 Gate、stop conditions。

- `03_EF_TEST_BENCHMARK_SPEC.md`  
  machine-proof tests、crash tests、prefix tests、behavioral benchmark、指标。

- `04_EF_LOCAL_AGENT_WORK_ORDER.md`  
  可直接交给本地 coding agent 的执行说明和节奏要求。

- `05_EF_DECISIONS_AND_OPEN_QUESTIONS.md`  
  已冻结决定、明确不做事项、待实验决定的问题。

---

## 10. 最终原则

Epistemic Fold 的核心命题：

> An agent may fold a trajectory only after its externally relevant epistemic effects have been materialized, preserved, and made recoverable.

中文：

> **只有当一段轨迹对未来仍有意义的知识效应已经被稳定对象吸收、关键状态与边界得到保留、且原始证据可以恢复时，该轨迹才有资格被折叠出工作上下文。**

实现时始终坚持：

\[
\boxed{
Correctness\ first,\ Optimization\ second
}
\]

以及：

\[
\boxed{
Policy\ chooses;\ Validator\ vetoes.
}
\]
