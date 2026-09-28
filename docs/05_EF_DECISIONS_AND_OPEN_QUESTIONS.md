# Epistemic Fold 决策记录与开放问题

> 目的：防止本地 Agent 在实现过程中重新打开已经讨论清楚的架构问题，或把尚未验证的推演误当作已冻结事实。

---

# A. 已冻结决定

## D-001：EF 不是多个 compaction plugin 串联

只允许一个历史 surface owner。

```text
ctx.compaction → Epistemic Fold
```

其他机制只能作为：

- reducer；
- projection；
- index；
- validator；
- recall；
- telemetry。

---

## D-002：Truth 与 Surface 分离

Canonical truth：

```text
DSH Session + Artifact
```

Surface 是可重建 projection。

CheckpointBundle 是 retrieval materialization，不是第二 canonical Session。

---

## D-003：M0 优先复用 Basic transaction

不复制：

```text
lock
start/end
range validation
tool pairing
surface revalidation
replace
failure semantics
```

EF 自己拥有：

```text
selection
archive
representation
state
```

---

## D-004：automatic = Leaf Fold；manual `/compact` = Root Fold

这是有意设计，不是 workaround。

Leaf Fold：

```text
高频 / 低 prefix mutation
```

Root Fold：

```text
低频 / 接受 cache reset / 全局整理
```

Emergency Fold 单独处理。

---

## D-005：Bundle-before-loss

任何 EF 有损 surface replacement 前：

```text
final Bundle MUST be durably published
```

如果 publish 失败：

```text
no lossy commit
```

---

## D-006：Semantic Summary 不拥有 state authority

StateReducer 与 Semantic Summarizer 并行。

```text
Raw Events → State
Raw Events → Semantic
```

禁止：

```text
Raw → Summary → State
```

---

## D-007：Knowledge Projection 必须 bounded

禁止长期：

```text
all history → NodeFact map
```

只维护：

```text
hot tail
active heads
open obligations/failures
current checkpoint refs
```

---

## D-008：seq != surface position

任何 range/frontier algorithm 都根据当前 surface ordering。

禁止用 seq 数值大小代替 position。

---

## D-009：No-core-change 优先

M0/M2/M3a 应优先在插件/包层完成。

只有真实 benchmark 证明某个 DSH seam 缺口阻止重大收益时，才提出最小 upstream change。

---

## D-010：Ingress reduction 推迟

原因：

当前：

```text
projectContent
→ post-execute
→ finalizeContent
→ materialize
```

纯插件层没有 universal post-finalize final-content seam。

先完成 M0/M2/M3a。

---

## D-011：M3a 先于 M3b

先 deterministic state。

再加入：

```text
negative knowledge
uncertainty
LLM semantic classification
```

---

## D-012：Graph 不作为 M3 前置

Hard dependency graph 只在 M3 benchmark 显示：

```text
主要错误来自跨 checkpoint 隐式依赖
```

时进入 M4。

---

## D-013：Embedding/vector DB 不作为基础设施

M0–M3 search 使用：

```text
exact ids
paths
hashes
lexical/FTS
checkpoint text
state keys
```

足够。

---

## D-014：Recall 默认 bounded

即使 archive 是 100K，也不得一次性返回 100K。

---

## D-015：EF failure must be soft

EF Bundle 丢失：

```text
degraded recall
```

而不是：

```text
Session cannot open
```

---

# B. 当前假设，必须通过实验验证

## H-001：M3a 可能是生产甜点位

假设：

```text
Exact Recall
+ Stable Leaf Fold
+ Deterministic State
```

已经解决主要长期错误。

如果数据支持，可以停在 M3a/M1。

---

## H-002：Stable prefix 的实际经济收益取决于 provider

本地可证明：

```text
prefix bytes stable
```

但真实 cache hit / cost 仍受：

- provider；
- routing；
- TTL；
- cache implementation。

因此必须分 architecture metric 和 provider metric。

---

## H-003：结构化 state 可能提高性能，而不只是省 token

原因：

减少 simultaneous stale/conflicting state。

需要用：

```text
State Ambiguity Rate
Duplicate Work Rate
```

验证。

---

## H-004：Root Fold rebase 应非常低频

M2 semantic-only root fold 仍有 summary drift。

M3a 后才更适合自动化。

---

# C. 开放问题

## Q-001：EF pressure threshold 取多少？

暂不冻结。

先做参数：

```text
prepareRatio
compactRatio
emergencyRatio
targetWorkingRatio
```

用 benchmark 决定。

---

## Q-002：Bundle 是否需要压缩文件格式？

第一版：

- 可以 plain JSON；
- 若实际磁盘占用明显，再加 zstd/gzip。

逻辑 hash 与文件 hash 分开。

---

## Q-003：Bundle storage location

应遵循 DSH per-session storage lifecycle。

待实现时根据 persistence package convention 决定。

硬要求：

- same session boundary；
- restricted permissions；
- atomic；
- deletable。

---

## Q-004：如何识别 explicit user constraint？

M3a 只做明显 deterministic/structured cases。

不要为了覆盖所有自然语言 constraint 一开始就引入全局 LLM classifier。

无法确定的用户文本可以保守保留在 recent/raw checkpoint semantic 中。

---

## Q-005：如何识别 current StateKey？

第一阶段只支持有明确 entity/property 的领域：

```text
config
artifact
failure
validation
task objective
```

不要泛化成 universal ontology。

---

## Q-006：M1 是否值得 upstream tool seam？

只有以下同时成立才考虑：

1. tool-heavy workload 成本显著由 first-view raw output 主导；
2. verified allowlist 过窄；
3. post-execute/finalize interference 真实发生；
4. 新 seam 可以保持很窄、可审计。

---

## Q-007：Hard Handoff Reset 何时做？

不是 M0–M3。

只有真实长期 session heap/log 成为产品 blocker 时进入。

---

## Q-008：是否需要完整 ARGP 风格 semantic dependency？

未确定。

先看 M3a failure corpus。

如果绝大多数错误可以由：

```text
current state
obligations
negative knowledge
exact recall
```

解决，则不应引入完整 semantic graph。

---

# D. 明确不再重新讨论的问题

除非新实验证据推翻，不要重新打开：

1. "是否把四个插件同时安装并都允许改 history？"  
   **否。**

2. "是否让 summary 作为数据库？"  
   **否。**

3. "是否每轮调用 LLM compressor？"  
   **默认否。**

4. "是否为了 exact recall 直接依赖 deprecated random Session reader？"  
   **否。**

5. "是否按 seq 数值决定 surface range？"  
   **否。**

6. "是否在 Bundle 落盘失败后仍允许有损 checkpoint？"  
   **否。**

7. "是否在 correctness 未闭合前做 adaptive RL planner？"  
   **否。**

8. "是否把 M0–M3 宣称为 Session log GC？"  
   **否。**

---

# E. 研究依据与 EF 新推演的边界

## 外部研究支持

用户提供的企业级研究总结支持以下方向：

- Agent context compression 已从静态 prompt compression 演化到 state/trajectory-aware forgetting；
- compaction alone 不够；
- structured handoff、external artifact、reset 有价值；
- task hierarchy 可用于 context folding；
- reasoning 外化后更容易遗忘；
- behavioral equivalence 比 summary similarity 更重要；
- compressor policy 可通过失败反馈改进；
- 企业 context architecture 强调"正确 context"，而不是单纯更大 context。

## EF 自己提出、必须验证

- Checkpoint 六元 Ports；
- Fold Frontier；
- automatic Leaf Fold / manual Root Fold；
- Bundle-before-loss；
- State Ambiguity Rate；
- Prefix Mutation Amplification；
- Recall Debt；
- bounded hot projection；
- future graph quotient；
- M3a 是甜点位的假设。

本地 Agent 不得把第二类表述成"已有论文已证明"。

---

# F. 下一次设计升级的触发条件

只有当 M0/M2/M3a 数据表明以下任一问题是主要瓶颈时升级：

### 触发 M1

```text
first-view tool output cost dominates
```

### 触发 M3b

```text
duplicate work / uncertainty drift dominates
```

### 触发 M4

```text
cross-checkpoint hidden dependency loss dominates
```

### 触发 M5

```text
leaf/root fold hierarchy no longer scales
```

### 触发 Hard Handoff

```text
live Session log/process-memory becomes blocker
```

原则：

\[
\boxed{
Do\ not\ build\ the\ next\ layer\ without\ observed\ failure\ that\ needs\ it.
}
\]
