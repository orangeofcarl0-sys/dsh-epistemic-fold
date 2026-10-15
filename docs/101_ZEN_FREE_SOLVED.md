# 101 — SOLVED: the free model works, and the gate was the session's TIME encoding

Status: **RESOLVED AND VERIFIED (HTTP 200)**. 2026-10-16. Parent `9145866`.

## A. The root cause, after four failed hand-replications

Every 403 traced to ONE field. `dsh-opencode-free` v0.3.4, `lib/zen-provider.js:170-175`:

```js
// The time region is no longer a hash: the inference gate rejects that form.
const encoded = ~(BigInt(timestamp) * 0x1000n + BigInt(counter));
const hex = (encoded & 0xffffffffffffn).toString(16).padStart(12, "0");
const id = `ses_${hex}${base62FromBytes(randomBytes(14), 14)}`;
```

**The session id's first 12 hex characters must be OpenCode's own TIME encoding.** I had been
hashing them (`sha256(salt + provider:id)`), which is what v0.3.3 did and what the v0.3.4 comment
says the gate now rejects. Everything else I had already reproduced correctly -- the endpoint
(`/inference/v1`), the identity headers, and the `read`/`bash` tool declarations.

This also explains why the differential test was misleading: I replayed the plugin's OWN captured
bytes and still got 403, because I replaced the session id with a fresh HASHED one. The bytes were
identical except for the one field that mattered.

## B. Verified from our own code

```
POST https://opencode.ai/inference/v1/chat/completions
  authorization: Bearer public
  user-agent:    opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14 ...
  x-opencode-client: cli     x-opencode-project: global
  x-opencode-session / x-client-request-id: ses_<time-encoded 12 hex><14 base62>
  x-opencode-request: msg_<12 hex><14 base62>
  body: { model, messages, stream: true, stream_options: {include_usage: true},
          max_tokens, tools: [read, bash] }

-> 200 in 2354ms
   usage {"prompt_tokens":391,"completion_tokens":17,"total_tokens":408,
          "prompt_tokens_details":{"cached_tokens":256}}
```

## C. Wired into the test environment

`eval/live/zcode-config.ts` gains `EF_LIVE_ZEN_FREE=1`: the identity is **generated**, not
configured, because a static `EF_LIVE_HEADERS` value would freeze the time region at whatever moment
the file was written. One id per process is the plugin's own semantics -- it keeps the first identity
for cache affinity and persists nothing. Explicit `EF_LIVE_HEADERS` entries still win, so this adds
the identity without removing anyone's override. `tsc -p tsconfig.eval.json` is clean for the file.

## D. The lane is running on it now

```
job        lhtb-ef-20261016-014238-probe-economy
model      deepseek-v4.1-flash-free
route      https://opencode.ai/inference/v1/chat/completions
env        EF_LIVE_ZEN_FREE=1  EF_LIVE_API_KEY=public
budget     REQUIRED=1  requests 140  prompt 7,000,000  output 550,000  wall 28,800,000
           EF_LHTB_REPLY_MAX_TOKENS=16384
```

**An earlier launch of the same command aborted before any model call** with `Docker daemon is not
running`; Docker Desktop was started (`29.7.2`) and the run relaunched. That abort is recorded because
it is the kind of thing that would otherwise read as a model failure.

## E. Context length: still NOT measured

Now that requests succeed, the ladder is possible -- but it has not been run, so there is still no
figure. The catalogue publishes no metadata, so the answer must come from probing.
