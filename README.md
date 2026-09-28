# Epistemic Fold

> **Epistemic Fold for DeepSeek Harness**
> *A contract-preserving context runtime for long-horizon agents.*
> *面向长周期 Agent 的、保持契约的上下文运行时。*

## What is this? · 这是什么？

Epistemic Fold (EF) is a compaction backend plugin for the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that treats
conversation history, memory, and working context as three different things:

```
History ≠ Memory ≠ Context
```

Its core principle:

> **An agent may fold a trajectory out of the working context only after its
> externally relevant epistemic effects have been materialized, preserved, and
> made recoverable.**

EF 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
的一个 compaction backend 插件。它把会话历史、记忆与工作上下文当作三件不同
的事，核心命题：

> **只有当一段轨迹对未来仍有意义的知识效应已经被稳定对象吸收、关键状态与
> 边界得到保留、且原始证据可以恢复时，该轨迹才有资格被折叠出工作上下文。**

Concretely, when the runtime folds a span of conversation it ·
运行时折叠一段会话时：

1. **archives the exact model-visible messages** into an immutable,
   hash-verified `CheckpointBundle` *before* any lossy surface replacement
   commits (`BundleDurable ≺ SurfaceLoss`) —
   **先归档精确的模型可见消息**到不可变、哈希校验的 `CheckpointBundle`，
   在任何有损 surface 替换提交之前；
2. **never re-folds what is already frozen** — a monotonically advancing
   *Fold Frontier* separates frozen checkpoints from the open trajectory, so
   the cached prefix stays byte-stable across folds —
   **绝不重折叠已冻结的内容** —— 单调前进的 Fold Frontier 分隔冻结
   checkpoint 与开放轨迹，缓存的 prefix 在多次折叠间逐字节稳定；
3. **derives the current state deterministically from raw session events** —
   objectives, constraints, decisions, values, evidence, failures, and
   obligations, with full provenance and a hard rule that narrative summaries
   can never verify state (`Raw Events → State` and `Raw Events → Summary`
   run in parallel; `Raw → Summary → State` is forbidden) —
   **当前状态由原始 session 事件确定性派生**，全部携带完整 provenance；
   语义摘要永远不能验证状态（`Raw → Summary → State` 被禁止）；
4. **recovers exactly** — `context_search` / `context_recall` serve bounded,
   paginated, provenance-checked recall of anything that left the working
   set —
   **精确恢复** —— `context_search` / `context_recall` 提供有界、分页、
   经 provenance 校验的召回。

The optimization goal is not maximal compression. It is correctness first —
then information density, prefix-cache locality, long-horizon state
consistency, and stable closed-loop continuation.

优化目标不是最大压缩率，而是 correctness first —— 在硬正确性约束下提高信息
密度、prefix cache 局部性、长期状态一致性与闭环延续稳定性。

## Status · 状态

Research implementation against **DeepSeek Harness `0.1.7-rc.2`** (verified
baseline `477b4f420553e8a52c2fbccc464d7561b239c443`) · 对照 DSH
`0.1.7-rc.2` 核验基线的研究性实现。

| Milestone 里程碑 | Scope 范围 | Gate |
|---|---|---|
| **M0** | Exact archive / recall closure, atomic bundle store, deterministic fallback · 精确归档/召回闭环、原子 bundle store、确定性 fallback | ✅ C0.1–C0.5 |
| **M2** | Fold Frontier, leaf/root folds, prefix fingerprint proofs · Fold Frontier、leaf/root 折叠、prefix 指纹证明 | ✅ C2.1–C2.4 |
| **M3a** | Deterministic current state (anchors, authority, projection) · 确定性当前状态 | ✅ ALR=0 · SSR=0 · provenance=100% · bounded |
| **R0-A** | Cross-layer integration closure: marker protocol, frontier hard invariant, recall isolation, commit records, authority gate, disjoint rendering · 跨层组合正确性闭合 | ✅ 65 tests |
| **R0-B** | Native plugin entry, package manifest, composition smoke (mount/fold/restart), CI lanes · 原生插件入口 + 组装冒烟 + CI | ✅ |
| **R0-C** | Corrected metrics, keyless boundary corpus (12 hard + 6 exploratory), paired runner (B1/E3a0/E3aR), long-horizon economics 32/64/128 · 指标修正 + 边界语料 + 配对续跑 + 长程经济学 | ✅ 115 tests · [report](docs/07_R0C_EVALUATION_REPORT.md) |
| **R1-A** | Token source attribution, versioned economics profiles (asOf + source, user-overridable), provider cache telemetry · 词元来源归因 + 版本化经济模型 + 缓存实况遥测 | ✅ 24 tests |
| **R1-B** | W1–W5 workloads × 32/64/128, counterfactual ROI lab (Delta / M1 / M5 / Adaptive Root) · 五类负载矩阵 + 反事实 ROI 实验台 | ✅ 14 tests · [gate](docs/11_R1B_ROUTE_SELECTION_GATE.md) |
| **R1-D** | Provider-aware amortized rebase policy compiler (break-even horizon, hard overrides win) · 模型感知摊销式 rebase 策略编译器 | ✅ 12 tests |
| **R1-E** | Pareto frontier over cost / footprint / success, correctness as a filter · 帕累托前沿 + 正确性作为过滤器 | ✅ 9 tests · [report](docs/12_R1_EVALUATION_REPORT.md) |
| **R1 live** | Opt-in live behavioral subset against the configured model + measured cache realization · 可选实模型行为子集 + 实测缓存命中率 | ⚠️ **NULL RESULT** · [results](docs/13_R1_LIVE_BEHAVIORAL_RESULTS.md) |

M1 (verified ingress reduction), M3b (negative knowledge / uncertainty), M4
(dependency graph) and beyond are **deliberately not implemented** — each
requires observed failure evidence from benchmarks first (see
[05_EF_DECISIONS_AND_OPEN_QUESTIONS.md](docs/05_EF_DECISIONS_AND_OPEN_QUESTIONS.md),
section F) · M1/M3b/M4 及之后**刻意未实现**——每项都需要 benchmark 先观察到
对应的失败证据（见 [05 文档](docs/05_EF_DECISIONS_AND_OPEN_QUESTIONS.md)第 F 节）。
R1 followed the same rule and **rejected production Delta Leaf** on measured
ROI (3.7–16.6% upper bound) in favour of an amortized root policy ·
R1 遵循同一规则：依据实测 ROI（上限 3.7–16.6%）**否决了生产化 Delta Leaf**，
改走摊销式 root 策略。

Evaluation evidence (R0-C, keyless + deterministic): EF keeps **more history
cache-warm** at every horizon, and the leaf/root maintenance loop works. The
honest long-horizon finding is that **frozen checkpoints charge a recurring
prompt cost that can exceed Basic's rewrite cost** as folds accumulate —
root rebase cuts that load ~45% and is the effective lever. EF's cache
locality converts into cost advantage only while the provider's cache
discount is deep (ρ break-even curve). Full numbers, including the cases where
EF does *not* win, are in
[the R0-C evaluation report](docs/07_R0C_EVALUATION_REPORT.md) ·
评估证据（R0-C，keyless + 确定性）：EF 在每个时间尺度上都保留**更多
cache-warm 历史**，leaf/root 维护回路工作正常。诚实的长期发现是：
**frozen checkpoint 的重复 prompt 成本会随折叠累积，可能超过 Basic 的重写
成本**——root rebase 能把该负载降低约 45%，是有效的杠杆。EF 的 cache 局部性
只有在 provider 缓存折扣足够深时才转化为成本优势（ρ break-even 曲线）。
包含 EF 并不占优情形的完整数据见 [R0-C 评估报告](docs/07_R0C_EVALUATION_REPORT.md)。

R1 evidence (keyless, deterministic) locates the real cost precisely, and it
is not where the architecture expected: **~87% of a leaf checkpoint node is
repeated framing preamble**, and because the frozen prefix is monotonically
non-decreasing, once it alone exceeds the pressure threshold *every* step
folds — EF folds 51× against Basic's 21× on an identical workload and digest,
a 3.3× total-token gap. With task success held constant, Basic dominates EF on
cost and footprint on every workload; the
[R1 report](docs/12_R1_EVALUATION_REPORT.md) states that plainly and states
equally plainly that it is not a verdict — equal success is the one premise
the keyless tier cannot test, and EF's entire justification is that success is
*not* equal. No production default is flipped on economics alone ·
R1 证据（keyless、确定性）精确定位了真实成本，而它并不在架构预期之处：
**leaf checkpoint 节点约 87% 是重复的 framing 前导文本**；且由于 frozen
prefix 单调不减，一旦其自身超过压力阈值，**每一步**都会折叠——相同负载与
相同摘要文本下 EF 折叠 51 次而 Basic 仅 21 次，总词元相差 3.3 倍。在任务
成功率相同的前提下，Basic 在每个负载上都优于 EF；[R1 报告](docs/12_R1_EVALUATION_REPORT.md)
如实陈述这一点，并同样明确说明这**不是最终结论**——"成功率相同"正是 keyless
层唯一无法验证的前提，而 EF 的全部理由就是成功率**并不相同**。任何生产默认值
都不会仅凭经济性而改变。

**The live tier then ran, and it did not find a behavioral advantage.** 64
paired trials against the configured model scored **EF 32/32 vs Basic 31/32** —
one trial, which is not evidence. The null result is reported as null:
at this scale Basic's lossy summary retained every fact the cases probed. Two
things were decisive, though: **measured cache realization h = 0.910** (not the
assumed 1.000), making the effective ratio **5.9× worse than the headline ρ**;
and a **production bug no keyless test could see** — failure anchors rendered
without their description, so the model saw that something was unresolved but
not what. Full detail in
[the live results](docs/13_R1_LIVE_BEHAVIORAL_RESULTS.md) ·
**实模型层随后运行，并未发现行为优势。** 对当前配置模型完成 64 组配对试验，
结果为 **EF 32/32 对 Basic 31/32**——仅差一次，不构成证据。零结果即如实报告
为零结果：在该规模下，Basic 的有损摘要保留了全部被测事实。但有两项结论是明确
的：**实测缓存命中率 h = 0.910**（而非假定的 1.000），使有效价格比**比标称 ρ
差 5.9 倍**；以及一个**keyless 测试完全无法发现的真实缺陷**——failure anchor
渲染时丢失了描述，模型只能看到"有未解决项"却看不到"是什么"。详见
[实模型结果](docs/13_R1_LIVE_BEHAVIORAL_RESULTS.md)。

## Development · 开发方式

This repository is a standalone plugin source tree. Tests run the vendored DSH
**sources** directly (the same source-level resolution the DSH monorepo uses),
so no build of the plugin itself is needed ·
本仓库是独立的插件源码树。测试直接运行 vendor 的 DSH **源码**（与 DSH
monorepo 相同的源码级解析方式），插件本身无需构建。

Prerequisites · 前置要求：Node `^22.19 || >=24`, pnpm `11.7.x`, npm.

```bash
# 1. Vendor the DSH monorepo at the verified baseline · 在核验基线上 vendor DSH monorepo
git clone https://github.com/deepseek-ai/deepseek-harness.git vendor/deepseek-harness
cd vendor/deepseek-harness
git checkout 477b4f420553e8a52c2fbccc464d7561b239c443
pnpm install

# 2. Build declaration output for the packages EF consumes · 构建 EF 消费包的声明输出
node --max-old-space-size=8192 ./node_modules/typescript/bin/tsc -b \
  packages/compaction/compaction-basic packages/core/tools packages/util/atomic-write

# 3. Back in the plugin repo: install tooling and (re)generate the
#    src/type resolution maps into vitest.config.ts + tsconfig.json
#    回到插件仓库：安装工具链并重新生成两张解析表
cd ../..
npm install
node scripts/generate-maps.cjs

# 4. Run everything · 全量运行
npx vitest run                     # 49 tests across 5 suites · 5 个套件共 49 个测试
npx tsc --noEmit -p tsconfig.json  # type check against vendor declarations
```

`scripts/generate-maps.cjs` extracts the `@deepseek-ai/*` path table from the
vendored monorepo and emits two maps: `scripts/vendor-paths.json` (sources,
consumed by the vitest alias table) and `scripts/vendor-types-paths.json`
(built declarations, consumed by tsconfig). Re-run it after rebasing the
vendor clone onto a new DSH version ·
该脚本从 vendor monorepo 提取 `@deepseek-ai/*` 路径表，产出两张映射：
`scripts/vendor-paths.json`（源码，供 vitest alias 表使用）与
`scripts/vendor-types-paths.json`（构建产物声明，供 tsconfig 使用）。vendor
clone 升级到新 DSH 版本后重新运行即可。

## Plugin usage · 插件用法

Mount the composite plugin into a cordis context — it owns `ctx.compaction`,
registers the deterministic state projection, provides the authority-gated
anchor service as `ctx.epistemicFold`, and registers the `context_search` /
`context_recall` tools when a ToolRuntime is present ·
将复合插件挂载到 cordis context——它持有 `ctx.compaction`、注册确定性状态
projection、提供 `ctx.epistemicFold`（authority 门控的 anchor 写入通道），
并在存在 ToolRuntime 时注册 `context_search` / `context_recall`：

```ts
import { EpistemicFoldPlugin } from 'dsh-epistemic-fold/plugin'

await ctx.plugin(EpistemicFoldPlugin, {
  auto: true,
  // Point bundles at the profile's persistence root (cleaned with the profile).
  bundleRoot: `${profileRoot}/epistemic-fold`,
  semanticMode: 'rationale', // or 'none' for a zero-LLM deterministic runtime
})
```

DSH profile YAML（等价形态 · equivalent form）:

```yaml
- name: dsh-epistemic-fold
  config:
    bundleRoot: <profile persistence root>/epistemic-fold
    semanticMode: rationale
```

Continuous Integration runs two lanes on every push: the **pinned DSH
baseline** (mandatory) and **DSH master** (allowed-to-fail compatibility
probe) · CI 每次推送跑两条 lane：pinned 基线（必过）与 DSH master
（allowed-to-fail 兼容性探测）。

## Repository layout · 仓库结构

```
src/
  engine.ts        EpistemicFoldEngine — Basic's transaction + EF compile hook · Basic 事务 + EF compile hook
  policy.ts        plugin config resolution + routed-model pressure math · 配置解析 + 压力数学
  candidate.ts     pending fold-candidate identity (single slot per session) · 每 session 单槽
  bundle-store.ts  FileBundleStore — atomic, hash-verified, 0600 permissions · 原子写、哈希校验
  compiler.ts      input splitting, canonical bundle build, checkpoint rendering · 输入切分、bundle 构建
  frontier.ts      Fold Frontier: locate/re-derive from the CURRENT surface · 从当前 surface 重定位
  leaf-policy.ts   [frontier+1, bestEnd] span selection + frozen budget load · span 选择 + 冻结预算
  root-policy.ts   root rebase advisories (manual /compact = Root Fold) · rebase 建议
  state.ts         deterministic StateReducer: anchors, supersession, lifecycles · 确定性状态
  authority.ts     which event kinds may ground which authority domains · authority 模型
  projection.ts    wires the reducer into ctx.sessionProjections · 接入投影注册表
  renderer.ts      structured checkpoint: Current/Evidence/Open/Rationale/Recall · 结构化 checkpoint
  recall.ts        context_search + context_recall (bounded, paginated, exact) · 有界精确召回
  tools.ts         registers the recall tools against ctx.tools · 注册召回工具
  hash.ts          canonical JSON + SHA-256 digests · canonical JSON + 摘要
  economics-profile.ts  versioned cost model: ρ, ρ_eff, cache realization, break-even · 版本化成本模型
  policy-compiler.ts    amortized rebase policy: break-even horizon, hard overrides · 摊销式 rebase 策略
eval/src/
  token-attribution.ts  per-request token buckets that reconcile exactly · 词元来源归因
  provider-telemetry.ts realized cache rate from provider usage · 缓存实况遥测
  counterfactual.ts     oracle arms measuring ROI upper bounds · 反事实 ROI 上界
  pareto.ts             frontier over cost/footprint/success; correctness is a filter · 帕累托前沿
eval/workloads/   W1–W5 workload matrix · 五类负载
profiles/economics/  versioned provider pricing (asOf + source) · 版本化价格数据
tests/             M0/M2/M3a/R0/R1 suites + shared harness (controlled LLM adapter) · 测试套件 + 共享 harness
bench/             paired-baseline harness (Basic vs EF prefix economics) · 配对基线 harness
```

## Design docs · 设计文档

All design documents live in [`docs/`](docs/) ·
全部设计文档位于 [`docs/`](docs/)：

| Document 文档 | Contents 内容 |
|---|---|
| [00_README_EF.md](docs/00_README_EF.md) | Project entry: naming, goals, nine core invariants · 项目入口：命名、目标、九条核心不变量 |
| [01_EF_RFC_001_ARCHITECTURE.md](docs/01_EF_RFC_001_ARCHITECTURE.md) | Architecture spec: truth model, data structures, fold transactions · 架构规范：真相模型、数据结构、折叠事务 |
| [02_EF_IMPLEMENTATION_PLAN_M0_M3.md](docs/02_EF_IMPLEMENTATION_PLAN_M0_M3.md) | Engineering DAG, gates, stop conditions · 工程 DAG、阶段 Gate、停止条件 |
| [03_EF_TEST_BENCHMARK_SPEC.md](docs/03_EF_TEST_BENCHMARK_SPEC.md) | Metrics (ALR/SSR/DWR/CR/PMA), test suites, benchmark arms · 指标、测试套件、benchmark 分组 |
| [04_EF_LOCAL_AGENT_WORK_ORDER.md](docs/04_EF_LOCAL_AGENT_WORK_ORDER.md) | Execution order and prohibitions for an implementation agent · 实现 Agent 的执行顺序与禁令 |
| [05_EF_DECISIONS_AND_OPEN_QUESTIONS.md](docs/05_EF_DECISIONS_AND_OPEN_QUESTIONS.md) | Frozen decisions, hypotheses, open questions · 冻结决定、假设、开放问题 |
| [06_FINAL_REPORT.md](docs/06_FINAL_REPORT.md) | Final implementation report: gates, evidence, deviations, refactor record · 最终实现报告 |
| [07_R0C_EVALUATION_REPORT.md](docs/07_R0C_EVALUATION_REPORT.md) | R0-C evaluation: measurement integrity, corpus, paired continuation, long-horizon economics, next-stage decision · R0-C 评估报告 |
| [08_BOUNDARY_CORPUS_PROTOCOL.md](docs/08_BOUNDARY_CORPUS_PROTOCOL.md) | Boundary corpus protocol: sidecar format, oracle union, action signatures · 边界语料协议 |
| [09_EVALUATION_METRICS_SPEC.md](docs/09_EVALUATION_METRICS_SPEC.md) | Exact metric definitions (SPN/SPT/IST/PMA/DWR/CR/ρ) · 评估指标规范 |
| [10_LOCAL_AGENT_WORK_ORDER_R0C.md](docs/10_LOCAL_AGENT_WORK_ORDER_R0C.md) | R0-C execution work order · R0-C 执行工单 |
| [11_R1B_ROUTE_SELECTION_GATE.md](docs/11_R1B_ROUTE_SELECTION_GATE.md) | R1-B route-selection gate: measured ROI per candidate, and the decision to reject production Delta Leaf · R1-B 路线选择 Gate：各候选实测 ROI 与否决 Delta Leaf 的决策 |
| [12_R1_EVALUATION_REPORT.md](docs/12_R1_EVALUATION_REPORT.md) | R1 evaluation report (GENERATED by `npm run eval:r1-report`): attribution, regime sensitivity, counterfactual bounds, per-profile policy, Pareto · R1 评估报告（由脚本生成） |
| [13_R1_LIVE_BEHAVIORAL_RESULTS.md](docs/13_R1_LIVE_BEHAVIORAL_RESULTS.md) | Live behavioral subset results: the null result, measured cache realization h = 0.910, and the production bug it found · 实模型行为子集结果：零结果、实测缓存命中率、以及发现的真实缺陷 |

`profiles/economics/` holds versioned provider pricing data (asOf + source,
caller-overridable) used by the R1 cost model — benchmark input, never
algorithm constants · `profiles/economics/` 存放版本化的 provider 价格数据
（带 asOf 与来源、可被调用方覆盖），供 R1 成本模型使用——属于 benchmark
输入，而非算法常量。

## License · 许可证

[MIT](LICENSE)
