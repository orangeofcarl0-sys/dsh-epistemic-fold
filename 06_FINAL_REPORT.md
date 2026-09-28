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

## 4. 关键数字（配对基线，fixture 见 tests/bench-baseline.spec.ts）

```text
arm=B1-basic | invalidatedSuffixTotal=2059 | reclaimed=1639 | folds=4
arm=E2-ef   | invalidatedSuffixTotal=1744 | reclaimed= 864 | folds=4
```

结论：同历史、同压力阈值下，EF 的累计 prefix 失效量低 15%，且随 fold 次数线性扩大优势（每次 fold EF 免作废全部 frozen prefix，Basic 每次全量重写）。EF reclaimed 较低是因为 frozen checkpoint 计入压力总量（这正是 M2 计划 §15 root rebase 预算存在的理由）。

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
