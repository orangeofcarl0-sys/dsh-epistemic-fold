# EF-R4 — live route qualification attempts

Decision: **blocked-provider-auth**. Campaign started: **false**.

| Attempt | Route | Result | Blocker |
|---|---|---|---|
| 1 | http://127.0.0.1:7866/v1 | fail, 0/16 | local-proxy-unreachable |
| 2 | https://opencode.ai/zen/go/v1 | fail, 0/16 | opencode-api-key-expired |
| 3 | https://opencode.ai/zen/go/v1 | fail, 0/16 | opencode-api-key-expired |
| 4 | https://opencode.ai/zen/go/v1 | fail, 0/16 | opencode-api-key-expired |

Provider requested: `opencode/deepseek-v4.1-flash` at `https://opencode.ai/zen/go/v1`.

All three configured OpenCode accounts returned HTTP 401 `api_key_expired`. Attempt 1 used the local proxy and failed with `ECONNREFUSED`.

Replace at least one OpenCode API key in `~/.zcode/v2/config.json`, then retry the probe. The 36-cell campaign remains unauthorized until the probe passes.

