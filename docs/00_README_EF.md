# Epistemic Fold (EF) 项目入口

> **这是什么**：一个 DSH compaction backend 插件，把"折叠一段轨迹"从一次有损摘要
> 变成一次可验证的事务。
> **读它做什么**：理解 EF 的模型、它的九条不变量、以及它刻意不做什么。
> **安装与运维**：[README](../README.md) 与 [42_DEPLOYMENT_CHAIN.md](42_DEPLOYMENT_CHAIN.md)。

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

**Epistemic Fold 是项目名；epistemic context runtime 是它是什么。**

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

即：当历史轨迹的知识效应已被 decision、evidence、artifact、constraint、negative
knowledge、uncertainty 等更稳定对象承载后，把原轨迹从 active context 中折叠出去。

名字保留 `dsh-` 前缀：EF 明确建立在 DSH 的 `ctx.compaction` /
`ctx.sessionProjections` / Session surface / `tokenMeter` / tool pipeline 等原语上，
不是已抽象完成的通用框架。为避免过早为跨 Harness 泛化付出架构成本，它保持单一包形态。

---

## 1. 项目目标

EF 要解决的不是"上下文太长"，而是**长周期会话中，压缩本身会引入的四类错误**：

| 错误 | 表现 | EF 的对应机制 |
|---|---|---|
| **summary drift** | 摘要与原始事实逐渐脱节，且无法察觉 | canonical truth 不可变；摘要永不验证状态（I3） |
| **stale state** | 旧值被当成当前值（"现在用哪个端口"） | 确定性状态派生 + supersession（I3） |
| **unrecoverable loss** | 折叠掉的内容再也拿不回来 | 有损处理前先落 durable archive（I2）+ 有界召回（I8） |
| **prefix churn** | 每次压缩都改写缓存前缀，成本反升 | 单调 Fold Frontier，已冻结内容绝不重折叠（I6） |

优化目标不是最大压缩率。顺序是：**correctness first** —— 在硬正确性约束下，
再谈信息密度、prefix cache 局部性、长期状态一致性与闭环延续稳定性。

---

## 2. 项目定位

**Epistemic Fold (EF)** — A contract-preserving epistemic context runtime for DeepSeek Harness

更工程化的描述：

> Event-sourced, state-aware, cache-conscious, provenance-preserving context runtime
> for long-horizon agents.

EF 不是以下任意一种方案的简单拼接，而是抽取其正交机制：

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

它**不是**：一个 embedding 记忆库、一个摘要服务、一个多级 RAG 系统。这些机制在
EF 里都没有实现，且都有实测理由说明为何不做（见 §5）。

---

## 3. 证据等级

实现过程中必须区分三类结论。EF 的每条主张都携带其证据状态，本文件同样如此。

### 3.1 外部研究/行业依据

来自论文、公开系统与行业实践的机制借鉴。**这类依据只提供假设，不构成对 EF
有效性的证据。**

### 3.2 已核验 DSH 能力

在本机真实 DSH 上实测确认的行为。例如：loader 的行寻址规则、`ctx.inject` 的可选
服务语义、`compaction/summary` 事件携带 `shadowedSeqs`、session projection 的 wire
view 契约。这类结论有复现步骤，且写进了对应文档。

### 3.3 EF 自身新增设计

EF 自己的机制，**必须由本项目自己的测量支撑**。EF 对未测量的机制标注
`HYPOTHESIS`，而不是借用外部依据的名义。这是本项目反复纠正过的一类错误
（见 [20_RC1_1_EVIDENCE_RECONCILIATION.md](20_RC1_1_EVIDENCE_RECONCILIATION.md)）。

---

## 4. 九条核心不变量

这九条是 EF 的契约，也是阅读任何实现细节时的判据。

### I1 — Truth is immutable

折叠只改变模型工作 surface，不改变 canonical truth。

### I2 — No lossy reduction without durable provenance

任何有损处理之前必须先存在可验证的 source reference 或 artifact/archive。
实现为 `BundleDurable ≺ SurfaceLoss`：bundle 落盘先于 surface 替换提交。

### I3 — Narrative cannot create authoritative state

LLM semantic summary 只能解释，不得独立产生 verified state。
`Raw → State` 与 `Raw → Summary` 并行；`Raw → Summary → State` 被禁止。

### I4 — Hard dependency boundaries may not disappear

跨越被折叠 span 的 hard dependency 必须在 checkpoint interface 中保留。

### I5 — Unresolved obligations may not silently disappear

pending validation、open failure、commitment、approval condition、open question
都必须有明确生命周期。

### I6 — Normal leaf fold advances a monotonic fold frontier

日常折叠只压 frontier 之后的闭合连续 span。已冻结内容不重折叠，因此缓存的 prefix
在多次折叠间逐字节稳定。

### I7 — Frozen surface changes only transactionally

只有 Leaf fold checkpoint、Root rebase、Emergency recovery 可以改 frozen surface，
且每次都经由同一事务路径。

### I8 — Recall is bounded and provenance-based

禁止"搜索后一次性重新注入 50K–100K 历史"。召回是有界、分页、带 provenance 校验的。

### I9 — Compression quality is behavioral

最终评价是 Agent 后续行为和任务结果，而不是摘要语义相似度。

---

## 5. 建了什么，按什么顺序，以及刻意不建什么

推荐的开发顺序是：

\[
\boxed{
M0 \rightarrow M2 \rightarrow M3a \rightarrow M1 \rightarrow M3b \rightarrow M4/M5
}
\]

前三步已建成并被测量；后三步经证据判定**不做**。这个顺序本身就是一条结论：
**先建不需要模型的那一层。**

| 阶段 | 内容 | 状态 |
|---|---|---|
| **M0** Recall correctness | 单一 EF backend、CheckpointBundle、exact archived history、有界 `context_search`/`context_recall`、确定性 fallback | ✅ **已建成** |
| **M2** Prefix correctness | Fold Frontier、immutable leaf checkpoint、automatic = Leaf Fold、manual `/compact` = Root Fold、prefix 指纹测试 | ✅ **已建成** |
| **M3a** State correctness | 确定性状态派生：objective、constraint、values、decision、evidence、failure、obligation、supersession | ✅ **已建成** |
| **M1** Verified ingress reduction | artifact-backed tool-output 缩减 | ⛔ **CLOSED / deferred** — 仅在工具输出真实存在处收益，实测上限不足以支撑复杂度 |
| **M3b** Semantic epistemic state | negative knowledge、uncertainty、语义分类 | ⛔ **CLOSED / deferred** — 无测量证据显示必要 |
| **M4/M5** Dependency graph | hard dependency graph、graph quotient、multi-level generations、adaptive planner | ⛔ **CLOSED / deferred** — 无测量证据显示必要 |
| — | `DeltaLeaf`（生产化 delta 折叠） | ❌ **REJECTED** — R1-B gate 实测 ROI 上限 3.7–16.6%，不足以支撑 |

这些阶段在后续报告中不再重复讨论；**仅当新的故障语料产生对应证据时才重新开启**。

### 为什么"甜点位"是 M3a 那一层

最值得验证的生产甜点位不是"全功能 EF"，而是：

\[
\boxed{
M3a = \text{Exact Archive/Recall} + \text{Fold Frontier}
+ \text{Immutable Checkpoint} + \text{Deterministic Current State}
}
\]

该层：

- 不需要 embedding；
- 不需要每轮 LLM compression；
- 不需要完整 semantic dependency graph；
- 不需要 learned planner；
- 已经能够显著降低 summary drift、stale state、旧值混淆和 prefix churn。

这不是假设：`economy` 档位已实测在**与 Basic 质量持平**的前提下把成本降到约
1/17，并在两次独立的 n=9 运行中复现
（[22_RC1_3](22_RC1_3_RETRIEVAL_ERGONOMICS.md)）。

---

## 6. 术语表

| 术语 | 含义 |
|---|---|
| **Epistemic Fold Runtime** | 架构名称 |
| **Epistemic Folding** | 核心机制名称 |
| **Leaf Fold** | 日常稳定前缀折叠（automatic pressure maintenance） |
| **Root Fold** | 主动全局重整（manual `/compact`、极低频 rebase） |
| **Fold Frontier** | 冻结前缀与开放轨迹之间的边界 |
| **Fold Checkpoint** | 折叠产生的 checkpoint |
| **Fold Bundle** | checkpoint 的 durable 存储单元（CheckpointBundle） |
| **Fold Bundle Store** | bundle 存储层 |
| **Fold Archive** | 折叠前的精确归档 |
| **Fold Projection** | host-side bounded 当前状态投影 |
| **Marker (`EF1`)** | checkpoint 体内的折叠身份标记，用于区分 leaf 与 root |

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

## 7. 代码结构

实际结构（完整清单见 [README](../README.md#repository-layout--仓库结构)）：

```text
src/
  engine.ts             EpistemicFoldEngine — Basic 事务 + EF compile hook
  bundle-store.ts       原子写、哈希校验、0600 权限
  compiler.ts           输入切分、canonical bundle 构建、checkpoint 渲染
  frontier.ts           Fold Frontier：从当前 surface 重定位
  state.ts              确定性 StateReducer：anchors、supersession、lifecycles
  authority.ts          哪些事件类型可以支撑哪些 authority 域
  recall.ts             context_search + context_recall（有界、分页、精确）
  renderer.ts           结构化 checkpoint
  preset.ts             档位阶梯及其证据状态
  status.ts             /context status 模型（对调用方数据的纯函数）
  status-projection.ts  面向客户端的投影（侧边栏的数据源）
  basic/                vendor 的 DSH Basic 副本（内联 frameCheckpoint seam）
client.js               浏览器侧边栏面板（手写，无打包器）
```

**`src/basic/` 是 vendor 副本，不要按普通源码修改。** 它是 DSH Basic 后端的
逐字节镜像，由脚本重新生成，并有 drift 测试守卫。改它会破坏 `mode: basic`
的一致性保证。理由见 [31_RC7](31_RC7_TRANSFORMATION_PLAN.md)。

---

## 8. 文档索引

完整索引（49 份，按类别分组）在 [README](../README.md#documentation--文档)。

按阅读目的：

| 你想知道 | 读 |
|---|---|
| 怎么装、怎么运维 | [42_DEPLOYMENT_CHAIN.md](42_DEPLOYMENT_CHAIN.md) |
| 架构与数据模型 | [01_EF_RFC_001_ARCHITECTURE.md](01_EF_RFC_001_ARCHITECTURE.md) |
| 决策记录与开放问题 | [05_EF_DECISIONS_AND_OPEN_QUESTIONS.md](05_EF_DECISIONS_AND_OPEN_QUESTIONS.md) |
| 评测方法与结果 | [09](09_EVALUATION_METRICS_SPEC.md)、[12](12_R1_EVALUATION_REPORT.md)、[17](17_R4_EVALUATION_REPORT.md) |
| 交互表面如何被验证 | [37](37_RC11_BROWSER_VERIFICATION.md)、[47](47_RC21_CLIENT_TYPECHECK_AND_CONTRACT.md) |
| 出过什么错、怎么修的 | 从 [38](38_RC12_PRESET_BACKEND_DOCTOR_DEFECT.md) 起的缺陷记录 |

---

## 9. 最终原则

核心命题：

> An agent may fold a trajectory only after its externally relevant epistemic
> effects have been materialized, preserved, and made recoverable.

中文：

> **只有当一段轨迹对未来仍有意义的知识效应已经被稳定对象吸收、关键状态与边界
> 得到保留、且原始证据可以恢复时，该轨迹才有资格被折叠出工作上下文。**

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
