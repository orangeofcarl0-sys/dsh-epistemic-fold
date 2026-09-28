# Epistemic Fold — M0/M2/M3a 最终实现报告

> 状态：主线完成（生产甜点位） · 50 tests green · tsc 零错误
> DSH 基线：`477b4f420553e8a52c2fbccc464d7561b239c443`（release/dsh-0.1.7-rc.2，vendor 精确检出）
> 本仓库：github.com/orangeofcarl0-sys/dsh-epistemic-fold
> 测试运行：`npx vitest run` · 类型检查：`npx tsc --noEmit -p tsconfig.json`

---

## 1. 交付总览

| 阶段 | 内容 | 状态 |
|---|---|---|
| Preflight | DSH 源码 vendor 克隆、基线逐 commit 核对、依赖环境（pnpm + tsc -b 构建声明文件） | ✅ |
| **M0** | Exact archive / recall 闭环：CandidateRegistry、CheckpointBundleV1、原子 bundle store、EF compile hook、`context_search`/`context_recall` | ✅ Gate C0.1–C0.5 |
| **M2** | Fold Frontier、leaf/root policy、EF 自己的 `compactIfNeeded`、prefix 指纹、frozen 预算与 root rebase 建议 | ✅ Gate C2.1–C2.4 |
| **M3a** | Deterministic current state：Anchor/StateReducer/Authority、session-projection 接入、结构化 checkpoint 渲染 | ✅ Gate ALR/SSR/Provenance/Evidence/Bounded |
| Bench 基础 | 配对基线 harness（Basic vs EF 同历史对比）+ 本地架构指标（doc 03 §12） | ✅ PMA(EF) < PMA(Basic) 机器证据 |

按 02 计划 §31 停止条件，**M1/M3b/M4/M5 未实现**（需 benchmark 证据触发），符合工作指令 §15 的完成定义。

## 2. 架构落点（与 RFC 的对应）

```text
Session (immutable log)
   ├── ef/anchor events ──► StateReducer (deterministic, 忽略 compaction/summary)
   │                              └──► ctx.sessionProjections['epistemicFold.current']
   ├── tool/result isError ────► 自动 OPEN failure anchor (empirical)
   └── compaction transaction (Basic 复用)
          └── EF summarize() hook:
                archive shadowed messages → semantic call (fail → deterministic fallback)
                → FINAL immutable Bundle 原子发布 (BundleDurable ≺ SurfaceLoss)
                → 结构化 checkpoint [Current/Evidence/Open/Rationale/Recall]
                → Basic commit replacement
```

- **Fold Frontier**：每次从当前 `surface.nodes` 按 POSITION 重定位（identity，非裸 index）；leaf span 永远从 frontier+1 开始——frozen checkpoint 不被重折叠（C2.2/C2.3）。
- **manual `/compact` = Root Fold**（D-004），`compactNow` 路径 candidate 缺席 → 隐式 root。
- **frozenCheckpointTokenBudget** 超标 → `rootRebaseRecommended` 告警（M2 不自动 rebase）。

## 3. 机器 Gate 证据索引

| Gate | 测试 |
|---|---|
| C0.1 committed ⇒ bundle | T01 |
| C0.2 logical hash valid | T05, T08（篡改→corrupt，recall 拒绝） |
| C0.3 exact recall == archive | T10, T24 |
| C0.4 bundle fail ⇒ no replacement | T06, T21 |
| C0.5 semantic fail ⇒ fallback | T17, T18 |
| C2.1 frontier monotonic | P03, P02 |
| C2.2 frozen prefix byte-stable | P01, P02, automatic-path 测试 |
| C2.3 leaf immutable | P02, P04（non-monotonic seq 按 position 处理） |
| C2.4 bounded via root path | P06（预算超标→rebase 建议→frozen 塌缩，旧 bundle 仍可 recall） |
| ALR = 0 | S01 + gate |
| SSR = 0 | S03, S06 |
| Provenance = 100% | Anchor.sourceRefs 类型必填 |
| EvidenceOverridesNarrative | S02（summary 投毒无效）, S05, reducer 忽略 compaction/summary, 无 evidence 的 verified no-op |
| ProjectionBounded | S07（1000 epochs heads=1, <4KB）, S08（history 10x 状态大小平坦） |
| **PMA(EF) < PMA(Basic)** | bench-baseline（同历史 8 步：EF 1744 < Basic 2059 invalidated tokens；每次 fold EF 少作废一个 frozen checkpoint 的量） |

## 4. 关键数字（R0-C 修正后的配对基线，fixture 见 tests/bench-baseline.spec.ts）

> **指标修正（R0-C）**：早期报告把跨 arm 门指标误标为 "PMA(EF) < PMA(Basic)"。
> 按 PMA = absolutePrefixInvalidation / reclaimed 的定义，两条 arm 的比率分别是
> Basic ≈1.10、EF ≈1.15 —— **EF 的比率更高**。真正成立并已由测试钉死的是
> **绝对 prefix 失效量（AbsolutePrefixInvalidation）EF < Basic**。两者是不同的
> 论断，不得混用。

12 步同历史配对（threshold 1200，每步 ~130 tokens）：

```text
arm=B1-basic | absInvalidation=2259 | stableReuse=6937 | PMA=1.10 | reclaimed=2049 | leaf=2
arm=E2-ef   | absInvalidation=2154 | stableReuse=7298 | PMA=1.15 | reclaimed=1880 | leaf=2
```

- 绝对 prefix 失效：EF 低 ~4.6%；prefix 复用（stable prefix tokens）EF 高 ~5.2%。
- 机制可见：Basic 每次 fold 步都在 position 0 全量重写；EF 的 fold 步变异点在
  frozen frontier 之后（mut>0）。

**Root rebase 的真实权衡（20 步带 rebase 的 arm）**：root rebase 一次全量重写
（inv≈404）买来 frozen load 塌缩（274→137），但短窗口内 EF 的绝对失效
（3598）高于 Basic（3404）——RootResetCost vs StableLeafBenefit 的量化呈现。
同时发现并修复了 **leaf/root 震荡**：root 后的陈旧 advice 会让之后每步都
触发 rebase（root=8 的病态），现已加入 cooldown（压力 fold ≥5 次后才能再次
建议 rebase）+ compactNow 后使陈旧 advice 失效。

**ρ break-even 曲线**（C_ρ = miss + ρ·hit）：

```text
ρ=0    basic=3819  ef=3714   delta=105    （无 cache 折扣：EF 绝对成本低）
ρ=0.29 （break-even：Δhit·ρ = Δmiss）
ρ=1    basic=10756 ef=11012  delta=-256   （cache 免费：EF 的 checkpoint recurring 成本主导）
```

结论：EF 的 cache 局部性收益只有在 provider 缓存折扣足够大（本 fixture
ρ ≲ 0.29）时才能兑现为成本优势；折扣小时 frozen checkpoint 的重复计费
反而占优。这正是 R0-C 要求把 economics 从单一指标升级为曲线的原因。

## 5. 与 RFC 的偏差（已声明）

1. `SummarizationInput`/`SummaryResult` 用本地结构镜像，不 import 兄弟包 `/src/summarizer.ts` 类型。
2. Constraint 写入走显式 `ef/anchor` 通道（Q-004：不做自然语言 classifier）；自然语言约束保留在 semantic 文本。
3. `EventRef.sessionId` 同 session 可省略（projection apply 无 session 上下文）。
4. EF config 不解析 `modelPolicies` 的 EF 侧策略（透传 Basic 供 summarization）；无 minReclaim 参数。
5. M2 selectLeafSpan 保留 Basic "retain 0 仍留末节点" 边界语义。

## 6. 新发现的 DSH 约束（对后续实现有用）

- leaf `compactRegion` 要求 open turn；manual `compactNow` 要求无 open turn——fixture 不可混用。
- framed checkpoint 恒 ≈220 tokens；小于该值的 span 必然 shrink-fail（自动路径 warn-and-continue）。
- `ProjectionDefinition.apply(state, event)` 无 session 引用。
- zod 必须单一物理副本（tsconfig paths + vitest alias 均映射 vendor 副本）。
- npm 发布包只有编译后 `lib/`；开发用 vendor 源码 + `tsc -b` 生成声明文件。

## 7. 未做（按停止条件刻意推迟）

- M1 ingress reduction、M3b negative knowledge/uncertainty、M4 graph、M5 generations、Hard Handoff、Session GC、embedding/vector DB。
- 触发条件见 05 文档 §F（"Do not build the next layer without observed failure that needs it"）。
- Behavioral paired-continuation benchmark（doc 03 §8 的 task-success/DWR/CR 指标）需要真实模型环境与任务语料，本阶段交付其 harness 基础（bench/paired-baseline.ts 可直接扩展 arms）。

---

## 8. 结构重构记录（屎山检查后执行，行为保持）

| 项 | 变更 | 收益 |
|---|---|---|
| P0-1 | 策略面拆出 `src/policy.ts`（routedTarget/reservedCompletionTokens/resolveEfConfig/resolveEfCompactSpec），engine 回到事务编排单一职责（466→323 行） | 策略可独立单测 |
| P0-2 | `state.ts` face 管理表驱动化：`ANCHOR_FACE` 映射 + `putFace`/`removeFace` 泛型 helper，7 处同构解构收敛；**修复 supersession 时 decisions/constraints face 残留旧 anchor 的有界性缺陷**；`retiredCount` 语义单一化（hot state 移除总数，去重计数） | reducer 审计成本大幅下降 |
| P0-3 | 测试去私有侵入：harness 增加 `bundleStore` 注入，T06/T21/T23 用 `tests/stores.ts` 的 failing/flaky store 替身，P06 走 `efConfig` 正门；**暴露并修复真实 bug：`frozenCheckpointTokenBudget` 未剥离即传 Basic 的严格 key 校验，传参即抛异常** | 测试覆盖生产构造路径 |
| P0-4 | `scripts/generate-maps.cjs` 统一再生两张 paths 表（src→vitest alias，lib/types→tsconfig）并幂等更新 tsconfig；删除已腐烂的 `extract-paths.cjs`（其输出路径指向已删除目录） | 工具链可再现 |
| P1 | 删除死代码：`CheckpointId` 品牌、`FoldSession` 别名、`compactNow` 纯透传 override、手写 `dirname`、重复的 `readVerified`、`proof-of-life.spec.ts`（覆盖已被 M0 套件包含） | 净删 ~250 行 |

有意保留：`frameCheckpoint`/`CHECKPOINT_PREAMBLE` 与 Basic 的逐字重复（RFC 红线：不依赖兄弟包 `/src` 运行时面）；`recall.search` O(n) 读（M0 规模 by design）。

---

## 9. R0-A — Runtime Integration Closure（外部审计后执行）

外部审计（R0 proposal）核实五项论断全部成立后，R0-A 修复了所有跨 M0/M2/M3a 组合正确性问题：

| 项 | 修复内容 | 证据 |
|---|---|---|
| R0-A1 | **checkpoint marker 协议**（`src/checkpoint-marker.ts`）：`[EF checkpoint v1 mode=<m> id=<uuid>]` 单一所有者 encode/parse/normalize；frontier/recall/renderer 全部改走协议。**顺带发现并修复双重 frame bug**（engine 返回已 frame 的 summary，Basic frameSummary 再包一次 → surface 双 `</compacted-summary>`，旧宽松正则掩盖） | r0a marker round-trip + structured-visible-to-frontier 测试 |
| R0-A2 | **frontier 硬不变量**：leaf fold 必须 `start >= firstOpenPosition`（`leaf_before_frontier` 拒绝）+ frozen prefix 连续性校验（`FRONTIER_INCONSISTENT`）；P04 重写为合法 fixture，新增 P04b | P04/P04b |
| R0-A3 | **recall 会话隔离**：`FoldBundleStore.read/verify/remove` 会话作用域化，跨 session 读 = fail-closed 缺失；corruption 分类（parse 失败 ≠ missing，wrong-session 显式）；O(#sessions) 的 locate() 扫描删除（O(1) 直达路径）；`cp:` 引用统一 normalize | r0a isolation 测试 |
| R0-A4 | **FoldCommitRecordV1**：post-commit provenance（compactionId/shadowedSeqs/startSeq/summarySeq/endSeq）与 pre-commit Bundle 身份分离；`compactNow` 显式 root candidate（废除 candidate-absent 隐式约定）；leaf 验证 committed span == candidate span | r0a leaf/root record 测试 |
| R0-A5 | **authority 运行时门**：`ef/anchor` 不再是自授权 root（derived authority must terminate at raw roots）；`createAnchorService()` 在事件 append 前校验 authority grounding 与 VERIFIED evidence kinds | r0a gate 测试（laundering 拒绝 / narrative verify 拒绝 / tool evidence 接受） |
| R0-A6 | **disjoint checkpoint presentation**（每 anchor 恰好出现在一个 section，按 id 去重）；**rationale-only semantic compiler**（`semanticMode: 'none' | 'rationale'`，专用 prompt 禁止断言状态/完成/验证，≤400 tokens，zero-LLM profile 支持 benchmark 对照）；**真实 audit metadata**（provider/model/usage/rawOutput/llmStreamCall 转发进 compaction/summary，不再写 epistemic-fold-semantic/unspecified 假值） | r0a zero-LLM + envelope 测试 |

**重构中额外发现并修复的第三个 bug**：bundle write 失败发生在 semantic try 块内会被误判为 semantic 失败 → 静默降级 fallback 并二次 write 成功（flaky-store probe 揪出，T06 全失败才侥幸通过）。修复后 semantic 获取与 publish 严格分离，publish 永不吞错。

测试：**65 passed（7 套件）**，tsc 零错误。
