# 本地 Agent 工作指令：实现 Epistemic Fold M0 → M2 → M3a

你正在 DeepSeek Harness 上实现 **Epistemic Fold (EF) — Epistemic Fold Runtime**。

本任务不是探索性 brainstorming。你需要读取同目录的：

1. `00_README_EF.md`
2. `01_EF_RFC_001_ARCHITECTURE.md`
3. `02_EF_IMPLEMENTATION_PLAN_M0_M3.md`
4. `03_EF_TEST_BENCHMARK_SPEC.md`
5. `05_EF_DECISIONS_AND_OPEN_QUESTIONS.md`

然后按本文执行。

---

# 1. 目标

第一主线只实现：

\[
\boxed{
M0 \rightarrow M2 \rightarrow M3a
}
\]

暂时不要实现：

- M1 universal ingress compression；
- M3b semantic classifier；
- M4 graph；
- M5 generations/adaptive planner；
- embedding；
- vector DB；
- Session GC；
- cross-session hard reset。

---

# 2. 基线

目标基线：

```text
deepseek-ai/deepseek-harness
version: 0.1.7-rc.2
expected baseline:
477b4f420553e8a52c2fbccc464d7561b239c443
```

开始时：

```bash
git rev-parse HEAD
git status --short
git branch --show-current
git rev-parse origin/master
```

并核对 package version。

如果代码基线明显后移：

- 阅读相关 compaction/session/tool/session-projection 变化；
- 更新 compatibility assessment；
- 不盲目 patch 到旧 API；
- 如果 seam 已变化，先报告再适配。

---

# 3. 工作节奏

按大阶段推进。

不要把工作拆成几十个需要人工确认的小 slice。

推荐：

```text
Preflight
↓
M0 implementation
↓
M0 full gate
↓
M2 implementation
↓
M2 full gate
↓
M3a implementation
↓
M3a full gate
↓
final report
```

普通单测失败由你自行定位修复。

只有以下情况停止并报告：

- baseline/API 与 RFC 根本不兼容；
- 发现必须修改 DSH Core 才能满足硬正确性不变量；
- Gate 中存在无法通过的架构冲突；
- 需要违反 RFC 的 immutable truth / provenance / safety 规则。

---

# 4. 不允许做的事

禁止：

1. 直接复制 `compaction-basic/src/region.ts` 全部 transaction；
2. 依赖 deprecated `session.eventAt()/snapshotEvents()/ownEvents()` 建立新 production 逻辑；
3. 深度依赖 `@deepseek-ai/dsh-compaction-basic/src/*` 作为稳定 API；
4. 让 semantic summary 成为 state authority；
5. 在 Bundle 持久化失败后继续有损 compaction；
6. 为了压缩率牺牲 active user constraint；
7. 引入 embedding/vector DB 作为 workaround；
8. 一开始实现完整 dependency graph；
9. 默默改变 DSH Session persistence semantics；
10. 把 EF 文件变成 Session 打不开时的硬依赖。

---

# 5. 优先复用

应优先复用当前 DSH：

```text
BasicCompactionEngine transaction behavior
ctx.tokenMeter
ctx.sessionProjections
existing atomic-write utilities
existing package/schema conventions
existing tool registration conventions
existing tests/testkits
```

原则：

```text
Reuse transaction semantics;
own EF policy/representation.
```

---

# 6. M0

## 6.1 交付

完成：

- `EpistemicFoldEngine`；
- FoldCandidateRegistry；
- `CheckpointBundleV1`；
- atomic bundle store；
- semantic fallback；
- `context_search`；
- `context_recall`；
- M0 test suite。

## 6.2 M0 invariant

```text
Committed checkpoint ⇒ exact Bundle exists
Bundle failure ⇒ no successful lossy replacement
Semantic failure ⇒ bounded deterministic checkpoint
Exact recall ⇒ archived model history
```

## 6.3 M0 结束报告

必须给：

```text
HEAD
changed files
tests
bundle format
exact recall proof
crash/failure tests
known deviations
```

只有 M0 Gate 全绿才进入 M2。

---

# 7. M2

## 7.1 目标

加入：

```text
FoldFrontier
automatic Leaf Fold checkpoint
manual /compact Root Fold rebase
prefix fingerprint tests
bounded frozen context path
```

Automatic pressure path 必须由 EF selector 决定 span。

Manual `/compact` 可以继续复用 Basic manual range path，但其 compile mode 定义为 Root Fold。

## 7.2 强 invariant

无 Root Fold/Emergency Fold：

```text
old frozen prefix bytes must not change
```

通过 hash machine-proof。

## 7.3 M2 结束报告

必须给：

```text
leaf fold selection behavior
frontier proof
prefix fingerprint results
root fold rebase behavior
comparison with Basic
```

---

# 8. M3a

## 8.1 目标

实现 deterministic：

```text
objective
constraint
decision
value
artifact
evidence
failure
obligation
supersession
```

暂不实现：

```text
negative knowledge
uncertainty classifier
semantic graph
```

## 8.2 关键架构

```text
Raw events
   ├──► deterministic StateReducer
   └──► semantic summarizer

State MUST NOT derive from summary.
```

## 8.3 必须证明

```text
ALR = 0
SSR = 0
ProvenanceCoverage = 100%
EvidenceOverridesNarrative
Projection bounded with history growth
```

---

# 9. 实现优先级

如果需要取舍：

1. correctness；
2. replay/recovery；
3. exact provenance；
4. prefix stability；
5. state correctness；
6. latency；
7. token reduction；
8. developer ergonomics。

不要反过来。

---

# 10. 代码风格

遵循 DSH 现有约定：

- typed branded identifiers；
- immutable snapshots；
- JSON-lossless durable values；
- Cordis service/plugin conventions；
- existing schema libraries；
- exhaustive union switches；
- doc comments only where contract is load-bearing；
- 测试优先复用 repo testkit。

避免：

- 全局单例；
- 隐式 async background mutation；
- 未 version 的 durable format；
- catch-all `any`；
- 无 source provenance 的 derived state。

---

# 11. Bundle durability

要求：

```text
same-session directory
restricted permissions
same-dir temp
atomic rename
logical hash verification
```

Bundle 格式从第一天 versioned。

Session 删除时要有 cleanup strategy，但 cleanup failure 不得阻塞 Session 本身。

---

# 12. Semantic failure

不能让 semantic model failure 导致：

```text
selected input recovery rewrite
```

而破坏 candidate identity。

EF compile hook 应：

```text
try semantic
catch → deterministic fallback
```

然后作为成功 SummaryResult 交回 Basic transaction。

---

# 13. Projection boundedness

禁止：

```text
Map<seq, all historical node facts>
```

长期存在。

Projection 只能保留：

```text
hot tail
current heads
open obligations/failures
visible checkpoint refs
small telemetry
```

Checkpoint commit 后，span 内 hot facts 必须退休。

---

# 14. 报告模板

每个大阶段：

```markdown
# Mx REPORT

## Baseline
HEAD:
branch:
origin:
working tree:

## Implemented
...

## Machine gates
| Gate | Result | Evidence |
|---|---|---|

## Metrics
...

## Deviations from RFC
...

## Newly discovered DSH constraints
...

## Decision
PROCEED / STOP
```

不要只说"tests pass"。

需要说明为什么架构 invariant 被证明。

---

# 15. 完成条件

本轮任务完成不是"写完代码"。

而是：

```text
M0 PASS
M2 PASS
M3a PASS
```

并产生：

- clean architecture；
- tests；
- benchmark harness 基础；
- final implementation report；
- 待办只包含 M1/M3b/M4/M5 等后续非阻塞项。

若 M3a 已经形成明显生产甜点位，不要擅自继续实现 M4。
