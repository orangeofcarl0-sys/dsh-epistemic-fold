# Epistemic Fold

[![CI](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/actions/workflows/ci.yml/badge.svg)](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/orangeofcarl0-sys/dsh-epistemic-fold?sort=semver)](https://github.com/orangeofcarl0-sys/dsh-epistemic-fold/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.1.7--rc.2-4b5563.svg)](#ci)
[![docs](https://img.shields.io/badge/docs-guide-4b5563.svg)](docs/README.md)

> 面向 DeepSeek Harness 长周期 Agent 的 contract-preserving context runtime。

[English](README.md) · [文档导航](docs/README.md) · [使用指南](docs/USER_GUIDE.md) · [架构](docs/ARCHITECTURE.md)

## Epistemic Fold 是什么？

长周期 Agent 最终都会遇到工作上下文膨胀。普通 compaction 通常把旧历史摘要成一段新文本，但摘要是有损表示：事实可能漂移、旧值可能重新看起来像当前值、很晚以后才需要的细节也可能已经消失。

Epistemic Fold（EF）把三件事分开：

```text
History ≠ Memory ≠ Context
```

一次 fold 只是把历史移出**模型当前工作 surface**，而不是删除 canonical record。EF 在有损 surface replacement 提交之前，先把原始 model-visible messages 写入持久、带哈希校验的 bundle；prompt 中只保留压缩后的 checkpoint，需要精确历史时再做有界 search / recall。

```text
DSH Session / tool results
          │
          ▼
   精确 Fold Archive ───────────────┐
          │                         │
          ▼                         │
 确定性 Current State              │
 + Compact Checkpoint              │
          │                         │
          ▼                         │
     Active Context                │
          │                         │
          └── context_search / context_recall
```

EF 的目标不是“把 token 压得最短”，而是在保住长期 Agent 所依赖的 contract 以后，再优化上下文体积、prefix cache 局部性和实际成本。

## 当前实现提供什么？

- **先归档、后有损替换**：folded messages 在 surface replacement 前落入 bundle store。
- **Fold Frontier**：普通折叠只推进单调边界，已经冻结的历史不会被反复摘要。
- **确定性状态表示**：constraint、value、failure、obligation 等可与 narrative summary 分离。
- **精确有界召回**：`context_search` 定位历史，`context_recall` 返回带 provenance 的分页原文。
- **Leaf / Root Fold**：高频增量维护 + 低频经济性 rebase。
- **Economy / Balanced / Quality 三档**：同一个 engine 的三个成本—稳态 operating point。
- **用户可见状态面**：`/context status` 与 Sidebar 显示 context pressure、archive、fold、recall 和成本，并且不进入模型上下文。
- **Basic fallback**：`mode: basic` 时 EF 完全退场，compaction 委托给逐字节兼容的 vendored Basic backend。

## 安装

最推荐使用 Release 中的 tarball，因为它已经包含构建好的 `lib/`——不会触发 `prepare`，不需要 `allowBuilds`，拿到的就是 release notes 描述的那份代码：

```bash
dsh plugin --profile <name> add file:/path/to/dsh-epistemic-fold-0.1.0.tgz
```

也可以固定到 git tag：

```bash
dsh plugin --profile <name> add github:orangeofcarl0-sys/dsh-epistemic-fold#v0.1.0
```

> **裸写 `github:owner/repo` 跟的是默认分支，不是 release。**
> `dsh plugin` 从不查询 GitHub Releases API：它把 spec 交给 pnpm，裸写形式会被解析到默认分支的
> TIP，只有带 `#<tag-or-commit>` 时才真正 pin——实测表现为 `codeload.github.com` 的 tarball URL，
> 末尾是解析出的 commit sha。想跟未发布代码就显式去掉 `#v0.1.0`，不要靠意外。

本地 checkout：

```bash
npm install
npm run preflight
```

然后以 `file:` dependency 加入 DSH profile。`file:` 渠道**不会**替你构建——实测 pnpm 会跳过 path
dependency 的 `prepare`——所以必须先 `npm install`，否则装进去的目录里 `main` 并不存在；
`npm run preflight` 会在安装之前拦住这种情况。

EF 会原位替换 DSH `standard`、`ptc`、`cordis` preset 中的 compaction backend；`minimal` 保持 DSH 原样。Bundle 顺序有意义：`dsh-epistemic-fold` 必须放在 `@deepseek-ai/dsh-web-app` 之后。

```jsonc
{
  "dependencies": {
    "dsh-epistemic-fold": "file:/path/to/dsh-epistemic-fold"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-epistemic-fold"
      ]
    }
  }
}
```

安装渠道、校验方法和升级排错见 [使用指南](docs/USER_GUIDE.md)；完整部署链见 [docs/42_DEPLOYMENT_CHAIN.md](docs/42_DEPLOYMENT_CHAIN.md)。

## 使用

### 三档模式

`economy`、`balanced`、`quality` 是用户档位；`legacy`、`basic` 是兼容模式。

| mode | 行为 | 当前证据 |
| --- | --- | --- |
| `economy` | 默认 retention，不做每次 fold 的 rationale 调用；旧历史按需召回 | 已在 targeted retrieval / integration tests 中测量 |
| `balanced` | Economy + 更大的 verbatim recent tail | 机制成立；稳态收益尚未建立 |
| `quality` | Balanced + narrative rationale checkpoint | 机制成立；成本最高，收益尚未建立 |
| `legacy` | EF engine 的冻结兼容基线 | compatibility |
| `basic` | EF 退场，使用 Basic 行为且不暴露 EF surface | compatibility |

启动配置：

```yaml
- name: dsh-epistemic-fold
  config:
    bundleRoot: <profile persistence root>/epistemic-fold
    mode: economy
```

运行中的三档切换：

```text
/context mode economy
/context mode balanced
/context mode quality
```

`legacy` / `basic` 通过配置选择，不属于运行时三档切换。

### 查看压缩状态

```text
/context status
/context line
```

状态面区分 **measured / estimated / unknown**。没有数据时不会伪造 `0`。

Sidebar 与 `/context status` 读取同一个结构化 projection。它只是 observation surface，不会进入 prompt。

### 召回 Folded History

当 ToolRuntime 存在时，EF 注册：

- `context_search`：在已折叠历史中查找相关 checkpoint 和有界原文 excerpt；
- `context_recall`：读取 checkpoint 的摘要或精确 archived messages。

Search 按会话逻辑时序排序，而不是按墙钟时间；exact recall 带 provenance。

## Fold 是怎样工作的？

普通 **Leaf Fold** 只处理 Fold Frontier 后面的 open trajectory：

```text
[frozen checkpoints] | frontier | [open trajectory]
                                      │
                                      └── leaf fold
```

一次 fold：

1. 找到合法且闭合的 span；
2. 把原始 messages 写入 bundle store；
3. 生成 checkpoint / current-state representation；
4. 提交 surface replacement；
5. 推进 frontier。

**Root Fold** 用于在长期 carry cost 确实值得时重整 frozen surface，因此故意保持低频。

任何离开 active surface 的内容仍然可以从 bundle store 精确恢复。

## 当前证据状态

EF 把“已经测量”与“产品假设”分开：

| 项目 | 状态 |
| --- | --- |
| bundle durability、exact archive / recall | **CLOSED / 已机器验证并在生产路径执行** |
| Fold Frontier、Leaf / Root 事务 | **CLOSED / measured** |
| retrieval ergonomics 与时间顺序 | **CLOSED on current contract** |
| 真实 DSH plugin、preset substitution、commands、Sidebar | **verified** |
| Economy targeted retrieval quality | **measured** |
| Balanced / Quality 的额外 steadiness 收益 | **尚未建立** |
| route-level realized cost superiority | **OPEN，依赖 provider/cache** |
| τ²-Bench | **已接入；首次 fold 前未观察到 tier separation** |
| LHTB | **环境/bridge 已验证；arm comparison 尚未完成** |

研究过程保留了完整 audit trail。后续文档如果推翻前序结论，会保留旧记录并显式纠正，而不是重写历史。导航见 [docs/README.md](docs/README.md)。

## 当前重要边界：State Ownership

EF 有一套 normalized state vocabulary，但并不宣称拥有所有 Agent state：

- goal 仍由 DSH goal state 管理；
- plan 仍由 todo/planning 管理；
- 项目级 guidance 仍来自 `AGENTS.md` / instruction loader；
- 当前自动生产的 EF state 主要来自 failed tool result；
- 其他 anchor kind 可以表示，但没有通用 production producer。

当前 DSH 下自定义 `ef/anchor` durable write 也不是一个可以普遍依赖的 persistence API。详见 [Architecture](docs/ARCHITECTURE.md#7-state-ownership-and-current-limitations)。

## 开发

本仓库是一个独立的 plugin source tree。测试直接跑 vendored DSH **source**（与 DSH monorepo 相同的
source-level resolution），所以测试 plugin 本身不需要先构建。

前置条件：Node `^22.19 || >=24`、pnpm `11.7.x`、npm。

```bash
# 1. 在已验证基线上 vendor DSH monorepo
git clone https://github.com/deepseek-ai/deepseek-harness.git vendor/deepseek-harness
cd vendor/deepseek-harness
git checkout 477b4f420553e8a52c2fbccc464d7561b239c443
pnpm install

# 2. 构建 EF 依赖的包的 declaration 输出
node --max-old-space-size=8192 ./node_modules/typescript/bin/tsc -b \
  packages/compaction/compaction-basic packages/core/tools packages/util/atomic-write

# 3. 回到 plugin 仓库：安装工具链并重新生成 resolution maps
cd ../..
npm install
node scripts/generate-maps.cjs

# 4. 全部跑一遍
npm test
npm run typecheck:all
npm run build
```

测试直接使用 vendored DSH source。`vendor/` 被 gitignore，但它是本地开发环境的一部分，不是可以随手清掉的 test output。

live tier 是 opt-in（`EF_LIVE=1`），没有可用 route 时会 **skip**，因此未测量的行为不会被报告成通过。

### CI

每次 push 跑两个 lane：

- **pinned DSH baseline**（`477b4f42…`，即 `0.1.7-rc.2` release）——必须通过。
- **DSH master**——允许失败的兼容性探针。

两个 lane 都跑 typecheck、全量测试和 keyless evaluation tier。

> **关于版本号。** 本仓库里的 `0.1.7-rc.2` 是 **CI 钉住的测试基线**，不是对你本机安装版本的声明。
> EF 的 `engines.dsh` 与 peer range 是 `>=0.1.7-rc.2`，并且已在 `0.2.0-rc.2` 上验证运行。

评测矩阵、live tier、外部 benchmark 和临时目录约定见 [Development](docs/DEVELOPMENT.md)。

## 仓库结构

```
src/
  engine.ts             EpistemicFoldEngine —— Basic 事务 + EF compile hook
  fold-economics.ts     经济性 leaf admission 与 rebase 决策（R2-B、R2-C）
  policy.ts             plugin 配置解析 + routed-model pressure 计算
  policy-compiler.ts    amortized rebase policy：break-even horizon、硬 override
  economics-profile.ts  版本化成本模型：ρ、ρ_eff、cache realization、break-even
  candidate.ts          待提交 fold candidate 的身份（每 session 单槽）
  bundle-store.ts       FileBundleStore —— 原子、哈希校验、0600 权限
  compiler.ts           input 切分、canonical bundle 构建、checkpoint 渲染
  frontier.ts           Fold Frontier：从 CURRENT surface 定位/重建
  leaf-policy.ts        [frontier+1, bestEnd] span 选择 + frozen budget 载入
  root-policy.ts        root rebase 建议（手动 /compact = Root Fold）
  state.ts              确定性 StateReducer：anchor、supersession、lifecycle
  authority.ts          哪些 event kind 可以支撑哪些 authority domain
  anchor-service.ts     authority-gated anchor 写入通道（ctx.epistemicFold）
  projection.ts         把 reducer 接入 ctx.sessionProjections
  renderer.ts           结构化 checkpoint：Current/Evidence/Open/Rationale/Recall
  recall.ts             context_search + context_recall（有界、分页、精确）
  tools.ts              向 ctx.tools 注册 recall 工具
  hash.ts               canonical JSON + SHA-256
  checkpoint-marker.ts  checkpoint body 内的 EF1 marker 协议
  pressure.ts           frozen/open pressure 归因
  trigger.ts            trigger-breakdown 计算
  trigger-diagnostics.ts 按 target 的 trigger 分解，输出到 log
  event-data.ts         EF 读取的 session event payload 的类型化 reader
  rebase-intent.ts      rebase-intent registry
  idle-rebase.ts        idle 时段的 rebase consumer
  effective-config.ts   已解析配置的报告
  preset.ts             档位阶梯及其证据状态
  status.ts             /context status 模型（对调用方数据的纯函数）
  status-projection.ts  面向 client 的 status projection（Sidebar 的数据源）
  command.ts            /context 命令面
  plugin.ts             组合 plugin：拥有 ctx.compaction，串联以上模块
  entry.ts              裸名入口（挂载 DOCTOR，而不是 plugin）
  doctor.ts             常驻的 substitution doctor（只观察）
  preset-self-check.ts  把未生效的 preset substitution 变成显式报错
  compat.ts             frameCheckpoint seam 探测 + fail-loud 断言
  basic/                DSH Basic backend 的 vendored 副本，内联了 seam
  index.ts, types.ts    library 面与共享类型
client.js               浏览器 Sidebar panel（手写，无 bundler）
eval/                   评测 harness：workload、ROI lab、Pareto、paired runner
profiles/economics/     版本化 provider 定价（asOf + source）
tests/                  测试套件，以及带受控 LLM adapter 的共享 harness
bench/                  paired-baseline harness（Basic vs EF prefix 经济性）
scripts/                构建、preset 生成、vendoring、seam 应用、preflight
docs/                   设计记录与评测报告（见下）
```

## 文档

推荐阅读顺序：

- [使用指南](docs/USER_GUIDE.md) —— 安装、模式、命令、Sidebar、排错。
- [架构](docs/ARCHITECTURE.md) —— contract、fold 生命周期、state 与 recall。
- [开发指南](docs/DEVELOPMENT.md) —— 本地环境、测试、评测约定。
- [完整文档导航](docs/README.md) —— 稳定文档 + 完整研究/审计归档。
- [部署链](docs/42_DEPLOYMENT_CHAIN.md) —— DSH preset 与浏览器部署的详细路径。

编号的 R/RC 文档是**研究与验证记录**，普通使用不需要按时间线阅读。完整索引在 [docs/README.md](docs/README.md)。

## License

MIT。见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
