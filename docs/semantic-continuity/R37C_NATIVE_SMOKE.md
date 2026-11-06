# R37-C — Native Smoke

## 1. Result

```text
N0 native tool smoke        passed
N1 native persistence       passed
N2 EF integration           passed
provider requests            0
synthetic tool repairs       0
```

The previous `TOOL_NOT_STARTED` is resolved. It was not a missing package and
not a broken ToolRuntime.

## 2. Root cause

The smoke host constructed `AgentLoop` with:

```js
new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
```

`AgentLoop` reads:

```js
ctx.agentLoop.config.maxParallelToolCalls.get()
```

The manual host passed a plain number where the service expects a volatile
cell. The loop threw `TypeError: ... .get is not a function` at the start of
tool scheduling, before `tool/call` was appended. The session's step recovery
then saw an assistant tool request with no durable start record and wrote the
synthetic `TOOL_NOT_STARTED` result. That is the crash-repair path, not a live
dispatch failure.

Fix:

```js
import { createVolatile } from '@deepseek-ai/cosmokit'
new AgentLoop(ctx, { agents: [], maxParallelToolCalls: createVolatile(1) })
```

## 3. N0 — native tool lifecycle

Composition:

```text
Context
LlmRuntime
SessionStore
SessionProjectionRegistry
TokenMeter
SystemPrompt
ToolRuntime
AgentRegistry
AgentLoop (createVolatile(1))
scripted model adapter
one deterministic read-only read_file tool, registered in the agent setup scope
```

Observed event order:

```text
turn/start
step/start
system/message
user/message
request/header
request/context
assistant/message  (tool-call read_file)
tool/call
tool/result
step/end
turn/end
```

Counts:

```text
tool calls        1
tool results      1
assistant messages 2
repairs            0
```

The first assistant message requests the tool; the second is the model's
text completion after the result.

## 4. N1 — persistence and resume

N1 mounts `@deepseek-ai/dsh-session-persistence-jsonl` with a temporary root,
creates the same session, runs the tool call, disposes the host, mounts a fresh
host, and resumes the same session id.

```text
first host    tool calls 1, tool results 1, repairs 0
resumed host  tool calls 1, tool results 1, repairs 0
ordering      call seq < result seq in both
```

The resume path preserves the call/result pair and does not synthesize a
repair.

## 5. N2 — EF integration

N2 adds the real `EpistemicFoldPlugin` with:

```text
semanticContinuity  active
semanticMode        rationale
bundleRoot          temporary
semanticRoot        temporary
writer              scripted B2 payload (handoff + two deltas)
```

The fold produced a checkpoint of 870 characters. The B2 fact
`in-memory queue` is visible in the checkpoint. A fresh native agent then
received the checkpoint plus the task and ran the same read-only tool:

```text
checkpoint fact visible   true
native tool calls         1
native tool results       1
repairs                   0
```

This is the minimal closed loop the brief asked for:

```text
history -> fold -> checkpoint delivery -> native continuation -> tool call -> result
```

## 6. Package versions

```text
@deepseek-ai/dsh-agent-loop                 0.2.1-rc.3
@deepseek-ai/dsh-session                    0.2.1-rc.3
@deepseek-ai/dsh-tools                      0.2.1-rc.3
@deepseek-ai/dsh-llm                        0.2.1-rc.3
@deepseek-ai/dsh-session-persistence-jsonl  0.2.1-rc.3
```

The native package was installed with `--no-save`; the production
`package.json` and lockfile are unchanged. This is an isolated smoke, not a
dependency migration.

## 7. What this does not claim

- It does not claim the production DSH host assembles `AgentLoop` the same way;
  it shows the correct manual construction.
- It does not claim a real provider or model behavior; the adapter is
  scripted.
- It does not claim the native loop replaces the custom evaluation loop for
  the R37-B/R37-C behavioral results.
- N2 is a minimal EF fold/continuation, not a benchmark run.
