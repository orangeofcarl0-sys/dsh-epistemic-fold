# Epistemic Fold

[![CI](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/actions/workflows/ci.yml/badge.svg)](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/orangeofcarl0-sys/dsh-epistemic-fold?sort=semver)](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.1.7--rc.2-4b5563.svg)](#ci)
[![docs](https://img.shields.io/badge/docs-49%20documents-4b5563.svg)](docs/)

> **Epistemic Fold for DeepSeek Harness**
> *面向长周期 Agent 的、保持契约的上下文运行时。*

[English](README.md)

## 这是什么？

Epistemic Fold (EF) 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
的一个 compaction backend 插件。它把会话历史、记忆与工作上下文当作三件不同的事：

```
历史 ≠ 记忆 ≠ 上下文
```

核心命题：

> **只有当一段轨迹对未来仍有意义的知识效应已经被稳定对象吸收、关键状态与边界
> 得到保留、且原始证据可以恢复时，该轨迹才有资格被折叠出工作上下文。**

具体来说，运行时折叠一段会话时会：

1. **先归档精确的模型可见消息**到不可变、哈希校验的 `CheckpointBundle`，在任何
   有损 surface 替换提交之前（`BundleDurable ≺ SurfaceLoss`）；
2. **绝不重折叠已冻结的内容** —— 单调前进的 *Fold Frontier* 分隔冻结 checkpoint
   与开放轨迹，缓存的 prefix 在多次折叠间逐字节稳定；
3. **当前状态由原始 session 事件确定性派生** —— objective、constraint、decision、
   value、evidence、failure、obligation，全部携带完整 provenance；并且有一条硬
   规则：语义摘要永远不能验证状态（`Raw Events → State` 与
   `Raw Events → Summary` 并行；`Raw → Summary → State` 被禁止）；
4. **精确恢复** —— `context_search` / `context_recall` 对任何离开工作集的内容提供
   有界、分页、经 provenance 校验的召回。

优化目标不是最大压缩率，而是 correctness first —— 在硬正确性约束下提高信息密度、
prefix cache 局部性、长期状态一致性与闭环延续稳定性。

---

## 安装

EF 是真正的 DSH 插件：构建为可加载 JS，并附带把自己替换进 DSH 自带 preset 的
bundle patch。

| 通道 | 写法 | 是否固定版本 | 会跑构建吗 | 需要什么 |
| --- | --- | --- | --- | --- |
| **tarball**（推荐） | [Releases](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/releases) 里的 `.tgz` | **是** | 不会 | 什么都不需要，`lib/` 已预构建 |
| **git，固定 tag** | `github:orangeofcarl0-sys/dsh-epistemic-fold#v0.1.0` | **是** | 会 | 一行 `allowBuilds`，dsh 会替你打印出来 |
| **git，跟随 main** | `github:orangeofcarl0-sys/dsh-epistemic-fold` | 否 | 会 | 同一行，但每次推送都会跟随 |
| **path** | `file:/path/to/dsh-epistemic-fold` | 不适用 | 不会 | 先在源码树里跑 `npm install` |
| **registry** | `dsh-epistemic-fold` | 不适用 | 不适用 | 不可用——包是 `private` 且未发布 |

> **Release 不是安装通道，只有它的附件是。** 实测：`dsh plugin` 从不查询 GitHub
> Releases API。它把 spec 交给 pnpm，由 pnpm 把 git spec 解析成
> **commit tarball**（来自 `codeload.github.com`）。`github:owner/repo` 解析为
> 默认分支的最新提交；只有显式写 `#<tag 或 commit>` 才真正固定版本。所以裸 git
> spec 会跟随 `main` 的每一次推送，包括尚未发布的提交。

### 从 release tarball 安装（推荐）

```bash
dsh plugin --profile <name> add file:/path/to/dsh-epistemic-fold-0.1.0.tgz
```

tarball 里已含构建好的 `lib/`，所以不会跑 `prepare`，也不需要 `allowBuilds`，
拿到的就是 release notes 描述的那份代码。

### 从 git 安装，固定到某个 tag

```bash
dsh plugin --profile <name> add github:orangeofcarl0-sys/dsh-epistemic-fold#v0.1.0
```

首次运行会以 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 停止。这是 pnpm 拦截构建
脚本，不是缺陷：**dsh 会打印出要粘贴到 profile `pnpm-workspace.yaml` 的
`allowBuilds` 行**。加上后重跑即可；安装过程会在 `prepare` 里构建 `lib/` 并生成
preset 替换行。

`allowBuilds` 的键里嵌的是解析后的 commit，所以固定 tag 同时也固定了这条允许项。

### 从 git 安装，跟随 `main`

去掉 `#v0.1.0` 即跟随默认分支。想要未发布的工作就用这个——但如果你想要的是
release notes 描述的那份，这就是错的选择，因为一旦有新提交落地，两者就分叉了。

### 从本地检出安装

```bash
cd /path/to/dsh-epistemic-fold
npm install          # 构建 lib/ —— file: 通道不会替你构建
npm run preflight    # 校验这棵树是否可安装
```

然后把它作为 `file:` 依赖加入。**`file:` 通道不会跑构建** —— 实测 pnpm 对路径
依赖跳过 `prepare`。不先 `npm install`，装入的就是一个 `main`（`lib/entry.js`）
指向不存在文件的目录，loader 会为一个**本身就是安装 doctor** 的条目报告
`failed to import`。`npm run preflight` 会在安装前拦住这种情况。

### 配置 profile

```jsonc
// <DSH_HOME>/profiles/<name>/package.json
{
  "dependencies": { "dsh-epistemic-fold": "file:/path/to/dsh-epistemic-fold" },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-epistemic-fold"        // ← 必须排在 dsh-web-app 之后
      ]
    }
  }
}
```

然后在 profile 目录执行 `pnpm install`，用 `dsh --profile <name>` 启动。

**bundle 顺序是正确性要求。** 替换 patch 覆盖的是 `@deepseek-ai/dsh-web-app`
声明的行；排在它前面，patch 什么也找不到——EF 自带的 doctor 会大声报告，而不是
静默把你留在原生 Basic 上。

**preset 菜单不会改变。** EF 把自己替换进 DSH 自带的 `standard`、`ptc`、
`cordis` 三个 preset，因此没有新东西要选。`minimal` 保持 DSH 原样——它本身不声明
compaction 组，没有可替换的东西。

### 验证安装

```bash
# 1. 替换确实发生了 —— 三行，每个被替换的 preset 一行
grep -c "name: dsh-epistemic-fold/plugin" cordis.patch.yml

# 2. 会话真的在跑 EF —— 在 standard/ptc/cordis 下的会话里
/context status

# 3. 浏览器拿到的是你构建的那份
#    （在页面控制台）
__DSH_BOOT__.entries.find(r => r.id === 'dsh-epistemic-fold').rev
```

doctor 的成功日志在正常 web 启动时**不会**打印——cordis 的 logger 只缓冲在内存，
而 `dsh-app-boot` 只捕获 warn/error。上面三个表面才是实际要看的。完整矩阵见
[部署链路](docs/42_DEPLOYMENT_CHAIN.md)。

---

## 使用

### 模式

三档模式，另有 `legacy`（引擎自身默认值）与 `basic`（完全让位）：

```yaml
- name: dsh-epistemic-fold
  config:
    bundleRoot: <profile 持久化根目录>/epistemic-fold
    mode: economy     # economy | balanced | quality | legacy | basic
```

| 模式 | 它增加了什么 | 证据状态 |
| --- | --- | --- |
| `economy` | —（默认保留量，无 per-checkpoint LLM 调用） | **MEASURED** —— RC1.3：与 Basic 质量持平，成本约 1/17 |
| `balanced` | 更大的逐字保留尾部（保留比例 0.16 → 0.24） | **HYPOTHESIS** —— RC2.1 的 A/B 未测出收益 |
| `quality` | 外加叙述性 checkpoint（`semanticMode: rationale`） | **HYPOTHESIS** —— 未测量 |
| `legacy` | 引擎自身默认值；不套用任何档位取值 | — |
| `basic` | 不增加任何东西——fold 委派给逐字节一致的 Basic 后端 | — |

阶梯每上一档只变动**一个**杠杆——先保留比例、再语义面——其余保持不变，因此相邻
两档之间的差异是可归因的。每一档都是「一组具名取值」而非分支：展开在解析之前
完成，因此引擎无法区分 preset 与手写配置，且**显式设置始终覆盖 preset**。

`reliability` 刻意**不提供**：尚无实测证据确定最优 reliability 配置，命名它等于
断言一个项目尚未得到的结论。

档位用 `/context mode economy|balanced|quality` 选择，而不是用 preset——因为
preset 在会话开始前就要选定，而 DSH 拒绝重组运行中的会话。

### `frameCheckpoint` seam

`framingMode: system-dedup`（每一档都选用它）需要 compaction 引擎上的
`frameCheckpoint` hook。**EF 把这个 seam 内联进自己 vendor 的 Basic 副本**
（`src/basic/`），因此在**任何** DSH 构建上都能挂载，无需打补丁脚本。若该副本
损坏，引擎**拒绝启动**，而不是静默退回更贵的 per-checkpoint framing——那会报告
一个该部署实际并未获得的节省。

### 侧边栏面板

EF 附带一个侧边栏**观测**面板（`client.js`）。它读取与 `/context status` 同一套
状态模型，而不是解析命令的输出文本；显示上下文占比与供应商侧的缓存命中率；无法
确立的数值显示 `—`，绝不为 0。它读取客户端投影，因此**结构上不可能进入模型
上下文**。

它同时接入**两套**右侧边栏，而两者各自维护 tab 注册表。这两半**并不对称**：
better-sidebar 走可选惯用法，原生一侧是**回退**——因为 better-sidebar 会把自己的
tab 桥接进原生注册表，无条件双注册会让用户看到两条一模一样的条目
（[docs/43](docs/43_RC17_SIDEBAR_ENTRY_DEDUPE.md)）。

### 完全让位

设 `mode: basic` 即可在不卸载的情况下拿回原生 Basic。EF 会把 fold 委派给逐字节
一致的 Basic 后端，且**不注册任何** EF 表面——没有投影、没有面板、没有
`/context`、没有召回工具。这是受支持的配置，不是降级。

---

## 状态

**哪些是已测量的，哪些不是。** EF 的纪律是每个主张都标注证据状态，本文件同样
如此。

| 领域 | 状态 |
| --- | --- |
| 精确归档/召回闭环、bundle store、确定性状态 | ✅ **MEASURED** —— M0/M2/M3a 各 Gate 已闭合 |
| Fold Frontier、leaf/root 折叠、prefix 稳定性 | ✅ **MEASURED** |
| `economy` 档成本持平 | ✅ **MEASURED** —— RC1.3：与 Basic 持平且成本约 1/17，已复现 |
| 召回质量 | ✅ **MEASURED** —— 3.00/3，n=9，与 Basic 持平 |
| 真实 DSH 插件化、presets、`mode: basic` | ✅ **VERIFIED** —— 在真实宿主中 |
| 侧边栏面板（两套边栏） | ✅ **VERIFIED** —— 在真实浏览器中 |
| 路由级实测成本门 | ⚠️ **OPEN** —— n=8 时离散度不足；不得反向驱动架构 |
| `balanced` / `quality` 稳定性收益 | ⚠️ **HYPOTHESIS** —— RC2.1 的 A/B 未测出收益 |
| Live 行为层（可选，`EF_LIVE=1`） | ⚠️ **NULL RESULT** —— 任务样本未能区分各模式 |
| 外部基准（τ²-Bench、LHTB） | ⚠️ **PARTIAL** —— 已接入；见 docs 33–36 |

**已冻结阶段**——已关闭，除非有新的故障证据否则不再讨论：`M1`、`M3b`、`M4`、
`M5`、`RecallPrune`（因证据不足而搁置）；`DeltaLeaf`（**已否决**，依据 R1-B 实测
ROI）。

仅剩一个未决问题，且它属于**定价**问题，不得反向驱动架构：路由级实测成本门。

---

## 开发方式

本仓库是独立的插件源码树。测试直接运行 vendor 的 DSH **源码**（与 DSH monorepo
相同的源码级解析方式），因此插件本身无需构建即可测试。

前置要求：Node `^22.19 || >=24`、pnpm `11.7.x`、npm。

```bash
# 1. 在核验基线上 vendor DSH monorepo
git clone https://github.com/deepseek-ai/deepseek-harness.git vendor/deepseek-harness
cd vendor/deepseek-harness
git checkout 477b4f420553e8a52c2fbccc464d7561b239c443
pnpm install

# 2. 构建 EF 所消费包的声明输出
node --max-old-space-size=8192 ./node_modules/typescript/bin/tsc -b \
  packages/compaction/compaction-basic packages/core/tools packages/util/atomic-write

# 3. 回到插件仓库：安装工具链并重新生成解析表
cd ../..
npm install
node scripts/generate-maps.cjs

# 4. 全量运行
npx vitest run                      # 全量测试套件
npm run typecheck:all               # src/ 与浏览器客户端面
```

**两个类型检查项目是刻意的。** `tsconfig.json` 以完整 `strict` 覆盖 `src/` 与
`tests/`；`tsconfig.client.json` 覆盖 `client.js`（浏览器面）——后者无法进入前者的
依赖图，因为它从宿主 loader 借用 React 而非依赖它。两者都在 CI 里跑。

本文件刻意**不写死**测试数量：写死的数字一经添加新用例即过期，而过期的数字会被
误读为套件不完整。权威数字以 `vitest run` 的输出为准。Live 层为可选
（`EF_LIVE=1`），没有可用路由时**跳过**，绝不把「未测量」报成「通过」。

### CI

每次推送跑两条 lane：

- **pinned DSH 基线**（`477b4f42…`，即 `0.1.7-rc.2` release）——必过。
- **DSH master**——allowed-to-fail 兼容性探测。

两条都跑类型检查、全量测试与 keyless 评测层。

> **关于版本号。** 本仓库中的 `0.1.7-rc.2` 是 **CI 固定的测试基线**，不是对你
> 本机已安装版本的断言。EF 的 `engines.dsh` 与 peer 范围是 `>=0.1.7-rc.2`，
> 并已在 `0.2.0-rc.2` 上验证运行。

---

## 仓库结构

```
src/
  engine.ts             EpistemicFoldEngine —— Basic 事务 + EF compile hook
  policy.ts             插件配置解析 + 路由模型的压力数学
  policy-compiler.ts    摊销式 rebase 策略：盈亏平衡视界、硬覆盖
  economics-profile.ts  版本化成本模型：ρ、ρ_eff、缓存实现率、盈亏平衡
  candidate.ts          待定 fold candidate 身份（每 session 单槽）
  bundle-store.ts       FileBundleStore —— 原子写、哈希校验、0600 权限
  compiler.ts           输入切分、canonical bundle 构建、checkpoint 渲染
  frontier.ts           Fold Frontier：从当前 surface 定位/重推导
  leaf-policy.ts        [frontier+1, bestEnd] span 选择 + 冻结预算加载
  root-policy.ts        root rebase 建议（手动 /compact = Root Fold）
  state.ts              确定性 StateReducer：anchors、supersession、生命周期
  authority.ts          哪些事件类型可以支撑哪些 authority 域
  anchor-service.ts     authority 门控的 anchor 写入通道（ctx.epistemicFold）
  projection.ts         把 reducer 接入 ctx.sessionProjections
  renderer.ts           结构化 checkpoint：Current/Evidence/Open/Rationale/Recall
  recall.ts             context_search + context_recall（有界、分页、精确）
  tools.ts              向 ctx.tools 注册召回工具
  hash.ts               canonical JSON + SHA-256 摘要
  checkpoint-marker.ts  checkpoint 体内的 EF1 标记协议
  pressure.ts           冻结/开放压力归因
  trigger.ts            trigger 拆解报告
  rebase-intent.ts      rebase intent 注册表
  idle-rebase.ts        空闲期 rebase 消费者
  effective-config.ts   解析后配置的报告
  preset.ts             档位阶梯及其证据状态
  status.ts             /context status 模型（对调用方数据的纯函数）
  status-projection.ts  面向客户端的投影（侧边栏的数据源）
  command.ts            /context 命令面
  plugin.ts             复合插件：持有 ctx.compaction，串联以上各件
  entry.ts              裸名入口（挂载 doctor，不是 plugin）
  doctor.ts             常驻的替换 doctor（纯观测）
  preset-self-check.ts  把漏掉的 preset 替换变成响亮的错误
  compat.ts             frameCheckpoint seam 探测 + 失败即大声报错
  basic/                vendor 的 DSH Basic 副本（内联 seam）
  index.ts, types.ts    库入口与共享类型
client.js               浏览器侧边栏面板（手写，无打包器）
eval/                   评测 harness：负载、ROI 实验台、Pareto、配对 runner
profiles/economics/     版本化供应商价格（含 asOf 与来源）
tests/                  测试套件，以及带受控 LLM adapter 的共享 harness
bench/                  配对基线 harness（Basic vs EF 的 prefix 经济性）
scripts/                构建、preset 生成、vendoring、seam 应用、preflight
docs/                   设计记录与评测报告（见下）
```

---

## 文档

`docs/` 有 **49 份文档**，分三类，读的时候这个区分很重要：**设计记录**陈述意图，
**评测报告**陈述实测结果，**缺陷记录**陈述错在哪、如何更正。后文推翻前文结论时，
前文**原地标注**而非被改写——审计链本身就是要保留的东西。

### 项目入口与架构

| 文档 | 内容 |
|---|---|
| [00_README_EF.md](docs/00_README_EF.md) | 项目入口：命名、目标、九条核心不变量、术语表 |
| [01_EF_RFC_001_ARCHITECTURE.md](docs/01_EF_RFC_001_ARCHITECTURE.md) | 架构规范：真相模型、数据结构、折叠事务 |
| [02_EF_IMPLEMENTATION_PLAN_M0_M3.md](docs/02_EF_IMPLEMENTATION_PLAN_M0_M3.md) | 工程 DAG、阶段 Gate、停止条件 |
| [03_EF_TEST_BENCHMARK_SPEC.md](docs/03_EF_TEST_BENCHMARK_SPEC.md) | 指标（ALR/SSR/DWR/CR/PMA）、测试套件、benchmark 分组 |
| [04_EF_LOCAL_AGENT_WORK_ORDER.md](docs/04_EF_LOCAL_AGENT_WORK_ORDER.md) | 实现 Agent 的执行顺序与禁令 |
| [05_EF_DECISIONS_AND_OPEN_QUESTIONS.md](docs/05_EF_DECISIONS_AND_OPEN_QUESTIONS.md) | 冻结决定、假设、开放问题 |
| [06_FINAL_REPORT.md](docs/06_FINAL_REPORT.md) | M0/M2/M3a 最终实现报告：Gate、证据、偏差 |

### 评测

| 文档 | 内容 |
|---|---|
| [07_R0C_EVALUATION_REPORT.md](docs/07_R0C_EVALUATION_REPORT.md) | R0-C 评测：测量完整性、语料、配对续跑、长程经济学 |
| [07_R0C_EVALUATION_CLOSURE.md](docs/07_R0C_EVALUATION_CLOSURE.md) | R0-C 闭合记录 |
| [08_BOUNDARY_CORPUS_PROTOCOL.md](docs/08_BOUNDARY_CORPUS_PROTOCOL.md) | 边界语料协议：sidecar 格式、oracle 并集、action 签名 |
| [09_EVALUATION_METRICS_SPEC.md](docs/09_EVALUATION_METRICS_SPEC.md) | 指标的精确定义（SPN/SPT/IST/PMA/DWR/CR/ρ） |
| [10_LOCAL_AGENT_WORK_ORDER_R0C.md](docs/10_LOCAL_AGENT_WORK_ORDER_R0C.md) | R0-C 执行工单 |
| [11_R1B_ROUTE_SELECTION_GATE.md](docs/11_R1B_ROUTE_SELECTION_GATE.md) | R1-B 路线选择 Gate：各候选实测 ROI，以及否决生产化 Delta Leaf |
| [12_R1_EVALUATION_REPORT.md](docs/12_R1_EVALUATION_REPORT.md) | R1 报告（由 `npm run eval:r1-report` **生成**）：归因、regime 敏感性、ROI 上界、策略、Pareto |
| [13_R1_LIVE_BEHAVIORAL_RESULTS.md](docs/13_R1_LIVE_BEHAVIORAL_RESULTS.md) | Live 行为子集：零结果、实测缓存实现率，以及它发现的缺陷 |
| [14_R2_EVALUATION_REPORT.md](docs/14_R2_EVALUATION_REPORT.md) | R2 价格支配报告：BCR 1.276 → 1.149，为何未达标 |
| [15_R2_FRAMING_CEILING.md](docs/15_R2_FRAMING_CEILING.md) | R2 framing 天花板分析：重复前导是 checkpoint 成本的主项 |
| [16_R3_EVALUATION_REPORT.md](docs/16_R3_EVALUATION_REPORT.md) | R3 冻结面经济闭合：定价正确性、空闲 rebase、framing seam |
| [17_R4_EVALUATION_REPORT.md](docs/17_R4_EVALUATION_REPORT.md) | R4 经济默认闭合：真实召回负载、实测计费、窗口安全、presets |

### 发布加固（RC0–RC2.1）

| 文档 | 内容 |
|---|---|
| [18_RC0_RELEASE_HARDENING.md](docs/18_RC0_RELEASE_HARDENING.md) | RC0：配置契约、成对非劣性、全调用计费记录器，以及让成本门保持开放的离散度 |
| [19_RC1_POLICY_NORMALIZATION.md](docs/19_RC1_POLICY_NORMALIZATION.md) | RC1：trigger 拆解、实测安全 reserve、重放模拟器、缓存微基准、认证经济档 |
| [20_RC1_1_EVIDENCE_RECONCILIATION.md](docs/20_RC1_1_EVIDENCE_RECONCILIATION.md) | RC1.1：逐组件认证、reserve 降级为限定范围的估计、两个重放 confound 移除、撤回 RC1-H 结论 |
| [21_RC1_2_RECALL_CLOSURE.md](docs/21_RC1_2_RECALL_CLOSURE.md) | RC1.2：真实 agent-loop 召回 smoke、确定性机制证明、rationale 税按其实测规模计价 |
| [22_RC1_3_RETRIEVAL_ERGONOMICS.md](docs/22_RC1_3_RETRIEVAL_ERGONOMICS.md) | RC1.3：无提示基线、逐事实失败分类、自描述搜索命中，以及把 economy 拉到持平的规则 |
| [23_RC1_3_1_TEMPORAL_RETRIEVAL_GUARD.md](docs/23_RC1_3_1_TEMPORAL_RETRIEVAL_GUARD.md) | RC1.3.1：以 source span 为准的由新到旧时序、latest-match supersession、`matchedMessageIndex`——冻结检索层 |
| [24_RC2_PRODUCT_INTEGRATION.md](docs/24_RC2_PRODUCT_INTEGRATION.md) | RC2：带证据状态标注的三档阶梯、真实命令面上的 `/context status`，以及为何真实任务对比未能区分各模式 |
| [25_RC2_1_STATUS_AND_RETENTION_AB.md](docs/25_RC2_1_STATUS_AND_RETENTION_AB.md) | RC2.1：四个 `/context status` 缺陷、EF-legacy-vs-Basic 基线更正、保留量优先的重排，以及未测出稳定性收益的 A/B |

### 产品集成（RC3–RC7）

| 文档 | 内容 |
|---|---|
| [26_RC3_REAL_DSH_PLUGINIZATION.md](docs/26_RC3_REAL_DSH_PLUGINIZATION.md) | RC3：构建步骤、bundle patch、只有真实宿主才能发现的 `ctx.inject` 缺陷，以及更正 RC2 的「在 DSH 中」说法 |
| [27_RC4_SIDEBAR_PANEL.md](docs/27_RC4_SIDEBAR_PANEL.md) | RC4：同一状态模型上的「命令=控制 / 侧边栏=观测」分工，以及手写客户端 bundle |
| [28_RC4A_INTERACTION_AUDIT.md](docs/28_RC4A_INTERACTION_AUDIT.md) | RC4-A：逐例走查命令面、web profile 的 `isolate` 发现、failure-as-success 缺陷 |
| [29_RC5_PRESET_DESIGN.md](docs/29_RC5_PRESET_DESIGN.md) | RC5：EF 独立 preset——为何声明优于覆盖、确切的替换、重述成本 |
| [30_RC6_PRIOR_ART_SURVEY.md](docs/30_RC6_PRIOR_ART_SURVEY.md) | RC6：其他 DSH context/compaction 插件实际是怎么做的 |
| [31_RC7_TRANSFORMATION_PLAN.md](docs/31_RC7_TRANSFORMATION_PLAN.md) | RC7：原地替换 + vendor 的 Basic 副本；为何是这个形态而非其他 |
| [32_RC7D_PARALLEL_LONG_TASK_TESTING.md](docs/32_RC7D_PARALLEL_LONG_TASK_TESTING.md) | RC7-D：并行长任务测试 |

### 外部基准（RC8–RC10）

| 文档 | 内容 |
|---|---|
| [33_RC8_EXTERNAL_BENCHMARKS.md](docs/33_RC8_EXTERNAL_BENCHMARKS.md) | RC8：外部基准接入——哪些是真的、哪些被阻塞 |
| [34_RC9_TAU2_INTEGRATION.md](docs/34_RC9_TAU2_INTEGRATION.md) | RC9：τ²-Bench-Verified 接入（Interaction-State 线） |
| [35_RC10_LHTB_INTEGRATION.md](docs/35_RC10_LHTB_INTEGRATION.md) | RC10：LHTB 接入（LongWork 线） |
| [36_RC10_SESSION_PAUSE.md](docs/36_RC10_SESSION_PAUSE.md) | RC10：会话状态，已暂停 |

### 交互表面（RC11–RC21）

| 文档 | 内容 |
|---|---|
| [37_RC11_BROWSER_VERIFICATION.md](docs/37_RC11_BROWSER_VERIFICATION.md) | RC11：交互表面的真实浏览器验证 |
| [38_RC12_PRESET_BACKEND_DOCTOR_DEFECT.md](docs/38_RC12_PRESET_BACKEND_DOCTOR_DEFECT.md) | RC12：preset 后端挂载了 **doctor**——每个会话都在静默跑 Basic |
| [39_RC13_SIDEBAR_PANEL_RENDER_DEFECT.md](docs/39_RC13_SIDEBAR_PANEL_RENDER_DEFECT.md) | RC13：面板调用了一个侧边栏从不传入的 hook |
| [40_RC14_DUAL_SIDEBAR_ADAPTER.md](docs/40_RC14_DUAL_SIDEBAR_ADAPTER.md) | RC14：双侧边栏适配——以及被证伪的「类型注册了、body 没有」追踪结论 |
| [41_RC15_NATIVE_SIDEBAR_RENDERS.md](docs/41_RC15_NATIVE_SIDEBAR_RENDERS.md) | RC15：原生面板渲染成功——thunk 化的 `description`，以及 `inject: ['slots']` |
| [42_DEPLOYMENT_CHAIN.md](docs/42_DEPLOYMENT_CHAIN.md) | **部署链路：从 GitHub 到运行中的 DSH**——运维文档 |
| [43_RC17_SIDEBAR_ENTRY_DEDUPE.md](docs/43_RC17_SIDEBAR_ENTRY_DEDUPE.md) | RC17：一条指南条目而非两条——以及修复自身的测试发现的无限递归 |
| [44_RC18_HONEST_PRICING.md](docs/44_RC18_HONEST_PRICING.md) | RC18：面板用错了价目表给每个会话计价 |
| [45_RC19_PANEL_READABILITY.md](docs/45_RC19_PANEL_READABILITY.md) | RC19：让面板可读——单位、占比、缓存命中率、语言 |
| [46_RC20_ARCHIVED_ITEM_COUNT.md](docs/46_RC20_ARCHIVED_ITEM_COUNT.md) | RC20：归档条目数其实一直读得到 |
| [47_RC21_CLIENT_TYPECHECK_AND_CONTRACT.md](docs/47_RC21_CLIENT_TYPECHECK_AND_CONTRACT.md) | RC21：给客户端面加类型检查，并把它与宿主的契约钉死 |

**新读者从这里开始**：[00](docs/00_README_EF.md) 看模型，
[42](docs/42_DEPLOYMENT_CHAIN.md) 看安装与运维，
[47](docs/47_RC21_CLIENT_TYPECHECK_AND_CONTRACT.md) 看近期工作如何被验证。

---

## 许可证

[MIT](LICENSE)

`src/basic/` 是从 DeepSeek Harness (MIT) vendor 而来，并内联了 `frameCheckpoint`
seam。见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
