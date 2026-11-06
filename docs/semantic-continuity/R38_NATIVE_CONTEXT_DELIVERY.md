# R38-M0 — Native Context Delivery

## 1. The injection path

Checked against the installed DSH `0.2.1-rc.3` line, not against an old
example:

```text
ctx.get('systemPrompt').context({ name, order, text })
        ↓
SystemPrompt.assemble()          contexts are rendered per step
        ↓
AgentLoop.preStep()              RuntimeContextProjection.project()
        ↓
user/message { source: { kind: 'runtime-context', sections } }
        ↓
session.append('user/message')   logged, replayable
```

`RuntimeContextProjection` keeps the last snapshot and emits a new message only
when the joined context text changes. That is the cache-friendly property:
the stable system-prompt prefix is untouched, and an unchanged overlay is not
re-sent as a new event.

The overlay is NOT injected with `systemPrompt.section()`. A section is part of
the stable prefix; rewriting it every step would invalidate the prefix cache.
It is also NOT injected by mutating the checkpoint, the journal, or the
session log.

## 2. What the overlay contains

```text
[EF context overlay]
snapshot state=<commit watermark> session=<event watermark> archive=<revision> frame=<revision>
selection <selectionDigest>
<pinned + working selection>

Warnings
- integrity: <auditor finding>
- reconcile <anchor>: committed at seq N; a later user message at seq M ...

unsafe-to-assert <anchor ids>

Recovered from archive
- [<checkpoint>:<offset> seq <source seq>] <excerpt>
```

Every selected fact keeps its `sourceRefs`; every recovered passage keeps its
checkpoint, offset and seq.

## 3. Native smoke

`eval/r38/out/native-context-smoke.json` — 6/6 checks.

The host is the real `LlmRuntime + SessionStore + SessionProjectionRegistry +
TokenMeter + SystemPrompt + ToolRuntime + AgentRegistry + AgentLoop`, with a
scripted `LlmAdapter`. No provider call, no model.

| Check | Observation |
|---|---|
| N0 stable context | overlay delivered as `runtime-context`; not in the system prompt; two identical steps produce ONE context event; digest and prefix stable |
| N1 task change | a new frame produces a new selection digest and a SECOND context event; the system prefix is unchanged |
| N2 recent tail | `reconcile queue` and `unsafe-to-assert` are present; the old value is shown WITH the warning, not as the only current truth |
| N3 restart/replay | a real JSONL reload (`agents.resume`) delivers the same selection digest; the overlay digest is unchanged |
| N4 integrity warning | `integrity: stale-negative-knowledge` travels in the overlay |
| N5 archive recovery | `Recovered from archive` and `cp-archive:3 seq 7` travel in the overlay |

N3 uses real persistence: the session is flushed to JSONL, the context is
disposed, a new host mounts over the same root, and `agents.resume` loads the
session. The resumed session still has its runtime-context events (5 after the
restart), and the next step receives the overlay again.

## 4. Cache accounting

The overlay records:

```text
selectionDigest     what was selected
renderedDigest      the exact overlay text
taskFrameDigest     the frame that drove it
stateRevision       the semantic state revision
tokenEstimate       chars/4
changedBytes        common-prefix/suffix diff against the previous overlay
```

For N1 the task change moved 64 bytes, not the whole overlay. The stable
system prompt was byte-identical across every call.

## 5. What is NOT claimed

- The adapter is scripted. This proves the delivery path, not model behaviour.
- The state and the tail events are fixtures. The engine's own checkpoint and
  journal are not involved in this smoke; the point is that the overlay does
  not touch them.
- The overlay builder is eval code. Production wiring would need a Task Frame
  source, a per-agent context registration, and a policy for when the overlay
  is rebuilt. None of that is enabled here.
- No version-compatibility blocker was found on `0.2.1-rc.3`. The
  `agent/pre-step` waterfall and `systemPrompt.context` are both public in the
  installed line.

## 6. Evidence

```text
eval/r38/src/context-overlay.ts
eval/r38/native-context-smoke.mjs
eval/r38/out/native-context-smoke.json   6/6 checks
tests/r38-native-context.spec.ts         9/9
```
