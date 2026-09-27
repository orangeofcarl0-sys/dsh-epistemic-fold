# Epistemic Fold M0–M3 实施计划

> 用途：直接供本地 coding agent 执行。  
> 风格：按"大阶段 + 关键检查门"推进，不切成过多微型 slice。  
> 原则：每个阶段完成后运行机器验证；只有 Gate 失败才停下定位，不因普通中间状态反复等待确认。

---

# 1. 基线与启动门

目标 DSH：

- repo: `deepseek-ai/deepseek-harness`
- version: `0.1.7-rc.2`
- verified baseline: `477b4f420553e8a52c2fbccc464d7561b239c443`

开始实现前必须报告：

```text
actual HEAD
branch
origin/master
git status --short
package version
```

如果基线与计划不一致：

- 不改生产代码；
- 输出差异；
- 判断是否只是后续兼容更新；
- 若 API seam 已变化，先更新本 RFC。

---

# 2. 总体阶段顺序

推荐真实工程顺序：

```text
M0  Exact archive / recall closure
↓
M2  Fold Frontier / stable leaf checkpoint
↓
M3a Deterministic current state
↓
M1  Verified ingress reduction
↓
M3b Negative knowledge / uncertainty
```

理由：

- M0–M3a 是 correctness architecture；
- M1 是成本优化；
- M3b 引入额外模型语义风险。

---

# 3. M0 — Compaction–Archive–Recall 闭环

## 3.1 M0 目标

建立以下闭环：

```text
selected surface span
       ↓
exact immutable Bundle
       ↓
DSH compaction transaction
       ↓
checkpoint surface
       ↓
context_search
       ↓
context_recall
       ↓
exact archived model history
```

M0 不引入：

- FoldFrontier；
- Anchor；
- StateReducer；
- graph；
- ingress reduction；
- generation。

---

## 3.2 M0 文件结构

```text
packages/epistemic-fold/
├── package.json
├── src/
│   ├── index.ts
│   ├── engine.ts
│   ├── candidate.ts
│   ├── bundle-store.ts
│   ├── compiler.ts
│   ├── recall.ts
│   └── types.ts
└── tests/
```

如果 repo package 命名规范要求其他路径，跟随 repo 现有 convention，但保持模块职责不变。

---

## 3.3 `types.ts`

第一版类型至少包括：

```ts
export type FoldMode =
  | "leaf"
  | "root"
  | "emergency"

export interface FoldCandidate {
  readonly checkpointId: string
  readonly mode: FoldMode
  readonly sessionId: string

  readonly start?: SessionSeq
  readonly end?: SessionSeq

  readonly preparedSurfaceGeneration: number
  readonly sourceDigestSeed: string
}

export interface CheckpointBundleV1 {
  readonly format: "ef-checkpoint"
  readonly formatVersion: 1

  readonly checkpointId: string
  readonly sessionId: string
  readonly createdAt: number
  readonly mode: FoldMode

  readonly archive: {
    readonly shadowedMessages: readonly Message[]
    readonly logicalHash: string
  }

  readonly semantic?: {
    readonly text: string
  }

  readonly rendered: {
    readonly text: string
    readonly digest: string
  }
}
```

注意：

- `Bundle` immutable；
- 不在 Bundle 里保存 mutable commit status；
- commit status 可由 Session + Bundle directory 重建。

---

# 4. `bundle-store.ts`

实现接口：

```ts
interface FoldBundleStore {
  write(bundle: CheckpointBundleV1): Promise<BundleWriteResult>
  read(checkpointId: string): Promise<CheckpointBundleV1 | null>
  verify(checkpointId: string): Promise<BundleVerification>
  list(sessionId: string): Promise<BundleDescriptor[]>
  remove(checkpointId: string): Promise<void>
}
```

## 4.1 原子写

必须采用：

```text
serialize
→ tmp file in same directory
→ flush if existing repo utility supports it
→ atomic rename
→ read/verify logical hash
```

优先复用 DSH 已有 atomic-write utility，不自造不必要 filesystem helper。

## 4.2 logical hash

对 canonical JSON representation 计算：

\[
logicalHash = SHA256(canonicalJSON(shadowedMessages))
\]

不要用 zstd/gzip 文件 bytes 作为逻辑 identity。

---

# 5. `candidate.ts`

M0 Candidate 只负责 identity/mode。

建议：

```ts
class FoldCandidateRegistry {
  private readonly pending = new WeakMap<Session, FoldCandidate>()

  prepare(session: Session, candidate: FoldCandidate): void
  get(session: Session): FoldCandidate | undefined
  clear(session: Session): void
}
```

规则：

- 每 Session 单槽；
- pending 已存在则 fail closed；
- candidate immutable；
- `finally` 必须 clear；
- cancellation/throw 时不得泄漏 pending。

---

# 6. `engine.ts`

## 6.1 基类

优先：

```ts
class EpistemicFoldEngine extends BasicCompactionEngine
```

M0 不复制 Basic transaction。

## 6.2 `compactRegion`

```ts
override async compactRegion(start, end, agent, signal) {
  const candidate = createFoldCandidate({
    mode: "leaf",
    session: agent.session,
    start,
    end,
  })

  this.candidates.prepare(agent.session, candidate)

  try {
    return await super.compactRegion(start, end, agent, signal)
  } finally {
    this.candidates.clear(agent.session)
  }
}
```

## 6.3 `compactNow`

M0 暂时：

```ts
override compactNow(...) {
  return super.compactNow(...)
}
```

其 semantic compiler 在 `summarize()` 中将 candidate absence 识别为 root/manual mode。

不要尝试用 `super.compactRegion()` 自造 manual transaction；它按 current-turn owner 运行，不等价于 idle `runMaintenance` path。

---

# 7. `compiler.ts`

## 7.1 `summarize()` 核心路径

伪代码：

```ts
protected override async summarize(input, agent, signal) {
  const candidate =
    this.candidates.get(agent.session)
    ?? createImplicitRootFoldCandidate(agent.session)

  const { contextPrefix, shadowedMessages } =
    splitSummarizationInput(input)

  const archive = createArchive(shadowedMessages)

  const fallback = renderFallback(candidate.checkpointId)

  // Bundle durability first
  const provisionalBundle =
    buildBundle(candidate, archive, fallback)

  await bundleStore.write(provisionalBundle)

  let semantic
  try {
    semantic = await semanticSummarize(input, agent, signal)
  } catch (error) {
    return asSummaryResult(fallback, /* deterministic metadata */)
  }

  const rendered =
    renderSemanticCheckpoint(candidate.checkpointId, semantic)

  // Write final immutable bundle version once.
  // Do NOT mutate an already published bundle.
  // Preferred implementation: perform semantic call BEFORE final atomic rename
  // while raw archive is safely staged; see transaction section below.

  return asSummaryResult(rendered, semantic.metadata)
}
```

### 重要实现修正

不可真的先写"最终 immutable Bundle"然后再改 semantic。

推荐事务：

```text
archive stage temp
↓
verify archive
↓
semantic call
  ├── success → semantic rendering
  └── fail → fallback rendering
↓
construct FINAL immutable Bundle
↓
atomic publish Bundle
↓
return summary
```

关键是：

> 在任何有损 surface mutation 前，FINAL Bundle 必须已 durable。

由于 Basic 直到 `summarize()` 返回后才 commit replacement，这一顺序满足要求。

---

## 7.2 semantic failure

semantic failure 不应进入 Basic `summary-error` recovery。

EF 自己捕获：

```text
semantic error
→ deterministic fallback
→ successful SummaryResult
```

原因：Basic recovery 可能修改 selected input，从而让已准备的 EF candidate 失配。

---

# 8. `splitSummarizationInput`

当前 Basic input 可能为：

```text
system head
+
shadowed region
```

实现：

```ts
function splitSummarizationInput(input) {
  const first = input.messages[0]
  if (first?.role === "system") {
    return {
      contextPrefix: [first],
      shadowedMessages: input.messages.slice(1),
    }
  }

  return {
    contextPrefix: [],
    shadowedMessages: input.messages,
  }
}
```

`logicalHash` 只覆盖 `shadowedMessages`。

---

# 9. `recall.ts`

暴露两个工具：

```text
context_search
context_recall
```

## 9.1 M0 `context_search`

最小搜索：

- exact checkpoint ID；
- rendered checkpoint text；
- simple lexical index。

不要上 embedding。

## 9.2 M0 `context_recall`

支持：

```text
summary
detail
exact
```

Exact 必须分页：

```ts
interface ExactRecallPage {
  checkpointId: string
  totalMessages: number
  offset: number
  nextOffset?: number
  messages: Message[]
}
```

禁止返回超预算页面。

---

# 10. M0 Gate

必须全部满足：

```text
C0.1 committed checkpoint => bundle exists
C0.2 bundle logical hash valid
C0.3 exact recall == archived shadowed model messages
C0.4 bundle/archive failure => no surface replacement
C0.5 semantic failure => deterministic fallback checkpoint
```

并通过 `03_EF_TEST_BENCHMARK_SPEC.md` 的 M0 suite。

---

# 11. M2 — Fold Frontier

M0 成功后进入 M2。

## 11.1 新文件

```text
frontier.ts
leaf-policy.ts
root-policy.ts
```

## 11.2 Automatic path

EF override：

```ts
compactIfNeeded(agent, trigger, signal)
```

不要继续调用 `super.compactIfNeeded()` 选 range。

压力测量仍复用：

```text
ctx.tokenMeter
routed model context capacity
reserved completion tokens
```

但 EF 自己选择：

```text
[FoldFrontier, BestSafeEnd]
```

---

# 12. Fold Frontier

Frontier 是逻辑 identity，不是裸 position。

```ts
interface FrontierRef {
  latestFrozenCheckpointId?: string
  latestFrozenSurfaceSeq?: SessionSeq
}
```

每次 plan：

1. 读取 current `session.surface.nodes`；
2. 找到 latest current frozen checkpoint；
3. 推导 frontier position；
4. 从 frontier 之后扫描 balanced candidate end；
5. 选满足 min reclaim 的闭合 span。

---

# 13. M2 Leaf Fold 规则

Leaf fold checkpoint MUST：

- append after existing frozen checkpoints；
- never rewrite older leaf；
- normal automatic compaction 只推进 frontier；
- prefix fingerprint 可机器验证。

M2 核心：

\[
FrozenPrefix_t=FrozenPrefix_{t+1}
\]

除非发生：

- Root Fold rebase；
- Emergency Fold；
- future Hard Handoff。

---

# 14. M2 Root Fold Rebase

直接将 manual `/compact` 定义为 Root Fold。

不修改 Basic manual transaction。

Root bundle：

```text
mode = "root"
```

renderer：

```text
[EF Root Rn]
```

M2 Root Fold 为 semantic-only weak safety：

- 稀有；
- manual preferred；
- 不得高频自动运行。

M3a 后才升级为 machine-state-preserving rebase。

---

# 15. M2 boundedness

Leaf 不可无限累积。

增加：

```text
frozenCheckpointTokenBudget
```

达到阈值时：

- 标记 `rootRebaseRecommended`；
- 第一版可等待 manual `/compact`；
- 若必须自动，需同时满足高 pressure + 明确 telemetry，并单独记录。

不要固定"每 6/8 个 checkpoint 必合并"。

---

# 16. M2 Gate

必须：

```text
C2.1 frontier monotonic
C2.2 frozen prefix byte-stable
C2.3 leaf checkpoint immutable
C2.4 context remains bounded via explicit root path
```

还需 paired baseline：

- PrefixMutationDepth(EF) < Basic；
- task success 非劣；
- duplicate work 不显著上升。

---

# 17. M3a — Deterministic Current State

新增：

```text
projection.ts
state.ts
authority.ts
renderer.ts
```

## 17.1 Projection 绝不能复制完整历史

保持：

```ts
interface FoldWorkingProjection {
  frontier: FrontierRef
  activeAnchors: ActiveAnchorState
  stateHeads: StateHeads
  openFailures: OpenFailureState
  openObligations: OpenObligationState
  tailFacts: BoundedTailFacts
  currentCheckpoints: CheckpointRef[]
}
```

历史 lineage cold。

---

# 18. M3a Anchor 类型

只做 deterministic：

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

暂不做：

```text
negative-knowledge
uncertainty
```

后者留 M3b。

---

# 19. M3a StateKey

```ts
interface StateKey {
  namespace: string
  entity: string
  property: string
}
```

例：

```text
config/server/timeout
artifact/src/foo.ts/version
build/current/status
```

当前 state 只保留 head。

---

# 20. Evidence rule

以下不允许产生 verified state：

```text
assistant says tests probably pass
semantic summary says bug fixed
```

只有明确 empirical/procedural evidence 才能产生 state transition。

例如：

```text
tool result / CI / filesystem evidence
```

---

# 21. Failure lifecycle

```text
OPEN
→ INVESTIGATING
→ RESOLVED
→ VERIFIED
```

只有 VERIFIED failure 可以从 active hot state 退休。

---

# 22. M3a Renderer

Leaf fold checkpoint 变为结构化 handoff：

```text
[EF C47 · verified]

Current
- ...

Evidence
- ...

Open
- ...

Rationale
- ...

Recall
- cp:C47
```

machine state 优先。

Rationale 可继续由 LLM 提供，但状态不依赖它。

---

# 23. M3a Gate

硬门：

```text
AuthorityLossRate = 0
StateStalenessRate = 0
ProvenanceCoverage = 100%
EvidenceOverridesNarrative = true
```

测试见 test spec。

---

# 24. M1 — Verified Ingress Reduction

只有 M0/M2/M3a 通过后再开始。

## 24.1 已知 DSH API 限制

tool pipeline：

```text
projectContent
→ tools/post-execute
→ finalizeContent
→ materialize
```

所以 `post-execute` 不是全局最终 model-content seam。

第一版只做：

**Verified Ingress Reduction**

---

# 25. ToolIngressProfile

```ts
interface ToolIngressProfile {
  toolName: string
  policy: "eligible" | "protected" | "unknown"
  reducer?: "log" | "json" | "diff" | "search" | "test"
  finalizationVerified: boolean
}
```

默认：

```text
unknown → no reduction
```

失败/error/security/subagent final result 默认 protected。

---

# 26. M1 transaction

```text
raw output
↓
eligible?
↓ yes
persist exact artifact
↓
artifact verify
↓
reduce projected content
↓
post-execute
↓
tool finalize
↓
observe final tools/result
↓
verify reduced digest survived
```

如果 final digest 不匹配：

- 标记该 tool incompatible；
- 禁止后续自动 ingress reduction；
- 不把 silent mismatch 当成功。

---

# 27. 可选 Core Enhancement

只有 M1 benchmark 证明 first-view reduction 有明显价值，才考虑 upstream 一个极小 seam：

```text
after finalizeContent
before materialization
```

要求：

- 只允许 content replacement；
- 不允许修改 canonical execution value；
- 不允许修改 error identity；
- 不允许修改 tool identity。

在此之前不修改 DSH Core。

---

# 28. M3b — Negative Knowledge / Uncertainty

最后加入 model-assisted classification。

新增 durable classification record，必须保留：

- source refs；
- exact quote（若有）；
- model；
- prompt version；
- label；
- lifecycle。

exact quote 必须 deterministic 验证为 source substring。

---

# 29. M3b Negative Knowledge

```ts
interface NegativeKnowledgeAnchor {
  subject: string
  rejectedClaim: string
  because: string[]
  validWhile?: string[]
  lifecycle: "active" | "stale" | "superseded"
}
```

不能永久"不要做 A"。

其有效性受前置 constraint/version 等条件约束。

---

# 30. M3b Uncertainty

```text
hypothesis
supported
established
rejected
```

LLM classifier 只可提案。

`established/rejected` 必须由 evidence transition 驱动。

---

# 31. 明确停止条件

达到 M3a 后必须先 benchmark。

如果：

- ALR = 0；
- SSR = 0；
- Prefix locality 显著优于 Basic；
- task success 非劣；
- DWR 低；
- recall regret 低；

则暂停扩大架构。

只有真实错误集中表现为"跨 checkpoint 隐式依赖丢失"时，再做 M4 graph。

不要为了完成蓝图而实现蓝图。

---

# 32. 每个阶段 Agent 报告格式

每阶段完成后只报告关键 Gate，不要逐微任务停顿。

格式：

```text
## Mx REPORT

Baseline
- HEAD:
- branch:
- dirty:

Implemented
- ...

Machine gates
- G1 PASS/FAIL
- G2 PASS/FAIL
- ...

Metrics
- ...

Deviations from RFC
- ...

New blockers
- ...

Decision
- PROCEED / STOP
```

Gate 失败时停止并给出证据。

Gate 全绿则继续下一个大阶段。
