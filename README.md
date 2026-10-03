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

---

## Install · 安装

EF is a real DSH plugin: it builds to loadable JS and ships a bundle patch that
substitutes itself into DSH's own agent presets. There are **three ways** to
install it, and they differ in one way that matters — whether the build runs for
you.

EF 是真正的 DSH 插件：构建为可加载 JS，并附带把自己替换进 DSH 自带 preset 的
bundle patch。有三种安装方式，差别在于**构建是否自动完成**。

| channel | spec | runs the build? | what it needs |
| --- | --- | --- | --- |
| **git** (recommended) | `github:orangeofcarl0-sys/dsh-epistemic-fold` | **yes** | one `allowBuilds` line, which dsh prints for you |
| **path** | `file:/path/to/dsh-epistemic-fold` | **no** | run `npm install` in the source tree first |
| **registry** | `dsh-epistemic-fold` | n/a | not available — the package is `private` and unpublished |

### Install from git

```bash
dsh plugin --profile <name> add github:orangeofcarl0-sys/dsh-epistemic-fold
```

The first run stops with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`. That is pnpm
blocking build scripts, not a defect: **dsh prints the exact `allowBuilds` line
to paste** into the profile's `pnpm-workspace.yaml`. Add it and re-run. The
install then builds `lib/` and generates the preset rows as part of `prepare`.

首次运行会以 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 停止。这是 pnpm 拦截构建
脚本，不是缺陷：**dsh 会打印出要粘贴到 profile `pnpm-workspace.yaml` 的
`allowBuilds` 行**。加上后重跑即可。

### Install from a local checkout

```bash
cd /path/to/dsh-epistemic-fold
npm install          # builds lib/ — the file: channel does NOT do this for you
npm run preflight    # verifies the tree is installable
```

then add it as a `file:` dependency. **The `file:` channel does not run the
build** — measured, pnpm skips `prepare` for path dependencies. Without
`npm install` the install copies a directory whose `main` (`lib/entry.js`) does
not exist, and the loader reports `failed to import` for an entry that is itself
the install doctor. `npm run preflight` catches that before you install.

`file:` 通道**不会**替你构建——实测 pnpm 对路径依赖跳过 `prepare`。不先
`npm install` 就会装入一个 `main` 指向不存在文件的目录。`npm run preflight`
会在安装前拦住这种情况。

### Configure the profile

```jsonc
// <DSH_HOME>/profiles/<name>/package.json
{
  "dependencies": { "dsh-epistemic-fold": "file:/path/to/dsh-epistemic-fold" },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-epistemic-fold"        // ← MUST come after dsh-web-app
      ]
    }
  }
}
```

Then `pnpm install` in the profile directory and boot with `dsh --profile <name>`.

**Bundle order is a correctness requirement.** The substitution patch overrides
rows that `@deepseek-ai/dsh-web-app` declares. Listed before it, the patch finds
nothing — and EF's doctor reports that loudly rather than silently leaving you on
native Basic.

**bundle 顺序是正确性要求。** 替换 patch 覆盖的是 `dsh-web-app` 声明的行；排在
它前面，patch 什么也找不到——EF 自带的 doctor 会大声报告，而不是静默把你留在
Basic 上。

**The preset menu does not change.** EF substitutes itself into DSH's own
`standard`, `ptc` and `cordis` presets, so there is nothing new to choose.
`minimal` is left exactly as DSH ships it — it declares no compaction group, so
there is nothing to substitute.

**preset 菜单不会改变**：EF 把自己替换进 DSH 自带的三个 preset，没有新东西要选。
`minimal` 保持原样。

### Verify the install

```bash
# 1. the composition actually happened — three rows, one per substituted preset
grep -c "name: dsh-epistemic-fold/plugin" cordis.patch.yml

# 2. the session runs EF — inside a session under standard/ptc/cordis
/context status

# 3. the browser got the build you made
#    (in the page console)
__DSH_BOOT__.entries.find(r => r.id === 'dsh-epistemic-fold').rev
```

The doctor's own success line is **not** printed on a healthy web boot — cordis's
logger buffers in memory and `dsh-app-boot` captures only warn/error. The three
surfaces above are what you actually check. See
[the deployment chain](docs/42_DEPLOYMENT_CHAIN.md) for the full matrix.

doctor 的成功日志在正常启动时**不会**打印（cordis logger 只缓冲在内存，
`dsh-app-boot` 仅捕获 warn/error）。上面三个表面才是实际要看的。

---

## Usage · 用法

### Modes

Three **tiers**, plus `legacy` (the engine's own default) and `basic` (stand
aside entirely) · 三档模式，另有 `legacy`（引擎默认）与 `basic`（完全让位）：

```yaml
- name: dsh-epistemic-fold
  config:
    bundleRoot: <profile persistence root>/epistemic-fold
    mode: economy     # economy | balanced | quality | legacy | basic
```

| mode | what it adds | evidence |
| --- | --- | --- |
| `economy` | — (default retention, no per-checkpoint LLM call) | **MEASURED** — RC1.3: parity with Basic at ~1/17 the cost |
| `balanced` | a larger verbatim tail (retention 0.16 → 0.24) | **HYPOTHESIS** — the RC2.1 A/B measured no gain |
| `quality` | + narrative checkpoints (`semanticMode: rationale`) | **HYPOTHESIS** — not measured |
| `legacy` | the engine's own default; no tier values applied | — |
| `basic` | nothing — folds delegate to a byte-identical Basic backend | — |

The ladder varies **one lever per rung** — retention first, then the semantic
face — with everything else held identical, so a difference between adjacent
rungs is attributable. Every tier is a named **set of values, not a branch**:
expansion happens before resolution, so the engine cannot tell a preset from the
same keys written by hand, and **an explicit setting always wins**.

阶梯每上一档只变动**一个**杠杆（先保留比例、再语义面）。每一档都是「一组具名
取值」而非分支，展开在解析之前完成，因此**显式设置始终覆盖 preset**。

`reliability` is deliberately **not** offered: there is no live evidence for what
the right reliability configuration is, and naming one would assert a conclusion
the project does not have. `reliability` 暂不提供：尚无实测证据，命名它等于断言
一个项目尚未得到的结论。

The tier is chosen with `/context mode economy|balanced|quality` — not with a
preset, because a preset is picked before a session starts and DSH refuses to
recompose a running one · 档位用 `/context mode` 选择，而不是用 preset——preset
在会话开始前就要选定，而 DSH 拒绝重组运行中的会话。

### The `frameCheckpoint` seam

`framingMode: system-dedup` (which every tier selects) needs a `frameCheckpoint`
hook on the compaction engine. **EF carries that seam in its own vendored copy of
the Basic backend** (`src/basic/`), so it mounts on **any** DSH build and needs
no patch script. If the vendored copy is ever damaged, the engine **refuses to
start** rather than silently running the costlier per-checkpoint framing — which
would report an economy saving the deployment does not get.

`system-dedup` 需要 compaction 引擎上的 `frameCheckpoint` hook。**EF 把这个
seam 内联进自己 vendor 的 Basic 副本**（`src/basic/`），因此在**任何** DSH 构建上
都能挂载，无需打补丁脚本。若该副本损坏，引擎**拒绝启动**，而不是静默退回更贵的
per-checkpoint framing。

### The Sidebar panel

EF ships a Sidebar **observation** panel (`client.js`). It reads the same status
model `/context status` renders rather than parsing the command's text, shows the
context's proportion and the provider's cache-hit share, and renders `—` for any
figure it cannot establish — never a zero. It reads a client-side projection, so
it **cannot enter the model context** by construction.

EF 附带侧边栏**观测**面板，读取与 `/context status` 同一套状态模型，显示上下文
占比与缓存命中率，无法确立的数值显示 `—`。它读取客户端投影，**结构上不可能进入
模型上下文**。

It reaches **both** right sidebars, which keep separate tab registries. The two
halves are **not** symmetric: better-sidebar is the optional idiom, and the
native registration is a **fallback**, because better-sidebar bridges its own
tabs *into* the native registry — registering both unconditionally showed two
identical entries ([docs/43](docs/43_RC17_SIDEBAR_ENTRY_DEDUPE.md)).

它同时接入两套右侧边栏，两者**并不对称**：better-sidebar 走可选惯用法，原生一侧
是**回退**——better-sidebar 会把自己的 tab 桥接进原生注册表，无条件双注册会出现
两条一模一样的条目。

### Standing aside

Set `mode: basic` to get native Basic back without uninstalling. EF then
delegates folds to a byte-identical Basic backend and registers **no** EF surface
at all — no projection, no panel, no `/context`, no recall tools. This is a
supported configuration, not a degraded one.

设 `mode: basic` 即可在不卸载的情况下拿回原生 Basic。EF 完全让位且不注册任何 EF
表面。这是受支持的配置，不是降级。

---

## Status · 状态

**What is measured, and what is not.** EF's discipline is that a claim carries
its evidence status, and this file follows the same rule.

**已测量的与未测量的。** EF 的纪律是每个主张都标注证据状态，本文件同样如此。

| area | status |
| --- | --- |
| Exact archive / recall closure, bundle store, deterministic state | ✅ **MEASURED** — M0/M2/M3a gates closed |
| Fold Frontier, leaf/root folds, prefix stability | ✅ **MEASURED** |
| `economy` tier cost parity | ✅ **MEASURED** — RC1.3: parity with Basic at ~1/17 cost, reproduced |
| Recall quality | ✅ **MEASURED** — 3.00/3 n=9, matching Basic |
| Real DSH pluginization, presets, `mode: basic` | ✅ **VERIFIED** in a real host |
| Sidebar panel (both sidebars) | ✅ **VERIFIED** in a real browser |
| Route-level realized cost gate | ⚠️ **OPEN** — dispersion at n=8; must not drive the architecture |
| `balanced` / `quality` steadiness benefit | ⚠️ **HYPOTHESIS** — the RC2.1 A/B measured no gain |
| Live behavioral tier (opt-in, `EF_LIVE=1`) | ⚠️ **NULL RESULT** — the task sample did not discriminate the modes |
| External benchmarks (τ²-Bench, LHTB) | ⚠️ **PARTIAL** — integrated; see docs 33–36 |

**Frozen stages** — closed, not to be re-litigated without new incident
evidence: `M1`, `M3b`, `M4`, `M5`, `RecallPrune` (deferred by evidence);
`DeltaLeaf` (**rejected** on measured ROI, R1-B).

**已冻结阶段**——已关闭，除非有新的故障证据否则不再讨论。

Only one question remains open, and it is a **pricing** question that must not
drive the architecture: the route-level realized cost gate.

仅剩一个未决问题，且它属于**定价**问题，不得反向驱动架构。

---

## Development · 开发方式

This repository is a standalone plugin source tree. Tests run the vendored DSH
**sources** directly (the same source-level resolution the DSH monorepo uses), so
no build of the plugin itself is needed to test it.

本仓库是独立的插件源码树。测试直接运行 vendor 的 DSH **源码**，插件本身无需构建
即可测试。

Prerequisites: Node `^22.19 || >=24`, pnpm `11.7.x`, npm.

```bash
# 1. Vendor the DSH monorepo at the verified baseline
git clone https://github.com/deepseek-ai/deepseek-harness.git vendor/deepseek-harness
cd vendor/deepseek-harness
git checkout 477b4f420553e8a52c2fbccc464d7561b239c443
pnpm install

# 2. Build declaration output for the packages EF consumes
node --max-old-space-size=8192 ./node_modules/typescript/bin/tsc -b \
  packages/compaction/compaction-basic packages/core/tools packages/util/atomic-write

# 3. Back in the plugin repo: install tooling and regenerate the resolution maps
cd ../..
npm install
node scripts/generate-maps.cjs

# 4. Run everything
npx vitest run                      # the whole suite
npm run typecheck:all               # src/ AND the browser client face
```

**Two typecheck projects, on purpose.** `tsconfig.json` covers `src/` and `tests/`
under full `strict`. `tsconfig.client.json` covers `client.js` — the browser face
— which cannot join the first project because it `require`s React from the host
loader rather than depending on it. Both run in CI.

**两个类型检查项目是刻意的**：`client.js` 从宿主 loader 借用 React，不能进入
主项目的依赖图，所以它有独立项目。两者都在 CI 里跑。

The suite grows every stage, so this file deliberately does **not** state a test
count: a hardcoded number goes stale the moment a spec is added, and a stale
count is read as an unfinished suite. `vitest run` prints the authoritative
totals. The live tier is opt-in (`EF_LIVE=1`) and **skips** without a resolved
route, so an unmeasured behavior is never reported as a passing one.

本文件刻意不写死测试数量：写死的数字一经添加新用例即过期。Live 层为可选，没有可用
路由时**跳过**，绝不把「未测量」报成「通过」。

### CI

Two lanes on every push · 每次推送跑两条 lane：

- **pinned DSH baseline** (`477b4f42…`, the `0.1.7-rc.2` release) — mandatory.
- **DSH master** — an allowed-to-fail compatibility probe.

Both run the typechecks, the full suite, and the keyless evaluation tiers.

> **On version numbers.** `0.1.7-rc.2` in this repository is the **test baseline
> CI pins**, not a claim about what you have installed. EF's `engines.dsh` and
> peer ranges are `>=0.1.7-rc.2`, and it is verified running on `0.2.0-rc.2`.
>
> 本仓库中的 `0.1.7-rc.2` 是 **CI 固定的测试基线**，不是对你本机版本的断言。

---

## Repository layout · 仓库结构

```
src/
  engine.ts             EpistemicFoldEngine — Basic's transaction + EF compile hook
  policy.ts             plugin config resolution + routed-model pressure math
  policy-compiler.ts    amortized rebase policy: break-even horizon, hard overrides
  economics-profile.ts  versioned cost model: ρ, ρ_eff, cache realization, break-even
  candidate.ts          pending fold-candidate identity (single slot per session)
  bundle-store.ts       FileBundleStore — atomic, hash-verified, 0600 permissions
  compiler.ts           input splitting, canonical bundle build, checkpoint rendering
  frontier.ts           Fold Frontier: locate/re-derive from the CURRENT surface
  leaf-policy.ts        [frontier+1, bestEnd] span selection + frozen budget load
  root-policy.ts        root rebase advisories (manual /compact = Root Fold)
  state.ts              deterministic StateReducer: anchors, supersession, lifecycles
  authority.ts          which event kinds may ground which authority domains
  anchor-service.ts     the authority-gated anchor write channel (ctx.epistemicFold)
  projection.ts         wires the reducer into ctx.sessionProjections
  renderer.ts           structured checkpoint: Current/Evidence/Open/Rationale/Recall
  recall.ts             context_search + context_recall (bounded, paginated, exact)
  tools.ts              registers the recall tools against ctx.tools
  hash.ts               canonical JSON + SHA-256 digests
  checkpoint-marker.ts  the EF1 marker protocol inside checkpoint bodies
  pressure.ts           frozen/open pressure attribution
  trigger.ts            trigger-breakdown reporting
  rebase-intent.ts      rebase-intent registry
  idle-rebase.ts        idle-time rebase consumer
  effective-config.ts   resolved-config reporting
  preset.ts             the tier ladder and its evidence status
  status.ts             /context status model (pure function over caller data)
  status-projection.ts  the client-facing status projection (the Sidebar's source)
  command.ts            the /context command plane
  plugin.ts             the composite plugin: owns ctx.compaction, wires the above
  entry.ts              the bare-name entry (mounts the DOCTOR, not the plugin)
  doctor.ts             always-mounted substitution doctor (observation only)
  preset-self-check.ts  turns a missed preset substitution into a loud error
  compat.ts             frameCheckpoint seam detection + fail-loud assertion
  basic/                vendored copy of DSH's Basic backend, with the seam inlined
  index.ts, types.ts    library face and shared types
client.js               the browser Sidebar panel (hand-written, no bundler)
eval/                   evaluation harness: workloads, ROI lab, Pareto, paired runner
profiles/economics/     versioned provider pricing (asOf + source)
tests/                  the suite, plus the shared harness with a controlled LLM adapter
bench/                  paired-baseline harness (Basic vs EF prefix economics)
scripts/                build, preset generation, vendoring, seam application, preflight
docs/                   design records and evaluation reports (see below)
```

---

## Documentation · 文档

`docs/` holds **49 documents**. They are of three kinds, and the distinction
matters when reading them: a **design record** states intent, an **evaluation
report** states what was measured, and a **defect record** states what went
wrong and what the correction was. Where a later document falsified an earlier
conclusion, the earlier document says so in place rather than being rewritten —
the audit trail is the point.

`docs/` 有 **49 份文档**，分三类：设计记录陈述意图，评测报告陈述实测结果，缺陷
记录陈述错在哪、如何更正。后文推翻前文结论时，前文**原地标注**而非被改写——
审计链本身就是要保留的东西。

### Project entry & architecture

| Document | Contents |
|---|---|
| [00_README_EF.md](docs/00_README_EF.md) | Project entry: naming, goals, the nine core invariants, glossary |
| [01_EF_RFC_001_ARCHITECTURE.md](docs/01_EF_RFC_001_ARCHITECTURE.md) | Architecture spec: truth model, data structures, fold transactions |
| [02_EF_IMPLEMENTATION_PLAN_M0_M3.md](docs/02_EF_IMPLEMENTATION_PLAN_M0_M3.md) | Engineering DAG, gates, stop conditions |
| [03_EF_TEST_BENCHMARK_SPEC.md](docs/03_EF_TEST_BENCHMARK_SPEC.md) | Metrics (ALR/SSR/DWR/CR/PMA), test suites, benchmark arms |
| [04_EF_LOCAL_AGENT_WORK_ORDER.md](docs/04_EF_LOCAL_AGENT_WORK_ORDER.md) | Execution order and prohibitions for an implementation agent |
| [05_EF_DECISIONS_AND_OPEN_QUESTIONS.md](docs/05_EF_DECISIONS_AND_OPEN_QUESTIONS.md) | Frozen decisions, hypotheses, open questions |
| [06_FINAL_REPORT.md](docs/06_FINAL_REPORT.md) | Final M0/M2/M3a implementation report: gates, evidence, deviations |

### Evaluation

| Document | Contents |
|---|---|
| [07_R0C_EVALUATION_REPORT.md](docs/07_R0C_EVALUATION_REPORT.md) | R0-C evaluation: measurement integrity, corpus, paired continuation, long-horizon economics |
| [07_R0C_EVALUATION_CLOSURE.md](docs/07_R0C_EVALUATION_CLOSURE.md) | R0-C closure record |
| [08_BOUNDARY_CORPUS_PROTOCOL.md](docs/08_BOUNDARY_CORPUS_PROTOCOL.md) | Boundary corpus protocol: sidecar format, oracle union, action signatures |
| [09_EVALUATION_METRICS_SPEC.md](docs/09_EVALUATION_METRICS_SPEC.md) | Exact metric definitions (SPN/SPT/IST/PMA/DWR/CR/ρ) |
| [10_LOCAL_AGENT_WORK_ORDER_R0C.md](docs/10_LOCAL_AGENT_WORK_ORDER_R0C.md) | R0-C execution work order |
| [11_R1B_ROUTE_SELECTION_GATE.md](docs/11_R1B_ROUTE_SELECTION_GATE.md) | R1-B route-selection gate: measured ROI per candidate, and the rejection of production Delta Leaf |
| [12_R1_EVALUATION_REPORT.md](docs/12_R1_EVALUATION_REPORT.md) | R1 report (**generated** by `npm run eval:r1-report`): attribution, regime sensitivity, ROI bounds, policy, Pareto |
| [13_R1_LIVE_BEHAVIORAL_RESULTS.md](docs/13_R1_LIVE_BEHAVIORAL_RESULTS.md) | Live behavioral subset: the null result, measured cache realization, and the bug it found |
| [14_R2_EVALUATION_REPORT.md](docs/14_R2_EVALUATION_REPORT.md) | R2 price-dominance report: BCR 1.276 → 1.149, why the objective was not reached |
| [15_R2_FRAMING_CEILING.md](docs/15_R2_FRAMING_CEILING.md) | R2 framing-ceiling analysis: the repeated preamble is the dominant checkpoint cost |
| [16_R3_EVALUATION_REPORT.md](docs/16_R3_EVALUATION_REPORT.md) | R3 frozen-surface economy closure: pricing correctness, idle rebase, framing seam |
| [17_R4_EVALUATION_REPORT.md](docs/17_R4_EVALUATION_REPORT.md) | R4 economy default closure: real-recall workload, realized billing, window safety, presets |

### Release hardening (RC0–RC2.1)

| Document | Contents |
|---|---|
| [18_RC0_RELEASE_HARDENING.md](docs/18_RC0_RELEASE_HARDENING.md) | RC0: the configuration contract, pairwise non-inferiority, the all-call billing recorder, and the dispersion that keeps the cost gate open |
| [19_RC1_POLICY_NORMALIZATION.md](docs/19_RC1_POLICY_NORMALIZATION.md) | RC1: trigger breakdown, measured safety reserve, replay simulator, cache microbench, certified economy profile |
| [20_RC1_1_EVIDENCE_RECONCILIATION.md](docs/20_RC1_1_EVIDENCE_RECONCILIATION.md) | RC1.1: component-wise certification, the reserve as a scoped estimate, both replay confounds removed, the withdrawn RC1-H conclusion |
| [21_RC1_2_RECALL_CLOSURE.md](docs/21_RC1_2_RECALL_CLOSURE.md) | RC1.2: the real agent-loop recall smoke, the deterministic mechanism proof, the rationale tax at its measured size |
| [22_RC1_3_RETRIEVAL_ERGONOMICS.md](docs/22_RC1_3_RETRIEVAL_ERGONOMICS.md) | RC1.3: the un-hinted baseline, per-fact failure taxonomy, the self-describing search hit, and the rule that brought economy to parity |
| [23_RC1_3_1_TEMPORAL_RETRIEVAL_GUARD.md](docs/23_RC1_3_1_TEMPORAL_RETRIEVAL_GUARD.md) | RC1.3.1: newest-first chronology from source spans, latest-match supersession, `matchedMessageIndex` — freezes the retrieval layer |
| [24_RC2_PRODUCT_INTEGRATION.md](docs/24_RC2_PRODUCT_INTEGRATION.md) | RC2: the three-tier ladder with declared evidence status, `/context status` on the real command plane, and why the real-task comparison did not discriminate |
| [25_RC2_1_STATUS_AND_RETENTION_AB.md](docs/25_RC2_1_STATUS_AND_RETENTION_AB.md) | RC2.1: four `/context status` defects, the EF-legacy-vs-Basic baseline correction, the retention-first reorder, and the A/B that measured no steadiness gain |

### Product integration (RC3–RC7)

| Document | Contents |
|---|---|
| [26_RC3_REAL_DSH_PLUGINIZATION.md](docs/26_RC3_REAL_DSH_PLUGINIZATION.md) | RC3: the build step, the bundle patch, the `ctx.inject` bug only a real host could find, and the correction of RC2's "in DSH" claim |
| [27_RC4_SIDEBAR_PANEL.md](docs/27_RC4_SIDEBAR_PANEL.md) | RC4: the command/observation split over one shared status model, and the hand-written client bundle |
| [28_RC4A_INTERACTION_AUDIT.md](docs/28_RC4A_INTERACTION_AUDIT.md) | RC4-A: the command surface exercised case by case, the web-profile `isolate` finding, the failure-as-success defect |
| [29_RC5_PRESET_DESIGN.md](docs/29_RC5_PRESET_DESIGN.md) | RC5: EF as its own preset — why declaring beats overriding, the exact substitution, the restatement cost |
| [30_RC6_PRIOR_ART_SURVEY.md](docs/30_RC6_PRIOR_ART_SURVEY.md) | RC6: how other DSH context/compaction plugins actually work |
| [31_RC7_TRANSFORMATION_PLAN.md](docs/31_RC7_TRANSFORMATION_PLAN.md) | RC7: in-place substitution + the vendored Basic copy; why that shape and not the alternatives |
| [32_RC7D_PARALLEL_LONG_TASK_TESTING.md](docs/32_RC7D_PARALLEL_LONG_TASK_TESTING.md) | RC7-D: parallel long-task testing |

### External benchmarks (RC8–RC10)

| Document | Contents |
|---|---|
| [33_RC8_EXTERNAL_BENCHMARKS.md](docs/33_RC8_EXTERNAL_BENCHMARKS.md) | RC8: external benchmark integration — what is real and what is blocked |
| [34_RC9_TAU2_INTEGRATION.md](docs/34_RC9_TAU2_INTEGRATION.md) | RC9: τ²-Bench-Verified integration (the Interaction-State lane) |
| [35_RC10_LHTB_INTEGRATION.md](docs/35_RC10_LHTB_INTEGRATION.md) | RC10: LHTB integration (the LongWork lane) |
| [36_RC10_SESSION_PAUSE.md](docs/36_RC10_SESSION_PAUSE.md) | RC10: session state, paused |

### Interaction surface (RC11–RC21)

| Document | Contents |
|---|---|
| [37_RC11_BROWSER_VERIFICATION.md](docs/37_RC11_BROWSER_VERIFICATION.md) | RC11: real-browser verification of the interaction surface |
| [38_RC12_PRESET_BACKEND_DOCTOR_DEFECT.md](docs/38_RC12_PRESET_BACKEND_DOCTOR_DEFECT.md) | RC12: the preset backend mounted the **doctor** — every session silently ran Basic |
| [39_RC13_SIDEBAR_PANEL_RENDER_DEFECT.md](docs/39_RC13_SIDEBAR_PANEL_RENDER_DEFECT.md) | RC13: the panel called a hook the sidebar never passes |
| [40_RC14_DUAL_SIDEBAR_ADAPTER.md](docs/40_RC14_DUAL_SIDEBAR_ADAPTER.md) | RC14: dual sidebar adaptation — and the falsified "the type registers, the body does not" trace |
| [41_RC15_NATIVE_SIDEBAR_RENDERS.md](docs/41_RC15_NATIVE_SIDEBAR_RENDERS.md) | RC15: the native panel renders — a thunked `description`, and `inject: ['slots']` |
| [42_DEPLOYMENT_CHAIN.md](docs/42_DEPLOYMENT_CHAIN.md) | **The deployment chain: GitHub to a running DSH** — the operational document |
| [43_RC17_SIDEBAR_ENTRY_DEDUPE.md](docs/43_RC17_SIDEBAR_ENTRY_DEDUPE.md) | RC17: one guide entry, not two — and the recursion the fix's own test found |
| [44_RC18_HONEST_PRICING.md](docs/44_RC18_HONEST_PRICING.md) | RC18: the panel priced every session with the wrong rate card |
| [45_RC19_PANEL_READABILITY.md](docs/45_RC19_PANEL_READABILITY.md) | RC19: making the panel readable — units, proportion, cache-hit share, locale |
| [46_RC20_ARCHIVED_ITEM_COUNT.md](docs/46_RC20_ARCHIVED_ITEM_COUNT.md) | RC20: the archived-item count was reachable all along |
| [47_RC21_CLIENT_TYPECHECK_AND_CONTRACT.md](docs/47_RC21_CLIENT_TYPECHECK_AND_CONTRACT.md) | RC21: typechecking the client face, and pinning its contract with the host |

**Start here if you are new:** [00](docs/00_README_EF.md) for the model,
[42](docs/42_DEPLOYMENT_CHAIN.md) to install and operate it, and
[47](docs/47_RC21_CLIENT_TYPECHECK_AND_CONTRACT.md) for how the recent work is
verified.

**新读者从这里开始**：[00](docs/00_README_EF.md) 看模型，
[42](docs/42_DEPLOYMENT_CHAIN.md) 看安装与运维，
[47](docs/47_RC21_CLIENT_TYPECHECK_AND_CONTRACT.md) 看近期工作如何被验证。

---

## License · 许可证

[MIT](LICENSE)

`src/basic/` is vendored from DeepSeek Harness (MIT) with the `frameCheckpoint`
seam inlined. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
