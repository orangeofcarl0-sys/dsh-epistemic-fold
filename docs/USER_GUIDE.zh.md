# Epistemic Fold 使用指南

[English](USER_GUIDE.md)

本指南描述当前产品面。研究历史见 [README.zh.md](README.zh.md)。

## 1. 安装

### Release tarball

固定版本部署的推荐方式：

```bash
dsh plugin --profile <name> add file:/path/to/dsh-epistemic-fold-0.1.0.tgz
```

release tarball 已包含 `lib/`，不需要构建步骤。

### 固定到 git tag

```bash
dsh plugin --profile <name> add github:orangeofcarl0-sys/dsh-epistemic-fold#v0.1.0
```

git 依赖可能需要 pnpm `allowBuilds`。当 pnpm 阻止 `prepare` 时，DSH 会打印出确切的条目。

### 本地 checkout

```bash
npm install
npm run preflight
```

然后把这个 checkout 以 `file:` dependency 加入 profile。

### Bundle 顺序

EF 原位 patch DSH 自带的 preset。profile 必须先加载 web app：

```jsonc
{
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

生成的替换会改掉 `standard`、`ptc`、`cordis` 内的 compaction backend。`minimal` 保持原样。

精确的 loader / preset / 浏览器矩阵见 [42_DEPLOYMENT_CHAIN.md](42_DEPLOYMENT_CHAIN.md)。

## 2. 模式

### Economy

```text
retainRatio  = 0.16
semanticMode = none
```

适用于上下文 / API 成本重要、且按需召回可以接受时。

Economy 让已声明 / 当前状态保持热，对更早的未声明叙述则更多依赖 search / recall。

### Balanced

```text
retainRatio  = 0.24
semanticMode = none
```

适用于"多留一些近期原文"值得付出适度上下文溢价时。

机制是刻意的，但项目尚未确立相对 Economy 的可靠长周期稳态优势。

### Quality

```text
retainRatio  = 0.24
semanticMode = rationale
```

适用于你主动偏好更多语义冗余、并接受额外 compaction 模型成本时。

额外收益仍是假设；额外成本是真实的。

### Legacy

EF 的冻结兼容基线。用于对比与回滚。

### Basic

EF 退场：

- compaction 委托给 vendored Basic backend；
- 无 EF projection；
- 无 EF Sidebar 面板；
- 无 `/context`；
- 无 `context_search` / `context_recall`。

适用于你想用原生基线、但不想卸载 EF 时。

## 3. 切换档位

启动时：

```yaml
- name: dsh-epistemic-fold
  config:
    mode: economy
    bundleRoot: <profile persistence root>/epistemic-fold
```

会话中：

```text
/context mode economy
/context mode balanced
/context mode quality
```

运行时命令刻意只暴露这三档。`legacy` / `basic` 通过配置选择。

## 4. 查看上下文

### 完整报告

```text
/context status
```

报告在可用时包含：

- 当前 context pressure 与模型 window；
- fold threshold 与 occupancy；
- 归档 token 估算量与归档消息实测计数；
- 当前 frozen checkpoint 数量；
- 累计 leaf / root fold 次数；
- search / recall 次数；
- 路由到的 provider / model 生命周期；
- provider 报告的累计 token 用量；
- 命中对应 economics profile 时的成本估算。

每个值都会标注系统是怎么知道的：

- **measured** —— 来自 DSH / provider 状态；
- **estimated** —— 由模型或启发式推导；
- **unknown** —— 无法确定。

unknown 不会被转成 0。

### 单行形式

```text
/context line
```

适合日志与状态栏。

### Sidebar

浏览器面板读取同一个 status projection。它只用于观察：渲染面板不会向模型 prompt 添加任何内容。

## 5. Search 与 recall

当 DSH 提供 ToolRuntime 时，EF 注册：

### `context_search`

用于查找相关的已折叠历史。search 会检查 checkpoint 内容与 archived messages。

一个命中可以包含：

- checkpoint id；
- 逻辑来源范围；
- match kind；
- matched message 索引；
- 有界 verbatim 摘录；
- 匹配次数 / 更早匹配的位置。

命中优先较新的会话时序，同时更早的证据仍然可达。

### `context_recall`

用一个 checkpoint 引用（`cp:<id>`）恢复：

- 紧凑的 checkpoint 视图；或
- 带分页的精确 archived messages。

精确历史从 bundle store 恢复，而不是从摘要重建。

## 6. Leaf fold 与 root fold

### Leaf Fold

常规维护操作。它折叠 Fold Frontier 之后的一段合法 span，并追加一个新的 frozen checkpoint。

这保持了更早 prefix 的稳定，避免递归重写旧 checkpoint。

### Root Fold

对 frozen surface 的一次更大 rebase。它刻意不常见，因为重写早期 prefix 可能让 provider cache 失效。

经济性 root 策略权衡的是"长期 carry cost"与"一次性变更成本"，而不是每 fold 都 rebase。

## 7. Sidebar / status 数字的含义

`checkpoints now` 与 `folds (lifetime)` 是刻意区分的两件事：

```text
40 historical folds
→ root rebase
→ 1 checkpoint currently visible
```

可以正确地报告为：

```text
checkpoints now: 1
leaf folds:      39
root rebases:     1
```

归档 token 数是估算；归档消息数是实测。

当没有 provider 用量、或没有对应路由的价格卡时，成本会被省略。

## 8. 排错

### 会话里看不到 EF

检查：

1. 插件已装进 profile；
2. `dsh-epistemic-fold` 排在 `@deepseek-ai/dsh-web-app` 之后；
3. 你选的是 `standard`、`ptc` 或 `cordis`；
4. 你没有配置 `mode: basic`。

substitution doctor 会把"preset 替换没生效"变成显式报错，而不是静默把会话留在 Basic 上。

### `/context` 不见了

该命令只在 DSH command registry 存在时注册。只有 compaction 的宿主可以挂载 EF 而不挂命令面。

`mode: basic` 也刻意不注册任何 EF 面。

### Recall 工具不见了

它们只在 ToolRuntime 存在时注册。

### 成本显示 `unknown`

两个常见原因：

- 还没有观测到 provider 用量；
- 路由到的 provider/model 没有匹配的 economics profile。

EF 不会凭空编一个费率。

### Sidebar 缺失或重复

面板同时支持原生右侧 Sidebar 与可选的 better-sidebar 路径。注册做了去重，因为 better-sidebar 可能桥接进原生 registry。

浏览器验证历史见 [37](37_RC11_BROWSER_VERIFICATION.md) 与 [43](43_RC17_SIDEBAR_ENTRY_DEDUPE.md)。

## 9. 升级 DSH

preset substitution 对版本敏感。DSH 升级之后：

```bash
node scripts/generate-presets.mjs
```

项目还跑一条 pinned-baseline CI lane 和一条 current-master 兼容性探针。

vendored Basic backend 有防漂移保护；不要把它当普通插件代码来改。

## 10. 安全性 / 当前限制

- Balanced 与 Quality 是产品 operating point，不是已被证明的排名。
- 路由级实测成本优势仍然依赖 provider/cache。
- EF 不会自动把用户的每一句话都变成权威的结构化状态。
- 通用 `ef/anchor` 持久化取决于 DSH 宿主能力，不得当作通用 persistence API。
- 外部 benchmark 只是部分接入；它们尚未确立通用的档位排序。
