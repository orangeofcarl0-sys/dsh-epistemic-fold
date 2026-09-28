# Epistemic Fold 测试与 Benchmark 规范

> 目标：证明 EF "不会忘错"，然后才证明"更省"。  
> 适用阶段：M0、M2、M3a、M1、M3b。  
> 原则：machine-verifiable correctness 指标不允许用平均分掩盖单点失败。

---

# 1. 指标层级

## 1.1 硬正确性指标

必须为零失败：

- Archive Loss；
- Exact Recall Mismatch；
- Authority Loss；
- State Staleness；
- Missing Provenance；
- Broken Tool Pair；
- Unrecoverable committed checkpoint。

这些不接受 99%。

---

## 1.2 行为指标

允许统计比较：

- Task Success；
- Duplicate Work Rate；
- Recall Dependency Rate；
- Context Regret；
- State Ambiguity；
- Trajectory divergence。

---

## 1.3 成本/性能指标

- active prompt tokens；
- summarizer tokens；
- cache read/write（若 provider 有）；
- local stable-prefix bytes；
- prefix mutation depth；
- bundle disk size；
- projection memory size；
- latency。

---

# 2. 核心公式

## 2.1 Authority Loss Rate

\[
ALR=
\frac{
missing\ active\ authoritative\ anchors
}{
active\ authoritative\ anchors
}
\]

M3a hard gate：

\[
ALR=0
\]

---

## 2.2 State Staleness Rate

\[
SSR=
\frac{
superseded\ values\ shown\ as\ current
}{
displayed\ current\ values
}
\]

M3a hard gate：

\[
SSR=0
\]

---

## 2.3 Duplicate Work Rate

\[
DWR=
\frac{
unnecessary\ repeated\ actions
}{
post\text{-}fold\ actions
}
\]

重复动作包括：

- 重读刚读过且无变化文件；
- 重跑刚验证过且没有输入变化的测试；
- 重搜相同问题；
- 重新尝试已明确排除的路径；
- 重开 verified-resolved failure。

---

## 2.4 Context Regret

\[
CR=
\frac{
tokens\ recalled\ shortly\ after\ folding
}{
tokens\ reclaimed
}
\]

"shortly"建议先取后续 3–5 个 request。

---

## 2.5 Prefix Mutation Amplification

\[
PMA=
\frac{
cache\text{-}equivalent\ invalidated\ tokens
}{
reclaimed\ active\ tokens
}
\]

没有 provider cache telemetry 时，用：

```text
first changed model-history token position
```

估算 invalidated suffix。

---

## 2.6 State Ambiguity Rate

对每个 current StateKey，统计 surface 中互相冲突的活跃值数量 \(n_k\)：

\[
SAR=
\frac{
\sum_k \max(0,n_k-1)
}{
|StateKeys|
}
\]

目标：

\[
SAR_{EF}<SAR_{raw/basic}
\]

---

# 3. M0 必测 suite

建议至少 24 个测试，分六类。

---

## A. Transaction tests

### T01 — leaf fold commits normally

验证：

- compaction start/end 成对；
- replacement 存在；
- Bundle 存在；
- recall 可用。

### T02 — tool-pair split rejected

构造 start/end 会切断 tool call/result。

预期：

- DSH 拒绝；
- Bundle 不成为 committed reference。

### T03 — selected surface changed during summary

summary pending 时改 selected span。

预期：

- transaction changed/fails；
- no invalid replacement；
- orphan Bundle 可检测。

### T04 — unrelated tail append does not corrupt selected fixed span

用于未来 selected-span prepare。

---

## B. Bundle/archive tests

### T05 — bundle logical hash exact

\[
hash(Bundle.messages)=hash(originalSelectedMessages)
\]

### T06 — atomic write failure

预期：

```text
no bundle
→ no successful summary
→ no surface replacement
```

### T07 — bundle success + compaction failure

预期：

- surface unchanged；
- orphan Bundle 可枚举；
- cleanup 安全。

### T08 — corrupt bundle hash detected

recall 必须拒绝"静默返回错误内容"。

---

## C. Recall tests

### T09 — summary recall

返回 checkpoint compact view。

### T10 — exact recall equality

规范化 Message JSON 完全相等。

### T11 — exact recall pagination

不得单次无界返回。

### T12 — missing bundle

返回 degraded/unavailable，不应 crash Session。

---

## D. Lifecycle tests

### T13 — process restart

restart 后：

- Session 恢复；
- checkpoint surface 正常；
- Bundle recall 正常。

### T14 — fork

确认 fork 后：

- EF bundle ref 不导致 parent/child 混淆；
- session ID provenance 正确。

### T15 — plugin unload/reload

EF 缺失时 Session 仍可打开。

### T16 — legacy Basic checkpoint present before EF install

EF 从 legacy surface 之后安全工作。

---

## E. Failure tests

### T17 — semantic model timeout

预期：

- deterministic fallback；
- Bundle durable；
- compaction 可继续；
- 不走输入修改型 summary retry。

### T18 — semantic malformed output

同上。

### T19 — cancellation before commit

无不一致状态。

### T20 — double compaction attempt

候选单槽/DSH lock 必须拒绝冲突。

---

## F. Crash-point tests

随机 kill/restart：

### T21 — archive temp write 后

### T22 — Bundle publish 后、compaction/start 前

### T23 — compaction/start 后、summary 中

### T24 — replacement 后、compaction/end 前

每个检查：

```text
Session opens?
surface coherent?
unmatched lock detectable?
bundle integrity?
orphan detectable?
recall status explicit?
```

---

# 4. M2 Stable Prefix tests

## P01 — frozen prefix byte/hash stability

连续 N 个 turn，不发生 leaf/root/emergency fold 时：

\[
SHA256(FrozenPrefix_t)
=
SHA256(FrozenPrefix_{t+n})
\]

---

## P02 — leaf fold append preserves prior prefix

Leaf C44 落地后：

```text
SYSTEM R0 C41 C42 C43
```

必须逐字不变。

---

## P03 — monotonic fold frontier

frontier 不得向左回退，除非 Root Fold/Emergency Fold。

---

## P04 — surface seq/non-monotonic safety

构造 high seq replacement 出现在旧 position。

验证：

- selector 按 `surface.nodes` 位置；
- 不按 seq 大小。

---

## P05 — manual `/compact` classified as root fold

预期：

```text
mode = root
```

而不是 leaf。

---

## P06 — rare root fold rebase restores bounded frozen budget

大量 leaf 后 manual root fold：

- frozen token 大幅回收；
- old bundles 仍可 recall；
- root bundle 有 child lineage/ref。

---

# 5. M3a State tests

## S01 — explicit user constraint survives

Turn 3：

```text
Do not change public API.
```

经过多次 checkpoint 后必须仍 active。

ALR = 0。

---

## S02 — summary poisoning

真实：

```text
2 failed
```

semantic summary 故意写：

```text
all tests passed
```

最终 machine/current state 必须仍为 FAIL。

---

## S03 — supersession

历史：

```text
timeout=30
timeout=60
```

Current：

```text
timeout=60
```

Recall 仍能查到 30。

SSR = 0。

---

## S04 — failure lifecycle

```text
OPEN
→ RESOLVED
→ VERIFIED
```

只有 VERIFIED 才能从 hot current state 退休。

---

## S05 — unverified completion

Assistant 声称 done，但没有 validation evidence。

Checkpoint 不得标为 verified complete。

---

## S06 — current decision supersession

旧 design decision 已明确替换。

current surface 只呈现新 decision。

---

## S07 — Projection boundedness

制造：

```text
10 epochs
100 epochs
1000 epochs
```

在 active state 数量恒定情况下：

- hot tail size bounded；
- current state size bounded；
- old epoch facts 不线性保留。

---

## S08 — projection checkpoint size

确保 projection cache 不退化成历史复制。

---

# 6. M3b Epistemic tests

## E01 — uncertainty drift

最初：

```text
X may be root cause.
```

32 checkpoint 后无 evidence：

必须仍是 hypothesis/open uncertainty。

---

## E02 — hypothesis rejected by evidence

应变为 rejected，并可生成 negative knowledge。

---

## E03 — negative knowledge prevents duplicate branch

A/B 已失败，C 成功。

折叠后继续，不应重新建议/执行 A/B，除非前置条件变化。

---

## E04 — negative knowledge expiration

A 因 constraint C 被拒绝。

C revoked 后，N(A) 应 stale，而不是永久禁止。

---

## E05 — classifier exact quote guard

模型引用不存在于 source 的 quote → reject。

---

# 7. M1 Verified Ingress tests

## I01 — compatible tool reduction survives finalize

expected reduced digest == final durable tool/result digest。

---

## I02 — finalizeContent interference

测试 tool 在 finalizeContent 重新扩张。

EF 必须：

- 检测 mismatch；
- 标 incompatible；
- 后续不自动压。

---

## I03 — artifact write fail-open

artifact 保存失败：

- full result 保留；
- 不允许有损 replacement。

---

## I04 — failure output protected

failed tests / errors 默认不 aggressive reduce。

---

## I05 — artifact exact recovery

reduced tool result 对应 raw artifact hash 正确。

---

# 8. Behavioral paired continuation benchmark

对于同一完整历史 H，构造：

```text
Branch A: no compaction / Basic
Branch B: EF fold checkpoint
```

使用相同：

- model；
- temperature；
- tools；
- environment snapshot；
- task continuation。

继续 3–5 个 action step。

记录：

```text
next tool
target file/object
re-read?
re-search?
re-test?
constraint violation?
resolved branch reopened?
final task state?
```

不要要求文本逐字一致。

---

# 9. Benchmark Arms

| Arm | Description |
|---|---|
| B0 | no compaction until hard limit |
| B1 | DSH Basic |
| B2 | Instant-like deterministic |
| B3 | ARGP（若版本可稳定复现） |
| E0 | EF M0 |
| E2 | EF M2 |
| E3a | EF M3a |
| E1 | EF M3a + verified ingress |
| E3b | EF M3b |

M4/M5 只有在上述数据证明必要时加入。

---

# 10. Workload

至少四类：

## Coding

- 大 tool output；
- exact path/hash/value；
- tests；
- failure lifecycle；
- code artifact。

## Research

- rationale；
- hypothesis；
- uncertainty；
- negative knowledge；
- evidence conflict。

## Search/Web

- 中间 search trace；
- final evidence；
- externalization；
- repeated query。

## Multi-agent

- child task transcript；
- child result handoff；
- parent working-set growth。

---

# 11. 长期 Drift benchmark

长度：

\[
8,\ 32,\ 128,\ 512
\]

epochs。

预埋：

```text
active constraint
exact value
superseded value
rejected approach
open uncertainty
failure later resolved
artifact path
validation evidence
```

最终检查：

- constraint 是否仍 active；
- old value 是否冒充 current；
- rejected approach 是否无条件复活；
- uncertainty 是否被误写成 fact；
- failure state 是否正确；
- exact provenance 是否可找回。

---

# 12. Prefix 指标

本地 architecture metric：

```text
stablePrefixBytes
stablePrefixTokens
firstMutationPosition
invalidatedSuffixTokens
leafFoldCount
rootFoldCount
```

Provider metric（如可得）：

```text
cacheReadTokens
cacheWriteTokens
cacheMissTokens
```

必须区分：

> Prefix architecture 正确

和：

> Provider 当前真的给缓存命中。

---

# 13. Gate

## M0

必须全绿：

```text
ArchiveLoss = 0
RecallMismatch = 0
SurfaceCorruption = 0
PairingBreak = 0
```

## M2

必须：

```text
FrozenPrefixInvariant = PASS
FrontierMonotonic = PASS
ContextBoundedPath = PASS
TaskSuccess non-inferior
```

## M3a

必须：

```text
ALR = 0
SSR = 0
ProvenanceCoverage = 100%
EvidenceOverridesNarrative = PASS
ProjectionBounded = PASS
```

## M1/M3b

不得导致：

```text
TaskSuccess significant regression
DWR significant increase
```

---

# 14. Stop Conditions

出现以下任一情况，暂停扩大功能：

1. Exact recall 不是 100% 可验证；
2. Bundle 与 Session lifecycle 无法可靠关联；
3. Prefix invariant 不能 machine-proof；
4. Projection 内存随历史线性增长；
5. M3 state correctness 不稳定；
6. EF task success 低于 Basic 且原因无法归结为修复项。

不要在 correctness 未闭合时继续做 M4/M5。
