# 98 — dsh-opencode-free: installed, protocol extracted, free tier NOT yet reachable

Status: **AVAILABILITY NOT SOLVED — CONTEXT LENGTH NOT MEASURED.** 2026-10-16. Parent `78a38f9`.

## A. What was done

**Installed** `dsh-opencode-free@0.3.3` into the `web` profile. The version is deliberate: v0.3.4
requires DSH `0.2.1-alpha.3`, and this machine runs **`0.2.1-alpha.2`**, which v0.3.3 pins exactly.

**Extracted the protocol** from `lib/zen-provider.js`:

```
identity   Authorization: Bearer public
           User-Agent: opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14 ...
           x-opencode-client: cli      x-opencode-project: global
           x-opencode-session / x-client-request-id: ses_ + 12 hex + 14 base62
           x-opencode-request: msg_ + 12 hex + 14 base62
session    sha256(SALT + 'opencode-zen-free:' + dshSessionId) -> 6 hex + 14 base62
gate       the request must declare tools named exactly `read` and `bash`
```

## B. Replication FAILED, and the source says why

I reproduced the endpoint, identity headers, session algorithm and tool declarations, and sent real
requests. **Both endpoints still answered 403 FreeTierError:**

```
https://opencode.ai/zen/v1/chat/completions        403  FreeTierError
https://opencode.ai/inference/v1/chat/completions  403  FreeTierError
```

`zen-provider.js:484-487` states the reason my shape is wrong:

> The gate operates on the **transcript**, because that is all a pi-ai 0.87+ provider reads:
> `context.tools` is not merely ignored, **it is unreachable**.

**The tool declarations must be injected into the messages in OpenCode's transcript shape, not passed
in the top-level `tools` field.** I did not reproduce that layer.

## C. The plugin cannot help this lane as installed

`dsh-opencode-free` works by **wrapping DSH's process-wide HTTP entry points for the Zen endpoint**.
It therefore helps a **DSH session** that selects an OpenCode Zen Free model. The EF/LHTB lane calls
the provider **directly** from `eval/live/openai-adapter.ts`, so the plugin is not on that path.
Using the free model in the LHTB experiment means either reproducing the transcript tool gate exactly,
or routing the lane through DSH's provider stack -- a larger change than a header set.

## D. Real context length: NOT MEASURED

**I could not obtain one successful free-tier request, so I have no measurement.** The Zen catalogue
publishes no context metadata at all -- every entry carries only `id`, `object`, `created`, `owned_by`:

```
deepseek-v4.1-flash-free  ->  {ctx: null, out: null, meta: [id, object, created, owned_by]}
```

so even the DECLARED length is not available from the API; the plugin sources it from models.dev.
**Any figure I offered here would be invented.** `not measured` is not `measured, no problem`.

## E. What is actually established

```
plugin installed (v0.3.3, version-matched)      YES
protocol extracted                              YES
hand-replication of admission                   FAILED -- 403 on both endpoints
free model reachable from this lane             NO
real context length                             NOT MEASURED
declared context length                         NOT AVAILABLE (catalogue has no metadata)
```

## F. The shortest path to an answer

Install v0.3.4 (accepting the `0.2.1-alpha.3` peer mismatch, or upgrade DSH first) -- the protocol
notes record the `/zen/v1` -> `/inference/v1` migration as the change that turned `403` into `200`,
and v0.3.3 is pinned to the OLD endpoint. Then either drive the model from a DSH session with the
plugin loaded, or lift `applyAnonymousToolGate` verbatim rather than reimplementing it.
