# EF-R4 — route addendum: the conversation works on a different provider

## What was tested

Attempt 5 used the `b88043d7…` OpenCode provider with the **provider's own** `x-opencode-session` header (`zcode-b88043d7-20260913`), not the generated Zen-free identity:

- `POST https://opencode.ai/zen/go/v1/chat/completions`
- model `deepseek-v4.1-flash`
- 75,603-char profile
- result: HTTP **401 `api_key_expired`** after 1,285 ms, no usage

This is the same result as attempts 2–4, which used three different OpenCode accounts and the generated session header. The key itself is rejected; the session header is not the problem.

## Why the conversation still works

The ZCode app log for this workspace records a different actual route:

```
2026-11-14 01:42:00.671  provider/model 就绪
{"modelId":"GLM-5.3-Flash","providerId":"account:bigmodel-start-plan",
 "revision":"model-selection:2",
 "workspaceKey":"F:\\Codex_Work_Space\\DSH plugin\\dsh-epistemic-fold"}
```

So the working conversation is served by `account:bigmodel-start-plan` / **GLM-5.3-Flash**, not by `opencode/deepseek-v4.1-flash`. The system prompt's model id and the app's actual provider selection are not the same thing here.

## Consequence

A working conversation does not prove the OpenCode key is usable by the harness. The harness reads the static `apiKey` from `~/.zcode/v2/config.json` and sends it to the configured base URL; that key is expired. The 36-cell campaign remains **not started**.

## Options

1. Replace at least one OpenCode `apiKey` in `~/.zcode/v2/config.json`; then rerun the 16-request probe.
2. Switch to the working GLM-5.3-Flash route. It uses Anthropic messages, while the harness has only an OpenAI-compatible adapter; it needs a new adapter, a new manifest, and is not comparable to the deepseek R3/R4 evidence.
3. Start the `omnigate2api` local proxy at `127.0.0.1:7866` if it is available. It is OpenAI-compatible, but currently has no listener.
