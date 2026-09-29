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
| **R2-A** | Pressure attribution: frozen/open split, marginal reclaim ratio, fold-every-step detector · 压力归因：冻结/开放拆分 + 边际回收率 + 逐步折叠探测器 | ✅ 11 tests |
| **R2-B** | Economic leaf admission (reclaim floors; leaf forbidden when the frozen prefix alone exceeds the threshold) · 经济性 leaf 准入 | ✅ 8 tests |
| **R2-C** | Provider-aware amortized rebase + leaf-refusal handoff · 模型感知摊销式 rebase + 拒绝交接 | ✅ 10 tests |
| **R2-D** | Checkpoint surface diet: omit empty sections, keep identity and recall · checkpoint 瘦身 | ✅ 8 tests |
| **R2-E** | BCR/BQR price-dominance matrix · 价格支配矩阵 | ❌ **BCR 1.149 > 1** · [report](docs/14_R2_EVALUATION_REPORT.md) |
| **R3** | Frozen-surface economy closure: pricing correctness, production idle rebase, framing seam, marker V2 · 冻结面经济闭合 | ✅ BCR 0.986 · [report](docs/16_R3_EVALUATION_REPORT.md) |
| **R4** | Economy default closure: real-recall workload, realized billing, window safety, presets · 经济模式默认闭合 | ✅ 5/5 gate components · [report](docs/17_R4_EVALUATION_REPORT.md) |
| **RC0** | Release hardening: config contract, pairwise non-inferiority, all-call billing recorder · 发布加固 | ⚠️ **cost gate OPEN (dispersion)** · superseded by RC1 · [report](docs/18_RC0_RELEASE_HARDENING.md) |
| **RC1** | Policy normalization: trigger breakdown, measured safety reserve, replay simulator, cache microbench, certified profile · 策略标准化与经济模式认证 | ✅ **certified profile**; cost gate **OPEN (dispersion at n=8)**; global default NOT flipped · [report](docs/19_RC1_POLICY_NORMALIZATION.md) |
| **RC1.1** | Evidence reconciliation: component-wise certification, reserve demoted to a scoped estimate, replay confounds removed, unanchored-narrative boundary measured · 证据闭合与重放修正 | ✅ **mechanics certified**; cost recommendation **OPEN**; RC1-H withdrawn · [report](docs/20_RC1_1_EVIDENCE_RECONCILIATION.md) |
| **RC1.2** | End-to-end recall closure: real agent-loop recall smoke, deterministic mechanism proof, rationale tax priced from its measured size · 端到端召回闭合 | ✅ **recall proven**; preset unchanged; RC1.1 boundary corrected · [report](docs/21_RC1_2_RECALL_CLOSURE.md) |
| **RC1.3** | Retrieval ergonomics closure: un-hinted baseline, per-fact failure taxonomy, self-describing search hits, measured retrieval rule · 检索工效学闭合 | ✅ **quality side CLOSED** — economy 3.00/3, matching Basic; cost gate still **OPEN**; default still `legacy` · [report](docs/22_RC1_3_RETRIEVAL_ERGONOMICS.md) |

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

**R2 then attacked the price side, and did not finish.** The fold-every-step
loop is fixed (folds 50 → 24, peak context −68%) and EF's cost excess over
Basic was cut from BCR 1.276 to **1.149** — but the R2 objective was BCR < 1,
and **0 of 40 measured cells are cheaper than Basic**. The cause is now precise
rather than suspected: EF's cold-token overhead is nearly zero, and its entire
disadvantage is that it carries **1.5×–85× more warm tokens**, because the
frontier invariant forbids re-folding a frozen checkpoint while Basic re-folds
its single one. No rebase cadence reaches the objective (best: 1.096). Full
detail in [the R2 report](docs/14_R2_EVALUATION_REPORT.md) ·
**R2 随后转向价格侧，但未能完成。** 逐步折叠循环已修复（折叠次数 50 → 24，
峰值上下文 −68%），相对 Basic 的成本超额从 BCR 1.276 降到 **1.149**——但 R2
的目标是 BCR < 1，而 **40 个实测单元中 0 个比 Basic 便宜**。原因现已精确定位
而非猜测：EF 的 cold token 开销几乎为零，全部劣势在于它携带**多出 1.5–85 倍的
warm token**，因为 frontier 不变量禁止重折叠已冻结的 checkpoint，而 Basic 会
重折叠它唯一的那个。任何 rebase 节奏都达不到目标（最好为 1.096）。详见
[R2 报告](docs/14_R2_EVALUATION_REPORT.md)。

**R3–RC0 closed the price gap, then found the shipped defaults were not
calibrated for it.** R3 removed the framing tax (BCR 1.149 → 0.986 on the
economy workloads) and R4 built the real-recall workload, realized billing, and
the presets — reaching all five gate components satisfied. RC0 then hardened the
release contract and **changed the headline conclusion**: at the shipped
defaults the full-task realized ratio has a median of 0.96 but a CI upper bound
of 1.353, so the gate is **OPEN because of dispersion**, not because the typical
run is dearer. The default flip stayed blocked by design ·
**R3–RC0 收窄了价格差距，随后发现出厂默认值并未针对它校准。** R3 消除了 framing
税（经济负载上 BCR 1.149 → 0.986），R4 建成了真实召回负载、实测计费与预设，
五个 gate 组件全部满足。RC0 随后加固发布契约，并**改写了主结论**：在出厂默认值
下全任务实测比中位数为 0.96，但置信区间上界 1.353——gate 因**离散度**而 OPEN，
并非因为典型运行更贵。默认翻转按设计保持阻断。

**RC1 then normalized the policy instead of adding mechanism.** It named the
binding constraint (`thresholdRatio: 0.8` reads as an 80% trigger; the shipped
reserve makes the real trigger **49.6%**), measured the safety reserve
(**9,733** tokens needed vs **65,536** shipped — 6.73×), moved parameter search
off the API and onto a replay simulator that calls the *production* policy
functions, exonerated the frozen budget by measurement (0 of 135 shadow
evaluations were profitable-but-blocked), and classified the RC0 outlier as
**provider cache state** — at comparable prompt sizes the two request shapes
cache identically (reuse ratio 1.000). Running it live exposed two instrument
defects larger than the experiment itself: **the live endpoint accepts a
top-level `system` field, returns HTTP 200, and silently ignores it** (so every
earlier live measurement that relied on system-prompt assembly was not sending
one — which matters most for R3's framing change, whose entire saving is earned
there), and **the paired driver shared provider cache between runs and arms**,
so its null test read 1.606 where it must read ~1. With both fixed the null test
behaves (1.021) and the noise floor is 1.005 — but the cost verdict still does
not reproduce at n=8 (0.965 vs 1.104), so the gate stays **OPEN for dispersion**
on a sound instrument. The deliverable is a **certified operating profile** for
the measured route, not a global default: an uncertified route falls back to
`legacy`, never to `economy`.
Full detail in [the RC1 report](docs/19_RC1_POLICY_NORMALIZATION.md) ·
**RC1 随后选择规范化策略而非增加机制。** 它命名了真正的约束（`thresholdRatio:
0.8` 读作 80% 触发，而出厂 reserve 使真实触发点落在 **49.6%**），实测了安全
reserve（需要 **9,733** token，出厂 **65,536**，相差 6.73 倍），把参数搜索从
API 搬到调用**生产**策略函数的 replay 模拟器上，用实测为 frozen budget 免责
（135 次 shadow 评估中 0 次「有利可图却被阻断」），并把 RC0 的离群值归类为
**provider 缓存状态**——在可比 prompt 长度下两种请求形状缓存表现完全一致
（复用比 1.000）。实机运行还暴露了一个比实验本身更重要的缺陷：**实机端点接受
顶层 `system` 字段、返回 HTTP 200、却静默忽略它**，因此此前所有依赖 system
prompt 组装的实机测量都没有真正发送 system prompt——这对 R3 的 framing 改动
影响最大，因为该改动的全部收益正来自那里。最终交付物是**针对已测路由的经济模式
认证档案**，而非全局默认值：未认证路由回退到 `legacy`，绝不回退到 `economy`。
详见 [RC1 报告](docs/19_RC1_POLICY_NORMALIZATION.md)。

**RC1.1 then reconciled the evidence, and withdrew one RC1 conclusion.** Three
defects did not survive audit: the certified profile reported `certified: true`
while the cost gate was OPEN (a **cache** reuse ratio was standing in for a
**price** measurement), a ~30K-scale safety estimate was reported as a production
headroom, and the replay varied the trigger and the retention together — which is
what produced RC1-H's "the shipped reserve helps" conclusion. Holding retention
fixed **reverses the sign**, so that conclusion is withdrawn. With both confounds
removed the region Ω is wide (10 robust cells, 7 below parity across all cache
scenarios) and the mature production values sit in its widest band, but the live
cost verdict still does not reproduce at n=8. The live smoke also measured what looked like a
product boundary: the economy preset preserves **declared** state across folds and
its marker-only checkpoint has no prose in it.
The project state is now **Economy mechanics certified; route-level cost
recommendation still open**, with no new architecture added to flip a default.

**RC1.2 then closed that boundary question, and corrected it.** RC1.1's smoke
never executed a tool call, so it could only show that the *surface* lacks
undeclared prose — not that EF cannot recover it. With a real agent loop
(`model → tool-call → ToolRuntime → tool/result → next model step`) and a
deterministic keyless proof, `PARSE-7741` is absent from the surface and present
in what `context_search → context_recall` returns, under **both** semantic modes.
So `semanticMode` does not gate recall, and the correct contract is **declared
state is hot; undeclared history is recoverable through bounded recall**. The
preset keeps `semanticMode: 'none'` — not because rationale is unaffordable (it
costs +6.4%, measured against its real ~7.4K-token call rather than the 512 the
simulator had assumed) but because nothing requires it.

**RC1.2.1 then corrected the comparison itself.** The three-arm live smoke had
passed `plugin: true` unconditionally, and since the harness returns early on
that, its `engine: 'basic'` spread was dead code — **the "Basic" arm was really
EF**, which is why it reported `facts retrievable 2/5` on a metric undefined for
real Basic. The harness now **refuses** that combination outright, and the
corrected comparison was: true Basic scores **3.00/3 with zero tool calls**, while
economy-none scores 2.40/3 with a tool returning the facts in **5/5** runs — so the
gap is **retrieval policy and model tool use**, not storage or mechanism.

**RC1.3 then closed that gap, and it was retrieval ergonomics on both sides.**
An un-hinted baseline (no "use context_search" in the probe) plus a per-fact
failure taxonomy found the only failure mode was `no-search` — never a
`recall-miss`, so no product-side retrieval defect — and two concrete defects
underneath it. First, `context_search` returned a 240-character excerpt *centred*
on the match, which cut a 230-character message's **other** facts off the front:
the model searched for one value, got an excerpt naming its neighbours, and
answered the rest `unknown`. A hit was manufacturing a `search-miss`. Short
messages now come back whole, and hits report `matchKind`, a verbatim excerpt, and
the `context_recall` page that holds the match. Second, the test filler numbered
its units in decimal, so `unit 64` and `unit 90` satisfied the fact matchers from
retained filler — a confound that also affected RC1.2's numbers. With both fixed
the baseline read 2.33/3, and one measured change to the framing section — search
the folded history before answering or reporting something unknown — took it to
**3.00/3, matching Basic**, reproduced in two independent n=9 runs with search in
9/9. The hint is now worth **0.00**: a deployment no longer needs to tell the
agent how to use its own tools. Economy remains a **retrieval-dependent low-cost
mode** (still ~17× cheaper on the n=5 sample) and is **not** promoted to a generic
default replacement. Full detail in
[the RC1.3 report](docs/22_RC1_3_RETRIEVAL_ERGONOMICS.md) ·
[the RC1.2 report](docs/21_RC1_2_RECALL_CLOSURE.md) ·
**RC1.2 随后闭合了该边界问题，并作出修正。** RC1.1 的 smoke 从未执行工具调用，因此
只能说明**表面**不携带未声明叙述，而非 EF 无法恢复它。通过真实 agent loop
（`model → tool-call → ToolRuntime → tool/result → 下一模型步`）与确定性的 keyless
证明，`PARSE-7741` 不在表面上，却存在于 `context_search → context_recall` 的返回中，
且在**两种** semantic mode 下均如此。因此 semanticMode 并不限制召回，正确的契约是
**已声明状态热保存；未声明历史可通过有界召回恢复**。preset 保持 `semanticMode: 'none'`
——并非因为 rationale 负担不起（实测其真实约 7.4K token 的调用后仅增加 6.4%，而非
模拟器假设的 512），而是因为没有证据表明需要它。

**RC1.2.1 随后修正了比较本身。** 三臂实机 smoke 无条件传入了 `plugin: true`，而 harness
在该选项上提前返回，因此其 `engine: 'basic'` 展开是死代码——**所谓 "Basic" arm 实为
EF**，这正是它报出 `facts retrievable 2/5` 的原因（该指标对真正的 Basic 并无定义）。
harness 现在**直接拒绝**该组合。修正后的比较为：真正的 Basic 以**零工具调用**取得
**3.00/3**，而 economy-none 取得 2.40/3，且工具有 **5/5** 的运行返回了事实。因此差距在于
**检索策略与模型工具使用**，而非存储或机制。

**RC1.3 随后闭合了这一差距，而它两侧都是检索工效学问题。** 通过无提示 baseline
（probe 中不再出现 "use context_search"）与逐事实的失败分类，发现唯一的失败模式是
`no-search`——从未出现 `recall-miss`，因此不存在产品侧的检索缺陷——其下有两个具体缺陷。
其一，`context_search` 返回以命中位置**居中**的 240 字符摘录，会把一条 230 字符消息的
**其他**事实截掉：模型检索某个值时拿到只提到其邻居的摘录，于是把其余问题答成
`unknown`。**命中本身在制造 `search-miss`。** 现在短消息整体返回，命中同时报告
`matchKind`、逐字摘录，以及承载该命中的 `context_recall` 页码。其二，测试填充文本以
十进制编号单元，于是保留的填充里 `unit 64`、`unit 90` 直接满足了事实匹配器——这一
confound 同样影响了 RC1.2 的数字。两者修正后 baseline 为 2.33/3；对 framing section
做一处可测量的改动——在回答或将某事报告为未知之前，先检索已折叠历史——使其达到
**3.00/3，与 Basic 持平**，并在两次独立的 n=9 运行中复现（9/9 均发生检索）。提示词现在
的增量为 **0.00**：部署方不再需要告诉 agent 如何使用它自己的工具。economy 仍是
**依赖检索的低成本模式**（n=5 样本上仍约便宜 **17 倍**），**并未**被提升为通用默认
替代品。详见 [RC1.3 报告](docs/22_RC1_3_RETRIEVAL_ERGONOMICS.md) ·
[RC1.2 报告](docs/21_RC1_2_RECALL_CLOSURE.md)。
Full detail in [the RC1.1 report](docs/20_RC1_1_EVIDENCE_RECONCILIATION.md) ·
**RC1.1 随后校正了证据，并撤回了一条 RC1 结论。** 三处缺陷未能通过审计：认证档案在
成本 gate 为 OPEN 时报告 `certified: true`（**缓存**复用比冒充了**价格**测量）；
一个约 30K 采样尺度的安全估计被当作生产 headroom；重放同时变动了 trigger 与
retention——而这正是 RC1-H「出厂 reserve 有益」结论的来源。固定 retention 后符号
**反转**，该结论予以撤回。两个 confound 去除后，区域 Ω 足够宽（10 个稳健格点，
7 个在所有缓存情景下均低于平价），成熟的生产参数位于最宽区间内，但实机成本结论在
n=8 下仍不可复现。实机 smoke 还测出了一条真实产品边界：经济模式预设能跨折叠保留
**已声明**状态，但**不**承载未锚定的叙述（可复现地 0/3，而 Basic 为 1/3），因为
marker-only checkpoint 里没有叙述文本——rationale checkpoint 能恢复其中大部分，
因此这是预设自身的选择而非架构限制。项目状态现为**经济机制已认证；路由级成本推荐
仍然开放**，且未为翻转默认值新增任何架构。详见
[RC1.1 报告](docs/20_RC1_1_EVIDENCE_RECONCILIATION.md)。

### Frozen stages · 已冻结阶段

These are closed and should not be re-litigated in future reports. They reopen
only when a new incident corpus produces corresponding evidence (RC1 §46) ·
以下阶段已关闭，后续报告不再重复讨论；仅当新的故障语料产生对应证据时才重新开启
（RC1 §46）：

```
M1           CLOSED / deferred by evidence
M3b          CLOSED / deferred
M4           CLOSED / deferred
M5           CLOSED / no measured need
RecallPrune  CLOSED / no measured problem
DeltaLeaf    REJECTED (R1-B gate)
```

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
npx vitest run                     # the whole suite · 全量测试套件
npx tsc --noEmit -p tsconfig.json  # type check against vendor declarations
```

The suite grows every stage, so this file deliberately does NOT state a test
count: a hardcoded number goes stale the moment a spec is added, and a stale
count is read as an unfinished suite. `vitest run` prints the authoritative
totals. The live tiers are opt-in (`EF_LIVE=1`) and SKIP without a resolved
route, so an unmeasured behavior is never reported as a passing one.
本文件刻意不写死测试数量：每个阶段都会增加用例，写死的数字一经添加新用例即过期，
而过期的数字会被误读为套件不完整。权威数字以 `vitest run` 的输出为准。
Live 层为可选（`EF_LIVE=1`），没有可用路由时跳过，绝不把「未测量」报成「通过」。

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

### Configuration modes · 配置模式

R4 adds a named mode, so a deployment does not have to understand the internal
mechanisms to use the product. R4 引入命名模式，部署方无需理解内部机制：

```yaml
- name: dsh-epistemic-fold
  config:
    bundleRoot: <profile persistence root>/epistemic-fold
    mode: economy          # or: legacy (the default) · 或 legacy（默认）
```

`mode: economy` fills in the policy keys R3 measured as cheaper
(`leafAdmission: economic`, `rootPolicy: economics`, `semanticMode: none`,
`framingMode: system-dedup`). It is a named **set of values, not a branch**:
expansion happens before resolution, so the engine cannot tell a preset from the
same keys written by hand, and **an explicit setting always wins** over the
preset. `mode: economy` 展开为 R3 实测更省的策略键组合；它是「一组具名取值」而非分支，
展开在解析之前完成，因此引擎无法区分 preset 与手写配置，且**显式设置始终覆盖 preset**。

`framingMode: system-dedup` requires the DSH `frameCheckpoint` seam. Without it
the engine **refuses to start** rather than silently running with per-checkpoint
framing — which would report an economy saving the deployment does not get.
Apply the seam with `node scripts/apply-framing-seam.mjs <dsh-root>`, upgrade
DSH, or set `framingMode: legacy` explicitly.
`system-dedup` 依赖 DSH 的 `frameCheckpoint` seam；缺失时引擎**拒绝启动**，而不是静默退回
per-checkpoint framing（那会报告一个实际并未获得的节省）。

`reliability` is deliberately **not** offered yet: there is no live evidence for
what the right reliability configuration is, and naming one would assert a
conclusion the project does not have. `reliability` 暂不提供：尚无实测证据确定最优
reliability 配置，命名它等于断言一个项目尚未得到的结论。

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
| [14_R2_EVALUATION_REPORT.md](docs/14_R2_EVALUATION_REPORT.md) | R2 price-dominance report: BCR 1.276 → 1.149, why the objective was not reached, and what would be required · R2 价格支配报告 |
| [15_R2_FRAMING_CEILING.md](docs/15_R2_FRAMING_CEILING.md) | R2 framing-ceiling analysis: the repeated preamble is the dominant checkpoint cost · R2 framing 天花板分析 |
| [16_R3_EVALUATION_REPORT.md](docs/16_R3_EVALUATION_REPORT.md) | R3 frozen-surface economy closure: pricing correctness, production idle rebase, framing seam, and where the directive said to STOP · R3 冻结面经济闭合 |
| [17_R4_EVALUATION_REPORT.md](docs/17_R4_EVALUATION_REPORT.md) | R4 economy default closure: real-recall workload, realized billing, window safety, presets, and the eligibility gate · R4 经济模式默认闭合 |
| [18_RC0_RELEASE_HARDENING.md](docs/18_RC0_RELEASE_HARDENING.md) | RC0 release hardening: the configuration contract, pairwise non-inferiority, the all-call billing recorder, and the dispersion that keeps the cost gate OPEN · RC0 发布加固 |
| [19_RC1_POLICY_NORMALIZATION.md](docs/19_RC1_POLICY_NORMALIZATION.md) | RC1 policy normalization: trigger breakdown, measured safety reserve, replay simulator, cache microbench, and the certified economy profile · RC1 策略标准化与经济模式认证 |
| [20_RC1_1_EVIDENCE_RECONCILIATION.md](docs/20_RC1_1_EVIDENCE_RECONCILIATION.md) | RC1.1 evidence reconciliation: component-wise certification, the reserve as a scoped estimate, both replay confounds removed, the withdrawn RC1-H conclusion, and the measured unanchored-narrative boundary · RC1.1 证据闭合与重放修正 |
| [21_RC1_2_RECALL_CLOSURE.md](docs/21_RC1_2_RECALL_CLOSURE.md) | RC1.2 end-to-end recall closure: the real agent-loop recall smoke, the deterministic mechanism proof, the corrected product boundary, and the rationale tax at its measured size · RC1.2 端到端召回闭合 |
| [22_RC1_3_RETRIEVAL_ERGONOMICS.md](docs/22_RC1_3_RETRIEVAL_ERGONOMICS.md) | RC1.3 retrieval ergonomics closure: the un-hinted baseline, the per-fact failure taxonomy, the self-describing `context_search` hit, the excerpt-window defect, and the measured retrieval rule that brought economy to parity with Basic · RC1.3 检索工效学闭合 |

`profiles/economics/` holds versioned provider pricing data (asOf + source,
caller-overridable) used by the R1 cost model — benchmark input, never
algorithm constants · `profiles/economics/` 存放版本化的 provider 价格数据
（带 asOf 与来源、可被调用方覆盖），供 R1 成本模型使用——属于 benchmark
输入，而非算法常量。

## License · 许可证

[MIT](LICENSE)
