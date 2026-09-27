# EF-RFC-001：Epistemic Fold 架构规范

> Status: Draft for implementation  
> Version: 0.2  
> Target: DeepSeek Harness `0.1.7-rc.2`  
> Verified DSH baseline: `477b4f420553e8a52c2fbccc464d7561b239c443`

---

# 1. 摘要

Epistemic Fold (EF) 是一个面向长周期 Agent 的 context runtime。它不把完整会话历史当成工作记忆，而是把 Session/Artifact 作为 immutable truth，从中维护 bounded current state、immutable checkpoints 和 bounded recall。

核心动作是 **Epistemic Folding**：当一段轨迹的知识效应已被更稳定对象（decision、evidence、artifact、constraint、negative knowledge、uncertainty）承载后，把该轨迹从 active context 中折叠出去，同时保持 contract 不丢失。

目标结构：

```text
Immutable Truth
    │
    ├── DSH Session
    └── Artifact / Bundle Store
            │
            ▼
      Working Projection
            │
      ┌─────┴────────────┐
      │                  │
 Current State       Open Tail Facts
      │                  │
      └─────┬────────────┘
            ▼
    Checkpoint Compiler
            │
      ┌─────┴──────┐
      │            │
Machine Interface Semantic Digest
      │            │
      └─────┬──────┘
            ▼
    Frozen Surface
            │
            ▼
           Model
            │
        Search/Recall
            │
            └──────────► Bundle / Artifact
```

---

# 2. 非目标

RFC-001 明确不要求：

- 全局 vector DB；
- semantic dependency graph；
- learned compression planner；
- 多级 generations；
- cross-session state runtime；
- universal tool ingress compressor；
- provider-specific cache API；
- 自动 context-reset 策略；
- Session log GC。

这些均不得成为 M0–M3 的前置依赖。

---

# 3. DSH 宿主假设

## 3.1 Session

依赖以下当前事实：

1. Session 是 append-only typed event log；
2. model-visible history 由 surface 派生；
3. replacement 使用当前 surface position span；
4. replacement 不删除历史 event；
5. seq identity 与 surface position 不等价。

**禁止**在新 EF production code 中依赖 seq 大小判断 surface 顺序。

---

## 3.2 Compaction

依赖：

```ts
CompactionEngine {
  compactIfNeeded(...)
  compactNow(...)
  compactRegion(...)
}
```

`BasicCompactionEngine` 已拥有：

- lock；
- range validation；
- tool-call/result pairing；
- summary call；
- async surface stability check；
- shrink check；
- durable compaction lifecycle；
- replacement commit；
- failure classification。

EF MUST 尽量复用事务语义，不复制 transaction implementation。

---

## 3.3 Session Projection

`ctx.sessionProjections` 用于 host-side current state。

Projection MUST：

- synchronous fold；
- bounded；
- 只维护 current/hot state；
- 不复制完整历史；
- 在 checkpoint 后退休被折叠 span 的 hot facts。

目标复杂度：

\[
Memory(K_t)=O(W_t + A_t + O_t + C_t)
\]

其中：

- \(W_t\)：unfrozen working tail；
- \(A_t\)：active anchors；
- \(O_t\)：open obligations；
- \(C_t\)：current visible checkpoint refs。

MUST NOT 为：

\[
O(|History|)
\]

---

# 4. 三层真相模型

## 4.1 Canonical Truth

\[
T = SessionLog \cup ArtifactStore
\]

Session 保存模型可重建事件事实。

ArtifactStore 保存：

- 进入 Session 前被有损压缩的大工具输出；
- 未来可能的外部 artifact。

## 4.2 Retrieval Materialization

`CheckpointBundle` 是 retrieval materialization，不是第二 canonical history。

Bundle 的存在是为了：

- production-safe exact recall；
- 避免依赖 deprecated random Session readers；
- 保存 checkpoint machine metadata；
- 对已退出 active surface 的 selected messages 提供直接恢复。

## 4.3 Working Projection

只含：

- frontier；
- hot-tail facts；
- active state heads；
- open failures/obligations；
- current checkpoint refs；
- telemetry。

---

# 5. 核心对象

## 5.1 EventRef

```ts
interface EventRef {
  sessionId: string
  seq: number
}
```

`seq` 是 event identity，不是 surface position。

---

## 5.2 ArtifactRef

```ts
interface ArtifactRef {
  id: string
  uri: string
  sha256: string
  bytes: number
  mime?: string
}
```

---

## 5.3 Anchor

M3a：

```ts
type AnchorKind =
  | "objective"
  | "constraint"
  | "decision"
  | "value"
  | "artifact"
  | "evidence"
  | "failure"
  | "obligation"
```

M3b 增加：

```ts
  | "negative-knowledge"
  | "uncertainty"
```

概念结构：

```ts
interface Anchor {
  id: string
  kind: AnchorKind
  stateKey?: string
  value: unknown
  authority: AuthorityDomain
  lifecycle: string
  sourceRefs: EventRef[]
  artifactRefs?: ArtifactRef[]
}
```

---

## 5.4 AuthorityDomain

```ts
type AuthorityDomain =
  | "normative"
  | "empirical"
  | "procedural"
  | "decision"
  | "narrative"
  | "hypothesis"
```

关键原则：

- user/system explicit constraint → normative；
- tool/test/filesystem evidence → empirical；
- execution lifecycle → procedural；
- adopted solution → decision；
- semantic digest → narrative；
- tentative model reasoning → hypothesis。

不存在一个跨 domain 的简单全局 score。

---

## 5.5 CheckpointInterface

M3 后正式使用：

```ts
interface CheckpointInterface {
  requires: string[]
  provides: string[]
  obligates: string[]
  evidences: string[]
  rejects: string[]
  uncertainties: string[]
}
```

数学记号：

\[
I(C)=(R,P,O,E,N,U)
\]

---

## 5.6 CheckpointBundleV1

```ts
interface CheckpointBundleV1 {
  format: "ef-checkpoint"
  formatVersion: 1

  checkpointId: string
  sessionId: string
  createdAt: number

  mode: "leaf" | "root" | "emergency"

  source: {
    orderedSurfaceSeqs?: number[]
    sourceDigest: string
  }

  archive: {
    shadowedMessages: unknown[]
    logicalHash: string
    fileHash?: string
  }

  machine?: CheckpointInterface
  semantic?: SemanticDigest

  rendered: {
    text: string
    digest: string
  }
}
```

规则：

- Bundle immutable；
- writer 永远只写当前 format；
- reader 应保留版本分派；
- archive `logicalHash` 对 canonicalized message JSON 计算；
- 文件压缩 bytes 可另有 `fileHash`。

---

# 6. CheckpointBundle 事务

核心不变量：

\[
\boxed{
BundleDurable \prec SurfaceLoss
}
\]

流程：

```text
prepare candidate
      ↓
Basic prepares summarization input
      ↓
EF compile hook
      ↓
extract actual shadowed messages
      ↓
construct immutable Bundle
      ↓
atomic write tmp
      ↓
flush / rename
      ↓
verify hash
      ↓
semantic summarize / fallback
      ↓
return replacement
      ↓
Basic shrink check
      ↓
Basic surface revalidation
      ↓
Basic compaction commit
```

### Archive failure

必须：

```text
archive write failure
→ summarize throws / compaction aborts
→ surface unchanged
```

### Bundle success + compaction failure

允许留下 orphan bundle。

GC 后续删除。

安全优先级：

\[
TemporaryDiskLeak \ll UnrecoverableContextLoss
\]

---

# 7. Exact Recall 定义

M0 的 exact recall 定义为：

> 被 EF checkpoint shadow 前，模型实际可见的 selected conversation messages 的精确恢复。

不是：

- 所有 log-only events；
- provider 原始字节流；
- Session 内部所有事务事件。

规范：

\[
RecallExact(C)=Bundle(C).archive.shadowedMessages
\]

默认 recall MUST NOT 一次性 dump 整包。

---

# 8. Recall API

## 8.1 `context_search`

```ts
interface ContextSearchArgs {
  query: string
  scope?: "session" | "project"
  limit?: number
}
```

M0 查询：

- checkpoint ID；
- rendered checkpoint text；
- tool names；
- file paths；
- artifact names。

M3 后增加：

- anchor index；
- current state keys；
- negative knowledge；
- uncertainty。

Embedding 不属于 M0–M3 必需项。

---

## 8.2 `context_recall`

```ts
interface ContextRecallArgs {
  ref: string
  depth?: "summary" | "detail" | "exact"
  offset?: number
  limit?: number
}
```

约束：

- 默认 `summary`；
- exact 必须分页；
- 返回必须 bounded；
- 大 artifact 返回 locator + page，不允许无界注入。

---

# 9. Epistemic Folding 三模式

## 9.1 Leaf Fold

用于 automatic pressure maintenance。

目标：

\[
\max PrefixLocality
\]

规则：

- 从 Fold Frontier 开始；
- 选择连续安全 span；
- 产生 immutable leaf checkpoint；
- 已冻结前缀不改。

---

## 9.2 Root Fold

用于 manual `/compact` 和极低频 rebase。

目标：

\[
\max ContextCleanup
\]

允许较大 prefix rewrite。

M2 时 Root Fold 属于 semantic-only weak safety。

M3a 后 Machine Interface 合并后才升级为 contract-preserving rebase。

---

## 9.3 Emergency Fold

用于 provider-confirmed context overflow。

目标：

\[
\text{Guaranteed bounded recovery}
\]

要求：

- deterministic；
- semantic model optional；
- hard state / recent user / open failures 优先；
- 必须可静态控制最终 token budget。

---

# 10. Fold Frontier

Surface：

```text
SYSTEM
R0
C41
C42
C43
------------ Fold Frontier
raw...
```

Frontier SHOULD NOT 持久化为裸 position index。

推荐持久化 identity：

```ts
interface FrontierRef {
  latestFrozenCheckpointId?: string
  latestFrozenSurfaceSeq?: number
}
```

每次 plan 时，根据当前 `session.surface.nodes` 重新定位 frontier position。

---

# 11. SafeFoldValidator

Validator 和 Planner 必须分离。

\[
\boxed{
Policy\ chooses;\ Validator\ vetoes
}
\]

定义：

\[
Safe(S,C)=B\land T\land A\land D\land O\land P\land R\land G
\]

- B：tool pairing / structural balance；
- T：transaction boundary；
- A：active authority coverage；
- D：hard dependency boundary coverage（M4 才完整启用）；
- O：open obligation coverage；
- P：provenance / Bundle completeness；
- R：replacement shorter than source；
- G：selected span stability。

M0 实现 B/P/R/G。

M3a 增加 A/O。

M4 增加 D。

---

# 12. Closure Level

```ts
type ClosureLevel = 0 | 1 | 2 | 3
```

- C0 Structural：只保证结构合法；
- C1 Interface-safe：authority / boundary 已 export；
- C2 Semantic-closed：自然工作阶段闭合；
- C3 Verified-closed：有 evidence 的闭合阶段。

优先级：

\[
C3 > C2 > C1 > C0
\]

Emergency Fold 可以退到 C0。

---

# 13. StateReducer（M3a）

目标不是保存所有历史，而是维护 current heads。

例如：

```ts
interface FoldCurrentState {
  objective?: Anchor
  constraints: Record<string, Anchor>
  stateHeads: Record<string, Anchor>
  openFailures: Record<string, Anchor>
  openObligations: Record<string, Anchor>
  decisions: Record<string, Anchor>
  evidence: Record<string, Anchor>
}
```

必须有空间上界，旧 lineage 不保存在 hot state。

---

# 14. Supersession

例如：

```text
timeout = 30
timeout = 60
```

Active state：

```text
timeout = 60
```

旧值只从 Bundle/Session recall。

原则：

\[
HistoricalTruth \neq CurrentState
\]

模型 active surface MUST NOT 模糊并列已经 superseded 的值。

---

# 15. Failure Lifecycle

```ts
type FailureState =
  | "open"
  | "investigating"
  | "resolved"
  | "verified"
```

只有 evidence-backed transition 才能进入 `verified`。

Semantic summary 不能单独改变 failure state。

---

# 16. Negative Knowledge（M3b）

```ts
interface NegativeKnowledgeAnchor {
  id: string
  subject: string
  rejectedClaim: string
  because: string[]
  validWhile?: string[]
  lifecycle: "active" | "stale" | "superseded"
  sourceRefs: EventRef[]
}
```

必须允许失效，不能永久积累"不要做 A/B/C"。

---

# 17. Uncertainty（M3b）

```ts
type EpistemicStatus =
  | "hypothesis"
  | "supported"
  | "established"
  | "rejected"
```

禁止 LLM narrative 自行：

```text
hypothesis → established
```

需要 evidence-backed transition。

---

# 18. Semantic Digest

Semantic 只能承担：

- context；
- rationale；
- alternatives；
- conceptual conclusion。

不能承担：

- verified state；
- constraint lifecycle；
- failure resolution；
- exact current values；
- test pass/fail authority。

如果 semantic call 失败：

\[
SemanticFailure \Rightarrow DeterministicFallback
\]

不允许为了 semantic retry 修改已准备的 candidate input。

---

# 19. DSH inheritance strategy

建议：

```ts
class EpistemicFoldEngine extends BasicCompactionEngine
```

复用 Basic 的 transaction。

EF 自己拥有：

- pressure policy；
- leaf fold range selection；
- candidate；
- bundle/archive；
- compiler；
- state projection；
- recall。

不依赖 `@deepseek-ai/dsh-compaction-basic/src/*` 内部 helper 作为生产 API。

---

# 20. Manual `/compact` 语义

当前 Basic manual path 不走 subclass `compactRegion()` selector。

RFC 将此行为主动定义为：

\[
\boxed{
/compact = Root Fold
}
\]

因此 M0–M3 不需要修改 DSH core。

---

# 21. Ingress Reduction 限制

当前 tool pipeline：

```text
execute
→ projectContent
→ tools/post-execute
→ finalizeContent
→ materialize tool/result
```

因此纯插件层没有"所有 finalize 之后、durable materialization 之前"的通用 final content seam。

M1 第一版只能做：

**Verified Ingress Reduction**

- allowlist；
- denylist/protected；
- final result audit；
- unknown tool 默认不压。

若 benchmark 证明价值足够高，再考虑最小 upstream seam：

```text
post-finalize / pre-materialize
```

---

# 22. Soft vs Hard Reset

### Soft Rebase

同 Session 中重建 surface。

解决：

- context pressure；
- stale context；
- prefix layout。

不解决 Session append-only log process memory。

### Hard Handoff Reset（future）

```text
Session A
→ structured handoff
→ Session B
→ dispose A
```

解决超长 live Session 生命周期问题。

RFC-001 M0–M3 明确不负责 Session log GC。

---

# 23. 安全优化模型

不采用一个把 correctness 和 cost 混成加权和的 optimizer。

首先：

\[
\mathcal O_{safe}=
\{o\mid Validator(o)=PASS\}
\]

然后：

\[
o^*=
\arg\min_{o\in\mathcal O_{safe}} ExpectedCost(o)
\]

即：

\[
\boxed{
Safety\ constraints\ first;
optimization\ inside\ feasible\ set.
}
\]

---

# 24. 生产降级原则

EF 必须 fail soft。

- Bundle store missing → checkpoint 仍可显示，但 exact recall 标记 unavailable；
- state extension failure → 可退回 semantic checkpoint；
- EF plugin disabled → Session 仍应能由其他 compaction backend 继续；
- EF 不得改变 Session 可恢复性为"依赖 EF 文件才能打开"。

EF 是增强层，不是 Session format 的不可移除依赖。

---

# 25. 安全与数据生命周期

Bundle/Artifact 可能包含企业敏感数据。

M0 即要求：

- per-session storage；
- restricted permissions；
- atomic writes；
- hash integrity；
- session delete cleanup hook；
- 不使用 world-readable temp；
- 不把 Bundle 上传到外部服务。

加密可后置，但访问权限和清理策略不可后置。

---

# 26. RFC-001 退出条件

只有以下条件同时满足，RFC-001 才允许进入 M4/M5 设计：

1. M0 exact archive/recall 闭环全部通过；
2. M2 stable prefix machine proof 通过；
3. M3a Authority Loss = 0；
4. M3a State Staleness = 0；
5. behavioral benchmark 不劣于 Basic；
6. Projection 内存规模不随 total historical events 线性增长；
7. Root Fold rebase 不成为高频日常路径。

否则继续修 M0–M3，不扩大功能范围。
