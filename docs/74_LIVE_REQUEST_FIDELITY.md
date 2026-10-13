# 74 — The three failed calls: a missing header, not a provider outage

Status: root cause identified, harness guard added, post-fold continuation verified (synthetic
history). 2026-10-14. Parent `117446e`.

## 1. Root cause

All three calls of the previous round's smoke answered:

```
HTTP 400 {"type":"error","error":{"type":"MissingSessionID",
  "message":"Request is missing x-opencode-session and cannot be routed efficiently."}}
```

`lastFinishReason = "error:live provider HTTP 400: ..."`, `providerFailures` 1 -> 2 -> 3, empty
replies. **Not a provider fault, not a transport fault, not an adapter misclassification.**

The `/zen/go/v1` gateway requires `x-opencode-session`. The route carries it in
`LiveRoute.headers`, sourced from **`EF_LIVE_HEADERS`** (`eval/live/zcode-config.ts:163`). The
ad-hoc smoke set **`EF_TAU2_HEADERS`** -- a variable that does not exist -- so no header was sent.

`scripts/run-lhtb.sh:191-194` sets `EF_LIVE_HEADERS` correctly for this route, so **the LHTB lane
was never affected**. The defect was in the throwaway diagnostic, and the round's conclusion was
drawn from it.

### 1.1 Why the evidence was missing

The smoke's bridge stderr went to the terminal, and the collection step filtered the whole output
with `Select-String 'SMOKE'`. Telemetry carried `lastProviderError` verbatim; it was never
printed. That loss is the reason a systematic error was read as a flaky provider, and it is why
this round began by re-deriving the failure class from code (`bridge-host.ts:1372`: `providerFailures`
is incremented ONLY for a finish reason beginning `error:`, so an empty reply with a normal finish
reason cannot be one).

### 1.2 A false positive, corrected

The live smoke's check for "was the task root shadowed" used `JSON.stringify(seqs).includes(String(rootSeq))`
-- a SUBSTRING test, which a larger seq containing the same digit satisfies. It printed `true`
while the keyless array assertion printed `false`. Re-measured precisely, keyless:

```
rootSeq=2 (the instruction event); LEAF shadowed [3,4,5,6]; ROOT shadowed [11,7]
array.includes(rootSeq) over ALL folds : false
array.includes(rootSeq) over the ROOT fold : false
smallest seq in any shadowed span : 3      -> seqs 1 and 2 are never shadowed
```

**No defect.** The substring check was mine and is discarded; the array membership test in
`tests/task-root-bridge.spec.ts` is the one that stands.

## 2. Request differential

| | preflight | bridge smoke (broken) | bridge smoke (fixed) |
|---|---|---|---|
| endpoint | `/zen/go/v1/chat/completions` | same | same |
| model | `deepseek-v4.1-flash` | same | same |
| `x-opencode-session` | **hard-coded in the fetch call** | **absent** | from `EF_LIVE_HEADERS` |
| stream / max_tokens | `false` / 20 | `false` / 500 | same |
| messages | 1 (user) | 2 (system + user) | same |
| tools | absent | `array[2]`, injected by the bridge's ToolRuntime | same |
| result | 200 | **400 on every call** | 200, `pf=0` |

The differential is ONE field, and it is the reason a probe that passes can coexist with a
harness that fails. Captured keylessly off the real bridge (local mock, no provider call): body
7,160 bytes, top-level `[model, messages, stream, max_tokens, tools]`, `stream: false`,
`max_tokens: 500`, 2 messages, `tools` present as a 2-element array even when `init` passes
`tools: []`.

## 3. The fix

`assertRouteRoutable(route)` in `eval/live/zcode-config.ts`, called from the bridge's `init`
immediately after `resolveLiveRoute()`. A route whose base URL is `/zen/go/v1` and which carries no
`x-opencode-session` is refused BEFORE the first model call, with a message that names the missing
header and the variable that supplies it.

This is not new knowledge -- `tests/live-route-headers.spec.ts` already documented that "a missing
or misspelled header makes every model call fail ... reads as a provider fault rather than as a
typo". The existing guard checked that `EF_LIVE_HEADERS` was well-formed JSON; it did not check
that a route requiring a header HAD one. Three tests now pin the third case, the sibling `/zen/v1`
route, and the reconfigured fix.

Not changed: the compaction transaction, the task-root policy, the presets, the timeout, the model.

## 4. Behavioral trace

With the header configured, one controlled run (window 16384, no ranking):

```
taskRoot  resident, sourceSeq 2, digestVerified, position 0      (before, and after, everything)
PRE-FOLD  finish=stop pf=0  real reply
LEAF      committed=1  folds=1  pressure=4158 tokens
POST-LEAF finish=stop pf=0  reply names the checkpoint: "One folded checkpoint (cp:761a07db...)"
ROOT      committed=1  refusal=none  lineage=[leaf, root]
POST-ROOT finish=stop pf=0  reply: "I called both retrieval tools on the checkpoint
                                       (cp:912dfb77..., detail depth) and a search for
                                       `evt event-log format family`"
final     taskRoot resident, sourceSeq 2, digestVerified, position 0
```

The model, after a committed leaf AND a committed root, reads the NEW surface, sees the original
task statement, calls the retrieval tools, and reasons about what the checkpoint does and does not
contain. That is the behavioral proof the previous round lacked.

**It is a SYNTHETIC-HISTORY continuation**: the pressure was filler this harness wrote, not a real
LHTB episode. It shows the model continues, correctly and with the task text intact, across a
committed fold; it is NOT evidence about natural long-task success rates.
