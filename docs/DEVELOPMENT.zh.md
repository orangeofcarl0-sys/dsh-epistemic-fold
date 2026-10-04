# Epistemic Fold 开发指南

[English](DEVELOPMENT.md)

## 1. 前置条件

- Node `^22.19 || >=24`
- pnpm `11.7.x`
- npm
- 一份 DeepSeek Harness 的本地 checkout，用于 source-level 测试

本仓库刻意不提交 DSH 的 vendor 树。

## 2. 准备 DSH 基线

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git vendor/deepseek-harness
cd vendor/deepseek-harness
git checkout 477b4f420553e8a52c2fbccc464d7561b239c443
pnpm install
```

为 EF 使用的 DSH 包构建 declaration：

```bash
node --max-old-space-size=8192 ./node_modules/typescript/bin/tsc -b \
  packages/compaction/compaction-basic \
  packages/core/tools \
  packages/util/atomic-write
```

回到 plugin 仓库：

```bash
npm install
node scripts/generate-maps.cjs
```

## 3. 主要检查

```bash
npm test
npm run typecheck:all
npm run build
npm run preflight
```

不要在文档里硬编码测试数量。测试套件变化频繁；命令输出才是权威。

## 4. 评测命令

Keyless 评测：

```bash
npm run eval:keyless
npm run eval:r1
npm run eval:r2
npm run eval:r3
npm run eval:r4
npm run eval:rc0
npm run eval:rc1
```

live 路线是 opt-in；当 route / 凭据不可用时应 SKIP，而不是静默通过。

示例：

```bash
EF_LIVE=1 npm run eval:r1-live
EF_LIVE=1 npm run eval:r4-live
```

把 live 测量当作**路由特定**的结果。provider cache 行为与定价会实质性改变结论。

## 5. 外部 benchmark lane

仓库里有针对以下项的集成工作：

- τ²-Bench-Verified —— 交互 / 状态可靠性；
- LHTB —— 持续长周期工作；
- LongMemEval-V2 —— 计划中 / 受本地 reader/embedder 硬件限制。

外部 benchmark 的结果应当以 benchmark 自己的原生分数作为头条。EF 特有的 telemetry 用来解释失败，不用来重新定义 benchmark 结论。

### τ²

τ² 对交互非回归有用，但当前选定的任务可能在 EF 的 fold threshold 之前就结束。零 fold 的结果是关于集成 / fold 前行为的证据，不是关于 EF compaction 质量的证据。

### LHTB

LHTB 能达到真正的 fold regime，因此是更直接的长任务 benchmark。它很吃资源；在资源受限的机器上一次跑一个 cell。

在比较模式之前，先用 Basic 标定本地 agent stack。来自另一个 agent scaffold 的已发表模型分数，不构成对本地的区分度保证。

## 6. 并行评测

并行执行对质量 / 可靠性研究有用。

除非显式控制 provider cache 隔离，否则不要把高并发运行当作实测成本证据。相似的并行请求会互相把对方的 prefix cache 焐热。

成本实验需要自己的目的守卫、cache 命名空间 / 顺序纪律，以及 provider 用量 telemetry。

## 7. 临时目录

评测代码必须使用受管理的 scratch-directory helper，而不是裸的、不受控的 `mkdtemp` 目录。

原因：早期套件在 OS 临时卷下累积了数万个临时目录。磁盘占用不大，但目录数量相关的操作变得昂贵，并占满了受限的系统卷。

使用仓库提供的 helper 与 release / sweep 路径。sweeper 被刻意限制在 EF 自己的前缀内。

绝不要因为"临时数据"就删掉被 gitignore 的 `vendor/` 树：测试依赖它。

## 8. Preset 生成

EF 把自己的 backend 替换进 DSH 自带的 preset。

升级 DSH checkout 之后：

```bash
node scripts/generate-presets.mjs
```

生成器只重写 `cordis.patch.yml` 里的生成区。

启动时的 doctor 会捕获漏掉的替换；DSH 升级不得在 UI 声称 EF 已激活的同时，把会话静默留在原生 Basic 上。

## 9. Client / Sidebar

两个 TypeScript project 是刻意的：

- `tsconfig.json` —— server / plugin / test 源码；
- `tsconfig.client.json` —— 浏览器 client 面。

运行：

```bash
npm run typecheck:all
```

client 使用宿主提供的 UI 模块，并被排除在 server 编译 project 之外。

## 10. 文档纪律

稳定产品文档：

- `README.md` / `README.zh.md`
- `docs/USER_GUIDE.md` / `docs/USER_GUIDE.zh.md`
- `docs/ARCHITECTURE.md` / `docs/ARCHITECTURE.zh.md`
- `docs/DEVELOPMENT.md` / `docs/DEVELOPMENT.zh.md`
- `docs/README.md` / `docs/README.zh.md`

编号 R/RC 文档是证据记录。

不要因为后来的实验推翻了旧结论就去重写那份旧实验结果。把更正加到更晚的记录里（必要时加一条显式的 supersession 说明），让审计链保持可读。

## 11. 评测纪律

从反复出现的 instrumentation 失败中得出的规则：

- 区分 `unknown` 与数值 0；
- 区分估算值与 provider 实测值；
- 区分任务未完成与认知性失败；
- 把当前 checkpoint 与累计 fold 分开；
- 永远不要假定一个 "Basic" 臂真的是 Basic —— 验证实际挂载的 engine；
- 在把某个探针称为 compaction 测试之前，确认它真的跨过了一次 fold 边界；
- 长任务要增量保留原始 transcript；
- 把质量实验与对 cache 敏感的成本实验分开；
- 外部 benchmark 使用 benchmark 原生的 grader；
- 宁可要 null result，也不要把夹具调到 EF 赢为止。

## 12. 更新依赖

强制 CI lane 钉住已验证的 DSH 基线。第二条兼容性 lane 探测更新的 DSH。

当改动最低支持的 DSH 版本时，检查：

1. compaction 事务语义；
2. preset 结构 / 生成的 patch；
3. ToolRuntime 与 command 注入；
4. token-meter 用量语义；
5. 浏览器 projection 与 Sidebar API；
6. vendored Basic 兼容 backend。

`src/basic/` 是兼容副本。不要把它当普通功能代码修改。
