# R37-D — Native Runtime

## 1. Scope

R37-C proved N0/N1/N2 with the real DSH runtime. R37-D adds three cases:

```text
N3  multiple tool calls in one assistant turn
N4  interrupted-session recovery at two persistence points
N5  two EF folds with a semantic revision, then a native tool call
```

All three use the real `@deepseek-ai/dsh-agent-loop`, `dsh-agent`, `dsh-tools`,
`dsh-session`, and JSONL persistence. The model is a scripted adapter. No
provider request is made.

```text
agent-loop     0.2.1-rc.3
session        0.2.1-rc.3
tools          0.2.1-rc.3
llm            0.2.1-rc.3
persistence    0.2.1-rc.3
```

## 2. N3 — multiple tool calls

One assistant turn requests five calls:

```text
read_file src/queue.mjs      (old content)
write_file src/queue.mjs     (new content)
run_tests                    (observes the new content)
fail_once                    (throws)
read_file src/queue.mjs      (new content again)
```

Result:

```text
tool calls             5
tool results           5
call/result paired     yes
write before test      yes; run_tests observed "new"
duplicate reads        2 results, both executed
thrown tool error      1; rendered as "Error: intentional tool failure"
```

Event order is call → result for each pair, in model order. The loop continues
after the thrown tool error and executes the duplicate read.

The runtime renders a thrown tool error as a text result, not as an `error`
field. The accounting treats `Error:` text and an explicit `error` field as the
same observable class; it does not invent an error code.

## 3. N4 — interrupted-session recovery

Two persisted sessions are constructed and then interrupted:

```text
not-started   assistant message contains a tool-call block, but no durable
              `tool/call` event is appended
started       a durable `tool/call` event is appended, but no `tool/result`
```

Both sessions are created through the agent factory (which takes persistence
ownership), flushed, and disposed. On resume, the runtime synthesizes:

| case | synthetic result | real code |
|---|---|---|
| not-started | "interrupted before the Harness recorded it as started" | `TOOL_NOT_STARTED` |
| started | "interrupted after it was recorded, but no result was durably recorded" | `TOOL_OUTCOME_UNKNOWN` |

The codes are the runtime's own. No `TOOL_STARTED_BUT_UNFINISHED` or
`TOOL_COMPLETED` state is invented.

The persisted session files exist before recovery:

```text
not-started   1 file, 1,060 bytes
started       1 file, 1,203 bytes
```

## 4. N5 — repeated EF folds

The session starts from the B2 transcript. The first fold commits the original
decision and the rejected outbox:

```text
The scheduler keeps an in-memory queue.
rejected: A durable outbox is rejected ...
```

A revision turn is appended, and a second fold runs with a writer payload that
supersedes both coordinates:

```text
The scheduler uses a durable outbox because the storage dependency is now
available.
supersedes: scheduler-queue, scheduler-outbox
```

The second fold commits:

```text
op declare   The scheduler uses a durable outbox ...
op retire    semantic-cc47... (the old rejected-approach)
```

Journal replay after both folds:

```text
packets             2
receipts            2
committed packets   2
proof valid         true
active anchors      1
                    The scheduler uses a durable outbox because the storage
                    dependency is now available.
```

The final checkpoint contains the new fact and not the old in-memory fact. The
old rejected-outbox anchor is retired. The stale state does not revive.

A native continuation then runs on the final checkpoint:

```text
tool calls      1
tool results    1
errors          0
```

## 5. What is still not verified

- The production DSH harness integration, not just a manual native host.
- Real provider behaviour, including the writer under a real model.
- Concurrency above `maxParallelToolCalls = 1`.
- A real process crash. N4 constructs the persisted interruption; it does not
  kill a process mid-write.
- Tool side effects under interruption. N4's synthetic result tells the model
  the outcome is unknown; it does not reconcile external state.
- N5 uses a scripted writer payload. It proves the fold/revision machinery, not
  a model's ability to produce the revision.

## 6. Artifacts

```text
eval/r37d/native-extended.mjs
eval/r37d/out/native-extended.json
tests/r37d-native.spec.ts
```

Run:

```bash
node eval/r37d/native-extended.mjs
```
