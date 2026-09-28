# Epistemic Fold

> **Epistemic Fold for DeepSeek Harness**
> *面向长周期 Agent 的、保持契约的上下文运行时。*

[English](README.md) · [中文](README.zh.md)

## 这是什么？

Epistemic Fold（EF）是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
的一个 compaction backend 插件。它把会话历史、记忆与工作上下文当作三件不同的事：

```
History ≠ Memory ≠ Context
```

核心命题：

> **只有当一段轨迹对未来仍有意义的知识效应已经被稳定对象吸收、关键状态与
> 边界得到保留、且原始证据可以恢复时，该轨迹才有资格被折叠出工作上下文。**

具体地，运行时折叠一段会话时：

1. **先归档精确的模型可见消息**到不可变、哈希校验的 `CheckpointBundle`，
   在任何有损 surface 替换提交之前（`BundleDurable ≺ SurfaceLoss`）；
2. **绝不重折叠已冻结的内容** —— 单调前进的 *Fold Frontier* 分隔冻结
   checkpoint 与开放轨迹，缓存的 prefix 在多次折叠间逐字节稳定；
3. **当前状态由原始 session 事件确定性派生** —— objective、constraint、
   decision、value、evidence、failure、obligation 全部携带完整 provenance，
   并有一条硬规则：语义摘要永远不能验证状态（`Raw Events → State` 与
   `Raw Events → Summary` 并行；`Raw → Summary → State` 被禁止）；
4. **精确恢复** —— `context_search` / `context_recall` 提供有界、分页、
   经 provenance 校验的召回，不一次性倾倒归档。

优化目标不是最大压缩率，而是 correctness first —— 在硬正确性约束下提高
信息密度、prefix cache 局部性、长期状态一致性与闭环延续稳定性。

## 状态

对照 **DeepSeek Harness `0.1.7-rc.2`**（核验基线
`477b4f420553e8a52c2fbccc464d7561b239c443`）的研究性实现。

| 里程碑 | 范围 | Gate |
|---|---|---|
| **M0** | 精确归档 / 召回闭环、原子 bundle store、确定性 fallback | ✅ C0.1–C0.5 |
| **M2** | Fold Frontier、leaf/root 折叠、prefix 指纹证明 | ✅ C2.1–C2.4 |
| **M3a** | 确定性当前状态（anchor、authority、projection） | ✅ ALR=0 · SSR=0 · provenance=100% · bounded |

M1（verified ingress reduction）、M3b（negative knowledge / uncertainty）、
M4（依赖图）及之后 **刻意未实现** —— 每一项都需要 benchmark 先观察到对应的
失败证据（见 [05_EF_DECISIONS_AND_OPEN_QUESTIONS.md](docs/05_EF_DECISIONS_AND_OPEN_QUESTIONS.md)
第 F 节）。

配对基线证据（相同历史分别跑 DSH Basic 与 EF）：在测量区间内 EF 的
**prefix 失效 token 量低 15%**，且差距随折叠次数扩大 —— Basic 每次折叠
全量重写 prefix，EF 只折叠 frontier 之后（见
[06_FINAL_REPORT.md](docs/06_FINAL_REPORT.md)）。

## 开发方式

本仓库是独立的插件源码树。测试直接运行 vendor 的 DSH **源码**（与 DSH
monorepo 相同的源码级解析方式），因此插件本身无需构建。

前置要求：Node `^22.19 || >=24`、pnpm `11.7.x`、npm。

```bash
# 1. 在核验基线上 vendor DSH monorepo
git clone https://github.com/deepseek-ai/deepseek-harness.git vendor/deepseek-harness
cd vendor/deepseek-harness
git checkout 477b4f420553e8a52c2fbccc464d7561b239c443
pnpm install

# 2. 为 EF 消费的包构建声明输出
node --max-old-space-size=8192 ./node_modules/typescript/bin/tsc -b \
  packages/compaction/compaction-basic packages/core/tools packages/util/atomic-write

# 3. 回到插件仓库：安装工具链并（重新）生成 src/类型两张解析表
#    （写入 vitest.config.ts 与 tsconfig.json 消费的 JSON）
cd ../..
npm install
node scripts/generate-maps.cjs

# 4. 全量运行
npx vitest run                     # 5 个套件共 49 个测试
npx tsc --noEmit -p tsconfig.json  # 对照 vendor 声明做类型检查
```

`scripts/generate-maps.cjs` 从 vendor monorepo 提取 `@deepseek-ai/*` 路径表，
产出两张映射：`scripts/vendor-paths.json`（源码，供 vitest alias 表使用）与
`scripts/vendor-types-paths.json`（构建产物声明，供 tsconfig 使用）。vendor
clone 升级到新 DSH 版本后重新运行即可。

## 仓库结构

```
src/
  engine.ts        EpistemicFoldEngine — Basic 事务 + EF compile hook
  policy.ts        插件配置解析 + 路由模型压力数学
  candidate.ts     待决折叠候选身份（每 session 单槽）
  bundle-store.ts  FileBundleStore — 原子写、哈希校验、0600 权限
  compiler.ts      输入切分、canonical bundle 构建、checkpoint 渲染
  frontier.ts      Fold Frontier：从当前 surface 重定位（identity 而非裸位置）
  leaf-policy.ts   [frontier+1, bestEnd] span 选择 + frozen 预算统计
  root-policy.ts   root rebase 建议（manual /compact = Root Fold）
  state.ts         确定性 StateReducer：anchor、supersession、生命周期
  authority.ts     哪些事件种类可以支撑哪些 authority domain
  projection.ts    把 reducer 接入 ctx.sessionProjections
  renderer.ts      结构化 checkpoint：Current/Evidence/Open/Rationale/Recall
  recall.ts        context_search + context_recall（有界、分页、精确）
  tools.ts         向 ctx.tools 注册召回工具
  hash.ts          canonical JSON + SHA-256 摘要
tests/             M0/M2/M3a 套件 + 共享 harness（受控 LLM adapter）
bench/             配对基线 harness（Basic vs EF 的 prefix 经济学）
```

## 设计文档（位于 `docs/`）

| 文档 | 内容 |
|---|---|
| [00_README_EF.md](docs/00_README_EF.md) | 项目入口：命名、目标、九条核心不变量 |
| [01_EF_RFC_001_ARCHITECTURE.md](docs/01_EF_RFC_001_ARCHITECTURE.md) | 架构规范：真相模型、数据结构、折叠事务 |
| [02_EF_IMPLEMENTATION_PLAN_M0_M3.md](docs/02_EF_IMPLEMENTATION_PLAN_M0_M3.md) | 工程 DAG、阶段 Gate、停止条件 |
| [03_EF_TEST_BENCHMARK_SPEC.md](docs/03_EF_TEST_BENCHMARK_SPEC.md) | 指标（ALR/SSR/DWR/CR/PMA）、测试套件、benchmark 分组 |
| [04_EF_LOCAL_AGENT_WORK_ORDER.md](docs/04_EF_LOCAL_AGENT_WORK_ORDER.md) | 实现 Agent 的执行顺序与禁令 |
| [05_EF_DECISIONS_AND_OPEN_QUESTIONS.md](docs/05_EF_DECISIONS_AND_OPEN_QUESTIONS.md) | 冻结决定、假设、开放问题 |
| [06_FINAL_REPORT.md](docs/06_FINAL_REPORT.md) | 最终实现报告：Gate、证据、偏差、重构记录 |

## 许可证

[MIT](LICENSE)
