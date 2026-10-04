# Epistemic Fold 架构

[English](ARCHITECTURE.md)

## 1. 模型

Epistemic Fold 把长周期 Agent 的上下文，看作一份更持久记录之上的工作集。

```text
Canonical truth
  ├─ DSH session events
  └─ Fold bundles / artifacts
          │
          ▼
Deterministic projection
  ├─ current state
  └─ open trajectory
          │
          ▼
Checkpoint compiler
          │
          ▼
Frozen prompt surface
          │
          ├─ recent open tail
          └─ search / recall → bundles
```

架构层面的陈述是：

```text
History ≠ Memory ≠ Context
```

History 是持久记录。Memory 是系统能够恢复或推导出来的东西。Context 是模型在下一次请求里需要的东西。

## 2. 核心契约

EF 建立在这些规则之上：

1. **真相不会被 compaction 重写。**
2. **有损的 surface 缩减只在持久 provenance 存在之后发生。**
3. **叙述性摘要不是权威状态。**
4. **未解决的 constraint / failure / obligation 不得静默消失。**
5. **普通折叠只推进单调的 Fold Frontier。**
6. **frozen surface 的变更走同一条 compaction 事务路径。**
7. **召回是有界的、在被要求时是精确的、且带 provenance。**
8. **压缩由闭环行为来评判，而不是由摘要相似度来评判。**

更早的 RFC 把这些列为一个更大的编号不变量集合；本文档只保留当前架构契约。历史规格见 [01_EF_RFC_001_ARCHITECTURE.md](01_EF_RFC_001_ARCHITECTURE.md)。

## 3. Fold 事务

一个候选 fold 是 model-visible surface 上一段连续且合法的 span。

```text
surface before
────────────────────────────────────────────
frozen checkpoints | frontier | open span | tail
                               └── candidate
```

事务顺序很重要：

```text
select candidate
      ↓
write exact CheckpointBundle
      ↓
derive state / checkpoint body
      ↓
commit DSH surface replacement
      ↓
re-derive frontier
```

bundle 写入必须在有损替换提交**之前**成功。

### CheckpointBundle

一个 bundle 包含校验与恢复这次 fold 所需的信息：

- checkpoint id / mode；
- 被遮蔽的精确 model-visible messages；
- canonical hash；
- 渲染后的 checkpoint；
- 可选的语义输出与 usage 元数据；
- 来源 / provenance 信息。

bundle 文件以原子方式写入，并使用受限权限。

## 4. Fold Frontier

Fold Frontier 把 frozen context 与 open trajectory 分开。

```text
[Frozen C1][Frozen C2][Frozen C3] | [Open turns...]
                                   ^
                               frontier
```

普通 Leaf Fold 只在这条边界之后操作。这避免了递归式的"摘要的摘要"重写，并改善 prefix 稳定性。

frontier 是从当前 surface **推导**出来的，而不是被当作一个独立可变指针来信任。

## 5. Leaf 与 Root fold

### Leaf Fold

默认的增量维护路径：

- 选择一段合法的 open span；
- 归档它；
- 用 EF checkpoint 替换它；
- 让更早的 frozen checkpoint 保持逐字节稳定。

### Root Fold

对更大 frozen 区域的一次 rebase：

- 当长期 carry cost 值得这次一次性的 prefix 变更时使用；
- 用 provider/model 经济性来评估，而不是用"每 N 次 fold 就合并一次"这种通用规则；
- 通常通过 idle 维护路径执行。

Root fold 故意保持低频。

## 6. State 与 authority

EF 有一套用于有界当前状态的规范化词汇：

```text
objective
constraint
decision
value
artifact
evidence
failure
obligation
```

state reducer 是确定性的，并支持 supersession / lifecycle 语义。

比词汇更重要的是 authority 规则：

```text
Raw Events ──► State
     │
     └──────► Narrative Summary

Narrative Summary ─X─► authoritative State
```

模型写的 rationale 可以解释一个 checkpoint，但它不能独立验证一个事实，也不能关闭一个 failure。

## 7. State 归属与当前限制

上面的词汇是**表示层**的。EF 不替代 DSH 中已有的 canonical owner。

| 领域 | canonical owner | EF |
| --- | --- | --- |
| 完成目标 | DSH goal service | 不重复 |
| 当前 plan / todo | DSH planning/todo | 不重复 |
| 项目级 guidance | `AGENTS.md` / instruction loader | 不重复 |
| 失败的工具结果 | 原始 `tool/result` | 存在自动的 EF 状态推导 |
| 临时 session 断言 | 无通用 owner | 可表示；无通用 producer |
| decisions / evidence / artifacts / obligations | 无通用 owner | 可表示；无通用 producer |

自定义 `ef/anchor` 事件受 authority gate 约束，但**能否持久化**取决于宿主是否保留 plugin-event envelope 元数据。在不能保留的宿主上，EF 必须 fail closed，而不是写出一个宿主无法重新打开的 session log。

## 8. 召回

compaction 不能让信息变得不可恢复。

### Search

`context_search` 扫描已折叠的 bundle，返回有界的指针 / 摘录。当前契约包括：

- 按会话逻辑时序排序；
- 较新的匹配证据优先；
- 更早的匹配仍然可达；
- 精确的 matched-message 索引；
- 有界的 verbatim 摘录；
- 显式 provenance。

### 精确召回

`context_recall` 可以返回 checkpoint 视图，或精确的 archived messages。精确分页取自归档，而不是从摘要重建。

## 9. Prefix 与 cache 经济性

EF 优化 prefix 稳定性，但 prefix 稳定性本身不是正确性不变量。

不同 provider 的 cache 经济性不同。一个 warm token 可能比 cold token 便宜得多，但它仍然占用 context window，并可能增加延迟。

因此策略把三件事分开：

```text
correctness constraints
      ↓
provider/model economics
      ↓
leaf/root decision
```

经济性模型可以计入 uncached input、cache 读/写、辅助 compaction 调用、recall，以及 context pressure。

## 10. 运行模式

所有档位最终都解析为普通配置值；engine 里没有针对模式的分支。

```text
Economy
  retain 0.16
  semantic none

Balanced
  retain 0.24
  semantic none

Quality
  retain 0.24
  semantic rationale
```

这让阶梯是可归因的：Economy → Balanced 改的是 retention；Balanced → Quality 改的是 semantic redundancy。

`legacy` 是 EF 的兼容基线。`basic` 委托给 vendored Basic backend，且不挂载任何 EF 的用户 / 模型面。

## 11. 可观察性

`/context status` 与 Sidebar 消费同一个 status model。

它们报告：

- 当前 pressure / window / threshold；
- 归档历史估算；
- 当前 checkpoint 数量；
- 累计 fold 次数；
- search / recall 活动；
- provider 用量；
- 命中价格 profile 时的路由成本估算。

这条观察路径在模型历史之外。

## 12. 非目标

当前 EF 刻意不实现：

- 向量数据库；
- 学习式压缩策略；
- 通用 embedding memory；
- 多级 checkpoint 世代；
- 语义依赖图；
- 通用工具输出压缩；
- 自动的跨 session memory runtime。

其中若干项曾被探索或做过实验性界定，最终因为测得的价值不足以支撑新增的正确性接缝而推迟。

## 13. 主要实现地图

| 子系统 | 文件 |
| --- | --- |
| compaction engine | `src/engine.ts` |
| fold candidates / frontier | `src/candidate.ts`、`src/frontier.ts` |
| bundle 存储 | `src/bundle-store.ts` |
| checkpoint 编译 / 渲染 | `src/compiler.ts`、`src/renderer.ts` |
| 确定性状态 | `src/state.ts`、`src/authority.ts` |
| search / recall | `src/recall.ts`、`src/tools.ts` |
| provider 经济性 | `src/economics-profile.ts`、`src/policy-compiler.ts` |
| 模式 preset | `src/preset.ts` |
| status / commands | `src/status.ts`、`src/command.ts` |
| client projection / Sidebar | `src/status-projection.ts`、`client.js` |
| DSH 集成 | `src/plugin.ts`、`cordis.patch.yml` |
| Basic 兼容 backend | `src/basic/` |
